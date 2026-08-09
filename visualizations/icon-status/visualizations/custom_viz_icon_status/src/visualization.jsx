import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Icon Status（単一値のアイコン切り替えビジュアライゼーション）
//
// SOC ダッシュボードでよく使うアイコン（サーバー・DB・シールド・警告 …）を
// 「多層 SVG」で立体的に描き、値に応じて色を変える単一値 viz。
//
// ■ 多層 SVG（方式C）の考え方
//   1つのアイコンを「べた塗りシェイプの重ね合わせ」として定義し、各レイヤーには
//   色そのものではなく **色ロール**（faceTop / faceFront / accent …）を持たせる。
//   描画時に「基準色1色」からロールごとの実際の色を導出するため、しきい値で
//   基準色が緑→黄→赤に変わると、陰影・グロー・差し色まで一斉に連動して色が変わる。
//   ラスタ画像では不可能で、これが方式Cを選んだ理由。
//
//   ロール一覧（resolveRoleColor が実装）:
//     glow      … 背後の発光。基準色を鮮やかに
//     faceTop   … 上面（最も明るい）
//     faceFront … 前面（中間）
//     faceSide  … 側面（最も暗い）
//     accent    … 差し色（スリット・鍵穴・チェック等）。基準色そのまま＝ここが光って見える
//     highlight … エッジ光。純白ではなく基準色寄りの白（純白だと面から浮く）
//     gleam     … 鏡面反射の光点（瞳など）。純白のまま強く出す
//     line      … 輪郭線
//
// ■ データモデル（単一値）
//   値フィールド（既定は最終列）を集計方法（既定は最終行）で1つの数値にする。
//   ラベルフィールドは表示ラベルにのみ使う（未指定なら値フィールド名）。
//
// ■ パフォーマンス方針
//   ・描画されるアイコンは常に1個（未選択のアイコンは配列データのままで DOM に出ない）
//   ・形状は不変で色だけ変わる → reflow が起きない
//   ・グロー（feGaussianBlur）はフィルタ層を据え置き、アニメーション（パルスリング）は
//     フィルタの外にある要素の属性だけを rAF で直接書き換える（毎フレームの
//     ぼかし再計算を避ける）。グロー／アニメーションは個別にオプションで切れる。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '1.1.5';

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    labelField: '', // ラベルフィールド（'' = 第1列）
    valueField: '', // 値フィールド（'' = 最終列）

    iconName: 'server', // アイコン名（ICONS[].name のいずれか）
    iconStyle: 'solid', // 質感（solid = 立体 / outline = 線画）

    colorMode: 'threshold', // 色の決め方（threshold = しきい値 / fixed = 単色）
    baseColor: '#22d3ee', // 単色モードの基準色
    colorBands: [
        { from: null, to: 50, value: '#3fb950' },
        { from: 50, to: 80, value: '#d29922' },
        { from: 80, to: null, value: '#f85149' },
    ],

    showGlow: true, // 発光（グロー）
    showShadow: true, // 接地シャドウ
    pulseMode: 'none', // アニメーション（none / ring）

    showValue: true, // 数値を表示
    showLabel: true, // ラベルを表示
    labelText: '', // ラベル文字列（'' = フィールド名）
    unitText: '', // 単位
    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: false, // 省略表記

    aggregation: 'last', // 集計方法
    iconScale: 1, // アイコンの大きさ（倍率）
    showCard: true, // カード背景を表示
};

const ICON_STYLES = ['solid', 'outline'];
const COLOR_MODES = ['threshold', 'fixed'];
const PULSE_MODES = ['none', 'ring'];
const AGGREGATIONS = ['last', 'sum', 'avg', 'max', 'min', 'count'];

// ---------------------------------------------------------------------------
// アイコン定義（多層 SVG）
//
// viewBox は 0 0 96 96 で統一。アイソメトリック（等角）で「上面・前面・側面」の
// 3面を描き分けると立体に見える。各レイヤーは:
//   { d: パス, role: 色ロール, opacity?: 不透明度 }
// outline（線画）用には別途 `line` 配列を持ち、質感オプションで切り替える。
// ---------------------------------------------------------------------------

