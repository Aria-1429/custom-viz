// ⚠⚠ **このファイルは自動生成です。手で編集しないでください。** ⚠⚠
//
// 生成: node tools/gen-viz-registry.mjs
// 検証: node tools/gen-viz-registry.mjs --check   （CI・再生成忘れの検出）
//
// **新しい Studio 拡張 viz を足したら、このスクリプトを 1 回走らせるだけ**で
// Component Palette / Property Editor / Renderer から使えるようになります。
// 条件は 2 つだけ:
//   1. `src/host.jsx` がある（⚠ エントリ `visualization.jsx` に export を書かない。
//      esbuild が ESM 出力になり Studio 実機でパネルが真っ黒になります）
//   2. `config.json` がある（optionsSchema / editorConfig をそのまま流用します）
//
// 現在 0 個の viz を登録しています。

import { adaptExtensionViz } from './extensionAdapter';



/** Studio 拡張 viz（iframe なしでホストしているもの）。 */
export const EXTENSION_VIZ = {

};
