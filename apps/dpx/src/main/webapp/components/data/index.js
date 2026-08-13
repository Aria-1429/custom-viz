// ── Splunk Data / Search Layer ──────────────────────────────────
//
// **サーチの実行と、その結果の運び方だけを担う層。**
// 他の層（Renderer / Builder / viz）は**このファイルだけを import する**。
//
// ```
// Splunk Data / Search Layer
// ├── useSplunkSearch … ジョブの投入・ポーリング・結果の取り出し
// ├── dataSources     … 共有データソースの解決（ref + postSearch）
// └── inputChoices    … 入力の選択肢をサーチで埋める
// ```
//
// ## この層の責務の境界
//
// **「SPL を投げて結果を返す」までがここ**。返した結果をどう描くかは viz、
// どのパネルがどのソースを使うかは Schema の担当。
//
// ⚠ **ここに描画の都合を持ち込まない。** 「この viz は列が2つ要る」のような
//   話は viz 側に置く（この層が viz を知ると、viz を足すたびここが太る）。
//
// ⚠ **絞り込みは `| where` を使う**（`| search` は 0 行になる。postSearch は
//   サブサーチではなく後続パイプなので `search` コマンドの意味が違う）。
// ────────────────────────────────────────────────────────────────

export { SearchAppContext, useSplunkSearch } from './useSplunkSearch';

export {
    getDataSources,
    migrateToDataSources,
    nextSourceId,
    panelsUsingSource,
    resolvePanelSearch,
} from './dataSources';

export {
    needsChoices,
    normalizeChoices,
    resolveChoiceSearch,
    useInputChoices,
    usesSearchChoices,
} from './inputChoices';
