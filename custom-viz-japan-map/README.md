# custom-viz-japan-map

![表示例](examples/example.png)

https://github.com/user-attachments/assets/bbf2dd36-f586-446c-9b78-c86fb98f57d0

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（日本地図＋アタックマップ）。
[custom-viz-world-map](../custom-viz-world-map/) の**日本地図版**で、仕様は World Map と共通です。

**都道府県境あり**の日本列島上に「起点（src）→ 終点（dst）」を弧で描き、弧に沿って光の筋が流れる
アニメーションで攻撃・脅威の流れを可視化する。Severity（High / Medium / Low）ごとに色分けし、
着弾点をホットスポットとして強調表示する。都道府県にカーソルを合わせると県名を表示する。

日本地図データ（都道府県境 topojson）はビルド時にバンドルされるため、**実行時のインターネット通信は
不要**（本番 Splunk 環境の制約に準拠）。地図の投影は日本にフィットする Mercator（`geoMercator`）。
地図データは**パブリックドメイン**（Natural Earth。著作権フリー・クレジット表記不要）を使用しています。

## World Map との違い

仕様（弧・流れる光の帯・ホットスポット・Severity 色分け・タイトル / 凡例 / フィルタ・テーマ対応・
オートフィット・フィールド選択・各種ガード）は World Map と完全に同一です。**地図の下地だけ**が違います。

| 項目 | World Map | Japan Map（本 viz） |
| --- | --- | --- |
| 地形データ | 世界地図（world-atlas） | 日本 47 都道府県（Natural Earth・境界線あり） |
| 投影 | `geoNaturalEarth1` | `geoMercator`（日本にフィット） |
| ツールチップ | 地点・弧 | 地点・弧に加え**都道府県名** |
| 追加オプション | — | 「都道府県の境界線を表示」 |
| タイトル既定 | `GLOBAL THREAT MAP` | `JAPAN THREAT MAP` |

## 特徴

- データドリブン描画（SPL の結果から起点・終点の弧を自動生成）
- 都道府県境ありの日本列島（県境の表示切替可・県名ツールチップ）
- Severity（High / Medium / Low ＋任意の独自値）で色分け、着弾点をホットスポット表示
- 弧に沿って光の筋が流れるアニメーション（速度変更・停止可）
- **編集画面のフィールド選択**（`editor.columnSelector`）で任意の列を緯度経度・Severity 等に割り当て可能
- ホットスポットと弧にツールチップ（地点名・Severity・count）
- タイトル / 凡例 / Severity フィルタ / 都道府県境の表示切替オプション
- ライト / ダークテーマ対応（`useTheme` によるガード付き）
- パネルサイズに自動フィット（コンテナサイズを監視して再描画）
- 空データ・必須フィールド欠損・型不一致に対するガード処理

## データ仕様（フィールド）

| 種別 | フィールド名（候補） | 説明 |
| --- | --- | --- |
| 必須 | `src_lat` / `src_lon` | 起点の緯度・経度 |
| 必須 | `dst_lat` / `dst_lon` | 終点の緯度・経度 |
| 任意 | `severity`（`threat_level` / `level`） | High / Medium / Low（`critical` は High 扱い）や独自値 |
| 任意 | `count`（`events` / `total`） | イベント数 |
| 任意 | `src_name` / `dst_name` | 起点・終点の表示名（ツールチップに表示） |

座標は日本国内を想定（投影が日本にフィットしているため、日本国外の座標は画面外に描画される）。

フィールドの決め方（優先順）:

1. 編集画面「データフィールド」セクションのフィールド選択（任意の列名を割り当て可能）
2. 未選択の場合は上表の候補名で自動判定（大文字小文字を問わない）

## オプション（ダッシュボード編集画面）

| セクション | オプション | 説明 |
| --- | --- | --- |
| データフィールド | 送信元/宛先の緯度・経度 ほか | 使用する列の明示指定（未設定は自動判定） |
| 表示 | タイトルを表示 / 凡例を表示 / 深刻度フィルタを表示 | 各オーバーレイの表示切替 |
| 表示 | 都道府県の境界線を表示 | 県境線の表示切替（OFF でも陸地本体は描画） |
| 表示 | アニメーション周期（秒、0で停止） | 光の筋がパスを走り切る秒数。`0` で全アニメーション停止（静的表示） |
| 線の色 | High（高）/ Medium（中）/ Low（低）/ その他の深刻度 1–4 | Severity ごとの線・ホットスポット色 |
| 背景 / 陸地 | 背景色・陸地色 | チェック ON 時のみカスタム色（transparent 指定で非表示） |

タイトル文字列は既定で `JAPAN THREAT MAP`。変更する場合はダッシュボード定義（ソース編集）で
`options.titleText` を設定する（編集 UI には出さない設計）。

## 地図データの出典・ライセンス

