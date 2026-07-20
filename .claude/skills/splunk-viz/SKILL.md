---
name: splunk-viz
description: Splunkのカスタムビジュアライゼーション(React/JSX, Dashboard Studio向け)を作る。/splunk-vizで明示的に呼び出す。
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# Splunk カスタムビジュアライゼーション開発スキル

Splunk向けのカスタムビジュアライゼーション(React/JSX)を開発する際は、以下の要件に必ず従うこと。

## 最初に読む：実装ナレッジ（必読）

**新規作成・改修に着手する前に必ず [references/splunk-viz-api.md](references/splunk-viz-api.md) を読むこと。**
過去の実装で得た再利用可能なナレッジを集約している:

1. プロジェクト構成 / スケルトン複製 / ビルド・パッケージ手順
2. 実装の定番パターン（テーマガード・データ正規化・オートフィット・堅牢性チェックリスト）
3. editorConfig と editor 型（確実な3種＋実在する型の調べ方、無効型の症状）
4. **値→色マッピング**：`editor.dynamicColor` はカスタムvizで使えない（配列がoptionsに来ない）。値ベースのカラースケールを自前実装する
5. ローカル検証（happy-dom で実機なしにバンドルを叩く）
6. デプロイ（アンインストール・再起動なし。`_bump`）
7. GitHub 運用（1 viz = 1 private repo、push はユーザー手動）
8. データモデルの型

タスクに関係する章は、着手前に該当箇所を Read すること。

## 開発方針

- Reactベースで開発する。
- 成果物はReactコード(.jsx)そのもの。画像やスクリーンショットではない。
- 添付されたjsxファイルがある場合は、それをベースに実装する。
- 出力は必ずファイル全体(完成版)とする。差分やスニペットのみの提示は禁止。コピペしてそのまま動かせる状態にすること。
- サーチ結果(SPLの実行結果)に応じて表示内容が変わるように実装する。デフォルトのSplunkビジュアライゼーションと同様、データドリブンな描画にすること。
- デフォルトのビジュアライゼーションと同様に、ダッシュボードの編集画面でグラフの色などのオプションを設定できるようにする。ユーザーが設定したオプションは `useOptions` で取得する。
- **編集画面のオプションラベルは日本語で書く**（`config.json > editorConfig` のセクション `label`・各項目の `label` とも。例:「表示」「タイトルを表示」「アニメーション周期（秒、0で停止）」）。オプションのキー名(`option` / `optionsSchema`)は英語のまま。既存 viz を改修するときも英語ラベルが残っていれば日本語化する。
- 参考資料の公式ドキュメントを参照し、Splunkのベストプラクティスに従うこと。
- パッケージ化する際はバージョンを更新すること．（詳細は「デプロイ／リリース運用」を参照）

## デプロイ／リリース運用

新規作成・改修してパッケージ化するときは、以下を必ず行う。GitHub へのコミット／プッシュ自体はユーザーが手動で行うが、**リリースノートの追記とバージョン更新は成果物の一部として Claude が実施する**こと。

- **リポジトリ**：モノレポ `Aria-1429/custom-viz`（private / `main`）に各 viz を `custom-viz-<name>/` として収録する。1 viz = 1 repo は廃止済み。
- **バージョン更新**：`package.json` の `version` を SemVer で上げる（新規=`1.0.0`、機能追加=minor、修正=patch）。`config.json` 等のバージョンも整合させる。
- **`.spl` はリポジトリに含める（旧版も残す）**：
  - パッケージ成果物 `dist/<app>-<ver>-<hash>.spl` はコミット対象。ファイル名にコミットハッシュが入るため複数併存するが、**旧バージョンの `.spl` も削除せず残す**方針（更新履歴を追えるようにするため）。
  - `.gitignore` は「`dist/*` は無視、`!dist/*.spl` で `.spl` だけ救済」の形にしてある（ルート＋各 viz の両方に必要。過去に各 viz 直下の `.gitignore` を見落としてハマった）。新しい viz を追加したら同じ 2 行が入っているか確認する。
- **リリースノートを追記する（必須）**：各 viz 直下の `RELEASE_NOTES.md`（[Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) 準拠 / SemVer）に、履歴セクション先頭（`---` の直下）へ新エントリを追記する。
  - 見出し：`## [x.y.z] - YYYY-MM-DD`
  - 変更種別の見出しで整理：`追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`
  - 生成した `.spl` のパス（`dist/....spl`）も記載する
  - まだ `RELEASE_NOTES.md` が無い viz を作るときは新規作成し、`1.0.0` に「新規作成（初回リリース）」を書く
- **実機デプロイ**：アンインストール・再起動は不要。`version` を上げ、Splunk の Upgrade チェックを通し、`_bump` ＋ハードリロードで反映する（詳細は [references/splunk-viz-api.md](references/splunk-viz-api.md) の「デプロイ」章）。

## 依存パッケージ

- Reactコンポーネントは新規インストールしてよい。より良い実装になるなら積極的に検討する。
- 追加するコンポーネントは `yarn add <package>` のコマンドを必ず提示する。

## 制約

- 成果物(実装するjsxコード)は本番のSplunk環境で動作するため、インターネット通信を行うコード(外部APIフェッチ、CDN読み込み等)を含めてはならない。
- 開発時(このスキル実行中)にClaude自身が外部サイトを参照して情報収集することは問題ない。下記「参考資料」のサイトは必要に応じて参照してよい。
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
- `useTheme()` がundefinedを返す場合はコンポーネント本体(App)をレンダリングせず、テーマ取得後にのみレンダリングするようガード処理を追加する。

## 成果物と一緒に提示するもの

- サンプルSPL(`makeresults` を使ったもの)を必ず合わせて提示し、動作確認できるようにする。