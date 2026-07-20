# custom-viz-donut-graph

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

1. `npm version patch --no-git-tag-version && yarn build && yarn package` でバージョンを上げて `.spl` を生成
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
