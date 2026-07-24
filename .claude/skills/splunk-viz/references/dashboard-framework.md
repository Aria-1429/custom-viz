# Splunk Dashboard Framework ナレッジ（Studio 拡張との能力差）

**Dashboard Framework**（`@splunk/create` で作る独立 React アプリ／`DashboardCore` + preset）に関する知見。
このプロジェクトが対象とする Dashboard Studio 拡張とは別物なので、[studio-extension-viz.md](studio-extension-viz.md)
には混ぜず、こちらに集約する。Framework 側の話が出たときに読む。

---

## 1. 2系統の区別

| | **Dashboard Studio 拡張** | **Dashboard Framework** |
|---|---|---|
| 通称 | custom viz extension | dashboard-core / `@splunk/create` app |
| このリポジトリ | これ（`custom-viz-*/`、`.spl`） | 対象外（このファイルの話） |
| 何を作る | 既存 Dashboard Studio に載せる **viz** | ダッシュボード UI を**丸ごと自作**する React アプリ |
| 主パッケージ | `@splunk/dashboard-studio-extension` | `@splunk/dashboard-core` / `@splunk/dashboard-context` / `@splunk/dashboard-presets` |
| 実行環境 | サンドボックス iframe（postMessage ブリッジ） | 通常の React（Splunk の1ページとして自前ホスト） |
| デプロイ | 既存ダッシュボードへ `.spl` を追加 | アプリ（`.spl`）を自前で用意・運用。既存 Studio 画面には載らない |

Framework は「ダッシュボードの器（`DashboardCore`）ごと自作し、**preset** に viz・input・レイアウトを
差し込む」方式。Studio 拡張は「既存の Studio 画面に viz を1個追加する」方式。**器を握れるかどうか**が
両者の能力差の根本。

---

## 1.5 Framework を構成するパッケージと標準提供物

`npm view @splunk/<pkg> version` で最新を確認できる（数値は目安）。標準提供物は tarball 実抽出。

| パッケージ | 役割 | 標準で入っているもの |
|---|---|---|
| `@splunk/dashboard-core` | 器の描画（`DashboardCore`）。JSON 定義からダッシュボードを描く controlled component | `DashboardCore` |
| `@splunk/dashboard-context` | 状態・データソース・プラグインの context / API。`DashboardContextProvider` は Core の**必須の親** | providers / contexts / registries |
| `@splunk/dashboard-presets` | viz・input・レイアウト・イベント・データソースを束ねた preset | **5 種**: `EnterprisePreset`, `EnterpriseViewOnlyPreset`, `CloudPreset`, `CloudViewOnlyPreset`, `ProfiledCloudPreset` |
| `@splunk/dashboard-inputs` | 入力部品（＋各 `*Schema`） | **6 種**: `Text`, `Number`, `Select`, `Multiselect`, `TimeRangePicker`, `EnterpriseTimeRangePicker` |
| `@splunk/visualizations` | 標準 viz（Framework でも同一） | 32 種（Area/Bar/Line/Pie/Sankey/Table… → [studio-extension-viz.md](studio-extension-viz.md) §0） |
| `@splunk/react-ui` / `@splunk/themes` / `@splunk/react-icons` | 汎用 UI 85 部品／テーマ／アイコン | 拡張・Framework 双方で使える |

- 最小構成: `DashboardContextProvider preset={preset} initialDefinition={def}` で `DashboardCore` を包む。
- **preset は spread で差し替え・除外・追加**する（標準 preset を土台に viz/input を上書き）。
- 公式 dashboard-docs のトピック（splunkui.splunk.com/Packages/dashboard-docs/）: Introduction /
  DashboardContext / Data sources overview / Layouts / Inputs / **Custom inputs** / Custom visualizations /
  Event handlers / Tokens / Drilldown。これらが Framework で扱える機能領域。

---

## 2. Framework でできて Studio 拡張でできないこと（本題）

### ① カスタムインプット（token を双方向にバインドする入力 UI）

Framework のみ可。preset の `inputs` に自作コンポーネントを登録する。input は
`@splunk/dashboard-inputs` の `BaseInput` / `withInputWrapper` をベースにし、**静的メソッドで
token と双方向バインド**する:

