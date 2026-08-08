# Splunk Custom Visualizations

Splunk **Dashboard Studio** 向けのカスタムビジュアライゼーション集（React/JSX）です。
標準ビジュアライゼーションでは表現できない図を、データドリブン（サーチ結果に応じて描画が変わる）・
ダークライト両テーマ対応・完全オフライン（外部通信なし）で実装しています。
一部にはデータを描くのではなく、**ダッシュボードを操作する**ための部品（タブ等）も含まれます。

各ビジュアライゼーションは `visualizations/<name>/` ディレクトリに独立して収められており、
それぞれ単体でビルド・パッケージ・デプロイできます。編集画面のオプションはすべて日本語ラベルです。

---

## ビジュアライゼーション一覧

### ダッシュボードの操作（データを「見せる」のではなく「絞り込む」）

他のビジュアライゼーションがサーチ結果を描くのに対し、こちらは**ダッシュボード自体を操作する**部品です。
標準の入力（input）では作れない見た目・挙動のコントロールを、ビジュアライゼーションとして実装しています。

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/tab-selector/examples/example.png" width="240"> | **[Tab Selector](visualizations/tab-selector/)**<br>v1.3.2 | クリックでトークンを切り替えるタブバー。「東京／大阪」のようなタブを押すと対応する値がトークンに入り、ダッシュボード全体のサーチが切り替わる。タブの数・名前・トークン値はすべて編集UIから設定でき（`表示名\|トークン値` 形式）、表示名とトークン値を分けられるのでサーチは英字コード・画面は日本語という使い分けができる。選択中は1枚のインジケータが滑って移動し、どのタブへ移ったかを目で追える。形は下線／塗りつぶし／ピル／枠線の4種。**サーチを紐づけずに配置・設定できる**ため、ダッシュボード上部のナビゲーションとして単体で置ける。左右矢印キーにも対応。<br>※ トークン設定には編集画面「インタラクション」の設定が1回必要（カスタム viz は自分でトークンを書けないため）。 |

### フロー・関係の可視化

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/funnel-leak/examples/example.png" width="240"> | **[Funnel Leak](visualizations/funnel-leak/)**<br>v1.1.2 | アニメ付きファネル×リーク図。各段の通過を下へ流し、離脱分を左右にこぼれ落ちる粒子で可視化。コンバージョン／攻撃チェーンの生存分析に。 |
| <img src="visualizations/sankey-flow/examples/example.png" width="240"> | **[Sankey Flow](visualizations/sankey-flow/)**<br>v1.1.2 | 多段サンキー図。グラデーションのリンク、ホバー強調、値ベースのリンク色スケール。 |
| <img src="visualizations/chord-flow/examples/example.png" width="240"> | **[Chord Flow](visualizations/chord-flow/)**<br>v1.1.2 | アニメ付きコード図。リング上のエンティティ間の相互フローをグラデーションリボンで結び、方向付き発光粒子が流れる。 |
| <img src="visualizations/network-graph/examples/example.png" width="240"> | **[Network Graph](visualizations/network-graph/)**<br>v1.1.2 | 力学ベースのフォースダイレクテッド・ネットワーク図。流れる破線エッジ、線幅連動の矢印、ドラッグ／ズーム／パン対応。 |
| <img src="visualizations/link-line/examples/example.png" width="240"> | **[Link Line](visualizations/link-line/)**<br>v1.11.0 | サーバ間コネクタ線。表示画面の「✎ 線を編集」でキャンバス上の線を直接編集（ドラッグ移動・折れ点追加・削除）でき、**値ラベルもドラッグで自由な位置に配置**できる。編集内容はダッシュボードの編集→保存で確定。値→色は**値の範囲**（`editor.threshold`・開区間対応）と**文字列の一致**（`OK|色` 形式。死活監視向け）の2モード。**線クリックのドリルダウン**（トークン設定）、値ラベルの**単位・接続名**表示に対応。質感4種（フラット／ソフトシャドウ／ネオン／立体パイプ）・破線・流れる光の帯（向きは順／逆／双方向）・パルス対応。 |
| <img src="visualizations/spotlight-frame/examples/example.png" width="240"> | **[Spotlight Frame](visualizations/spotlight-frame/)**<br>v1.2.2 | データ駆動のステータス枠。サーチ結果を OK／WARNING／CRITICAL に分類し、パネル外周の枠色・発光・状態バッジ・点滅で表現。複数行は最悪ケースに丸め、件数内訳と Critical 対象名を併記。判定は自動／数値しきい値／文字列一致の3モード。枠だけ表示（frameOnly）で他パネルへ重ね置きでき、単体では控えめだがダッシュボード全体の状態把握を強化する脇役。 |

