// NOC ウォールの配色・タイポグラフィ。
//
// このページは Splunk のライト／ダークテーマには追従しない。
// 壁掛けモニタで常時表示する前提なので、暗所で見やすい暗色に固定する
// （明るい背景だと大画面では眩しく、発光表現も成立しない）。

export const C = {
    // 背景は「完全な黒」にしない。わずかに青を含ませると発光色が沈んで見える。
    bg: '#05070D',
    bgPanel: 'rgba(18, 24, 40, 0.55)',
    bgPanelSolid: '#0B1120',
    grid: 'rgba(120, 160, 255, 0.07)',
    border: 'rgba(120, 170, 255, 0.16)',
    borderBright: 'rgba(120, 190, 255, 0.42)',

    text: '#E6EDFF',
    textDim: '#8A9BC4',
    textFaint: '#4A5878',

    // ステータス色。彩度を上げすぎると大画面で滲むので、発光は glow 側で足す。
    ok: '#25E0A8',
    info: '#3BA9FF',
    warn: '#FFC24B',
    high: '#FF8A3D',
    crit: '#FF4767',
    accent: '#8B5CFF',
};

/** severity 文字列 → 色。未知の値は info 扱いにする（描画を止めない）。 */
export function severityColor(sev) {
    const s = String(sev || '').toLowerCase();
    if (s.startsWith('crit') || s === 'fatal' || s === 'emergency') return C.crit;
    if (s.startsWith('high') || s === 'error' || s === 'err') return C.high;
    if (s.startsWith('med') || s.startsWith('warn')) return C.warn;
    if (s.startsWith('low') || s === 'debug') return C.ok;
    return C.info;
}

/**
 * 数値の桁を落として読みやすくする（1284392 → 1.28M）。
 *
 * 1万未満はそのまま出す。件数のような整数に小数点が付くと
 * 「50.4 件のアラート」のように意味を取り違えるので、整数は整数のまま見せる。
 */
export function compact(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
    return Number.isInteger(v)
        ? v.toLocaleString()
        : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// 等幅フォントは数字が揃うので、大画面のメトリクス表示に必須。
// 外部フォントは読み込めない（オフライン制約）ため OS 同梱のものを並べる。
export const MONO = `"SF Mono", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace`;
