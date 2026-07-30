---
name: splunk-viz
description: Splunkのカスタムビジュアライゼーション(React/JSX, Dashboard Studio向け)を作る。/splunk-vizで明示的に呼び出す。
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# Splunk カスタムビジュアライゼーション開発スキル

Splunk向けのカスタムビジュアライゼーション(React/JSX)を開発する際は、以下の要件に必ず従うこと。

## 最初に読む：実装ナレッジ（必読）

**新規作成・改修に着手する前に必ず [references/studio-extension-viz.md](references/studio-extension-viz.md) を読むこと。**
Dashboard Studio 拡張 viz の実装ナレッジを集約している:

1. プロジェクト構成 / スケルトン複製 / ビルド・パッケージ手順
2. 実装の定番パターン（テーマガード・データ正規化・オートフィット・堅牢性チェックリスト）
3. editorConfig と editor 型（実在する25種の一覧と可否判定、選択肢は `editor.select`、無効型の症状）
4. **値→色マッピング**：`editor.dynamicColor` はカスタムvizで使えない（配列がoptionsに来ない）。範囲→色は **`editor.threshold`**（配列が生で届く）、連続グラデーションは自前のカラースケール
5. ローカル検証（happy-dom で実機なしにバンドルを叩く）
6. デプロイ（アンインストール・再起動なし。`_bump`）
7. GitHub 運用（モノレポ `Aria-1429/custom-viz`、push はユーザー手動）
8. データモデルの型
9. **同梱データ・素材のライセンス**：バンドルする地図/データ/素材は著作権フリー（パブリックドメイン）のみ。地図は Natural Earth が第一候補。出典表記が必須の素材は使わない

タスクに関係する章は、着手前に該当箇所を Read すること。

**カスタム viz には2方式ある**（classic / Studio 拡張）。どのダッシュボードで使うかで選ぶ。
方式の取り違えは「一覧に出ない」で詰まるので、迷ったら [references/custom-viz-methods.md](references/custom-viz-methods.md) を先に読む:
- **classic**（`SplunkVisualizationBase` + `formatter.html`、`visualizations.conf` に `framework_type` なし）
  … **Simple XML と Dashboard Studio の両方で表示できる**唯一の方式。
- **Studio 拡張**（このリポジトリの `visualizations/<name>/`。`framework_type = studio_visualization` + `config.json`）… Studio 専用。

## 開発方針

