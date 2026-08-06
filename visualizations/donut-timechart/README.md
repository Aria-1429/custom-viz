# Donut Timechart

![表示例](examples/example.png)

Splunk Dashboard Studio 用カスタムビジュアライゼーション。
「Endpoint Protection Status」カード風に、**ドーナツチャート + 凡例 + トレンドチャート(スパークライン)** を1枚のパネルにまとめて表示する。

- **上段左**: ドーナツチャート。中央に最大セグメントの割合(例 `98.0% Protected`)、またはオプションで合計値を表示
- **上段右**: 凡例。カテゴリごとのドット・ラベル・値(区切り線つき)、末尾に Total 行
- **下段**: 全カテゴリ合計値の推移を示すエリア+ライントレンドチャート
- ダーク / ライトテーマ両対応、ホバーでドーナツ⇔凡例が連動

### v0.2.0 の改善

- **フィールド選択 UI**: 編集画面の「データフィールド」で時刻 / カテゴリ / 値の列を明示指定できる(未指定なら従来どおり自動判定)
- **マルチバリューセルの救済**: `stats values()` 等で mv が1セルに束で届いても、桁連結事故(`500`+`300`→`500300`)を起こさず正しく展開して集計する
- **オートフィット**: パネル実寸に応じて凡例フォント・ドーナツ枠を自動スケール(既定 ON。編集画面の「表示」で OFF 可)
- **編集画面ラベルの日本語化**・系列色を8色に拡張・**デバッグ情報オーバーレイ**(オプションが反映されない事故の切り分け用)
- happy-dom によるローカル検証(`yarn verify`)を追加

## データ仕様

### 推奨: timechart 形式

第1列が `_time`、以降が数値系列。**最後(最新)の行**でドーナツと凡例を描き、**各行の合計**でトレンドチャートを描く。

```
| timechart span=15m count by status
```

`_span` などアンダースコア始まりの内部フィールドは自動で除外される。

### 互換: stats 形式

`_time` 列が無い場合は「第1列=カテゴリ、第2列=数値」として解釈し、トレンドチャートは自動で非表示になる。

```
| stats count by status
```

## 動作確認用サンプルSPL

```
| makeresults count=48
| streamstats count as i
| eval _time = relative_time(now(), "-48h") + i*3600
| eval Protected = 1200 + round(30*sin(i/3)) + (random()%20)
| eval "At Risk" = 14 + (random()%8)
| eval Offline = 4 + (random()%5)
| table _time Protected "At Risk" Offline
```

stats 形式(ドーナツのみ):

```
| makeresults
| eval status="Protected", count=1247
| append [| makeresults | eval status="At Risk", count=18]
| append [| makeresults | eval status="Offline", count=7]
| table status count
```

## オプション(ダッシュボード編集画面)

| セクション | オプション | 説明 |
|---|---|---|
| データフィールド | 時刻 / カテゴリ / 値フィールド | 使用する列を明示指定(未指定で自動判定) |
| ドーナツ | リングの太さ / 隙間 / 最大セグメント数 / 端を丸める | 太さ・隙間・最大セグメント数(超過分は Others に集約)・丸端 |
| ドーナツ | 中央に最大セグメントの割合を表示 | ON: 最大セグメントの% / OFF: 合計値 |
| ドーナツ | 発光エフェクト / 発光の強さ | ネオン風発光 |
| 凡例 | 凡例を表示 / 割合を表示 / 合計行を表示 | 凡例・%表示・Total 行 |
| トレンドチャート | 表示 / 高さ / 塗りつぶし / ライン色 | トレンドチャートの表示・高さ・塗り・線色 |
| 色 | 系列の色 / 合計行のドット | 系列色パレット(SPLの列順に対応。プリセット選択＋スウォッチ列で色数も増減可)・Total 行のドット色 |
| 表示 | 自動フィット | パネルサイズ追従 |

## 開発コマンド

```bash
yarn install   # 依存関係のインストール
yarn build     # dist/ にバンドルを生成
yarn verify    # happy-dom で実機なしにバンドルを検証(dist が必要)
yarn package   # dist/ に .spl を生成
```

## デプロイ(再デプロイ時)

1. `npm version patch --no-git-tag-version && yarn build:prod && yarn package`
2. Splunk Web「Appの管理 → Install app from file」で **Upgrade app にチェック**してアップロード
3. `https://<host>:8000/en-US/_bump` で Bump version
4. ブラウザをハードリロード(Ctrl+Shift+R)

## プロジェクト構成

```
donut-timechart/
├── package.json                     # Node/npm スクリプトと依存関係
├── build.mjs / package.mjs          # ビルド・パッケージスクリプト
├── package/app/app.conf             # Splunk アプリメタデータ
└── visualizations/
    └── custom_viz_donut_timechart/
        ├── config.json              # オプションスキーマ・エディタ設定
        └── src/visualization.jsx    # 本体(React)
```

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

---

### [1.1.2] - 2026-08-06

#### 変更

- **表示名から `Custom Viz ` プレフィックスを削除**（`Custom Viz Donut Timechart` → `Donut Timechart`）。
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

- `dist/custom_viz_donut_timechart-1.1.1-b4e4674.spl`

---


### [1.1.0] - 2026-07-25

#### 変更

- 系列色の設定を `editor.color` 8個（`color1`〜`color8`）から **`editor.seriesColors` 1項目**（`seriesColors`）へ統合。編集画面が「プリセット選択＋色スウォッチ列」になり、色数もユーザーが増減できるようになった。
- パレットが系列数より少ない場合は循環して適用する（既定色に落ちない）。
- 合計行のドット（`totalColor`）とトレンドラインの色（`sparkColor`）は単独用途のため `editor.color` のまま。

#### 削除

- 旧オプション `color1`〜`color8`。**既定値が options に載らないホスト挙動のため、旧キーへのフォールバックは意図的に実装していない**（実装すると「既定値を選んだときだけ直らない」不具合になる）。既存ダッシュボードで色を変更していた場合は既定パレットに戻るので、編集画面で設定し直すこと。
- デバッグ用オプション `debug` と debug オーバーレイ。切り分け用途を終えたため削除した。

#### 成果物

- `dist/custom_viz_donut_timechart-1.1.0-fcde869.spl`

---

### [1.0.2] - 2026-07-25

#### 変更

- **データ未取得時のメッセージを全 viz 共通の文言に統一**した。
  「データがありません。サーチ結果を確認してください。」（従来は英語表記や viz ごとに異なる文言だった）。
  ダッシュボードに複数の viz を並べたときに、サーチ未設定の空パネルが揃った見た目になる。


#### 生成物

- `dist/custom_viz_donut_timechart-1.0.2-2dc2dde.spl`

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
- `dist/custom_viz_donut_timechart-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

ドーナツチャート＋凡例＋トレンドチャート（スパークライン）を 1 枚のパネルにまとめたカード風ビジュアライゼーション。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_donut_timechart-1.0.0-beb3d05.spl`
