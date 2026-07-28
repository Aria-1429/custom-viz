# Dashboard Studio 拡張 viz 実装ナレッジ

`/splunk-viz` スキルで作る **Dashboard Studio カスタムビジュアライゼーション拡張**の実装知見。
SKILL.md 本体から参照される。新規作成・改修の前に関連章を読むこと。

- リポジトリ：モノレポ `Aria-1429/custom-viz`（private / `main`）。各 viz は `visualizations/<name>/`。
  （2026-07-25 に直下の `custom-viz-*/` から移設。フォルダ名からは `custom-viz-` プレフィックスを外し、
  　Splunk のアプリ ID は従来どおり `custom_viz_<name>`。）
- push はユーザーが手動で行う（Claude は push しない）。
- 別系統（`@splunk/create` の独立アプリ＝Dashboard Framework）は [dashboard-framework.md](dashboard-framework.md) を参照。

---

## 0. 利用できる Splunk UI 公式パッケージ

Splunk UI（splunkui.splunk.com / Splunk Design System）が提供する npm パッケージ群。
バージョンは `npm view @splunk/<pkg> version` で確認できる（数値は目安）。

| パッケージ | 用途 | 拡張 viz 内で使うか |
|---|---|---|
| `@splunk/dashboard-studio-extension` | **カスタム viz 拡張 API**（hook / triggerDrilldown）。このプロジェクトの土台 | 必須 |
| `@splunk/react-ui` | Splunk デザイン言語の UI 部品 85 種（Button/Dropdown/Modal/Table/Slider/ComboBox/Color/Tooltip/Menu/Card/Switch/WaitSpinner 等） | **使える・推奨** |
| `@splunk/react-icons` | アイコン群 | 使える |
| `@splunk/themes` | テーマ変数・mixin（`SplunkThemeProvider` は viz ルートで使用済み） | 使う |
| `@splunk/visualizations` | 標準 viz 32 種（下記）＋ editor 型定義（`*.config.js`） | 参考/editor 調査用 |
| `@splunk/dashboard-core` / `-inputs` / `-presets` / `-context` | ダッシュボードの器・input・preset・状態 API | **Framework 専用**（拡張では使わない） |

- **`@splunk/react-ui` は拡張 viz 内でそのまま使える**。ツールチップ・ドロップダウン・スイッチ等は自前で
  書かず react-ui を使うとテーマ整合も取れる。UI 部品名の一覧: Accordion, Anchor, Avatar, Badge, Button,
  ButtonGroup, Calendar, Card, Checkbox, Chip, Code, CollapsiblePanel, Color, ComboBox, ControlGroup,
  Date, Divider, Drawer, Dropdown, DualListbox, File, Heading, Layer, List, Markdown, Menu, Message,
  MessageBar, Modal, Multiselect, Number, Paginator, Popover, Progress, RadioBar, RadioList, Search,
  Select, Slider, SplitButton, StepBar, Switch, TabBar, Table, Text, TextArea, Tooltip, Tree, TreeGrid,
  Typography, WaitSpinner ほか。
- **標準 viz 32 種**（`@splunk/visualizations`。作る前に「標準で足りるか」の判断材料）: Area, Bar, Bubble,
  ChoroplethSvg, Column, Events, FillerGauge, Image, Line, LinkGraph, Map, Markdown, MarkerGauge,
  NetworkGraph, ParallelCoordinates, Pie, ProcessTree, Punchcard, RichText, Sankey, Scatter, SingleValue,
  SingleValueBasic, SingleValueIcon, SingleValueRadial, SparkLine, Table, Timeline, Treemap ほか。
- `@splunk/dashboard-inputs` の標準 input: text / select / multiselect / number / button / time range。
  カスタム input UI は拡張では作れず Framework 側のみ（[dashboard-framework.md](dashboard-framework.md)）。

---

## 1. プロジェクト構成とスキャフォールド

各 viz は独立フォルダ `visualizations/<name>/`。CLI でベースを作れる:

```bash
npx @splunk/create@latest --mode=dashboard-studio-extension
```

CLI が生成する JavaScript テンプレートはそのまま使わず、実績のある **React + useOptions
スケルトン**（既存 viz、例 `visualizations/donut-graph`）を複製して流用する。CLI を非対話実行する
場合は inquirer が改行を取りこぼすので遅延付きで流し込む:

```bash
( for i in $(seq 1 8); do printf '\n'; sleep 2; done ) | \
  timeout 300 npx @splunk/create@latest --mode=dashboard-studio-extension
```

### スケルトン複製の手順（cp を使う）

```bash
cd <リポジトリルート>/visualizations
mkdir -p <new>
cd <base>   # 例: donut-graph（React+useOptions版）
cp -r build-plugins build.mjs package.mjs package.json yarn.lock .gitignore README.md package \
      ../<new>/
mkdir -p ../<new>/visualizations/custom_viz_<new>/src/assets
cp visualizations/custom_viz_<base>/src/assets/*.svg ../<new>/visualizations/custom_viz_<new>/src/assets/
cp visualizations/custom_viz_<base>/src/visualization.css ../<new>/visualizations/custom_viz_<new>/src/
mv ../<new>/visualizations/custom_viz_<base> ../<new>/visualizations/custom_viz_<new>
```

### 複製後に必ず置換する識別子

- `package.json` … `"name"`, `"description"`
- `package/app/app.conf` … `[package] id`, `[id] name`, `[ui] label`, `[launcher] description`
- `visualizations/custom_viz_<new>/config.json` … `config.name`, `config.description`, `optionsSchema`, `editorConfig`
- `README.md` … タイトル・特徴・サンプルSPL
- `visualizations/custom_viz_<new>/src/visualization.jsx` … 実装本体

ディレクトリ構成（重要ファイル）:
```
visualizations/<name>/
├── build.mjs / package.mjs / build-plugins/css-and-size.mjs   # esbuild ビルド & .spl パッケージ
├── package/app/app.conf                                        # Splunkアプリ定義（id, version, label…）
├── package/metadata/default.meta                               # _vizName_ プレースホルダのまま流用可
└── visualizations/custom_viz_<name>/
    ├── config.json         # showTitleAndDescription, dataContract, optionsSchema, editorConfig, defaultContext
    └── src/
        ├── visualization.jsx   # 実装本体
        ├── visualization.css   # 原則いじらない（.viz-container 等の共通クラス）
        └── assets/*.svg
```

### ビルド & パッケージ

```bash
yarn install
yarn build          # dist/<viz>/visualization.js を生成（esbuild, jsx automatic）
yarn package        # dist/<viz>-<ver>-<hash>.spl を生成（stage/ 経由で tar.gz）
```

- パッケージ化のたびに **バージョンを上げる**（`package.json` と `package/app/app.conf` 両方）:
  `npm version minor --no-git-tag-version` → app.conf の `version = x.y.z` を sed で同期。
- **旧版の `.spl` は残す**。`rm -f dist/*.spl` はしない（ファイル名にバージョン＋ハッシュが入るので判別可）。
- **`yarn build` は `.spl` を消さないこと**。`build.mjs` は非 watch ビルド時に `dist/` を掃除するが、
  `.spl` は温存し、`dist/` 直下のビルド成果物（`<viz>/` や `.map`）だけ削除する形にする。
  複製元が古いと `dist/` 丸ごと削除になり `.spl` を巻き添えにするので、複製後に必ず確認する:
  ```js
  if (!isWatch && existsSync(distDir)) {
      for (const entry of readdirSync(distDir)) {
          if (entry.endsWith('.spl')) continue;          // .spl は残す
          rmSync(join(distDir, entry), { recursive: true, force: true });
      }
  }
  ```

### 実機に反映されないときの切り分け

- **リバースプロキシ（Cloudflare トンネル）のキャッシュが第一容疑**。トンネル経由だと
  アップグレード＋`_bump`＋ハードリロードをしても旧 `visualization.js` が配信され続けることがある。
  反映確認はまず直接 IP アクセスで行い、トンネル側は Cloudflare のキャッシュパージで対処する。
- バンドル内の日本語は esbuild が `\uXXXX` 形式（大文字hex）にエスケープするため、**日本語文字列の
  grep では新旧バンドルを判定できない**。ASCII の識別子や `VIZ_VERSION` 文字列で判定する。viz 側に
  バージョン定数を入れて UI/debug に出しておくと実機での反映確認が一目でできる。

---

## 2. 実装の定番パターン（visualization.jsx）

### ルート構成（マウントゲート必須）

カスタム viz はサンドボックス iframe で動き、テーマ/データ等の状態は親から postMessage で
非同期に届く。公式 React フックは「`getX()` でシード → `useEffect` で購読」だが**購読登録時に
現在値を再送しない**ため、初期 state をマウント後〜購読前に取り逃すと `useTheme()` 等が
**undefined のまま永久に描画されない**ことがある。対策は「**初期 state が揃ってからマウントする**」
マウントゲート。公式構成（import/Provider/フック）はそのまま維持できる。正常時の表示遅延は最大 +50ms。

