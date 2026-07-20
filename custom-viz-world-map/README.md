# custom-viz-world-map

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（世界地図＋アタックマップ）。

世界地図上に「起点（src）→ 終点（dst）」を弧で描き、弧に沿って光の筋が流れるアニメーションで
攻撃・脅威の流れを可視化する。Severity（High / Medium / Low）ごとに色分けし、着弾点をホット
スポットとして強調表示する。

世界地図データ（`world-atlas`）はビルド時にバンドルされるため、**実行時のインターネット通信は
不要**（本番 Splunk 環境の制約に準拠）。

## 特徴

- データドリブン描画（SPL の結果から起点・終点の弧を自動生成）
- Severity（High / Medium / Low ＋任意の独自値）で色分け、着弾点をホットスポット表示
- 弧に沿って光の筋が流れるアニメーション（速度変更・停止可）
- **編集画面のフィールド選択**（`editor.columnSelector`）で任意の列を緯度経度・Severity 等に割り当て可能
- ホットスポットと弧にツールチップ（地点名・Severity・count）
- タイトル / 凡例 / Severity フィルタの表示切替オプション
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

フィールドの決め方（優先順）:

1. 編集画面「データフィールド」セクションのフィールド選択（任意の列名を割り当て可能）
2. 未選択の場合は上表の候補名で自動判定（大文字小文字を問わない）

## オプション（ダッシュボード編集画面）

| セクション | オプション | 説明 |
| --- | --- | --- |
| データフィールド | 送信元/宛先の緯度・経度 ほか | 使用する列の明示指定（未設定は自動判定） |
| 表示 | タイトルを表示 / 凡例を表示 / 深刻度フィルタを表示 | 各オーバーレイの表示切替 |
| 表示 | アニメーション周期（秒、0で停止） | 光の筋がパスを走り切る秒数。`0` で全アニメーション停止（静的表示） |
| 線の色 | High（高）/ Medium（中）/ Low（低）/ その他の深刻度 1–4 | Severity ごとの線・ホットスポット色 |
| 背景 / 陸地 | 背景色・陸地色 | チェック ON 時のみカスタム色（transparent 指定で非表示） |

タイトル文字列は既定で `GLOBAL THREAT MAP`。変更する場合はダッシュボード定義（ソース編集）で
`options.titleText` を設定する（編集 UI には出さない設計）。

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

lookup 不要（座標を直接指定。フィールド名は自動判定される）:

```spl
| makeresults format=csv data="src_lat,src_lon,dst_lat,dst_lon,severity,count,src_name,dst_name
51.51,-0.13,35.68,139.69,low,120,London,Tokyo
31.23,121.47,35.68,139.69,high,300,Shanghai,Tokyo
55.76,37.62,35.68,139.69,high,50,Moscow,Tokyo
-23.55,-46.63,35.68,139.69,medium,80,Sao Paulo,Tokyo
28.61,77.21,35.68,139.69,medium,60,Delhi,Tokyo
40.71,-74.01,35.68,139.69,low,10,New York,Tokyo
-33.87,151.21,35.68,139.69,scan,40,Sydney,Tokyo"
```

`major_cities` lookup を使う場合:

```spl
| makeresults format=csv data="src_city,dest_city,severity,count
London,Tokyo,low,1000
Shanghai,Tokyo,high,2000
Moscow,Tokyo,high,3000
Sao Paulo,Tokyo,medium,4000
Delhi,Tokyo,medium,5000
New York,Tokyo,low,6000
Los Angeles,Tokyo,low,7000
Dallas,Tokyo,medium,8000
Sydney,Tokyo,low,9000"
| lookup major_cities city as src_city OUTPUT lat as src_lat lon as src_lon
| lookup major_cities city as dest_city OUTPUT lat as dest_lat lon as dest_lon
```
