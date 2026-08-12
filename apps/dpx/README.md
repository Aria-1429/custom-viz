# DPX — DPX

**Splunk 上で動く完全独自のダッシュボード基盤**（アプリ ID: `dpx`）。
Dashboard Studio でも classic（Simple XML）でもなく、独立 React ページの上に自前の
ダッシュボードエンジンを載せたものです。「Splunk 上で動作し、Splunk にサーチが投げられる」
ことだけを前提に、**より映えるダッシュボードを自由に簡単に作れる**ことを目指しています。

実装ナレッジ（構成・スキーマ・viz の作り方・踏んだ罠・E2E ツール）は
[.claude/skills/splunk-viz/references/dpx-platform.md](../../.claude/skills/splunk-viz/references/dpx-platform.md)
に集約しています。**着手前にそちらを読むこと。**

## 構成（30秒版）

```
Splunk Web
 └ ホストビュー dpx（画面はこの1枚だけ。template="pages/splunk_ui_app.html" ＝ Splunk 同梱）
    └ pages/dpx.js                        ← 唯一のランタイム（ホーム＋ダッシュボード）
        /app/dpx/dpx            → ホーム（一覧）
        /app/dpx/dpx?id=<app>/<name> → ダッシュボード
 └ 定義ビュー（1 ダッシュボード = 1 ビュー XML。isVisible=False の入れ物）
    └ <definition><![CDATA[ DPX スキーマ v1 の JSON ]]></definition>
```

- 保存形式は Studio と同型（ビュー XML に定義 JSON を埋め込む）。REST で動的に作成できる
- **画面間は SPA 遷移（pushState）＝ページ再読込ゼロ**。ボード切替・ホーム往復に白は出ない
- viz は「props を受け取る素の React コンポーネント」を `vizRegistry.js` に登録するだけ
  （iframe なし・config.json なし・splunkd 再起動なし）
- **カスタム Mako テンプレートは不使用**（10.4.0 非推奨・AppInspect 4.4.0 から審査 fail の対象）。
  検討した代替案と全数調査の記録は dpx-platform.md §1.1 を参照

## 開発ループ

```bash
cd apps/dpx
rm -rf stage && NODE_OPTIONS=--max-old-space-size=8192 yarn build   # 本番ビルド
yarn package                                                        # dist/*.spl
node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/dpx/<view> --out /tmp/shots
```

---

## サンプルダッシュボード

| ファイル | 用途 |
|---|---|
| [`examples/aegis-soc.json`](examples/aegis-soc.json) | **ショーケース**。DPX でしか組めない構図を一枚にまとめたもの（下記） |
| [`examples/all-viz-check.json`](examples/all-viz-check.json) | 全 viz の描画確認用（30枚を並べただけ） |

### AEGIS / Global Threat Operations（ショーケース）

3タブ・25パネル・21データソース・14種の viz。**Studio では組めない**要素を意図的に集めてある:

- **左サイドバータブ**（`tabPosition: "left"`）
- **背景エフェクト**（`constellation`）がパネルの裏で常時動く
- **枠なしパネル**（`frameless`）で見出しと時計を地の上に直接置く
- **全幅の地図を1枚のキャンバスとして使う**（`frameless` + 12列。枠もタイトルバーも無い）
- 自作 viz（world-map / attack-globe / sunburst / sankey-flow / heat-matrix /
  timeline-swimlane / liquid-tube）とネイティブ viz を混在

⚠ **地図（world-map / attack-globe）の上に他のパネルを重ねない。**
DPX は `style.z` でパネルを重ね置きできる（Studio に無い機能）が、
**地図に対して使うと肝心の地形と着弾点が隠れる**。
重ねたガラスパネルは見栄えはするものの、地図の凡例・フロー一覧・
端の国（日本／オーストラリア）が読めなくなった（実機で確認して取りやめ）。
**重ね置きは「地図以外」で使う。** 地図は単独で全幅を与えるのが正解。

投入:

```bash
node tools/dashboard-loop/src/push.mjs apps/dpx/examples/aegis-soc.json --name dpx_aegis
```

⚠ **`makeresults format=csv` の CSV は本物の改行で書く。**
`\n` の2文字を埋め込むと**1行の壊れた CSV**になり、
**HTTP 200 のまま 0 行**が返る（エラーにならないので気づきにくい）。
⚠ **`eval` で日本語のフィールド名を参照するときは `'達成率'` と単引用符で囲む。**
囲まないとこれも **200 で 0 行**になる（このダッシュボードの作成中に実際に踏んだ）。

---

## ライセンス

**MIT License**（[LICENSE](LICENSE)）。