const ICONS = [
    {
        name: 'server',
        label: 'サーバー',
        // アイソメの直方体。上面は菱形 (48,14)-(70,26)-(48,38)-(26,26)、
        // 前面は x=48〜70、側面は x=26〜48、底辺 y=74（前面）/ y=74（側面）。
        // スリット・LED はすべて所属する面の内側に収める。
        layers: [
            // 側面（左・暗）
            { d: 'M26 26 L48 38 L48 78 L26 66 Z', role: 'faceSide' },
            // 前面（右・中間）
            { d: 'M70 26 L48 38 L48 78 L70 66 Z', role: 'faceFront' },
            // 上面（菱形・明）
            { d: 'M48 14 L70 26 L48 38 L26 26 Z', role: 'faceTop' },
            // 前面の通気スリット（前面の傾き -12/22 に沿わせる）
            { d: 'M53 56 L66 49 L66 53 L53 60 Z', role: 'accent', opacity: 0.85 },
            { d: 'M53 62 L66 55 L66 59 L53 66 Z', role: 'accent', opacity: 0.65 },
            { d: 'M53 68 L66 61 L66 65 L53 72 Z', role: 'accent', opacity: 0.45 },
            // 側面の LED（側面の傾き +12/22 に沿わせる）
            { d: 'M31 44 L36 46.5 L36 51 L31 48.5 Z', role: 'accent' },
            { d: 'M31 54 L36 56.5 L36 61 L31 58.5 Z', role: 'accent', opacity: 0.6 },
            // 上面のエッジ光。辺 (48,14)-(70,26) に**内側から**沿わせる
            // （頂点を辺の端に重ねると角で溢れるので、4頂点とも菱形の内部に取る）
            { d: 'M49.5 15.8 L67 25.4 L64.5 26.8 L49 18.4 Z', role: 'highlight', opacity: 0.4 },
        ],
        line: [
            'M48 14 L70 26 L48 38 L26 26 Z',
            'M26 26 L26 66 L48 78 L48 38',
            'M70 26 L70 66 L48 78',
            'M53 57 L66 50',
            'M53 66 L66 59',
        ],
    },
    {
        name: 'database',
        label: 'データベース',
        // 円柱。中心 x=48、半径 rx=24（24〜72）、上面楕円 cy=26、底 cy=70。
        // 段のラインは胴の内側（y=26〜70）にのみ置く。
        layers: [
            // 胴
            { d: 'M24 26 L24 70 A24 11 0 0 0 72 70 L72 26 Z', role: 'faceFront' },
            // 胴の下半分（陰）
            { d: 'M24 50 L24 70 A24 11 0 0 0 72 70 L72 50 A24 11 0 0 1 24 50 Z', role: 'faceSide', opacity: 0.85 },
            // 上面（楕円）
            { d: 'M24 26 A24 11 0 0 1 72 26 A24 11 0 0 1 24 26 Z', role: 'faceTop' },
            // 段のライン（胴の内側に収める）
            { d: 'M24 42 A24 11 0 0 0 72 42 L72 45 A24 11 0 0 1 24 45 Z', role: 'accent', opacity: 0.8 },
            { d: 'M24 56 A24 11 0 0 0 72 56 L72 59 A24 11 0 0 1 24 59 Z', role: 'accent', opacity: 0.55 },
            // 上面のハイライト（上面楕円の内側）
            { d: 'M32 22 A17 6 0 0 1 62 20 A20 8 0 0 0 32 22 Z', role: 'highlight', opacity: 0.45 },
        ],
        line: [
            'M24 26 A24 11 0 0 1 72 26 A24 11 0 0 1 24 26 Z',
            'M24 26 L24 70 A24 11 0 0 0 72 70 L72 26',
            'M24 48 A24 11 0 0 0 72 48',
        ],
    },
    {
        name: 'shield',
        label: 'シールド（防御）',
        clipShape: 'M48 10 L76 22 L76 48 C76 66 63 79 48 86 C33 79 20 66 20 48 L20 22 Z',
        // 盾。頂点 (48,10)、肩 y=24、幅 20〜76、先端 (48,86)。
        // チェックは盾の内側（x=32〜64, y=40〜62）に収める。
        layers: [
            // 右半分（前面）
            { d: 'M48 10 L76 22 L76 48 C76 66 63 79 48 86 Z', role: 'faceFront' },
            // 左半分（側面・陰）
            { d: 'M48 10 L20 22 L20 48 C20 66 33 79 48 86 Z', role: 'shade' },
            // 上面の帯（厚み）
            { d: 'M48 10 L76 22 L48 28 L20 22 Z', role: 'faceTop' },
            // チェックマーク（盾の内側に完全に収める。右上端は x=62 までに留める。
            // 盾は y=48 付近から内側へ曲がるので、右へ伸ばしすぎると縁からはみ出す）
            { d: 'M34 52 L43 61 L58 42 L63 47 L43 70 L29 56 Z', role: 'accent' },
            // 上辺エッジの光。上面の帯 (48,10)-(76,22)-(48,28)-(20,22) の内側に収める
            { d: 'M49.5 12 L72.5 21.8 L69 23 L49 14.8 Z', role: 'highlight', opacity: 0.45 },
        ],
        line: [
            'M48 10 L76 22 L76 48 C76 66 63 79 48 86 C33 79 20 66 20 48 L20 22 Z',
            'M34 50 L44 60 L63 41',
        ],
    },
    {
        name: 'alert',
        label: '警告',
        clipShape: 'M48 12 L86 80 L10 80 Z',
        // 三角形の警告標識。安全域(6〜90)の内側に収める：頂点 (48,12)、底辺 y=80、幅 10〜86。
        // 感嘆符は三角形の内側（y=36〜72）で、下端は底辺から十分離す。
        layers: [
            // 三角形の本体（前面）
            { d: 'M48 12 L86 80 L10 80 Z', role: 'faceFront' },
            // 左半分の陰（グラデーションが x=48 で透明に抜けるので境界線は出ない）
            { d: 'M48 12 L48 80 L10 80 Z', role: 'shade' },
            // 感嘆符の縦棒（明るい面色で抜く）
            { d: 'M43.5 38 L52.5 38 L51 60 L45 60 Z', role: 'faceTop' },
            // 感嘆符の点（底辺 y=80 から余白を取る）
            { d: 'M44 65 L52 65 L52 73 L44 73 Z', role: 'faceTop' },
        ],
        line: ['M48 12 L86 80 L10 80 Z', 'M48 38 L48 60', 'M48 67 L48 71'],
    },
    {
        name: 'lock',
        label: '錠前',
        clipShape: 'M24 46 L72 46 L72 80 L24 80 Z',
        // 南京錠。すべて中心 x=48 で対称にする。
        //   シャックル（弦）: 外径 x=32〜64、内径 x=40〜56、上端 y=20、本体へ y=46 で接続
        //   本体: x=24〜72、y=46〜80（左右対称）
        //   鍵穴: 本体の中央 x=48、y=56〜72（本体内に収める）
        layers: [
            // シャックル（本体より先に描いて背面へ回す）
            {
                d: 'M32 50 L32 36 A16 16 0 0 1 64 36 L64 50 L56 50 L56 36 A8 8 0 0 0 40 36 L40 50 Z',
                role: 'faceSide',
            },
            // 本体（前面）
            { d: 'M24 46 L72 46 L72 80 L24 80 Z', role: 'faceFront' },
            // 本体の左端だけ陰にする（半分塗ると平面2枚に見える）
            { d: 'M24 46 L40 46 L40 80 L24 80 Z', role: 'shade', opacity: 0.85 },
            // 本体上辺のハイライト帯
            { d: 'M24 46 L72 46 L72 50 L24 50 Z', role: 'faceTop', opacity: 0.9 },
            // 鍵穴（中心 x=48。円＋下向きの台形で本体内に収める）
            { d: 'M48 54 A6.5 6.5 0 1 1 48 67 A6.5 6.5 0 0 1 48 54 Z', role: 'accent' },
            { d: 'M45 63 L51 63 L52.5 74 L43.5 74 Z', role: 'accent' },
        ],
        line: [
            'M24 46 L72 46 L72 80 L24 80 Z',
            'M36 46 L36 36 A12 12 0 0 1 60 36 L60 46',
            'M48 56 A5 5 0 1 1 48 66 A5 5 0 0 1 48 56 Z',
            'M48 66 L48 72',
        ],
    },
    {
        name: 'router',
        label: 'ネットワーク機器',
        // 平たい筐体＋アンテナ。すべて中心 x=48 で左右対称にする。
        //   上面菱形: (48,42)-(80,58)-(48,74)-(16,58)
        //   厚み: y=58〜70（側面/前面）
        //   アンテナ: 根元 (34,52)/(62,52) から上へ、先端 (28,20)/(68,20)。左右対称。
        layers: [
            // アンテナ（筐体より先に描く＝背面）
            { d: 'M32 55 L37 56 L32 22 L28 22 Z', role: 'faceSide' },
            { d: 'M64 55 L59 56 L64 22 L68 22 Z', role: 'faceSide' },
            { d: 'M30 15 A5 5 0 1 1 30 25 A5 5 0 0 1 30 15 Z', role: 'accent' },
            { d: 'M66 15 A5 5 0 1 1 66 25 A5 5 0 0 1 66 15 Z', role: 'accent', opacity: 0.8 },
            // 筐体の厚み（左＝側面、右＝前面）
            { d: 'M16 58 L48 74 L48 82 L16 66 Z', role: 'faceSide' },
            { d: 'M80 58 L48 74 L48 82 L80 66 Z', role: 'faceFront' },
            // 上面（菱形）
            { d: 'M48 42 L80 58 L48 74 L16 58 Z', role: 'faceTop' },
            // 上面の LED 列（菱形の中心 (48,58) を通る「左下がり」の対角線上に等間隔で並べる。
            // 菱形の稜線と平行にすることで、面から浮かず整列して見える）
            { d: 'M34 58 L40 55 L44 57 L38 60 Z', role: 'accent' },
            { d: 'M44 58 L50 55 L54 57 L48 60 Z', role: 'accent', opacity: 0.7 },
            { d: 'M54 58 L60 55 L64 57 L58 60 Z', role: 'accent', opacity: 0.5 },
            // 上面「左上」辺のエッジ光。辺 (48,42)-(16,58) に**内側から**沿わせる。
            // 帯の4頂点はすべて菱形の内部に取ること（頂点を辺上に置くと角で溢れる）。
            { d: 'M46 43.6 L21 56.1 L24.5 57.9 L47.5 46.4 Z', role: 'highlight', opacity: 0.35 },
        ],
        line: [
            'M48 42 L80 58 L48 74 L16 58 Z',
            'M16 58 L16 66 L48 82 L48 74',
            'M80 58 L80 66 L48 82',
            'M34 53 L29 24',
            'M62 53 L67 24',
        ],
    },
    {
        name: 'user',
        label: 'ユーザー',
        clipShape: 'M48 12 A16 16 0 1 1 48 44 A16 16 0 0 1 48 12 Z M18 82 C18 58 31 42 48 42 C65 42 78 58 78 82 Z',
        // 頭部＋肩。中心 x=48。頭は cy=28 r=16（12〜44）、肩は y=52〜82 で頭と重ねて隙間をなくす。
        layers: [
            // 胴（肩）。頭の下端 y=44 に食い込ませて隙間をなくす（y=42 から立ち上げる）
            { d: 'M18 82 C18 58 31 42 48 42 C65 42 78 58 78 82 Z', role: 'faceFront' },
            // 胴の陰。全体を覆うと他アイコンより沈んで見えるので、左寄りの一部だけに掛ける
            { d: 'M18 82 C18 58 31 42 48 42 L48 82 Z', role: 'shade', opacity: 0.9 },
            // 頭部
            { d: 'M48 12 A16 16 0 1 1 48 44 A16 16 0 0 1 48 12 Z', role: 'faceFront' },
            // 頭部の陰（左側だけ。グラデーションで右へ抜けるので seam は出ない）
            { d: 'M48 12 A16 16 0 0 0 48 44 A16 16 0 0 1 48 12 Z', role: 'shade', opacity: 0.9 },
            // 胸のバッジ（胴の内側に収める。底辺 y=82 から離す）
            { d: 'M48 60 A7 7 0 1 1 48 74 A7 7 0 0 1 48 60 Z', role: 'accent' },
            // 頭部のハイライト
            { d: 'M38 21 A12 12 0 0 1 55 16 A16 16 0 0 0 38 21 Z', role: 'highlight', opacity: 0.42 },
        ],
        line: [
            'M48 12 A16 16 0 1 1 48 44 A16 16 0 0 1 48 12 Z',
            'M18 82 C18 62 31 50 48 50 C65 50 78 62 78 82',
        ],
    },
    {
        name: 'eye',
        label: '監視（目）',
        clipShape: 'M8 48 C22 27 34 22 48 22 C62 22 74 27 88 48 C74 69 62 74 48 74 C34 74 22 69 8 48 Z',
        // 目。中心 (48,48)。外形は x=8〜88、y=22〜74。
        //   虹彩 r=17（31〜65）、瞳 r=9（39〜57）、ハイライトは瞳の内側に置く。
        layers: [
            // 白目（外形）
            { d: 'M8 48 C22 27 34 22 48 22 C62 22 74 27 88 48 C74 69 62 74 48 74 C34 74 22 69 8 48 Z', role: 'faceFront' },
            // 上半分の陰
            { d: 'M8 48 C22 27 34 22 48 22 C62 22 74 27 88 48 C74 38 62 34 48 34 C34 34 22 38 8 48 Z', role: 'shade', opacity: 0.9 },
            // 虹彩
            { d: 'M48 31 A17 17 0 1 1 48 65 A17 17 0 0 1 48 31 Z', role: 'accent' },
            // 瞳
            { d: 'M48 39 A9 9 0 1 1 48 57 A9 9 0 0 1 48 39 Z', role: 'faceSide' },
            // 瞳の中のハイライト。瞳は cx=48,cy=48,r=9。
            // 中心 (44.5,44.5) r=2.6 なら中心間距離 √(3.5²+3.5²)≈4.95、+2.6=7.55 < 9 で内側に収まる
            { d: 'M41.9 44.5 A2.6 2.6 0 1 1 47.1 44.5 A2.6 2.6 0 0 1 41.9 44.5 Z', role: 'gleam', opacity: 0.9 },
        ],
        line: [
            'M8 48 C22 27 34 22 48 22 C62 22 74 27 88 48 C74 69 62 74 48 74 C34 74 22 69 8 48 Z',
            'M48 33 A15 15 0 1 1 48 63 A15 15 0 0 1 48 33 Z',
        ],
    },
    {
        name: 'cloud',
        label: 'クラウド',
        clipShape: 'M28 72 A16 16 0 0 1 29 44 A21 21 0 0 1 66 38 A14 14 0 0 1 70 72 Z',
        // 雲。中心 x=48、底辺 y=72。外形 x=16〜80、y=24〜72。
        // 矢印は雲の内側（y=42〜66）に収め、下の陰と重ならないようにする。
        layers: [
            // 雲本体
            { d: 'M28 72 A16 16 0 0 1 29 40 A21 21 0 0 1 68 34 A15 15 0 0 1 72 72 Z', role: 'faceFront' },
            // 下部の陰（矢印より下に来ないよう y=62 以降に限定）
            { d: 'M28 72 A16 16 0 0 1 24 62 C40 66 58 66 76 62 A15 15 0 0 1 72 72 Z', role: 'shade', opacity: 0.8 },
            // 上部のハイライト
            { d: 'M35 38 A19 19 0 0 1 64 33 A21 21 0 0 0 35 38 Z', role: 'highlight', opacity: 0.5 },
            // 下向き矢印（雲の内側に収める）
            { d: 'M44 40 L52 40 L52 52 L58 52 L48 64 L38 52 L44 52 Z', role: 'accent' },
        ],
        line: ['M28 72 A16 16 0 0 1 29 40 A21 21 0 0 1 68 34 A15 15 0 0 1 72 72 Z'],
    },
    {
        name: 'firewall',
        label: 'ファイアウォール',
        // レンガ壁＋炎。壁は中心 x=48 で対称：前面 x=18〜78、上面の奥行き +8。
        //   壁 y=44〜82、目地は壁の内側のみ。炎は壁の上（y=8〜42）に置く。
        layers: [
            // 炎（壁より先に描いて背面へ）
            {
                d: 'M48 8 C50 18 57 21 57 28 C57 31 55.5 33 55.5 33 C59.5 31 60.5 27 60.5 27 C63 31 63 35 63 35 C63 41 56.5 44 48 44 C39.5 44 33 41 33 35 C33 30 36.5 26 40 22.5 C42 27.5 45 27.5 45 24 C45 18.5 46 13 48 8 Z',
                role: 'accent',
            },
            // 炎の芯。純白（highlight）を使うと炎の中に「水滴」が浮いて見えるので、
            // 明るい面色（faceTop）でごく淡く入れる。形も先端を左へ倒した非対称にする。
            { d: 'M46 27 C49 31 52 33 52 36 C52 39.5 50.3 41.5 48 41.5 C45.7 41.5 44 39.5 44 36.5 C44 34 45.2 31.5 46 27 Z', role: 'faceTop', opacity: 0.45 },
            // 壁の上面（奥行き）
            { d: 'M18 44 L26 38 L86 38 L78 44 Z', role: 'faceTop' },
            // 壁の右側面（奥行き）
            { d: 'M78 44 L86 38 L86 76 L78 82 Z', role: 'faceSide' },
            // 壁の前面
            { d: 'M18 44 L78 44 L78 82 L18 82 Z', role: 'faceFront' },
            // 目地（横）— 前面 x=18〜78 の内側
            { d: 'M18 56 L78 56 L78 59 L18 59 Z', role: 'faceSide', opacity: 0.85 },
            { d: 'M18 68 L78 68 L78 71 L18 71 Z', role: 'faceSide', opacity: 0.85 },
            // 目地（縦）— 段ごとに互い違い。すべて前面の内側
            { d: 'M46.5 44 L49.5 44 L49.5 56 L46.5 56 Z', role: 'faceSide', opacity: 0.85 },
            { d: 'M31.5 59 L34.5 59 L34.5 68 L31.5 68 Z', role: 'faceSide', opacity: 0.85 },
            { d: 'M61.5 59 L64.5 59 L64.5 68 L61.5 68 Z', role: 'faceSide', opacity: 0.85 },
            { d: 'M46.5 71 L49.5 71 L49.5 82 L46.5 82 Z', role: 'faceSide', opacity: 0.85 },
        ],
        line: [
            'M18 44 L78 44 L78 82 L18 82 Z',
            'M18 57 L78 57',
            'M18 69 L78 69',
            'M48 10 C50 19 57 22 57 29 C57 32 55.5 34 55.5 34 C60 32 61 28 61 28 C63 32 63 36 63 36 C63 41 56.5 44 48 44 C39.5 44 33 41 33 36 C33 31 36.5 27 40 23.5 C42 28 45 28 45 24.5 C45 19 46 14 48 10 Z',
        ],
    },
    {
        name: 'endpoint',
        label: 'エンドポイントPC',
        // ノートPC。中心 x=48、安全域(6〜90)内に収める。
        //   画面: 外枠 x=22〜74 / y=20〜60、内側 x=26〜70 / y=24〜56
        //   台座: 上面 x=14〜82（y=66〜76）、前面 x=10〜86（y=76〜80）
        layers: [
            // 画面の外枠
            { d: 'M22 20 L74 20 L74 60 L22 60 Z', role: 'faceSide' },
            // 画面の内側
            { d: 'M26 24 L70 24 L70 56 L26 56 Z', role: 'faceFront' },
            // 画面の中身（内側 x=26〜70 の内部に収める）
            { d: 'M32 31 L58 31 L58 35 L32 35 Z', role: 'accent', opacity: 0.9 },
            { d: 'M32 38 L50 38 L50 42 L32 42 Z', role: 'accent', opacity: 0.65 },
            { d: 'M32 45 L64 45 L64 49 L32 49 Z', role: 'accent', opacity: 0.45 },
            // 台座（上面＝明、前面＝暗）
            { d: 'M14 66 L82 66 L86 76 L10 76 Z', role: 'faceTop' },
            { d: 'M10 76 L86 76 L86 80 L10 80 Z', role: 'faceSide' },
            // 画面上辺のハイライト
            { d: 'M26 24 L70 24 L70 27 L26 27 Z', role: 'highlight', opacity: 0.3 },
        ],
        line: [
            'M22 20 L74 20 L74 60 L22 60 Z',
            'M14 66 L82 66 L86 76 L10 76 Z',
            'M32 33 L58 33',
            'M32 43 L50 43',
        ],
    },
    {
        name: 'bug',
        label: 'バグ（マルウェア）',
        clipShape: 'M48 29 A19 25 0 1 1 48 79 A19 25 0 0 1 48 29 Z',
        // 甲虫。中心 x=48。胴は楕円 cx=48 cy=54 rx=19 ry=25（x=29〜67 / y=29〜79）。
        // 縞は胴の内側だけに収める（楕円の幅は y ごとに変わるので、各段の幅を個別に決める）。
        layers: [
            // 脚（胴より先に描く＝背面）。左右対称
            { d: 'M32 44 L19 36 L17 40 L30 48 Z', role: 'faceSide' },
            { d: 'M64 44 L77 36 L79 40 L66 48 Z', role: 'faceSide' },
            { d: 'M30 56 L16 56 L16 60 L30 60 Z', role: 'faceSide' },
            { d: 'M66 56 L80 56 L80 60 L66 60 Z', role: 'faceSide' },
            { d: 'M32 68 L19 76 L21 80 L34 72 Z', role: 'faceSide' },
            { d: 'M64 68 L77 76 L75 80 L62 72 Z', role: 'faceSide' },
            // 触角（左右対称）
            { d: 'M42 22 L35 13 L32 15 L39 24 Z', role: 'faceSide' },
            { d: 'M54 22 L61 13 L64 15 L57 24 Z', role: 'faceSide' },
            // 頭部
            { d: 'M48 16 A11 9 0 1 1 48 34 A11 9 0 0 1 48 16 Z', role: 'faceSide' },
            // 胴体（楕円）
            { d: 'M48 29 A19 25 0 1 1 48 79 A19 25 0 0 1 48 29 Z', role: 'faceFront' },
            // 胴の左半分（陰）
            { d: 'M48 29 A19 25 0 0 0 48 79 A19 25 0 0 1 48 29 Z', role: 'shade' },
            // 背中の分割線（胴の内側）
            { d: 'M46.5 31 L49.5 31 L49.5 77 L46.5 77 Z', role: 'accent', opacity: 0.8 },
            // 甲羅の横縞。胴は cx=48 cy=54 rx=19 ry=25 なので、y での半幅は
            // 19*√(1-((y-54)/25)²)。各段はその半幅から 2px 余裕を引いた幅にする。
            //   y=44 → 半幅 17.4 → x=33〜63
            //   y=56 → 半幅 18.9 → x=31.5〜64.5
            //   y=68 → 半幅 15.7 → x=35〜61
            { d: 'M33 42 L63 42 L63 46 L33 46 Z', role: 'accent' },
            { d: 'M31.5 54 L64.5 54 L64.5 58 L31.5 58 Z', role: 'accent', opacity: 0.7 },
            { d: 'M35 66 L61 66 L61 70 L35 70 Z', role: 'accent', opacity: 0.5 },
            // 胴上部のハイライト
            { d: 'M38 38 A16 19 0 0 1 55 33 A19 25 0 0 0 38 38 Z', role: 'highlight', opacity: 0.32 },
        ],
        line: [
            'M48 29 A19 25 0 1 1 48 79 A19 25 0 0 1 48 29 Z',
            'M48 31 L48 77',
            'M32 44 L19 36',
            'M64 44 L77 36',
            'M30 58 L16 58',
            'M66 58 L80 58',
            'M32 68 L19 76',
            'M64 68 L77 76',
        ],
    },
];