```jsx
import {
  VisualizationExtensionProvider, useDataSources, useTheme, useOptions,
} from '@splunk/dashboard-studio-extension/react';
import { SplunkThemeProvider } from '@splunk/themes';
import { createRoot } from 'react-dom/client';

function App() {
  const themeApi = useTheme();
  const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
  const mode = colorScheme === 'dark' ? 'dark' : 'light';
  return (
    <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
      <MyVisualization mode={mode} />
    </SplunkThemeProvider>
  );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。最大5秒でフォールバック描画に入る。
const MOUNT_START = Date.now();

function hostReady() {
  try {
    const api = globalThis.DashboardExtensionAPI;
    return Boolean(api && api.getTheme()?.theme && api.getDataSources());
  } catch (e) {
    return false;
  }
}

function mountApp() {
  const rootElement = document.getElementById('root') || document.body;
  createRoot(rootElement).render(
    <VisualizationExtensionProvider><App /></VisualizationExtensionProvider>
  );
}

(function mountWhenReady() {
  if (hostReady() || Date.now() - MOUNT_START >= 5000) {
    mountApp();
  } else {
    setTimeout(mountWhenReady, 50);
  }
})();
```

- ゲートが待つのは**ハンドシェイク完了**（state の容れ物）であってサーチ完了ではない。
  `getDataSources()` は接続確立時点で `{loading:true}` を返すので、スピナー→本描画の流れは従来どおり。
- テーマは `themeApi?.theme || 'light'` でフォールバックし、未取得でも必ず描画する。
  `return null` で永久に待つガードは書かない。
- 残余リスク: API 注入前にバンドルが実行されるとライブラリのモジュール評価が throw する
  （コンソールに "DashboardExtensionAPI is not available..."）。

### データ正規化（rows / columns 両形式に対応・落とさない）

> **`data.rows` だけ見る実装は必ず壊れる。** 実機では `columns` 形式で届くことがあり、
> その場合 rows は空なので**「サーチを紐づけているのに 0 行」**という症状になる
> （2026-07-25 に検証用 viz でやらかした）。下記の `normalizeData()` を必ず通すこと。

```jsx
function normalizeData(data) {
  try {
    if (data.rows && data.rows.length > 0) return data.rows;
    if (data.columns && data.columns.length > 0) {
      const n = data.columns[0].length;
      return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
    }
  } catch (e) { /* 想定外形式でも落とさない */ }
  return [];
}
// フィールド名: (data?.fields || []).map((f) => f?.name || f)
```

### 堅牢性チェックリスト

- `loading` 中はスピナー、`!data || rows.length===0` はデータなしメッセージ。
  **文言は全 viz 共通で「データがありません。サーチ結果を確認してください。」に統一する**
  （ダッシュボードに複数 viz を並べたとき、サーチ未設定の空パネルが揃った見た目になる）。
  データ形式の案内が要る場合は、この文言を本文に置き、副文（`opacity:0.7` / `fontSize:12` 程度）で添える。
  例外は link-line のみ（データが無くても線をニュートラル色で描き続ける仕様）。
- 数値は `Number(String(v).replace(/,/g,'').trim())` で正規化し `Number.isFinite` ガード。
- オプションは必ず `normalizeOptions(options)` で型・範囲を安全側に補正（未設定/型不一致に耐える）。
- 幅・高さは ResizeObserver でコンテナ実寸を測って自動フィット。非対応環境では初回計測にフォールバック。

### アニメーション viz（物理シミュレーション・パーティクル等）のハイブリッド描画

60fps の位置更新を React の再レンダリングでやると持たないので、**役割を属性単位で分離**する:

- **React(JSX)**: 構造・色・太さ・不透明度など「データ/オプション変更時にだけ変わるもの」。
- **rAF ループ**: `transform` / `d` / `cx,cy` など位置系の属性を `setAttribute` で直接更新。
  要素は callback ref で `Map<id, element>` に収集。React と同じ属性を触らないのが規約。
- ループは mount 時に 1 回だけ張り、設定・シム状態はすべて ref（`optsRef.current = opts` を
  毎レンダー代入）経由で読む → stale closure を回避。
- 初期配置はノード名ハッシュをシードにした mulberry32 で決定的に。初回は数十ステップ同期で
  「ならして」から画面に出すと初期の暴れが見えない。データ更新時は旧位置を id で引き継ぎ alpha を再加熱。
- **ガード表示→本表示の切替**があるため、`useEffect([])` で `ref.current` を掴むとガード時の要素を
  掴んだままになる。ResizeObserver は callback ref で張り直し、native リスナー（wheel の
  passive:false 等）は「本表示がマウントされているか」の boolean を deps に入れて張り直す。
- **力学レイアウトの定数は固定値にしない**：反発・リンク距離は `√(面積/ノード数)` ベースで面積
  スケールし、中心重力は弱く（0.01x）。画面いっぱいの利用は「カメラ自動フィット」（ノード bbox へ
  view transform を easing 追従、手動ズーム/パンで解除・dblclick で復帰）が担う。ラベル高さを
  衝突半径に足すとラベル同士の重なりも減る。
- ソースに生の NUL 文字（`\x00`）を入れない（grep がバイナリ扱いする）。`'\u0000'` エスケープで書く。
- **rAF ループが管理する要素グループを掴む callback ref は必ず `useCallback([])` で安定化する**。
  インライン関数だと再レンダーのたびに ref を detach(null)→attach し直し、プールをリセットすると
  古い要素が DOM に孤児として残る（症状: オプション変更後も古い色/位置のパーティクルが凍結表示）。
  attach 時に `while (el.firstChild) el.removeChild(...)` で子を掃除しておくと切替にも安全。

### オートフィット（余白を残さない）

コンテナ実寸 `clientWidth/clientHeight` を測り、要素サイズを動的計算して領域いっぱいに広げる。
「編集画面でパネルを大きくすると下に大きな余白」が出たら固定サイズ設計が原因。上限だけ
オプション化（例 `maxCellSize`, `0 = 無制限`）し、既定は自動。

### ラベルの見切れ防止

ラベル余白を「面積の固定比率」で取ると長い名前が見切れる。**実ラベルの推定幅から余白を計算**する:

- 推定幅: CJK ≈ 1.0×fontSize、その他 ≈ 0.62×fontSize（`codePointAt > 0x2e7f` で判定）。
  SVG に measureText は無いがこの推定で実用十分。
- 余白 = clamp(最長ラベル推定幅 + マージン, 下限, 面積の~28%)。収まらないときは段階退避:
  **値の併記を自動オフ → 名前を … で切り詰め → ラベル自体を自動非表示（ツールチップで代替）**。
  本体（リング等）の描画を常に優先し「Panel too small」は最終手段。
- 切り詰め・表示可否は layout メモ内で確定し、描画側はその結果を使う（判定の二重化を避ける）。
- happy-dom 検証でリサイズを試すには、寸法を `let VW/VH` + configurable getter にし、
  ResizeObserver インスタンスを配列に集めて手動 flush する `resize(w,h)` ヘルパを作る。

---

## 3. editorConfig（編集画面の右パネル）と editor 型

`config.json > config.editorConfig` は「セクション > layout > 行 > editor項目」の入れ子。
各項目は `{ label, option, editor, editorProps?, context? }`。`optionsSchema` に対応する option の
`default` を必ず定義し、viz 側は `useOptions()` で受け取る。

**ラベルは日本語で書く**（セクション `label`・項目 `label` とも。config.json は UTF-8 の日本語を
そのまま書ける）。キー名（`option` / `optionsSchema`）は英語のまま。訳語の目安:
Data Fields→データフィールド、Display→表示、Show ~→「~を表示」、severity→深刻度、
count→件数、source/destination→送信元/宛先。

### 使える editor 型

`@splunk/visualizations` の全 `*.config.js` を require して walk した結果、**標準 viz が使っている
editor 型は 28 種**（2026-07-25 調査。2026-07-28 に v28.8.0 の一次ソースで再現・件数まで一致）。
標準 viz での採用数が多いものほど素性が確か。

