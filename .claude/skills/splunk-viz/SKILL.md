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
4. **値→色マッピング**：`editor.dynamicColor` はカスタムvizで使えない（配列がoptionsに来ない）。値ベースのカラースケールを自前実装する
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
  | 自由入力の文字列 | `editor.text` | 単位ラベル |
  | 色 | `editor.color` | 背景色 |
  | フィールド選択 | `editor.columnSelector` | ラベル列、値列 |

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
- **実機デプロイ**：アンインストール・再起動は不要。`version` を上げ、Splunk の Upgrade チェックを通し、`_bump` ＋ハードリロードで反映する（詳細は [references/studio-extension-viz.md](references/studio-extension-viz.md) の「デプロイ」章）。

## 依存パッケージ

- Reactコンポーネントは新規インストールしてよい。より良い実装になるなら積極的に検討する。
- 追加するコンポーネントは `yarn add <package>` のコマンドを必ず提示する。

## 制約

- 成果物(実装するjsxコード)は本番のSplunk環境で動作するため、インターネット通信を行うコード(外部APIフェッチ、CDN読み込み等)を含めてはならない。
- 開発時(このスキル実行中)にClaude自身が外部サイトを参照して情報収集することは問題ない。下記「参考資料」のサイトは必要に応じて参照してよい。
- **同梱するデータ・素材（地図データ、GeoJSON/TopoJSON、アイコン、フォント、画像、辞書・参照データ等）は、著作権フリー（パブリックドメイン）またはそれ相当のもの「だけ」を使う。** クレジット表記・出典明記・利用報告・承認申請のいずれかが「必須」となる素材は使わない（表記が任意＝MIT/BSD/ISC 等の緩いコード系ライセンスは可、ただしデータ本体のライセンスを別途確認する）。判断できない場合は必ずライセンス原文で確認し、確実にフリーと言えないものは採用しない。代表例:
  - **地図データ**：Natural Earth（パブリックドメイン・クレジット不要）を第一候補にする。`world-atlas`（Natural Earth の再配布）も可。行政区画（州/都道府県=Admin-1）が要る場合は Natural Earth の `ne_10m_admin_1_states_provinces` から抽出する。**国土地理院「地球地図日本」/ GADM / OpenStreetMap 由来（出典表記や継承ライセンスが必須）は使わない。**
  - 素材を加工して同梱する場合も、元素材が上記条件を満たすことを確認する。
  - 詳細な判断基準・調達手順は [references/studio-extension-viz.md](references/studio-extension-viz.md) の「同梱データ・素材のライセンス」章を参照。
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

## 安定性・堅牢性

- 表示されないケースがあるため、安定して表示される設計にする(データ欠損・空データ・型不一致などに対するガード処理を入れる)。
- **マウントゲート必須**：ホスト初期化完了（`DashboardExtensionAPI` 注入＋テーマ/データの初期 state 受信）を待ってから `createRoot().render()` する。公式フックは購読登録時に現在値を再送しないため、初期 state を取り逃すと `useTheme()` 等が undefined のまま永久に描画されない（詳細と実装コードは [references/studio-extension-viz.md](references/studio-extension-viz.md) の「ルート構成（マウントゲート必須）」）。
- テーマは `themeApi?.theme || 'light'` でフォールバックし、未取得でも必ず描画する（ゲート通過後は通常取得済み。`return null` で永久に待つガードは書かない）。

## 成果物と一緒に提示するもの

- サンプルSPL(`makeresults` を使ったもの)を必ず合わせて提示し、動作確認できるようにする。