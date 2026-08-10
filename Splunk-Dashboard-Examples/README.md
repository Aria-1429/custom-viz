# Splunk Dashboard Studio ダッシュボード例

このリポジトリの**カスタム viz を並べた Dashboard Studio のダッシュボード定義**（JSON）を置く場所。
viz 本体は [`visualizations/`](../visualizations/) にある。

| ファイル | パネル数 | 概要 |
|---|---|---|
| [`soc_command_center_dashboard.json`](soc_command_center_dashboard.json) | 39 | **SOC コマンドセンター（4タブ）**。カスタム viz 23 種を使った SOC 監視の全体像。**各タブを 1920x980 に収め、縦スクロールが出ない**構成。インシデント対応タブは**クリックでトークンが伝播する**（実機確認済み） |

---

## SOC コマンドセンター

### タブ構成

縦に長い1枚ものにせず、**目的ごとに4タブへ分割**してある。
`layout.tabs` ＋ `layoutDefinitions`（→ [studio-dashboard-json.md](../.claude/skills/splunk-viz/references/studio-dashboard-json.md) §4）。

| タブ | 何を見るタブか | 主な viz |
|---|---|---|
| **概況** | 直近24時間の全体像。規模 → 発生源 → 内訳の順に読む | KPI Tile ×6 / Attack Globe / World Map / Donut Graph / Severity Table / Horizon Chart |
| **脅威分析** | 攻撃の手口と経路。戦術の分布、侵入から流出までの流れ | Sunburst（MITRE ATT&CK）/ Sankey Flow（キルチェーン）/ Heat Matrix / Treemap / Country Graph / Funnel Leak |
| **インシデント対応** | 個別インシデントの調査。**クリックで対象を切り替える** | Severity Table（起点）/ Icon Status / Gauge Arc / Radar Chart / Timeline Swimlane / Waterfall Chart |
| **インフラ健全性** | 監視基盤そのものの状態。SOC が目を塞がれていないかの確認 | Icon Status ＋ Link Line（取り込み系統図）/ VU Console / Liquid Tube / Bullet Graph / Calendar Heatmap / Gradient Bar |

### クリック連動（実機確認済み）

**インシデント対応タブの「対応キュー」で行をクリックすると、右の調査ペインと下段が
そのホストに切り替わる。** 実機で検証した結果:

- `db-primary` の行をクリック → パネルタイトルが3枚とも `web-01 の…` → `db-primary の…` に変化
- **上部のドロップダウンの表示値も `db-primary` に同期した**
- リスクスコアのゲージが 74点 → 88点 に再計算され、レーダーも db-primary のプロファイルに再描画

実装は `severity-table` の `eventHandlers` で `drilldown.setToken`（`row.host.value` → `sel_host`）。
**未選択で空パネルにならないよう `input.dropdown` で初期値 `web-01` を与えてある**
（ドロップダウンとドリルダウンは同じトークンを共有できる）。

### 検証状況

| 項目 | 結果 |
|---|---|
| `validate-dashboard.mjs`（定義との突き合わせ） | ✓ エラー 0 件 |
| `spl-check.mjs`（実機で SPL 実行） | ✓ 28/35。残り 7 は `ds.chain`（ツールが `extend` を解決しないための既知の限界） |
| `ds.chain` 7本の手動検算（親を連結して oneshot 実行） | ✓ 全件 1 行返却 |
| 実機 push ＋ 全4タブのスクリーンショット確認 | ✓ 空表示パネル 0 枚 |
| クリック→トークン伝播 | ✓ 実機で確認（上記） |
| 縦スクロール | ✓ 出ない（ブラウザ表示で全タブ 1 画面に収まることを確認） |

### 注意点

- **必要な viz アプリが全て導入済みであること**（未導入だとそのパネルだけエラーになる）。
  このダッシュボードは 23 種のカスタム viz を使う。
- **データは全て `makeresults` のサンプル**。実データに差し替える場合は `dataSources` の
  `query` を置き換える（`queryParameters` は時間レンジ入力と連動する形にしてある）。
- **Liquid Tube は 1 パネル = 1 本**。複数の値を並べたい場合はパネルを複数置く
  （1 viz に詰め込むと管が細くなり質感が潰れるため。README のデータ仕様どおり）。
- **Spotlight Frame は使っていない**。単体パネルではなく「他パネルに重ねる枠」として
  設計されているため、独立したタイルとしては中身が空になる（実機で確認して Icon Status に差し替えた）。

### 実機へ入れる

```bash
node tools/dashboard-loop/src/sync.mjs Splunk-Dashboard-Examples/soc_command_center_dashboard.json \
     --name soc_command_center --out /tmp/shots --scale 1 --wait 25
```

手貼りする場合は Studio で新規ダッシュボードを作り、「ソースコードを編集」に JSON 全文を貼り付ける。