> ⚠ **【重要な訂正】この 28 種は「実在する editor 型の全部」ではない**（2026-07-28 確認）。
> 一次ソースを調べ直した結果、**この数字が上限である保証は無い**ことが分かった:
>
> - `@splunk/visualizations` は**標準 viz の定義集であって、有効な editor 型のレジストリではない**。
>   28 種は「**標準 viz がたまたま使っている型**」を数えたものにすぎない。
> - **有効／無効を判定しているホスト側のコード（`Invalid editor type` を出す実体）は、
>   ローカルの node_modules のどこにも無い**。Splunk Web 側にあり、手元から列挙できない。
>   `visualization-schemas` 等の兄弟パッケージ7つを全て調べたが、editor 型の定義は**0件**。
>   `.d.ts` にも `docs-llm/` にも editor 型の union 定義は**存在しない**。
> - **反証が実在する**：`editor.arrayOfStrings` は `LinkGraph.config.js` の
>   **コメントアウトされたブロックの中にしか出てこない**（＝標準 viz は誰も使っていない）のに、
>   実機では正常に動作し値も届く。**「標準 viz が使っていない＝存在しない」は成り立たない。**
>
> 従って正しい言い方は「**実在する型は 28 種**」ではなく
> 「**28 種は動作確認済み。それ以外に未知の型が存在する可能性は否定できない**」。
> 未知の型を探すには、名前を推測して Editor Probe で1つずつ試すしかない
> （`Invalid editor type` が出れば無効、UI が出れば有効、という判定は実機でのみ可能）。
>
> なお `editor:` の値が変数・ファクトリ関数になっている箇所は**全パッケージで0件**（全て文字列リテラル）
> なので、**「このパッケージ内に grep で見逃した型がある」可能性は排除できている**。
> 見えていないのは「パッケージ外の型」だけ。

| editor 型 | 採用 viz 数 | editorProps の要点 | カスタム viz での評価 |
|---|---|---|---|
| `editor.color` | 26 | `{labelPosition, themes:{}}` | **確実（実機確認済み）** |
| `editor.number` | 23 | `{min, max}` | **確実（実機確認済み）** |
| `editor.select` | 20 | `{values:[{label,value},…]}` | **確実（実機確認済み）** |
| `editor.columnSelector` | 19 | `{dataSourceKey:'primary', supportsDSL, expectedDataPrimitive}` | **確実**（ただし DOS 文字列で届く→§3 後述） |
| `editor.toggle` | 18 | `{help, helpFormat}` | **確実（実機確認済み）** |
| `editor.radioBar` | 18 | `{values:[{label,value},…]}` | **確実（実機確認済み）** |
| `editor.checkbox` | 16 | なし | **確実（実機確認済み）** |
| `editor.text` | 15 | `{tooltip}` | **確実（実機確認済み）** |
| `editor.slider` | 6 | `{min, max, step}` | **確実（実機確認済み）**。UI 値がそのまま届く |
| `editor.percent` | 4 | `{min}` | **確実（実機確認済み）**。⚠ **UI 値の 1/100 が届く**（下記） |
| `editor.threshold` | 1 | `{openRanges, isTogglable}` | **確実（実機確認済み）**。⭐ **`[{from,to,value}]` の配列が生で届く**（→ §4） |
| `editor.arrayOfStrings` | 0（コメントのみ） | `{themes, labelPosition}` | **確実（実機確認済み）**。チップ形式の文字列リスト。`["a","b"]` が届く |
| `editor.markdown` | 1 | なし | **確実（実機確認済み）**。ツールバー付きエディタ。**Markdown 原文の文字列**が届く（描画は viz 側） |
| `editor.image` | 2 | `{validMediaTypes:['svg'], svgRenderAsDom}` | **△ 動くが実用不可**。届くのは `splunk-enterprise-kvstore://<id>` という**URI で画像本体ではない**。拡張 iframe から解決できないため、同梱アセットか `editor.text` で data URI を貼る方が現実的 |
| `editor.columnMultiSelectionByFieldNameEditor` | 8 | なし | **確実（実機確認済み）**。⭐ **生のフィールド名配列**（`["_time","category"]`）が届く。複数フィールド選択はこれ一択 |
| `editor.seriesColorsByField` | 6 | なし | **確実（実機確認済み）**。`{"_time":"#7B56DB",…}` のオブジェクトが届く |
| `editor.tableBackgroundColor` | 1 | `{themes, palette:[…]}` | **△ 使えるが要注意**。`option` ではなく **`key`** が必要。書き込み先は**固定キー `backgroundColor`**（`key` の値は使われない） |
| `editor.marks` / `editor.seriesLineTypes` / `editor.seriesLineTypesByField` | — | — | **× 使用不可（実機確認済み）**。`Invalid editor type` で editorConfig 全体が消える。`seriesColors` は動くのに LineTypes 系は動かない＝**系統名で判断できない** |
| `editor.tableDynamicColor` | 1 | — | **× 使用不可（実機確認済み）**。`option` 名を無視して固定キー `tableFormat` に DOS 式を書き、**編集パネルが操作不能になる**。Table 専用 |
| `editor.tableColumnFormatter` | 1 | — | **× 採用しない**（未検証）。`option`/`key` を持たない Table 専用型。`tableDynamicColor` と同様に危険 |
| `editor.operations` / `editor.children` / `editor.isInline` / `editor.onChange` / `editor.insertText` | — | — | **実在しない**（Slate.js 由来の grep 誤検出。クォート付き grep では出てこない） |
| `editor.seriesColors` | 10 | なし | **確実（実機確認済み）**。プリセット選択＋色スウォッチ列。`["#7B56DB",…]` が生で届く |
| `editor.presetSelector` | 6 | `{presets:[{label,name,value:{context,options}}]}` | **確実（実機確認済み）**。`option` を持たず、選んだ preset の `value.options` が options に流れる（複数オプションの一括切替に使える） |
| `editor.trellisSplitBy` | 11 | `{dataSourceKey:'primary'}` | **確実（実機確認済み）**。生のフィールド名（`"count"`）が届く |
| `editor.columnMultiSelector` | 5 | `{dataSourceKey, filterByTypes}` | **△ DOS 文字列で届く**（`> primary \| frameBySeriesNames('a','b')`）。パースすれば使える |
| `editor.dynamicColor` / `editor.dynamicColorWithPrecedence` / `editor.networkGraphDynamicColor` / `editor.tableDynamicColor` / `editor.seriesColorsByField` / `editor.tableColumnFormatter` / `editor.tableBackgroundColor` / `editor.columnMultiSelectionByFieldNameEditor` | 3〜8 | `context` + DOS 前提 | **× 使えない見込み**（`dynamicColor` のみ実証済み）。`option` の中身が DOS 式（`> value \| rangeValue(...)`）になる型は届かない → §4 |

**選定の原則**（2026-07-25 に**実在候補 28 種を全数実機検証**して確定。20種が使える）:

> - **ほとんどの型は素の値／配列／オブジェクトがそのまま options に届く**
> - **DOS 文字列になるのは 2 系統だけ**：
>   ① データソースの列を指す型（`columnSelector` / `columnMultiSelector`）… パースすれば使える
>   ② `dynamicColor` 系（`option` の中身が `> value | rangeValue(...)` になる）… 使えない（→ §4）
> - **Table 専用型は `option` を無視して固定キーに書く**。
>   `tableBackgroundColor` は `key` 指定で使えるが書き込み先は `backgroundColor` 固定。
>   **`tableDynamicColor` / `tableColumnFormatter` は編集パネルを操作不能にするので入れない**
> - **系統名で可否を判断しない**。`seriesColors` は動くが `seriesLineTypes` は使用不可。
>   `arrayOfStrings` は標準 viz が使っていない（コメントアウトのみ）が動く。

**旧記述の誤り（訂正）**：以前は「`context` を使う型は全部届かない」と書いていたが**誤り**。
`editor.seriesColors` は `context` を使う型だが**配列が生で届く**（実機確認済み）。
`dynamicColor` が届かないのは `context` のせいではなく、`option` に DOS 式が入るため。

#### `context` は viz から読めない（2026-07-25 実機確認済み）

`dynamicColor` 系はダッシュボード定義の `context` に**範囲配列を生で保存している**:
```json
"context": { "<option名>EditorConfig": [{ "from": 20, "to": 40, "value": "#D94E17" }, …] }
```
「これを viz から読めれば dynamicColor 系も使えるのでは」を実機で検証したが、**読めない**。
拡張 API がホストから受け取れるのは以下 **19 個だけ**で、`context` を取る手段は存在しない
（API オブジェクトをプロトタイプチェーンごと総なめして確認済み）:

```
getDataSources / getOptions / getTheme / getDimensions / getMode / getTokens / getError
addDataSourcesListener / addOptionsListener / addThemeListener / addDimensionsListener /
addModeListener / addTokensListener / addErrorListener / addDrilldownListener
setOptions / setError / clearError / triggerDrilldown
```

→ **`option` に DOS 式が入り、実データが `context` にしか無い型は原理的に使えない。**
範囲→色をやりたいなら `editor.threshold`（`option` に配列が直接入る）を使う。

#### ⚠ `editor.percent` は UI 値の 1/100 が届く（2026-07-25 実機確認）

編集パネルに `5` と入力すると、viz には **`0.05`** が来る（`editor.slider` は `0.42` がそのまま来る）。

```
editor.percent : UI「5」   → options: 0.05   ← 比率。viz 側で ×100 しない
editor.slider  : UI「0.42」→ options: 0.42   ← そのまま
```

