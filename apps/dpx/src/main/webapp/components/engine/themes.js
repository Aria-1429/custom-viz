// ── DPX デザインプリセット ────────────────────────────────────────
// 「映える」を既定にするための一括テーマ。definition.style.preset で選び、
// definition.style.accent で差し色だけ上書きできる。
//
// パネルスタイル（パネル側 style.variant）:
//   card      … 従来のカード（枠・タイトルバーあり）
//   glass     … すりガラス（半透明＋blur。重ね置きで映える）
//   frameless … 枠なし・背景透過（全面背景 viz や装飾テキスト用）
// ────────────────────────────────────────────────────────────────

import { createContext, useContext } from 'react';

const base = {
    fontFamily: "'Segoe UI', 'Hiragino Sans', sans-serif",
};

// ネイティブ viz の系列色（プリセットごと）
const PALETTES = {
    midnight: ['#4ea1ff', '#7b6cff', '#3cdcb4', '#ffb020', '#ff5c8a', '#38c6f4'],
    neon: ['#00e5ff', '#ff2d95', '#b44cff', '#ffe14c', '#3cff9e', '#ff8c42'],
    aurora: ['#3cdcb4', '#4ea1ff', '#b0ff5c', '#ffb020', '#ff7b7b', '#7b6cff'],
    light: ['#1e93c6', '#7b56db', '#2fa874', '#e8a33d', '#d95565', '#4a7ba6'],
    carbon: ['#6ea8fe', '#9d8cff', '#4fd1a5', '#ffc457', '#ff7a90', '#57cfe8'],
    amber: ['#ffb545', '#ff8c42', '#ffd670', '#e8734a', '#c0d860', '#7fc4a8'],
    slate: ['#5b9bd5', '#8f7fd8', '#4fb99f', '#d9a441', '#cf6b7a', '#6fa8bd'],
    matrix: ['#3cff9e', '#7dffc4', '#22d47c', '#c8ff8a', '#4fe8d0', '#a0ff5c'],
    paper: ['#2f6f9f', '#8a5cc4', '#2f8f6a', '#c98a2e', '#c05464', '#5a7f99'],
    // 活版：刷り色のパレット。藍・臙脂・緑青・褐色といった実際の印刷インクに寄せる。
    // ⚠ ネイティブ viz は色を `linear-gradient(色 → 色+77)` で塗るので、
    //   暗すぎるインクだと**濁った灰色の面**になる（実機で確認）。
    //   地が紙色なので、面で塗っても沈まない**中明度**にしてある
    letterpress: ['#3d6389', '#a8544f', '#4a7d66', '#a8873f', '#6a6a8c', '#7f9478'],
    // 青焼き：製図の線色。白／シアン／黄が図面のインク
    blueprint: ['#8fd3ff', '#ffffff', '#ffd97a', '#7ae0c8', '#c3b6ff', '#ff9fb0'],
    // サーマル：熱の偽色スケール（冷→熱）。系列色もこの順に並べる
    thermal: ['#ff9d2e', '#ff5a3c', '#ffd447', '#c2447f', '#7a3fa8', '#39c2c9'],
    // E Ink：電子ペーパー。彩度をほぼ持たず、濃淡で系列を分ける
    eink: ['#2b2b2b', '#6b6b6b', '#4a5a6a', '#8a8a8a', '#3f4f45', '#a0a0a0'],
    // 水彩：透明水彩の定番顔料（セルリアン・ローズマダー・サップグリーン・
    // イエローオーカー・すみれ・バーントシェンナ）。
    // ⚠ 紙地の上に `linear-gradient(色 → 色+77)` で面塗りされるので、
    //   絵具の「薄めた一段」に相当する中明度で持つ（letterpress と同じ理由）
    watercolor: ['#4a90bd', '#c46a84', '#6aa06f', '#c9973f', '#8a74b8', '#bd7a55'],
    // クレヨン：黒画用紙に描く蝋の色。混色できない画材なので原色寄りの6色
    crayon: ['#ff6b4a', '#ffce3d', '#4db8e8', '#7ed957', '#ff5fa2', '#ffa03d'],
    // 色鉛筆：芯の色。紙の白が透けるぶん、彩度を一段落とした「粉っぽい」色
    pencil: ['#4a78b5', '#c0504d', '#5f9455', '#d9a33d', '#8a68a8', '#3f9a9a'],
    // インク＋水彩：ペン画に置くウォッシュ。インクの黒に負けない濁りのない中間色
    inkwash: ['#4a80ad', '#bf6a55', '#6a9a70', '#c99a45', '#7d6ba8', '#528fa0'],
    // Liquid Glass（iOS 26）：Apple のシステムカラー系。銀地のガラス越しでも
    // 沈まない、彩度の高い中明度6色（blue/green/orange/red/purple/teal）
    liquidGlass: ['#007aff', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#30b0c7'],
};

/** 明るい地のプリセット（colorScheme=light 扱い）。 */
const LIGHT_PRESETS = new Set([
    'light', 'paper', 'letterpress', 'eink',
    // 手描き系は「紙」が地なのでライト扱い（クレヨンだけ黒画用紙＝ダーク）
    'watercolor', 'pencil', 'inkwash',
    // Liquid Glass は WWDC25 の銀地（ライト）
    'liquidGlass',
]);

export const DPX_PRESETS = {
    midnight: {
        ...base,
        name: 'ミッドナイト',
        canvasBg:
            'radial-gradient(ellipse at 20% 0%, rgba(46,80,160,0.18), transparent 50%), linear-gradient(180deg, #0b1220 0%, #0e1628 100%)',
        titleColor: '#e8eefc',
        subColor: 'rgba(232, 238, 252, 0.55)',
        accent: '#4ea1ff',
        errorColor: '#ff7b7b',
        selection: '#4ea1ff',
        panel: {
            card: {
                background: 'rgba(20, 30, 52, 0.85)',
                border: '1px solid rgba(90, 130, 200, 0.25)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
            },
            glass: {
                background: 'rgba(24, 36, 64, 0.45)',
                border: '1px solid rgba(140, 180, 255, 0.28)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    neon: {
        ...base,
        name: 'ネオン',
        canvasBg:
            'radial-gradient(ellipse at 80% 10%, rgba(255,0,128,0.12), transparent 45%), radial-gradient(ellipse at 10% 90%, rgba(0,229,255,0.10), transparent 45%), linear-gradient(160deg, #0a0614 0%, #120a24 100%)',
        titleColor: '#f4ecff',
        subColor: 'rgba(244, 236, 255, 0.55)',
        accent: '#00e5ff',
        errorColor: '#ff5c8a',
        selection: '#ff2d95',
        panel: {
            card: {
                background: 'rgba(26, 16, 48, 0.85)',
                border: '1px solid rgba(255, 45, 149, 0.35)',
                boxShadow: '0 0 18px rgba(255, 45, 149, 0.18), 0 4px 24px rgba(0,0,0,0.5)',
            },
            glass: {
                background: 'rgba(30, 18, 56, 0.4)',
                border: '1px solid rgba(0, 229, 255, 0.35)',
                boxShadow: '0 0 22px rgba(0, 229, 255, 0.15), 0 8px 32px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    aurora: {
        ...base,
        name: 'オーロラ',
        canvasBg:
            'radial-gradient(ellipse at 70% 0%, rgba(60,220,180,0.14), transparent 50%), radial-gradient(ellipse at 20% 100%, rgba(120,80,255,0.14), transparent 50%), linear-gradient(180deg, #041418 0%, #071022 100%)',
        titleColor: '#eafff8',
        subColor: 'rgba(234, 255, 248, 0.55)',
        accent: '#3cdcb4',
        errorColor: '#ff8c6b',
        selection: '#3cdcb4',
        panel: {
            card: {
                background: 'rgba(10, 34, 40, 0.82)',
                border: '1px solid rgba(60, 220, 180, 0.25)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            },
            glass: {
                background: 'rgba(12, 40, 46, 0.42)',
                border: '1px solid rgba(60, 220, 180, 0.3)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    carbon: {
        ...base,
        name: 'カーボン（無彩色・硬質）',
        canvasBg: 'linear-gradient(180deg, #121417 0%, #16191d 100%)',
        titleColor: '#e6e9ee',
        subColor: 'rgba(230, 233, 238, 0.5)',
        accent: '#6ea8fe',
        errorColor: '#ff7b7b',
        selection: '#6ea8fe',
        panel: {
            card: {
                background: 'rgba(28, 31, 36, 0.9)',
                border: '1px solid rgba(255, 255, 255, 0.09)',
                boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
            },
            glass: {
                background: 'rgba(34, 38, 44, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    amber: {
        ...base,
        name: 'アンバー（琥珀の管制盤）',
        canvasBg:
            'radial-gradient(ellipse at 50% 0%, rgba(255,170,60,0.10), transparent 55%), linear-gradient(180deg, #17120a 0%, #1d1710 100%)',
        titleColor: '#ffeccd',
        subColor: 'rgba(255, 236, 205, 0.52)',
        accent: '#ffb545',
        errorColor: '#ff6b5c',
        selection: '#ffb545',
        panel: {
            card: {
                background: 'rgba(38, 29, 16, 0.86)',
                border: '1px solid rgba(255, 181, 69, 0.24)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
            },
            glass: {
                background: 'rgba(44, 34, 18, 0.45)',
                border: '1px solid rgba(255, 181, 69, 0.3)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    slate: {
        ...base,
        name: 'スレート（落ち着いた青灰）',
        canvasBg: 'linear-gradient(180deg, #1b2029 0%, #202634 100%)',
        titleColor: '#dde5f0',
        subColor: 'rgba(221, 229, 240, 0.5)',
        accent: '#5b9bd5',
        errorColor: '#e07a86',
        selection: '#5b9bd5',
        panel: {
            card: {
                background: 'rgba(38, 45, 58, 0.88)',
                border: '1px solid rgba(150, 175, 210, 0.16)',
                boxShadow: '0 3px 14px rgba(0,0,0,0.32)',
            },
            glass: {
                background: 'rgba(44, 53, 68, 0.5)',
                border: '1px solid rgba(150, 175, 210, 0.22)',
                boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    matrix: {
        ...base,
        name: 'マトリクス（緑のターミナル）',
        canvasBg:
            'radial-gradient(ellipse at 50% 100%, rgba(60,255,158,0.08), transparent 55%), linear-gradient(180deg, #05100a 0%, #071510 100%)',
        titleColor: '#d6ffe8',
        subColor: 'rgba(214, 255, 232, 0.5)',
        accent: '#3cff9e',
        errorColor: '#ff6b6b',
        selection: '#3cff9e',
        fontFamily: "'DejaVu Sans Mono', Menlo, Consolas, monospace",
        panel: {
            card: {
                background: 'rgba(8, 26, 18, 0.85)',
                border: '1px solid rgba(60, 255, 158, 0.22)',
                boxShadow: '0 0 14px rgba(60,255,158,0.08), 0 4px 20px rgba(0,0,0,0.5)',
            },
            glass: {
                background: 'rgba(10, 32, 22, 0.45)',
                border: '1px solid rgba(60, 255, 158, 0.28)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
    paper: {
        ...base,
        name: 'ペーパー（印刷物・高コントラスト）',
        canvasBg: '#eceff3',
        titleColor: '#14181f',
        subColor: 'rgba(20, 24, 31, 0.6)',
        accent: '#2f6f9f',
        errorColor: '#b8242e',
        selection: '#2f6f9f',
        panel: {
            card: {
                background: '#ffffff',
                border: '1px solid rgba(20, 24, 31, 0.16)',
                boxShadow: 'none',
            },
            glass: {
                background: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(20, 24, 31, 0.12)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                backdropFilter: 'blur(4px)',
            },
        },
    },
    letterpress: {
        ...base,
        name: 'レタープレス（活版・紙の質感）',
        // 生成りの紙。完全な平坦にせず、隅をわずかに焼けさせて「刷り物」に寄せる。
        // ⚠ ここは静的なグラデーション1枚だけ。animate しないので合成は一度きり
        //   （background-position を動かすと全面再描画になる。BackgroundLayer.jsx 参照）
        canvasBg:
            'radial-gradient(ellipse at 50% 0%, rgba(120,100,70,0.05), transparent 60%), linear-gradient(180deg, #e8e4d9 0%, #e2ddd0 100%)',
        titleColor: '#1a1f2b',
        subColor: 'rgba(26, 31, 43, 0.62)',
        accent: '#1f3a5f', // 藍のインク
        errorColor: '#8c3b3b', // 臙脂
        selection: '#2f5d4a', // 緑青
        // 見出しに明朝、機械ラベルに等幅。日本語の明朝は環境差が大きいので
        // 游明朝→ヒラギノ→IPA の順に落とし、最後は総称 serif で必ず着地させる
        fontFamily:
            "'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'Noto Serif JP', 'IPAexMincho', Georgia, serif",
        panel: {
            card: {
                // 紙より少し白い「貼り込んだ紙片」。影ではなく罫で浮かせる
                background: 'rgba(250, 248, 242, 0.92)',
                border: '1px solid rgba(26, 31, 43, 0.28)',
                boxShadow: 'none',
            },
            glass: {
                background: 'rgba(250, 248, 242, 0.75)',
                border: '1px solid rgba(26, 31, 43, 0.20)',
                boxShadow: 'none',
            },
        },
    },
    blueprint: {
        ...base,
        name: 'ブループリント（青焼き図面）',
        // 青焼き（シアノタイプ）：濃いプルシアンブルーの地に白とシアンの線。
        // 暗色だが**発光させない**のが要点。ネオン系との差はここにある
        canvasBg: 'linear-gradient(180deg, #0d2b52 0%, #10315c 100%)',
        titleColor: '#eaf4ff',
        subColor: 'rgba(234, 244, 255, 0.62)',
        accent: '#8fd3ff',
        errorColor: '#ff9fb0',
        selection: '#ffd97a',
        // 製図の文字＝等幅。図面の注記らしさが出る
        fontFamily: "'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        panel: {
            card: {
                // 地よりわずかに明るい「貼り込んだ図面」。影ではなく線で見せる
                background: 'rgba(20, 58, 104, 0.72)',
                border: '1px solid rgba(143, 211, 255, 0.34)',
                boxShadow: 'none',
            },
            glass: {
                background: 'rgba(20, 58, 104, 0.45)',
                border: '1px solid rgba(143, 211, 255, 0.28)',
                boxShadow: 'none',
            },
        },
    },
    thermal: {
        ...base,
        name: 'サーマル（熱画像）',
        // 赤外カメラの偽色。地は「冷たい側」＝黒〜暗紫、
        // 差し色は「熱い側」＝橙〜白。既存プリセットに無い暖色の連続スケール
        canvasBg:
            'radial-gradient(ellipse at 50% 120%, rgba(255,90,60,0.16), transparent 55%), linear-gradient(180deg, #0a0610 0%, #140a1c 100%)',
        titleColor: '#ffe9d6',
        subColor: 'rgba(255, 233, 214, 0.58)',
        accent: '#ff9d2e',
        errorColor: '#ff5a3c',
        selection: '#ffd447',
        panel: {
            card: {
                background: 'rgba(30, 16, 38, 0.86)',
                border: '1px solid rgba(255, 157, 46, 0.26)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            },
            glass: {
                background: 'rgba(34, 18, 44, 0.5)',
                border: '1px solid rgba(255, 157, 46, 0.3)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
            },
        },
    },
    eink: {
        ...base,
        name: 'E Ink（電子ペーパー・低コントラスト）',
        // 電子ペーパー：ほぼ無彩色・低コントラスト。
        // 長時間つけっぱなしの壁面表示で目が疲れないことを狙う。
        // ⚠ 彩度を持たせない（色で主張しないのがこのプリセットの存在理由）
        canvasBg: '#d8d8d4',
        titleColor: '#1c1c1c',
        subColor: 'rgba(28, 28, 28, 0.58)',
        accent: '#2b2b2b',
        errorColor: '#6b2020',
        selection: '#4a5a6a',
        // ⚠ 増減の色も無彩色にする（既定の緑／ピンクだとここだけ色が浮く）。
        //   濃淡で「悪い＝濃い」を表し、向きは矢印（▲▼）が担う
        goodColor: 'rgba(28, 28, 28, 0.55)',
        badColor: '#1c1c1c',
        panel: {
            card: {
                background: '#e9e9e5',
                border: '1px solid rgba(28, 28, 28, 0.24)',
                boxShadow: 'none',
            },
            glass: {
                background: 'rgba(233, 233, 229, 0.8)',
                border: '1px solid rgba(28, 28, 28, 0.18)',
                boxShadow: 'none',
            },
        },
    },
    watercolor: {
        ...base,
        name: '水彩（にじみの紙）',
        // コールドプレスの水彩紙。地は生成りで、隅に薄めた顔料のウォッシュを
        // 乾かした跡を置く。**にじみは「縁が中心より濃い」**（乾くとき顔料が
        // 縁に寄る＝エッジの濃まり）。radial-gradient の段差でその縁を作る。
        // ⚠ 全レイヤ静的（animate しない）。合成は一度きり
        // 濃度は控えめ→「もっと露骨に」の指示で一段上げた（2026-08-12）。
        // 4隅に別顔料のウォッシュを置き、縁（78%付近）を中より2倍濃くする
        canvasBg:
            'radial-gradient(ellipse 52% 40% at 8% 4%, rgba(74,144,189,0.10) 0%, rgba(74,144,189,0.10) 58%, rgba(74,144,189,0.22) 76%, transparent 84%),' +
            ' radial-gradient(ellipse 44% 36% at 96% 90%, rgba(196,106,132,0.09) 0%, rgba(196,106,132,0.09) 56%, rgba(196,106,132,0.20) 76%, transparent 84%),' +
            ' radial-gradient(ellipse 30% 24% at 80% 8%, rgba(201,151,63,0.08) 0%, rgba(201,151,63,0.08) 54%, rgba(201,151,63,0.17) 74%, transparent 83%),' +
            ' radial-gradient(ellipse 26% 20% at 30% 96%, rgba(106,160,111,0.07) 0%, rgba(106,160,111,0.07) 52%, rgba(106,160,111,0.15) 74%, transparent 83%),' +
            ' linear-gradient(180deg, #f8f5ee 0%, #f2eee2 100%)',
        titleColor: '#2b3440', // ペインズグレー（水彩の「黒」は青みの灰）
        subColor: 'rgba(43, 52, 64, 0.6)',
        accent: '#3f8fbf', // セルリアンブルー
        errorColor: '#b8434e',
        selection: '#3f8fbf',
        // 手描きの温度は丸ゴシックで出す（無い環境は素直にサンセリフへ落ちる）
        fontFamily:
            "'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'Yu Gothic', 'Meiryo', sans-serif",
        panel: {
            card: {
                // 紙の上の「白を残した一枠」。輪郭線ではなく薄い顔料の縁で示す
                background: 'rgba(255, 255, 253, 0.72)',
                border: '1px solid rgba(63, 143, 191, 0.26)',
                boxShadow: 'inset 0 0 10px rgba(63, 143, 191, 0.08)',
            },
            glass: {
                background: 'rgba(255, 255, 253, 0.55)',
                border: '1px solid rgba(63, 143, 191, 0.2)',
                boxShadow: 'none',
                backdropFilter: 'blur(4px)',
            },
        },
    },
    crayon: {
        ...base,
        name: 'クレヨン（黒画用紙）',
        // 黒画用紙にオイルパステル。手描き系4種で唯一の暗い地。
        // 紙の目（tooth）は 1px の明るい粒＝面積比例の塗りにならない。
        // パステルの「こすった跡」を隅に2枚だけ、ごく薄く置く
        // ⚠ canvasBg は `background:` 一括指定で使われる（DpxDashboard/HomePage）。
        //   紙の目のタイルは「位置 / サイズ」構文（`0 0 / 5px 5px`）で書く
        //   （backgroundSize を別プロパティで足す口が無いため）
        canvasBg:
            'radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px) 0 0 / 5px 5px, ' +
            'radial-gradient(ellipse 40% 30% at 8% 100%, rgba(255,107,74,0.13), transparent 62%),' +
            ' radial-gradient(ellipse 36% 28% at 96% 4%, rgba(77,184,232,0.11), transparent 62%),' +
            ' radial-gradient(ellipse 26% 22% at 55% 100%, rgba(126,217,87,0.08), transparent 60%),' +
            ' linear-gradient(180deg, #262220 0%, #1f1c19 100%)',
        titleColor: '#f3ece1', // チョークの白
        subColor: 'rgba(243, 236, 225, 0.55)',
        accent: '#ffce3d', // クロムイエロー
        errorColor: '#ff5c5c',
        selection: '#ffce3d',
        fontFamily:
            "'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'Yu Gothic', 'Meiryo', sans-serif",
        panel: {
            card: {
                background: 'rgba(40, 36, 31, 0.88)',
                border: '1px solid rgba(243, 236, 225, 0.14)',
                boxShadow: 'none',
            },
            glass: {
                background: 'rgba(46, 41, 35, 0.5)',
                border: '1px solid rgba(255, 206, 61, 0.22)',
                boxShadow: 'none',
                backdropFilter: 'blur(5px)',
            },
        },
    },
    pencil: {
        ...base,
        name: '色鉛筆（スケッチブック）',
        // スケッチブックの紙。細かい紙目（4px 間隔の 1px 粒）だけを敷き、
        // 色は乗せない（色は系列色＝芯の色に任せる。地が主張すると芯が濁る）
        canvasBg:
            'radial-gradient(rgba(70, 75, 85, 0.09) 1px, transparent 1px) 0 0 / 4px 4px, ' +
            'linear-gradient(180deg, #f5f3ee 0%, #efede5 100%)',
        titleColor: '#2e3138', // グラファイト
        subColor: 'rgba(46, 49, 56, 0.58)',
        accent: '#4a78b5', // 青鉛筆（校正の青）
        errorColor: '#c0504d', // 赤鉛筆
        selection: '#4a78b5',
        fontFamily:
            "'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'Yu Gothic', 'Meiryo', sans-serif",
        panel: {
            card: {
                // 鉛筆の枠線は「二度引き」＝本線＋わずかにずれた薄い線
                background: 'rgba(255, 255, 255, 0.75)',
                border: '1px solid rgba(46, 49, 56, 0.42)',
                boxShadow: '1.5px 1.5px 0 0 rgba(46, 49, 56, 0.14)',
            },
            glass: {
                background: 'rgba(255, 255, 255, 0.58)',
                border: '1px solid rgba(46, 49, 56, 0.3)',
                boxShadow: 'none',
                backdropFilter: 'blur(4px)',
            },
        },
    },
    inkwash: {
        ...base,
        name: 'インク＋水彩（ペン画）',
        // アーバンスケッチ（ペン＋淡彩）。地は旅帳の生成り。
        // 群青のウォッシュを上辺に一刷け、隅は紙の日焼けでわずかに沈める
        canvasBg:
            'radial-gradient(ellipse 60% 30% at 70% 0%, rgba(74,128,173,0.15), transparent 62%),' +
            ' radial-gradient(ellipse 34% 24% at 6% 92%, rgba(191,106,85,0.10), transparent 62%),' +
            ' radial-gradient(ellipse 120% 90% at 50% 50%, transparent 60%, rgba(110,90,60,0.10) 100%),' +
            ' linear-gradient(180deg, #f6f1e4 0%, #f1ebdc 100%)',
        titleColor: '#262119', // セピアの製図インク
        subColor: 'rgba(38, 33, 25, 0.6)',
        accent: '#3b78a8', // ウルトラマリンのウォッシュ
        errorColor: '#a8433a',
        selection: '#3b78a8',
        panel: {
            card: {
                // インクの輪郭線＋右下に「ペンの溜まり」を落とす
                background: 'rgba(252, 249, 241, 0.8)',
                border: '1px solid rgba(38, 33, 25, 0.55)',
                boxShadow: '2px 2px 0 -0.5px rgba(38, 33, 25, 0.18)',
            },
            glass: {
                background: 'rgba(252, 249, 241, 0.6)',
                border: '1px solid rgba(38, 33, 25, 0.35)',
                boxShadow: 'none',
                backdropFilter: 'blur(4px)',
            },
        },
    },
    liquidGlass: {
        ...base,
        name: 'Liquid Glass（iOS 26）',
        // WWDC25 のキービジュアルの舞台＝銀のグラデーションに細いグリッド。
        // ガラスは「背景を屈折させて見せる」材質なので、地には
        // (1) 淡い色の溜まり（屈折で見えるもの）と (2) グリッド（歪みの基準線）を敷く。
        // ⚠ 全レイヤ静的。**この上のガラス質感は backdrop-filter を使う**ので、
        //   動く背景（particles 等）と組み合わせると毎フレーム再ブラーになる。
        //   プリセットの地は静的にして、その組み合わせを既定にしない
        canvasBg:
            'linear-gradient(rgba(110,120,140,0.15) 1px, transparent 1px) 0 0 / 120px 120px, ' +
            'linear-gradient(90deg, rgba(110,120,140,0.15) 1px, transparent 1px) 0 0 / 120px 120px, ' +
            'radial-gradient(ellipse 55% 45% at 18% 8%, rgba(0,122,255,0.18), transparent 62%),' +
            ' radial-gradient(ellipse 45% 40% at 90% 92%, rgba(255,149,0,0.14), transparent 62%),' +
            ' radial-gradient(ellipse 40% 35% at 8% 96%, rgba(175,82,222,0.12), transparent 60%),' +
            ' linear-gradient(160deg, #eceef2 0%, #dde0e6 55%, #cfd3da 100%)',
        titleColor: '#1c1f26',
        subColor: 'rgba(28, 31, 38, 0.55)',
        accent: '#007aff', // iOS システムブルー
        errorColor: '#ff3b30',
        selection: '#007aff',
        // SF Pro 系。無い環境は各 OS のシステムフォントへ
        fontFamily:
            "-apple-system, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', 'Hiragino Sans', sans-serif",
        panel: {
            card: {
                background: 'rgba(255, 255, 255, 0.55)',
                border: '1px solid rgba(255, 255, 255, 0.75)',
                boxShadow: '0 8px 24px rgba(24, 32, 48, 0.14)',
            },
            glass: {
                background: 'rgba(255, 255, 255, 0.32)',
                border: '1px solid rgba(255, 255, 255, 0.65)',
                boxShadow: '0 8px 24px rgba(24, 32, 48, 0.16)',
                backdropFilter: 'blur(10px) saturate(150%)',
            },
        },
    },
    light: {
        ...base,
        name: 'ライト',
        canvasBg: '#f4f6fa',
        titleColor: '#1a2333',
        subColor: 'rgba(26, 35, 51, 0.55)',
        accent: '#1e93c6',
        errorColor: '#d41f1f',
        selection: '#1e93c6',
        panel: {
            card: {
                background: '#ffffff',
                border: '1px solid rgba(0,0,0,0.08)',
                boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
            },
            glass: {
                background: 'rgba(255,255,255,0.65)',
                border: '1px solid rgba(0,0,0,0.1)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                backdropFilter: 'blur(6px)',
            },
        },
    },
};

/** definition から解決済みテーマを得る（style.preset > 旧 theme キーの順で解釈）。 */
export function resolveTheme(definition) {
    const presetName =
        definition?.style?.preset ?? (definition?.theme === 'light' ? 'light' : 'midnight');
    const preset = DPX_PRESETS[presetName] ?? DPX_PRESETS.midnight;
    const accent = definition?.style?.accent || preset.accent;
    return {
        ...preset,
        accent,
        presetName,
        palette: PALETTES[presetName] ?? PALETTES.midnight,
        colorScheme: LIGHT_PRESETS.has(presetName) ? 'light' : 'dark',
        // ⚠ **本文の文字色。プリセット側には定義が無い（`titleColor` と同義）。**
        //   UI 側（VizPicker / EditToolbar / PanelContextMenu / DateInput /
        //   optionEditors）は以前から `t.textColor` を読んでいたが、
        //   どのプリセットもこのキーを持っていなかったため **常に undefined** で、
        //   `color: undefined` ＝ 親からの継承になっていた。
        //   暗いテーマでは親が明るい文字色なので偶然読めていたが、
        //   **ライト系テーマでは白のまま継承されて文字が消えた**（実機で発生）。
        //   ここで一度だけ定義して、全参照箇所をまとめて正す。
        textColor: preset.titleColor,
        // ⚠ 同じく「読まれているのに定義が無かった」キー（定義ソース欄が使う）。
        //   undefined だと地が透明・仕切り線が消える。カード質感から導く
        //   （手で色を書くと質感を直したとき片方だけ古くなる）
        panelBg: preset.panel.card.background,
        panelBorder: preset.panel.card.border,
        // パネルの角の丸み（px）。**既定は 2**＝ほぼ角のある硬い印象。
        // 丸すぎると「アプリの UI」に見えてしまい、管制画面の硬質さが出ない。
        // ダッシュボード単位で `style.radius`、パネル単位で `panel.style.radius` で上書き。
        radius: Number.isFinite(Number(definition?.style?.radius))
            ? Number(definition.style.radius)
            : 2,
        // NOC 質感のカギ括弧の色。アクセントをそのまま使うと主張が強いので
        // 既定は控えめな中性色にし、`style.bracketColor` で上書きできる
        bracketColor:
            definition?.style?.bracketColor ||
            (LIGHT_PRESETS.has(presetName) ? 'rgba(60, 90, 140, 0.55)' : 'rgba(160, 195, 245, 0.62)'),
    };
}

// ネイティブ viz が解決済みテーマを読むためのコンテキスト
// （DpxDashboard が Provider を張る。未提供時は midnight 相当）
export const DpxThemeContext = createContext(null);
export function useDpxTheme() {
    return (
        useContext(DpxThemeContext) ?? {
            ...DPX_PRESETS.midnight,
            accent: DPX_PRESETS.midnight.accent,
            palette: PALETTES.midnight,
            presetName: 'midnight',
            colorScheme: 'dark',
            // resolveTheme と同じ派生キーをここにも持たせる
            // （フォールバック側だけ欠けると同じ不具合が再発する）
            textColor: DPX_PRESETS.midnight.titleColor,
        }
    );
}

/** パネルの見た目（variant 別スタイル）。frameless は装飾なし。 */
/**
 * 「コーナーフレーム」＝四隅のカギ括弧だけの枠を作る。
 *
 * ⚠ スキーマ上のキーは `noc` のまま（表示名だけ変更）。
 *   キーを変えると既存ダッシュボードの `style.variant` が解決できなくなる。
 *
 * 全周の枠線を引かず、**角だけ L 字**にする。管制室のモニタ壁の意匠で、
 * 枠が主張しないぶん中身（数値やグラフ）が前に出る。
 *
 * 実装は `linear-gradient` を8枚重ねる方式にしてある。理由:
 *   - 疑似要素（::before/::after）は2つしか使えず、4隅×2辺には足りない
 *   - 余計な DOM を増やすと viz 側のレイアウト計算に影響する
 *   - **面積に比例する塗りではない**ので raster コストが小さい
 *     （viz-performance.md の方針。半透明の大面積塗りは避ける）
 *
 * @param color 線の色
 * @param len   カギ括弧の腕の長さ(px)
 * @param w     線の太さ(px)
 */
export function cornerBrackets(color, len = 14, w = 1) {
    const line = `linear-gradient(${color}, ${color})`;
    return {
        backgroundImage: Array(8).fill(line).join(', '),
        backgroundRepeat: 'no-repeat',
        // 左上（横・縦）/ 右上 / 左下 / 右下 の順
        backgroundSize: [
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
        ].join(', '),
        backgroundPosition: [
            'left top', 'left top',
            'right top', 'right top',
            'left bottom', 'left bottom',
            'right bottom', 'right bottom',
        ].join(', '),
    };
}

/**
 * カギ括弧の腕の長さを決める。
 *
 * ⚠ **背の低いパネルでは腕を詰める。** 既定の 11px のままだと、
 *   高さ 1 行（約 74px）のパネルで上下の括弧が近づきすぎ、
 *   **タイトルの上下に括弧が二重にあるように見える**（実機で発生）。
 *   パネル高の 1/6 を上限にして、腕どうしが視覚的に繋がらないようにする。
 */
export function bracketArmLength(panelHeightPx, base = 11) {
    if (!Number.isFinite(panelHeightPx) || panelHeightPx <= 0) return base;
    return Math.max(6, Math.min(base, Math.floor(panelHeightPx / 6)));
}

/**
 * 内側に罫を持つ質感（letterpress）で、中身を罫より内側に寄せるための余白。
 *
 * ⚠ **罫の位置（inset 5px）より大きい値**にすること。inset box-shadow は
 *   レイアウト上の場所を取らないので、この padding だけが
 *   「中身が罫を踏まない」ことを保証している。
 */
const PANEL_INNER_PAD = 6;

/**
 * パネル質感の一覧（表示名つき）。**インスペクタのドロップダウンはこれを使う。**
 *
 * ⚠ **UI 側にベタ書きしない。** 以前はインスペクタに直接並べていたため、
 *   質感を足すたびに「描画は対応したのに選べない」というズレが起きうる状態だった。
 *   `panelSurface()` の実装と**同じファイルに置いて**、増減を1か所で済ませる。
 *   区画（グループ）の質感選択も同じ一覧を使う（§groupSurface）。
 */
/**
 * **区画（グループ）で使えない質感**（2026-08-12 実機で確認）。
 *
 * CSS は流用できるが、**この2つは「中身がある箱」を前提にした造り**なので、
 * 中身を持たない区画（パネルの背面に敷く空の箱）では意図した絵にならない:
 *
 * | 質感 | 区画で何が起きるか |
 * |---|---|
 * | `polaroid` | 白縁は **`padding` で中身を押し込んで**作る。中身が無い区画では縁が成立せず、**印画面がベタ塗りの明るい面**になってパネルを覆う |
 * | `punchCard` | `clip-path` で輪郭を欠けさせる質感。区画では**濃い地がパネルの背面全体を覆い**、切り欠きだけが上辺に残って意図が伝わらない |
 *
 * ⚠ **「CSS が同じ＝流用できる」ではない。** `groupSurface` は
 *   `panelSurface` と**バイト単位で同じ値**を返すのに、実機では破綻していた
 *   （JSON 比較のテストだけでは検出できず、スクリーンショットで気づいた）。
 *   質感を足すときは「中身の有無に依存していないか」を必ず見る。
 */
export const GROUP_INCOMPATIBLE_VARIANTS = new Set(['polaroid', 'punchCard']);

/** 区画の質感として選べるもの（構造依存の2種を除いた一覧）。 */
export function groupVariants() {
    return PANEL_VARIANTS.filter((v) => !GROUP_INCOMPATIBLE_VARIANTS.has(v.value));
}

export const PANEL_VARIANTS = [
    { value: 'noc', label: 'コーナーフレーム（四隅のカギ括弧）' },
    { value: 'bracketSolid', label: 'コーナーフレーム＋不透明' },
    { value: 'card', label: 'カード（枠あり）' },
    { value: 'glass', label: 'すりガラス' },
    { value: 'solid', label: '不透明' },
    { value: 'outline', label: '枠線のみ' },
    { value: 'underline', label: '上線' },
    { value: 'sideAccent', label: '左線' },
    { value: 'inset', label: '沈み込み' },
    { value: 'elevated', label: '浮き上がり' },
    { value: 'holo', label: 'ホログラム（斜め縞）' },
    { value: 'neonEdge', label: 'ネオン管（枠が光る）' },
    { value: 'blueprint', label: '方眼紙（設計図）' },
    { value: 'ticket', label: '伝票（上辺ミシン目）' },
    { value: 'letterpress', label: '活版（細罫）' },
    { value: 'watercolor', label: '水彩（にじみの縁）' },
    { value: 'crayon', label: 'クレヨン（蝋の縁取り）' },
    { value: 'pencil', label: '色鉛筆（ハッチング）' },
    { value: 'inkwash', label: 'インク＋水彩（ペン画）' },
    { value: 'liquidGlass', label: 'Liquid Glass（iOS 26 のガラス）' },
    { value: 'polaroid', label: '印画紙（下に広い余白）' },
    { value: 'punchCard', label: 'パンチカード（上辺に切り欠き）' },
    { value: 'titleBlock', label: '表題欄（図面の枠）' },
    { value: 'eink', label: '電子ペーパー（平坦）' },
    { value: 'frameless', label: '枠なし（透過）' },
];

export function panelSurface(theme, variant, bracketLen = 11) {
    if (variant === 'frameless') {
        return { background: 'transparent', border: 'none', boxShadow: 'none' };
    }
    if (variant === 'noc') {
        // NOC WALL：四隅のカギ括弧だけ。全周の枠線もタイトル下の区切り線も引かない。
        // 背景はごく薄く沈ませて、パネルの矩形だけそれとなく分かるようにする。
        return {
            // ⚠ `background`（一括）にすると、下の cornerBrackets が返す
            //   `backgroundImage` に**色のレイヤーごと上書きされて地が消える**。
            //   ライトテーマでパネルが暗いまま見える原因になっていた（実機で確認）。
            //   色は必ず `backgroundColor` で指定する。
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(10, 18, 34, 0.42)',
            border: 'none',
            boxShadow: 'none',
            // ⚠ 腕は「短く・はっきり」。長いと枠線に見えてしまい、
            //    薄いと壁面ディスプレイでは消える（実機で調整）
            ...cornerBrackets(theme.bracketColor ?? `${theme.accent}66`, bracketLen, 1),
        };
    }
    if (variant === 'glass') {
        return { ...theme.panel.glass };
    }
    if (variant === 'outline') {
        // 塗りを持たない枠だけの質感。図形の上に重ねても下が透ける
        return {
            background: 'transparent',
            border: `1px solid ${theme.accent}66`,
            boxShadow: 'none',
        };
    }
    if (variant === 'bracketSolid') {
        // NOC の括弧＋不透明な地。背景エフェクトが強いときでも中身が読める
        return {
            // ⚠ cornerBrackets の backgroundImage に潰されるので backgroundColor で
            backgroundColor: theme.colorScheme === 'light' ? '#ffffff' : '#0c1424',
            border: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
            ...cornerBrackets(theme.bracketColor ?? `${theme.accent}66`, bracketLen, 1),
        };
    }
    if (variant === 'underline') {
        // 上辺だけアクセント線。表形式を並べるときに軽くまとまる
        return {
            background: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(14, 22, 40, 0.55)',
            border: 'none',
            borderTop: `2px solid ${theme.accent}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'sideAccent') {
        // 左辺だけアクセント線。ステータス一覧のような縦積みに合う
        return {
            background: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(14, 22, 40, 0.55)',
            border: 'none',
            borderLeft: `3px solid ${theme.accent}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'inset') {
        // 沈み込み（内側の影）。押し込まれた計器盤のような質感
        return {
            background: theme.colorScheme === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(0, 0, 0, 0.3)',
            border: 'none',
            boxShadow:
                theme.colorScheme === 'light'
                    ? 'inset 0 2px 8px rgba(0,0,0,0.10)'
                    : 'inset 0 2px 10px rgba(0,0,0,0.55)',
        };
    }
    if (variant === 'elevated') {
        // 浮き上がり（強い影）。重要なパネルを1枚だけ持ち上げるとき
        return {
            background: theme.colorScheme === 'light' ? '#ffffff' : 'rgba(24, 34, 56, 0.95)',
            border: theme.panel.card.border,
            boxShadow: '0 14px 40px rgba(0,0,0,0.45)',
        };
    }
    if (variant === 'holo') {
        // ホログラム：斜めの薄い縞＋外周のリムライト。
        // ⚠ blur は使わない（backdrop-filter は文字のサブピクセルAAを殺し、
        //    面積に比例して重い。§viz-performance）。縞は repeating-linear-gradient
        //    の1枚だけなので raster が軽い
        const base = theme.colorScheme === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(14, 24, 44, 0.72)';
        return {
            backgroundColor: base,
            backgroundImage: `repeating-linear-gradient(115deg, ${theme.accent}0f 0px, ${theme.accent}0f 1px, transparent 1px, transparent 7px)`,
            border: `1px solid ${theme.accent}3d`,
            boxShadow: `inset 0 1px 0 ${theme.accent}33, 0 4px 18px rgba(0,0,0,0.32)`,
        };
    }
    if (variant === 'neonEdge') {
        // ネオン管：枠だけを強く光らせる。中身は暗いままにして数値を立てる
        return {
            backgroundColor: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(8, 14, 28, 0.86)',
            border: `1px solid ${theme.accent}`,
            // ⚠ box-shadow は「静的」なら安い。アニメさせると毎フレーム再描画になる
            boxShadow: `0 0 0 1px ${theme.accent}33, 0 0 14px ${theme.accent}55, inset 0 0 12px ${theme.accent}1f`,
        };
    }
    if (variant === 'blueprint') {
        // 方眼紙：設計図の意匠。細い格子を2枚重ねる（16px と 80px）
        const line = theme.colorScheme === 'light' ? 'rgba(60,110,180,0.16)' : 'rgba(120,170,255,0.10)';
        const bold = theme.colorScheme === 'light' ? 'rgba(60,110,180,0.28)' : 'rgba(120,170,255,0.18)';
        return {
            backgroundColor: theme.colorScheme === 'light' ? 'rgba(238,244,252,0.9)' : 'rgba(9, 18, 34, 0.9)',
            backgroundImage:
                `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px),` +
                `linear-gradient(${bold} 1px, transparent 1px), linear-gradient(90deg, ${bold} 1px, transparent 1px)`,
            backgroundSize: '16px 16px, 16px 16px, 80px 80px, 80px 80px',
            border: `1px solid ${theme.accent}33`,
            boxShadow: 'none',
        };
    }
    if (variant === 'letterpress') {
        // 活版：**細いヘアラインの枠1本だけ**。
        //
        // ⚠ **二重罫にしない。** 以前は外罫＋内罫（4px 間隔）だったが、
        //   離れた2本の線は少し引くと**1本の太い帯**に見え、
        //   「線が太い」という印象になる（実機で確認して1本へ変更）。
        //   紙らしさは「線の細さ」と「地の色」で出し、線の本数では出さない。
        // ⚠ 影を付けない（活版は平ら）。animate もしない。
        const rgb = theme.colorScheme === 'light' ? '26, 31, 43' : '226, 221, 208';
        const ink = (a) => `rgba(${rgb}, ${a})`;
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(250, 248, 242, 0.92)' : 'rgba(20, 24, 34, 0.92)',
            // ヘアライン1本。濃さも落として、罫が主張しないようにする
            border: `1px solid ${ink(0.28)}`,
            boxShadow: 'none',
            // 中身を縁から少し離す（罫に文字やスクロールバーが貼り付かないように）
            padding: PANEL_INNER_PAD,
        };
    }
    if (variant === 'watercolor') {
        // 水彩のウォッシュ：輪郭線を引かず、**乾いた縁に顔料が寄る**現象
        // （エッジの濃まり）を inset shadow の2枚重ねで作る。
        // 中心はほぼ紙のまま、縁に向かってアクセントの顔料が濃くなる。
        // ⚠ backgroundImage を使うので色は backgroundColor で指定する（§background 一括の罠）
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 253, 0.66)' : 'rgba(22, 30, 44, 0.6)',
            // 塗りムラ：一隅からの薄いウォッシュを1枚だけ（静的・面積の小さい塗り）
            backgroundImage: `radial-gradient(ellipse 120% 90% at 28% 18%, ${theme.accent}1f, transparent 70%)`,
            border: 'none',
            // 実機で「ほぼ普通のカード」に見えたため2回濃くした
            // （「もっと露骨に」のユーザー指示。24/2e → 2b/38 → 45/52）
            boxShadow: `inset 0 0 22px ${theme.accent}45, inset 0 0 5px ${theme.accent}52`,
            // 水の縁は角張らない。質感側で丸みを持つ（個別指定があれば後勝ちで上書きされる）
            borderRadius: 9,
        };
    }
    if (variant === 'crayon') {
        // クレヨンの縁取り：太く・少し透ける蝋の線。
        // 蝋は完全に紙を覆わないので不透明にしない（b8=72%）。
        // 内側にもう一周「こすった跡」を薄く回すと、単なる太枠に見えなくなる。
        // 角は丸く（クレヨンで直角は引けない＝角丸はこの質感の意匠の一部）
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 255, 0.6)' : 'rgba(30, 27, 23, 0.72)',
            border: `4px solid ${theme.accent}cc`,
            // 蝋の二度塗り：内側にもう一周＋**外側にずらしたもう一筆**
            // （クレヨンは同じ線を2回なぞる。ずれが「手」の証拠になる）
            boxShadow: `inset 0 0 0 3px ${theme.accent}33, 3px 3px 0 0 ${theme.accent}59`,
            borderRadius: 12,
        };
    }
    if (variant === 'pencil') {
        // 色鉛筆：**二度引きの輪郭線**（本線＋わずかにずれた薄い線）と、
        // アクセント色の斜めハッチング。手の角度（115deg）で、
        // holo（7px 間隔）より細かい 4px 間隔にして「塗り」に見せる
        const graphite =
            theme.colorScheme === 'light' ? 'rgba(52, 56, 64, 0.62)' : 'rgba(220, 224, 232, 0.5)';
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 255, 0.62)' : 'rgba(18, 24, 36, 0.6)',
            // クロスハッチ：主方向（手の角度 115deg・濃く密）＋交差方向（25deg・薄く粗く）。
            // 1方向だけだと「薄い縞」にしか見えなかったので交差させて「塗り」にする
            backgroundImage:
                `repeating-linear-gradient(115deg, ${theme.accent}24 0px, ${theme.accent}24 1px, transparent 1px, transparent 4px),` +
                ` repeating-linear-gradient(25deg, ${theme.accent}0f 0px, ${theme.accent}0f 1px, transparent 1px, transparent 7px)`,
            border: `1px solid ${graphite}`,
            boxShadow: `2.5px 2.5px 0 0 ${
                theme.colorScheme === 'light' ? 'rgba(52, 56, 64, 0.28)' : 'rgba(220, 224, 232, 0.2)'
            }`,
        };
    }
    if (variant === 'inkwash') {
        // ペン画（インク＋淡彩）：くっきりしたインクの輪郭線と、
        // **線と重ならない位置に置いたウォッシュ**（淡彩は線からはみ出すのが流儀）。
        // 右下の box-shadow はペンの「入りと抜き」で線が太る癖の表現
        const ink =
            theme.colorScheme === 'light' ? 'rgba(38, 33, 25, 0.72)' : 'rgba(235, 228, 214, 0.6)';
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(253, 250, 243, 0.7)' : 'rgba(24, 28, 38, 0.7)',
            backgroundImage: `radial-gradient(ellipse 90% 70% at 16% 0%, ${theme.accent}38, transparent 64%)`,
            border: `2px solid ${ink}`,
            boxShadow: `3px 3px 0 -1px ${
                theme.colorScheme === 'light' ? 'rgba(38, 33, 25, 0.3)' : 'rgba(0, 0, 0, 0.5)'
            }`,
        };
    }
    if (variant === 'liquidGlass') {
        // Liquid Glass（iOS 26 / WWDC25）：**ほぼ透明な「厚いガラスのレンズ」**。
        // 既存の glass（すりガラス）との違いは、曇らせて隠すのではなく
        // **縁で光が屈折している**ように見せること。要素は4つ:
        //   (1) 上辺のスペキュラハイライト（inset 0 1px）＝光源の写り込み
        //   (2) 全周のヘアラインの明縁＋内側への光の回り込み（厚みの表現）
        //   (3) 下辺の分光（薄い虹の帯）＝WWDC25 キービジュアルの縁の虹
        //   (4) 浮遊感のある柔らかい落ち影
        // ⚠ backdrop-filter を使う（この質感の本質なので例外的に許容。
        //   ただし**動く背景と組み合わせると毎フレーム再ブラー**になるので、
        //   静的背景（グラデ／パターン系）との組み合わせを推奨）
        const isLight = theme.colorScheme === 'light';
        return {
            // 白濁させない：塗りは最小限にして「透けている」ことを最優先する
            // （初版 0.22 では白いカードに見えた。実機スクショで確認して下げた）
            backgroundColor: isLight ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.06)',
            // 4レイヤ：**湾曲したシートグレア**（上半分に大きく回り込む照り。
            // 平面のグラデでは「板」に、楕円の照りは「湾曲したガラス」に見える）／
            // 斜めの窓映り込み（反射ストリーク）／面の照度差／下辺の分光
            // ⚠ **ダークテーマでは光り物を大幅に絞る**（2026-08-12 ユーザー指摘「やりすぎ」）。
            //   暗い地では白いグレアが「油膜の汚れ」に見える。ダーク側は
            //   屈折（フィルタ）とヘアラインに語らせ、面の照りはほぼ消す
            // ⚠ **ダークは照りのレイヤを持たない**（分光ラインのみ）。
            //   微弱（2〜7%）でも紺地では「霧状の滲み」に見える（2026-08-12「まだ滲んでる」）。
            //   ダークのガラスらしさは縁の屈折・ヘアライン・スペキュラだけで出す
            backgroundImage: isLight
                ? `radial-gradient(ellipse 130% 70% at 50% -25%, rgba(255,255,255,0.36) 38%, rgba(255,255,255,0.09) 55%, transparent 68%), ` +
                  `linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.4) 36%, rgba(255,255,255,0.12) 46%, transparent 55%), ` +
                  `linear-gradient(165deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.02) 42%, rgba(255,255,255,0.1) 100%), ` +
                  'linear-gradient(90deg, transparent 16%, rgba(255,80,80,0.38) 36%, rgba(90,235,130,0.38) 52%, rgba(120,110,255,0.38) 68%, transparent 86%)'
                : 'linear-gradient(90deg, transparent 16%, rgba(255,80,80,0.22) 36%, rgba(90,235,130,0.22) 52%, rgba(120,110,255,0.22) 68%, transparent 86%)',
            backgroundRepeat: 'no-repeat',
            backgroundSize: isLight ? '100% 100%, 100% 100%, 100% 100%, 100% 2px' : '100% 2px',
            backgroundPosition: isLight ? '0 0, 0 0, 0 0, 0 100%' : '0 100%',
            border: 'none',
            boxShadow: [
                // (1) 上辺のスペキュラ
                `inset 0 1.5px 1px rgba(255,255,255,${isLight ? 0.95 : 0.4})`,
                // (2) ヘアラインの明縁＋光の回り込み（厚いガラスの縁）。
                //     ⚠ ダークの回り込みは半径・濃度とも最小に（広いと縁の霧になる）
                `inset 0 0 0 1px rgba(255,255,255,${isLight ? 0.7 : 0.24})`,
                `inset 0 0 ${isLight ? 24 : 8}px rgba(255,255,255,${isLight ? 0.42 : 0.06})`,
                // (3) 下縁の沈み＝ガラスの厚みが落とす内側の影
                `inset 0 -1.5px 2px rgba(30, 40, 60, ${isLight ? 0.22 : 0.4})`,
                // (4) 浮遊感（ガラスは面から浮いている）
                isLight ? '0 10px 30px rgba(24, 32, 48, 0.2)' : '0 10px 30px rgba(0, 0, 0, 0.5)',
            ].join(', '),
            // ⭐ レンズの屈折（本質）。SVG の変位マップで backdrop を縁だけ歪ませる。
            //   フィルタ定義は LiquidGlassDefs（DpxDashboard が常設。同一 DOM だから届く）。
            // ⚠ ダークは blur も saturate も掛けない（url のみ）。
            //   ソフトなグローの背景に 2px のブラーが乗るだけで全面の滲みに見える
            backdropFilter: isLight
                ? 'url(#dpx-liquid-lens) blur(2px) saturate(150%)'
                : 'url(#dpx-liquid-lens)',
            // カプセルに近い大きな丸み＝この材質の造形言語。
            // ダッシュボード側の radius 既定（2px）に任せると板ガラスに見えない
            borderRadius: 24,
        };
    }
    if (variant === 'polaroid') {
        // インスタント写真：**下辺だけ極端に広い白縁**。左右と上は細い。
        //
        // ⚠ この質感の肝は「四辺が非対称であること」。既存の質感はすべて
        //   四辺対称なので、対称にした瞬間ただの白いカードになる。
        // ⚠ 余白は `padding` で作る（border だと色が付いてしまい、
        //   「印画紙の白い縁」ではなく「太い枠線」に見える）。
        //   padding なら中身が押し込まれるだけで、地の色がそのまま縁になる。
        // ⚠ **白い縁だけでは「ただの白いカード」にしか見えない**（実機で確認）。
        //   印画紙に見せるには「**印画された面**」が縁と別の色で見えている必要がある。
        //
        // ⚠ 印画面は `background-image` ＋ **`background-clip: content-box`** で作る。
        //   `inset box-shadow` は padding box 全体を塗ってしまい**白縁ごと潰れる**ので使えない
        //   （content-box に限定する手段が box-shadow には無い）。
        //   backgroundColor（＝白紙）は padding box 全体に残るので、
        //   「白い縁の内側に印画面がある」状態が1要素で作れる。
        const paper = theme.colorScheme === 'light' ? '#fbfaf7' : '#ece9e3';
        const photo = theme.colorScheme === 'light' ? 'rgba(24,28,38,0.06)' : 'rgba(24,28,38,0.11)';
        return {
            backgroundColor: paper,
            backgroundImage: `linear-gradient(${photo}, ${photo})`,
            backgroundClip: 'content-box',
            backgroundOrigin: 'content-box',
            backgroundRepeat: 'no-repeat',
            border: 'none',
            // 印画紙は実体のある「もの」なので、ここだけは影を持たせる
            boxShadow:
                theme.colorScheme === 'light'
                    ? '0 2px 8px rgba(16,24,40,0.18)'
                    : '0 3px 12px rgba(0,0,0,0.5)',
            // 上・左右は細く、下だけ広い（写真の下に書き込む余白）
            padding: '11px 11px 32px',
            // ⚠ 印画紙の縁は角が立っている。丸めない
            borderRadius: 0,
        };
    }
    if (variant === 'punchCard') {
        // パンチカード：**上辺に等間隔の矩形ノッチ＋左上の角落とし**。
        //
        // ⚠ 輪郭そのものを欠けさせるので `clip-path` を使う。
        //   border では表現できない（border は矩形の外周にしか引けない）。
        // ⚠ clip-path は**枠線も一緒に切る**ので、border は使わず
        //   地の色だけで面を作る（切った断面に線は残らない）。
        // ⚠ 角丸と併用しない（clip-path が優先され、丸みは見えなくなる）。
        const card = theme.colorScheme === 'light' ? '#efe7d2' : 'rgba(46, 40, 28, 0.94)';
        // 上辺のノッチ：8等分の位置に凹みを作る。polygon の頂点を並べる
        const notches = [];
        const N = 8;
        for (let i = 0; i < N; i++) {
            const a = (i + 0.28) * (100 / N);
            const b = (i + 0.72) * (100 / N);
            notches.push(`${a.toFixed(2)}% 0`, `${a.toFixed(2)}% 7px`, `${b.toFixed(2)}% 7px`, `${b.toFixed(2)}% 0`);
        }
        return {
            backgroundColor: card,
            border: 'none',
            boxShadow: 'none',
            // 左上を斜めに落とす（カードの向きを示す実際の意匠）＋上辺のノッチ
            clipPath: `polygon(0 14px, 14px 0, ${notches.join(', ')}, 100% 0, 100% 100%, 0 100%)`,
            // ノッチのぶん中身を下げ、左上の角落としに文字がかからないようにする
            padding: '10px 8px 6px',
            borderRadius: 0,
        };
    }
    if (variant === 'titleBlock') {
        // 図面のタイトルブロック：右下だけ角を落とした枠。
        // 製図では表題欄が角にあるので、その意匠を borderImage ではなく
        // 単純な枠＋角のノッチで表す（DOM を増やさない）。
        // ⚠ 塗りは薄く。青焼きの地の上に「もう1枚の紙」として乗る想定
        const line = theme.colorScheme === 'light' ? 'rgba(20,40,70,0.4)' : `${theme.accent}55`;
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(16, 46, 84, 0.62)',
            border: `1px solid ${line}`,
            // 右下に「表題欄」を思わせる二重線を1本だけ入れる
            boxShadow: `inset -1px -1px 0 0 ${line}, inset -4px -4px 0 -3px ${line}`,
        };
    }
    if (variant === 'eink') {
        // 電子ペーパー：影も光沢も持たない完全に平らな面。
        // ⚠ **影を付けない**。E Ink は反射型ディスプレイで、
        //   浮き上がりや発光は原理的に存在しない。付けると嘘になる
        return {
            backgroundColor: theme.colorScheme === 'light' ? '#e9e9e5' : 'rgba(24,24,24,0.9)',
            border: `1px solid ${theme.colorScheme === 'light' ? 'rgba(28,28,28,0.28)' : 'rgba(220,220,214,0.24)'}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'ticket') {
        // 伝票：上辺だけミシン目風の点線。一覧を「札」に見せたいとき
        return {
            backgroundColor: theme.colorScheme === 'light' ? '#ffffff' : 'rgba(18, 26, 44, 0.94)',
            borderTop: `2px dashed ${theme.accent}66`,
            borderRight: 'none',
            borderBottom: 'none',
            borderLeft: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
        };
    }
    if (variant === 'solid') {
        // 完全不透明。背景エフェクトの上でも中身のコントラストを保ちたいとき用
        return {
            background: theme.colorScheme === 'light' ? '#ffffff' : '#0c1424',
            border: theme.panelBorder,
            boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        };
    }
    return { ...theme.panel.card };
}

/**
 * パネル個別の色欄が「未指定のとき実際に効いている色」を返す。
 *
 * インスペクタの色欄に**実効値を表示する**ために使う。
 * ⚠ ここは**描画と同じ関数（`panelSurface`）から導く**こと。
 *   同じ値を手で書き写すと、質感（variant）を足したときに片方だけ古くなり、
 *   UI が実物と食い違う（＝この関数を作った動機そのもの）。
 *
 * @param key   'bg' | 'borderColor' | 'accent'
 * @param theme resolveTheme() の戻り値
 * @param variant パネルの質感（`panel.style.variant ?? defaultVariantFor(viz)`）
 * @returns CSS 色文字列。決められない場合は null
 */
export function effectivePanelColor(key, theme, variant) {
    if (key === 'accent') return theme?.accent ?? null;

    const surface = panelSurface(theme, variant);
    if (key === 'bg') {
        // panelSurface は variant により backgroundColor / background のどちらでも返す
        return surface.backgroundColor ?? surface.background ?? null;
    }
    if (key === 'borderColor') {
        // `border` は "1px solid <色>" の形。色の部分だけ取り出す。
        // 'none' の質感（noc など）は**枠線が無いのが実効値**なので none を返す
        const b = surface.border ?? surface.borderTop ?? surface.borderLeft;
        if (!b || b === 'none') return 'none';
        const m = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/.exec(String(b));
        return m ? m[1] : null;
    }
    return null;
}

/**
 * タイトルバーの質感（`panel.style.titleSkin`）。
 *
 * これまでタイトルは「左上・小さめ・大文字」で固定だった。パネルの質感は
 * 14 種選べるのにタイトルだけ動かせないのは不釣り合いなので、位置とあわせて
 * 選べるようにした。
 *
 * 返すのは 3 つ:
 *   box  … タイトルバー（外側の div）に足す CSS
 *   text … 文字そのものの CSS
 *   dot  … 先頭のアクセント丸を出すか
 *
 * ⚠ **`background`（一括指定）を使わないこと。** 一括プロパティは
 *   `background-image` を `none` にリセットするので、コーナーフレームの
 *   カギ括弧（linear-gradient 8枚）が消える。ここはパネル本体ではないが、
 *   同じ事故を繰り返さないよう `backgroundColor` / `backgroundImage` を使い分ける。
 *   （経緯は dpx-platform.md §8.jj）
 */
/**
 * 区画（グループ）の見出しの字面。**パネルのタイトル質感から導く**。
 *
 * ⚠ **独自にベタ書きしない**（2026-08-12・ユーザー指摘で修正）。
 *   以前は `fontSize: 10` / 字間 0.22em / 大文字を**区画だけ決め打ち**していたため、
 *   パネルのタイトル質感（`panelTitleSkin` の10種）を変えても区画名だけが
 *   取り残され、**「文字が小さい」「質感が違う」**状態になっていた。
 *   → **同じ関数から取り、区画らしく一段弱めるだけ**にする。
 *
 * 区画はパネルの「親」なので、**同じ字面のまま少しだけ控えめ**にする
 * （大きさで competing させない。字間と色で階層を作る）。
 *
 * @param skin  パネルと同じ質感キー（区画側で未指定ならダッシュボードの既定）
 */
export function groupTitleStyle(skin, theme, accent) {
    const base = panelTitleSkin(skin, theme, undefined, accent).text ?? {};
    const size = Number(base.fontSize) || 13;
    return {
        ...base,
        // ⚠ パネルより**わずかに小さく**（1px）。大きく差を付けると
        //   「小さくて読めない」になる（実機のスクリーンショットで指摘された症状）
        fontSize: Math.max(10, size - 1),
        // 親であることは**字間**で示す（大きさではなく）
        letterSpacing: base.letterSpacing ?? '0.14em',
        color: base.color ?? theme?.titleColor,
    };
}

export function panelTitleSkin(skin, theme, variant, accent) {
    const ac = accent || theme?.accent;
    // 管制ラベル（従来の noc）。小さめ・大文字・字間広め
    const control = {
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: theme?.subColor,
    };
    const plain = { fontSize: 13, fontWeight: 600, color: theme?.titleColor };

    switch (skin) {
        case 'plain':
            return { box: {}, text: plain, dot: false };
        case 'badge':
            // 従来のカード質感（丸＋通常の文字）
            return { box: {}, text: plain, dot: true };
        case 'bold':
            return {
                box: {},
                text: { ...plain, fontSize: 15, fontWeight: 800, letterSpacing: '0.01em' },
                dot: false,
            };
        case 'accentBar':
            // 左に太いアクセント帯。縦積みの一覧で見出しが立つ
            return {
                box: { boxShadow: `inset 3px 0 0 ${ac}`, paddingLeft: 14 },
                text: plain,
                dot: false,
            };
        case 'filled':
            // 見出しだけ地を敷く。パネルの中身と切り分けたいとき
            return {
                box: { backgroundColor: `${ac}1c` },
                text: { ...plain, color: ac },
                dot: false,
            };
        case 'ribbon':
            // 左端から伸びる帯。タイトルが「ラベル」として読める
            return {
                box: {
                    backgroundImage: `linear-gradient(90deg, ${ac}2e, transparent 62%)`,
                },
                text: { ...control, color: theme?.titleColor },
                dot: false,
            };
        case 'underline':
            // 下線つき（区切り線を明示する）
            return { box: {}, text: plain, dot: false, divider: true };
        case 'stamp':
            // ゴム印：二重の枠で囲った大文字・等幅のラベル。
            //
            // ⚠ **枠は `text`（文字の span）側に付ける。** `box` はタイトルバー
            //   （幅いっぱいの flex コンテナ）に当たるので、そちらに border を
            //   置くと**判子ではなく帯**になる（実機で確認して直した）。
            // ⚠ **傾けない**。transform を持たせると子孫の position:fixed が
            //   祖先基準になり、全画面表示とツールチップが壊れる（§8.z）。
            //   紙の意匠は枠と字間で出し、傾きには頼らない
            return {
                box: {},
                text: {
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: ac,
                    fontFamily: "'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    border: `2px solid ${ac}`,
                    // 外側にもう1本の細罫を回して「二重枠の判子」にする
                    boxShadow: `0 0 0 1px ${ac}`,
                    padding: '2px 8px',
                    borderRadius: 2,
                    // 枠が文字に貼り付くよう、span を行ボックスとして扱う
                    display: 'inline-block',
                    lineHeight: 1.35,
                },
                dot: false,
            };
        case 'mono':
            // 等幅。ID やホスト名を見出しにするとき桁が揃う
            return {
                box: {},
                text: {
                    ...control,
                    letterSpacing: '0.08em',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                },
                dot: false,
            };
        case 'control':
            return { box: {}, text: control, dot: false };
        default:
            // 'auto'（既定）＝ 従来どおり質感に追従する。
            // ⚠ ここを変えると**既存ダッシュボードの見た目が黙って動く**。
            //   判定は改修前とまったく同じ `variant === 'noc'` のみにする
            //   （bracketSolid まで含めると従来バッジだったものが変わってしまう）
            return variant === 'noc'
                ? { box: {}, text: control, dot: false }
                : { box: {}, text: plain, dot: true };
    }
}

/**
 * パネル個別の見た目上書きを CSS に落とす（`panel.style` の拡張分）。
 *
 * 質感プリセット（variant）だけでは「もっと自由に」に応えられないので、
 * 1枚ごとに効かせられるつまみを用意する。**未指定のキーは触らない**
 * （プリセットの値をそのまま活かすため、既定値で上書きしない）。
 *
 *   accent      … このパネルだけアクセント色を変える（タイトルの丸・枠の発光）
 *   bg          … 背景色の直接指定
 *   opacity     … パネル全体の不透明度（背面の図形を透かす）
 *   radius      … 角の丸み
 *   borderColor … 枠線の色
 *   glow        … 枠の外側に出す発光の強さ（0〜1）
 *   blur        … 背面のぼかし（すりガラスの強さ）
 *   rotate      … 傾き（deg）。⚠ transform は position:fixed を壊すので
 *                  0 のときは指定そのものを出さない（§8.z）
 */
/**
 * パネルグループの枠。**複数パネルを1つの領域としてくくる**ための意匠。
 *
 * Studio では iframe の外に描けないので作れない（＝DPX 固有）。
 *
 * 意匠の方針（既存の DPX 言語に合わせる）:
 *   - **新しい色を持ち込まない。** 既定は `t.bracketColor` と同系の中性色。
 *     グループが主張すると中身（数値・グラフ）が引っ込むため
 *   - **塗らない。** 面積に比例する半透明の塗りは raster が重く、
 *     性能方針（§7.1）に反する。枠と見出しだけで領域を示す
 *   - 角の丸みはテーマの `radius` に従う（ここだけ丸いと浮く）
 *
 * ⭐ **質感は `panelSurface()` をそのまま流用する**（2026-08-12・ユーザー指定）。
 * 区画専用の質感を別実装で持つと、**質感を足すたびに2か所を直す**ことになり
 * 必ず片方が古くなる（`radius` を決め打ちして全廃した前科と同じ構図）。
 * 区画固有なのは `rule`（上辺の罫＋下辺の返し）だけで、
 * **残り20種はパネルと同じ関数から取る**。
 *
 * ⚠ 流用にあたっての注意:
 *   - **カギ括弧の腕はパネルより長くする**（区画の方が大きいので、
 *     同じ 11px だと角の印が小さすぎて枠に見えない）
 *   - `色` を指定されたときは**枠線系のプロパティだけ**上書きする
 *     （地色まで塗り替えると質感の意図が壊れる）
 *
 * @param variant 'rule'（既定・区画固有）ほか `PANEL_VARIANTS` の全種
 */
export function groupSurface(theme, variant = 'rule', color) {
    const c = color || theme.bracketColor || `${theme.accent}66`;

    // ⭐ 区画固有の `rule` 以外は**パネルの質感をそのまま使う**。
    //   区画は面積が大きいので、カギ括弧の腕だけ長め（22px）にする。
    // ⚠ 中身がある前提の質感（polaroid / punchCard）は区画では破綻するので、
    //   既存の定義に入っていても**既定（rule）に落とす**（黙って壊れた絵を出さない）
    if (variant && variant !== 'rule' && !GROUP_INCOMPATIBLE_VARIANTS.has(variant)) {
        const surface = panelSurface(theme, variant, 22);
        if (!color) return surface;

        // 色の指定があるときは**もともと線を持っているプロパティだけ**差し替える。
        // ⚠ `panelSurface` は「線なし」を **`border: 'none'`** で表す（truthy）。
        //   単純に `if (tinted.border)` で書き換えると、
        //   **コーナーフレームに全周の枠が生えたり、枠なしに枠が付く**
        //   （実際にこの実装で発生させ、値を出力して気づいた）。
        //   `none` を除外し、**線幅と種別は元のまま**色だけ入れ替える。
        const tinted = { ...surface };
        const recolor = (v) => {
            if (typeof v !== 'string' || v === 'none' || !v.trim()) return v;
            // 「<幅> <種別> <色>」の色だけを置き換える（幅・種別は質感の意図）
            const m = v.match(/^(\S+\s+\S+)\s+.+$/);
            return m ? `${m[1]} ${c}` : v;
        };
        for (const k of ['border', 'borderTop', 'borderLeft', 'borderRight', 'borderBottom']) {
            if (k in tinted) tinted[k] = recolor(tinted[k]);
        }
        // コーナーフレーム系は backgroundImage が線そのものなので引き直す
        if (variant === 'noc' || variant === 'bracketSolid') {
            Object.assign(tinted, cornerBrackets(c, 22, 1));
        }
        return tinted;
    }
    // 既定＝**上辺の罫＋下辺の返し**（設計図の表題欄の語彙）。
    //
    // ⚠ 当初は四隅のカギ括弧にしたが、**パネルの `noc` 質感と見分けが付かなかった**
    //   （実機のスクリーンショットで確認。腕の長さを変えても、括弧が並ぶだけで
    //   「どれがグループでどれがパネルか」が読めない）。
    //   グループは**パネルが持たない device** を使う必要がある。
    //
    // ⚠ **上辺の罫だけでは「区画の終わり」が分からない**（2026-08-12・2x 拡大で判明）。
    //   下に境界が無いので、次のパネルとの境目が読めなかった。
    //   → **下辺の左右だけに短い垂直の「返し」**を足す。全周を囲うと
    //   パネルの枠と競合するので、**線量は最小**にして区画の下端だけを示す。
    //
    // 実装は linear-gradient の重ね（`cornerBrackets` と同じ方式）。
    // 面積比例の塗りではないので raster が軽い（§7.1 の性能方針）。
    // ⚠ 返しを**垂直線**にしたら、パネルのカギ括弧と近接して
    //   「見分けが付かない一塊」に見えた（2x 拡大で確認）。
    //   → **水平の短い罫**にする。上辺の罫と同じ語彙なので
    //   「同じものの下端」と読め、括弧（パネル）とは競合しない。
    const line = `linear-gradient(${c}, ${c})`;
    const RETURN_W = 26; // 返しの長さ(px)。上辺の罫の「続き」に見える程度に短く
    return {
        borderRadius: 0,
        backgroundColor: 'transparent',
        borderTop: `1px solid ${c}`,
        backgroundImage: [line, line].join(', '),
        backgroundRepeat: 'no-repeat',
        backgroundSize: [`${RETURN_W}px 1px`, `${RETURN_W}px 1px`].join(', '),
        backgroundPosition: ['left bottom', 'right bottom'].join(', '),
    };
}

export function panelStyleOverrides(style = {}, theme) {
    const css = {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    // ⚠ **`background`（一括）で書いてはいけない。**
    //   一括プロパティは `background-image` を `none` にリセットするので、
    //   コーナーフレーム（`cornerBrackets()` が敷く linear-gradient 8枚）が
    //   **丸ごと消える**。`style.bg` を触った瞬間に枠が無くなり、
    //   色を戻しても枠は戻らない（実機で発生。`bg` が空文字でない限り消え続ける）。
    //   `transparent` に限らず**どんな色でも**同じ。必ず backgroundColor で書く。
    //   `''`（未指定）は下の if で弾かれるので、プリセットの地がそのまま残る。
    if (style.bg) css.backgroundColor = style.bg;
    if (style.borderColor) css.border = `1px solid ${style.borderColor}`;

    const radius = num(style.radius);
    if (radius !== null) css.borderRadius = radius;

    const opacity = num(style.opacity);
    if (opacity !== null && opacity < 1) css.opacity = Math.max(0, opacity);

    const glow = num(style.glow);
    if (glow) {
        const c = style.accent || theme.accent;
        css.boxShadow = `0 0 ${Math.round(glow * 40)}px ${c}${Math.round(
            Math.min(Math.max(glow, 0), 1) * 120
        )
            .toString(16)
            .padStart(2, '0')}`;
    }

    const blur = num(style.blur);
    if (blur) css.backdropFilter = `blur(${blur}px)`;

    const rotate = num(style.rotate);
    // ⚠ 0 のときは transform を書かない。transform があるだけで子孫の
    //   position:fixed が壊れる（全画面・ツールチップが消える。§8.z）
    if (rotate) css.transform = `rotate(${rotate}deg)`;

    return css;
}