```jsx
import { BaseInput, withInputWrapper } from '@splunk/dashboard-inputs';

// 値→トークン（1入力から複数トークンへ展開も可）
FlightWidget.valueToTokens = (value, { token }) => ({
  [`${token}.origin`]: value.origin,
  [`${token}.destination`]: value.destination,
});
// トークン→値（初期表示・外部変更の反映）
FlightWidget.tokensToValue = ({ tokens, tokenNamespace, tokenName }) => ({ /* ... */ });
```

Studio 拡張の setToken（後述③）は**クリック契機の一方向**でしかない。input のような「常時
双方向・任意 UI・複数トークン展開」はできない。→ 本格的な自作入力が要るなら Framework 一択。

### ② ダッシュボードの器・レイアウト・プリセット全体の制御

Framework のみ可。preset はただのオブジェクトで、キー名にコンポーネントを差し込むだけ:

```jsx
import { DashboardCore } from '@splunk/dashboard-core';
import { DashboardContextProvider } from '@splunk/dashboard-context';
import EnterprisePreset from '@splunk/dashboard-presets/EnterprisePreset';

const preset = {
  ...EnterprisePreset,
  visualizations: { ...EnterprisePreset.visualizations, 'splunk.calendar': CalendarViz },
  inputs:         { ...EnterprisePreset.inputs,         'input.flightwidget': FlightWidget },
};

<DashboardContextProvider preset={preset} initialDefinition={def}>
  <DashboardCore width="100%" height="100%" />
</DashboardContextProvider>
```

- 標準 viz/input の**差し替え・除外・追加**、レイアウトエンジンや初期 definition の差し込み、
  ダッシュボード全体の挙動を自由に組める。Studio 拡張は viz を1個足すだけで、器には触れない。

### ③ ホスト DOM / 親フレームへのアクセス

Framework は通常の React なので `window` / DOM / 他コンポーネントに普通にアクセスできる。
Studio 拡張は iframe 隔離で **`window.parent` にアクセス不可・Studio ページの DOM は読み書き不可**
（通信は postMessage のみ）。

### ④ カスタム viz でホスト機構へフル参加

Framework のカスタム viz は `@splunk/visualizations/common/SplunkVisualization` を継承して preset に
登録する。ホストと同一 React ツリー内なので、トークン・ドリルダウン・エディタ機構へ制約なく参加でき、
任意の npm 描画ライブラリ（例 `@nivo/calendar`）をバンドルして使える。Studio 拡張の viz は
postMessage 越しで、参加できる機構が API で絞られる（§3）。

---

## 3. Studio 拡張でも「できる」こと（誤解しやすい点・訂正）

Studio 拡張は read 専用ではない。公式 Extension API リファレンスで確認できる範囲:

- **トークンの読み取り**：`useTokens()` / `addTokensListener()`。ダッシュボードのトークンを購読できる。
- **トークンの書き込み（限定的）**：`triggerDrilldown()` の **setToken アクション**経由。
  config.json で `canSetTokens`（`["dynamic","static"]`）を有効化し、`showDrilldown: true` +
  `hasEventHandlers: true` が前提。**クリック/イベント契機の一方向**であり、input のような常時
  双方向バインドではない。
- **ドリルダウンの発火**：`triggerDrilldown()`（プログラム発火）/ `addDrilldownListener()`（DOM ノードに
  ハンドラ登録）。`linkTo` / `setToken` 等のアクションが使える。

つまり「Studio 拡張はトークンに一切書き戻せない」は**誤り**。正しくは「書き戻しは**ドリルダウン/
イベント契機の setToken に限られ**、input UI の定義や常時双方向バインドはできない」。

> 既存 viz の config.json は既定で `showDrilldown:false` / `canSetTokens:[]` / `hasEventHandlers:false`。
> クリックでトークンを設定させたい viz では、これらを有効化し `triggerDrilldown` を実装する。
> verify モックが `getTokens`/`addTokensListener`/`setToken` を持つのはこの API を叩けるようにするため。

---

## 4. できる／できない early 早見表

