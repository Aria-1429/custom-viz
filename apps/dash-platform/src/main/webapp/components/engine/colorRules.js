// ── DPX 値→色マッピング（Splunk 標準の「動的色設定」に相当）─────
// 設定オブジェクト:
// {
//   mode: 'range' | 'match',      // 範囲（数値のしきい値）/ 一致（文字列）
//   palette?: 'trafficDark' | ... // プリセットパレット名（適用ボタン用の記録）
//   // mode='range': 昇順の区切り。色は区切り数+1 個（最小側から）
//   //   thresholds: [20, 40, 60, 80]
//   //   colors:     ['#c0392b', '#e07b39', '#e3c04a', '#8fbf45', '#3fa34d']
//   //   → 20未満 / 20〜40 / 40〜60 / 60〜80 / 80以上
//   thresholds?: number[],
//   colors?: string[],
//   // mode='match': 値と色の対応（値は「そのまま」1件1行。区切り記号は不要）
//   matches?: [{ value: '稼働', color: '#3cdcb4', label?: 'RUNNING' }],
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

/** 既定の色設定（範囲モード・4区切り＝5色）。 */
export function defaultColorRules(mode = 'range') {
    if (mode === 'match') {
        return { mode: 'match', matches: [], defaultColor: '' };
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

/** 値に対する色を返す。当たらなければ defaultColor →  null。 */
export function colorForValue(cfg, value) {
    if (!cfg) return null;
    if (cfg.mode === 'match') {
        const hit = (cfg.matches ?? []).find(
            (m) => String(m.value).toLowerCase() === String(value).toLowerCase()
        );
        return hit?.color || cfg.defaultColor || null;
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
