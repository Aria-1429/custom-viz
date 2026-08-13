// ── Layout Engine の契約（インターフェース定義）──────────────────
//
// **目的**: グリッドとフリーフォームを「差し替え可能な実装」にすること。
//
// 旧実装は CSS grid の座標計算が `DpxDashboard` と `Panel` に直接埋まっており、
// フリーフォームを足す口が無かった。**同じ契約を満たす実装を並べる**形にして、
// `layout.type` で選べるようにする。
//
// ## 設計の要点
//
// ⚠ **エンジンは純粋関数の集合にする。** React に依存させない。
//   理由は 2 つ:
//     1. 素の Node でテストできる（座標計算はテストで押さえないと必ずズレる。
//        「枠のズレは目視で気づけない」＝1 マスずれてもそれらしく見える）
//     2. ドラッグ中のプレビューと確定後の描画で**同じ関数**を通せる
//        （別々に書くと「動いている絵」と「保存された値」が食い違う）
//
// ⚠ **外部ライブラリ（GridStack / react-grid-layout / Craft.js）は採らない。**
//   評価した結果、いずれも DOM か Schema を own する設計で、DPX の
//   **差別化機能を壊す**:
//     - パネル間の隙間に区画（グループ）の枠を描く … ライブラリが DOM を握ると不可能
//     - 区画ごと移動のクランプ（**全体で判定**しないと形が崩れる）
//     - パネルを**重ねられる**こと（`style.z`。Studio の grid では組めない構図）
//   現実装の座標計算は 200 行程度なので、interface 化する方が安全かつ軽い。
//
// ## 契約
//
// ```
// LayoutEngine = {
//   id,                                  // 'grid' | 'freeform'
//   name,                                // UI の表示名
//   // 描画: パネル1枚の CSS を返す（グリッド項目 or 絶対配置）
//   styleFor(panel, ctx) -> CSSProperties,
//   // 描画: コンテナ側の CSS を返す
//   containerStyle(ctx) -> CSSProperties,
//   // 寸法: パネルの実ピクセル高さ（viz に数値で渡すために要る）
//   pixelSize(panel, ctx) -> {width|null, height},
//   // 操作: ポインタの移動量 → パネルの新しい配置（クランプ済み）
//   applyDrag(panel, delta, ctx) -> patch|null,
//   applyResize(panel, delta, ctx) -> patch|null,
//   // 操作: 矢印キーの 1 ステップ
//   nudge(panel, dir, resize, ctx) -> patch|null,
// }
// ```
//
// `ctx`（レイアウト文脈）は実装ごとに必要なものが違うので**丸ごと渡す**:
//   { layout, columns, rowHeight, gap, containerWidth, containerHeight, rowOf }
// ────────────────────────────────────────────────────────────────

/** 数値を範囲に収める。 */
export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
}

/**
 * ⚠ **数値でないものを丸めない。**
 * `Math.max(0, Math.min(n - 1, NaN))` は **NaN のまま素通りする**ので、
 * 添字に使うと落ちる（時間ブラシで実際に踏んだ）。丸める前に弾く。
 */
export function toNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** レイアウト文脈の既定値を埋める。 */
export function makeLayoutContext({
    layout,
    containerWidth = 0,
    containerHeight = 0,
    rowOf = (y) => y + 1,
    headerRows = 0,
} = {}) {
    const grid = layout?.grid ?? {};
    return {
        layout,
        columns: toNum(grid.columns, 12),
        rowHeight: toNum(grid.rowHeight, 72),
        gap: toNum(grid.gap, 12),
        containerWidth,
        containerHeight,
        rowOf,
        headerRows,
    };
}