- Reactベースで開発する。
- 成果物はReactコード(.jsx)そのもの。画像やスクリーンショットではない。
- 添付されたjsxファイルがある場合は、それをベースに実装する。
- 出力は必ずファイル全体(完成版)とする。差分やスニペットのみの提示は禁止。コピペしてそのまま動かせる状態にすること。
- サーチ結果(SPLの実行結果)に応じて表示内容が変わるように実装する。デフォルトのSplunkビジュアライゼーションと同様、データドリブンな描画にすること。
- デフォルトのビジュアライゼーションと同様に、ダッシュボードの編集画面でグラフの色などのオプションを設定できるようにする。ユーザーが設定したオプションは `useOptions` で取得する。
- **編集画面のオプションラベルは日本語で書く**（`config.json > editorConfig` のセクション `label`・各項目の `label` とも。例:「表示」「タイトルを表示」「アニメーション周期（秒、0で停止）」）。オプションのキー名(`option` / `optionsSchema`)は英語のまま。既存 viz を改修するときも英語ラベルが残っていれば日本語化する。
- **オプションの性質に合った editor 型を選ぶ**（数値やチェックボックスで代用しない）。
  設定項目を追加するときは、まず「この値は何型か」を考えてから editor を決める:

  | 値の性質 | 使う editor | 例 |
  |---|---|---|
  | 3つ以上の選択肢から1つ | **`editor.select`**（ドロップダウン） | 判定モード、質感、レイアウト |
  | 2〜4択で常時見せたい | **`editor.radioBar`** | 配置（左/中/右）、並び順 |
  | ON/OFF | `editor.checkbox` / `editor.toggle` | 〜を表示 |
  | 連続量 | `editor.number` | サイズ(px)、上限件数 |
  | 範囲が決まった連続量 | `editor.slider`（`{min,max,step}`） | 不透明度 0〜1 |
  | 割合（%表示・内部は比率） | `editor.percent`（⚠ **UI値の1/100が届く**） | 不透明度（5→`0.05`） |
  | 自由入力の文字列 | `editor.text` | 単位ラベル |
  | 色 | `editor.color` | 背景色 |
  | **範囲→色のマッピング**（動的に増減） | **`editor.threshold`**（`[{from,to,value}]` が届く） | しきい値の色分け |
  | 色パレット（系列色） | `editor.seriesColors`（`["#7B56DB",…]` が届く） | 系列ごとの色 |
  | 複数オプションの一括切替 | `editor.presetSelector` | 配色プリセット |
  | フィールド名→色 | `editor.seriesColorsByField`（`{field: 色}` が届く） | フィールド別の色 |
  | 文字列のリスト | `editor.arrayOfStrings` | 除外キーワード |
  | フィールド選択（1つ） | `editor.trellisSplitBy`（生のフィールド名が届く） | 分割フィールド |
  | **フィールド選択（複数）** | **`editor.columnMultiSelectionByFieldNameEditor`**（生のフィールド名配列） | 対象フィールド群 |
  | フィールド選択 | `editor.columnSelector`（⚠ DOS 文字列で届く。要パース） | ラベル列、値列 |

  **使ってはいけない型**（実機確認済み。editorConfig 全体が消える／操作不能になる）:
  `editor.marks` / `editor.seriesLineTypes` / `editor.seriesLineTypesByField`（`Invalid editor type`）、
  `editor.dynamicColor` 系4種（DOS 式しか届かない）、
  **`editor.tableDynamicColor` / `editor.tableColumnFormatter`（編集パネルが操作不能になる）**。

  **禁止パターン**（過去の viz に実在する。見つけたら直す）:
  - ❌ **選択肢を数値コードにする**：`「判定モード（0=自動 / 1=数値 / 2=文字列）」` を `editor.number` で作る。
    → `editor.select` にして `editorProps.values` にラベルを持たせる。ユーザーに数字の意味を覚えさせない。
  - ❌ **排他的な選択をチェックボックス複数で作る**：`sortByPeak` + `sortByTotal` のように
    「両方ON」が未定義動作になる組み合わせ。→ 1つの `editor.select`（`none`/`peak`/`total`）にまとめる。
  - ✅ 独立してON/OFFできるもの（`sortRowsByTotal` と `sortColsByTotal` など）は checkbox のままでよい。

  `editor.select` / `editor.radioBar` の書き方と、使える editor 型 25 種の全一覧・可否判定は
  [references/studio-extension-viz.md](references/studio-extension-viz.md) の「editorConfig と editor 型」章を参照。
- 参考資料の公式ドキュメントを参照し、Splunkのベストプラクティスに従うこと。
- パッケージ化する際はバージョンを更新すること．（詳細は「デプロイ／リリース運用」を参照）

## デプロイ／リリース運用

新規作成・改修してパッケージ化するときは、以下を必ず行う。

- **リリースノートの追記とバージョン更新は成果物の一部として Claude が自動で実施する**（ファイルを書くところまで）。
- **ただし git のコミット／プッシュは Claude が行わない**。`git add` / `git commit` / `git push` はユーザーが手動で行う。作業後は「どのファイルを更新したか」を伝えるにとどめ、勝手にプッシュしないこと（ユーザーが明示的に依頼した場合を除く）。

- **リポジトリ**：モノレポ `Aria-1429/custom-viz`（private / `main`）に各 viz を `visualizations/<name>/` として収録する。1 viz = 1 repo は廃止済み。
  （フォルダ名は `<name>`＝プレフィックスなし、Splunk のアプリ ID は `custom_viz_<name>`。）
- **バージョン更新**：`package.json` の `version` を SemVer で上げる（新規=`1.0.0`、機能追加=minor、修正=patch）。`config.json` 等のバージョンも整合させる。
- **`.spl` はリポジトリに含める（旧版も残す）**：
  - パッケージ成果物 `dist/<app>-<ver>-<hash>.spl` はコミット対象。ファイル名にコミットハッシュが入るため複数併存するが、**旧バージョンの `.spl` も削除せず残す**方針（更新履歴を追えるようにするため）。
  - `.gitignore` は「`dist/*` は無視、`!dist/*.spl` で `.spl` だけ救済」の形にしてある（ルート＋各 viz の両方に必要。過去に各 viz 直下の `.gitignore` を見落としてハマった）。新しい viz を追加したら同じ 2 行が入っているか確認する。
- **リリースノートを追記する（必須）**：各 viz 直下の `README.md` 末尾の「## リリースノート」セクション（[Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) 準拠 / SemVer）に、履歴先頭（区切り線 `---` の直下）へ新エントリを追記する。**独立した `RELEASE_NOTES.md` は廃止済み**（2026-07-22 に README へ統合。README 内では見出しを1段下げる）。
  - 見出し：`### [x.y.z] - YYYY-MM-DD`
  - 変更種別の見出し（`####`）で整理：`追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`
  - 生成した `.spl` のパス（`dist/....spl`）も記載する
  - まだリリースノートセクションが無い viz を作るときは README 末尾に新設し、`1.0.0` に「新規作成（初回リリース）」を書く