### 分布・多変量の可視化

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/radar-chart/examples/example.png" width="240"> | **[Radar Chart](visualizations/radar-chart/)**<br>v1.2.2 | レーダー（スパイダー）チャート。共通軸上に複数系列を重ねて比較。 |
| <img src="visualizations/radial-bar/examples/example.png" width="240"> | **[Radial Bar](visualizations/radial-bar/)**<br>v1.1.2 | 放射状カラムチャート。各カテゴリを等角のくさびで描き、値をバーの外側への伸びで表現。中央に合計 KPI、値ベースのカラースケール、フィールド選択、ホバー連動（背景トラックにも反応）、ライト／ダーク両対応。 |
| <img src="visualizations/metric-terrain/examples/example.png" width="240"> | **[Metric Terrain](visualizations/metric-terrain/)**<br>v1.1.2 | 等角投影の疑似3D地形。値の起伏を地形として描き、リアルタイムの陰影・落ち影・回転に対応。 |
| <img src="visualizations/calendar-heatmap/examples/example.png" width="240"> | **[Calendar Heatmap](visualizations/calendar-heatmap/)**<br>v1.1.2 | GitHub 風カレンダーヒートマップ。オートフィットと、編集可能な低／高値カラースケール。 |
| <img src="visualizations/heat-matrix/examples/example.png" width="240"> | **[Heat Matrix](visualizations/heat-matrix/)**<br>v1.1.2 | 汎用ヒートマップ・マトリクス。任意の2軸クロス集計を連続カラースケールの色行列で表示。縦持ち（`stats by A B`）／クロス集計（`chart`・`timechart by`）の自動判別、行／列ごとの色正規化、合計マージン、合計順ソート、時刻ラベル自動整形に対応。 |

### 階層の可視化

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/sunburst/examples/example.png" width="240"> | **[Sunburst](visualizations/sunburst/)**<br>v1.3.2 | 階層構造を同心円の輪で表す放射状チャート。中心が根、外側ほど下の階層で、扇形の角度が値を表す。子は親の角度範囲を過不足なく埋めるため、包含関係が一目で分かる。Treemap が「面積の大小を比べる」のに対し、こちらは「どこで枝分かれしているか」という構造を読むのに向く。階層の深さは無制限（一度に表示する輪の数は指定でき、クリックすれば何階層でも掘り下げられる）。ホバーするとその枝の祖先＋子孫だけが明るく残り、他は暗くなるので系統を追いやすい。中央 KPI クリックで1つ戻る、細い扇形は自動で「その他」に集約。 |
| <img src="visualizations/treemap/examples/example.png" width="240"> | **[Treemap](visualizations/treemap/)**<br>v1.2.2 | 階層構造を面積で表すツリーマップ。`index > sourcetype > host` のような 1〜3 階層の入れ子を一画面に収め、どこが容量・件数を食っているかを示す。squarified レイアウト（Bruls et al.）でタイルの縦横比を 1 に近づけ、細長い短冊による面積比較の破綻を避ける。グループをクリックして掘り下げ、パンくずで復帰。ホバーで階層のパス・値・全体比をツールチップ表示。第1階層で色を決めて子は濃淡で表現するため、掘り下げても枝を見失わない。 |