- 「%」で見せたいが**内部は比率**として扱う設計。`opacity` などにはそのまま渡せて都合がよい。
- **既存の「%で持つ」オプション（例 `bgOpacity: 0〜100`）を `editor.percent` に移行すると値が
  1/100 になる**ので、viz 側の計算を必ず見直すこと。移行しないなら `editor.number` のままでよい。

#### `editor.seriesColors`（色パレット）と `editor.presetSelector`（一括切替）

どちらも実機確認済み。標準 viz と同じ UI がそのまま使える。

```json
// 系列色パレット。プリセット選択＋色スウォッチ列の UI が出る
[{ "label": "系列の色", "editor": "editor.seriesColors", "option": "seriesColors" }]
// → viz には ["#7B56DB", "#009CEB", "#00CDAF"] が生で届く
```
```json
// 複数オプションを一括で切り替えるプリセット。option は持たない
[{ "label": "配色プリセット", "editor": "editor.presetSelector",
   "editorProps": { "presets": [
     { "label": "標準", "name": "p.default", "value": { "context": {}, "options": { "accentColor": "#22d3ee", "useGlow": true } } },
     { "label": "警告", "name": "p.alert",   "value": { "context": {}, "options": { "accentColor": "#f85149", "useGlow": false } } }
   ] } }]
// → 選ぶと value.options のキーがまとめて options に反映される
```

`editor.trellisSplitBy` も**生のフィールド名**（`"count"`）が届くので、
「1フィールドを選ばせたい」用途では `columnSelector`（DOS 文字列でパースが要る）より扱いやすい。

#### optionsSchema は `anyOf` ＋ DOS 文字列パターンで書く（2026-07-25 実機で判明）

**標準 viz の optionsSchema は素の `"type"` を使っていない。** 必ず次の形をとる:

```json
"seriesColors": {
  "default": ["#7B56DB", "#009CEB"],
  "anyOf": [
    { "type": "array", "items": { "type": "string" } },
    { "type": "string", "pattern": "^>.*" }        ← DOS 文字列も許容する
  ]
}
```

理由は、**どのオプションにも DOS 文字列（`> primary | ...`）が入りうる**ため。`"type": "string"` と
書き切ると、ユーザーが値を設定した瞬間にダッシュボードの保存時検証で落ちる:

```
/visualizations/viz_XXXX/options/p_arrayOfStrings: must be string
/visualizations/viz_XXXX: must match "then" schema
```

これは**editor 型が無効なのではなく、こちらの型宣言と実際の値の不一致**。エラーメッセージに
option 名が出るので、その option の `optionsSchema` を疑う。

- 単純な型（`editor.checkbox` の boolean 等）は素の `"type"` でも実用上は動いている（既存 viz が実績）。
- ただし**配列やオブジェクトを返す editor 型**（`threshold`・`seriesColors`・`columnMultiSelector` 等）は
  必ず `anyOf` で正確に書く。`"type": "string"` のままだと確実に落ちる。
- 迷ったら標準 viz の同じ editor 型の定義をコピーする（`<Viz>.config.js` の `optionsSchema`）。

#### options には optionsSchema に無いキーも来る

ホストが `backgroundColor: "transparent"` などを勝手に載せてくる（実機で確認）。
**viz 側は未知のキーを無視する作り**にしておく（`normalizeOptions` で必要なキーだけ拾う既存パターンでOK）。

- **調べ方**（再現手順）:
  ```bash
  npm install @splunk/visualizations   # スクラッチ領域で。プロジェクトには入れない
  # ざっと候補を洗う（誤検出込み。Slate.js の editor.marks なども混じる）
  grep -rhoE "editor\.[a-zA-Z0-9]+" node_modules/@splunk | sort | uniq -c | sort -rn
  # 実際に標準 viz で使われている型と editorProps / optionsSchema の正しい書き方を見る
  # → 各 .config.js を require() して editorConfig を再帰 walk し、
  #   node.editor が 'editor.' 始まりのノードから label/option/context/editorProps を集める
  ```

  **【重要】この静的解析で分かるのは「標準 viz が使っているか」だけ。「型が実在するか」は分からない。**
  `@splunk/visualizations` は**標準 viz の定義集**であって、**editor 実装のレジストリではない**
  （editor 本体はダッシュボード編集画面側のバンドルにあり、このパッケージには入っていない）。

  実例（2026-07-25 にやらかした誤判定）:
  - `editor.arrayOfStrings` は `LinkGraph.config.js` に**コメントアウトでしか出てこない**ため
    「実在しない」と判断した。→ **誤り。実機では UI が出て配列も届いた**。
  - 一方 `editor.marks` は実機で `Invalid editor type` になった（本当に無い）。
  - **静的解析だけでは両者を区別できない。可否は実機で確かめるしかない。**

  → 採用数 0 の型を「使えない」と決めつけない。**使えるかどうかは実機検証がすべて**。

### 選択肢は `editor.select` / `editor.radioBar` を使う（数値コード化しない）

**このリポジトリの全 viz は checkbox / color / number / columnSelector の4種だけで組まれており、
`editor.select` を1つも使っていない**（2026-07-25 時点）。そのため列挙型のオプションが
「数値コード」や「チェックボックス複数」で代用され、UI が分かりにくくなっている箇所がある。
新規・改修では下記に従う。

```json
// editorConfig：3つ以上の選択肢はドロップダウン
[{ "label": "判定モード", "editor": "editor.select", "option": "matchMode",
   "editorProps": { "values": [
     { "label": "自動",         "value": "auto" },
     { "label": "数値しきい値", "value": "numeric" },
     { "label": "文字列一致",   "value": "string" }
   ] } }]

// 2〜4択で常時見せたいなら radioBar（同じ editorProps.values 形状）
[{ "label": "並び順", "editor": "editor.radioBar", "option": "sortMode",
   "editorProps": { "values": [
     { "label": "検索結果順", "value": "none" },
     { "label": "最大値順",   "value": "peak" },
     { "label": "合計順",     "value": "total" }
   ] } }]
```
```json
// optionsSchema は文字列型にする（数値コードにしない）
"matchMode": { "type": "string", "default": "auto" }
```
```js
// viz 側：未知値は既定へ丸める（旧バージョンの数値が残っていても壊れないように）
const MATCH_MODES = ['auto', 'numeric', 'string'];
const matchMode = MATCH_MODES.includes(o.matchMode) ? o.matchMode : 'auto';
```

**アンチパターン**（実在した例）:

| 悪い例 | 何が問題か | 直し方 |
|---|---|---|
| `「判定モード（0=自動 / 1=数値 / 2=文字列）」` を `editor.number` | ユーザーが数字の意味を覚える必要がある。範囲外の値も入力できる | `editor.select` + 文字列 value |
| `sortByPeak` + `sortByTotal` の checkbox 2つ | **両方ONが未定義動作**（コードは `if/else if` で片方が黙って勝つ）。UI 上は両方チェックできてしまう | 1つの `editor.select`（`none`/`peak`/`total`） |
| `sortByValue` + `sortAscending` の checkbox 2つ | 「並べ替える」OFF時に「昇順」が無意味に残る（依存関係が UI に出ない） | `editor.select`（`none`/`asc`/`desc`）に統合 |

**checkbox のままでよいもの**: `sortRowsByTotal` と `sortColsByTotal` のように**独立して ON/OFF
できる**もの。排他かどうかで判断する。

**「0＝特別値」の数値は数値のままでよい**（`maxCellSize`（0=無制限）、`labelWidth`（0=自動）など）。
選択肢ではなく連続量なので `editor.number` が正しい。

> **`editor.select` は実機確認済み**（2026-07-25、kpi-tile v1.3.0）。編集画面にドロップダウンとして
> 正しく表示され、選択値も `useOptions()` に届く。セクションが消える症状も出ない。
> `editor.radioBar` は同じ `editorProps.values` 形状なので通る見込みだが未検証。

### 【重要】既定値と同じ値は options に載らない（旧オプション読み替えの罠）

**ホストは `optionsSchema` の `default` と同じ値を options に載せないことがある。**
ユーザーが既定値を選ぶと、その option は options から**消える**（未設定と区別できない）。

このため、**旧オプションへフォールバックする「後方互換」実装を書いてはいけない**:

```js
// ❌ やってはいけない
function resolveIconName(raw) {
    if (isValid(raw.iconName)) return raw.iconName;
    if (Number.isFinite(raw.iconIndex)) return ICONS[raw.iconIndex - 1].name; // ← 旧値が復活する
    return DEFAULTS.iconName;
}
// ✅ 正しい：新オプションだけ見て、無ければ既定値へ倒す
function resolveIconName(raw) {
    return isValid(raw.iconName) ? raw.iconName : DEFAULTS.iconName;
}
```

