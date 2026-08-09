# Donut Graph
![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（ドーナツグラフ）。

中央にトータル値、右側に値・割合・割合バー付きの凡例を表示する。上位 N 件を色分けし、残りは
"Others" に集約する。ネオン風の発光エフェクトやリング太さ・色などをダッシュボードの編集画面
（Configuration パネル）から設定できる。

## 特徴

- データドリブン描画（SPL の結果に応じて自動でセグメント生成）
- **フィールド選択**：編集画面の「データ設定」でカテゴリ列・値列をドロップダウンで選択（未選択なら
  第1列＝カテゴリ・最初の数値列＝値に自動フォールバック）
- 上位 N 件 + Others 集約で、極小スライスの視認性を確保
- ネオン風グロー、リング太さ／隙間／色などを編集画面から設定（`useOptions`）
- ライト / ダークテーマ対応（`useTheme` によるガード付き）
- ドーナツ ⇔ 凡例のホバー連動、中央値のスワップ表示
- **堅牢性**：カンマ付き数値の正規化、非数値・負値・空ラベル行の除去、マルチバリューセル
  （mvexpand し忘れ等）の平行展開救済、`rows` / `columns` 両形式対応

## データ仕様

- 第1列（既定）= カテゴリ、第2列（既定）= 数値。
- 編集画面「データ設定」で任意の列を選択可能。値列を選ばない場合は最初の数値列を自動採用。

## 開発

```bash
yarn install
yarn build          # dist/custom_viz_donut_graph/visualization.js を生成
yarn verify         # happy-dom で実機なしにバンドルを検証（描画・オプション・ガード）
yarn package        # dist/*.spl（Splunk アプリパッケージ）を生成
```

## デプロイ（再インストール・再起動なし）

1. `npm version patch --no-git-tag-version && yarn build:prod && yarn package` でバージョンを上げて `.spl` を生成
   （`package/app/app.conf` の `version` も同期する）
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）
4. ブラウザをハードリロード（Ctrl+Shift+R）

## サンプル SPL

Splunk 9.0+（`makeresults format=csv` が最も確実で読みやすい）:

```spl
| makeresults format=csv data="log_level,count
INFO,494612
WARN,50669
ERROR,217
WARNING,65
DEBUG,12
NONE,1
TRACE,1"
| eval count=tonumber(count)
```

旧環境（`format=csv` が使えない場合）:

```spl
| makeresults
| eval raw=split("INFO,494612|WARN,50669|ERROR,217|DEBUG,65|TRACE,12|NONE,1","|")
| mvexpand raw
| eval log_level=mvindex(split(raw,","),0), count=tonumber(mvindex(split(raw,","),1))
| table log_level count
```

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

---

### [1.1.3] - 2026-08-09

#### 修正

- **スピナーが永遠に回り続けることがある問題への対策**（全 viz 共通の横展開）。
  公式 `useDataSources` は「render 時に現在値でシード → `useEffect` で購読」の構造で、
  その間に届いた更新を取り逃す（ホストは購読登録時に現在値を再送しない）。
  サーチ完了の最終通知をこの隙間で落とすと `loading` のまま固まる。対策として、
  loading 中は `getDataSources()` を 500ms 間隔で読み直し、ホスト側が完了済みなら
  その値を採用する（`useDataSourcesWithRescue`）。完了後はポーリングしない。
  不定期・初回表示時に発生しやすく、リロードで直る症状はこれが原因とみられる。
  描画・オプションの挙動に変更はない。

`.spl`: `dist/custom_viz_donut_graph-1.1.3-2bb5ec3.spl`

### [1.1.2] - 2026-08-06

#### 変更

- **表示名から `Custom Viz ` プレフィックスを削除**（`Custom Viz Donut Graph` → `Donut Graph`）。
  Studio の viz 切替 UI に出る名前・管理画面の App 一覧・README タイトルの3か所が対象。
  **アプリ ID（`custom_viz_*`）は変更していない**ため、配置済みダッシュボードには影響しない。
---

### [1.1.1] - 2026-07-30

#### 追加

- **`THIRD_PARTY_NOTICES.txt` を `.spl` に同梱**するようにした。バンドルしている
  OSS のライセンス条文と同梱素材の出典を、esbuild metafile（実際にバンドルされた
  モジュールの一覧）から機械生成している。パッケージ時に内容の鮮度も検査され、
  依存が変わったまま再生成し忘れると `.spl` 生成が失敗する。

#### 修正

- **`.spl` に開発ビルド（非 minify＋ソースマップ）が混入していたのを修正**。
  本番ビルド（`yarn build:prod`）で梱包するようにした（`.spl` が大幅に小さくなる）。
  機能・描画の変更はない。

#### 成果物

- `dist/custom_viz_donut_graph-1.1.1-b4e4674.spl`

---


### [1.1.0] - 2026-07-25

#### 変更

- セグメントの色設定を `editor.color` 6個（`color1`〜`color6`）から **`editor.seriesColors` 1項目**（`seriesColors`）へ統合。編集画面が「プリセット選択＋色スウォッチ列」になり、色数もユーザーが増減できるようになった。
- パレットがセグメント数より少ない場合は循環して適用する（既定色に落ちない）。

#### 削除

- 旧オプション `color1`〜`color6`。**既定値が options に載らないホスト挙動のため、旧キーへのフォールバックは意図的に実装していない**（実装すると「既定値を選んだときだけ直らない」不具合になる）。既存ダッシュボードで色を変更していた場合は既定パレットに戻るので、編集画面で設定し直すこと。

#### 成果物

- `dist/custom_viz_donut_graph-1.1.0-fcde869.spl`

---

### [1.0.2] - 2026-07-25

#### 変更

- **データ未取得時のメッセージを全 viz 共通の文言に統一**した。
  「データがありません。サーチ結果を確認してください。」（従来は英語表記や viz ごとに異なる文言だった）。
  ダッシュボードに複数の viz を並べたときに、サーチ未設定の空パネルが揃った見た目になる。


#### 生成物

- `dist/custom_viz_donut_graph-1.0.2-2dc2dde.spl`

---

### [1.0.1] - 2026-07-21

#### 修正

- **まれにパネルが描画されない事象への対策（マウントゲート導入）**。ホスト初期化完了
  （`DashboardExtensionAPI` 注入＋テーマ／データの初期 state 受信）を待ってから React を
  マウントするよう変更。公式フックは購読登録時に現在値を再送しないため、初期 state が
  マウント後に届くと取り逃して `useTheme` 等が undefined のまま永久に非表示となる
  競合があった。
- **テーマ未取得時のフォールバックを追加**。最大5秒待っても初期 state が揃わない場合は
  light テーマで必ず描画を開始する（永久に真っ白のままになる経路を排除）。

#### パッケージ
- `dist/custom_viz_donut_graph-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

カテゴリ構成比を表すドーナツグラフ。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_donut_graph-1.0.0-beb3d05.spl`