### 時系列・集計の可視化

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/horizon-chart/examples/example.png" width="240"> | **[Horizon Chart](visualizations/horizon-chart/)**<br>v1.1.2 | 多数の時系列を「畳んで色帯にする」ホライズンチャート。値域を等幅バンドに切り、上のバンドを下へ折り返して重ね、上のバンドほど濃く塗ることで「高さ」の情報を「色の濃さ」に置き換える。これによりレーン高さを 1/バンド数に圧縮でき、1系列 20〜30px で数十系列を同時に比較できる。標準の timechart が系列5本で読めなくなる領域（100台のホストの CPU を縦に積み、どこが同時に跳ねたか見る）を担う。基準値より下は反対色で折り返すので増減の符号も分かる。`timechart` 出力と縦持ちの自動判別、クロスヘア連動の値表示、系列ごとの正規化に対応。 |
| <img src="visualizations/timeline-swimlane/examples/example.png" width="240"> | **[Timeline Swimlane](visualizations/timeline-swimlane/)**<br>v1.3.2 | エンティティ（host/user/process）ごとのレーンにイベントを時刻順で並べるタイムライン。期間イベントは帯、瞬間イベントは点で描画。カーソルを乗せると時刻の縦線が出て、その瞬間に重なるイベントだけが浮かび上がる（スクラブ用クロスヘア）。分類フィールドによる色分け（色覚特性に配慮したパレット）、横ドラッグでの時間範囲の絞り込み、レーン高さのオートフィットに対応。標準の timechart（集計されて個々のイベントが消える）や Events テーブル（レーン分割できない）では再現できないインシデント調査向けの図。 |
| <img src="visualizations/liquid-tube/examples/example.png" width="240"> | **[Liquid Tube](visualizations/liquid-tube/)**<br>v1.0.0 | 試験管に入った液体で単一の値を表すゲージ（**1 viz = 1本**）。液面の高さが値を示す。**ガラス・液体・気泡を WebGL フラグメントシェーダで描画**し、屈折・Beer-Lambert の透過・フレネル反射による立体的な質感を出す（SVG では出せない表現）。気泡は個体差と時間で形が揺らぎ真円にならない。**液体・ガラスを通しても背景が透ける**ためダッシュボードに重ねられ、**外側のグローも消せる**。複数行は集計（最終行／合計／平均／最大／最小／件数）で1値に畳む。色は値の**しきい値**または**固定色**。ドリルダウン対応。**WebGL2 が必要**。 |
| <img src="visualizations/gauge-arc/examples/example.png" width="240"> | **[Gauge Arc](visualizations/gauge-arc/)**<br>v1.3.2 | 単一値のアークゲージ＋サブ情報パネル。主役は1つの数値で、円弧で現在値を大きく見せつつ右（左／下）に副次情報を添える。**ゲージの種類を切り替えられる**のが特徴で、なめらかな「連続」／小片が値まで点灯するイコライザ風の「セグメント」／帯を全周塗って針が現在値を指す車のメーター風の「タコメーター」を選べる。開き角は 180°〜320° の4種。**色が切り替わる位置には境界値を表示**。`editor.threshold` の帯で色分けでき、**境界で階段状に切り替える／滑らかなグラデーション／単色**を選べる。**前回との比較**（直前の行／最初の行／平均／指定フィールド／固定値）を差分＋割合で表示、「増加が良い／減少が良い」で色の意味を反転できる。サブパネルは4スロットで、前回比／サブ指標／帯ごとの内訳／上位ランキング／推移／目標比／凡例／対象期間／自由テキストを自由に割り当てる。標準の SingleValueRadial（単色リング1本・色帯を持てない）と MarkerGauge（横長の棒）では作れない「色帯を持つ半円ゲージ＋周辺情報」を担う。 |
| <img src="visualizations/kpi-tile/examples/example.png" width="240"> | **[KPI Tile](visualizations/kpi-tile/)**<br>v1.4.2 | SOC 風 KPI 統計タイル。大数値＋前日比＋スパークライン＋選択式アイコンバッジをアクセントカラーで統一したネオン調カード。編集モード中はタイル上のアイコンをクリックして変更可能。カード背景の不透明度調整・スパークラインの線グラフ切替（グラデ面塗り＋最新点ドット）対応。 |
| <img src="visualizations/icon-status/examples/example.png" width="240"> | **[Icon Status](visualizations/icon-status/)**<br>v1.1.4 | 単一値を「アイコンそのもの」で見せるステータスタイル。SOC でよく使う 12 種（サーバー／DB／シールド／警告／錠前／ネットワーク機器／ユーザー／監視／クラウド／ファイアウォール／エンドポイント／バグ）を切り替えられる。アイコンは線画ではなく**多層 SVG による立体表現**で、レイヤーごとに色そのものではなく「色ロール」（上面／前面／側面／差し色／陰／グロー）を持たせ、基準色1色から全レイヤーの色を導出する。このため `editor.threshold` で値が帯をまたぐと、**面の陰影・差し色・発光まで一斉に連動して色が変わる**（ラスタ画像では不可能）。質感は立体／線画を選べ、小さいパネルでは自動で線画に退避。演出（グロー・接地シャドウ・パルスリング）は個別に ON/OFF 可。集計は最終行／合計／平均／最大／最小／件数。KPI Tile が「数値を主役に周辺情報を添える」のに対し、こちらは**アイコンの見た目そのものが状態を語る**壁掛けステータス表示を担う。 |
| <img src="visualizations/bullet-graph/examples/example.png" width="240"> | **[Bullet Graph](visualizations/bullet-graph/)**<br>v1.1.2 | ブレットグラフ KPI リスト。実績バー＋目標ティック＋良／可／不可の質的バンドを 1 行に重畳し、多数の指標を目標比つきで高密度に一覧。達成度の自動色分け・達成率表示・目標／比較列の名前自動検出・range 列の絶対バンド指定に対応。 |
| <img src="visualizations/waterfall-chart/examples/example.png" width="240"> | **[Waterfall Chart](visualizations/waterfall-chart/)**<br>v1.1.2 | ウォーターフォール（滝／ブリッジ）チャート。増減の積み上げが合計へ届く過程を階段状バーで可視化。種別列（start/total）の自動検出、累計値モード、合計バー自動追加、破線コネクタ付き。 |
| <img src="visualizations/donut-graph/examples/example.png" width="240"> | **[Donut Graph](visualizations/donut-graph/)**<br>v1.1.2 | ドーナツチャート。中央に合計、詳細な凡例付き。 |
| <img src="visualizations/donut-timechart/examples/example.png" width="240"> | **[Donut Timechart](visualizations/donut-timechart/)**<br>v1.1.2 | ドーナツ＋詳細凡例＋トレンド・スパークラインを組み合わせたステータスカード。 |
| <img src="visualizations/gradient-bar/examples/example.png" width="240"> | **[Gradient Bar](visualizations/gradient-bar/)**<br>v1.1.2 | グラデーションの縦棒グラフ。 |
| <img src="visualizations/severity-table/examples/example.png" width="240"> | **[Severity Table](visualizations/severity-table/)** <br>v2.2.1 | 重要度を色分けするテーブル。深刻度の順位・別名・色・並び順・一覧にない値の扱いまで、判定ルールをすべて編集画面で設定できる。列幅は見出しの境界をドラッグして自由に変更でき、セルのクリックでトークン設定も可能。 |

