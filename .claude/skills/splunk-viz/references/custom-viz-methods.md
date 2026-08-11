# Splunk カスタムビジュアライゼーションの2方式（全体像・最初に読む）

Splunk でカスタムビジュアライゼーション（＝ダッシュボードにパネルとして載せる viz）を作る方式は **2つ**。
目的（どのダッシュボードで使うか）で選ぶ。取り違えると「一覧に出ない」で詰まるので、まずこの表で当たりを付ける。

| | **classic**（SplunkJS） | **Studio 拡張** |
|---|---|---|
| 公式名 | Custom viz for classic Simple XML | Custom viz for Dashboard Studio |
| 実体 | `SplunkVisualizationBase` 継承（AMD/webpack、d3等） | React iframe 拡張 |
| 登録 | `visualizations.conf`（**`framework_type` なし**）＋ `formatter.html` | `visualizations.conf`（**`framework_type = studio_visualization`**）＋ `config.json` |
| **Simple XML で使える** | **○** | ✕ |
| **Dashboard Studio で使える** | **○（後方互換）** | ○（ネイティブ） |
| 既存ダッシュボードにパネル追加 | ○ | ○ |
| このリポジトリ | （未作成） | `visualizations/<name>/` ← 現行の主力 |
| 詳細ナレッジ | 本ファイル §2 | [studio-extension-viz.md](studio-extension-viz.md) |

### 一目の選び方

- **Simple XML と Studio の両方で使いたい／どちらか不明** → **classic**（1つで両対応）。
- **Studio だけでよく、React で作りたい** → **Studio 拡張**（このリポジトリの通常運用）。

> **classic が Studio でも出る理由**：**Dashboard Studio は classic カスタム viz を後方互換で表示できる**
> （公式明記）。実例 circlepack_viz（`framework_type` なし・`SplunkVisualizationBase` 継承・`formatter.html`）が
> Studio でも出るのはこのため。「Studio 拡張が登場する前から Studio で表示できるカスタム viz があった」の
> 正体がこれ。

> **⭐ 第4の選択肢：DPX（独自ダッシュボード基盤）**。上の2方式は「Splunk のダッシュボードに
> パネルを載せる」話だが、**ダッシュボードの器そのものを自前で持つ**なら
> [dpx-platform.md](dpx-platform.md) を読む（`apps/dash-platform/`。2026-08-10 実機検証済み）。
> DPX の viz は **iframe なし・`config.json` なし・splunkd 再起動なしの素の React コンポーネント**で、
> registry に1行足すだけで載る。既存の Studio 拡張 viz も2ステップで移植できる（world-map で実証）。

> **`@splunk/create` の独立 React ページ（Splunk App with React）は、この2方式とは別系統**。
> 「ダッシュボードにパネルとして viz を載せる」用途では使わない（成果物はページ1枚）ので、
> カスタム viz を作る目的なら上の2方式から選ぶ。
> ただし**ページ自身に SPL を実行させたい**なら選択肢になる。
> → [splunk-react-app.md](splunk-react-app.md)（2026-08-10 実機検証済み）
>
> **【訂正】** 以前ここには「Dashboard Framework（…／`DashboardCore` + preset）は
> **Mako テンプレート依存で 10.4 では非推奨**」と書いてあったが、**2点とも誤り**だった:
> - **別物2つを混同していた**。`@splunk/create` の独立アプリと、その中で Splunk の
>   ダッシュボードを描画する `DashboardCore` + preset は別の話。
> - **Mako を自分で書く必要は無い**（同梱の共通テンプレート `pages/splunk_ui_app.html` を使う）。
>   実機 10.4.2 で描画・サーチ実行まで確認済み。

---

## 1.5 能力対比（Studio 拡張は classic の上位互換ではない）

**結論：Studio 拡張は classic の「シンプルな上位互換」ではない。**両者はトレードオフ。むしろ
**データ制御と formatter の自由度は classic の方が上**で、拡張は「Studio 特化・React 前提で書きやすく
した代わりにその自由度を削った」もの。Splunk が「新規は拡張推奨」と言うのは機能的上位互換だからでは
なく、**Dashboard Studio が将来の主軸**という戦略的理由（公式 API リファレンス両者を突き合わせて確認）。

| 能力 | **classic**（`SplunkVisualizationBase`） | **Studio 拡張** |
|---|---|---|
| **データの増分/ページ取得** | **○** `getInitialDataParams` の `count`/`offset`/`sortKey` ＋ **`updateDataParams` で実行時に再要求** | **✕** ホストが出したデータを `useDataSources` で受け取るだけ（受動的消費者） |
| **出力フォーマット選択** | **○** `ROW_MAJOR_OUTPUT_MODE` / `COLUMN_MAJOR_OUTPUT_MODE` / **`RAW_OUTPUT_MODE`（生JSON）** | **✕** ホストが出した形のまま。format 選択なし |
| **大規模データ** | **○** 自分でチャンク要求できる | **✕** ホスト任せ |
| フォーマットパネル（編集UI） | `formatter.html`（Web Components を自由に組める） | `config.json` の editorConfig（**editor 型が限られる**） |
| **右パネルの動的色設定** | **○**（標準 formatter 要素） | **✕**（`editor.dynamicColor` は配列が届かず不可。→ [studio-extension-viz.md](studio-extension-viz.md) §4） |
| DOM/JS ライブラリ/アニメ | ○ `this.el` に自由アクセス、d3 等自由 | ○ ただし **iframe 隔離**（`window.parent` 不可） |
| ドリルダウン/トークン設定 | ○ `drilldown(payload, event)` | ○ `triggerDrilldown`（config 有効化が前提） |
| React 前提 | △（可能だが前提ではない） | ○（`useOptions`/`useTheme` 等フック） |
| **Simple XML で使える** | **○** | ✕ |
| Dashboard Studio で使える | ○（後方互換） | ○（ネイティブ） |
| iframe 隔離 | なし（ページと同一コンテキスト） | あり |
| Splunk の新規推奨 | △ | ○ |

