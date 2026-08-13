// ── DPX ネイティブ viz ──────────────────────────────────────────
//
// **プラットフォーム標準のチャート群。** 外部チャートライブラリに依存せず
// SVG / DOM で描く。全て Viz SDK（`../`）だけを使って書かれている
// ＝**カスタム viz と同じ土俵**に乗っている（特権が無い）。
//
// | viz | データ規約 |
// |---|---|
// | `dpx.line`    | 1列目 = X（ラベル/時刻）、2列目以降 = 数値系列 |
// | `dpx.bar`     | 1列目 = ラベル、2列目 = 値 |
// | `dpx.ranking` | 1列目 = ラベル、2列目 = 値（降順） |
// | `dpx.donut`   | 1列目 = ラベル、2列目 = 値 |
// | `dpx.value`   | 最初の数値列（最終値＝現在値・直前値との差分） |
// | `dpx.status`  | 1列目 = 名前、2列目 = 状態、3列目 = 補足（任意） |
// | `dpx.table`   | 全列をそのまま表 |
//
// ⚠ **1 viz = 1 ファイル**。以前は 7 つで 2,516 行の 1 ファイルだった。
//   どこを直せばよいかが分からず、**別の viz を直してしまう事故**が起きた
//   （dpx.bar の横向きを dpx.ranking と取り違えた）。
// ────────────────────────────────────────────────────────────────

export { DpxLine } from './DpxLine';
export { DpxBar } from './DpxBar';
export { DpxValue } from './DpxValue';
export { DpxStatus } from './DpxStatus';
export { DpxTable } from './DpxTable';
export { DpxDonut } from './DpxDonut';
export { DpxRanking } from './DpxRanking';