症状は**「既定値を選んだときだけ直らない」**という分かりにくい形で出る。実例（kpi-tile v1.3.0 開発中）:
旧 `iconIndex:3`(警告) が残ったダッシュボードでドロップダウンから既定値の「シールド」を選ぶと、
`iconName` が options に載らず → 旧 `iconIndex` が読まれて**警告アイコンのまま**になった。
既定値以外（稲妻など）を選んだときは正常に動くため、テストでも見落としやすい。

→ **オプションのキー名を変えるときは読み替えを諦め、既定値に戻す**。README に「この設定は既定値に
戻るので選び直してください」と書くのが正しい。ローカル検証では「旧キーだけがある options」を
食わせて、**旧値が漏れてこないこと**を回帰テストにする。

### ドリルダウン用の editor 型は存在しない

`editor.drilldown` のような型は 25 種のどこにも無く、標準 viz の editorConfig にも drilldown 項目は無い。
ドリルダウン（＝「インタラクション」）は editorConfig とは**別レイヤー**の仕組み → §5 を参照。

### 無効な editor を混ぜたときの症状（2026-07-25 実機で確定）

**未対応の editor 型を1つでも入れると、editorConfig 全体が出なくなる。**
セクション単位ではなく**全滅**する（他のセクションも、確実に動く `editor.checkbox` だけの
セクションも、まとめて消える）。標準の「全般 / データソース / 可視性 / 位置とサイズ」だけが残る。

**ただし原因の型名は表示される。** 設定パネル下部に赤い警告アイコンとともに

```
⚠ Invalid editor type: editor.marks
```

と**最初に見つかった無効な型の名前が1つだけ**出る。これが唯一の手がかり。

→ **「独立セクションに隔離すれば1つずつ切り分けられる」は誤り**（この前提でプローブを作って
失敗した）。全滅するので隔離しても無意味。正しい切り分け方は次のどちらか:

1. **エラーメッセージを読んで1つずつ消す**。表示されるのは1つだけなので、消して再デプロイ →
   次の型名が出る → また消す、の反復。確実だが `_bump`＋リロードを型の数だけ繰り返す。
2. **二分探索**。候補を半分ずつ入れて、パネルが出るか出ないかで絞る。デプロイ回数は
   log2 で済むが、どの型が原因かはエラーメッセージの方が速い。

**実務上の結論**：未検証の editor 型は**1つずつ追加して確認する**。まとめて入れると
全滅したうえに、エラーは最初の1つしか出ないため何個ダメなのか分からない。

### フィールド選択 UI（editor.columnSelector）

標準 viz の「データ設定」（ラベル/値のフィールド選択ドロップダウン）は `editor.columnSelector`。
標準 Pie の定義形状をそのまま真似る（`@splunk/visualizations/Pie.config.js` で確認）:
```json
[{ "label": "Source field", "editor": "editor.columnSelector", "option": "sourceField",
   "context": "valuesContext", "editorProps": { "dataSourceKey": "primary" } }]
```
- 選択結果はオプションに **DOS 文字列**（`> primary | seriesByName('src')`）で書かれ、カスタム viz
  には未解決のまま届く。**`seriesByName('X')` / `seriesByIndex(N)` を正規表現でパース**して列を自前解決する。
- 生フィールド名・ホスト解決済み配列（列内容の照合で特定）・未設定（既定列にフォールバック）も受けると
  全ケースで壊れない。optionsSchema は `{ "type": "string", "default": "" }`。
- 参照実装: chord-flow の `resolveFieldIndex()`。

### 編集モード中は viz 内のマウス操作 UI が効かない（iframe への入力遮断）

Studio 編集モードのイベント設計:
- パネル移動はホバー時に上部中央へ出るピル型ドラッグハンドルから（`useDragHandleComponent`,
  `EVENT_MOUSE_DOWN_ON_HANDLE` でのみ `isMovingRef=true`）。
- **viz 本体への mousedown はパネル選択に消費**される（`SelectableContainer.onMouseDown` →
  `EVENT_MOUSE_DOWN_ON_VIZ_WITH_HANDLE`）。これを iframe 拡張 viz でも成立させるため、編集モード中は
  ホストが拡張 iframe への入力を遮断する。
- → **編集モード中に viz 内へ描いたクリック/ドラッグ UI（アイコンピッカー・編集ハンドル等）は実機では
  動かない**。
- 対策:「**表示モードで操作 → 変更を viz 内 pending に保持 → mode が edit に変わった瞬間に setOptions を
  再送(flush) → ユーザーが保存**」。モード変化イベントは iframe に届き続ける（iframe は view↔edit で
  生存する）ため flush が成立する。echo（opts が pending と一致）で消し込み、再送は未反映分のみ1回。
  表示モード中の見た目はローカル draft でライブプレビューする（**表示モードの setOptions はホスト定義に
  載らない**ため）。参照実装: link-line の `pendingRef` / flush effect。確実な保険は右パネル
  （editor.number 等）完結の操作。

---

## 4. 値→色マッピング（`dynamicColor` は不可 → **`threshold` を使う**）

### 結論（2026-07-25 更新）

やりたいことに応じて2択:

| やりたいこと | 使うもの |
|---|---|
| **範囲→色を editor で設定させたい**（動的に増減） | **`editor.threshold`**（後述。配列が生で届く） |
| 値の大小を連続グラデーションで塗りたい | 自前のカラースケール（`editor.color` × 2〜3 ＋ 補間） |

**`editor.dynamicColor` は使えない**（下記）。ただし**代わりに `editor.threshold` が使える**ことが
実機で判明したので、「範囲を+で追加」系の UI はそちらで実現する。

### DOS の全体像と `matchValue`（2026-07-28 公式ドキュメントで確認）

公式ドキュメントに **DOS 関数の完全な一覧ページ**がある（今まで参照していなかった）。
DOS は **`> データソース | セレクタ関数 | フォーマット関数`** というパイプ構造で、関数は2種類:

- **セレクタ関数**（列や値を取り出す）… `seriesByName` `seriesByIndex` `frameBySeriesNames`
  `seriesByType` `getField` `getValue` `min` `max` `sum` `firstPoint` `lastPoint` ほか多数
  <https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.4/configuration-options-reference/dynamic-options-syntax-functions/dynamic-options-syntax-selector-functions>
- **フォーマット関数**（値を変換・着色する）… **`matchValue`** `rangeValue` `gradient` `lerp`
  `pick` `formatByType` `multiFormat` `type` `maxContrast` `setColorChannel` `prefix` ほか
  <https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.4/configuration-options-reference/dynamic-options-syntax-functions/dynamic-options-syntax-formatting-functions>

**⭐ 文字列カテゴリ→色は `matchValue`（＝「HIGH なら赤」）が正式に存在する。**
`rangeValue`（数値範囲→色）と対をなす関数で、標準 viz の編集画面では
「Ranges（範囲）」と並ぶ **「Matches（一致）」** として出てくる。

```
> primary | seriesByName("status") | matchValue(colorMatchConfig)
```
```json
[ { "match": "SIM Cubicle", "value": "#FF0000" },
  { "match": "Dream Crusher", "value": "#00FF00" } ]
```

> ⚠ **【訂正】**「文字列→色を1組ずつ登録する仕組みは無い」と過去に回答したのは**誤り**。
> `matchValue` として**確実に存在する**（公式ドキュメント記載＋パッケージ内 107 箇所で使用）。
>
> **ただしカスタム viz からは依然として使えない**（結論は変わらない）。理由は
> 「機能が無いから」ではなく「**到達手段が無いから**」:
> `matchValue` の対応表を編集 UI で設定する経路は `editor.dynamicColor` /
> `editor.dynamicColorWithPrecedence` / `editor.tableDynamicColor` の3つだけで、
> **いずれも実機で使用不可**。しかも対応表の実体は `option` ではなく **`context` 側**に入る
> （`Timeline.config.js`: `context: { colorMatchConfig: "colorMatchConfig" }`）ため、
> `useOptions()` には DOS 式の文字列しか来ない。
>
> → 文字列カテゴリの着色は **`editor.seriesColors`（順序付きパレット）** で自前実装する方針のまま。
> 関連: [[threshold-vs-palette-categorical]]

標準 viz の「動的色設定：範囲を+で追加」パネルは `editor.dynamicColor` だが、**カスタム viz 拡張では
使えない**。editorConfig に書くと編集 UI は右パネルに出るが、**編集した範囲/一致の配列は options に
渡らない**。viz が `useOptions()` で受け取るのは DOS 文字列だけ:
```
"cellColor": "> heatValue | rangeValue(cellColorEditorConfig)"   ← 配列ではなくこの文字列が来る
```
範囲配列は `context`（`<option名>EditorConfig`）に保存され、ホストの DOS 評価器だけが参照する。
拡張 iframe ランタイムは DOS を評価しないため、解決済みの色値も範囲配列も viz には届かない。

さらに標準の `rangeValue`/`matchValue` は「**1スカラー→1色**」で、行ごとに値が違うデータ駆動 viz
（カレンダー等）には原理的に不適合。

