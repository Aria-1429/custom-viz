// SOC コンソールの配色。NOC Wall と同じ世界観に揃えてある
// （並べて使っても違和感が出ないように、背景・severity 色は同一値）。
//
// ただしこちらは「座って作業する」画面なので、
// 発光は NOC Wall より弱めにして長時間の目視に耐えるようにしている。

export const C = {
    bg: '#05070D',
    bgPanel: 'rgba(18, 24, 40, 0.55)',
    bgRow: 'rgba(30, 42, 68, 0.35)',
    bgRowHover: 'rgba(60, 100, 180, 0.22)',
    grid: 'rgba(120, 160, 255, 0.06)',
    border: 'rgba(120, 170, 255, 0.16)',
    borderBright: 'rgba(120, 190, 255, 0.42)',

    text: '#E6EDFF',
    textDim: '#8A9BC4',
    textFaint: '#4A5878',

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
    if (s.startsWith('crit') || s === 'fatal') return C.crit;
    if (s.startsWith('high') || s === 'error') return C.high;
    if (s.startsWith('med') || s.startsWith('warn')) return C.warn;
    if (s.startsWith('low') || s === 'info') return C.ok;
    return C.info;
}

/** severity の重み。並べ替えに使う（大きいほど深刻）。 */
export function severityRank(sev) {
    const s = String(sev || '').toLowerCase();
    if (s.startsWith('crit')) return 4;
    if (s.startsWith('high')) return 3;
    if (s.startsWith('med')) return 2;
    if (s.startsWith('low')) return 1;
    return 0;
}

/**
 * 一覧に出すステータスの短縮表記。
 * "investigating" は長くて列を圧迫するので詰める（詳細ペインには原文を出す）。
 */
export function statusShort(st) {
    const s = String(st || '').toLowerCase();
    if (s === 'investigating' || s === 'in_progress') return 'INVEST';
    if (s === 'contained') return 'CONTAIN';
    return s;
}

/** ステータス → 色。トリアージの進行状態を示す。 */
export function statusColor(st) {
    const s = String(st || '').toLowerCase();
    if (s === 'new') return C.crit;
    if (s === 'investigating' || s === 'in_progress') return C.warn;
    if (s === 'contained') return C.info;
    if (s === 'closed' || s === 'resolved') return C.ok;
    return C.textDim;
}

/** 数値の桁を落とす。整数は整数のまま見せる。 */
export function compact(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * エポック秒 → 「12m ago」形式。
 * ⚠ SPL の strftime はサーバの TZ で解釈されるため使わない。
 *   エポック秒で受け取ってブラウザ側で整形する（NOC Wall で踏んだ罠）。
 */
export function agoLabel(epoch) {
    const t = Number(epoch);
    if (!Number.isFinite(t)) return '—';
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - t));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

/** エポック秒 → HH:MM:SS（ブラウザのタイムゾーン）。 */
export function timeLabel(epoch) {
    const t = Number(epoch);
    if (!Number.isFinite(t)) return '--:--:--';
    return new Date(t * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

export const MONO = `"SF Mono", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace`;
