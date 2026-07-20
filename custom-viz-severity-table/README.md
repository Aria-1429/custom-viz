# custom-viz-severity-table

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（重要度色分けテーブル）。

サーチ結果をテーブルとして表示し、`severity`（重要度）系の列を値に応じて色分けする。
セキュリティイベント一覧やアラート一覧などを、重要度が直感的に読めるテーブルで可視化する。

## 特徴

- **データドリブン描画**：サーチ結果の全列をテーブル表示
- **重要度の色分け**：`critical` / `high` / `medium` / `low` / `info`（`informational`）。
  `error`・`warning`・`notice` などのエイリアスも吸収する
- **深刻度フィールドの自動判定 + 手動指定**：`severity` / `sev` / `priority` / `urgency` /
  `level` / `risk` を自動判定。編集画面のフィールド選択（`columnSelector`）で明示指定も可能
- **数値の深刻度対応**：`urgency`（1〜5）や CVSS のような数値列を、閾値で 5 レベルへマッピング
- **深刻度でソート**：重大→情報の順に並べ替え（安定ソート。同レベルは元の順序を維持）
- **件数サマリ**：上部に深刻度ごとの件数を集計表示（データ駆動）
- **最大表示行数**：大量の結果でも上限を設けて安定描画（0 で無制限）
- **表示スタイル**：行頭カラーバー・縞模様（ゼブラ）・コンパクト表示・タイトル表示を切替
- **色のカスタマイズ**：5 レベルの色を編集画面から個別に設定可能
- **ライト / ダークテーマ対応**（`useTheme` によるガード付き）
- 未定義の重要度値は通常テキストとして安全にフォールバック
- 外部通信なし。マルチバリューセル・カラム形式データ・空データにガード付き

## データ仕様

- サーチ結果の**全フィールドをそのまま列**として表示する。
- 深刻度列は自動判定（`severity` / `sev` / `priority` / `urgency` / `level` / `risk`）。
  複数該当する場合は最も優先度の高い名前を採用する。編集画面で明示指定も可能。
- 深刻度の値は次のいずれか：
  - 文字列：`critical` / `high` / `medium` / `low` / `info`（および `error`・`warning` 等のエイリアス）
  - 数値：「数値を深刻度として扱う」を ON にし、閾値で 5 レベルに割り当てる

## 編集画面のオプション

| セクション | オプション | 内容 |
| --- | --- | --- |
| データ | 深刻度フィールド | 色分けに使う列（未指定なら自動判定） |
| データ | 深刻度でソート | 重大→情報の順に並べ替え |
| データ | 最大表示行数 | 表示する最大行数（0 で無制限） |
| 深刻度の色 | 重大 / 高 / 中 / 低 / 情報 | 各レベルの色 |
| 数値の深刻度 | 数値を深刻度として扱う / 各閾値 | 数値列を閾値でレベルへマッピング |
| 表示 | 行頭カラーバー / 縞模様 / コンパクト / 件数サマリ / タイトル | 見た目の切替 |
| デバッグ | オプションのデバッグ表示 | 解決結果と options のダンプ |

## 開発

```bash
yarn install
yarn build          # dist/<viz>/visualization.js を生成
yarn package        # dist/*.spl（Splunk アプリパッケージ）を生成
yarn verify         # happy-dom で実機なしにバンドルを検証
```

本番向け（minify・ソースマップ無し）は `yarn build:prod` の後に `yarn package` を実行する。
アプリのメタデータは `package/app/app.conf` に格納されている（`package.json` は Node/npm 用）。

## デプロイ（再インストール・再起動なし）

1. `npm version patch --no-git-tag-version && yarn build && yarn package` でバージョンを上げて `.spl` を生成
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）
4. ブラウザをハードリロード（Ctrl+Shift+R）

## サンプル SPL

### 文字列の深刻度（セキュリティアラート一覧）

Splunk 9.0+ の `makeresults format=csv` を使う確実な形式：

```spl
| makeresults format=csv data="_time_str,severity,event,host
2026-07-19 10:12:03,critical,Brute force detected,host-01
2026-07-19 10:09:44,high,Port scan,host-07
2026-07-19 10:05:12,medium,Policy violation,host-22
2026-07-19 09:58:31,low,Login success,host-03
2026-07-19 09:51:20,info,Config reload,host-11
2026-07-19 09:40:07,warning,Unusual outbound traffic,host-05"
```

### 数値の深刻度（urgency 1〜5）

「数値を深刻度として扱う」を ON にして使う：

```spl
| makeresults format=csv data="urgency,event,host
5,Data exfiltration attempt,host-14
4,Malware detected,host-02
3,Repeated auth failures,host-08
2,Suspicious login,host-21
1,Informational log,host-33"
```

### 旧環境（makeresults format=csv が使えない場合）

```spl
| makeresults
| eval raw=split("critical|Brute force|host-01;high|Port scan|host-07;low|Login success|host-03", ";")
| mvexpand raw
| eval severity=mvindex(split(raw,"|"),0),
       event=mvindex(split(raw,"|"),1),
       host=mvindex(split(raw,"|"),2)
| table severity event host
```
