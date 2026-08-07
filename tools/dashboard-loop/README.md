# dashboard-loop

Studio ダッシュボードを**実機へ push し、描画結果をスクリーンショットで取得する**開発ループ用ツール。

これがあると、ダッシュボード作成の「実装 → 画面を見る → 微調整」を Claude 側だけで回せる。
従来は ①Studio へ手貼り ②人が目で見て言葉で症状を伝える、の2箇所で人手が要っていた。

```
JSON を書く → push（REST）→ 描画をスクショ → 見て直す → push …
```

## セットアップ

依存はこのフォルダに隔離してある（ルートに `package.json` は作らない。各 viz の
`node_modules` と干渉させないため）。

```bash
cd tools/dashboard-loop
yarn install
npx playwright install chromium
sudo npx playwright install-deps chromium   # OS 側の共有ライブラリ
```

接続設定は**リポジトリに置かない**（このリポジトリは public）。`~/.splunk-dev.env` に書く:

```bash
cat > ~/.splunk-dev.env <<'EOF'
SPLUNK_HOST=<開発機のIP>
SPLUNK_USER=<開発用ユーザー>
SPLUNK_PASS=<パスワード>
SPLUNK_APP=dev_dashboards
EOF
chmod 600 ~/.splunk-dev.env
```

環境変数が指定されていればそちらが優先される。

## 使い方

```bash
# push → 撮影 をまとめて（通常はこれだけ使う）
node src/sync.mjs ../../Splunk-Dashboard-Examples/soc_overview_dashboard.json --panels

# push だけ
node src/push.mjs <path/to/dashboard.json> [--name <id>] [--theme dark|light]

# 撮影だけ（既に実機にあるダッシュボードを見る）
node src/shot.mjs <dashboard-name> [--panels] [--wait 45] [--width 1920]

# ヘッドレスで WebGL が描けるかの単体確認（Splunk 不要）
node src/probe-webgl.mjs out.png

# 実機の DOM を調べる（セレクタが変わったとき）
node src/probe-dom.mjs <dashboard-name>

# viz アプリのバージョンをローカルと突き合わせる（viz を撮影する前に必ず）
node src/viz-status.mjs [<viz名>] [--all]
```

出力は `shots/`（git 管理外）:

| ファイル | 内容 |
|---|---|
| `<name>.png` | 全体のスクリーンショット（2x） |
| `<name>__<panelId>.png` | `--panels` 指定時のパネル個別 |
| `<name>.report.json` | コンソールエラー・ページエラー・失敗リクエスト・描画が安定したか |

## 主なフラグ

| フラグ | 既定 | 意味 |
|---|---|---|
| `--name <id>` | ファイル名 | ダッシュボードの ID |
| `--panels` | off | パネルごとに個別撮影する |
| `--wait <秒>` | 45 | 描画待ちの上限 |
| `--settle <秒>` | 2 | 「安定した」と判定するまでの静止時間 |
| `--width` / `--height` | 1920 / 1080 | ビューポート（高さは実寸に自動追従する） |
| `--nofit` | off | ビューポートの自動追従を切る |
| `--maxheight <px>` | 3000 | 自動追従の上限 |
| `--full` | off | ダッシュボード本体だけでなくブラウザ画面全体を撮る |
| `--probe` | off | DOM の `data-test` 値を列挙する（セレクタ調査用） |

## 実機で確認した事実（2026-08-07 / Splunk Enterprise 10.4.2）