- **ルート `README.md`（リポジトリ直下）の一覧も必ず更新する（必須）**：
  各 viz の README とは**別物**。リポジトリ直下の `README.md` にはジャンル別の viz 一覧表があり、
  各行が `プレビュー画像 | 名前 / バージョン | 概要` になっている。ここを更新し忘れると
  **一覧のバージョンと概要が実物と食い違う**（2026-07-28 に world-map で実際に発生。
  v1.7.0 まで上げたのに一覧は v1.3.0 のまま、説明も「Severity で色分け」と旧仕様のままだった）。
  - **バージョン更新時**：該当行の `<br>vX.Y.Z` を新しい版に直す。
  - **機能を足した／仕様を変えたとき**：同じ行の「概要」も実物に合わせて直す。
    特に**破壊的変更**（オプション名の変更・挙動の一般化など）は概要に反映する。
  - **新規 viz を作ったとき**：適切なジャンルの表に行を追加する
    （プレビュー画像のパスは `visualizations/<name>/examples/example.png`）。
  - 確認コマンド（README の版と `package.json` の版がずれていないか）:
    ```bash
    for d in visualizations/*/; do n=$(basename "$d"); [ -f "$d/package.json" ] || continue
      a=$(node -p "require('./$d/package.json').version" 2>/dev/null)
      r=$(grep -A0 "visualizations/$n/)" README.md | grep -oP '<br>v\K[0-9.]+' | head -1)
      [ "$a" != "$r" ] && echo "差異 $n: README=v${r:-なし} 実際=v$a"; done
    ```
    （`editor-probe` は検証用でリポジトリ一覧に載せないため、`README=vなし` と出るのが正常）
- **実機デプロイ**：アンインストール・再起動は不要。`version` を上げ、Splunk の Upgrade チェックを通し、`_bump` ＋ハードリロードで反映する（詳細は [references/studio-extension-viz.md](references/studio-extension-viz.md) の「デプロイ」章）。

### コミット／プッシュを依頼されたときのチェックリスト

**ユーザーが明示的に依頼した場合のみ**実行する（既定は「Claude は push しない」）。
依頼されたら、コミット前に以下を確認する:

1. **ルート `README.md` の該当行**（バージョン・概要）が最新か ← **忘れやすい**
2. 各 viz の `README.md` にリリースノートを追記したか
3. `package.json` と `package/app/app.conf` のバージョンが一致しているか
4. **`yarn build:prod` && `yarn package`** 済みで、`.spl` が最新コードと一致しているか
   （**`yarn build` は開発ビルド**。sourcemap 入りの巨大 `.spl` になる。
   `tar -tzf dist/<最新>.spl | grep '\.map$'` が空であること）
5. `yarn verify` が全件成功しているか（**package 後の本番ビルドに対して**回す）
6. 混入チェック：`git diff --cached --name-only | grep -E 'node_modules|/stage/|\.map$'` が空

## 依存パッケージ

- Reactコンポーネントは新規インストールしてよい。より良い実装になるなら積極的に検討する。
- 追加するコンポーネントは `yarn add <package>` のコマンドを必ず提示する。

## 制約

- 成果物(実装するjsxコード)は本番のSplunk環境で動作するため、インターネット通信を行うコード(外部APIフェッチ、CDN読み込み等)を含めてはならない。
- 開発時(このスキル実行中)にClaude自身が外部サイトを参照して情報収集することは問題ない。下記「参考資料」のサイトは必要に応じて参照してよい。
- **同梱するデータ・素材（地図データ、GeoJSON/TopoJSON、アイコン、フォント、画像、辞書・参照データ等）は、著作権フリー（パブリックドメイン）またはそれ相当のもの「だけ」を使う。** クレジット表記・出典明記・利用報告・承認申請のいずれかが「必須」となる素材は使わない（MIT/BSD/ISC 等の緩いコード系ライセンスは**素材選定としては可**。ただし**配布時に条文の同梱が必要**＝下記の別項目、およびデータ本体のライセンスを別途確認する）。判断できない場合は必ずライセンス原文で確認し、確実にフリーと言えないものは採用しない。代表例:
  - **地図データ**：Natural Earth（パブリックドメイン・クレジット不要）を第一候補にする。`world-atlas`（Natural Earth の再配布）も可。行政区画（州/都道府県=Admin-1）が要る場合は Natural Earth の `ne_10m_admin_1_states_provinces` から抽出する。**国土地理院「地球地図日本」/ GADM / OpenStreetMap 由来（出典表記や継承ライセンスが必須）は使わない。**
  - 素材を加工して同梱する場合も、元素材が上記条件を満たすことを確認する。
  - 詳細な判断基準・調達手順は [references/studio-extension-viz.md](references/studio-extension-viz.md) の「同梱データ・素材のライセンス」章を参照。
