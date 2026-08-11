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
};

/** 明るい地のプリセット（colorScheme=light 扱い）。 */
const LIGHT_PRESETS = new Set(['light', 'paper']);

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
