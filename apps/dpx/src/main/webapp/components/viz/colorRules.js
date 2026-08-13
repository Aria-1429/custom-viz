// ── DPX 値→色マッピング（Splunk 標準の「動的色設定」に相当）─────
//
// Studio では DOS（`> table | seriesByName("x") | rangeValue(...)`）という
// 式を手で書く必要がある機能を、DPX では**すべて UI から設定できる**ようにしている。
// 対応関係:
//   DOS `rangeValue`   → mode: 'range'     （しきい値→色）
//   DOS `matchValue`   → mode: 'match'     （文字列→色）
//   DOS `gradient`     → mode: 'gradient'  （最小〜最大を連続で写像。しきい値を書かなくてよい）
//   DOS `maxContrast`  → pickTextColor()   （背景色から読みやすい文字色を自動選択）
//
// 設定オブジェクト:
// {
//   mode: 'range' | 'match' | 'gradient',  // 範囲 / 一致 / 連続グラデーション
//   palette?: 'trafficDark' | ... // プリセットパレット名（適用ボタン用の記録）
//   // mode='range': 昇順の区切り。色は区切り数+1 個（最小側から）
//   //   thresholds: [20, 40, 60, 80]
//   //   colors:     ['#c0392b', '#e07b39', '#e3c04a', '#8fbf45', '#3fa34d']
//   //   → 20未満 / 20〜40 / 40〜60 / 60〜80 / 80以上
//   thresholds?: number[],
//   colors?: string[],
//   // mode='match': 値と色の対応（値は「そのまま」1件1行。区切り記号は不要）
//   matches?: [{ value: '稼働', color: '#3cdcb4', label?: 'RUNNING' }],
//   // mode='gradient': colors を最小値〜最大値に連続で写像する。
//   //   しきい値を1つも決めなくてよいのが利点（ヒートマップ的な見せ方）。
//   //   min/max を省略すると、その列の実データの最小・最大を使う。
//   min?: number, max?: number,
//   defaultColor?: string,        // どれにも当たらない場合
// }
//
// 「crit|重大」のような区切り記号を使う記法は廃止（ユーザー負担が大きい）。
// 同じ色に複数の値を割り当てたい場合は、行を複数作って同じ色を選ぶ。
// ────────────────────────────────────────────────────────────────

export const COLOR_PALETTES = [
    {
        id: 'trafficDark',
        name: 'ダークカラー',
        colors: ['#c0392b', '#d35400', '#d9a441', '#c9c04a', '#8fbf45', '#5fa844', '#3fa34d'],
    },
    {
        id: 'trafficLight',
        name: 'ライトカラー',
        colors: ['#e8746b', '#ef9a68', '#efc46b', '#e7e07e', '#b7d977', '#8ccf6a', '#6cc27a'],
    },
    {
        id: 'oceanDark',
        name: 'オーシャン',
        colors: ['#0b3d63', '#12557f', '#1a6f9c', '#2489b8', '#38a5cf', '#5cc0e0', '#8ad8ee'],
    },
    {
        id: 'violetDark',
        name: 'バイオレット',
        colors: ['#2b1a52', '#3f2478', '#57309e', '#7147c4', '#8f68dd', '#ae8ee9', '#ccb6f2'],
    },
    {
        id: 'heat',
        name: 'ヒート',
        colors: ['#2c1a4a', '#5c2472', '#9b2f6d', '#cf4a52', '#eb7d3c', '#f4b13a', '#f7e05e'],
    },
];

/** パレットから n 色を等間隔で取り出す（両端を必ず含む）。 */
export function samplePalette(paletteId, n) {
    const p = COLOR_PALETTES.find((x) => x.id === paletteId) ?? COLOR_PALETTES[0];
    const src = p.colors;
    if (n <= 1) return [src[src.length - 1]];
    const out = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.round((i / (n - 1)) * (src.length - 1));
        out.push(src[idx]);
    }
    return out;
}

// ── 色の変換（gradient / maxContrast の土台）─────────────────────

/** '#rgb' / '#rrggbb' → {r,g,b}。解釈できなければ null。 */
export function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    const s = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) {
        return { r: parseInt(s[0] + s[0], 16), g: parseInt(s[1] + s[1], 16), b: parseInt(s[2] + s[2], 16) };
    }
    if (/^[0-9a-fA-F]{6}$/.test(s)) {
        return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
    }
    return null;
}