| やりたいこと | Studio 拡張 | Framework |
|---|---|---|
| データ駆動の描画（viz 本体） | ○ | ○ |
| 編集画面オプション（`useOptions`/editorConfig） | ○ | ○（preset の editor 機構） |
| トークンを**読む** | ○（`useTokens`） | ○ |
| クリックでトークンを**set**（一方向） | ○（`triggerDrilldown`+config） | ○ |
| ドリルダウン（linkTo 等） | ○（`triggerDrilldown`） | ○ |
| **カスタム input UI**（双方向 token バインド） | ✕ | ○（`@splunk/dashboard-inputs`） |
| 1入力→**複数トークン**展開 | ✕ | ○（`valueToTokens`） |
| **レイアウト/器/preset 全体**の制御 | ✕ | ○ |
| 標準 viz/input の差し替え・除外 | ✕ | ○ |
| ホスト DOM / `window.parent` アクセス | ✕（iframe 隔離） | ○ |
| 既存 Studio 画面に**そのまま**追加 | ○ | ✕（アプリを丸ごと自作） |

---

## 5. このプロジェクトでの実務判断

- **既存 Studio ダッシュボードに部品を足す**用途は Studio 拡張のまま（このリポジトリの `.spl` 運用）。
  クリックでトークン連携したい程度なら拡張の `triggerDrilldown` + config 有効化で足りる。
- **カスタム入力・レイアウト・ダッシュボードの器そのもの**を作り込む必要が出たら Framework 方式。
  ただし `.spl` を既存 Studio に載せる運用ではなく、`DashboardCore` でアプリを丸ごと組む**新規開発**に
  なる点を発注前に合意する。既存の custom-viz-* 群とは土台が別になる。

---

## 6. 拡張 ⇄ Framework の切り替えガイド

### 大前提：1つの成果物の中では切り替えられない

Studio 拡張 viz と Framework アプリは**ランタイム・ビルド・配置がすべて非互換**。同じ `.jsx` を
両対応にはできない。「柔軟に切り替える」とは *同一 viz の両対応* ではなく、**プロジェクトが両方式の
レーンを持ち、要件ごとに新規成果物をどちらで作るか振り分ける**こと。

| | Studio 拡張 viz | Framework アプリ |
|---|---|---|
| ルート | `VisualizationExtensionProvider`（iframe） | `DashboardContextProvider` + `DashboardCore` |
| 状態取得 | `useOptions`/`useTheme`（postMessage） | preset・props 経由 |
| ビルド/成果物 | esbuild → `.spl`（visualization.js） | webpack → Splunk アプリ（ページ）→ `.spl` |
| 載る場所 | **既存**ダッシュボードのパネル1個 | **自作アプリのページ**（既存 Studio には載らない） |

### 切り替え判断チェックリスト（上から順に。1つでも該当したら Framework 検討）

まず Studio 拡張で組めないか試す。以下に当たるときだけ Framework にする:

- [ ] **カスタム入力 UI が要る**（ドロップダウン等の値を token に**常時双方向**バインド、1入力→複数トークン）。
      → 拡張の `triggerDrilldown`(setToken) は*クリック契機の一方向*止まり。該当なら Framework。
- [ ] **ダッシュボードの器・レイアウト・パネル配置そのもの**をコード側で制御したい。
- [ ] **複数パネル間の協調**（あるパネルの状態で他パネルを動的に組み替える等）を viz の外から握りたい。
- [ ] **標準 viz/input の差し替え・除外**、独自 preset を効かせたい。
- [ ] **ホスト DOM / `window` / 他コンポーネント**への直接アクセスが要る（iframe 隔離が邪魔）。

いずれも非該当なら **Studio 拡張のまま**（このリポジトリの通常運用）。「クリックでトークン設定」程度は
拡張で足りる（§3）。

### Framework で作ると決めたら

- **置き場所**：`custom-viz-*/`（拡張レーン）とは分け、`dashboard-apps/<name>/` を作る（レーンを混ぜない）。
- **スケルトン**：`npx @splunk/create@latest`（拡張用の `--mode=dashboard-studio-extension` は付けない。
  React app / dashboard として作る）。最小構成は §2②の `DashboardContextProvider`+`DashboardCore`+preset。
- **preset は標準を spread**して viz/input を足す（`{...EnterprisePreset, visualizations:{...}, inputs:{...}}`）。
  input は `@splunk/dashboard-inputs`、カスタム viz は `SplunkVisualization` 継承（§2）。
- **リリース運用は共通**：SemVer、README リリースノート、`.spl` を残す、push はユーザー手動（[studio-extension-viz.md](studio-extension-viz.md) §1/§7 と同じ方針）。
- **オフライン制約は同じ**：外部通信・CDN 禁止。描画 lib は `yarn add` でバンドルする。

### 既存 viz 資産の再利用方針

