// ── Theme（配色）────────────────────────────────────────────────
//
// **色だけ**を持つ層。18 個のプリセットと、定義からの解決（`resolveTheme`）。
//
// ⚠ **面の質感は持たない**（それは Surface Engine の担当）。
//
// ## ⚠ 派生キーは resolveTheme と useDpxTheme の両方に持たせる
//
// `useDpxTheme()` のフォールバック側だけ派生キー（`textColor` など）が
// 欠けていると、**Provider が無い経路でだけ文字が消える**。
// 実際に「ライト系テーマでだけ白文字が白地に」なった前科がある。
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
        name: 'カーボン',
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
        name: 'アンバー',
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
        name: 'スレート',
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
        name: 'マトリクス',
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
        name: 'ペーパー',
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
        name: 'レタープレス',
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
        name: 'ブループリント',
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
        name: 'サーマル',
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
        name: 'E Ink',
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
        name: '水彩',
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
        // 紙そのものの色。**手描き画材の canvas 描画が「顔料が乗らなかった凹み」を
        //   この色で置く**（handDrawn.js の applyTooth）。生成りの水彩紙
        paperColor: '#fdfaf2',
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
        name: 'クレヨン',
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
        // 紙そのものの色。**手描き画材の canvas 描画が「顔料が乗らなかった凹み」を
        //   この色で置く**（handDrawn.js の applyTooth）。黒画用紙
        paperColor: '#1f1c19',
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
        name: '色鉛筆',
        // スケッチブックの紙。細かい紙目（4px 間隔の 1px 粒）だけを敷き、
        // 色は乗せない（色は系列色＝芯の色に任せる。地が主張すると芯が濁る）
        canvasBg:
            'radial-gradient(rgba(70, 75, 85, 0.09) 1px, transparent 1px) 0 0 / 4px 4px, ' +
            'linear-gradient(180deg, #f5f3ee 0%, #efede5 100%)',
        // 紙そのものの色。**手描き画材の canvas 描画が「顔料が乗らなかった凹み」を
        //   この色で置く**（handDrawn.js の applyTooth）。スケッチブックの紙
        paperColor: '#f2f0e9',
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
        name: 'インク＋水彩',
        // アーバンスケッチ（ペン＋淡彩）。地は旅帳の生成り。
        // 群青のウォッシュを上辺に一刷け、隅は紙の日焼けでわずかに沈める
        canvasBg:
            'radial-gradient(ellipse 60% 30% at 70% 0%, rgba(74,128,173,0.15), transparent 62%),' +
            ' radial-gradient(ellipse 34% 24% at 6% 92%, rgba(191,106,85,0.10), transparent 62%),' +
            ' radial-gradient(ellipse 120% 90% at 50% 50%, transparent 60%, rgba(110,90,60,0.10) 100%),' +
            ' linear-gradient(180deg, #f6f1e4 0%, #f1ebdc 100%)',
        // 紙そのものの色。**手描き画材の canvas 描画が「顔料が乗らなかった凹み」を
        //   この色で置く**（handDrawn.js の applyTooth）。旅帳の生成り
        paperColor: '#f4efe0',
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
        name: 'Liquid Glass',
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

/** プリセットを選ぶ UI での並び順（暗い画面 → 明るい紙 → 画材 → ガラス）。
 *
 *  ⚠ **`DPX_PRESETS` の定義順とは分ける。** 定義順は追加した歴史そのもので、
 *    「発光系のあとに紙が来て、また発光系に戻る」という並びになっていた。
 *    ここを見れば UI の並びが分かるようにし、**定義の場所を動かさずに**
 *    順番を変えられるようにする（数百行のブロック移動は差分が読めなくなる）。
 *  ⚠ 新しいプリセットを足したらこの配列にも足すこと（漏れたものは末尾に回る）。 */
export const PRESET_ORDER = [
    // 暗い画面（発光系）
    'midnight',
    'slate',
    'carbon',
    'neon',
    'aurora',
    'matrix',
    'amber',
    'thermal',
    // 明るい地・紙もの
    'light',
    'paper',
    'eink',
    'letterpress',
    'blueprint',
    // 手描きの画材
    'watercolor',
    'inkwash',
    'pencil',
    'crayon',
    // ガラス
    'liquidGlass',
];

/** プリセットの一覧を表示順で返す（`[key, preset]` の配列）。
 *  ⚠ `PRESET_ORDER` に無いものも**必ず末尾に出す**（足し忘れても消えない）。 */
export function orderedPresets() {
    const keys = Object.keys(DPX_PRESETS);
    const ranked = PRESET_ORDER.filter((k) => k in DPX_PRESETS);
    const rest = keys.filter((k) => !PRESET_ORDER.includes(k));
    return [...ranked, ...rest].map((k) => [k, DPX_PRESETS[k]]);
}

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