- **バンドルした OSS のライセンス条文を配布物に同梱する**（MIT / ISC / BSD / Apache-2.0 はいずれも
  「複製物に著作権表示と許諾条文を含めること」が条件。Splunk App EULA も遵守を求めている）:
  - **対象は `package.json` の `dependencies` から決めてはいけない。**
    `react` / `styled-components` / `@splunk/react-ui` 等は devDependencies だが
    `external` 指定が無いためバンドルされる。**`dependencies` が空の viz も対象**。
  - 判定は **esbuild metafile の `outputs[*].inputs`**、条文取得は
    **`yarn licenses generate-disclaimer`**（手で書き写さない）。
  - `@splunk/dashboard-studio-extension` は **OSS ではない**（Splunk General Terms）。
    OSS 通知に契約全文を貼らず、参照情報のみ別枠にする。
    ただし**このパッケージを使った開発・成果物の配布は問題ない**。
  - 手順・実測値・落とし穴は [references/studio-extension-viz.md](references/studio-extension-viz.md)
    の「バンドルした OSS のライセンス通知」章を参照。
- CSSは原則いじらない。どうしても必要な場合のみ最小限の変更にとどめる。
- GihHubへのコミットやプッシュは行わない。これらの操作はユーザーが手動で行う。

## 参考資料

実装にあたり、以下の外部サイトを必要に応じて参照する:

- Splunk公式 Dashboard extension API reference (Dashboard Studio向けカスタムビジュアライゼーション用React API)
  https://help.splunk.com/en/splunk-enterprise/developing-views-and-apps-for-splunk-web/10.4/custom-visualizations-for-dashboard-studio/dashboard-extension-api-reference

  `@splunk/dashboard-studio-extension/react` が提供する主要フック:
  - `useDataSources` — サーチ結果(`{ dataSources, loading }`)を購読する。表示内容をサーチ結果に応じて変える際の中核。
  - `useTheme` — ダッシュボードのテーマ(`light`/`dark`)を購読する(`{ theme }`)。undefinedの場合はレンダリングしないガード処理に使う。
  - `useDimensions` — ビジュアライゼーションの幅・高さ(`{ width, height }`)を購読する。
  - `useOptions` — ユーザーが設定したビジュアライゼーションオプション(`{ options, setOptions }`)を購読する。ダッシュボード編集画面でのオプション設定に対応する際の中核。
  - `useMode` / `useTokens` / `useError` — 必要に応じて利用。

  ルートは必ず `VisualizationExtensionProvider` でラップする:
  ```jsx
  import { VisualizationExtensionProvider } from '@splunk/dashboard-studio-extension/react';

  function App() {
    return (
      <VisualizationExtensionProvider>
        <MyVisualization />
      </VisualizationExtensionProvider>
    );
  }
  ```

- Splunk公式 Create custom visualizations for Dashboard Studio with the Splunk dashboard extension CLI(プロジェクト構成、`config.json`の位置づけ)
  https://help.splunk.com/en/splunk-cloud-platform/developing-views-and-apps-for-splunk-web/10.4.2604/custom-visualizations-for-dashboard-studio/create-custom-visualizations-for-dashboard-studio-with-the-splunk-dashboard-extension-cli

- Splunk公式 ベストプラクティス(ドリルダウン有効化時の`config.json`設定など)
  https://help.splunk.com/en/splunk-cloud-platform/developing-views-and-apps-for-splunk-web/10.4.2604/custom-visualizations-for-dashboard-studio/best-practices

## 推測と事実を混ぜない（再発防止・必読）

このプラットフォームは**ドキュメント化されていない挙動が多く、コードからの推測がよく外れる**。
2026-07-25 の editor 型検証で、Claude の事前予想は**5回外れた**。同じ失敗を繰り返さないため、
以下を厳守する。

### 実際に外した例（すべて「コードを読んで断定 → 実機で否定」）

