# custom-viz-metric-terrain

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（**等角投影の疑似3Dメトリック地形**）。

サーチ結果の値を**起伏の高さ**に持つ 3D 地形サーフェスとして描画する。値が高いほど地面が
「山」として盛り上がり、標高カラースケール・光源による陰影・落ち影・土台・ワイヤーフレームで
立体的に見せる。`autoRotate` を有効にすると地形がゆっくり回転し、あらゆる角度から山谷を確認できる。

2軸のカテゴリ（例: ホスト × 時間帯、地域 × 製品）に対する集計値の「地形」を俯瞰する用途に向く。
標準の面／棒／ヒートマップでは表現できない、**値の起伏を立体で直感的に掴む**ためのビジュアライゼーション。

## データモデル

2つの入力形式を**自動判別**する。

### A. tidy / long 形式（推奨）: `[X, Y, 値]`

| 列   | 役割                                                    |
| ---- | ------------------------------------------------------- |
| X軸  | 格子の横方向カテゴリ（既定=第1列）                      |
| Y軸  | 格子の奥行き方向カテゴリ（既定=第2列）                  |
| 値   | 標高（山の高さ）になる数値（既定=最終列）               |

- 同じ `(X, Y)` セルが複数行ある場合は**合算**する。
- 欠損セル（その X×Y の組み合わせが無い）は標高 0 として敷き詰める。
- `| stats sum(bytes) by host, hour` のような集計をそのまま渡せる。

### B. matrix 形式: `[行ラベル, 数値列1, 数値列2, …]`

- 第1列＝行（Y軸）ラベル、残りの数値列がそのまま格子の1行になる（列名が X 軸）。
- `| chart sum(count) over host by status` や `| timechart` の出力をそのまま食える。
- Y軸フィールドを明示指定した場合は常に tidy 形式として扱う。

> **フィールド選択**: 編集画面の「データ」セクションで X / Y / 値フィールドをドロップダウンから
> 選べる（空欄なら上記の既定列にフォールバック）。マルチバリューセルは可能な範囲で救済する。
> 格子が大きすぎる場合（各軸 80 超 or 総セル 3600 超）は自動で粗くリサンプルする（ヘッダーに明示）。

## 特徴（デフォルト viz では不可能な領域）

- **値 → 起伏**: 各セルの値を正規化し、`yaw`（水平回転）と `pitch`（俯角）の回転行列で
  四隅を 2D 投影。ペインターズアルゴリズム（奥→手前）で SVG ポリゴンとして塗り重ねる立体地形。
- **リアルタイム回転**: `autoRotate` 有効時、`requestAnimationFrame` ループが毎フレーム
  全ジオメトリを再投影して `points` を直接更新（React 再レンダー無しの命令的描画）。
- **陰影**: 各面の 3D 法線 × 光源方向のランバート反射で明暗を付け、標高カラースケールと合成。
  光源方位も回転する地形に対して固定なので、回っていると陰影が動いて立体感が増す。
- **標高カラースケール**: 低→(中)→高→頂点の 4 段補間。色はすべて `editor.color` で編集可能
  （`editor.dynamicColor` はカスタム viz で使えないため、値ベースのカラースケールを自前実装）。
- **落ち影・土台・ワイヤーフレーム・頂点マーカー**: ダークテーマでは接地影と高標高部の発光、
  外周の側面押し出し（土台）、格子のワイヤーフレーム、最高地点の脈動マーカーを重ねる。

## オプション（編集画面・日本語ラベル）

- **データ**: X軸／Y軸／値フィールドの選択。
- **地形と視点**: 起伏の高さ、yaw、pitch、自動回転、回転速度。
- **標高カラースケール**: 低／中／高／頂点の色、中間色・頂点色の ON/OFF、反転、スケール下限・上限。
- **陰影とスタイル**: 陰影の強さ、光源の方位、ワイヤーフレーム、地面の影、土台、発光。
- **表示**: サマリーヘッダー、軸ラベル、凡例、最高地点マーカー。
- **デバッグ**: options 診断オーバーレイ。

## 開発コマンド

```bash
yarn install
yarn build      # dist/custom_viz_metric_terrain/visualization.js を生成
yarn verify     # happy-dom でバンドルをローカル検証（Splunk 実機不要）
yarn package    # dist/*.spl を生成
```

## デプロイ（アンインストール・再起動なし）

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`package/app/app.conf` の
   `version` も同期。`yarn build && yarn package` で新しい `.spl` を生成。
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**。
4. ブラウザをハードリロード（Ctrl+Shift+R）。

## サンプル SPL（`makeresults` ベース）

### tidy 形式（ホスト × 時間帯の CPU 使用率地形）

```spl
| makeresults format=csv data="host,hour,cpu
web01,00,12
web01,06,35
web01,12,88
web01,18,54
web02,00,20
web02,06,60
web02,12,95
web02,18,40
web03,00,8
web03,06,22
web03,12,44
web03,18,70
db01,00,30
db01,06,50
db01,12,66
db01,18,90"
```

### tidy 形式（実データ風・地域 × 製品の売上を山にする）

```spl
| makeresults format=csv data="region,product,revenue
APAC,Widgets,120
APAC,Gadgets,80
APAC,Gizmos,200
EMEA,Widgets,60
EMEA,Gadgets,140
EMEA,Gizmos,90
AMER,Widgets,300
AMER,Gadgets,110
AMER,Gizmos,175"
```

### matrix 形式（chart 出力をそのまま）

```spl
| makeresults format=csv data="host,ok,warning,error
web01,420,30,5
web02,380,55,12
web03,510,18,3
db01,290,40,22"
```

### 大きめの連続地形（sine 波でなだらかな山を作る動作確認）

```spl
| makeresults count=400
| streamstats count as i
| eval x=(i%20), y=floor(i/20)
| eval value=round(50 + 40*sin(x/3) + 30*cos(y/3), 1)
| table x y value
```

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

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
- `dist/custom_viz_metric_terrain-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

値の大小を起伏の高さに変換して描く、等角投影の疑似 3D メトリック地形。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_metric_terrain-1.0.0-beb3d05.spl`