const toHex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** {r,g,b} → '#rrggbb' */
export function rgbToHex({ r, g, b }) {
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/**
 * 色の配列を 0〜1 の位置で線形補間する（DOS の `gradient` 相当）。
 * ⚠ 補間は sRGB 上で行う。厳密には知覚均等では無いが、
 *   Splunk 標準の gradient も同じ見え方なので揃えている。
 */
export function sampleGradient(colors, ratio) {
    const list = (colors ?? []).map(hexToRgb).filter(Boolean);
    if (list.length === 0) return null;
    if (list.length === 1) return rgbToHex(list[0]);
    const p = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const pos = p * (list.length - 1);
    const i = Math.min(Math.floor(pos), list.length - 2);
    const f = pos - i;
    const a = list[i];
    const b = list[i + 1];
    return rgbToHex({ r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f });
}

/**
 * 背景色の相対輝度（WCAG）。0=黒 〜 1=白。
 * ⚠ 単純な (r+g+b)/3 では緑が明るく見える性質を拾えず、
 *   緑背景で黒文字が選ばれて読みにくくなる。必ず係数つきで計算する。
 */
export function relativeLuminance(hex) {
    const c = hexToRgb(hex);
    if (!c) return null;
    const ch = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/**
 * 背景色に対してコントラストが高い方の文字色を返す（DOS の `maxContrast` 相当）。
 * 候補は既定で白・黒。背景が決められないときは null（呼び出し側が既定色を使う）。
 */
export function pickTextColor(bgHex, candidates = ['#ffffff', '#0b1220']) {
    const lum = relativeLuminance(bgHex);
    // ⚠ 背景が解釈できないときに候補から1つ選んでしまうと、
    //    「地の色が分からないのに白文字」のような事故になる。null を返して
    //    呼び出し側の既定色に委ねる（テストで検出した）
    if (lum === null) return null;
    let best = null;
    let bestRatio = -1;
    for (const c of candidates) {
        const l = relativeLuminance(c);
        if (l === null) continue;
        const ratio = (Math.max(lum, l) + 0.05) / (Math.min(lum, l) + 0.05);
        if (ratio > bestRatio) {
            bestRatio = ratio;
            best = c;
        }
    }
    return best;
}

/** 既定の色設定（範囲モード・4区切り＝5色）。 */
export function defaultColorRules(mode = 'range') {
    if (mode === 'match') {
        return { mode: 'match', matches: [], defaultColor: '' };
    }
    if (mode === 'gradient') {
        // しきい値を持たない。色は3点あれば「低→中→高」が表現できる
        return { mode: 'gradient', palette: 'heat', colors: samplePalette('heat', 3), defaultColor: '' };
    }
    return {
        mode: 'range',
        palette: 'trafficDark',
        thresholds: [20, 40, 60, 80],
        colors: samplePalette('trafficDark', 5),
        defaultColor: '',
    };
}

/** 旧形式（[{match, color, label}] のルール配列）を新形式へ移行する。
 *  `|` 区切りは1行1値に展開し、`>50` 等の数値比較は範囲モードに寄せられないため
 *  一致モードの値として残す（表示は保たれる）。 */
export function migrateLegacyRules(legacy) {
    if (!Array.isArray(legacy) || legacy.length === 0) return null;
    const matches = [];
    for (const r of legacy) {
        const parts = String(r?.match ?? '')
            .split('|')
            .map((x) => x.trim())
            .filter(Boolean);
        for (const value of parts) {
            matches.push({ value, color: r.color, label: r.label || '' });
        }
    }
    return { mode: 'match', matches, defaultColor: '' };
}

/** options から色設定を解決する（旧形式も受ける）。 */
export function resolveColorRules(raw, fallback) {
    let cfg = raw;
    if (typeof cfg === 'string' && cfg.trim()) {
        try {
            cfg = JSON.parse(cfg);
        } catch {
            cfg = null;
        }
    }
    if (Array.isArray(cfg)) cfg = migrateLegacyRules(cfg); // 旧: ルール配列
    if (!cfg || typeof cfg !== 'object' || !cfg.mode) return fallback ?? null;
    return cfg;
}

/**
 * 値に対する色を返す。当たらなければ defaultColor →  null。
 *
 * @param range グラデーションモードでのみ使う `{ min, max }`。
 *              **その列の実データの最小・最大**を呼び出し側から渡す
 *              （設定に min/max があればそちらが優先）。
 *              渡さないとグラデーションは既定色にフォールバックする。
 */
export function colorForValue(cfg, value, range) {
    if (!cfg) return null;
    if (cfg.mode === 'match') {
        const hit = (cfg.matches ?? []).find(
            (m) => String(m.value).toLowerCase() === String(value).toLowerCase()
        );
        return hit?.color || cfg.defaultColor || null;
    }
    if (cfg.mode === 'gradient') {
        const n = Number(value);
        if (!Number.isFinite(n)) return cfg.defaultColor || null;
        const min = Number.isFinite(Number(cfg.min)) ? Number(cfg.min) : range?.min;
        const max = Number.isFinite(Number(cfg.max)) ? Number(cfg.max) : range?.max;
        if (!Number.isFinite(min) || !Number.isFinite(max)) return cfg.defaultColor || null;
        // ⚠ 全行が同値だと max-min=0 でゼロ除算になる。その場合は中間色を返す
        const ratio = max === min ? 0.5 : (n - min) / (max - min);
        return sampleGradient(cfg.colors, ratio) || cfg.defaultColor || null;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) return cfg.defaultColor || null;
    const th = (cfg.thresholds ?? []).slice().sort((a, b) => a - b);
    const colors = cfg.colors ?? [];
    // th=[20,40,60,80] → 区間は 5 つ（<20, 20-40, 40-60, 60-80, >=80）
    let idx = 0;
    while (idx < th.length && num >= th[idx]) idx += 1;
    return colors[idx] || cfg.defaultColor || null;
}

/** 値に対する表示ラベル（一致モードのみ。無ければ元の値）。 */
export function labelForValue(cfg, value) {
    if (!cfg || cfg.mode !== 'match') return null;
    const hit = (cfg.matches ?? []).find(
        (m) => String(m.value).toLowerCase() === String(value).toLowerCase()
    );
    return hit?.label || null;
}