| 断定した内容 | 実際 | 何が悪かったか |
|---|---|---|
| 無効な editor 型はそのセクションだけ消える | **editorConfig 全体が消える** | 未検証の仮説を「定石」としてナレッジに書いていた |
| `editor.arrayOfStrings` は実在しない | **動く**。UI も出て配列も届く | `@splunk/visualizations` に無い＝存在しない、と誤った演繹 |
| `context` を使う型は値が届かない | `seriesColors` は**配列が生で届く** | 1例（`dynamicColor`）から全体を一般化した |
| 旧オプションへのフォールバックで後方互換が保てる | **既定値を選んだ時だけ壊れる** | ホストの挙動（既定値は options に載らない）を確認せず実装した |
| 「ドリルダウン」の調査依頼 | 実際は「**ドロップダウン**」の質問 | 語を思い込みで補完し、確認しなかった |
| 公式docsどおり `triggerDrilldown({action:'setToken'})` でトークンを設定できる | **その形では効かない**（例外も出ずサイレントに無視） | docs を検証せず信じた。**API が例外を投げない＝動いている、ではない** |
| 4通り試して全滅したので「**トークン設定は不可**」 | **できた**。`config.json` の `events` 宣言が抜けていただけ | **「N通り試した」は「全条件を試した」ではない**。viz 側の引数ばかり変えて、**config 側の前提を疑わなかった**。ユーザーの「検証方法に誤りがあるのでは」で気づいた |

**「やり方を変えて全部ダメ」でも「不可能」とは限らない。**
同じ次元（引数の形）で総当たりしても、**前提条件（config 宣言・ホスト側の設定）が欠けていれば全滅する**。
否定的な結論を出す前に「**そもそも土俵に乗っているか**」を疑う。標準 viz が何を宣言しているかを見る。

**公式ドキュメントは当てにならない**（実例2件）:
`addDrilldownListener` のシグネチャは docs と実際の型定義が食い違う（位置引数 vs オブジェクト引数）。
`setToken` は docs の例（`action:'setToken'`）では効かず、実際は
`events` 宣言＋`type:'cell.click'` で「事実」を送る形が正しい。**docs の記述も実機で確かめる。**

### 守ること

1. **「実機で確認した」と「コードから推測した」を必ず書き分ける。**
   ナレッジ／回答では `（実機確認済み）` `（未検証・推測）` を明示する。
   検証していないことを、検証済みのような書き方で断定しない。
2. **「〜は使えない」「〜は存在しない」は実機で確かめるまで言わない。**
   静的解析で分かるのは「標準 viz がそう使っているか」だけ。
   `@splunk/visualizations` は**標準 viz の定義集であって実装レジストリではない**ので、
   「そこに無い＝使えない」は導けない。**否定的な結論ほど根拠を厳しく求める。**
3. **1例からの一般化をしない。** `dynamicColor` が届かないことは、
   「`context` を使う型が全部届かない」ことを意味しない。法則を書くなら複数例で確かめる。
4. **エラーメッセージを都合よく解釈しない。**
   `must be string` は「値が届いている」証拠なのに「型が存在しない」と読んだ。
   **メッセージが何を実際に述べているか**を字義通りに読む。
5. **ユーザーの言葉を勝手に補完しない。** 用語がずれていそうなら、推測で進めず確認する。
6. **検証可能なことは検証してから答える。** `test/`（Editor Probe）に検証台がある。
   「たぶん動く／たぶんダメ」で終わらせず、1ラウンド回せば事実が得られる。
7. **ナレッジに書いた推測は、後で必ず実機結果で上書きする。**
   誤りが判明したら「訂正」と明記して残す（同じ誤りを再導入しないため）。

### 実機検証のやり方

`test/`（git 管理外の Editor Probe）を使う。手順とラウンド定義は `test/ROUNDS.md`。
未検証の editor 型・未確認のホスト挙動は、ここで1つずつ潰してから本番 viz に入れる。

## 安定性・堅牢性

- 表示されないケースがあるため、安定して表示される設計にする(データ欠損・空データ・型不一致などに対するガード処理を入れる)。
- **マウントゲート必須**：ホスト初期化完了（`DashboardExtensionAPI` 注入＋テーマ/データの初期 state 受信）を待ってから `createRoot().render()` する。公式フックは購読登録時に現在値を再送しないため、初期 state を取り逃すと `useTheme()` 等が undefined のまま永久に描画されない（詳細と実装コードは [references/studio-extension-viz.md](references/studio-extension-viz.md) の「ルート構成（マウントゲート必須）」）。
- テーマは `themeApi?.theme || 'light'` でフォールバックし、未取得でも必ず描画する（ゲート通過後は通常取得済み。`return null` で永久に待つガードは書かない）。

## 成果物と一緒に提示するもの

- サンプルSPL(`makeresults` を使ったもの)を必ず合わせて提示し、動作確認できるようにする。