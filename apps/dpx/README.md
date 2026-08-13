# DPX

> ⚠ **リリース前（v0.1.0）です。** `0.x` の間は破壊的変更を予告なく入れることがあります。

**Splunk 上で動く完全独自のダッシュボード基盤**（アプリ ID: `dpx`）。
Dashboard Studio でも classic（Simple XML）でもなく、独立 React ページの上に自前の
ダッシュボードエンジンを載せたものです。「Splunk 上で動作し、Splunk にサーチが投げられる」
ことだけを前提に、**より映えるダッシュボードを自由に簡単に作れる**ことを目指しています。

実装ナレッジ（構成・スキーマ・viz の作り方・踏んだ罠・E2E ツール）は
[.claude/skills/splunk-viz/references/dpx-platform.md](../../.claude/skills/splunk-viz/references/dpx-platform.md)
に集約しています。**着手前にそちらを読むこと。**

## 構成（30秒版）

```
Splunk Web
 └ ホストビュー dpx（画面はこの1枚だけ。template="pages/splunk_ui_app.html" ＝ Splunk 同梱）
    └ pages/dpx.js                        ← 唯一のランタイム（ホーム＋ダッシュボード）
        /app/dpx/dpx            → ホーム（一覧）
        /app/dpx/dpx?id=<app>/<name> → ダッシュボード
 └ 定義ビュー（1 ダッシュボード = 1 ビュー XML。isVisible=False の入れ物）
    └ <definition><![CDATA[ DPX スキーマ v1 の JSON ]]></definition>
```

- 保存形式は Studio と同型（ビュー XML に定義 JSON を埋め込む）。REST で動的に作成できる
- **画面間は SPA 遷移（pushState）＝ページ再読込ゼロ**。ボード切替・ホーム往復に白は出ない
- viz は「props を受け取る素の React コンポーネント」を `vizRegistry.js` に登録するだけ
  （iframe なし・config.json なし・splunkd 再起動なし）
- **カスタム Mako テンプレートは不使用**（10.4.0 非推奨・AppInspect 4.4.0 から審査 fail の対象）。
  検討した代替案と全数調査の記録は dpx-platform.md §1.1 を参照

## 開発ループ

```bash
cd apps/dpx
rm -rf stage && NODE_OPTIONS=--max-old-space-size=8192 yarn build   # 本番ビルド
yarn package                                                        # dist/*.spl
node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/dpx/<view> --out /tmp/shots
```

---

## サンプルダッシュボード

| ファイル | 用途 |
|---|---|
| [`examples/aegis-soc.json`](examples/aegis-soc.json) | **ショーケース**。DPX でしか組めない構図を一枚にまとめたもの（下記） |
| [`examples/all-viz-check.json`](examples/all-viz-check.json) | 全 viz の描画確認用（30枚を並べただけ） |

### AEGIS / Global Threat Operations（ショーケース）

3タブ・25パネル・21データソース・14種の viz。**Studio では組めない**要素を意図的に集めてある:

- **左サイドバータブ**（`tabPosition: "left"`）
- **背景エフェクト**（`constellation`）がパネルの裏で常時動く
- **枠なしパネル**（`frameless`）で見出しと時計を地の上に直接置く
- **全幅の地図を1枚のキャンバスとして使う**（`frameless` + 12列。枠もタイトルバーも無い）
- 自作 viz（world-map / attack-globe / sunburst / sankey-flow / heat-matrix /
  timeline-swimlane / liquid-tube）とネイティブ viz を混在

⚠ **地図（world-map / attack-globe）の上に他のパネルを重ねない。**
DPX は `style.z` でパネルを重ね置きできる（Studio に無い機能）が、
**地図に対して使うと肝心の地形と着弾点が隠れる**。
重ねたガラスパネルは見栄えはするものの、地図の凡例・フロー一覧・
端の国（日本／オーストラリア）が読めなくなった（実機で確認して取りやめ）。
**重ね置きは「地図以外」で使う。** 地図は単独で全幅を与えるのが正解。

投入:

```bash
node tools/dashboard-loop/src/push.mjs apps/dpx/examples/aegis-soc.json --name dpx_aegis
```

⚠ **`makeresults format=csv` の CSV は本物の改行で書く。**
`\n` の2文字を埋め込むと**1行の壊れた CSV**になり、
**HTTP 200 のまま 0 行**が返る（エラーにならないので気づきにくい）。
⚠ **`eval` で日本語のフィールド名を参照するときは `'達成率'` と単引用符で囲む。**
囲まないとこれも **200 で 0 行**になる（このダッシュボードの作成中に実際に踏んだ）。