const ICON_BY_NAME = new Map(ICONS.map((ic) => [ic.name, ic]));

// ---------------------------------------------------------------------------
// 小道具（数値・色）
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

// 文字列や数値を安全に数値化（カンマ・空白除去）
function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    const s = String(v).replace(/,/g, '').trim();
    if (s === '') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
}

function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim();
    if (h[0] !== '#') return null;
    h = h.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

function parseRgb(str) {
    if (typeof str !== 'string') return null;
    const m = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function toRgb(color) {
    return hexToRgb(color) || parseRgb(color);
}

// 2色を線形補間
function mixColor(colorA, colorB, ratio) {
    const a = toRgb(colorA);
    const b = toRgb(colorB);
    if (!a || !b) return colorA;
    const u = clamp01(ratio);
    return `rgb(${Math.round(a.r + (b.r - a.r) * u)},${Math.round(a.g + (b.g - a.g) * u)},${Math.round(
        a.b + (b.b - a.b) * u
    )})`;
}

function withAlpha(color, alpha) {
    const rgb = toRgb(color);
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.round(alpha * 1000) / 1000})`;
    return color;
}

// 彩度を上げる（グロー用。基準色を鮮やかに寄せる）
function saturate(color, amount) {
    const rgb = toRgb(color);
    if (!rgb) return color;
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const mid = (max + min) / 2;
    const push = (c) => clamp(Math.round(mid + (c - mid) * (1 + amount)), 0, 255);
    return `rgb(${push(rgb.r)},${push(rgb.g)},${push(rgb.b)})`;
}

function fmtValue(n, decimals, abbreviate) {
    if (!Number.isFinite(n)) return '-';
    if (abbreviate) {
        const abs = Math.abs(n);
        const units = [
            [1e12, 'T'],
            [1e9, 'B'],
            [1e6, 'M'],
            [1e3, 'K'],
        ];
        for (const [u, suf] of units) {
            if (abs >= u) {
                const v = n / u;
                const str = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
                return str + suf;
            }
        }
    }
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    const d = clamp(Math.round(decimals) || 0, 0, 6);
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// CJK を含むかで文字幅を推定（SVG に measureText が無いための近似）
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.62;
    }
    return w;
}

// ---------------------------------------------------------------------------
// 色ロール → 実際の色
//
// 方式Cの中核。基準色1色から全レイヤーの色を導出するため、基準色が変われば
// 立体の陰影・LED・グローがまとめて追従する。
// ---------------------------------------------------------------------------

function resolveRoleColor(role, base, mode) {
    const isDark = mode === 'dark';
    switch (role) {
        case 'glow':
            return saturate(base, 0.35);
        // 3面のコントラストは強めに開ける。近い明度だとアイソメの立体感が出ず、
        // 「のっぺりした一色の塊」に見える（実際に描画して確認した）。
        case 'faceTop':
            // 上面：最も明るい面
            return isDark ? mixColor(base, '#ffffff', 0.55) : mixColor(base, '#ffffff', 0.62);
        case 'faceFront':
            // 前面：中間
            return isDark ? mixColor(base, '#0b0f1a', 0.18) : mixColor(base, '#ffffff', 0.12);
        case 'faceSide':
            // 側面：最も暗い面
            return isDark ? mixColor(base, '#05070d', 0.58) : mixColor(base, '#2b3644', 0.5);
        case 'accent':
            // LED・スリット：基準色そのまま（ここが光って見える）
            return base;
        case 'highlight':
            // 純白を重ねると面から浮いて「白い棒」に見える（両テーマで確認した）。
            // faceTop よりわずかに明るい程度に留めると、エッジの照り返しとして馴染む。
            return isDark ? mixColor(base, '#ffffff', 0.75) : mixColor(base, '#ffffff', 0.85);
        case 'gleam':
            // 鏡面反射（瞳の光点など）。highlight と違い、純白のまま強く出す
            return '#ffffff';
        case 'shade':
            // 曲面の陰。faceSide と同じ暗さだが、描画側で左→右に透明へ抜ける
            // グラデーションを掛けるため、境界線が出ない（seam 対策）
            return isDark ? mixColor(base, '#05070d', 0.58) : mixColor(base, '#2b3644', 0.5);
        case 'line':
            return isDark ? mixColor(base, '#ffffff', 0.25) : mixColor(base, '#000000', 0.15);
        default:
            return base;
    }
}

// ---------------------------------------------------------------------------
// しきい値バンド → 色
//
// editor.threshold は [{from,to,value}] を生で届ける（openRanges:true のとき
// from/to が null になりうる）。null は ±Infinity として扱う。
// ---------------------------------------------------------------------------

function normalizeBands(raw) {
    if (!Array.isArray(raw)) return null;
    const bands = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const color = typeof b.value === 'string' ? b.value : null;
        if (!color || !toRgb(color)) return;
        const from = b.from === null || b.from === undefined ? -Infinity : parseNum(b.from);
        const to = b.to === null || b.to === undefined ? Infinity : parseNum(b.to);
        if (Number.isNaN(from) || Number.isNaN(to)) return;
        bands.push({ from, to, color });
    });
    return bands.length > 0 ? bands : null;
}

// 値からバンドの色を引く。どのバンドにも入らない場合は最も近いバンドへ倒す
// （バンドの隙間や範囲外で「色が付かない」のを避ける）。
function colorForValue(value, bands, fallback) {
    if (!Array.isArray(bands) || bands.length === 0) return fallback;
    if (!Number.isFinite(value)) return fallback;

    for (const b of bands) {
        // 下端は含み、上端は含まない（最上位バンドの上端が有限なら含める）
        if (value >= b.from && value < b.to) return b.color;
    }
    // 範囲外：最上位バンドの上端ちょうど、または全バンド外
    let best = null;
    let bestDist = Infinity;
    for (const b of bands) {
        const lo = b.from === -Infinity ? value : b.from;
        const hi = b.to === Infinity ? value : b.to;
        const dist = value < lo ? lo - value : value > hi ? value - hi : 0;
        if (dist < bestDist) {
            bestDist = dist;
            best = b;
        }
    }
    return best ? best.color : fallback;
}

// ---------------------------------------------------------------------------
// オプション正規化（型・範囲を安全側へ）
//
// 【重要】旧オプションへのフォールバックは実装しない。ホストは optionsSchema の
// default と同じ値を options に載せないことがあるため、旧キーを読むと
// 「既定値を選んだときだけ直らない」不具合になる。未設定なら既定値へ倒す。
// ---------------------------------------------------------------------------

function normalizeOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const o = { ...DEFAULTS, ...src };
    const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
    const numOr = (v, d) => {
        const n = parseNum(v);
        return Number.isFinite(n) ? n : d;
    };
    const colorOr = (v, d) => (toRgb(v) ? v : d);
    const strOr = (v, d) => (typeof v === 'string' ? v : d);
    const pick = (v, list, d) => (typeof v === 'string' && list.includes(v) ? v : d);

    return {
        labelField: typeof o.labelField === 'string' || Array.isArray(o.labelField) ? o.labelField : '',
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',

        iconName: ICON_BY_NAME.has(o.iconName) ? o.iconName : DEFAULTS.iconName,
        iconStyle: pick(o.iconStyle, ICON_STYLES, DEFAULTS.iconStyle),

        colorMode: pick(o.colorMode, COLOR_MODES, DEFAULTS.colorMode),
        baseColor: colorOr(o.baseColor, DEFAULTS.baseColor),
        colorBands: normalizeBands(o.colorBands) || normalizeBands(DEFAULTS.colorBands),

        showGlow: bool(o.showGlow, DEFAULTS.showGlow),
        showShadow: bool(o.showShadow, DEFAULTS.showShadow),
        pulseMode: pick(o.pulseMode, PULSE_MODES, DEFAULTS.pulseMode),

        showValue: bool(o.showValue, DEFAULTS.showValue),
        showLabel: bool(o.showLabel, DEFAULTS.showLabel),
        labelText: strOr(o.labelText, ''),
        unitText: strOr(o.unitText, ''),
        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),

        aggregation: pick(o.aggregation, AGGREGATIONS, DEFAULTS.aggregation),
        iconScale: clamp(numOr(o.iconScale, DEFAULTS.iconScale), 0.3, 1),
        showCard: bool(o.showCard, DEFAULTS.showCard),
    };
}

// ---------------------------------------------------------------------------
// データ正規化
//
// rows / columns 両形式に対応（columns 形式で届くことがあり、rows だけ見ると
// 「サーチを紐づけているのに 0 行」になる）。
// ---------------------------------------------------------------------------

function normalizeData(data) {
    try {
        if (data && Array.isArray(data.rows) && data.rows.length > 0) return data.rows;
        if (data && Array.isArray(data.columns) && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

// columnSelector は DOS 文字列で届くため、フィールド名を取り出して解決する。
// 生のフィールド名・ホスト解決済み配列・未設定にも耐える。
function resolveFieldIndex(optValue, fieldNames, rows, fallbackIdx) {
    if (optValue === undefined || optValue === null || optValue === '') return fallbackIdx;

    // ホストが配列で渡してくる場合：列内容の照合で特定する
    if (Array.isArray(optValue)) {
        if (optValue.length === 0) return fallbackIdx;
        const target = optValue.map((v) => String(v));
        for (let c = 0; c < fieldNames.length; c += 1) {
            const col = rows.map((r) => (Array.isArray(r) ? String(r[c]) : ''));
            if (col.length === target.length && col.every((v, i) => v === target[i])) return c;
        }
        return fallbackIdx;
    }

    if (typeof optValue !== 'string') return fallbackIdx;

    // DOS 文字列： > primary | seriesByName('src')  /  seriesByIndex(2)
    const byName = optValue.match(/seriesByName\(\s*['"]([^'"]+)['"]\s*\)/);
    if (byName) {
        const idx = fieldNames.indexOf(byName[1]);
        return idx >= 0 ? idx : fallbackIdx;
    }
    const byIndex = optValue.match(/seriesByIndex\(\s*(\d+)\s*\)/);
    if (byIndex) {
        const idx = Number(byIndex[1]);
        return idx >= 0 && idx < fieldNames.length ? idx : fallbackIdx;
    }

    // 生のフィールド名
    const direct = fieldNames.indexOf(optValue);
    if (direct >= 0) return direct;

    return fallbackIdx;
}

// 値フィールドを集計方法で1つの数値にする
function aggregate(values, mode) {
    if (mode === 'count') return values.length;
    if (values.length === 0) return NaN;
    switch (mode) {
        case 'sum':
            return values.reduce((a, b) => a + b, 0);
        case 'avg':
            return values.reduce((a, b) => a + b, 0) / values.length;
        case 'max':
            return Math.max(...values);
        case 'min':
            return Math.min(...values);
        case 'last':
        default:
            return values[values.length - 1];
    }
}

function extractSingleValue(data, opts) {
    const rows = normalizeData(data);
    if (rows.length === 0) return { error: 'empty' };

    const fieldNames = ((data && data.fields) || []).map((f) => (f && f.name ? f.name : String(f)));
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { error: 'empty' };

    let labelIdx;
    let valIdx;
    if (colCount === 1) {
        labelIdx = -1;
        valIdx = 0;
    } else {
        labelIdx = resolveFieldIndex(opts.labelField, fieldNames, rows, 0);
        valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, colCount - 1);
        if (valIdx === labelIdx) valIdx = labelIdx === colCount - 1 ? 0 : colCount - 1;
    }

    const values = [];
    rows.forEach((row) => {
        if (!Array.isArray(row)) return;
        const v = parseNum(row[valIdx]);
        if (Number.isFinite(v)) values.push(v);
    });

    // count 集計だけは数値が1つも無くても行数で成立する
    if (values.length === 0 && opts.aggregation !== 'count') return { error: 'novalue' };

    const value = aggregate(values, opts.aggregation);
    if (!Number.isFinite(value)) return { error: 'novalue' };

    // ラベル：オプション優先 → 値フィールド名 → ラベル列の最終値
    let label = opts.labelText;
    if (!label) label = fieldNames[valIdx] || '';
    if (!label && labelIdx >= 0) {
        const lastRow = rows[rows.length - 1];
        if (Array.isArray(lastRow) && lastRow[labelIdx] !== undefined) label = String(lastRow[labelIdx]);
    }

    return { value, label, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// テーマ配色（カード）
// ---------------------------------------------------------------------------

// 【重要】カード背景に不透明色を使ってはいけない（旧: ダーク #0d1020 / ライト #ffffff）。
// ダッシュボードのパネル背景を塗り潰してしまい、**画像エクスポート時に背景が
// くり抜かれず、viz の地色が写り込む**（実機で発生）。
// radial-bar 等は 'transparent' にしており、透過のままエクスポートできる。
// カードの「面」はアクセント色の半透明グラデーション（cardGrad）だけで表現する。
// そのため cardBase に相当する不透明色はここでは持たない。
function cardColors(mode, accent) {
    if (mode === 'dark') {
        return {
            cardGrad: `linear-gradient(150deg, ${withAlpha(accent, 0.18)} 0%, ${withAlpha(accent, 0.05)} 45%, rgba(10,12,24,0) 75%)`,
            border: withAlpha(accent, 0.42),
            value: mixColor(accent, '#ffffff', 0.4),
            label: '#8b98a5',
            subText: '#6e7b8a',
        };
    }
    return {
        cardGrad: `linear-gradient(150deg, ${withAlpha(accent, 0.12)} 0%, ${withAlpha(accent, 0.03)} 45%, rgba(255,255,255,0) 75%)`,
        border: withAlpha(accent, 0.38),
        value: mixColor(accent, '#000000', 0.4),
        label: '#5c6773',
        subText: '#6b7684',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// アイコン描画（多層 SVG）
//
// パフォーマンス注記：
//   ・グロー（feGaussianBlur）を使う層は静的に保つ。アニメーションは
//     フィルタの外にある要素の属性を rAF で直接書き換えるため、
//     ぼかしの再計算が毎フレーム走らない。
//   ・形状は不変で色だけ変わるので reflow が発生しない。
// ---------------------------------------------------------------------------

function LayeredIcon({ icon, size, base, mode, showGlow, showShadow, pulseMode, uid }) {
    const ringRef = useRef(null);

    // アニメーション：フィルタの外にあるリングの r / opacity だけを直接書き換える
    // （フィルタ付きの層を毎フレーム触るとぼかしが再計算されるため）。
    useEffect(() => {
        if (pulseMode !== 'ring') {
            if (ringRef.current) ringRef.current.setAttribute('opacity', '0');
            return undefined;
        }
        let raf = 0;
        let start = null;
        const step = (ts) => {
            if (start === null) start = ts;
            const t = (ts - start) / 1000;
            if (ringRef.current) {
                // 2.4秒周期で広がるリング
                const phase = (t / 2.4) % 1;
                ringRef.current.setAttribute('r', String(26 + phase * 22));
                ringRef.current.setAttribute('opacity', String(Math.round((1 - phase) * 0.5 * 1000) / 1000));
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [pulseMode, icon.name]);

    const glowId = `glow-${uid}`;
    const shadowId = `shadow-${uid}`;
    const glowColor = resolveRoleColor('glow', base, mode);

    // 線画モード
    if (icon.style === 'outline') {
        const lineColor = resolveRoleColor('line', base, mode);
        return (
            <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">
                {showGlow && (
                    <defs>
                        <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
                            <feGaussianBlur stdDeviation="3" result="b" />
                            <feMerge>
                                <feMergeNode in="b" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>
                )}
                {showShadow && <ellipse cx="48" cy="88" rx="26" ry="5" fill={withAlpha(glowColor, 0.28)} />}
                {pulseMode === 'ring' && (
                    <circle ref={ringRef} cx="48" cy="48" r="26" fill="none" stroke={base} strokeWidth="2" opacity="0" />
                )}
                <g filter={showGlow ? `url(#${glowId})` : undefined}>
                    {(icon.line || []).map((d, i) => (
                        <path
                            key={`l${i}`}
                            d={d}
                            stroke={lineColor}
                            strokeWidth="3.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                        />
                    ))}
                </g>
            </svg>
        );
    }

    // 立体モード
    //
    // 面はベタ塗りにせず、ロールごとの線形グラデーションで塗る。
    // ベタ塗りだと「色を塗り分けただけの平面」に見えてチープになるため
    // （実際に描画して確認した）。光源は左上と想定し、上→下で暗くなる向きに統一する。
    const gradId = (role) => `g-${role}-${uid}`;
    const GRADIENT_ROLES = ['faceTop', 'faceFront', 'faceSide', 'accent'];
    // 各ロールの [上端の明度寄せ, 下端の明度寄せ]。正=白寄り／負=黒寄り
    const GRAD_SHIFT = {
        faceTop: [0.14, -0.06],
        faceFront: [0.1, -0.14],
        faceSide: [0.06, -0.16],
        accent: [0.16, -0.1],
    };
    const shiftColor = (color, amount) =>
        amount >= 0 ? mixColor(color, '#ffffff', amount) : mixColor(color, mode === 'dark' ? '#05070d' : '#2b3644', -amount);

    return (
        <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">
            <defs>
                {showGlow && (
                    <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="5" />
                    </filter>
                )}
                {showShadow && (
                    <filter id={shadowId} x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="3.5" />
                    </filter>
                )}
                {/* 面のグラデーション。userSpaceOnUse で viewBox 全体（y=8〜88）を基準にし、
                    「アイコン全体を1つの光源が照らしている」状態にする。既定の
                    objectBoundingBox だとレイヤーごとに基準が変わり、隣り合う面で
                    明るさが噛み合わずパッチワークに見える。 */}
                {GRADIENT_ROLES.map((role) => {
                    const c = resolveRoleColor(role, base, mode);
                    const [top, bottom] = GRAD_SHIFT[role];
                    return (
                        <linearGradient
                            key={role}
                            id={gradId(role)}
                            gradientUnits="userSpaceOnUse"
                            x1="20"
                            y1="8"
                            x2="60"
                            y2="88"
                        >
                            <stop offset="0%" stopColor={shiftColor(c, top)} />
                            <stop offset="100%" stopColor={shiftColor(c, bottom)} />
                        </linearGradient>
                    );
                })}
                {/* 曲面の陰（丸い形＝人・雲・虫・盾・警告に使う）。
                    陰のパスは「左半分」なので、右端 x=48 に直線の切れ目ができる。
                    グラデーションの終点を x=48 に合わせるだけでは seam（硬い縦線）は
                    消えない（座標を何度か調整して描画で確認した）。
                    そこで陰の層自体を feGaussianBlur で軽くぼかし、切れ目を溶かす。
                    はみ出さないよう、直前に描く本体シェイプで clip する。
                    ※ 静的なので毎フレームの再計算は発生しない。 */}
                <filter id={`shadeblur-${uid}`} x="-25%" y="-25%" width="150%" height="150%">
                    <feGaussianBlur stdDeviation="5" />
                </filter>
                <linearGradient
                    id={gradId('shade')}
                    gradientUnits="userSpaceOnUse"
                    x1="10"
                    y1="24"
                    x2="60"
                    y2="60"
                >
                    <stop offset="0%" stopColor={resolveRoleColor('shade', base, mode)} stopOpacity="1" />
                    <stop offset="45%" stopColor={resolveRoleColor('shade', base, mode)} stopOpacity="0.72" />
                    <stop offset="100%" stopColor={resolveRoleColor('shade', base, mode)} stopOpacity="0" />
                </linearGradient>
                {/* 陰を本体の輪郭で切り抜くための clip。
                    各アイコンの clipShape（＝本体の外形）を使う。 */}
                {icon.clipShape && (
                    <clipPath id={`clip-${uid}`}>
                        <path d={icon.clipShape} />
                    </clipPath>
                )}
            </defs>

            {/* 接地シャドウ（静的。フィルタは据え置き） */}
            {showShadow && (
                <ellipse
                    cx="48"
                    cy="88"
                    rx="28"
                    ry="6"
                    fill={mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(40,50,66,0.3)'}
                    filter={`url(#${shadowId})`}
                />
            )}

            {/* 背後のグロー（静的。ぼかしは1回だけ計算される） */}
            {showGlow && (
                <ellipse cx="48" cy="56" rx="30" ry="26" fill={withAlpha(glowColor, 0.42)} filter={`url(#${glowId})`} />
            )}

            {/* パルスリング（フィルタの外なので毎フレーム更新しても安い） */}
            {pulseMode === 'ring' && (
                <circle ref={ringRef} cx="48" cy="52" r="26" fill="none" stroke={base} strokeWidth="2.5" opacity="0" />
            )}

            {/* 本体レイヤー。面はグラデーション、光沢系はベタで塗る。
                shade はぼかして本体の輪郭で切り抜く（seam 対策） */}
            {icon.layers.map((layer, i) => {
                const isShade = layer.role === 'shade';
                return (
                    <path
                        key={`s${i}`}
                        d={layer.d}
                        fill={
                            GRADIENT_ROLES.includes(layer.role) || isShade
                                ? `url(#${gradId(layer.role)})`
                                : resolveRoleColor(layer.role, base, mode)
                        }
                        opacity={layer.opacity === undefined ? 1 : layer.opacity}
                        filter={isShade ? `url(#shadeblur-${uid})` : undefined}
                        clipPath={isShade && icon.clipShape ? `url(#clip-${uid})` : undefined}
                        data-role={layer.role}
                    />
                );
            })}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// スピナー永久表示（サーチ完了通知の取りこぼし）対策
//
// 公式 useDataSources は「render 時に getDataSources() でシード → useEffect で購読」
// の構造で、シードと購読の間に届いた更新を取り逃す（ホストは購読登録時に現在値を
// 再送しない。実機確認済み）。取り逃したのがサーチ完了の最終通知だと、以後更新が
// 来ないため loading:true のまま固まり、スピナーが回り続ける。
// 対策として、公式フックが loading の間は getDataSources() を定期的に読み直し、
// ホスト側がすでに完了していればその値を採用する。完了後は何もしない（コストゼロ）。
// ---------------------------------------------------------------------------

const RESCUE_POLL_MS = 500;

function useDataSourcesWithRescue() {
    const official = useDataSources();
    const [rescue, setRescue] = useState(null);
    const officialLoading = Boolean(official?.loading);

    useEffect(() => {
        if (!officialLoading) return undefined;
        setRescue(null); // 新しいロードサイクル。前回の回収値は使わない
        let timer = 0;
        const tick = () => {
            try {
                const cur = globalThis.DashboardExtensionAPI?.getDataSources?.();
                if (cur && !cur.loading) {
                    setRescue(cur); // ホストは完了済み＝最終通知を取り逃していた。回収して終了
                    return;
                }
            } catch (e) {
                /* ホスト未応答でも落とさない。次のtickで再試行 */
            }
            timer = setTimeout(tick, RESCUE_POLL_MS);
        };
        timer = setTimeout(tick, RESCUE_POLL_MS);
        return () => clearTimeout(timer);
    }, [officialLoading]);

    return officialLoading && rescue ? rescue : official;
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

function IconStatus({ mode }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
    const { options } = useOptions();

    const opts = useMemo(() => normalizeOptions(options), [options]);

    // コンテナ実寸に自動フィット
    const containerRef = useRef(null);
    const [size, setSize] = useState({ w: 300, h: 260 });

    const attachContainer = useCallback((el) => {
        containerRef.current = el;
        if (!el) return;
        const measure = () => {
            const w = el.clientWidth || 300;
            const h = el.clientHeight || 260;
            setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        };
        measure();
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(measure);
            ro.observe(el);
            el._ro = ro;
        }
    }, []);

    useEffect(() => {
        return () => {
            const el = containerRef.current;
            if (el && el._ro) {
                el._ro.disconnect();
                el._ro = null;
            }
        };
    }, []);

    const primary = dataSources && dataSources.primary;
    const data = primary && primary.data;

    const result = useMemo(() => {
        if (!data) return { error: 'empty' };
        try {
            return extractSingleValue(data, opts);
        } catch (e) {
            return { error: 'empty' };
        }
    }, [data, opts]);

    // 一意な filter id（同一ダッシュボードに複数枚並べたときの id 衝突回避）
    const uidRef = useRef(null);
    if (uidRef.current === null) {
        uidRef.current = `is${Math.floor(Math.random() * 1e9).toString(36)}`;
    }

    if (loading) {
        return (
            <div className="viz-container viz-container--empty" data-viz-version={VIZ_VERSION} style={{ background: 'transparent' }}>
                <WaitSpinner size="medium" />
            </div>
        );
    }

    if (result.error) {
        return (
            <div className="viz-container viz-container--empty" data-viz-version={VIZ_VERSION} style={{ background: 'transparent' }}>
                <div className="viz-message">
                    <Paragraph>データがありません。サーチ結果を確認してください。</Paragraph>
                    <Paragraph style={{ opacity: 0.7, fontSize: 12 }}>
                        数値フィールドを1つ以上含むサーチ結果が必要です。
                    </Paragraph>
                </div>
            </div>
        );
    }

    const { value, label } = result;

    // 基準色：しきい値モードなら値からバンドを引く
    const base =
        opts.colorMode === 'threshold'
            ? colorForValue(value, opts.colorBands, opts.baseColor)
            : opts.baseColor;

    const pal = cardColors(mode, base);

    // --- レイアウト計算（段階的に退避） ---------------------------------
    //
    // 余白は「はみ出さない範囲でできるだけ小さく」する方針。
    // カード枠を出すときは枠線と中身が接すると窮屈なので最小限の内側余白を取り、
    // 枠なし（showCard=false）ならほぼゼロにして描画領域を最大化する。
    const { w, h } = size;
    const pad = opts.showCard
        ? clamp(Math.round(Math.min(w, h) * 0.035), 4, 10)
        : clamp(Math.round(Math.min(w, h) * 0.015), 1, 4);
    const availW = Math.max(40, w - pad * 2);
    const availH = Math.max(40, h - pad * 2);

    const valueText = `${fmtValue(value, opts.valueDecimals, opts.abbreviateValue)}${opts.unitText || ''}`;
    const labelString = opts.labelText || label || '';

    // 小さいパネルでは ラベル → 数値 の順に退避
    const labelVisible = opts.showLabel && Boolean(labelString) && availH >= 110 && availW >= 90;
    const valueVisible = opts.showValue && availH >= 78;

    // 数値のフォントサイズ：幅に収まるまで縮める
    let valueFont = clamp(Math.round(Math.min(availW * 0.22, availH * 0.2)), 12, 54);
    if (valueVisible) {
        const maxW = availW * 0.94;
        let guard = 0;
        while (estimateTextWidth(valueText, valueFont) > maxW && valueFont > 11 && guard < 60) {
            valueFont -= 1;
            guard += 1;
        }
    }
    const labelFont = clamp(Math.round(valueFont * 0.34), 10, 15);

    const textBlockH =
        (valueVisible ? Math.round(valueFont * 1.18) : 0) + (labelVisible ? Math.round(labelFont * 1.7) : 0);

    // アイコンサイズ：テキストを引いた残りの領域いっぱいに広げる（倍率オプションを乗算）。
    // 固定の上限（旧 260px）は設けない。大きいパネルで下に余白が残るため。
    // gap はテキスト行の数だけ差し引く。
    const gapPx = valueVisible || labelVisible ? Math.max(2, Math.round(pad * 0.35)) : 0;
    const gapTotal = gapPx * ((valueVisible ? 1 : 0) + (labelVisible ? 1 : 0));
    const iconRoom = Math.max(28, Math.min(availW, availH - textBlockH - gapTotal));
    // 倍率は 1.0 超も選べるが、領域を超えるとパネルからはみ出すので iconRoom で頭打ちにする
    // （固定上限を外した際、倍率1.6でカードを突き破る不具合を出した）
    const iconSize = clamp(Math.round(iconRoom * opts.iconScale), 24, iconRoom);

    // 質感：小さすぎるパネルでは立体の3面が潰れて読めなくなるので自動で線画に落とす。
    // 96x96 の viewBox を 56px 未満に縮めると面の描き分けが視認できなくなるため、
    // そこを境界にする（線画のほうが小さくても形が分かる）。
    const effectiveStyle = opts.iconStyle === 'solid' && iconSize < 56 ? 'outline' : opts.iconStyle;
    const iconDef = ICON_BY_NAME.get(opts.iconName) || ICONS[0];
    const icon = { ...iconDef, style: effectiveStyle };

    // 背景は「常に透過」。カード表示時もベタ塗りはせず、アクセント色の半透明
    // グラデーション（cardGrad）だけを重ねる。こうしないとパネル背景を塗り
    // 潰してしまい、画像エクスポートで背景がくり抜かれなくなる。
    //
    // ⚠ background（一括指定）と backgroundImage（個別指定）を混ぜないこと。
    // 混在させるとトグル時に React が
    // "Removing a style property during rerender" を警告し、
    // 片方が消えない／消えすぎる不具合になる。常に同じキー集合を渡す。
    const cardStyle = opts.showCard
        ? {
              backgroundColor: 'transparent',
              backgroundImage: pal.cardGrad,
              border: `1px solid ${pal.border}`,
              borderRadius: 10,
              boxShadow: opts.showGlow ? `0 0 18px ${withAlpha(base, 0.18)}` : 'none',
          }
        : {
              backgroundColor: 'transparent',
              backgroundImage: 'none',
              border: 'none',
              borderRadius: 0,
              boxShadow: 'none',
          };

    return (
        <div
            ref={attachContainer}
            className="viz-container"
            data-viz-version={VIZ_VERSION}
            data-icon={opts.iconName}
            data-base-color={base}
            // 【重要】ルートに background: 'transparent' を明示すること。
            // 指定しないと iframe / ホスト側の既定背景が残り、**画像エクスポート時に
            // 背景がくり抜かれない**（実機で発生。カード側だけ透過にしても直らなかった）。
            // 透過エクスポートできている radial-bar はここを明示している。
            style={{ padding: 0, overflow: 'hidden', background: 'transparent' }}
        >
            <div
                data-role="card"
                style={{
                    width: '100%',
                    height: '100%',
                    boxSizing: 'border-box',
                    padding: pad,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: gapPx,
                    fontFamily: FONT_STACK,
                    ...cardStyle,
                }}
            >
                <div data-role="icon-wrap" style={{ lineHeight: 0, flexShrink: 0 }}>
                    <LayeredIcon
                        icon={icon}
                        size={iconSize}
                        base={base}
                        mode={mode}
                        showGlow={opts.showGlow}
                        showShadow={opts.showShadow}
                        pulseMode={opts.pulseMode}
                        uid={uidRef.current}
                    />
                </div>

                {valueVisible && (
                    <div
                        data-role="value"
                        style={{
                            fontSize: valueFont,
                            lineHeight: 1.1,
                            fontWeight: 700,
                            color: pal.value,
                            letterSpacing: '-0.01em',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {valueText}
                    </div>
                )}

                {labelVisible && (
                    <div
                        data-role="label"
                        style={{
                            fontSize: labelFont,
                            lineHeight: 1.3,
                            color: pal.label,
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            textAlign: 'center',
                        }}
                        title={labelString}
                    >
                        {labelString}
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（マウントゲート必須）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light';
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <IconStatus mode={mode} />
        </SplunkThemeProvider>
    );
}

const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
    } catch (e) {
        return false;
    }
}

function mountApp() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(
        <VisualizationExtensionProvider>
            <App />
        </VisualizationExtensionProvider>
    );
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
