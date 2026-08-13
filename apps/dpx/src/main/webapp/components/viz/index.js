// ── DPX Viz SDK（viz が使ってよいものの全部）─────────────────────
//
// ⭐⭐ **viz を書くときに import してよいのは、このファイルだけ。**
//
// ```
// import { useDpxTheme, useVizData, VizTooltip, … } from './';
// ```
//
// ## なぜ「1 つの入口」にするのか
//
// 以前は viz が **engine の内部 8 モジュールから 23 個のシンボル**を
// 直接 import していた。そのため:
//
//   - **viz を足すとき「どこから何を import すべきか」が自明でない**
//     （既存の viz を読んで真似するしかない）
//   - engine 側の内部を動かすと **viz が巻き添えで壊れる**
//   - ⚠ 実際に **viz が Property Editor（`optionEditors.jsx`）を
//     import する**層違反が起きていた（`dosToField`）
//
// **SDK があれば、engine の内部構造は自由に変えられる**（SDK が緩衝材になる）。
// これが「あとから機能を足しやすい」の実体。
//
// ## 依存の向き（守るべき唯一の規則）
//
// ```
//   viz  ──依存──>  Viz SDK  ──依存──>  engine の内部
//   viz  ✗ engine の内部を直接見ない
//   viz  ✗ store / Builder（Inspector・Canvas）を見ない
// ```
//
// ⚠ **逆向きを作らない。** SDK が viz を import した瞬間に循環する。
//   SDK は「viz に配るもの」だけを持ち、viz を知らない。
//
// ## viz の契約（VizProps）
//
// viz は**props を受け取る React コンポーネント**。
// 形は `types.js` に JSDoc で定義してある（Studio 拡張と互換）。
//
// ⚠ **フックのルールを守る**（DPX で最頻の白紙バグ）。
//   データ有無で early return する viz で、フックを return の後に置くと
//   **データ到着の瞬間に落ちる**。コンソールにエラーが出ないこともある。
//   → `useVizData()` を**最初に**呼び、その戻り値で分岐する。
// ────────────────────────────────────────────────────────────────

// ── データ（サーチ結果の読み方）──────────────────────────────────
export { useVizData, normalizeVizData, EMPTY_VIZ_DATA } from './data';

// ── DOS 文字列（列を指すオプションの形式）────────────────────────
// ⚠ Property Editor ではなく **Data 層**から取る（層違反を避けるため）
export { dosToField, fieldToDos, isDos, toFieldNames } from '../data/dos';

// ── テーマ（配色）────────────────────────────────────────────────
export { useDpxTheme } from '../design';

// ── 色のルール（値 → 色）────────────────────────────────────────
export {
    colorForValue,
    defaultColorRules,
    labelForValue,
    pickTextColor,
    resolveColorRules,
} from './colorRules';

// ── 目盛り・軸 ──────────────────────────────────────────────────
export { formatAxisLabels, niceScale, niceTicks } from './scale';

// ── 時間（時間ブラシ・時刻の軸）──────────────────────────────────
export { axisTimes, formatSpan, rangeFromIndices } from './timeBrush';

// ── 描画の部品（ツールチップ・アニメ・ポインタ）──────────────────
export {
    VizTooltip,
    applyDrawIn,
    useCountUp,
    usePointer,
    useVizKitStyles,
} from './parts';

// ── トークン（入力・ドリルダウンで共有する値）────────────────────
export { applyTokens, useDpxTokens } from '../shared/tokens';

// ── viz 間の連携（ホバー同期など）────────────────────────────────
export { useVizHover } from '../shared/vizBus';

// ── Brush Engine（線と塗りの質感）────────────────────────────────
// ⚠ **使わなくてよい**。既定（flat）では `useBrush()` が null を返し、
//   従来の描画経路がそのまま通る。作り込みたい viz だけが使う。
export { BrushOverlay, BrushStrokes, seedFor, useBrush } from '../design/brush';

// ── 共通の小物 ──────────────────────────────────────────────────
export { EmptyHint, fmtNumber, toNum, useContainerSize } from './kit';
