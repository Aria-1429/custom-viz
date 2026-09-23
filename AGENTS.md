# custom-viz — AI エージェント共通ルール

Claude Code と OpenAI Codex が共有するプロジェクトルールの正本。両ツールとも毎回読み込むので、
ここには「必ず伝わるべき短いルール」だけを置き、詳細はスキル `splunk-viz` の references に分離してある。

## プロジェクト概要

Splunk **Dashboard Studio** 向けカスタムビジュアライゼーション集（React/JSX）と、
独立 React ページのアプリ群（DPX ほか）を収めたモノレポ。全体像と viz 一覧は [README.md](README.md)。

- 技術スタック: React 18 / JSX、esbuild（`build.mjs`）、yarn、happy-dom によるローカル検証、Splunk 10.4 実機
- 対象は3種類あり作法が違う: **Studio 拡張 viz**（`visualizations/`）、**クラシック**（Simple XML）、**DPX**（`apps/dpx/`、独自基盤）

## ディレクトリ構成

- `visualizations/<name>/` … Studio 拡張 viz（32 種）。各ディレクトリで単体にビルド・パッケージ・デプロイできる。Splunk のアプリ ID は `custom_viz_<name>`
- `apps/` … viz ではなく Splunk のナビから開く独立 React ページ。`apps/dpx/` は Studio と無関係の独自ダッシュボード基盤
- `tools/dashboard-loop/` … 実機へ push してスクリーンショットを撮るツール群
- `scripts/` … 第三者ライセンス通知の生成など、viz 横断のスクリプト
- `.agents/skills/splunk-viz/` … **実装ナレッジの本体**（両ツール共有。下記）
- `.claude/` … Claude Code 固有の設定（permissions とスキルの入口）。ナレッジは置かない

## Splunk viz / ダッシュボード / DPX の作業を頼まれたら

着手前に必ずスキル **splunk-viz** を読む。Claude Code では `/splunk-viz`、Codex では `$splunk-viz`。
呼び出せない場合は [.agents/skills/splunk-viz/SKILL.md](.agents/skills/splunk-viz/SKILL.md) を直接読む。
SKILL.md が作業内容ごとに読むべき `references/` を指示しているので、該当章だけを読む
（Studio 拡張 viz・標準 viz・Studio ダッシュボード JSON・クラシック・DPX・性能・WebGL・ハック）。
**作る前に「標準 viz で足りないか」を確認する**（標準でできることをカスタムで作り直さない）。

## コマンド（各 viz ディレクトリ内で実行）

```bash
yarn build:prod   # 本番ビルド（yarn build は開発ビルド。.spl に混ぜない）
yarn verify       # happy-dom によるローカル検証。package 後の本番ビルドに対して回す
yarn package      # dist/*.spl を生成
```

## 守ること

- 成果物は動く React コード（ファイル全体）。差分やスニペットだけの提示はしない
- 成果物にインターネット通信（外部 API・CDN）を入れない。完全オフラインで動くこと
- 同梱する地図・データ・素材はパブリックドメインのみ。バンドルした OSS の条文は機械生成して同梱する
- 依存を追加したら `yarn add <package>` のコマンドを提示する
- パッケージ（`.spl`）を作る前に `build:prod` を通す。バージョンは SemVer で上げ、各 viz の README のリリースノートとルート README の一覧行も更新する
- 「直った」と言う前に実機のスクリーンショットで確認する。「実機確認済み」と「未検証・推測」を書き分ける
- 実機の接続情報は `~/.splunk-dev.env`（git 管理外）。認証情報をチャット・コード・コミットに書かない

## AI が勝手にやってはいけないこと

- **splunkd の再起動**（`config.json` を変えた回に必要）。実機を止めるので、毎回ユーザーの許可を取ってから行う
- `git commit` / `git push`。ユーザーが明示的に依頼したときだけ。push は原則ユーザーが手動で行う
- アプリ ID（`custom_viz_<name>`）とフォルダ名の変更。既存ダッシュボードが壊れる
- 配布済みの旧 `.spl` の書き換え・削除。リリースアーカイブとして残す

## ナレッジの更新

実機で確かめた事実や踏んだ罠は `.agents/skills/splunk-viz/references/` に書き戻す（ツール固有のメモリに閉じ込めない）。
誤りが分かった記述は消さず「訂正」と明記して残す。
