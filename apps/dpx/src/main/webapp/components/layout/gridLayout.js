// ── Grid Layout（既定）───────────────────────────────────────────
//
// CSS grid に載せる方式。**現行 DPX の挙動をそのまま抽出したもの**で、
// 座標の意味・クランプ規則・区画の見出し行の扱いを一切変えていない。
//
// - パネルの x/y/w/h は**列 / 行の単位**（ピクセルではない）
// - パネルは**重ねてよい**（同じセルに複数置き `style.z` で順序制御）。
//   Studio の grid では組めない構図（全面地図の上にガラスパネル等）のため
// - 区画（グループ）の見出し用に**行を挿し込む**ことがあるので、
//   行番号は `ctx.rowOf(y)` を通す（定義の `panel.y` は書き換えない）
// ────────────────────────────────────────────────────────────────

import { clamp, toNum } from './types.js';

/** セル 1 個ぶんの幅（px）。gap を差し引いてから列数で割る。 */
export function cellWidth(ctx) {
    const { containerWidth, gap, columns } = ctx;
    if (!containerWidth || columns <= 0) return 0;
    return (containerWidth - gap * (columns - 1)) / columns;
}

/** 行 n 個ぶんの高さ（px）。間の gap も含む。 */
export function rowsToPx(n, ctx) {
    const rows = Math.max(0, toNum(n, 0));
    if (rows === 0) return 0;
    return rows * ctx.rowHeight + (rows - 1) * ctx.gap;
}

export const gridLayout = {
    id: 'grid',
    name: 'グリッド',

    /** コンテナ（グリッド本体）の CSS。 */
    containerStyle(ctx, rowTemplate) {
        return {
            display: 'grid',
            gridTemplateColumns: `repeat(${ctx.columns}, 1fr)`,
            // ⚠ 区画の見出し行だけ低くするため、必要なときは行を明示する
            //   （`gridAutoRows` では「見出し行だけ低く」ができない＝全行同じ高さになる）
            ...(rowTemplate ? { gridTemplateRows: rowTemplate } : {}),
            gridAutoRows: `${ctx.rowHeight}px`,
            gap: ctx.gap,
        };
    },

    /** パネル 1 枚の配置 CSS（グリッド項目）。 */
    styleFor(panel, ctx) {
        const x = toNum(panel.x, 0);
        const y = toNum(panel.y, 0);
        const w = Math.max(1, toNum(panel.w, 1));
        const h = Math.max(1, toNum(panel.h, 1));
        return {
            gridColumn: `${x + 1} / span ${w}`,
            gridRow: `${ctx.rowOf(y)} / span ${h}`,
        };
    },

    /**
     * パネルの実ピクセル寸法。
     * ⚠ **viz には数値の height が要る**（`100%` では中身が潰れる viz がある）。
     */
    pixelSize(panel, ctx) {
        return {
            width: null, // 幅は grid（1fr）が決めるので数値では出さない
            height: rowsToPx(Math.max(1, toNum(panel.h, 1)), ctx),
        };
    },

    /**
     * ドラッグ移動 → 新しい x/y。
     *
     * ⚠ **掴んだ時点の座標（panel）からの絶対量で計算する。**
     *   前フレームからの差分を足し込む形にすると、クランプで止まった後に
     *   戻すときズレる（実機で確認済みの規則）。
     */
    applyDrag(panel, { dx, dy }, ctx) {
        const cw = cellWidth(ctx);
        if (cw <= 0) return null;
        const dxCells = Math.round(dx / (cw + ctx.gap));
        const dyRows = Math.round(dy / (ctx.rowHeight + ctx.gap));
        const w = Math.max(1, toNum(panel.w, 1));
        const next = {
            x: clamp(toNum(panel.x, 0) + dxCells, 0, ctx.columns - w),
            y: Math.max(toNum(panel.y, 0) + dyRows, 0),
        };
        // 掴んだ時点と同じなら「動いていない」＝保存対象にしない
        if (next.x === toNum(panel.x, 0) && next.y === toNum(panel.y, 0)) return null;
        return next;
    },

    /** ドラッグリサイズ → 新しい w/h。 */
    applyResize(panel, { dx, dy }, ctx) {
        const cw = cellWidth(ctx);
        if (cw <= 0) return null;
        const dxCells = Math.round(dx / (cw + ctx.gap));
        const dyRows = Math.round(dy / (ctx.rowHeight + ctx.gap));
        const x = toNum(panel.x, 0);
        const next = {
            w: clamp(toNum(panel.w, 1) + dxCells, 1, ctx.columns - x),
            h: Math.max(toNum(panel.h, 1) + dyRows, 1),
        };
        if (next.w === toNum(panel.w, 1) && next.h === toNum(panel.h, 1)) return null;
        return next;
    },

    /** 矢印キー 1 ステップ（`dir` は [dx, dy] のセル単位）。 */
    nudge(panel, [dx, dy], resize, ctx) {
        const x = toNum(panel.x, 0);
        const w = Math.max(1, toNum(panel.w, 1));
        if (resize) {
            return {
                w: clamp(w + dx, 1, ctx.columns - x),
                h: Math.max(1, toNum(panel.h, 1) + dy),
            };
        }
        return {
            x: clamp(x + dx, 0, ctx.columns - w),
            y: Math.max(0, toNum(panel.y, 0) + dy),
        };
    },

    /**
     * 区画（グループ）をまとめて動かすときの移動量を求める。
     *
     * ⚠ **クランプは「区画全体」で判定する（最重要）。**
     *   パネルごとに `clamp(0, columns - w)` すると、**端に当たった 1 枚だけが
     *   止まって区画の形が崩れる**。先に「全体で動ける量」を求めてから全員に足す。
     */
    clampGroupDelta(members, { dx, dy }, ctx) {
        if (!members.length) return { dx: 0, dy: 0 };
        const minX = Math.min(...members.map((p) => toNum(p.x, 0)));
        const minY = Math.min(...members.map((p) => toNum(p.y, 0)));
        const maxRight = Math.max(...members.map((p) => toNum(p.x, 0) + Math.max(1, toNum(p.w, 1))));
        // ⚠ `+ 0` で **-0 を 0 に正規化する**。`Math.max(-0, …)` は -0 を返し、
        //   定義に入ると JSON に `-0` として残る（比較でも `0` と別物扱いになる）。
        return {
            dx: Math.max(-minX, Math.min(dx, ctx.columns - maxRight)) + 0,
            dy: Math.max(-minY, dy) + 0,
        };
    },

    /** ポインタ移動量（px）→ セル / 行の移動量。 */
    toCells({ dx, dy }, ctx) {
        const cw = cellWidth(ctx);
        if (cw <= 0) return { dx: 0, dy: 0 };
        return {
            dx: Math.round(dx / (cw + ctx.gap)),
            dy: Math.round(dy / (ctx.rowHeight + ctx.gap)),
        };
    },
};
