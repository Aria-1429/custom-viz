# custom-viz-calendar-heatmap

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（カレンダーヒートマップ）。

GitHub の contribution graph 風に、**日付ごとの値を色の濃淡**で表す。週を列・曜日を行（7行）
として並べ、月ラベル・曜日ラベルを添える。ログ量の日次推移、インシデント発生日、ログイン頻度
など「いつ・どれくらい」を一目で把握したい時系列に向く。

## データモデル

| 列    | 役割                                                             |
| ----- | ---------------------------------------------------------------- |
| 日付  | `_time` / ISO文字列 / epoch 秒・ミリ秒 のいずれでも可（既定=第1列） |
| 値    | 数値。1 日 1 セルとして色の濃淡で強度を表す（既定=第2列）          |

- **フィールド選択**: 編集画面の「データ」セクションで、日付フィールド・値フィールドを
  ドロップダウンから選べる（空欄なら日付=第1列・値=第2列に自動フォールバック）。
- 同じ日が複数行ある場合は合算する（`| timechart span=1d count` などをそのまま渡せる）。
- **マルチバリューセルの救済**: `mvexpand` し忘れなどで1セルに複数値が届いても、全列の
  トークン数が一致する行は平行展開して復元する（桁連結・カンマ連結の壊れ表示を防ぐ）。
- 色分けは 2 方式を編集画面で切替:
  - **グラデーション**（既定）: 最大値を基準に強度レベル（既定 5 段階）へ量子化。
  - **値カラースケール**: 「Color by value (low → high)」をONにすると、値の大小に応じて
    `Low color →(Middle color)→ High color` を補間してセル色にする（例: 安全=緑 … 危険=赤）。
    色は編集画面のカラーピッカーで指定でき、変更は即反映される。
    - **Reverse**: 高い値を Low 側の色にする（「高い値＝赤」にしたい時）。
    - **Scale min / max**: 正規化の下限・上限（空欄ならデータの最小/最大を自動採用）。
    - 凡例は連続グラデーションバー＋最小/最大ラベル。
    ※ Splunk 標準の「動的色設定（editor.dynamicColor）」はカスタムviz拡張では設定値が options に
      渡らないため使えない（範囲配列は context に保存されホストのみ参照）。本方式はすべて
      editor.color / number / checkbox で構成し、useOptions に確実に届くようにしている。
- 日付が 1 つも解釈できない場合はガイドメッセージを表示する。

## 特徴

- **オートフィット**: コンテナ実寸を測り、セルサイズ・間隔・角丸を自動計算してパネル全体に
  広げる（余白を残さない）。`Max cell size` で上限だけ指定可（0 = 無制限＝常に領域いっぱい）
- データドリブン描画（日付範囲・強度を SPL の結果から自動生成）
- **フィールド選択**（`editor.columnSelector`）で日付列・値列を編集画面から指定
- 上部サマリーヘッダー（期間・Total・Active days・Peak/day）
- 高強度色（1色）を薄→濃のグラデーションに展開。ライト/ダーク双方で視認性を確保
- 強度レベル数 / セル上限サイズを編集画面から設定（useOptions）
- 日曜始まり ⇔ 月曜始まりの切替、ヘッダー・月・曜日ラベル・凡例の表示切替
- セルホバーで日付と値のツールチップ（ぼかし付き）、Less→More 凡例
- ライト / ダークテーマ対応（useTheme によるガード付き）

## 開発

\`\`\`bash
yarn install
yarn build          # dist/*/visualization.js を生成
yarn package        # dist/*.spl（Splunk アプリパッケージ）を生成
\`\`\`

## デプロイ（再インストール・再起動なし）

1. \`npm version patch --no-git-tag-version && yarn build && yarn package\` でバージョンを上げて \`.spl\` を生成
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して \`.spl\` をアップロード
3. ブラウザで \`https://<host>:8000/en-US/_bump\` を開き **Bump version**（Splunk 再起動の代替）
4. ブラウザをハードリロード（Ctrl+Shift+R）

## サンプル SPL

90 日分の日次カウント（ランダム）を生成するデモ。

\`\`\`spl
| makeresults count=90
| streamstats count as n
| eval _time = now() - (n-1)*86400
| eval count = round(random() % 100)
| table _time count
| sort _time
\`\`\`

フィールド選択の動作確認用（日付・値の列名を明示。編集画面のドロップダウンで選べる）:

\`\`\`spl
| makeresults count=60
| streamstats count as n
| eval day = strftime(now() - (n-1)*86400, "%Y-%m-%d")
| eval events = round(random() % 200)
| table day events
| sort day
\`\`\`

実データ例（日次のイベント数をそのまま渡す）:

\`\`\`spl
index=_internal
| timechart span=1d count
\`\`\`

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
- `dist/custom_viz_calendar_heatmap-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

日付ごとの値をカレンダー状のセルに色の濃淡で表示するヒートマップ。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_calendar_heatmap-1.0.0-beb3d05.spl`
