// ── viz の共通小物 ──────────────────────────────────────────────
//
// **どの viz でも要る小さな道具**。`nativeViz.jsx` の中に private として
// 埋まっていたものを、SDK の一部として外に出したもの。
//
// ⚠ **ここに「特定の viz でしか要らないもの」を足さない。**
//   足すと SDK が肥大し、「全 viz の共通契約」という意味が薄れる。
//   1 つの viz だけが使うヘルパは、その viz のファイルに置く。
// ────────────────────────────────────────────────────────────────

import React from 'react';

/** 数値に変換する。数値にならなければ null（0 と区別するため NaN を返さない）。 */
export const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * 人が読む数値に整える（1.2k / 3.4M / 5.6G）。
 *
 * ⚠ **欠損は `'—'`**（`0` や `'NaN'` と区別できるように）。
 */
export const fmtNumber = (v, decimals = 1) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(decimals)}G`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(decimals)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(decimals)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(decimals);
};

/**
 * 要素の幅を実測する。
 *
 * ⚠ **callback ref で観測を始める**（mount 時 effect ではない）。
 *   データ到着前に「データがありません」を返す viz では、effect の時点で
 *   ref がまだ null で**観測が永久に始まらない**
 *   （実機で発生：チャートが既定幅 600px のまま固まる）。
 *
 * @returns [ref, width]
 */
export function useContainerSize(defaultW = 600) {
    const [w, setW] = React.useState(defaultW);
    const roRef = React.useRef(null);
    const ref = React.useCallback((el) => {
        if (roRef.current) {
            roRef.current.disconnect();
            roRef.current = null;
        }
        if (!el) return;
        if (el.offsetWidth) setW(el.offsetWidth);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                const width = entries[0]?.contentRect?.width;
                if (width) setW(width);
            });
            ro.observe(el);
            roRef.current = ro;
        }
    }, []);
    return [ref, w];
}

/**
 * データが無いときの表示。
 *
 * ⚠ **`setError` を使わない**（パネルごと差し替わって viz が画面から消える）。
 *   「データがありません」は viz の中で自前で出す。
 */
export function EmptyHint({ loading, message = 'データがありません' }) {
    return (
        <div style={{ padding: 14, fontSize: 12, opacity: 0.55 }}>
            {loading ? '読み込み中…' : message}
        </div>
    );
}
