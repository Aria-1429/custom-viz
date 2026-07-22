# custom-viz-country-graph

![表示例](examples/example.png)

Splunk Dashboard Studio 向けのカスタムビジュアライゼーション（国別ランキング＋国旗）。

サーチ結果の国名（または ISO 3166-1 alpha-2 コード）を国旗アイコン付きでランキング表示する。
国名は英語表記・別名から ISO コードへ自動解決し、解決できない場合は 🌐 でフォールバックする。
国旗アイコン（`country-flag-icons`）はビルド時にバンドルされるため、**実行時のインターネット
通信は不要**（本番 Splunk 環境の制約に準拠）。

## 特徴

- データドリブン描画（第1列＝国、最初の数値列＝値としてランキング生成）
- 国名 → ISO コード自動解決（英語表記・別名・2文字コードに対応）
- 国旗アイコン表示（未解決時は 🌐 にフォールバック）
- ライト / ダークテーマ対応（`useTheme` によるガード付き）
- 空データ・型不一致・未知の国名に対するガード処理
- **編集画面オプション（`useOptions`）で描画をカスタマイズ**（v0.2.0〜）
  - **配色モード**: `palette`（順位グラデーション）/ `value`（値ベース）を切替
    - palette: 1位側→下位側の2色を補間
    - value: 「低い値＝緑・高い値＝赤」のように値でバー色を変える（中間色・高低反転・スケール min/max 指定に対応）
  - **並び替え**: 降順 / 昇順
  - **絞り込み**: 上位N件のみ表示（0＝全件）
  - **表示トグル**: ヘッダー / 順位番号 / 国旗 / バー / 数値 / 構成比 / コンパクト表示
  - **演出**: バー発光 / 初期アニメーション

編集画面ラベルはすべて日本語。オプションのキー名は英語（`useOptions` 経由で取得）。
`editor.color` / `editor.checkbox` / `editor.number` のみを使用（カスタム viz で確実に反映される型）。
列挙値（配色モード・並び順）はチェックボックスで受け、内部で文字列オプションへ変換している。

## 検証

```bash
yarn verify   # happy-dom で dist バンドルを実行し、描画・オプション反映・ガードを検証（28項目）
```

## データ仕様

| 列 | 説明 |
| --- | --- |
| 第1列 | 国名または ISO 3166-1 alpha-2 コード（例: `Japan` / `JP`） |
| 数値列 | 値（件数など）。最初に見つかった数値列を採用 |

## 開発

```bash
yarn install
yarn build          # visualizations/*/dist を生成
yarn package        # dist/*.spl（Splunk アプリパッケージ）を生成
```

本番向け（minify・ソースマップ無し）は `yarn build:prod` の後に `yarn package` を実行する。
アプリのメタデータは `package/app/app.conf` に格納されている（`package.json` は Node/npm 用）。

## デプロイ（再インストール・再起動なし）

1. `npm version patch --no-git-tag-version && yarn build && yarn package` でバージョンを上げて `.spl` を生成
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）
4. ブラウザをハードリロード（Ctrl+Shift+R）

## サンプル SPL

### 基本（順位グラデーション）

```spl
| makeresults format=csv data="country,alerts
United States,5000
Germany,4500
Japan,4000
Russia,3500
China,3000
France,2500
United Kingdom,2000
South Korea,1500
Brazil,1000
Italy,500"
| table country alerts
```

### 値ベース配色の確認（攻撃元スコア：低＝緑・高＝赤）

編集画面で「配色モード」を value に、「上位N件」を 5 などにして確認する。

```spl
| makeresults format=csv data="country,threat_score
CN,98
RU,91
KP,77
IR,64
US,42
DE,28
JP,15
BR,9"
| table country threat_score
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

#### パッケージ
- `dist/custom_viz_country_graph-1.0.1-d824e00.spl`

### [1.0.0] - 2026-07-20

国旗付きの国別ランキング横棒グラフ。

#### 追加
- 新規作成（初回リリース）。
- パッケージ: `dist/custom_viz_country_graph-1.0.0-beb3d05.spl`
