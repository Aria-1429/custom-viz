# Custom Viz Heat Matrix

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション。
任意の2軸クロス集計を「色の行列」で表示する汎用**ヒートマップ・マトリクス**です。

Splunk 標準にはドットサイズで表す punchcard しかなく、連続カラースケール・セル値表示・
行/列ごとの色正規化・合計マージン・合計順ソートを備えた本物のヒートマップは
標準ビジュアライゼーションでは再現できません。

## 特徴

- **2つのデータ形式を自動判別**
  - 縦持ち（tidy）: `stats count by A, B`（2列目が非数値なら自動判定。同一セルは合算）
  - クロス集計（matrix）: `chart ... over A by B` / `timechart by` の出力をそのまま描画
  - `editor.columnSelector` による行/列/値フィールドの明示選択はどちらでも自動判定より優先
- **値→色の連続カラースケール**（low →（mid）→ high を自前補間。`editor.dynamicColor` 非依存）
  - 低⇔高の反転、スケール上限/下限の固定（空欄=データの min/max 自動）
  - **行ごと / 列ごとの色正規化**（行内・列内の相対的な濃淡でパターンを見る）
- セル内の値表示（背景色に応じて文字色を白/黒に自動切替。入らなければ自動で非表示）
- 行/列の**合計マージン**表示、合計の大きい順ソート
- `_time` / ISO 日付ラベルは粒度に応じて自動整形（同日なら HH:MM、日単位なら M/D）
- 欠損セル（組み合わせにデータが無い）は 0 と区別して薄いニュートラル色で表示
- カラー凡例（グラデーションバー + min/max）、ツールチップ（値と全体比%）
- コンテナ実寸へ自動フィット。行数が多いときは縦スクロール、極小セルではラベル・値を段階退避
- マルチバリューセルの救済、rows/columns 両形式対応、ライト/ダークテーマ対応
- 編集画面のオプションラベルは日本語

## データ仕様

| 形式 | 例 | 解釈 |
|---|---|---|
| 縦持ち | `stats count by host, status` | 第1列=行、第2列=列、最初の数値列=値 |
| クロス集計 | `chart count over host by sourcetype` | 第1列=行、残りの数値列=横軸 |
| 時系列 | `timechart span=1h count by host` | `_time`=行（自動整形）、系列=横軸 |

- 描画上限は 300行 × 120列（超過分は先頭を残して省略し、凡例行に注記）
- 同一 (行, 列) の重複行は合算

## サンプルSPL

クロス集計（ホスト × ログレベル）:

```spl
| makeresults format=csv data="host,ERROR,WARN,INFO
web-01,10,40,100
web-02,90,20,50
db-01,0,5,200
cache-01,3,12,80"
```

縦持ち（ユーザー × アクション、`stats` 出力相当）:

```spl
| makeresults format=csv data="user,action,count
alice,login,42
alice,logout,40
alice,upload,7
bob,login,18
bob,upload,31
carol,login,5
carol,delete,12"
```

時間帯 × 曜日のアクセスパターン（縦持ち）:

```spl
| makeresults format=csv data="hour,day,count
00,Mon,12
00,Tue,8
06,Mon,45
06,Tue,52
12,Mon,180
12,Tue,165
18,Mon,220
18,Tue,90"
```

実データ例:

```spl
index=_internal | stats count by sourcetype, log_level
```

## 開発

```bash
yarn install
yarn build      # dist/custom_viz_heat_matrix/visualization.js
yarn verify     # happy-dom によるローカル検証（62 チェック）
yarn package    # dist/custom_viz_heat_matrix-<ver>-<hash>.spl
```

## デプロイ

1. `npm version patch --no-git-tag-version` でバージョンを上げ、`package/app/app.conf` の version も同期
2. `yarn build && yarn package`
3. Splunk Web「Install app from file」で **Upgrade app にチェック**して `.spl` をアップロード
4. `https://<host>:8000/en-US/_bump` で Bump version → ブラウザをハードリロード（Ctrl+Shift+R）

Dashboard Studio の JSON では `"type": "custom_viz_heat_matrix.custom_viz_heat_matrix"`。