既存 `custom-viz-*/visualization.jsx` は描画本体に拡張フック（`useDataSources`/`useOptions`/`useTheme`）が
直に混ざっており、**そのままは Framework で使えない**。再利用するなら**純粋ロジックを切り出す**:

- 再利用できる（フック非依存）：データ正規化（`normalizeData`）、レイアウト計算、SVG 生成、色スケール
  （`lerpColor`/`scaleColorFor`）、`normalizeOptions` の中身。→ これらを引数だけで動く純関数にしておくと
  拡張 viz と Framework viz の両方から呼べる。
- 差し替えが要る（ホスト依存）：状態の取得口（拡張=フック / Framework=props・preset）、ルート構成、
  マウントゲート（Framework は iframe でないので不要）。
- 新規に拡張 viz を書くときも、**描画ロジックを純関数に寄せておく**と後で Framework へ移しやすい
  （将来の切り替えコストを下げる予防設計）。

---

## 7. Framework の成果物形態とデプロイ（`.spl` の中身が拡張と別物）

「最終的に `.spl` を作って Splunk にインストールする」点は拡張と同じ。だが **`.spl` の中身と載り方が
根本的に違う**。Framework の成果物は「viz 部品」ではなく **独自ページを持つ Splunk アプリそのもの**。

### 成果物の違い（公式デモ my-splunk-app の実構成で確認）

| | Studio 拡張 viz | Framework アプリ |
|---|---|---|
| ビルドツール | esbuild → `visualization.js` | **webpack**（`@splunk/webpack-configs/base.config`） |
| `.spl` の中身 | `config.json` + `visualization.js`（viz 定義だけ） | **アプリ一式**：`appserver/static`（バンドル）+ `default/app.conf` + **`data/ui/views/*.xml`** + `nav/default.xml` + `templates/*.html` + lookups + `metadata/default.meta` |
| 載る単位 | 既存ダッシュボードの**パネル1個**（viz 選択肢が増える） | **アプリ＝独立ページ**（`views/start.xml` が React バンドルを読み込む） |
| インストール後 | Studio の viz 一覧に追加 | **アプリ／ページが1つ増える**（Studio のパネルには出ない） |

### デプロイの流れ（Framework）

1. `@splunk/create` で scaffold（webpack + `src/main/resources/splunk/` にアプリ雛形。`app.conf`/`views`/`nav` 込み）。
2. `yarn build`（`NODE_ENV=production webpack`）→ `stage/appserver/static/pages/` にバンドル出力。
   `src/main/resources/splunk` が `stage/` にコピーされる（CopyWebpackPlugin）。
3. `stage/` を tar 化して `.spl` を作る。
4. Splunk に「Install app from file」でインストール → **アプリとして起動**（`views/start.xml` 経由で
   `DashboardCore` が描画）。
5. 開発中は `yarn link:app`（`stage/` を `$SPLUNK_HOME/etc/apps/<app>` にシンボリックリンク）＋
   `webpack --watch` でライブ確認。

### 拡張のデプロイ手順は流用不可（注意）

- 拡張の `_bump` + Upgrade チェックの手順（[studio-extension-viz.md](studio-extension-viz.md) §6）は
  **Framework には流用できない**（成果物の性質が違う）。ビルドも esbuild でなく webpack で別物。
- 「既存 Studio ダッシュボードにパネルとして足したい」なら Framework は選択肢外（§6 の判断ガイド）。
- リリース運用の共通部分（SemVer / README リリースノート / `.spl` を残す / push はユーザー手動）は
  拡張と揃える。

---

## 参照リンク

- Extension API リファレンス（Studio 拡張の hook / triggerDrilldown / setToken の限界）:
  https://help.splunk.com/en/splunk-enterprise/developing-views-and-apps-for-splunk-web/10.4/custom-visualizations-for-dashboard-studio/dashboard-extension-api-reference
- SplunkUI Custom inputs（Framework の input）: https://splunkui.splunk.com/Packages/dashboard-docs/Custominputs
- 公式デモ（Framework: preset に viz と input を登録）:
  https://github.com/splunk/splunk-dashboard-framework-custom-inputs
  - input 実装: `packages/my-splunk-app/src/main/webapp/pages/start/FlightWidget.jsx`
  - viz 実装: `.../start/CalendarViz.jsx`、preset 登録: `.../start/index.jsx`