### 実務含意

- 既存 `visualizations/*`（拡張）で困っていた **`editor.dynamicColor` 不可**・**大量データの扱い**は、
  実装の問題ではなく**拡張が classic から削った構造的制約**。裏返すと、これらが要件なら **classic が適合**
  （かつ Simple XML/Studio 両対応のおまけ付き）。
- 逆に、Studio だけでよく React で宣言的に書きたい・テーマ連携をフック1つで済ませたいなら拡張が楽。

---

## 2. classic カスタムビジュアライゼーション（SplunkJS）

### ディレクトリ構成（実例 circlepack_viz で確認）

```
<app>/
├── appserver/static/visualizations/<name>/
│   ├── visualization.js      # ビルド成果物（AMD）。`define(["api/SplunkVisualizationBase", ...])`
│   ├── visualization.css
│   ├── formatter.html        # ★編集画面のフォーマットパネル（Web Components 定義）
│   ├── preview.png
│   └── src/visualization_source.js   # 実装ソース（webpack で visualization.js に）
├── default/
│   ├── visualizations.conf   # ★viz 登録（framework_type なし＝classic）
│   ├── app.conf
│   └── savedsearches.conf    # 任意（デモ用サーチ）
├── metadata/default.meta     # export 設定
└── app.manifest
```

### `visualizations.conf`（framework_type を書かない＝classic）

```ini
[<name>]
label = Circlepack
description = ...
search_fragment = | stats count by category1 category2 category3   # viz 選択時の初期SPL補完
supports_trellis = false
supports_drilldown = true
```
- `framework_type = studio_visualization` を**書かない**のが classic の目印。書くと Studio 拡張扱いになる。
- `label` と stanza 名が「ビジュアライゼーション一覧」への登録になる。

### 実装（`SplunkVisualizationBase` 継承）

`visualization_source.js` は AMD で `api/SplunkVisualizationBase` / `api/SplunkVisualizationUtils` を継承し、
ライフサイクルメソッドを実装する（circlepack_viz で確認したもの）:

- `getInitialDataParams()` — データ契約。`{ outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT, count: ... }` を返す。
- `formatData(data)` — 生データを描画用に整形。
- `updateView(data, config)` — 実描画（d3 等）。`config` に formatter.html で設定した値が入る。
- `setupView()` / `reflow()` — 初期化・リサイズ対応（任意）。

### `formatter.html`（編集画面のフォーマットパネル）

Web Components で組む。`{{VIZ_NAMESPACE}}` が option 名の接頭辞になる。circlepack_viz の例:

```html
<form class="splunk-formatter-section" section-label="General">
  <splunk-control-group label="Color set">
    <splunk-select name="{{VIZ_NAMESPACE}}.color" value="schemeCategory10">
      <option value="schemeCategory10">Bright</option>
      ...
    </splunk-select>
  </splunk-control-group>
  <splunk-control-group label="...">
    <splunk-color-picker name="{{VIZ_NAMESPACE}}.someColor"></splunk-color-picker>
  </splunk-control-group>
</form>
```
利用可能な要素例: `splunk-formatter-section` / `splunk-control-group` / `splunk-select` /
`splunk-text-input` / `splunk-radio-input` / `splunk-color-picker` / `splunk-color`。

### classic の位置づけ（このリポジトリでの判断）

- **1つ作れば Simple XML と Studio の両方で表示できる**唯一の方式。両対応が要件なら classic。
- ただし Splunk の推奨は「新規は Studio 拡張」。React 資産（既存 `visualizations/*`）を活かすなら Studio 拡張のまま。
- Splunkbase の既製「Custom Visualizations アプリ集（11種）」は 2024-12-21 EOL。ただし**自作の仕組み
  （`SplunkVisualizationBase` + `visualizations.conf`）は 9.x/10.x で現役サポート**（別物なので混同しない）。

---

## 参照リンク

- classic カスタム viz API リファレンス（Simple XML 用。10.4 でも現役）:
  https://help.splunk.com/en/splunk-enterprise/developing-views-and-apps-for-splunk-web/10.4/custom-visualizations-for-classic-simple-xml-dashboards/custom-visualization-api-reference
- Studio がカスタム viz を扱う分類（classic 後方互換と拡張の両方）:
  https://help.splunk.com/en/splunk-enterprise/developing-views-and-apps-for-splunk-web/10.4/custom-visualizations-for-dashboard-studio
- Custom Visualizations アプリ集 EOL FAQ（既製アプリ集の話。自作の仕組みは別）:
  https://lantern.splunk.com/Manage_Performance_and_Health/Splunk_Custom_Visualizations_apps_end_of_life_FAQ
