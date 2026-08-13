// ── viz の契約（VizProps）───────────────────────────────────────
//
// **DPX の viz は「props を受け取る React コンポーネント」**、それだけ。
// クラスも継承も登録用の基底も要らない。
//
// ⚠ この形は **Studio 拡張の VizProps と互換**にしてある。
//   そのため既存の Studio 拡張 viz が `extensionAdapter` 経由で
//   **無改変のまま載る**（30 個が実際にそうなっている）。
//   形を変えるとその互換が壊れるので、変更は慎重に。
//
// ## 最小の viz
//
// ```jsx
// import { EmptyHint, useDpxTheme, useVizData } from './';
//
// export function MyViz({ dataSources, options = {}, height, loading }) {
//     const t = useDpxTheme();
//     const d = useVizData(dataSources);        // ⚠ 必ず先頭で呼ぶ
//     if (d.isEmpty) return <EmptyHint loading={loading} />;
//     return <div style={{ color: t.textColor }}>{d.rowCount} 行</div>;
// }
//
// MyViz.config = {
//     name: 'My Viz',
//     category: 'chart',
//     optionsSchema: { … },
//     editorConfig: [ … ],      // インスペクタのフォームが自動生成される
// };
// ```
//
// 登録は `vizRegistry.js` に 1 行。Studio 拡張 viz なら
// `tools/gen-viz-registry.mjs` が自動で拾う。
// ────────────────────────────────────────────────────────────────

/**
 * viz が受け取る props。
 *
 * @typedef {Object} VizProps
 * @property {Object}  dataSources    サーチ結果。`{primary: {data: {fields, columns}}}`
 *                                    ⚠ 直接掘らず `useVizData()` を通すこと
 * @property {boolean} loading        サーチ実行中
 * @property {Object}  options        ユーザーが設定したオプション
 *                                    ⚠ **既定値は載らない**（未設定キーは undefined）。
 *                                      既定は `optionsSchema` 側で持つか `??` で補う
 * @property {number}  width          パネルの幅(px)
 * @property {number=} height         パネルの高さ(px)。⚠ '100%' ではなく**数値**が来る
 * @property {'view'|'edit'} mode     表示モードか編集モードか
 * @property {string}  id             パネル ID（viz 間連携の宛先に使う）
 * @property {Function} onOptionsChange  viz の中から設定を変える（ドラッグでの位置調整など）
 * @property {Function} onEventTrigger   ドリルダウン（クリックの事実を送る）
 */

/**
 * viz の静的な定義（`MyViz.config`）。
 *
 * @typedef {Object} VizConfig
 * @property {string} name            表示名（viz ピッカーに出る）
 * @property {'chart'|'status'|'deco'|'shape'|'custom'} category
 * @property {Object=} optionsSchema  オプションの型と既定値
 * @property {Array=}  editorConfig   インスペクタのフォーム定義
 *                                    ⚠ **ラベルは日本語**（キー名は英語のまま）
 */

export const VIZ_CATEGORIES = ['chart', 'status', 'deco', 'shape', 'custom'];

/**
 * その値が viz として使える形か（登録時の検査に使う）。
 *
 * ⚠ **関数であることだけを見る**（React はクラスも関数も受け付ける）。
 *   厳密に判定しようとすると `React.memo` や `forwardRef` を弾いてしまう。
 */
export function isVizComponent(v) {
    return typeof v === 'function' || (v != null && typeof v === 'object' && 'render' in v);
}