同梱の都道府県境 topojson（`visualizations/custom_viz_japanmap/src/assets/japan-prefectures.topojson.json`）は、
**[Natural Earth](https://www.naturalearthdata.com/)** の Admin-1（州・都道府県）レベルデータ
（`ne_10m_admin_1_states_provinces`）から日本の 47 都道府県を抽出し、本 viz 用に TopoJSON へ
変換・簡略化・量子化したものです。47 都道府県の `nam`（英語名）/ `nam_ja`（日本語名）を含みます。

- **ライセンス：パブリックドメイン（著作権フリー）**。Natural Earth の利用規約は
  「*All versions of Natural Earth ... map data ... are in the public domain.* /
  *No permission is needed to use Natural Earth. Crediting the authors is unnecessary.*」と明記しており、
  **クレジット表記も承認申請も不要**です（本 README での記載は任意の謝辞です）。
- ビルド時にバンドルされ、実行時のインターネット通信は発生しません。

## 開発

```bash
yarn install
yarn build          # visualizations/*/dist を生成
yarn verify         # happy-dom によるローカル検証（Splunk 実機なしでバンドルを検証）
yarn package        # dist/*.spl（Splunk アプリパッケージ）を生成
```

本番向け（minify・ソースマップ無し）は `yarn build:prod` の後に `yarn package` を実行する。

アプリのメタデータ（version / label / author / description / category）は `package/app/app.conf`
に格納されている。Splunk 上での見え方を変えるときはこのファイルを編集する（`package.json` は
Node/npm 用）。

## デプロイ（再インストール・再起動なし）

1. `npm version patch --no-git-tag-version && yarn build && yarn package` でバージョンを上げて `.spl` を生成
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）
4. ブラウザをハードリロード（Ctrl+Shift+R）

## サンプル SPL

座標を直接指定（フィールド名は自動判定される）。国内主要都市 → 東京への攻撃フロー:

```spl
| makeresults format=csv data="src_lat,src_lon,dst_lat,dst_lon,severity,count,src_name,dst_name
43.06,141.35,35.68,139.69,low,120,Sapporo,Tokyo
34.69,135.50,35.68,139.69,high,300,Osaka,Tokyo
33.59,130.40,35.68,139.69,high,50,Fukuoka,Tokyo
26.21,127.68,35.68,139.69,medium,80,Naha,Tokyo
38.27,140.87,35.68,139.69,medium,60,Sendai,Tokyo
35.18,136.91,35.68,139.69,low,10,Nagoya,Tokyo
34.39,132.46,35.68,139.69,scan,40,Hiroshima,Tokyo"
```

宛先を分散させる例（各地方都市が相互に攻撃）:

```spl
| makeresults format=csv data="src_lat,src_lon,dst_lat,dst_lon,severity,count,src_name,dst_name
34.69,135.50,43.06,141.35,high,200,Osaka,Sapporo
33.59,130.40,35.68,139.69,medium,150,Fukuoka,Tokyo
43.06,141.35,34.69,135.50,low,90,Sapporo,Osaka
35.68,139.69,26.21,127.68,high,120,Tokyo,Naha
38.27,140.87,35.18,136.91,medium,60,Sendai,Nagoya"
```

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

---

### [1.0.1] - 2026-07-25

#### 変更

- **データ未取得時のメッセージを全 viz 共通の文言に統一**した。
  「データがありません。サーチ結果を確認してください。」（従来は英語表記や viz ごとに異なる文言だった）。
  ダッシュボードに複数の viz を並べたときに、サーチ未設定の空パネルが揃った見た目になる。


#### 生成物

- `dist/custom_viz_japanmap-1.0.1-2dc2dde.spl`

---

### [1.0.0] - 2026-07-24

[custom-viz-world-map](../custom-viz-world-map/) v1.1.1 をベースにした日本地図版アタックマップ。
仕様は World Map と共通で、地図の下地を都道府県境ありの日本列島に差し替えた新規 viz。

#### 追加
- 新規作成（初回リリース）。
- 都道府県境あり日本地図（**Natural Earth**＝パブリックドメイン／著作権フリー・クレジット不要の
  Admin-1 データ `ne_10m_admin_1_states_provinces` から日本 47 都道府県を抽出し、TopoJSON へ変換・
  簡略化・量子化して同梱。実行時のインターネット通信なし）。投影は `geoMercator` で日本にフィット。
- 都道府県ごとの県境線表示（「都道府県の境界線を表示」オプションで切替）と、県名ツールチップ。
- World Map と同一の機能：起点→終点の弧、弧に沿って流れる光の帯（Canvas）、着弾ホットスポット、
  Severity 色分け（High/Medium/Low＋独自値）、Severity フィルタ、凡例、タイトル、
  `editor.columnSelector` によるフィールド割り当て、ライト/ダークテーマ対応、オートフィット、
  空データ・必須フィールド欠損・型不一致のガード、マウントゲート。
- ローカル検証（`test/verify.mjs`、happy-dom）で 32 項目 pass（県境・県名ツールチップの検証を含む）。
- パッケージ: `dist/custom_viz_japanmap-1.0.0-fe591dc.spl`
