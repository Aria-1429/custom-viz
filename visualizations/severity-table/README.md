# Custom Viz Severity Table
![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（重要度色分けテーブル）。

サーチ結果をテーブルとして表示し、`severity`（重要度）系の列を値に応じて色分けする。
セキュリティイベント一覧やアラート一覧などを、重要度が直感的に読めるテーブルで可視化する。

## 特徴

- **データドリブン描画**：サーチ結果の全列をテーブル表示
- **段階数が固定されていない**：色は「値の範囲と色」（`severityBands`）**ただ一つ**が決める。
  編集画面の「＋」で段階を自由に増減できる。3 段階でも 7 段階でも構わない
- **任意の深刻度値に対応**：`critical` / `high` / `medium` / `low` / `info` はもちろん、
  `P1` / `P2` / `P3` や `緊急` / `注意` のような**独自の値でもそのまま色分けされる**
- **エイリアス吸収**：`crit`・`fatal`・`error`・`warning`・`notice` などは既知のレベルへ
  正規化され、ソート順と色の割り当て順に反映される
- **深刻度フィールドの自動判定 + 手動指定**：`severity` / `sev` / `priority` / `urgency` /
  `level` / `risk` を自動判定。編集画面のフィールド選択（`columnSelector`）で明示指定も可能
- **数値の深刻度対応**：`urgency`（1〜5）や CVSS のような数値列を、範囲（バンド）で色分け。
  当たったバンドの色がそのまま使われる。上限・下限のない開区間も作れる
- **深刻度でソート**：重大→情報の順に並べ替え（安定ソート。同レベルは元の順序を維持）
- **件数サマリ**：データに出現した深刻度をそのまま集計表示（5 レベル固定ではない）
- **最大表示行数**：大量の結果でも上限を設けて安定描画（0 で無制限）
- **表示スタイル**：行頭カラーバー・縞模様（ゼブラ）・コンパクト表示・タイトル表示を切替
- **ライト / ダークテーマ対応**（`useTheme` によるガード付き）
- 空の重要度値は通常テキストとして安全にフォールバック
- 外部通信なし。マルチバリューセル・カラム形式データ・空データにガード付き

## データ仕様

- サーチ結果の**全フィールドをそのまま列**として表示する。
- 深刻度列は自動判定（`severity` / `sev` / `priority` / `urgency` / `level` / `risk`）。
  複数該当する場合は最も優先度の高い名前を採用する。編集画面で明示指定も可能。
- **色を決めるのは「値の範囲と色」（`severityBands`）ただ一つ**。文字列・数値のどちらの
  深刻度もこの設定から色を取る。段階数は自由に増減できる。
- 深刻度の値は次のいずれか：
  - **文字列**（`critical`・`warning`・`P1`・`緊急` など任意）：
    データに実際に出現する深刻度を重複なく集め、**重大な順に並べてバンド色を高い範囲から
    順に割り当てる**。並び順は次のルールで決まる。
    1. 既知のエイリアス（下表）は `critical` > `high` > `medium` > `low` > `info` の順
    2. 未知の値は既知の後ろに置き、**データ内の初出順**で安定させる
    段階数とバンド数が食い違っても比例配分するので、必ず色が付く。
  - **数値**：「数値を深刻度として扱う」を ON にすると、各バンドの範囲で判定し、
    **当たったバンドの色をそのまま使う**。件数サマリのラベルは範囲表記（`3–4`、`≧ 90` など）。
- 件数サマリのラベルは、既知の 5 レベルなら日本語（重大 / 高 / 中 / 低 / 情報）、
  **未知の値なら生の文字列をそのまま**表示する。

既知のエイリアス（→ 正規レベル）：

| 正規レベル | 吸収される値 |
| --- | --- |
| `critical` | `critical` `crit` `fatal` `emergency` `severe` |
| `high` | `high` `error` `major` |
| `medium` | `medium` `moderate` `warning` `warn` |
| `low` | `low` `minor` `notice` |
| `info` | `info` `informational` `information` `debug` `ok` `normal` |

これ以外の値は「未知」として扱われ、既知レベルの後ろに初出順で並ぶ（色は付く）。

## 編集画面のオプション

| セクション | オプション | 内容 |
| --- | --- | --- |
| データ | 深刻度フィールド | 色分けに使う列（未指定なら自動判定） |
| データ | 深刻度でソート | 重大→情報の順に並べ替え |
| データ | 最大表示行数 | 表示する最大行数（0 で無制限） |
| 深刻度の色 | 値の範囲と色 | **色を決める唯一の設定**。「＋」で段階を動的に増減。各行は `開始 / 終了 / 色`。上限・下限なしの開区間も可。文字列の深刻度にもこの色が使われる |
| 深刻度の色 | 数値を深刻度として扱う | ON にすると数値列を上の範囲で直接判定する（OFF なら文字列として扱う） |
| 表示 | 行頭カラーバー / 縞模様 / コンパクト / 件数サマリ / タイトル | 見た目の切替 |

> **色は「値の範囲と色」だけで設定する。** 以前あった「重大 / 高 / 中 / 低 / 情報」の
> 5 つの色ピッカー（`criticalColor` 等）は v1.2.0 で削除された。深刻度の段階が 5 段階に
> 固定されてしまい、`P1`/`P2`/`P3` のような独自の体系を表現できなかったため。

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

1. `npm version patch --no-git-tag-version && yarn build:prod && yarn package` でバージョンを上げて `.spl` を生成
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

### 独自の深刻度体系（P1 / P2 / P3）

5 レベルに一致しない値でも、そのまま色分けされる。段階数に合わせて
「値の範囲と色」の段階数を調整すると意図どおりの配色になる：

```spl
| makeresults format=csv data="ticket,severity,event,host
INC-1001,P1,Cluster down,host-01
INC-1002,P2,Disk pressure,host-04
INC-1003,P3,Cert expiring soon,host-09
INC-1004,P1,Second outage,host-02"
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

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

---

### [1.2.0] - 2026-07-25

#### 変更

- **深刻度→色の対応を完全にユーザー定義にした。** 従来は `critical` / `high` / `medium` /
  `low` / `info` の **5 段階に固定**され、その 5 色だけが設定できた。深刻度の段階数が
  5 でない環境や、`P1` / `P2` / `P3`・`緊急` / `注意` のような独自の値を使う環境では
  表現できなかった。この固定を撤廃し、**「値の範囲と色」（`severityBands`、`editor.threshold`）
  ただ一つが色を決める**ようにした。編集画面の「＋」で段階を自由に増減できる。
- **数値の深刻度：当たったバンドの色をそのまま使う**ようになった。従来は一度
  「重大／高／中／低／情報」という固定レベル名を経由してから 5 色のどれかに割り当てていたが、
  この中間層を削除した。件数サマリのラベルは範囲表記（`3–4`、`≧ 90` など）になる。
- **文字列の深刻度：ランク順にバンド色を割り当てる**方式にした。データに実際に出現する
  深刻度を重複なく集め、重大な順（既知のエイリアスは `critical` > `high` > … の順、
  未知の値は既知の後ろに初出順）に並べ、バンド色を高い範囲から順に対応させる。
  段階数とバンド数が食い違っても比例配分で必ず色が付く。
  → **`P1` / `P2` / `P3` のような独自の深刻度でも、コードを触らずに異なる色が付く。**
- **エイリアス吸収（`crit`→`critical`、`warn`→`medium` 等）は維持**した。
  色の固定を外しただけで、ソート順と色の割り当て順にはこの知識を引き続き使う。
- **件数サマリが 5 レベル固定でなくなった。** データに出現した深刻度をそのまま
  チップとして表示する。既知の 5 レベルは日本語ラベル（重大/高/中/低/情報）、
  **未知の値は生の文字列をそのまま表示**する。
- 深刻度セルの警告アイコンは「そのデータ内で最も重大な深刻度」に付くようになった
  （従来は `critical` という名前に固定されていた）。
- **`optionsSchema` の `severityBands` を開区間対応の形に修正**した。`openRanges: true` を
  使っているのに `from` / `to` が `"type": "number"` かつ `required` だったため、
  上限・下限なしの範囲（`null`）を作るとダッシュボードの**保存時バリデーションが失敗**していた。
  `{"type": ["number", "null"]}` にし、`required` を `["value"]` のみに変更した。
- 既定の `severityBands` は従来の 5 段階の見た目をそのまま再現するため、
  **既定のまま使っていた場合の表示は変わらない**。

#### 削除

- **固定 5 レベルの色オプションを削除**した：`criticalColor` / `highColor` /
  `mediumColor` / `lowColor` / `infoColor`。editorConfig の「深刻度の色」セクションから
  5 つの `editor.color` を除去し、同セクションを `severityBands` 中心に再構成した。
  `optionsSchema` の 5 キーも削除。
- 内部の `levelColor()`（レベル名→固定色）と `bandsToLevels()` の色一致による
  レベル名逆引きを削除。これが 5 段階固定の原因だった。

- **⚠ 既存ダッシュボードで設定していた深刻度の色は既定バンドに戻る。設定し直しが必要。**
  旧キー（`criticalColor` 等）からの読み替えは**意図的に実装していない**。
  ホストは「既定値と同じ値」を options に載せないため、旧キーへフォールバックすると
  「既定値を選んだときだけ元に戻らない」という分かりにくい不具合になるため。

#### 成果物

- `dist/custom_viz_severity_table-1.2.0-fcde869.spl`

---

### [1.1.0] - 2026-07-25

#### 変更

- **数値の深刻度を `editor.threshold`（値の範囲と色）に移行**した。従来の
  「重大の閾値 / 高の閾値 / 中の閾値 / 低の閾値」という固定 4 つの数値入力
  （`criticalThreshold` / `highThreshold` / `mediumThreshold` / `lowThreshold`）を廃止し、
  単一のオプション `severityBands` に統合。編集画面に**「+ 閾値の追加」で範囲を動的に増減できる
  UI**（各行が `開始 / 終了 / 色`）が出るようになり、5 段階に縛られず任意の数の範囲を定義できる。
  上限・下限のない開区間（`openRanges`）にも対応する。
- **⚠ 既存ダッシュボードの数値しきい値は既定値に戻る。設定し直しが必要。**
  旧キー（`criticalThreshold` 等）からの読み替えは**意図的に実装していない**。
  ホストは「既定値と同じ値」を options に載せないため、旧キーへフォールバックすると
  「既定値を選んだときだけ元に戻らない」という分かりにくい不具合になるため。
  既定バンドは従来の既定挙動（`≧4` 重大 / `≧3` 高 / `≧2` 中 / `≧1` 低 / それ未満 情報）を
  そのまま再現しているので、既定のままだった場合は見た目は変わらない。
- **数値パスの色はバンド自身の色**を使うようになった。「深刻度の色」の 5 色は
  **文字列の深刻度**（`critical` / `warning` 等）専用として引き続き機能する（挙動変更なし）。
  件数サマリのレベル名は、バンドの色が名前付き 5 色と一致すればそのレベル名を、
  一致しなければ範囲の並び順（高い範囲ほど重大）で導出する。
- バンド配列は防御的に正規化する。未ソート・範囲の重なり・`from > to` の逆転・
  `null` の開区間・空配列・配列以外・不正な色を含む要素のいずれでも描画は落ちず、
  使えない場合は既定バンドへフォールバックする。

#### 削除

- **`debug` オプション（「デバッグ」セクション）を削除**した。editorConfig のセクション・
  `optionsSchema` のキー・`normalizeOptions` の項目・`DebugOverlay` コンポーネントを一括で除去。
- `optionsSchema` から旧しきい値キー 4 つ（`criticalThreshold` / `highThreshold` /
  `mediumThreshold` / `lowThreshold`）を削除。

#### 成果物

- `dist/custom_viz_severity_table-1.1.0-fcde869.spl`

---

### [1.0.3] - 2026-07-25

#### 変更

- **データ未取得時のメッセージを全 viz 共通の文言に統一**した。
  「データがありません。サーチ結果を確認してください。」（従来は英語表記や viz ごとに異なる文言だった）。
  ダッシュボードに複数の viz を並べたときに、サーチ未設定の空パネルが揃った見た目になる。


#### 生成物

- `dist/custom_viz_severity_table-1.0.3-2dc2dde.spl`

---

### [1.0.2] - 2026-07-21

#### 修正

- **テーブル左側に大きな余白ができ、右側の列が見切れる不具合を修正**。
  `tableLayout: 'fixed'` では列幅を `colgroup`（無い場合は先頭行）から決めるが、
  行頭カラーバー列の `<th>` に明示幅が無かったため、そのヘッダー列が等分幅の 1 枠を
  丸取りして左に巨大な余白を作り、TIME 列以降が右へ押し出されて見切れていた。
  `<colgroup>` で「バー列 = 4px 固定・データ列 = 均等配分」を宣言し、バー列 `<th>` にも
  `width: 4px` を付与して列の整列を修正。

#### パッケージ
- `dist/custom_viz_severity_table-1.0.2-a8408c6.spl`

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
- `dist/custom_viz_severity_table-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

重要度に応じて行を色分けするテーブル。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_severity_table-1.0.0-beb3d05.spl`
