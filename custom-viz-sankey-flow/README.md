# custom-viz-sankey-flow

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（Sankey フロー図・多段対応）。

ネットワークトラフィックの経路、ユーザーの画面遷移、売上の内訳フローなど、
**「どこから、どこへ、どれだけ流れたか」** を帯の太さで表す。

## 特徴

- **2つの入力モード**
  - 3列 `source, target, value` … 自由グラフモード。`a→b`, `b→c` を行として並べれば多段の連鎖になる。循環リンク（`c→a` など）は値の小さいものから自動除去。
  - 4列以上 `stage1, stage2, ..., value` … ステージモード。列がそのまま段になり、各行がパス全体に値を流す（`stats sum(x) by f1 f2 f3` の結果をそのまま入れられる）。
- **グラデーションリンク** … ソースノード色→ターゲットノード色の SVG グラデーション（既定 ON）
- **値ベースのリンク着色** … 低値色→(中間色)→高値色の自前カラースケール。色・反転を編集画面で設定でき、確実に反映される（`editor.dynamicColor` はカスタム viz では使えないため不採用）
- **ホバーハイライト** … ノード/リンクにホバーすると関連フローだけ強調＋ツールチップ（値・全体比・入出次数）
- **サマリーヘッダー** … 総流量・段数・ノード数・リンク数・除去した行数を表示
- **オートフィット** … ResizeObserver でコンテナ実寸に追従。ラベルは細いノードで自動的に隠す
- **堅牢性** … rows/columns 両形式、カンマ付き数値、空カテゴリ・非数値・0以下の行、空データ、テーマ未取得をすべてガード。同一 (source, target) は合算。リンクは値の大きい順に最大500本
- ライト/ダークテーマ対応。ノード色は Splunk 配色に寄せた12色パレット（同名ノードは段が違っても同色）

## データ仕様

| 列 | 内容 |
|---|---|
| 最終列 | 数値（フロー量）。カンマ付き文字列も可。0以下・非数値の行は無視 |
| それ以外の列 | 経路のステージ（カテゴリ文字列）。空欄の行は無視 |

## オプション（ダッシュボード編集画面）

| セクション | 項目 |
|---|---|
| Links | グラデーションリンク / 不透明度(%) / 値ベース着色 (low・mid・high 色, 3色スケール, 反転) |
| Nodes | ノード幅(px) / ノード間隔(px) |
| Labels | ラベル表示 / 値の併記 / 文字サイズ(0=自動) |
| Display | サマリーヘッダー / ホバーハイライト |
| Debug | options 生値のオーバーレイ表示 |

## 開発

```bash
yarn install
yarn build      # dist/custom_viz_sankey_flow/visualization.js
yarn package    # dist/custom_viz_sankey_flow-<ver>-<hash>.spl
```

依存: レイアウトは `d3-sankey`（純粋な計算ライブラリ。バンドルに同梱され、実行時のネットワーク通信は一切なし）。

## デプロイ（アンインストール・再起動不要）

1. `npm version patch --no-git-tag-version` でバージョンを上げ、`package/app/app.conf` の `version` も同期
2. `yarn build && yarn package`
3. Splunk Web「Install app from file」で **Upgrade app にチェック**して `.spl` をアップロード
4. `https://<host>:8000/en-US/_bump` で Bump version → ブラウザをハードリロード (Ctrl+Shift+R)

## サンプル SPL

### 3列（自由グラフモード）— ネットワークフロー

```spl
| makeresults format=csv data="source,target,bytes
Internet,Firewall,5200
Internet,VPN,1400
Firewall,Web Server,3600
Firewall,App Server,1500
VPN,App Server,900
Web Server,Database,2100
App Server,Database,1700"
| table source target bytes
```

### 4列（ステージモード）— 売上フロー

```spl
| makeresults format=csv data="region,product,channel,revenue
APAC,Widgets,Online,120
APAC,Widgets,Retail,60
APAC,Gadgets,Online,80
EMEA,Widgets,Online,90
EMEA,Gadgets,Retail,70
AMER,Gadgets,Online,140
AMER,Widgets,Retail,50"
| table region product channel revenue
```

### 実データの例

```spl
index=web sourcetype=access_combined
| stats sum(bytes) as bytes by src_ip, dest_ip
| sort - bytes | head 50
| table src_ip dest_ip bytes
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
- `dist/custom_viz_sankey_flow-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

多段対応の Sankey（サンキー）フロー図。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_sankey_flow-1.0.0-beb3d05.spl`
