# Custom Viz Spotlight Frame

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション。
パネルの外周を **色付きの枠＋発光＋状態バッジ** で縁取り、サーチ結果の状態値（severity / status / 件数）に応じて色・点滅・バッジが変わる「データ駆動のステータス枠」。

単体では中身をほとんど持たない **脇役** だが、ダッシュボード上で他パネルに重ねる／隣に置くことで「今どこが危険か」を視線を上げた瞬間に伝える。`link-line` と同じく、それ自体が主役ではなくダッシュボード全体の意味づけを強化する部品として使う。

## 特徴

- **状態で枠色が変わる**: サーチ結果を OK / WARNING / CRITICAL の 3 段階に分類し、枠線・発光・バッジの色を切り替え（各色は編集パネルで指定）
- **最悪ケースに丸める**: 複数行のデータは「一番深刻な状態」で枠色を決める（1 件でも Critical があれば赤）。各状態の件数を集計してバッジに `CRITICAL · Crit 3 / Warn 12 / OK 40` と内訳表示。Critical のラベル（対象名）も併記
- **3 つの判定モード**:
  - `0 = 自動`: 値が数値ならしきい値、文字列なら既知キーワード（critical/error/warn/ok…）で判定
  - `1 = 数値しきい値`: warn/crit のしきい値で判定（「大きいほど悪い」を反転すれば可用性% など小さいほど悪い指標にも対応）
  - `2 = 文字列一致`: severity 文字列で判定
- **点滅（パルス）**: 危険時のみ／警告以上／常時／なし を選択、周期も指定（0 で停止）
- **枠だけ表示（frameOnly）**: 中央を透明化して他パネルへ重ね置きできる
- 枠の太さ・角丸・発光の強さ・背景の塗り不透明度を編集パネルで調整。ライト/ダークテーマ両対応
- コンテナ実寸へ自動フィット。小さいパネルではタイトル → 件数内訳を段階退避

## データ仕様

1 行 = 1 つの判定対象。

| 列 | 意味 | 既定 |
|---|---|---|
| 状態値列 | severity 文字列（critical/warn/ok…）または数値 | 最終列 |
| ラベル列 | 対象名（任意。Critical の内訳表示に使用） | 第1列 |

- フィールドは編集パネルの「データフィールド」（columnSelector）で選択可
- タイトルは状態値フィールド名を表示（SPL の `rename` で日本語化するのが手軽）。`titleText` オプション（ソース JSON 編集）でも上書き可
- OK/WARNING/CRITICAL のバッジ文言は `okLabel` / `warnLabel` / `critLabel` オプション（ソース JSON 編集）で変更可
- 1 列だけの結果は「状態値のみの系列」として扱う

### 状態判定に使うキーワード（文字列モード / 自動モード）

- **CRITICAL**: `crit` `critical` `fatal` `error` `down` `fail` `alert` `high` `severe` `sev1` `p1` `緊急` `重大` `危険` `異常` `停止` など
- **WARNING**: `warn` `warning` `medium` `minor` `degrad` `sev2` `sev3` `p2` `p3` `警告` `注意` など
- **OK**: `ok` `up` `healthy` `normal` `good` `pass` `low` `info` `success` `正常` `成功` など

## サンプル SPL

### 文字列 severity（自動判定）

```spl
| makeresults format=csv data="host,severity
web-01,ok
web-02,warning
api-01,critical
api-02,warning
db-01,ok"
| table host, severity
```

→ 1 件 critical があるので枠は **赤（CRITICAL）**、バッジに `Crit 1 / Warn 2 / OK 2` と `api-01` を表示。

### 数値しきい値（エラー件数）

```spl
| makeresults format=csv data="host,errors
web-01,0
web-02,3
api-01,12"
| table host, errors
```

編集パネルで **判定モード=1**、**警告のしきい値=3**、**危険のしきい値=10**、**大きいほど悪い=ON** にすると、12 件のホストで **CRITICAL**。

### 可用性%（小さいほど悪い）

```spl
| makeresults format=csv data="svc,uptime
auth,99.9
cart,95
search,80"
| table svc, uptime
```

判定モード=1、警告=98、危険=90、**大きいほど悪い=OFF** で、80% のサービスが **CRITICAL**。

### 単一の状態値

```spl
| makeresults
| eval status = "CRITICAL"
| table status
```

## 使い方のヒント

- **重ね置き**: `frameOnly=ON` にして枠だけにし、既存の表やグラフのパネルと同じ位置・サイズで重ねると、そのパネルの外周が状態色で縁取られる
- **セクションの見張り番**: 関連パネル群の背後に大きめに置き、配下の集計 SPL（`stats count by severity` など）を食わせると、そのセクション全体の状態が一目で分かる
- **編集モード**: このビジュアライゼーションは表示専用（クリック操作 UI を持たない）ため、編集モードの iframe 入力遮断の影響を受けない。色・しきい値などはすべて右パネルで設定する

## 開発

```bash
yarn install
yarn build      # dist/custom_viz_spotlight_frame/visualization.js を生成
yarn verify     # happy-dom でローカル検証（実機不要）
yarn package    # dist/custom_viz_spotlight_frame-<ver>-<hash>.spl を生成
```

## デプロイ

1. `yarn build && yarn package` で `.spl` を生成
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**してアップロード
3. `https://<host>:8000/en-US/_bump` で **Bump version**
4. ブラウザをハードリロード（Ctrl+Shift+R）

---

## リリースノート

[Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) 準拠 / [SemVer](https://semver.org/lang/ja/)。

### [1.0.0] - 2026-07-24

#### 追加

- 新規作成（初回リリース）。データ駆動のステータス枠ビジュアライゼーション。
  - サーチ結果を OK / WARNING / CRITICAL の 3 段階に分類し、枠線・発光・状態バッジの色を切り替え
  - 複数行は「最悪の状態」に丸めて枠色を決定。各状態の件数と Critical の対象名をバッジ／内訳に表示
  - 3 つの判定モード（0=自動 / 1=数値しきい値 / 2=文字列一致）、しきい値・「大きいほど悪い」反転に対応
  - 点滅（なし／警告以上／危険のみ／常時、周期指定）、枠だけ表示（frameOnly）、枠の太さ・角丸・発光の強さ・背景の塗り不透明度を編集パネルで調整
  - ライト/ダークテーマ両対応、コンテナ実寸への自動フィット、マウントゲートによる安定描画
  - 生成物: `dist/custom_viz_spotlight_frame-1.0.0-e95b0ae.spl`