### 正しい実装：値ベースのカラースケール

値→色は **options に確実に届く editor.color / editor.number / editor.checkbox** で自前実装する:

- optionsSchema: `useValueColors`(checkbox), `lowColor`/`highColor`/`midColor`(color),
  `useMidColor`/`reverse`(checkbox), `scaleMin`/`scaleMax`(number, 空欄=データ min/max 自動)。
- ロジック: 値を `[scaleLo, scaleHi]` で 0..1 に正規化 → `lerpColor` で `low →(mid)→ high` を補間。
  `reverse` で低↔高を反転。全同値なら中央色。
- 凡例は連続グラデーションバー＋min/max ラベル。色を変えると即反映（options 直結）。

```js
function lerpColor(hexA, hexB, t){ /* rgb を線形補間して 'rgb(r,g,b)' */ }
function scaleColorFor(t, opts){
  let u = clamp01(t); if (opts.reverse) u = 1 - u;
  if (opts.useMidColor) return u<=0.5 ? lerpColor(opts.lowColor,opts.midColor,u/0.5)
                                      : lerpColor(opts.midColor,opts.highColor,(u-0.5)/0.5);
  return lerpColor(opts.lowColor, opts.highColor, u);
}
// cellFill: t = (value - scaleLo)/(scaleHi - scaleLo)
```
参照実装: `visualizations/calendar-heatmap/.../visualization.jsx` の
`normalizeOptions` / `lerpColor` / `scaleColorFor` / `cellFill`。

### 「動的に範囲を+追加」したい場合 → **`editor.threshold` を使う**（2026-07-25 実機確認）

**`editor.dynamicColor` の代わりに `editor.threshold` を使えば、やりたいことがそのまま実現できる。**
`dynamicColor` と違い **`context`／DOS を経由せず、範囲＋色の配列が生で options に届く**。

```json
// editorConfig
[{ "label": "しきい値の色", "editor": "editor.threshold", "option": "colorBands",
   "editorProps": { "openRanges": false, "isTogglable": false } }]
```
```json
// optionsSchema（anyOf で正確に書く。素の "type" だと保存時に落ちる）
"colorBands": {
  "default": [{ "from": 0, "to": 50, "value": "#118832" }, { "from": 50, "to": 100, "value": "#D41F1F" }],
  "anyOf": [
    { "type": "array", "items": { "type": "object",
      "properties": { "from": { "type": "number" }, "to": { "type": "number" }, "value": { "type": "string" } },
      "required": ["from", "to", "value"], "additionalProperties": false } },
    { "type": "string", "pattern": "^>.*" }
  ]
}
```
```js
// viz 側に届く生の値（そのまま使える）
[{ from: 40, to: 100, value: '#f8be34' }, { from: 22, to: 40, value: '#dc4e41' }, …]
```

UI は**「+ 閾値の追加」で行を動的に増減**でき、各行に数値2つ＋色ピッカーが並ぶ
（標準 viz の MarkerGauge「ゲージ範囲」と同じ見た目）。`editorProps.openRanges: true` にすると
上限なしの範囲も作れる。

#### ⚠ `openRanges: true` を使うなら optionsSchema を null 許容にする（2026-07-25）

**上の schema 例は `openRanges: false` 用。`true` にするなら下記に変えること。**
開いた範囲は `from`／`to` が **`null`** で保存されるため、`"type": "number"` かつ
`required` に入れたままだと**ダッシュボード保存時の検証で落ちる**（症状は
`must be number` / `must match "then" schema`）:

```json
"colorBands": {
  "default": [ { "from": 0, "to": 40, "value": "#53a051" },
               { "from": 40, "to": null, "value": "#dc4e41" } ],   ← 上限なし
  "anyOf": [
    { "type": "array", "items": { "type": "object",
      "properties": { "from": { "type": ["number", "null"] },      ← null を許す
                      "to":   { "type": ["number", "null"] },
                      "value": { "type": "string" } },
      "required": ["value"], "additionalProperties": false } },     ← from/to は必須にしない
    { "type": "string", "pattern": "^>.*" }
  ]
}
```

viz 側は `from == null → -Infinity` / `to == null → +Infinity` に正規化して判定する。

**既定バンドの上端は開けておく**のが安全。`{from:90, to:100}` のように閉じると
**100 を超える値がどのバンドにも入らず**「色が付かない」症状になる（link-line v1.9.1 で実際に混入し修正）。

**したがって以下の旧・代替案はもう不要**（既存 viz を触るときは threshold への置き換えを検討する）:

- ~~固定 N 組の `editor.number(from) + editor.color` バンド~~
- ~~viz 内に「動的色設定」風パネルを自前実装~~（参照実装だった link-line の `parseColorBands`／
  色設定パネルは、**編集モードでの iframe 入力遮断を回避するための苦肉の策**だった。
  threshold なら右パネルで完結するのでその問題も起きない）
- SPL 側で行に `color` フィールドを持たせる方式は、データ駆動で色を決めたい場合には引き続き有効。

---

## 5. ドリルダウン（設定UIの「インタラクション」）とトークン

### 結論

**使える（2026-07-25 実機確認済み）。** `config.json` で `showDrilldown: true` と
`hasEventHandlers: true` を立てると、**編集画面に「インタラクション」タブが実際に出る**。
Studio では drilldown が「インタラクション（Interactions）」に名称変更されているだけで、
カスタム viz も同じ UI に乗る。`triggerDrilldown` / `addDrilldownListener` も例外なく呼べる。

### `useTokens` で読めるもの（実機確認済み）

**トークンはフラットではなく入れ子で届く。** `tokens.foo` ではなく下記の3階層:

```json
{
  "env":       { "app": "…", "locale": "ja-JP", "user": "admin",
                 "user_realname": "Administrator", "user_email": "…", "user_timezone": "…",
                 "product": "enterprise", "version": "10.4.1", "is_enterprise": true },
  "default":   { "global_time.earliest": "-24h@h", "global_time.latest": "now" },
  "submitted": { "global_time.earliest": "-24h@h", "global_time.latest": "now" }
}
```

- `env` … ログインユーザー名・表示名・メール・タイムゾーン・アプリ名・ロケール・Splunk 版数
- `default` / `submitted` … **選択中の時間レンジ**（`global_time.earliest` / `latest`）

→ **ドリルダウンを使わなくても、viz 内に「対象期間」や「ユーザー名」を出せる**。
ダッシュボードの入力（input）で設定したトークンも同様にここへ入る。
**任意のトークン名を探すときは階層を再帰的に走査すること**（どの階層に入るかは名前次第）。

ただし**デフォルトで無効**。`config.json` の 2 フラグを立て、かつ **viz 側でクリック発火を実装**
しないと、パネルに出てこない／出ても何も起きない。この repo の既存 viz はすべて
`showDrilldown: false` なので、必要な viz で個別に有効化する。

### ✅ トークン設定は**できる**（2026-07-25 実機確認済み・Splunk 10.4.1）

> **【訂正】** 当初この節は「トークン設定は不可」と結論づけていたが**誤りだった**。
> 原因は `config.json` に **`events` 宣言が無かった**こと（下記①）。

**成立の条件は3つ。1つでも欠けると「例外は出ないが何も起きない」。**

**① `config.json` に `events` / `supports` を宣言する（これが抜けていて失敗した）**

```json
{
  "showDrilldown": true,
  "hasEventHandlers": true,
  "canSetTokens": ["dynamic", "static"],
  "config": {
    "events": { "cell.click": { "description": "triggered when user clicks a table cell" } },
    "supports": ["events"]
  }
}
```
標準 viz（`Table.js` 等）と同じ形。**ホストはここに宣言されたイベント名しか認識しない**ので、
宣言が無いと編集画面のインタラクションに紐づける対象が存在せず、発火しても無視される。
イベント名は標準 viz に倣う（`cell.click` / `point.click` / `legend.click` / `node.click` など）。

**② 各要素を `addDrilldownListener` で登録し、「命令」ではなく「事実」を渡す**

`action: 'setToken'` という**命令を送るのは誤り**（公式ドキュメントの例は効かない）。
渡すのは**クリックされたという事実だけ**。`payloadCallback` が返す payload がそれにあたる:

```js
addDrilldownListener({
  node,                               // ← クリックさせたい DOM 要素（セル・バー等）
  action: 'cell.click',               // ← config の events に宣言した名前
  payloadCallback: () => ({
    'row.host.value': 'host-2',       // ← 行の各フィールドを row.<フィールド名>.value で載せる
    'row.status.value': 'OK',
    name: 'status', value: 'OK',      // クリックされた要素自身
  }),
});
```

**`triggerDrilldown()` を自前の `onClick` から呼んでも効かない**（下記）。

**③ ユーザーが編集画面「インタラクション」で「トークンを設定」を追加する**

