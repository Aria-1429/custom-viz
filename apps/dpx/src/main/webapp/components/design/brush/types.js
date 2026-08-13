// ── Brush Engine の中間表現（BrushPath）─────────────────────────
//
// **グラフの「線」と「塗り」に画材の質感を与えるための共通表現。**
//
// ## なぜ単一の `d` 文字列にしないか（実測に基づく決定）
//
// 手描きの図形は **1 つの path では表現できない**（2026-08-13 実測）:
//
// | 図形 | path 数 | 内訳 |
// |---|---|---|
// | 線 | 1 | 輪郭 |
// | **塗り矩形（棒）** | **2** | ハッチの塗り（線幅 0.5）＋ 輪郭（線幅 1） |
// | **面（エリア）** | **2** | 塗り ＋ 輪郭 |
//
// **それぞれ線幅も不透明度も違う**ので、単一の `d` に畳むと
// 「重ね塗り＋輪郭」という画材の本質が表現できない。
//
// ## なぜ描画ライブラリの型を公開しないか
//
// **描画ライブラリは差し替え候補になりうる**（実例: `p5.brush` は peer の p5 が
// 17MB で不採用にした）。中間表現を挟んでおけば、実装を替えても
// **viz 側は 1 行も変わらない**。
//
// ⚠ **このファイルと `BrushPath` に、特定ライブラリ固有の語彙を出さないこと。**
//   （`fillSketch` / `roughness` / `bowing` などは実装の内側に閉じる）
//
// ## BrushPath
//
// ```
// {
//   d:       string,   // SVG の path データ
//   role:    'fill' | 'stroke' | 'accent',
//   width:   number,   // 線幅
//   opacity: number,   // 不透明度 0〜1
//   color?:  string,   // 省略時は viz 側の色をそのまま使う
// }
// ```
//
// - `fill`   … 塗り（ハッチ・ウォッシュ）。**面積が大きいので数を抑える**
// - `stroke` … 主線。値を読む手がかりなので**必ず 1 本は出す**
// - `accent` … 縁の溜まり・二度描きの重ね。**省略しても意味が壊れない**もの
//
// `role` を持たせてあるのは、**品質レベルで間引くため**。
// `minimal` では `accent` を捨て、`stroke` だけ残せば「読める」状態を保てる。
// ────────────────────────────────────────────────────────────────

/** BrushPath の role。 */
export const ROLE = { FILL: 'fill', STROKE: 'stroke', ACCENT: 'accent' };

/**
 * 決定論的な seed を作る（FNV-1a）。
 *
 * ⚠⚠ **これが Brush Engine で最も重要な関数。**
 *
 * seed を固定しないと、**React の再描画のたびに手描きの形が変わってチラつく**。
 * 症状が「画面がなんとなく落ち着かない」としか出ないため原因特定が非常に難しい
 * （パネル枠の canvas 実装で実際に踏んだ）。
 *
 * ⚠ **データの「値」を seed に含めないこと。**
 *   含めると `makeresults` のようにサーチのたびに値が変わるデータで
 *   **再サーチのたびに形が変わる**。
 *   逆に「点の数」は含めるべき（点数が変われば形が変わるのが自然）。
 *
 * 推奨: `seedFor(panel.id, seriesName, points.length)`
 */
export function seedFor(...parts) {
    let h = 0x811c9dc5;
    const s = parts.filter((p) => p != null).join('\u0000');
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // rough.js の seed は 32bit 整数を想定するので正の整数へ均す
    return Math.abs(h | 0) || 1;
}

/**
 * 品質レベルで BrushPath を間引く。
 *
 * ⚠ **`stroke` は絶対に落とさない**（線が消えるとグラフが読めなくなる）。
 *   落としてよいのは `accent`（重ね描き）と、次点で `fill`（塗り）。
 *
 * @param paths BrushPath[]
 * @param level 'full' | 'reduced' | 'minimal'
 */
export function prunePaths(paths, level) {
    if (!Array.isArray(paths)) return [];
    if (level === 'minimal') return paths.filter((p) => p.role === ROLE.STROKE);
    if (level === 'reduced') return paths.filter((p) => p.role !== ROLE.ACCENT);
    return paths;
}