| 事項 | 結果 |
|---|---|
| REST でのダッシュボード作成・更新・読み戻し・削除 | 全て動作 |
| ヘッドレス Chromium の WebGL2 | **動く**。GLSL ES 3.00／ANGLE + SwiftShader |
| パネルのセレクタ | **`[data-test="viz-item"]`**。`data-id` が JSON の `visualizations` キー、`data-viz-type` が viz の型 |
| ダッシュボード本体の領域 | **`[data-test="canvas"]`**（Splunk のヘッダ・ナビを除いた矩形） |
| ログインフォーム | `input[name="username"]` / `input[name="password"]` |
| アプリの新規作成 | **`power` ロールでは不可**（要 `admin_all_objects` か `edit_local_apps`）。既存アプリへの書き込みは可 |
| `.spl` のインストール／アップグレード | **可**（2026-08-07 に `install_apps` を付与して確認）。`install-viz.mjs` が `POST /en-US/manager/appinstall/upload_app` を叩く。⚠ 管理ポート(8089)の `services/apps/local` / `services/apps/appinstall` は **multipart を受け付けない**（`Unparsable URI-encoded request data`）ので使えない |
| 実機の viz アプリ一覧・バージョン参照 | **可**（`rest_apps_view`）。`viz-status.mjs` がこれを使う |

## viz を撮影して見た目を詰める

ダッシュボードだけでなく、**カスタム viz 本体の見た目も実機で確認して直せる**。
**インストールまで含めて自動で回せる**（2026-08-07 に `install_apps` 付与）。

```bash
node src/viz-status.mjs <viz名>       # ① 実機とローカルのバージョン一致を確認 ← 必ず最初
# ② ズレていたら: cd visualizations/<viz名> && yarn build:prod && yarn package
node src/install-viz.mjs <viz名>      #    最新 .spl を上書きインストール ＋ _bump
node src/sync.mjs <検証用.json> --name viz_check_<viz名> --out <出力先>   # ③ 撮る
# ④ PNG を見て直して ② に戻る
```

**①を飛ばすと、実機の古いバンドルを見て「直したのに直らない」と誤診する。**

## 落とし穴（実際に踏んだもの）

- **一発の撮影を信用しない。** サーチが終わらないと正常なパネルでも「データがありません」になる。
  同じ JSON を撮り直すたびに空になるパネルが変わった（35秒→3枚、75秒→2枚、90秒→0枚）。
  `shot.mjs` は空表示パネルを数えて警告するので、出たら `--wait` を伸ばして撮り直すこと。
- **カスタム viz は iframe 内で描画される**（28パネルのダッシュボードで 23 枚）。
  ホスト DOM の `textContent` では中身が読めない。最初その実装で空表示検出を書き、
  **「検出ゼロ」と報告しながら実際には空パネルが2枚あった**。`contentFrame()` を辿ること。
- **ビューポートが足りないと折り返しより下のパネルが空白のまま撮れる。**
  レイアウト 1920x1680 のダッシュボードを 1920x1080 で撮ったら下段4パネルが空白になった。
  **パネル個別撮影は Playwright が要素を可視域へスクロールするので影響を受けない**ため、
  「個別は撮れているのに全体だと空白」という紛らわしい出方をする。
  → `[data-test="canvas"]` の実寸を測ってビューポートを自動で広げるようにした（`--nofit` で無効化）。
- **共有をアプリレベルに上げると所有者が `nobody` に移る。**
  ユーザー名前空間の URL で GET/DELETE すると 404 になる。
  → ユーザー → `nobody` の順に試す `requestEntity` で吸収している。

## 設計上の注意

- **描画完了の判定**は「スクショが2回連続で同一になったら完了」。DOM のロード完了は
  サーチ実行の完了を意味しないため。**アニメーションする viz（Attack Globe 等）は
  永久に安定しない**ので `--wait` で打ち切る（これは異常ではない）。
- **REST で作ったダッシュボードは既定でそのユーザーの private**。`push` は自動で
  共有範囲をアプリレベルに上げる（これをやらないと人が UI から探せない）。
- 自己署名証明書のため TLS 検証を切っているが、**これは開発機への接続に限った話**で
  viz の成果物には一切入らない。
- push 時に **SPL の2重エスケープ**（`\"m\"` 問題）を検査して警告する。
  詳細は `.claude/skills/splunk-viz/references/studio-dashboard-json.md` の「最重要」章。