バンドルに含まれるサードパーティ OSS の著作権表示・許諾条文は
[THIRD-PARTY-NOTICES.txt](src/main/resources/splunk/THIRD-PARTY-NOTICES.txt) に同梱しています
（配布物である `.spl` にも両方が入ります）。

⚠ `@splunk/dashboard-studio-extension` など Splunk 提供のパッケージは OSS ではなく
Splunk General Terms が適用されます（OSS 通知とは別枠で参照情報のみ記載）。

---

## リリースノート

このセクションは [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠します。
バージョニングは [SemVer](https://semver.org/lang/ja/) です。

---

### [1.2.1] - 2026-08-12

#### 修正

- **サーチを Studio と同じ方式に合わせた（`exec_mode=blocking` を廃止）。**
  リバースプロキシ（Cloudflare トンネル）越しにパネルが
  **`[object Response]`** になり描画されない不具合の根本原因。
  - `blocking` は**ジョブ完了まで HTTP 接続を握る**ため、同時に投げた本数ぶん
    サーバ側でジョブが並走し、役割の同時実行上限（`srchJobsQuota`）を超えた分が
    **HTTP 503**（`role-based concurrency limit ... has been reached`）で落ちていた
  - **Studio は `exec_mode` を送っていない**（実機で POST body を観測して確認）。
    同じ実機で標準 Studio ダッシュボードは 12 パネルを 19ms 以内に一斉ディスパッチしても
    **503 が出ない**。キューで絞っているのではなく **blocking を使っていない**ため
  - → DPX も非ブロッキングで投げ、**`dispatchState` のポーリングで完了を待つ**方式へ変更
  - 実測（同一実機・同時12本）: `blocking` = 201×10 / **503×2** → 変更後 **201×12**
  - **なぜ IP 直では出なかったか**: HTTP/1.1 は1オリジン同時6接続までで、
    ブラウザが**偶然スロットリングしていた**ため上限に届かなかった。
    トンネルは h3/HTTP/2 で多重化が効き、12本が一斉に到達して上限が露出した。
    **Cloudflare が壊していたのではなく、元からあった不具合が見えるようになっただけ**
- **`[object Response]` という無意味なエラー表示を修正**（`handleError` を対で使う）。
  `@splunk/splunk-utils` の `handleResponse` は**生の `Response` を reject する**ため、
  受け側が `err.message` を読むと `undefined` になり `String(Response)` が表示されていた。
  Splunk 自身の `splunk-utils/search.js` は必ず `handleError` と対で使っており、
  これが**サーバの `messages[].text` を本物の `Error` にしてくれる**。
  - 適用先: サーチ実行（ジョブ作成・状態取得・結果取得）と
    `viewStore` の**保存 / 作成 / 共有設定**（同じ潜在バグがあった）
  - 効果: 上限超過や SPL の誤り（例: `Unknown search command '...'`）が**画面に理由として出る**

生成物: `dist/dpx-1.2.1-a1189d4.spl`

---

### [1.2.0] - 2026-08-12

#### 追加

- **コネクタ線 viz（`dpx.linkLine`）を追加**（`components/engine/linkLineViz.jsx`）。
  Studio 拡張の Link Line 相当を DPX ネイティブとして実装したもの。
  パネル同士を線で結び、**サーチ結果の値で線の色が変わる**（死活・遅延の可視化）。
  - **⭐ 編集モードでキャンバス上を直接ドラッグして線を整形できる**
    （点の移動／セグメント中央の「＋」で折れ点追加／中間点をダブルクリックで削除／
    値ラベルのドラッグ移動）。**これは Studio ではできなかったこと**——Studio 拡張は
    パネルが iframe に隔離され、編集モードのポインタ入力をホストがパネル選択に
    使ってしまうため、Link Line は「表示モードで形を整える」しかなかった
  - 色分けは DPX の `editor.colorRules` を流用＝**範囲／一致／グラデーションの3モード**
  - 質感4種（フラット／ソフトシャドウ／ネオン発光／立体パイプ）・矢印・破線・
    流れアニメ・丸端子・値ラベル（単位／接続名／小数桁）
  - データが無くても線は消さず**ニュートラル色＋「N/A」**で描き続ける
  - 表示モードには編集 UI を出さない（壁掛け・キオスクでの誤操作を避けるため）
- **エンジン: `Viz.config.canvasEdit`** を追加。宣言した viz には編集モードの
  **移動用オーバーレイを敷かない**（敷くと viz にポインタが一切届かない）。
  パネル移動はタイトルバー（タイトル非表示時は上端の細い帯）で行う。
- **エンジン: パネルに `data-panel-id` / `data-viz` 属性**を付与。
  E2E がパネルを一意に狙えるようにするため。
- **検証ツール**: `tools/dashboard-loop/src/dp-push.mjs`（DPX 定義の REST push）と
  `dp-linkline-e2e.mjs`（編集モードのドラッグ→保存→REST 永続化の E2E）。

#### 修正

- **`onOptionsChange` が空実装（`() => {}`）で、viz からのオプション書き戻しが
  黙って捨てられていた。** viz 側は保存された前提で描き続けるため、
  **動くのに保存されない**という分かりにくい壊れ方をしていた。`onPatchPanel` に接続。

生成物: `dist/dpx-1.2.0-a1189d4.spl`

---

### [1.1.0] - 2026-08-12

#### 追加

- **トップバーに「Splunk へ戻る」リンクを追加**（`components/engine/SplunkHomeLink.jsx`）。
  DPX は `body > header` を隠して Splunk のヘッダを消すため、これまで**Splunk 本体へ戻る
  導線が画面上に一つも無く**、ブラウザの戻るに頼るしかなかった。
  - 行き先は Splunk のヘッダロゴと同じ **`app/launcher`**（実機の
    `<a data-test="header-logo" href="/en-US/app/launcher">` を確認して合わせた）。
    ロケール接頭辞は `createURL` に付けさせる
  - **ホーム画面（一覧）とダッシュボード画面の両方**の同じ位置（左端）に置いた
  - Splunk 本体へ出るので SPA 遷移ではなく素の `<a href>`。
    Ctrl/⌘ クリックの別タブもそのまま効く
  - 地・文字色は `t.colorScheme` で分岐（ライト系プリセットで読めなくなるのを回避）。
    アイコンは `stroke="currentColor"` でテーマに追随する
  - ⚠ **Splunk のロゴ SVG は複製していない**（登録商標のため）。汎用のホーム記号＋
    「Splunk」の文字で行き先を示す

生成物: `dist/dpx-1.1.0-a1189d4.spl`

---

### [1.0.0] - 2026-08-12

**初回リリース。** DPX（独自ダッシュボード基盤）の最初の正式版。
これ以前の 0.x は開発版のため、リリースノート・配布アーカイブとも本版に集約している。

#### 主な機能

**基盤**
- Splunk 上で動く**完全独自のダッシュボード基盤**（Dashboard Studio でも classic でもない）。
  独立 React ページの上に自前のレンダリングエンジンを載せた構成
- 画面はホストビュー 1 枚に集約した **SPA**（`?id=<app>/<name>` で切り替え。画面遷移で再読込なし）
- ダッシュボード定義は**ビュー XML 1 枚＝1 ダッシュボード**（classic と同じモデル）。
  REST で動的に作成・更新できる
- **Mako 不使用**（Splunk 同梱の標準テンプレートを使用）。AppInspect は
  cloud / private_* すべて **failure 0**

**作成・編集**
- GUI での**ダッシュボード編集**（パネルのドラッグ移動・リサイズ・複製・重なり順）
- **共有データソース**（1 つのサーチを複数パネルで参照しても実行は 1 回）
- **タブ**（上部／左サイドバー）と自動送り、**入力とトークン**、**パネル間のクリック連携**
- **SPL エディタ**（Splunk 公式の Ace＋SPL モード。構文ハイライト・整形）
- **設定の別ウィンドウ表示**（URL バーの無い浮遊ウィンドウ。マルチモニタ対応。
  ダッシュボードを全幅で見たまま調整できる）

**見た目**
- **配色プリセット 13 種**（画面発光系に加えて、紙・活版／青焼き図面／熱画像／電子ペーパー）
- **パネル質感 19 種**（コーナーフレーム・すりガラス・活版・印画紙・パンチカードなど）
- **背景エフェクト 22 種**（canvas 系・パターン系・グラデーション系）
- タイトルの位置と質感、パネル個別の色・角丸・傾きなどの上書き

**viz**
- **DPX ネイティブ viz**（表・棒・折れ線／エリア・ドーナツ・単一値・ランキング・ステータス一覧）
- **装飾・図形**（テキスト・時計・図形・コーナーフレーム）
- **既存のカスタム viz 31 種がそのまま動く**（iframe なし・Studio と同じ type 指定）
- **値→色のルール**を UI から設定可能（範囲・一致・グラデーション。Studio では DOS の手書きが必要だった領域）

#### 動作環境

- Splunk Enterprise 10.4 系で開発・実機検証
- 一部の viz は WebGL2 を使用（対応環境が必要）

#### ライセンス

- **MIT License** で公開（`LICENSE` を配布物にも同梱）

生成物: `dist/dpx-1.0.0-<hash>.spl`