### 地理の可視化

| プレビュー | 名前 / バージョン | 概要 |
| --- | --- | --- |
| <img src="visualizations/attack-globe/examples/example.png" width="240"> | **[Attack Globe](visualizations/attack-globe/)**<br>v1.1.0 | **回転する3D地球儀のアタックマップ（WebGL）**。フラグメントシェーダでレイトレースした球体地球に、起点→終点の大円アークを描く。弧は発光ハロー＋芯線の2本構えで、テーパー形状の彗星が流れ、終点到達時にリップルが広がる（World Map と同じ質感）。球の裏側に回った弧は自動的に隠れ、着弾点は放射グラデーションのグロー＋コアドットで強調。フレネルの大気の縁光・経緯線グリッド・国境線・陰影3モード（柔らかい/フラット/**昼夜ターミネーター**）を装備。陸地は Natural Earth のポリゴンを初期化時にテクスチャへラスタライズ（解像度3段階）。**ドラッグで回転（慣性付き）・ホイールでズーム・放置で自転**（周期指定・0で停止）。色分けはカテゴリ「名前\|色」明示指定または件数しきい値、凡例にカテゴリ別件数。弧・着弾点のクリックでドリルダウン（トークン設定）。**背景透過**でダッシュボードに地球が浮かぶ。データ仕様は World Map と共通（同じ SPL が使える）。分析には平面の World Map、展示・壁掛けにはこちら。**WebGL2 が必要**。 |
| <img src="visualizations/world-map/examples/example.png" width="240"> | **[World Map](visualizations/world-map/)**<br>v1.10.1 | 世界地図上に起点→終点の弧を描くフローマップ。弧に沿って光の帯が流れ、着弾点をホットスポット表示。**地図アプリのようにホイールでズーム／ドラッグで移動**でき、拡大に応じて国名→都市名の地名ラベルが現れる（Natural Earth 約7,340都市を同梱）。色分けは深刻度専用ではなく**任意の列**（ログ種別・ステータス等）で行い、色は「カテゴリ名\|色」でユーザーが明示指定する（viz は語彙を推測しない）。色分けは count の**しきい値バンド**でも可能。**近接した地点は自動でまとめられ（ズームすると分離）**、凡例には**「表示◯◯／全◯◯」の件数とカテゴリ別件数**が出る。**地名の日本語表示**・ズーム時の**50m 高解像度国境**・カスタムツールチップに対応。凡例クリックで絞り込み、弧・地点のクリックでドリルダウン（トークン設定）も可能。**スタイルプリセット**（管制室ダーク／ドットマトリクス／大円航路図／ミニマル）で、経緯線グリッド・ドット絵風の陸地・大円航路の弧・HUD統計行（LIVE＋総件数）を1操作で切り替えられる。国境は海岸線と内側国境の2階調、ドラッグは慣性付き。 |
| <img src="visualizations/japan-map/examples/example.png" width="240"> | **[Japan Map](visualizations/japan-map/)**<br>v1.2.2 | World Map の日本地図版。都道府県境あり（県名ツールチップ付き）の日本列島に、国内の起点→終点の弧＋流れる光の帯＋ホットスポットを描く。仕様は World Map と共通。 |
| <img src="visualizations/country-graph/examples/example.png" width="240"> | **[Country Graph](visualizations/country-graph/)**<br>v1.1.3 | 国旗付きの国別ランキング棒グラフ。上位 N 制限・ソート・低／高値カラースケール。登場アニメーションは他 viz と同じ「マウント後フラグ＋inline transition」方式で、最終状態が常に inline style に載るため PNG 書き出しでも欠けない。 |

> 各ビジュアライゼーションの詳細（データ仕様・編集オプション・サンプル SPL）は、
> それぞれのディレクトリ内 `README.md` を参照してください。

---

## ディレクトリ構成

```
custom-viz/
├── README.md                           ← このファイル（全体一覧）
├── .gitignore
├── visualizations/                     ← 各ビジュアライゼーション（独立してビルド可能）
│   └── <name>/                         ← 例: horizon-chart, sunburst, treemap …
│       ├── README.md                   ← 個別の詳細ドキュメント
│       ├── package.json / build.mjs / package.mjs
│       ├── build-plugins/
│       ├── package/app/app.conf        ← Splunk アプリ定義（id, version, label…）
│       ├── examples/example.png        ← プレビュー画像
│       ├── test/verify.mjs             ← happy-dom によるローカル検証
│       └── visualizations/custom_viz_<name>/
│           ├── config.json             ← dataContract, optionsSchema, editorConfig
│           └── src/visualization.jsx   ← 実装本体
└── Splunk-Dashboard-Examples/          ← これらの viz を並べた Dashboard Studio の JSON（そのまま取り込めます）

※ フォルダ名は `<name>`（例 `horizon-chart`）、Splunk のアプリ ID は
　 `custom_viz_<name>`（例 `custom_viz_horizon_chart`）で対応します。
```

---

## 開発コマンド（各 viz ディレクトリ内で実行）

```bash
cd visualizations/<name>
yarn install
yarn build        # dist/custom_viz_<name>/visualization.js を生成（esbuild）
yarn verify       # happy-dom によるローカル検証（Splunk 実機不要）
yarn package      # dist/*.spl を生成
```

## デプロイ（アンインストール・再起動なし）

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`package/app/app.conf` の version も同期。
2. `yarn build && yarn package` で新しい `.spl` を生成。
3. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
4. `https://<host>:8000/en-US/_bump` で **Bump version**（Splunk 再起動の代替）→ ブラウザをハードリロード（Ctrl+Shift+R）。

---

## 新しいビジュアライゼーションを追加するには

1. 既存の viz（例 `visualizations/donut-graph`）をベースディレクトリごと複製する。
2. 識別子を置換する：
   - `package.json` … `name`, `description`, `version`
   - `package/app/app.conf` … `[package] id`, `[id] name`, `[ui] label`, `[launcher] description`
   - `visualizations/custom_viz_<new>/config.json` … `config.name`, `config.description`, `optionsSchema`, `editorConfig`
   - `visualizations/custom_viz_<new>/src/visualization.jsx` … 実装本体
3. `examples/example.png` に表示例のスクリーンショットを置く。
4. 個別 `README.md` を作成し、本ファイル（ルート README）の一覧表にも 1 行追加する。

---

## 設計上の共通ルール

- **完全オフライン**：外部 API フェッチ・CDN 読み込みは禁止。依存はすべてバンドルに同梱。
- **テーマガード**：`useTheme()` が undefined の間はレンダリングせず、取得後のみ描画。
- **データ正規化**：`rows` / `columns` 両形式に対応し、欠損・型不一致・マルチバリューでも落とさない。
- **オートフィット**：`ResizeObserver` でコンテナ実寸を測り、領域いっぱいに描画。
- **値→色**：`editor.dynamicColor` はカスタム viz で使えないため、値ベースのカラースケールを自前実装。
- 編集画面のオプションラベルはすべて日本語（キー名は英語）。
- **データ未取得時のメッセージ**：全 viz 共通で
  「データがありません。サーチ結果を確認してください。」をパネル中央に表示する。
  データ形式の案内が要る場合は、この文言を本文として残したうえで副文（小さめ・薄め）で添える。
  ※ 例外は2つ。Link Line はデータが無くても線をニュートラル色で描き続ける仕様。
  Tab Selector は**そもそもサーチ結果を使わない**ため、代わりに
  「タブが設定されていません。」と設定手順を案内する。
- **サーチを使わない viz の `dataContract`**：`requiredDataSources` だけでなく
  **`optionalDataSources` も空配列**にする。`primary` を「任意」で挙げているだけで
  ホストがデータソースの指定を求め、**サーチを紐づけないと設定できなくなる**
  （データ不要の標準 viz＝Markdown / RichText / Image と同じ形にする）。
- **ソースに生の制御文字を書かない**：マップのキー区切り等で NUL を使う場合も
  `'\u0000'` のようにエスケープで書く。生のバイトが入ると grep がファイルを
  バイナリ扱いし、検索・レビューができなくなる。