**何をするか（トークン設定・リンク遷移）を決めるのはホスト側のインタラクション定義**であって
viz ではない。viz は発火するだけ。

→ これで**viz のクリックでダッシュボード全体を絞り込める**（実機確認済み）。

#### ⚠ カスタム viz で発火できるのは **click だけ**（2026-07-25 実機確認済み）

標準 viz は `events` にホバー・ドラッグ・範囲選択も宣言している:

| 分類 | イベント名 |
|---|---|
| クリック | `cell.click` `point.click` `legend.click` `node.click` `link.click` `lane.click` `event.click` `parent.click` `tag.click` `time.click` `value.click` |
| ホバー | `point.mouseover` `point.mouseout` `node.mouseOver` `node.mouseOut` |
| ドラッグ | `node.drag` |
| 範囲選択 | `range.select` `range.selectBeforeZoom` |
| 描画完了 | `viz.renderedWithData` |

**しかしカスタム viz（拡張）で使えるのは click のみ。**
`config.json` の `events` に `point.mouseover` / `range.select` を宣言し、
ホバー／ドラッグのタイミングで `triggerDrilldown` を呼んでも**発火しない**（実機で確認）。

理由は明快で、**`addDrilldownListener` が click しか見ないから**
（型定義に "listens to 'click' events" と明記）。そして
**`triggerDrilldown` は効かない**（前述）。つまり
**「click 以外を発火する手段が存在しない」**。

→ カスタム viz のインタラクションは**クリック前提で設計する**。
ホバーでツールチップを出すなどは viz 内で完結させ、
ダッシュボード連携（トークン設定・リンク遷移）はクリックに割り当てる。

#### ⭐ 発火するのは `addDrilldownListener` だけ（`triggerDrilldown` は効かない）

**2026-07-25 実機で確定した最重要事項。**

`triggerDrilldown()` を各要素の `onClick` から呼んでも**トークンは更新されない**
（例外も出ないので気づきにくい）。**実際にインタラクションを発火させるのは
`addDrilldownListener` で登録した DOM ノードのクリック**である。

→ **クリック可能にしたい要素（セル・バー・ノード等）を1つずつ
`addDrilldownListener` に登録する**のが正解。`payloadCallback` はその要素専用に
行/列を閉じ込めておけばよい（固定で問題ない）。

```jsx
// 各セルの ref を集める
const cellRefs = useRef(new Map());

useEffect(() => {
    cellRefs.current.forEach((node, key) => {
        const [r, c] = key.split(':').map(Number);
        addDrilldownListener({
            node,
            action: 'cell.click',
            payloadCallback: () => buildPayload(r, c),   // ← この要素専用なので固定でよい
        });
    });
}, [rows.length, fields.join(','), JSON.stringify(rows)]);

// JSX 側
<td ref={(el) => { if (el) cellRefs.current.set(`${ri}:${ci}`, el); }} …>
```

これで**要素を押した瞬間にトークンが入る**（デフォルト viz と同じ挙動。実機確認済み）。

**⚠ ノードを1つだけ登録して `payloadCallback` を使い回さない。**
`payloadCallback` に `buildPayload(0, …)` のような**固定の行番号**を書くと、
**どこを押しても1行目の値が飛ぶ**（「2行目の OK を押したのに1行目の NG になる」症状。実際にやらかした）。

#### テーブル以外（SVG 図形など）にも同じ手法が使える

登録するのは**任意の DOM ノード**なので、テーブルのセルに限らない。
world-map のアタックライン（`<path>`）、network-graph のノード（`<circle>`）、
treemap の矩形（`<rect>`）なども**要素ごとに ref を集めて登録すれば**クリックできる。

```jsx
// 例：world-map のアタックライン（データ1本 = 1 path）
const arcRefs = useRef(new Map());

useEffect(() => {
    arcRefs.current.forEach((node, id) => {
        const t = threats.find((x) => x.id === id);
        if (!t) return;
        addDrilldownListener({
            node,
            action: 'link.click',                    // config の events に宣言した名前
            payloadCallback: () => ({
                'row.src.value': t.srcName,
                'row.dst.value': t.dstName,
                'row.severity.value': t.severity,
                name: 'src', value: t.srcName,
            }),
        });
    });
}, [threats]);

<path ref={(el) => { if (el) arcRefs.current.set(t.id, el); }} d={d} … />
```

**⚠ 型定義は `node: HTMLElement` だが SVG 要素は `SVGElement`**（`HTMLElement` の派生ではない）。
実際に受け付けるかは**未検証**。動かない場合は、SVG 図形を透明な `<div>` でオーバーレイして
その div を登録する、`<foreignObject>` を使う、などの回避策を検討する。

- **当たり判定は太めに**：線や小さい点は押しにくいので、
  透明で太い `stroke`（`strokeWidth` 大 + `stroke="transparent"`）のパスを重ねて
  そちらを登録すると押しやすい（既存 viz のツールチップ用ヒット領域と同じ考え方）。
- **要素が再生成されると登録が外れる**：データ更新やアニメーションで要素を作り直す実装なら、
  `useEffect` の依存配列にデータを入れて**再登録**する。

**注意**：`triggerDrilldown` は**どの形でも例外を投げない**。サイレントに無視されるだけなので、
**「例外が出ない＝動いている」と判断してはいけない**。必ずトークンの値が変わったかを確認する。

### 有効化の 3 ステップ

**① `config.json` のトップレベル 2 フラグ**（`config` の中ではなく外側。既定はどちらも `false`）:

```json
{
  "showDrilldown": true,
  "hasEventHandlers": true,
  ...
}
```

- `showDrilldown` … 編集画面の「インタラクション」パネルにこの viz を出す
- `hasEventHandlers` … viz が発火したイベントをホスト側のハンドラへ流す

**② トークンを設定させるなら `canSetTokens`**（`["dynamic","static"]`）**＋ `events` 宣言**。
`events` が無いとトークン設定は動かない（上記参照）。

**③ viz 側でクリックを発火**（どちらか一方）:

```jsx
// 方式A: DOM ノードを登録してホストに click を任せる
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';

addDrilldownListener({
  node: barEl,                       // HTMLElement（SVG 要素も可）
  action: 'custom.click',
  payloadCallback: () => ({ name: 'host', value: 'host-1', data: { ...row } }),
});
```

```jsx
// 方式B: 自前の onClick から明示的に発火（React ではこちらが素直）
import { triggerDrilldown } from '@splunk/dashboard-studio-extension/visualization';

<rect onClick={(e) => triggerDrilldown({
  action: 'custom.click',
  payload: { name: 'host', value: row.host, data: row },
  originalEvent: e.nativeEvent,      // click 以外の起点なら指定
})} />
```

### API の所在（重要）

**`/react` サブパスに drilldown フックは無い。** `useDataSources` 等と違い、
`useDrilldown` のようなフックは存在しないので、**コアの
`@splunk/dashboard-studio-extension/visualization` から関数を直接 import** する
（`.d.mts` の export 一覧で確認済み）。

**公式ドキュメントの `addDrilldownListener` シグネチャは誤り。**
docs は位置引数 `(node, action, payloadCallback)` と書いているが、**実際の型定義は
単一オブジェクト引数** `({ node, action, payloadCallback })`。型定義（node_modules の
`visualization-*.d.mts`）が正。docs のコード例をそのままコピペすると動かない。

### 型

```ts
interface DrilldownPayloadState {
  earliest?: string | number;  latest?: string | number;
  data?: Record<string, unknown>;
  bounds?: string[];  name?: string;  value?: unknown;  action?: string;
  [key: string]: unknown;      // 任意キー可
}
interface DrilldownArgs {
  action: string;                    // 例 'custom.click'
  payload: DrilldownPayloadState;
  originalEvent?: Event;             // click 以外の起点で使う
}
declare const addDrilldownListener: (a: {
  node: HTMLElement; action: string; payloadCallback: () => DrilldownPayloadState;
}) => void;
declare const triggerDrilldown: (a: DrilldownArgs) => void;
```

`payload` の `name` / `value` が、インタラクション設定 UI 側でトークン
（`$name$` / `$value$` 相当）やリンク先 URL のパラメータに渡る値になる。
行全体を `data` に入れておくと、フィールド指定のインタラクションで参照できる。

### 注意

- **編集モードでは viz 内のマウス操作が iframe ごと遮断される**（§3 の既知事項）。
  クリックの動作確認は表示モードで行う。
- ローカル検証（§6）では `DashboardExtensionAPI` モックに
  `addDrilldownListener` / `triggerDrilldown` を生やしておくと、発火の有無を検査できる。

---

## 6. ローカル検証（happy-dom で実機なしにバンドルを叩く）

ビルド済み `dist/<viz>/visualization.js` を Node + happy-dom で実行し、描画・オプション反映・ガードを
検証する。回帰の早期発見に有効。

### 仕組み