---

## ライセンス

**MIT License**（[LICENSE](LICENSE)）。

バンドルに含まれるサードパーティ OSS の著作権表示・許諾条文は
[THIRD-PARTY-NOTICES.txt](src/main/resources/splunk/THIRD-PARTY-NOTICES.txt) に同梱しています
（配布物である `.spl` にも両方が入ります）。

⚠ `@splunk/dashboard-studio-extension` など Splunk 提供のパッケージは OSS ではなく
Splunk General Terms が適用されます（OSS 通知とは別枠で参照情報のみ記載）。

---

## リリースノート

このセクションは [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠します。
バージョニングは [SemVer](https://semver.org/lang/ja/) です。

> **DPX はまだリリース前（0.x）です。**
> `0.x` の間は**破壊的変更を予告なく入れることがあります**（SemVer の 0.y.z の扱い）。
> **0.1.0 が最初のバージョン**です。これ以前に開発中の区切りとして付けていた
> 版番号（1.0.0〜1.8.0）と、その成果物は**この版で整理しました**。
> 経緯は git の履歴で追えます。

---

### [0.7.1] - 2026-08-13

#### 修正

- ⭐ **カスタム viz に質感がほとんど乗らない問題を修正**（ユーザー報告）。
  原因は `scale` が **px の固定値**で、**図形が大きいほど相対的に効かなくなる**こと。
  ゲージの弧（270px）では変位が約 1.5% しかなく、見た目が変わらなかった。
  → **図形の大きさに応じた倍率**（`SIZE_TIERS`）を導入し、
  フィルタを**段ごとの別実体**にした。
  ⚠ 小さい印は逆に**弱める**（効きすぎて壊れて見えるため）。上限もあり。

### [0.7.0] - 2026-08-13

**画材で文字が歪む問題を構造から修正（Ink Layer）。**

#### 修正

- ⭐ **画材が文字を歪ませなくなった。** 原因は画材の中身ではなく
  **filter をパネル全体に掛けていたこと**。「印」だけに当てる層を新設した。
  ⚠ **画材のパラメータ調整では直らない問題**だった（適用範囲の問題）。

#### 追加

- **Ink Layer**（`design/brush/ink.js` / `useInkFilter.js`・テスト 13 件）
  - `data-dpx-ink="mark"` で viz が**自分で印を宣言**できる（今後の viz 向け）
  - 宣言が無ければ **SVG の形状要素だけを自動検出**（既存 30 viz が無改変で対象）
  - `text` / `tspan` / `foreignObject` / `image` は**必ず除外**
- ⚠ **Canvas / WebGL の viz は既定で対象外**（文字が焼き込まれていて分離できない）。
  掛けたい場合は `panel.style.brushCanvas: true`。

### [0.6.0] - 2026-08-13

**Design Engine の 4 軸を編集パネルから触れるようにした。**
これまで `style.brush` / `style.motion` は **JSON 直接編集でしか設定できなかった**。

#### 追加

- インスペクタの「デザイン」に 3 つの設定を追加:
  - **グラフの画材**（`style.brush`）… なし / 色鉛筆 / クレヨン / 水彩 / インク / マーカー
  - **画材の強さ**（`style.brushIntensity`）… 0〜100%。⚠ **画材を選んだときだけ出す**
  - **動きの性格**（`style.motion`）… なし / 控えめ / スプリング / オーガニック
- E2E `dp-brushui-e2e.mjs` を追加し、回帰スイートに登録（**9 件**に）。
  「UI に出た」で終わらせず、**描画（filter 適用数）と定義の両方**を見る。

#### ⚠ 実装上の判断

- **選択肢は Design Engine から取る**（`BRUSH_OPTIONS` / `MOTION_OPTIONS`）。
  編集パネルに文字列を手書きすると、**画材を増やしたときに直し忘れて
  「実装したのに選べない」**になる。
- **画材を選ぶと注意書きを出す**。フィルタは描画結果に掛かるので
  **文字の輪郭も揺れる**。知らないと「ラベルが読めない＝不具合」と誤解される。
- 「動きの性格」には **`entrance` の明示指定が優先される**ことを hint に明記。

### [0.5.0] - 2026-08-13

**ディレクトリ構造の再編成（Phase 7）。図の層をそのままディレクトリにした。**

#### 変更

- **`engine/` を廃止**（直下に 31 ファイルが平置きだった）。
  トップレベルを `builder/ canvas/ renderer/ schema/ store/ layout/ viz/ design/ data/ shared/ pages/` に。
- **`DpxDashboard.jsx` → `renderer/DashboardRenderer.jsx`**（図の名前と一致させた）。
- **`dashboardSchema/` → `schema/`**、**`vizKit.jsx` → `viz/parts.jsx`**。
- ⭐ **Brush の実体を `design/brush/` に集約**（`material/brush/` と
  `design/brushFilter.jsx` に割れていた）。**Design Engine の 4 軸がすべて
  `design/` 配下に実体を持つ**ようになった。
- 移動と import 書き換えは機械化（`tools/restructure.mjs` / `tools/fix-imports.mjs`）。

#### 削除

- **`engine/themes.js`**（実体は `design/theme/` と `design/surface/`）。
- **`engine/material/`**。`material/index.js` は**中身が design barrel の
  再輸出＝循環**していたため廃止。`quality.js` は `design/quality.js` へ。

#### 追加

- 層テストに 2 件（`engine/` の復活検出・トップレベルが図と一致するか）。

### [0.4.0] - 2026-08-13

**構造の作り直し（Phase 6）。**
これまで「既存の動きが壊れるのを恐れて」見送っていた部分に手を入れた。
設計判断は [REARCHITECTURE.md](REARCHITECTURE.md) が正。

#### 追加

- **Viz SDK**（`components/engine/viz/`）。**viz が import してよいものの唯一の入口**。
  - `useVizData()` … サーチ結果の形を知る唯一の場所
  - `kit`（`toNum` / `fmtNumber` / `useContainerSize` / `EmptyHint`）
  - `types.js` … VizProps の契約（Studio 拡張と互換）
  - → **engine の内部を変えても viz が巻き添えにならない**
- **`engine/data/dos.js`**。DOS 文字列（`> primary | seriesByName("x")`）を Data 層へ。
- **未定義参照チェッカ**（`tools/check-undefined.mjs`・`yarn test` に組込）。
  ⚠ **ビルドが通るのに実機で真っ白になる**種類の事故を検出する。
- **E2E 回帰スイート**（`tools/dashboard-loop/src/dp-regression.mjs`）。
  固定フィクスチャで 8 件を 1 コマンド実行。**8/8 成功**。
- `dp-delete-view.mjs`（⚠ owner のネームスペース指定が要る）。
- 層の境界テストを 12 → 21 件（viz の契約・Theme/Surface 分離を固定）。

#### 変更

- **`nativeViz.jsx`（2,516 行）を viz ごとに 7 ファイルへ分割**（`engine/viz/native/`）。
  分割は機械的に行い、**本文が 1 文字も変わっていないことを検証**してから旧ファイルを削除。
- **`themes.js`（1,514 行）を Theme と Surface に分割**
  （`engine/design/theme/` / `engine/design/surface/`）。
  **211 個のテーマテストが全て通ることで同一性を確認**。
  `themes.js` は互換 barrel として残る。
- 図形・装飾・linkLine・SpikeViz を `engine/viz/` へ集約。

#### 修正

- **viz が Property Editor に依存していた層違反を解消**
  （`nativeViz.jsx` → `optionEditors.jsx` の `dosToField`）。
- 分割で作り込んだ不具合 2 件を修正（**どちらもビルドは通っていた**）:
  - `DEFAULT_STATUS_MATCHES is not defined` … `DpxStatus` の定数が `DpxValue` 側へ紛れた
  - `e.toFixed is not a function` … `DpxTable` のローカル `fmt` を機械置換で取り違えた
- 古くなっていた E2E ツール 6 件を修正（パネル ID・座標・セレクタの決め打ち、
  および**存在しない UI（↑↓ ボタン）を操作していた** `dp-inputorder-e2e`）。

### [0.3.0] - 2026-08-13

**理想の構成との差分を埋めた（Phase 5）。**
Dashboard Canvas と Splunk Data / Search 層を独立させ、
**目標としていた 11 個の層がすべてコード上の実体を持つ**状態になった。
設計判断は [REARCHITECTURE.md](REARCHITECTURE.md) が正。

#### 追加

- **Dashboard Canvas 層**（`components/engine/canvas/`）。
  編集モードの操作（ドラッグ・配置プレビュー・余白メニュー）を集約。
  - `useCanvasInteractions` … ドラッグと一時状態
  - `DashboardCanvas` … ストアに繋がった Renderer
- **Splunk Data / Search 層**（`components/engine/data/`）。
  `useSplunkSearch` / `dataSources` / `inputChoices` を barrel 経由に統一。
- **層の境界テスト**（`test/layers.test.mjs`・12 件）。
  依存の向きを機械で固定する（**コメントで書いた境界は必ず腐る**ため）。
  ソースへの制御文字の混入検査も含む。
- Property Editor に editor 型を 3 種追加：
  `editor.percent`（⚠ **UI 値の 1/100** を保存。Studio と同じ約束）/
  `editor.trellisSplitBy` / `editor.seriesColorsByField`。

#### 変更

- **Dashboard Renderer（`DpxDashboard.jsx`）が「描くだけ」になった。**
  ストアを import せず、ドラッグの実装も持たない。
  → **表示専用の用途（壁掛け・印刷・埋め込み）で編集コードを読み込まずに使える。**
- `DashboardPage` は `DpxDashboard` ではなく `DashboardCanvas` を使う。
  定義はストアから取るので `definition` を props で渡さない。

#### 修正

- **ソース 3 ファイルに混入していた生の NUL を除去**
  （`dataSources.js` / `material/brush/types.js` / `panelFields.jsx`）。
  実行時の値は変わらないが、**ファイルがバイナリ扱いになり `grep` が
  無言で何も返さなくなる**問題があった。
- E2E ツールのフィクスチャ決め打ちを引数化
  （`dp-dragpreview-e2e.mjs` / `dp-undo-e2e.mjs`）。
  ⚠ リサイズの掴み手は **8〜12px 内側**を掴む（4px では move 用の
  オーバーレイに覆われていて掴めない）。

### [0.2.0] - 2026-08-13

**アーキテクチャの再設計（Phase 1・2）。**
Dashboard Schema と State / Command 層を独立させ、今後
Visualization / Layout / Data Source / Material を**独立した拡張ポイント**として
足せる構造へ寄せた。進捗と設計判断は [REARCHITECTURE.md](REARCHITECTURE.md) が正。

> ⚠ **破壊的変更：スキーマ v1 の定義は読めません。**
> `schemaVersion: 2` が必須で、v1（`version: 1`）の定義は**理由付きで拒否**します
> （黙って壊さないよう「v1 の定義です」と名指しで伝えます）。
> 0.x のため互換は維持しない方針です。

#### 追加

- **Dashboard Schema v2**（`components/engine/dashboardSchema/`）。
  Zod による**型・検証・既定値・versioning** を 1 か所に集約
  - `vocab.js` … **列挙値と既定値の唯一の出どころ**（依存ゼロ・素の Node でテスト可）
  - `parse.js` … `parseDefinition()` が**唯一の入口**。
    エラーは**場所つきで理由を返す**（`panels.0.viz: ...`）
  - `layout: { type, grid }` に変更（**Layout Engine 差し替えの受け皿**。旧 `grid` 直下から移動）
  - **サーチは `dataSources` 参照のみ**（`search.spl` 直書きをスキーマで禁止）
- **State / Command 層**（`components/store/`）。zustand
  - `dashboardStore` … 定義＋履歴＋Command（`dispatch`）
  - `editorStore` … 選択・ダイアログ・プレビュー（**保存しない**）
  - **選択を `{kind, ids[]}` に統合**。パネル / 入力 / 区画の**排他が構造的に保証**され、
    `ids` が配列なので **Multi Select を足しても型が変わらない**
- テスト 58 件（`schema` 24 / `schemaVocab` 9 / `store` 25）

#### 変更

- **`DashboardPage.jsx` の `useState` を 20 → 3 に削減**（残りは真にローカルな値のみ）
- 既定値の適用を**スキーマへ集約**。コンポーネント側の `?? 'noc'` 等を撤去
  （**UI と実物がズレる不具合の構造的な再発防止**）
- `emptyDashboard` / `emptyDefinition` をスキーマへ委譲
- **`@splunk/react-search` を直接依存に昇格**。
  ⚠ `SplAce.jsx` が実際に `require` しているが、これまで
  **`@splunk/dashboard` 経由の推移的依存に頼っていた**（消すと SPL エディタが壊れる状態だった）

#### 削除

- `engine/schema.js`（v1 判定 17 行）と、その全参照
- **未使用の `@splunk/dashboard*` 6 パッケージ**
  （`dashboard` / `dashboard-context` / `dashboard-core` / `dashboard-presets` /
  `dashboard-state` / `datasources` / `visualization-context`）

#### 修正

- **早期 return がストアの初期値 `idle` をすり抜け、`def=null` で描画に進んで
  画面が落ちる**（`Cannot read properties of null (reading 'tabs')`）。
  **ビルドも単体テストも通り、実機でのみ再現した**。
  → 条件を否定形（`phase === 'loading'`）から**肯定形**（`phase !== 'ready' || !def`）へ
- ヘッダのスタンプが `DPX v1` 固定だったのを **`SCHEMA_VERSION` から導出**
- **E2E ツール 12 本の URL が 1 ビュー集約前の形のまま**だった
  （`/app/{app}/{view}` → `/app/dpx/dpx?id={app}/{view}`）。
  あわせて `dp-save-check`（Studio 時代の `aria-label` セレクタ）・
  `dp-settings-e2e`（プリセット表示名の決め打ち・項目が `div` だと誤認）・
  `dp-group-e2e`（パネル ID `h1` の決め打ち）を修正。
  **いずれも DPX 側の退行ではなく、ツールが古かったもの**

#### 追加（Phase 3・Layout Engine）

- **Layout Engine**（`components/engine/layout/`）。
  **grid / freeform を差し替え可能な実装**として分離し、
  Renderer の座標計算（配置・寸法・ドラッグ・リサイズ・区画移動・コンテナ）を
  **すべてエンジン経由**にした
  - `gridLayout` … 現行の挙動をそのまま抽出（**見た目は 1px も変えていない**）
  - `freeform` … **px 絶対配置**＋スナップ（既定 8px）。グリッドに縛られない構図が組める
  - `switchLayoutType()` … **切替時に座標を変換する**
    （変換しないと「セル 6」が「6px」になり全パネルが左上に固まる）
  - ⭐ **座標のキー（`x/y/w/h`）は共有し、単位だけ変える**。
    別キーを足さないので**移動・複製・区画・undo の既存処理がそのまま効く**
- `layout.freeform.snap` をスキーマに追加
- テスト 32 件（`test/layout.test.mjs`）。
  **座標計算はテストで押さえる**（枠のズレは 1 マスずれても目視で気づけない）

#### 修正（Phase 3）

- **freeform でパネルが縦に積まれる**。パネル本体に `position:'relative'` が
  ベタ書きされており、エンジンの `absolute` を**後から上書き**していた
  （`left/top` は正しく入っているのに絵が合わない、という紛らわしい出方）
- **`convertToGrid` が幅をクランプせず、12 列を超えたパネルが残る**（テストで検出）
- 区画のクランプが **`-0`** を返しうる（`Math.max(-0, …)` の仕様。テストで検出）

#### 追加（Phase 4・Material Engine）

- **Material Engine**（`components/engine/material/`）。
  質感・配色・背景・アニメーションを **1 つの層として境界を宣言**した
  - **`<MaterialSurface material intensity>`** … 質感を「中身」から切り離して被せる。
    ⚠ 触るのは **Surface / Background / Border / Shadow / Overlay / Animation** だけで、
    **viz 内部の色や描画には干渉しない**（＝同じ Studio 拡張 viz を
    Flat / Liquid Glass / Watercolor の上に載せられる）
  - **`useMaterial()`** … viz 側から Material の文脈を読む口（参照は任意）
  - ⭐ **品質レベル**（`full` / `reduced` / `minimal`）。
    パネル数と **`prefers-reduced-motion`** から自動判定し、
    重い指定（`backdrop-filter` → 影・発光・アニメの順）を落とす。
    `style.quality` で明示指定もできる
  - ⚠ **`themes.js` は物理移動していない**（意図的）。中身は既に Material Engine
    そのもので、移動すると 25 質感 × 18 配色の巨大 diff になりレビュー不能なうえ、
    実機でしか見つからなかった知見を壊すリスクがある。
    **境界の宣言（`material/` から再輸出）**にとどめた
- テスト 24 件（`test/material.test.mjs`）

#### 追加（Registry の機械生成）

- **`tools/gen-viz-registry.mjs`**。`visualizations/*` を走査して
  `vizRegistry.generated.js` を出力する。
  ⭐ **新しい Studio 拡張 viz は `src/host.jsx` と `config.json` を置いて
  生成し直すだけ**で Component Palette / Property Editor / Renderer から使える
  - `vizRegistry.js` は **187 行 → 100 行**（手書きの import 60 行が消えた）
  - **`yarn test` に `--check` を組み込み済み**＝再生成忘れを機械的に検出
  - `yarn gen:registry` で再生成

#### 変更

- パネルの質感 CSS は **`applyQuality()` を通す**ようになった
  （品質レベルの適用漏れを防ぐため、`panelSurface()` の直接呼び出しを増やさない）

#### 追加（Brush Engine）

- **Brush Engine**（`components/engine/material/brush/`）。
  **グラフの線と塗りに画材の質感**を与える層（Surface＝面の質感とは別軸）
  - 対応 viz: **折れ線 / 棒 / ドーナツ / ランキング**（`style.brush` で切替）
  - 画材: 色鉛筆 / クレヨン / 水彩 / インク / マーカー
  - ⭐ **`flat`（既定）では従来の描画経路をそのまま通る**＝完全な後方互換
    （実機で「flat の brush 経由 path が 0 本」を確認済み）
  - ⭐ **当たり判定は元の geometry のまま**。ホバー・ツールチップ・
    時間ブラシ・ドリルダウンは影響を受けない（実機確認済み）
  - ⭐ **決定論的 seed**。再描画・再サーチで手描きの形が変わらない
  - ⚠ **CSS の div で描く viz（棒・ランキング）は `BrushOverlay`** で
    元の div を残したまま SVG を重ねる（構造を書き換えるとインタラクションが全滅するため）
  - 描画ライブラリ（rough.js）は `brushes.js` に閉じ、公開 API には出さない
- テスト 22 件（`test/brush.test.mjs`）

生成した `.spl`: `dist/dpx-0.2.0-34f994c.spl`

---

### [0.1.0] - 2026-08-13

**最初のプレリリース。**

#### 追加

- **ダッシュボードの複製**（ホームの行「…」→ 複製）:
  - パネル・データソース・タブ・入力を丸ごと引き継いで新しいボードを作る。
    **別のアプリへコピーもできる**（保存先を選べる）
  - ID は `<元のID>_copy` を自動で提案し、**既存と衝突しない番号まで付ける**
    （`_copy` → `_copy2` …）
- **新規作成ダイアログでテーマを選べるように**:
  - 18 プリセットを **名前ではなく「地の色そのもの」** で並べるピッカー
    （一覧の行スウォッチと同じ描き方）。従来は常に midnight の空板だった
- **名前の変更**（ホームの行「…」→ 名前を変更）:
  - 従来は 編集 → インスペクタ → 保存 の3手が必要だった。
    **ID は変えない**ので既存のリンクはそのまま使える
- **JSON の書き出し / 取り込み**:
  - 行「…」→「JSON を書き出し」で定義を `.json` としてダウンロード
  - トップバーの「取り込み」から `.json` を選ぶと、作成ダイアログに載せて新規作成
  - **取り込みは作成前に検証し、理由を出す**（壊れた JSON / トップレベルが配列 /
    `version`・`panels` が無い / **Dashboard Studio の定義**）。
    Studio の定義は「Studio のもののようです」と名指しで伝える

- **背景にも手描きの質感を追加**（5種。パネル枠と同じ canvas 実描画）:
  `紙の目`（繊維と粒）／`手描きの方眼`（定規を使わず引いた升目＝線がふらつき間隔も揃わない）／
  `クレヨンの塗り`／`鉛筆のハッチング`／`インクの飛沫`
  - ⚠ **静止画として1回だけ描く**（`StaticCanvas`）。紙と画材は動かないし、
    全面 canvas を毎フレーム描くと面積比例の raster コストが乗る。
    **1920×1080 で5種とも 60fps を実測**
  - 選択肢のグループに「手描き」を新設（背景は 35 → 40 種）
- **背景エフェクトを 23 → 35 種に**（12 種追加。すべて実機で描画確認済み）:
  - アニメーション5種：`流星`（疎らに走る光跡）/ `レーダー`（掃引線＋同心円）/
    `バブル`（昇る泡）/ `スノー`（揺れながら降る粒）/ `ホタル`（個体ごとに明滅）
  - パターン4種：`アイソメ`（60/120度の立体方眼）/ `シェブロン`（山形）/
    `カーボン繊維`（綾織り）/ `図面枠`（外周の二重罫。中央は塗らない）
  - グラデーション3種：`スポットライト`（中央だけ明るい）/
    `コーナーグロー`（四隅から。中央が空くので読みやすい）/ `斜光`（窓から差す光）
  - ⚠ **1920×1080・パネル6枚で全て 60fps を実測**（既存の `パーティクル` と同値）。
    canvas 系は線・点のみで描き、CSS 系は静的レイヤ＝合成一度きりにしてある
- **出現アニメを 6 → 12 種に**:
  `ドロップ（上から）`（着地して軽く跳ねる）/ `スライド（右から）` /
  `ポップ（縮小）` / `アンフォールド（横）` / `スイング（Y 軸）` / `ティルト`（紙を置く動き）
  - パネルは index×70ms でずれて出るので、方向のあるものは**盤面を波が走る**ように見える
  - ⚠ 動かすのは `transform` / `opacity` だけ（`filter` / `box-shadow` を動かすと
    毎フレーム再描画になる）。この規約はテストが機械的に検査する

#### 変更

- **手描き画材4種（クレヨン／色鉛筆／水彩／インク＋水彩）の線を「本物」にした。**
  - **何が問題だったか**: 当初の実装は `repeating-linear-gradient` と
    `box-shadow` で質感を「それっぽく」見せていた。しかし CSS が作れるのは
    **完全な直線・等間隔・均一な太さ**だけで、画材の本質——
    線がふらつく／筆圧で濃さと太さが変わる／紙の目でかすれる／縁を二度なぞる
    ——を一つも表現できていなかった（ユーザー指摘：「小手先の CSS で理想とは遠い」）
  - **どう変えたか**: パネル枠を **canvas で実描画**するようにした
    （`handDrawn.js` / `HandDrawnFrame.jsx`）。形のゆらぎは **rough.js**（MIT・
    バンドル増は約 40KB）に任せ、画材固有の「乗り方」（重ね塗り・かすれ・
    紙の目）は自前で描く
  - **CSS のまま残した部分**: 水彩の「エッジの濃まり」やインクのウォッシュなど、
    **面の表現は CSS が苦手ではない**ので据え置いた。置き換えたのは「線」だけ
  - 各プリセットに `paperColor`（紙そのものの色）を追加。
    canvas 側が「顔料が乗らなかった凹み」をこの色で置く
  - ⚠ **描画は決定的**（seed をパネル ID から作る）。乱数のままだと
    React の再描画のたびに枠の形が変わってチラつく

- **テーマ・質感の名前を短くし、並び順を整理した**（見た目を選ぶ3つの一覧が対象）:
  - **括弧書きの説明を全廃**（`カーボン（無彩色・硬質）` → `カーボン`、
    `コーナーフレーム（四隅のカギ括弧）` → `コーナーフレーム`）。
    選択肢が18〜25個あるので、括弧付きだと**一覧で名前が切れて読めなかった**
  - **配色プリセット**は「暗い画面 → 明るい紙 → 画材 → ガラス」順に。
    並び順は `PRESET_ORDER` が持つので、**定義の場所を動かさずに変えられる**
  - **パネルの質感**は「素っ気ない → 装飾的」順に（基本形 → 光り物 → 紙もの → 画材）
  - **背景エフェクト**はグループ内で近いものを隣に。`星空` は
    グループ「キャンバス」1件だけだったので「アニメーション」に統合
  - ⚠ 変わったのは**表示名と並びだけ**で、定義に保存される値（`preset` / `variant` /
    `background`）は不変。**既存のダッシュボードには影響しない**
  - `タイトルの質感`・`出現アニメ`も同様に短縮（ただし
    `自動（質感に合わせる）`・`ライズ（下から）`・`スライド（左から）` の括弧は、
    **説明ではなく識別に要る情報**なので残した）

#### 修正

- **横長のパネルで手描きの枠が内側にたわんでいた**のを修正。rough.js の `bowing` は
  辺の長さに比例して弓なりになるため、幅 780px のパネルで顕著だった（実機で確認）。
  辺が長いほどゆらぎを弱める（実際の手描きも「長い線ほど相対的にまっすぐ」）
- **手描きの枠がタイトルやグラフに食い込んでいた**のを修正。canvas の枠は
  CSS の `border` と違い**レイアウト上の幅を持たない**ため、そのままでは中身に重なる。
  パネル側に枠のぶんの余白（`HAND_DRAWN_INSET`）を確保した
- **テーブルの見出し帯・行の縞が手描きの枠を塗り潰していた**のを修正。
  枠を中身より**前面**に出した（`pointerEvents:'none'` なのでクリックは透過する）。
  実際の画材でも「紙の上に描いた線」は中身の上に乗るので、物理的にもこちらが正しい。
  ⚠ あわせて**紙の目は枠の帯の内側には撒かない**（前面にあるので、
  全面に撒くとグラフや文字の上に粒が乗って汚れて見える）
- **折れ線グラフの右端の時刻ラベルが見切れていた**のを修正（以前からの既存不具合）。
  `padR` が 14px しかないのに両端のラベルも中央揃え（`textAnchor="middle"`）だったため、
  `08:01` のようなラベルの右半分がはみ出していた。**両端だけ内側へ寄せる**
  （右端＝右揃え／左端＝左揃え）。padR を広げる案は、プロット領域が常に狭くなるうえ
  ラベルの文字数で必要量が変わるため採らなかった
- **日本語だけのタイトルで ID が空になり、「作成」が押せないまま理由も分からなかった**
  問題を修正（`売上ボード` → slugify の結果が空文字だった）。
  ASCII が残らないときは日付ベースの一意な ID（`dpx_YYYYMMDD_hhmmss`）を宛てがう

#### 内部

- `roughjs` を依存に追加（MIT）。
- **OSS 通知を共通ジェネレータに載せ替えた（3 件 → 45 件）。**
  - **問題**: 通知に載っていたのは 3 件だけで、**実際にバンドルされている 45 件のうち
    42 件が記載漏れ**だった（react-dom / styled-components / lodash / d3-* など）。
    MIT・BSD・Apache-2.0 はいずれも「複製物に著作権表示と許諾条文を含めること」が
    条件なので、これは**ライセンス条件を満たしていない状態**だった
  - **対策**: `visualizations/*` が既に使っていた **共通ジェネレータ
    `scripts/gen-third-party-notices.mjs`** に載せ替えた（`yarn notices`）。
    ファイル名も他と揃えて `THIRD_PARTY_NOTICES.txt` にした
  - ⚠ **DPX 専用のジェネレータを作りかけたが廃棄した。** 共通のほうが厳格
    （**指紋照合**・ライセンス宣言が無いパッケージで**失敗**・非 OSS を別枠に分離・
    `notices-data.json` での同梱素材の申告）。**新しく作る前に既存の仕組みを探すこと**
  - **共通ジェネレータを webpack にも対応させた**（`WEBPACK_STATS`）。
    `visualizations/*` は esbuild（metafile）、`apps/*` は webpack（stats）とビルド方式が
    違うため、これまで apps/* が対象外になっていた（**穴はここだった**）
  - **`bin/package.mjs` に指紋照合を追加**：通知がバンドル内容と食い違う `.spl` は
    **作れない**（実際に指紋を書き換えて落ちることを確認済み）
  - ⚠ **DPX は姉妹 viz の `node_modules` も踏む**（移植した viz を import しているため）。
    パッケージ名だけで探すと `d3-sankey` 等を取りこぼすので、**解決パスごと**集める
  - ⚠ `styled-components` は **npm パッケージに LICENSE ファイルを含めていない**。
    共通ジェネレータは**条文を捏造せず**「宣言のみ（原文は配布元参照）」と事実だけ書く
- `test/handDrawn.test.mjs` を追加（33 アサーション）。
  **最重要は「乱数の決定性」**（同じ seed が同じ列を返すこと）。
  ここが壊れると「画面がなんとなく落ち着かない」という形で現れ、原因特定が難しい
- `themes.test.mjs` の手描き4種の検査を新しい契約に合わせて更新
  （「CSS の偽の線を持たないこと」＋「canvas 実描画の指示があること」）
- `isDpxDefinition` を `engine/schema.js` に、取り込み検証を
  `engine/importDefinition.js` に切り出した。
  **viewStore は `@splunk/splunk-utils`（ブラウザ専用）を読むため素の Node から
  import できずテストが書けない**ので、純粋なロジックだけを依存ゼロの側へ寄せた。
  従来の import 先を壊さないよう viewStore から再輸出している
- `test/importDefinition.test.mjs` を追加（13 アサーション）
- `themes.test.mjs` に**名前と並び順の退化を防ぐ検査**を追加
  （括弧書きの再混入・`PRESET_ORDER` への足し忘れ・幽霊キーを検出。
  実際に壊して落ちることを確認済み）
- `test/backgrounds.test.mjs` を追加（12 アサーション）。
  **選択肢と実装のズレは無言で失敗する**（一覧にあるのに実装が無い＝背景が消える／
  実装したのに一覧に無い＝死にコード／`@keyframes` の名前間違い＝アニメが効かない）ため、
  ソースを文字列として突き合わせる。こちらも実際に壊して落ちることを確認済み

生成した `.spl`: `dist/dpx-0.1.0-3647297.spl`
