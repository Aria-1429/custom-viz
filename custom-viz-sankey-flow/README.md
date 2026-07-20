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