- happy-dom で DOM を用意し、`globalThis.DashboardExtensionAPI` をモックしてバンドルを `eval`。
- SVG/DOM 属性を検査。リスナーを発火してオプション/データ/テーマ変更をシミュレート。
- フックは `VisualizationExtensionProvider` 無しでも動く（standalone listener 実装）。

### モックの形

```js
globalThis.DashboardExtensionAPI = {
  getDataSources: () => ({ loading:false, dataSources:{ primary:{ data:{ fields, rows } } } }),
  addDataSourcesListener: mkListener('dataSources'),
  getOptions: () => ({ options: {...} }),   // options はネスト（フラットではない）
  setOptions, addOptionsListener: mkListener('options'),
  getTheme: () => ({ theme: 'dark' }), addThemeListener: mkListener('theme'),
  getDimensions: () => ({ width, height }), addDimensionsListener: mkListener('dimensions'),
  getMode: () => ({ mode:'view' }), addModeListener: mkListener('mode'),
  /* tokens / drilldown / error も同様に */
};
```

### ハマりどころ

- **オートフィット系**は `HTMLElement.prototype.clientWidth/clientHeight` を `Object.defineProperty` で固定。
- **ResizeObserver**: 削除して初回計測フォールバックに落とすか、observe 時に callback を呼ぶ簡易モックを
  入れる（サイズ変更の再計測を試すなら後者＋手動 flush）。
- `requestAnimationFrame` は `setTimeout(cb, 0)` で代替。`await sleep(150〜320)` で描画/再レンダリングを待つ。
- **色の比較**: rect の fill は `#RRGGBB` 生値で入ることが多い（`rgb(...)` 変換せずに hex で比較）。
- happy-dom では `editor.dynamicColor` 等の**編集画面 UI 自体は再現できない**。検証できるのは
  「options に値が渡ったときに viz が正しく適用するか」まで。エディタが実機で出るかは実機確認。
- `globalThis.navigator` は直接代入不可。`Object.defineProperty` で configurable 設定する。

雛形は `visualizations/sankey-flow/test/verify.mjs`（`yarn verify` で実行、happy-dom は devDependency）を
流用する。モック一式・リスナー発火・オプション/データ/テーマ変更・ガード検証のパターンを網羅している。

### 「オプションは出るのに反映されない」症状の切り分け

config.json は新しいが `visualization.js` が古い（JS キャッシュ or 古い `.spl` をインストール）可能性大。
config.json と JS バンドルは別経路で配信される。§6 の `_bump` + ハードリロードと、正しい `.spl` の確認。

---

## 7. デプロイ（アンインストール・再起動なし）

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`app.conf` の version も同期。
   `yarn build && yarn package` で新 `.spl` 生成。
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）。
4. ブラウザをハードリロード（Ctrl+Shift+R）。

反映されない場合は §1「実機に反映されないとき」（リバースプロキシのキャッシュ）を参照。

---

## 8. GitHub（ユーザーが手動 push）

- モノレポ `Aria-1429/custom-viz`（private / `main`）。Claude は commit / push しない。
- push 前リークチェック: `git status --short | grep -E 'node_modules|dist/|stage/'`
  （`.spl` はコミット対象。それ以外のビルド成果物は `.gitignore` で除外）。
- `.gitignore` は「`dist/*` は無視、`!dist/*.spl` で `.spl` だけ救済」。ルート＋各 viz の両方に必要。
  新しい viz を追加したらこの 2 行が入っているか確認する。
- README は日本語（特徴・データ仕様・開発コマンド・デプロイ手順・サンプルSPL・リリースノート）。

---

## 9. データモデルの型

第1列をカテゴリ/軸/日付、第2列以降を数値とするのが基本。代表例:
- bar / donut … 第1列=カテゴリ, 第2列=数値
- radar … 第1列=軸(メトリック), 第2列以降=系列（列ごとにポリゴン）
- calendar-heatmap … 第1列=日付(_time/ISO/epoch 秒・ミリ秒), 第2列=数値（同日は合算）

サンプル SPL は必ず `makeresults` ベースで提示し、動作確認できるようにする。

### サンプル SPL の書き方

`eval _raw="..." | makemv | mvexpand | rex` のチェーンは実機で mvexpand が不発になり
「全行が1行に潰れて各セルがマルチバリュー」になることがある。確実な形式を使う:
- **Splunk 9.0+**: `| makeresults format=csv data="col1,col2,...\n..."`（最も確実・読みやすい）。
- **旧環境**: `| makeresults | eval raw=split("a,b,10|c,d,20","|") | mvexpand raw
  | eval x=mvindex(split(raw,","),0), ...`（makemv/rex に依存しない）。

### マルチバリューセルの救済（viz 側の防御）

mv フィールドが1行のセルに**配列**（環境により改行区切り文字列）で届くことがある。放置すると
`String(配列)`="A,B,..." がエンティティ名になり、数値は parseNum のカンマ除去で**桁連結**した
巨大値になる。防御パターン:
- 全カラムのトークン数（配列長 or 改行分割数）が一致する行だけ平行展開して復元。
- 不一致の行は null 行に置換して確実に落とす。
- 1e15 以上の値は `toExponential` で表示（カンマ 30 桁でヘッダーが崩壊する）。

---

## 10. 同梱データ・素材のライセンス（著作権フリーのみ）

viz にバンドルする**データ・素材**（地図データ、GeoJSON/TopoJSON、アイコン、フォント、画像、辞書・
参照データ等）は、**著作権フリー＝パブリックドメイン、またはそれ相当のものだけを使う**。
「実行時のインターネット通信なし」制約とは別軸の話で、**バンドルする=再配布する**ため、素材本体の
再配布可否・条件がそのまま viz の配布条件になる。

### 採否の基準

- **可**：クレジット表記・出典明記・利用報告・承認申請のいずれも**「必須ではない」**もの。
  - パブリックドメイン / CC0 / PDDL。
  - MIT / BSD / ISC / Apache-2.0 等（主にコード・フォント）。ただし**データ本体のライセンスは別途確認**
    （パッケージのライセンスと中身のデータのライセンスは別なことがある。例：`world-atlas` は
    パッケージが ISC だが、**中身は Natural Earth=パブリックドメイン**。両方確認して初めて安全と言える）。
- **不可**：以下のいずれかが**必須**のもの。確実にフリーと言えなければ採用しない。
  - 出典表記・クレジット表示が必須（CC BY、政府標準利用規約 / 国土地理院コンテンツ利用規約 等）。
  - 継承（ShareAlike）が必須（CC BY-SA、ODbL＝OpenStreetMap 由来データ）。
  - 利用報告・事前承認が必要（旧「地球地図」系など）。
  - ライセンス不明・出所不明。

### 地図データの調達（第一候補：Natural Earth）

- **Natural Earth**（<https://www.naturalearthdata.com/about/terms-of-use/>）は明示的に
  **パブリックドメイン**：*"All versions ... are in the public domain."* /
  *"No permission is needed to use Natural Earth. Crediting the authors is unnecessary."*
  → **クレジット不要・商用可・改変可・再配布可**。地図系はまずこれを使う。
- **国レベル**：npm `world-atlas`（Natural Earth の再配布。`countries-110m/50m/10m.json`）。
  world-map viz が採用済み。
- **行政区画（州・都道府県=Admin-1）**：Natural Earth の `ne_10m_admin_1_states_provinces`
  （`nvkelso/natural-earth-vector` リポジトリの `geojson/` にパブリックドメインで置かれている。
  約 40MB）から対象国を `properties.admin==='Japan'` 等で抽出し、`topojson-server` で TopoJSON 化、
  `topojson-simplify` の presimplify→simplify で簡略化＋量子化して同梱する。
  japan-map viz がこの手順で 47 都道府県（`name`/`name_ja` 付き、153KB）を作成済み。
- **使ってはいけない代表例**：国土地理院「地球地図日本」「基盤地図情報」（出典表記必須）、
  GADM（再配布・商用に制限）、OpenStreetMap 由来（ODbL の継承義務）。
  ※ かつて japan-map v1.0.0 で `dataofjapan/land`（地球地図日本由来）を使い、**出典表記が必要**と
  判明して Natural Earth へ差し替えた経緯がある。最初からフリー素材を選ぶこと。

### 調達時のワークフロー

1. 素材を採用する前に**ライセンス原文（ToU / LICENSE / README のライセンス節）を必ず確認**する。
   開発中に Claude が公式サイトを参照するのは可（SKILL「制約」参照）。
2. パッケージ経由で入れる場合も、**パッケージのライセンス**と**同梱データの出所・ライセンス**の
   両方を確認する。
3. フリーと確認できたら、README の「地図データの出典・ライセンス」節に**パブリックドメインである旨**を
   記載する（表記は義務ではないが、後任が再確認せず済むように書いておく）。
4. 少しでも不明なら採用しない。代替のフリー素材を探すか、ユーザーに確認する。
