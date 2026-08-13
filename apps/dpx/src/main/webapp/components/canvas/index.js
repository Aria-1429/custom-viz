// ── Dashboard Canvas（編集の器）─────────────────────────────────
//
// Builder の 3 部品のうち「キャンバス」にあたる層。
//
// ```
// Dashboard Builder
// ├── Component Palette … VizPicker
// ├── Dashboard Canvas  … ここ
// └── Property Editor   … Inspector
// ```
//
// - `DashboardCanvas`        … ストアに繋がった Renderer（通常はこれを使う）
// - `useCanvasInteractions`  … ドラッグ・配置プレビュー・余白メニュー
//
// ⚠ **描画そのものは持たない**（Renderer = `DpxDashboard` の担当）。
// ────────────────────────────────────────────────────────────────

export { default as DashboardCanvas } from './DashboardCanvas';
export { useCanvasInteractions } from './useCanvasInteractions';
