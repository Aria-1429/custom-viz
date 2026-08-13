// ── Ink Layer（画材を「どこに」掛けるか）─────────────────────────
//
// ⭐⭐ **Brush Engine で一番間違えやすいのはここ。**
//
// ## 何を解決する層か
//
// SVG フィルタは**ラスタライズ後の絵**に掛かる。パネル全体に掛けると
// 「線」も「塗り」も「文字」も区別できず、**ラベルまで波打つ**。
//
// ```
// ✗ <div style="filter:url(#brush)">   ← 中身ぜんぶ歪む（文字も）
//       <Viz />
//   </div>
//
// ✓ <Viz />  → 「印」だけに filter を当てる（文字は素通し）
// ```
//
// **実機で確認済み（2026-08-13）**: 同じ画材のまま、掛ける先を
// 「印だけ」に変えると**棒の質感は保たれ、日本語ラベルの歪みが消えた**。
//
// ⚠ **画材（feTurbulence のパラメータ）をいくら調整しても直らない。**
//   強くすれば文字も歪み、弱くすれば線も効かない。**適用範囲の問題**なので、
//   「画材を自作すれば直る」は誤り。
//
// ## 「印」の決め方（自動 ＋ 例外指定）
//
// **既定は自動検出。viz は「例外」だけを書く。**
//
// | 書き方 | 意味 | 使いどころ |
// |---|---|---|
// | （何も書かない） | 自動検出に任せる | **ほとんどの要素** |
// | `data-dpx-ink="none"` | **この要素だけ外す** | 目盛り・アイコンなど歪むと壊れて見えるもの |
// | `data-dpx-ink="mark"` | **この要素は必ず印** | 自動検出が拾えない形（`<g>` 単位で扱いたい等） |
// | `data-dpx-ink="only"` | **以降この viz は宣言したものだけ** | 全面的に手で管理したいとき |
//
// ⚠⚠ **`mark` を書いても自動検出は止まらない**（2026-08-13 に修正）。
//   以前は「1 つでも宣言があれば宣言だけを見る」全か無かの仕様だった。
//   これだと**例外を 1 つ書くために全部書く**羽目になる
//   （gauge-arc なら 16 箇所）。**例外は 1 行で済むべき。**
//   全部を手で管理したい場合だけ `only` を使う。
//
// ## ⚠ Canvas / WebGL は既定で除外する
//
// `<canvas>` は**1 枚の絵に図形と文字が一緒に焼かれている**ので、
// 原理的に分離できない。掛ければ必ず文字が歪む。
// → 既定は除外。承知のうえで掛けたい場合だけ
//   `panel.style.brushCanvas: true` で明示的に有効にする。
//
// ⚠ **依存ゼロで保つ**（React も DOM API も import しない。純粋な判定関数）。
//   実際の DOM 操作は `useInkFilter`（index.jsx）が行う。
// ────────────────────────────────────────────────────────────────

/** viz が「ここは印」と宣言するための属性。 */
export const INK_ATTR = 'data-dpx-ink';

/** 宣言の値。 */
export const INK_MARK = 'mark';   // この要素は印（自動検出に**追加**する）
export const INK_NONE = 'none';   // この要素だけ外す（最も使う）
export const INK_ONLY = 'only';   // この viz は宣言したものだけを印にする

/**
 * 自動検出で「印」とみなす SVG 要素。
 *
 * ⚠ **`text` / `tspan` / `foreignObject` を入れない**（歪ませたくない当のもの）。
 * ⚠ `image` も入れない（写真や地図タイルが歪むと汚いだけ）。
 */
const SHAPE_TAGS = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
]);

/** 自動検出で**必ず避ける**もの。 */
const NEVER_TAGS = new Set(['text', 'tspan', 'textPath', 'foreignObject', 'image', 'use']);

/**
 * その要素は「印」か（自動検出）。
 *
 * @param tag        小文字のタグ名
 * @param hasTextAncestor その要素が text 系の中にいるか
 */
export function isInkShape(tag, hasTextAncestor = false) {
    if (hasTextAncestor) return false;
    if (NEVER_TAGS.has(tag)) return false;
    return SHAPE_TAGS.has(tag);
}

/**
 * 宣言（`data-dpx-ink`）の解釈。
 *
 * @returns 'mark' | 'none' | null（宣言なし）
 */
export function readInkDeclaration(value) {
    if (value === INK_ONLY) return INK_ONLY;
    if (value === INK_MARK || value === '' || value === 'true') return INK_MARK;
    if (value === INK_NONE || value === 'false') return INK_NONE;
    return null;
}

/**
 * その viz で「宣言したものだけ」を印にするか。
 *
 * ⚠ **`mark` があるだけでは true にしない。** `mark` は自動検出への*追加*で、
 *   自動検出を止めるものではない（例外を 1 つ書くために全部書かせない）。
 */
export function isDeclarativeOnly(values) {
    return (Array.isArray(values) ? values : []).some((v) => readInkDeclaration(v) === INK_ONLY);
}

/**
 * その viz に画材を掛けてよいか（パネル単位の判定）。
 *
 * ⚠ **canvas を含むなら既定で掛けない**。文字が焼き込まれていて分離できないため。
 *
 * @param {{hasCanvas:boolean, declared:boolean, allowCanvas:boolean}} facts
 * @returns {{apply:boolean, reason:string}}
 */
export function decideInkScope({ hasCanvas = false, declared = false, allowCanvas = false } = {}) {
    if (declared) {
        // viz が明示的に印を宣言しているなら、canvas があってもその宣言を信じる
        return { apply: true, reason: 'declared' };
    }
    if (hasCanvas && !allowCanvas) {
        return { apply: false, reason: 'canvas' };
    }
    return { apply: true, reason: 'auto' };
}

/**
 * 図形の大きさ（px）ごとの強さの倍率。
 *
 * **「変位量が図形の何%か」を揃える**ための補正。
 * 値は実機で目視して決めた（gauge-arc の弧 270px で scale 8 相当が自然）。
 *
 * ⚠ **上限を設ける**。大きい図形で青天井に強くすると、
 *   輪郭が溶けて「壊れている」ように見える（実測）。
 */
export const SIZE_TIERS = [
    { maxPx: 40, mul: 0.7 },   // 小さい印（アイコン・目盛り）… 効きすぎるので弱める
    { maxPx: 120, mul: 1 },    // 標準（棒・セル）… 既定値がちょうど良い大きさ
    { maxPx: 260, mul: 1.6 },  // 大きい（太い弧・広い面）
    { maxPx: Infinity, mul: 2.2 }, // 特大（全面の弧・地図）… 上限
];

/** その大きさに掛ける倍率。`px` は図形の外接矩形の長辺。 */
export function sizeTierFor(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return (SIZE_TIERS.find((t) => n <= t.maxPx) ?? SIZE_TIERS[SIZE_TIERS.length - 1]).mul;
}

/**
 * その大きさ用のフィルタ id。
 *
 * ⚠ **フィルタは大きさごとに別実体が要る**（`scale` は属性なので、
 *   1 つの filter を共有すると全部同じ強さになる）。
 */
export const brushFilterIdForSize = (brushId, px) =>
    `dpx-brush-${brushId}-t${SIZE_TIERS.findIndex((t) => Number(px) <= t.maxPx) + 1 || SIZE_TIERS.length}`;
