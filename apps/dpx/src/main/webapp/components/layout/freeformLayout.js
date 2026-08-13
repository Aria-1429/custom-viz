// ── Freeform Layout（自由配置）──────────────────────────────────
//
// パネルを**ピクセル単位の絶対配置**で置く方式。グリッドに縛られない構図
// （斜めに散らした計器盤、背景画像に合わせた配置など）のためのもの。
//
// ## グリッドとの関係（重要な設計判断）
//
// ⭐ **座標の意味だけを変え、スキーマは共有する。**
//   `panel.x / y / w / h` は同じキーのまま、**単位が「セル」から「px」に変わる**。
//   別キー（`px`/`py`）を足さない理由:
//     - パネルの移動・複製・区画・undo など**既存の処理が全部そのまま効く**
//     - グリッド ⇄ フリーフォームの切替が**座標の変換だけ**で済む
//
// ⚠ **切替時は座標を変換する**（`convertFromGrid` / `convertToGrid`）。
//   変換せずに単位だけ読み替えると、`x:6` のパネルが**画面左端 6px** に飛ぶ。
//
// ## グリッドとの違い
//
// | | grid | freeform |
// |---|---|---|
// | 単位 | 列 / 行 | px |
// | 重なり | 可（`style.z`） | 可（同じ） |
// | スナップ | 常にセル境界 | `snap` px（既定 8。0 で無効） |
// | 高さ | 行数 × rowHeight | そのまま px |
// ────────────────────────────────────────────────────────────────

import { clamp, toNum } from './types.js';

/** スナップ幅（px）。0 でスナップ無し。 */
const DEFAULT_SNAP = 8;

function snapTo(v, snap) {
    const s = toNum(snap, DEFAULT_SNAP);
    if (s <= 0) return Math.round(v);
    return Math.round(v / s) * s;
}

export const freeformLayout = {
    id: 'freeform',
    name: 'フリーフォーム',

    containerStyle(ctx) {
        return {
            position: 'relative',
            // ⚠ 高さは中身から決まらない（絶対配置なので）。
            //   最下端のパネルに合わせて伸ばすのは呼び出し側の責務
            minHeight: ctx.containerHeight || 400,
        };
    },

    /** パネル 1 枚の配置 CSS（絶対配置）。 */
    styleFor(panel, ctx) {
        return {
            position: 'absolute',
            left: toNum(panel.x, 0),
            top: toNum(panel.y, 0),
            width: Math.max(40, toNum(panel.w, 240)),
            height: Math.max(32, toNum(panel.h, 160)),
        };
    },

    pixelSize(panel) {
        return {
            width: Math.max(40, toNum(panel.w, 240)),
            height: Math.max(32, toNum(panel.h, 160)),
        };
    },

    /**
     * ドラッグ移動。
     * ⚠ **左端・上端で止める**（負の座標に出すと掴めなくなる）。
     */
    applyDrag(panel, { dx, dy }, ctx) {
        const snap = ctx.layout?.freeform?.snap;
        const w = Math.max(40, toNum(panel.w, 240));
        const maxX = Math.max(0, (ctx.containerWidth || 0) - w);
        const next = {
            x: clamp(snapTo(toNum(panel.x, 0) + dx, snap), 0, maxX || Number.MAX_SAFE_INTEGER),
            y: Math.max(0, snapTo(toNum(panel.y, 0) + dy, snap)),
        };
        if (next.x === toNum(panel.x, 0) && next.y === toNum(panel.y, 0)) return null;
        return next;
    },

    applyResize(panel, { dx, dy }, ctx) {
        const snap = ctx.layout?.freeform?.snap;
        const next = {
            w: Math.max(40, snapTo(toNum(panel.w, 240) + dx, snap)),
            h: Math.max(32, snapTo(toNum(panel.h, 160) + dy, snap)),
        };
        if (next.w === toNum(panel.w, 240) && next.h === toNum(panel.h, 160)) return null;
        return next;
    },

    /** 矢印キー：1 スナップぶん動かす（Shift 併用でリサイズ）。 */
    nudge(panel, [dx, dy], resize, ctx) {
        const step = toNum(ctx.layout?.freeform?.snap, DEFAULT_SNAP) || 1;
        if (resize) {
            return {
                w: Math.max(40, toNum(panel.w, 240) + dx * step),
                h: Math.max(32, toNum(panel.h, 160) + dy * step),
            };
        }
        return {
            x: Math.max(0, toNum(panel.x, 0) + dx * step),
            y: Math.max(0, toNum(panel.y, 0) + dy * step),
        };
    },

    /** 区画の移動量。フリーフォームは列の上限が無いので上/左だけ止める。 */
    clampGroupDelta(members, { dx, dy }) {
        if (!members.length) return { dx: 0, dy: 0 };
        const minX = Math.min(...members.map((p) => toNum(p.x, 0)));
        const minY = Math.min(...members.map((p) => toNum(p.y, 0)));
        return { dx: Math.max(-minX, dx), dy: Math.max(-minY, dy) };
    },

    /** ポインタ移動量はそのまま px。 */
    toCells({ dx, dy }) {
        return { dx, dy };
    },
};

// ── 座標変換（レイアウト切替時）──────────────────────────────────
//
// ⚠ **切替時に必ず通す。** 通さないと「セル 6」が「6px」になって
//   全パネルが左上に固まる。

/** グリッド座標（列/行）→ ピクセル座標。 */
export function convertFromGrid(panels, ctx) {
    const cw =
        ctx.containerWidth > 0
            ? (ctx.containerWidth - ctx.gap * (ctx.columns - 1)) / ctx.columns
            : 100;
    return panels.map((p) => ({
        ...p,
        x: Math.round(toNum(p.x, 0) * (cw + ctx.gap)),
        y: Math.round(toNum(p.y, 0) * (ctx.rowHeight + ctx.gap)),
        w: Math.round(Math.max(1, toNum(p.w, 1)) * cw + (Math.max(1, toNum(p.w, 1)) - 1) * ctx.gap),
        h: Math.round(
            Math.max(1, toNum(p.h, 1)) * ctx.rowHeight + (Math.max(1, toNum(p.h, 1)) - 1) * ctx.gap
        ),
    }));
}

/** ピクセル座標 → グリッド座標（列/行）。 */
export function convertToGrid(panels, ctx) {
    const cw =
        ctx.containerWidth > 0
            ? (ctx.containerWidth - ctx.gap * (ctx.columns - 1)) / ctx.columns
            : 100;
    return panels.map((p) => {
        // ⚠ **幅も列数で頭打ちにする。** x だけクランプしても、
        //   極端に広いパネル（フリーフォームでは可能）が **12 列を超えて残る**。
        //   テストで検出した実バグ（`w=50` が素通りしていた）。
        const w = clamp(Math.round(toNum(p.w, 240) / (cw + ctx.gap)), 1, ctx.columns);
        return {
            ...p,
            x: clamp(Math.round(toNum(p.x, 0) / (cw + ctx.gap)), 0, Math.max(0, ctx.columns - w)),
            y: Math.max(0, Math.round(toNum(p.y, 0) / (ctx.rowHeight + ctx.gap))),
            w,
            h: Math.max(1, Math.round(toNum(p.h, 160) / (ctx.rowHeight + ctx.gap))),
        };
    });
}
