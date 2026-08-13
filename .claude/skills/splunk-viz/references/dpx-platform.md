# DPX（DPX）— 独自ダッシュボード基盤の実装ナレッジ

**2026-08-10 に構築・実機検証（Splunk Enterprise 10.4.2）。実装は [apps/dpx/](../../../../apps/dpx/)、
アプリ ID は `dpx`。この文書は「DPX を触る前に読むファイル」。**

DPX は **Splunk の上で動く完全独自のダッシュボード基盤**。
Dashboard Studio でも classic でもなく、**独立 React ページ（[splunk-react-app.md](splunk-react-app.md) の第3の方式）の上に
自前のダッシュボードエンジンを載せたもの**。

> **位置づけ（ユーザー決定・2026-08-10）**
> 「**Splunk 上で動作し、Splunk にサーチが投げられる**ということだけが最低条件。
> 既存 viz は一旦考慮せず**完全な新規プラットフォーム**」「完全差別化し、
> **より映えるダッシュボードを自由に簡単に作れる**プラットフォームを目指す」。
> → 既存29 viz の互換・移植は**設計の柱ではない**（アダプタは動く状態で残置）。
> DPX ネイティブ viz を主軸に作る。

---

## 0. 30秒で掴む全体像

| | 内容 |
|---|---|
| 成果物 | `dpx` アプリ 1 つ。定義は**ビュー XML 1 枚＝1 ダッシュボード**（isVisible=False の入れ物） |
| 画面 | **ホストビュー `dpx` の1枚だけ**（v0.2.0 で1ビュー集約）。`/app/dpx/dpx` がホーム、`?id=<app>/<name>` がダッシュボード。**画面間は pushState の SPA＝再読込ゼロ** |
| 描画 | 自前エンジン `DpxDashboard`（CSS grid）。Studio の `@splunk/dashboard-*` に**依存しない** |
| データ | ページ自身が splunkd に `search/jobs` を投げる（iframe が無いのでセッション認証がそのまま効く）。⚠ **名前空間は所属アプリ**（`SearchAppContext`。URL が常に dpx なので明示必須） |
| 保存 | ビュー XML の `<definition><![CDATA[ JSON ]]></definition>`（Studio と同型の入れ物） |
| 配信 | **Splunk 同梱テンプレート `pages/splunk_ui_app.html`** が同名 JS `pages/dpx.js` を読む。**Mako 不使用**（v0.2.0 で全廃）。ダッシュボードを増やしても**再パッケージ不要** |
| viz | `vizRegistry.js` の Map に React コンポーネントを登録するだけ。**iframe なし・config.json なし・再起動なし** |
| 編集 | 独自インスペクタ（`Inspector.jsx`）。viz の `editorConfig` からフォームを自動生成 |
| 管理 | ホーム（`pages/HomePage.jsx`）から**作成（テーマ選択つき）・複製・名前変更・削除・JSON の書き出し／取り込み**。REST 層は `viewStore.js`、スキーマ判定と取り込み検証は依存ゼロの `engine/schema.js` / `engine/importDefinition.js`（**素の Node でテストできるよう viewStore から分離**） |

**開発ループ**（全部で10秒程度）:

```bash
cd apps/dpx
rm -rf stage && NODE_OPTIONS=--max-old-space-size=8192 yarn build   # ← heap 拡張は必須（後述）
yarn package && node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/dpx/<view> --out /tmp/shots
```

---

## 1. アーキテクチャ（なぜこの形なのか）— v0.2.0 で1ビュー集約・Mako 全廃

```
Splunk Web
 └ ホストビュー dpx（default/data/ui/views/dpx.xml。画面はこの1枚だけ）
    ├ template="pages/splunk_ui_app.html"     ← Splunk 同梱（Mako ではない）
    │   └ pages/dpx.js                        ← 唯一のランタイム（同名 JS 規則）
    │       /app/dpx/dpx            → ホーム（一覧）
    │       /app/dpx/dpx?id=<app>/<name> → ダッシュボード（SPA 切替）
    └ 定義ビュー（isVisible=False の入れ物。直接開かない）
        └ <definition><![CDATA[ DPX スキーマ v1 の JSON ]]></definition>
                      ↓ ランタイムが ?id= から app/view を判定して REST で読む
             DpxDashboard（自前レンダラ）→ 各パネル → useSplunkSearch → splunkd
```

**要点（すべて実機で確定）**:

1. **標準テンプレートは「ビューと同名の JS」を所属アプリから読む。** ビューを `dpx` の
   1枚に集約したことで「動的に作るビューに JS を配れない」問題自体を消した。
   定義ビューは何枚増えても**画面としては開かない**ので同名 JS が要らない。
2. **旧 `/home` は 263 バイトのスタブ JS（pages/home.js）で新 URL へ即時転送。**
   標準テンプレートの同名 JS 規則を逆手に取った後方互換（パッケージ同梱ビューだから可能。
   REST で動的に作る定義ビューには同じ手は使えない＝旧ボード URL は救えない）。
3. **白フラッシュ対策は2段**: (a) `pages/dpx/bootPaint.js`（バンドル評価の先頭で暗転＋
   スプラッシュ。⚠ **必ず index.jsx の最初の import**・依存ゼロ・`!important` 必須）
   (b) DPX 内は SPA 遷移で再読込ゼロ。実測: コールド入口の白は前ページの残像込みで
   **1〜2フレーム（~120ms、220ms 時点で暗転）**。DPX 内遷移は白ゼロ
   （window マーカー生存でリロード無しを証明済み）。
   スプラッシュは**最低 350ms 見せる**（`BootScreen.MIN_SPLASH_MS`。bootPaint が
   `__DPX_BOOT_T0` を記録し dismiss 側で下限を保証。実測 666ms 表示）。
   **SPA 遷移（id が変わる切替・戻る/進む含む）でも `showBootSplash()` で同じ
   ロード画面を 350ms 挟む**（演出として意図的。実測 360ms・リロード無し。
   mode だけの切替では出さない）。
   **AppInspect 4.3.0 は failure 0 / future_failure 0**（Mako チェック not_applicable）。
4. **⚠ サーチは所属アプリの名前空間で投げる**（`useSplunkSearch` の `SearchAppContext`）。
   URL が常に dpx になったので、明示しないと**他アプリのマクロ・ルックアップが
   静かに壊れる**。DashboardPage が Provider で配る。
5. **所属アプリは自由。** 定義ビューはどのアプリにも作れる（`?id=<app>/<name>` で開く）。
6. **splunkd 再起動は不要**（この移行も再起動なしで完了）。標準テンプレートは常設・
   ビュー作成は REST・静的 JS は `_bump` で反映。旧 Mako 時代の「初回導入時のみ再起動」
   すら不要になった（`appserver/templates` を使わないため）。

### 1.05 ダッシュボードの移行は「ビュー XML 1枚」（classic と同じ）

**質問への答え：はい。ファイル（ビュー XML）を移せばそのまま移行できる。**

```
$SPLUNK_HOME/etc/apps/<app>/local/data/ui/views/<name>.xml   ← これ1枚が1ダッシュボード
```

中身は `<view template="pages/splunk_ui_app.html" type="html" isVisible="False">` に
`<definition><![CDATA[ DPX の JSON ]]></definition>` が入っているだけ（実機で全文確認済み）。
**classic の Simple XML と同じ「XML 1枚＝1ダッシュボード」モデル**を意図的に踏襲している。
開く URL は `/app/dpx/dpx?id=<app>/<name>`（ビュー自体は直接開かない）。

- 移行先に **`dpx` アプリが入っていること**が前提（テンプレートの提供元）
- REST でも出し入れできる：`GET/POST /servicesNS/<owner>/<app>/data/ui/views/<name>`
- カスタム viz を使っているなら、その viz アプリも移行先に必要（classic/Studio と同じ）
- 権限・共有設定は `metadata/local.meta` 側（これも classic と同じ）

---

### 1.1 カスタム Mako テンプレートの非推奨と、DPX の移行（**解消済み**）

> **✅ 2026-08-11 v0.2.0 で解決。** 1ビュー集約（§1）により DPX は Mako を全廃した
> （パッケージに `appserver/templates` 0件＝AppInspect の Mako チェックは not_applicable）。
> 以下は経緯と、移行判断の材料になった全数調査の記録。**「Mako を使わずに動的ページを
> 作る方法」を将来また探すことになったら、まずこの節を読む。**

**旧 DPX の `appserver/templates/dashboard.html` は、まさに非推奨対象のディレクトリにあった**
（2026-08-10 調査時点の記述）。

| | 内容 |
|---|---|
| 何が非推奨か | **アプリが同梱する「カスタム」Mako テンプレート**（`etc/apps/<app>/appserver/templates`）。First deprecated: **10.4.0** |
| 除外されるもの | **Splunk 同梱の第一党テンプレートは対象外**。`pages/splunk_ui_app.html`（`share/splunk/search_mrsparkle` 配下）は**明示的に安全**。仕様書に "Splunk Web always allows first-party templates in the `$SPLUNK_HOME/share/splunk/search_mrsparkle` directory" とある |
| 停止スイッチ | `deactivate_custom_mako_templates`（**`web-features.conf` の `[feature:appserver_security]`**。公式の非推奨ページは `server.conf` と書いているが**誤り**） |
| 実機の現状 | **10.4.2 で確認：値は `false`**（＝有効。今は動く）。同時に `deactivate_custom_cherrypy_controllers = false` も存在 |
| 削除時期 | **未告知**。「will be removed in future versions」とだけ |
| 併せて非推奨 | カスタム CherryPy コントローラ（10.4.0〜） |

**よくある混同**（別物なので切り分ける）:

| | 対象 | 状態 |
|---|---|---|
| (a) カスタム Mako テンプレート | アプリ同梱の `appserver/templates` | **10.4.0 で非推奨** ← DPX が該当 |
| (b) HTML ダッシュボード | Simple XML の「HTML に変換」 | 8.2.0 で非推奨・変換機能は削除済み。**(a) とは別物** |
| (c) Web Framework / Django（splunkdj） | 旧フレームワーク | とうに終了 |
| (d) `type="html"` ビューそのもの | HTML ビューの仕組み | **非推奨の記載はない**（10.4 で 33 個が現役稼働） |
| (e) `@splunk/create` の React スキャフォールド | Splunk App with React | **非推奨ではない。現役で活発**（v11.1.0 / 2026-07-07） |

**むしろ `pages/splunk_ui_app.html` は Splunk 公式の移行先**。`@splunk/create` v11.0.0（2026-05-19）は
「10.4 以降専用の新テンプレート形式」を既定にし、アプリ同梱 Mako を出す旧方式を
`--use-legacy-template` に降格した。つまり Splunk は「自前 Mako をやめて同梱テンプレートへ」と
誘導している。

**なぜ DPX は自前 Mako を使っているのか**（＝簡単にはやめられない理由）:
同梱テンプレートは「**ビューと同名の JS を所属アプリから読む**」（§1 要点1）。DPX は
ダッシュボードを REST で動的に作るので、ビューごとに JS を配ることができない。
だから「常に同じ `dashboard.js` を読む」自前テンプレートが要る。**非推奨と実装上の制約が
正面衝突している**ので、片付けるなら設計変更が要る。

**逃げ道の全数調査（2026-08-11 実機検証済み。Mako 全廃の代替はすべて棄却）**:

| 候補 | 結果 |
|---|---|
| 標準テンプレートの `PAGE_PATH` を先回りして差し替える | **不可**。`window.PAGE_PATH` はただの JS 変数でローダー（`load_themed_page.js`）も非同期だが、**ビュー XML から `<script>` を注入する口が無い**（`<html><![CDATA[...]]>` を入れても HTML に一切出ない。実測） |
| ビュー XML の `page` 属性で読み込む JS を変える | **不可**。属性は無視され、`PAGE_PATH` は必ず `pages/<ビュー名>.js`（実測）。`views.conf` の stanza にも `disabled` 以外のキーが無い |
| REST で `pages/<ビュー名>.js` を実行時に作る | **不可**。静的アセットを書く REST は無い（`data/ui/html` 系も 404）。パス解決も厳密（エイリアス/フォールバック無し、実測） |
| **Simple XML `script=` 属性で共有 JS を読む** | **不可**。version="1.1" の新ランタイム `dashboard_1.1.js` は属性サポート表で **`script:!1, stylesheet:!1`（非サポート）**（バンドルから抽出＋app 共有でもリクエストが飛ばないことを実測）。version="1.0" は 10.4 で **「Loading...」のまま描画されず死んでいる**（実測）。なお `<definition>` CDATA は Simple XML でも保存・往復でき、**クラシックのダークページは白フラッシュゼロ**（294ms 時点から暗色）だったが、JS が読めないので無意味 |
| 第一党テンプレートに別の器が無いか | **無い**。14 候補を試して生きているのは `pages/splunk_ui_app.html` と `pages/app.html` のみ（**どちらも同じ `PAGE_PATH`＝ビュー名機構**）。`pages/base.html` / `pages/dashboard.html` は 200 だがページ JS を読む口が無い。他は全部 500（候補名の総当たりであり網羅証明ではない） |
| 作成時にスタブ JS 入りアプリを `upload_app` で再アップロード | **技術的には可能**（エンドポイントは install-viz.mjs で実証済み）だが、GUI でダッシュボードを作る**全ユーザーに `install_apps` 権限が要る**ので設計として不採用 |
| スタブのプール（`dpx01.js`〜`dpxNN.js` を同梱し予約名で作成） | Mako 全廃と REST 作成は両立するが、**白フラッシュは解決しない**（標準テンプレートの `<head>` を握れず、PAGE_PATH のスクリプトはテーマ解決後にしか走らない）＋ビュー名がプール名に固定される |

**公式ドキュメント側の裏取り（2026-08-11）**:
- 10.4 の `web-features.conf` リファレンスにあるのは Mako/CherryPy 停止スイッチと
  dashboards_csp（外部コンテンツ制限）だけ。**クラシック JS 拡張を止めるフラグは文書に無い**
  ＝1.1 の `script` 非サポートは設定ではなくランタイム仕様
- dev.splunk.com の SUIT 統合手順（adduicomponent）は **`@splunk/create` でビルド時にビューを作る**
  流れのみ。動的作成への言及は皆無

**⭐ リスク評価を下げる実機事実（2026-08-11）**: `splunk-dashboard-studio:/templates/dashboard.html`
＝ **Splunk 自身の Dashboard Studio アプリが 10.4.2 でも etc/apps に custom Mako を同梱している**
（ビューから参照して 200 を実測）。停止スイッチを既定 true にすると Splunk 自社製品が壊れるため、
**この機構が急に消える可能性は低い**。

> ## 🛑【重要な訂正・2026-08-11】「DPX は Splunk Cloud に持ち込めない」は**誤り**
>
> **AppInspect 4.3.0 を v0.10.1 の `.spl` に実際に流した結果（実測）**:
>
> | タグ | failure | future_failure | error | warning |
> |---|---|---|---|---|
> | `cloud` | **0** | **0** | 0 | 2 |
> | `private_victoria` | **0** | **0** | 0 | 2 |
> | `private_classic` | **0** | **0** | 0 | 2 |
> | `private_app` | **0** | **0** | 0 | 2 |
>
> **`check_for_custom_mako_templates` は `not_applicable`。**
> 下の「持ち込めない」という結論は **Mako を使っていた頃（v0.1.x）の評価**で、
> **v0.2.0 で Mako を全廃した時点で失効していた**のに、
> 結論だけが残って**前提の変化が反映されていなかった**。
> パッケージには `.html` が 0 件（`appserver/templates` も `appserver/modules` も無い）＝
> **このチェックは発火しようがない**。
>
> **唯一の failure だったもの**（v0.10.0 で検出 → v0.10.1 で修正済み）:
> `check_for_valid_ui_label` … `[ui] label` は **5〜80 文字**必要で、`DPX`（3 文字）が短すぎた。
> → `DPX Dashboards` に変更。**Mako とは無関係の、1 行で直る指摘だった。**
>
> **残る warning 2 件**（いずれも審査を止めない）:
> `check_for_splunk_js`（テレメトリ目的。メッセージ自身が "Please ignore this warning" と明記）と
> `check_for_splunk_js_header_and_footer_view`（6.5 で非推奨の API 名がバンドル文字列に含まれる）。
> どちらも **`@splunk/react-page` 由来**で、DPX が直接呼んでいるわけではない。
>
> **教訓（強く効く）**:
> 1. **「審査で落ちる」は実行して確かめる。** AppInspect はローカルで流せる
>    （`splunk-appinspect inspect <spl> --included-tags cloud`）。**ソースを読んで推論しない。**
> 2. **前提が変わったら結論も見直す。** 「Mako があるから落ちる」は正しかったが、
>    **Mako を消した自分の変更で前提が消えていた**。
>    ナレッジに否定的な結論を書いたら、**その根拠が生きているかを毎回確かめる**。
> 3. **否定的な結論ほど検証コストを払う。** 「できない」は相手の選択肢を奪う主張なので、
>    肯定的な主張より強い根拠が要る。

**⭐ AppInspect のチェック内容（2026-08-11 ソース確認）**
※ **以下は「Mako を同梱していた場合」の話。現在の DPX には該当しない**（上の訂正を参照）:
`check_for_custom_mako_templates` = **`appserver/templates/`（または `appserver/modules/`）に
`.html` が存在するだけで `FailMessage`**（内容不問。DPX の dashboard.html / home.html は無条件該当。
空ファイルでも引っかかる）。
- 現行 AppInspect 4.3.0 では `release_version=4.4.0` 指定により **`future_failure`（予告）**。
  **AppInspect 4.4.0 から本物の `failure`** になる（`FailMessage.__init__` の実装で確認）
- 対象タグは `cloud` / `private_app` / `private_victoria` / `private_classic` / `migration_victoria`
  ＝ **Splunkbase 提出と Splunk Cloud の私有アプリ審査**。**セルフマネージド Enterprise の実行時には
  何も強制されない**
- → ~~**DPX は Splunk Cloud には持ち込めない**（審査で落ちる）。Enterprise 専用と割り切る~~
  **【訂正】この結論は誤り**（上の訂正ブロックを参照）。Mako 全廃後は
  このチェックが `not_applicable` になり、**cloud / private_* すべて failure 0** で通る（実測）
- 是正指示は「UCC ≥6.3.0 か `@splunk/create` ≥11.0.0 で作り直せ」＝標準テンプレート移行
  （上の全数調査で棄却済みの道）。**新しい逃げ道は示されていない**
- ⚠ 公式 10.4 非推奨ページの「AppInspect version 3.81 で置き換え勧告開始」は**不正確**。
  3.8.1 のソースに置き換え勧告チェックは無い（あるのは 8.0 時代の Python3 互換警告だけ。
  実ソースで確認）。同じページは停止スイッチの場所も `server.conf` と誤記している（実際は
  `web-features.conf`）。**このページの記述は個別に検証してから信じること**

**結論（確定）**：「①Mako 全廃 ②URL 維持（/app/<app>/<name>）③REST 動的作成 ④白フラッシュゼロ」は
**同時に満たせない**。白フラッシュゼロの唯一のレバーは初期 HTML の `<head>` を握ること＝Mako だけ。
**当面は Mako 継続が正解**。`deactivate_custom_mako_templates` が `false` である限り DPX は動く。
**Splunk のバージョンを上げるときは必ずこの設定と非推奨ページを確認する**。

---

## 2. DPX スキーマ v1（ダッシュボード定義）

```jsonc
{
  "version": 1,
  "title": "AEGIS SOC",
  "description": "",
  "hideHeader": false,           // true で見出し行を消す（全面レイアウト）
  "chrome": "dpx",               // 'dpx' = Splunk ヘッダを隠す / 'splunk' = 残す
  "style": {
    "preset": "midnight",        // midnight | neon | aurora | light
    "accent": "#00e5ff",         // 差し色の上書き（任意）
    "background": "particles",   // 背景エフェクト（§5）
    "entrance": "rise"           // rise | fade | none（表示モードのみ）
  },
  "grid": { "columns": 12, "rowHeight": 72, "gap": 12 },
  "dataSources": {                                            // 共有サーチ（§4.1）
    "ds_hosts": { "name": "ホスト一覧", "spl": "index=… | stats count by host",
                  "earliest": "-24h", "latest": "now", "refresh": 60 }
  },
  "tabs": [ { "id": "overview", "label": "概況" } ],        // 省略時は単一画面
  "tabPosition": "left",         // 'top'（既定）/ 'left'（サイドバー。★Studio に無い）
  "tabWidth": 168,               // サイドバー時の幅
  "rotate": { "enabled": true, "intervalSec": 15 },          // タブ自動送り
  "inputs": [                                                 // §4
    { "id": "in_time", "type": "timerange", "label": "期間", "token": "time",
      "defaultValue": "-24h,now" }
  ],
  "panels": [
    {
      "id": "trend", "viz": "dpx.line", "title": "トラフィック",
      "tab": "overview",                                      // タブ指定（省略時は先頭タブ）
      "x": 0, "y": 0, "w": 8, "h": 4,                         // グリッド座標（列/行単位）
      "style": { "variant": "glass", "hideTitle": false, "z": 1 },  // §5
      "search": { "ref": "ds_hosts",                          // ← 必ずデータソースを参照
                  "postSearch": "| where status=\"critical\"",  // ← このパネルだけの絞り込み
                  "earliest": "$time.earliest$",
                  "latest": "$time.latest$", "refresh": 60 },
      "options": { },                                          // viz ごとのオプション
      "onEvent": { "setTokens": { "svc": "value" } }           // クリック→トークン
    }
  ]
}
```

- **サーチは必ず `dataSources` に置く**（v0.4.0 で統一）。パネルは `search.ref` で参照し、
  パネル固有の絞り込みは `postSearch`（後続パイプ）で行う。
  **`search.spl` の直書きは廃止**（旧定義は開いた時点で `migrateToDataSources` が
  データソースへ切り出す。同一 SPL は 1 つに集約・冪等）。`refresh`（秒）で自動更新
- **`$token$` は SPL・earliest/latest・パネルタイトルで展開**される。
  **未解決トークンがあるパネルはサーチを実行しない**（「トークン待ち: $x$」を表示）
- パネルは**重ねてよい**（同じグリッドセルに複数置き、`style.z` で順序制御）。
  Studio の grid では不可能な構図（全面地図の上にガラスパネル等）が組める

---

## 3. viz の作り方・登録（**とても簡単**）

### 3.1 新規に作る

viz は「props を受け取る素の React コンポーネント」。**iframe も config.json も無い。**

```jsx
export function MyViz({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();                       // 解決済みテーマ（配色・パレット）
    const cols = dataSources?.primary?.data?.columns ?? [];
    if (cols.length < 2) return <div>データがありません</div>;
    // …描画…
}

MyViz.config = {
    key: 'my.viz',
    name: 'マイ viz',
    category: 'chart',                              // chart | status | deco | custom
    optionsSchema: { size: { type: 'number', default: 24 } },
    editorConfig: [                                 // インスペクタのフォームが自動生成される
        { label: '表示', layout: [[{ label: 'サイズ(px)', option: 'size', editor: 'editor.number' }]] },
    ],
};
```

`vizRegistry.js` の `VIZ_REGISTRY` に 1 行足せば viz ピッカーに出る。**ビルドし直すだけ**。

**渡ってくる props**（Studio 拡張の VizProps 互換）:
`dataSources.primary.data = {fields:[{name}], columns:[[…]]}` / `options` / `width` / `height` /
`loading` / `mode`（'view'|'edit'）/ `onOptionsChange` / `onEventTrigger`

### 3.2 既存の Studio 拡張 viz を載せる（2ステップ）

> **✅ 2026-08-11（DPX v0.3.0）で全 30 viz に適用済み。**
> `weather-panel`（`src/` が空＝ソース未実装）と `editor-probe`（検証用）を除く全 viz が
> DPX の registry に登録され、実機で描画確認済み。**新規に viz を作ったときだけ**
> 以下の2ステップが要る（既存 viz は対応済みなので読む必要はない）。
>
> **一括適用スクリプトの要点**（再実行するなら）: `visualization.jsx` の
> 自己マウント部を正規表現で捉えてガードで包み、`globalThis.__<NAME>_APP__ = <Comp>` を
> 追記し、`host.jsx` を生成する。⚠ **エントリの形は viz ごとに揺れる**ので
> 決め打ちしない（29 viz は `(function mountWhenReady(){…})()` の IIFE 形だったが、
> **severity-table だけ `if (document.readyState === 'loading')` 分岐形**で、
> しかも **`App` が props を取るため公開すべきは `Root`** だった。
> 機械適用の前に必ず全件の実際の形を grep で確認すること）。

world-map で実証済み（v2.2.1。**iframe 版の動作・見た目は不変**）:

1. viz 側: 自己マウントを `if (!globalThis.__DASH_PLATFORM_HOST__) { …mount… }` でガードし、
   **`App` をホストへ渡す口を用意する**（`globalThis.__WORLDMAP_APP__ = App` のような形）。
   ⚠ **エントリの .jsx に `export` を書いてはいけない**（次の「🛑」参照）。
   受け渡し用の `export` は **別ファイル**（`src/host.jsx`）に置く
2. DPX 側: `adaptExtensionViz(App, config)` でラップして registry に登録
   （`config.json` の `optionsSchema` / `editorConfig` は**そのまま流用できる**）

#### 🛑 エントリに `export` を足すと Studio 側が黙って全滅する（2026-08-10 実機で発生）

**これは実際に本番の world-map を壊した。移植で最も危険な罠。**

- viz のビルドは **esbuild の `format: 'esm'`**。エントリに `export` が **1つでもある**と
  成果物の末尾に **`export{nW as App}`** が出力される
- Studio の iframe はこのバンドルを**クラシックスクリプトとして読む**ため、
  **`Uncaught SyntaxError: Unexpected token 'export'`** でファイル全体が実行されず、
  **パネルが真っ黒**になる（描画コードは1行も走らない）
- **気づきにくい理由**：DPX 側は webpack で束ねるので**まったく正常に動く**。
  ローカルの `yarn verify`（229 件）も**全部通る**。壊れるのは Studio の実機だけ
- **検出方法**（パッケージ後に必ず確認する）:
  ```bash
  tar -xzOf dist/<最新>.spl '*/visualization.js' | grep -cE '(^|;)export[ {]'
  # → 0 なら OK。1 以上なら Studio で確実に壊れる
  ```
- **正しい構成**：エントリ（`src/visualization.jsx`）は export ゼロを維持し、
  `globalThis.__<VIZ>_APP__ = App` で受け渡す。DPX が import するのは
  **`src/host.jsx`**（`import './visualization.jsx'` してから `export const App = globalThis.…`）。
  esbuild のエントリではないファイルなので、`export` を書いても成果物に影響しない

> **教訓**：「差分が小さいから安全」は根拠にならない。`export` 1語の追加が
> バンドル全体の**モジュール形式**を変えた。**出力側（成果物）を見て確かめる**こと。
> このときも「diff は無害」と判断しかけ、実機の撮影で初めて気づいた。

**⚠ 検証ハーネスが罠を隠していた（2026-08-10 に判明・実証済み）**：
world-map の `test/verify.mjs` は eval の前に**末尾の `export` 文を剥がしていた**
（「実機のホストは module として読むので問題ない」という**誤ったコメント付き**）。
そのため**この致命バグを抱えたバンドルでも 229 件すべて通る**。実際に `export` を
注入して全通過することを確認した。**「剥がす」から「検出して落とす」に変更済み（world-map v2.2.1）。**
→ **他の viz に同じ検証台を作るときは、export を剥がす実装にしないこと。**

**⚠ `host.jsx` は import の並び順に依存させない**：
自己マウント抑止フラグ `__DASH_PLATFORM_HOST__` は `extensionAdapter` も立てるが、
`vizRegistry.js` の import 順（adapter が先・host が後）に依存する形だと、
**lint の import 整列などで順序が入れ替わった瞬間に二重マウント**しうる。
`host.jsx` 自身がフラグを立ててから viz を読み込む形にする:

```jsx
globalThis.__DASH_PLATFORM_HOST__ = true;   // ← 先に立てる
require('./visualization.jsx');             // ← import 文だと巻き上げられるので require
export const App = globalThis.__WORLDMAP_APP__;
```

（実機で単一マウント・`pageErrors` なしを確認済み。`import` 文は巻き上げられて
フラグ設定より先に評価されるため、ここは `require` である必要がある。）

webpack alias で `@splunk/dashboard-studio-extension/{react,visualization}` を
`components/extensionAdapter.jsx` に差し替えている（useDataSources / useOptions / useTheme /
useMode / useTokens / addDrilldownListener の互換実装）。

⚠ **移植で踏む罠3つ（すべて実機で確定）**:
- **react の二重バンドル**（viz 側 node_modules の react が解決され、hooks が null で死ぬ）
  → `react` / `react-dom` / `react-is` / `styled-components` / `@splunk/themes` / `@splunk/react-ui`
  を **webpack alias でアプリ側に一本化**する
- **classic JSX 変換**（既存 viz は automatic ランタイム前提で `import React` を書いていない）
  → `webpack.ProvidePlugin({ React: 'react' })`
- **babel の設定探索は「対象ファイルの場所」基準**。モノレポ外部のソースには
  アプリの `.babelrc.js` が届かないので、**rule 側に `presets` を直接書く**
- **SVG ローダーの衝突**（2026-08-11 追加。全 viz 移植で判明）。
  `@splunk/webpack-configs` の base が
  `{test: /\.(png|jpg|jpeg|gif|svg|eot|wav|mp3)$/, type:'asset/resource', generator:{filename}}`
  を持っており、**webpackMerge はルールを追記する**ので DPX 側で `asset/inline` を足すと
  両方が当たって **`ValidationError: generator has an unknown property 'filename'`** でビルドが落ちる。
  → **base 側の test から svg を外してから merge する**（他の拡張子は据え置き）。
  esbuild 側は `'.svg': 'dataurl'` なので、DPX も data URL（`asset/inline`）に揃えるのが正解

**⚠ 移植すると既存 viz 側のバグが可視化されることがある**（2026-08-11 の実例）:
8 viz が共有する空状態アイコン `ChartColumnSquare.svg` は **`viewBox` のみで幅高さを持たず
`fill="currentColor"`**。これを `<img src>` で読むと **(1) 親いっぱいに伸びる (2) currentColor が
効かず黒くなる**ため、パネル全面が黒い矩形になった。**Studio でも同じ**なので DPX 起因ではないが、
DPX で初めて目立った。CSS で `width/height/opacity` を与えて解決（両方の見た目が同時に改善）。

### 3.3 editor 型（インスペクタのフォーム自動生成）

**DPX が対応している editor 型は 15 種**（`Inspector.jsx` の `EDITOR_RENDERERS`。2026-08-10 時点）:

| 型 | UI | 届く値 |
|---|---|---|
| `editor.text` | 1行テキスト | string |
| `editor.number` | 数値 | number |
| `editor.checkbox` / `editor.toggle` | トグル | boolean |
| `editor.select` / `editor.radioBar` | ドロップダウン | 選択肢の value |
| `editor.color` | カラーピッカー | `#rrggbb` |
| `editor.slider` | スライダ | number |
| `editor.colorRules` | 値→色（DPX 独自。§6） | 独自オブジェクト |
| **`editor.columnSelector`** | 列のドロップダウン（**候補はサーチ結果の実列名**） | **DOS 文字列** `> primary \| seriesByName("x")` |
| **`editor.columnMultiSelectionByFieldNameEditor`** | 列をピルで複数選択 | 生のフィールド名の配列 |
| **`editor.threshold`** | 「以上／未満／色」の行を増減 | `[{from,to,value}]`（null 可＝開区間） |
| **`editor.arrayOfStrings`** | 1行1要素・並べ替え可 | `string[]` |
| **`editor.seriesColors`** | 色スウォッチの増減 | `string[]` |
| **`editor.presetSelector`** | ボタン群。押すと複数オプションを一括適用 | （値は保存しない） |

太字の6種は **2026-08-10 に追加**（world-map の全オプションがフォーム化された。実機確認済み）。

**⚠ `columnSelector` は「生のフィールド名」ではなく DOS 文字列を保存する。**
Studio と同じ形にしてあるので **viz 側のコードを一切変えずに載せ替えられる**。
ここを生の列名にすると、viz のパーサ（`seriesByName\((['"])(.+?)\1\)` を見ている）が
黙って空を返し、**エラーも出ずに「データが無い」状態**になる。

**列名の供給経路**（`columnSelector` の候補を出すための配管）:
```
Panel（サーチ結果を持つ）→ useRegisterPanelFields(panel.id, 列名[])
   → panelFields.jsx（PanelFieldsProvider）→ Inspector が usePanelFields() で読む
```
サーチは Panel の中で走るのでインスペクタからは見えない。そのため専用の
レジストリを1枚挟んでいる（Studio は editor 側が `dataSourceKey` で引くが、
DPX にはその配管が無い）。

⚠ **`data.fields` は Studio 互換の `[{name}]`**。文字列に均さずに渡すと
候補が **`[object Object]`** で並ぶ（2026-08-10 に実機で発生）。
`optionEditors.jsx` 側にも `toFieldNames()` の防御を入れてあるが、登録側で均すのが本筋。

- **Studio 拡張の editor 型一覧（28種）とは別物**。DPX は自前実装なので、
  ここに無い型は**フォームに出ず「JSON で編集」欄に落ちる**（隠さず案内する実装）
- 型を増やしたいときは `EDITOR_RENDERERS` にレンダラを1つ足すだけ（**再起動不要**）
- 未設定のオプションは **`optionsSchema` の `default` を表示**する
  （Studio 拡張の「既定値は options に載らない」罠と同じズレを避けるため）
- **`option` キーを持たない項目がある**（`presetSelector` が該当）。
  `key` を `item.option` だけで作ると React が壊れるので、`editor`＋添字で補う

**残っている未対応型**（他 viz で使われているもの。必要になったら足す）:
`editor.tableBackgroundColor`（1 viz で1箇所のみ）。

---

## 4. 入力・トークン・インタラクション

- **入力型**: `dropdown` / `multiselect`（カンマ区切り）/ `text` / `timerange`
- **timerange は `<token>.earliest` / `<token>.latest` の2トークン**になる
- **時間範囲ピッカーは Splunk 標準相当**（プリセット / 相対 / 絶対 / 詳細の4タブ。
  修飾子文字列 `-24h@h` 等をそのまま扱う）
- **パネルの時間範囲は2択**: 「このパネルで指定する」/「入力から受け取る」
  （後者は選んだ入力の `$tok.earliest$` を自動で埋める）
- **クリック→トークン**: パネルの `onEvent.setTokens = { トークン名: payloadキー }`。
  viz は `onEventTrigger({type, originalEvent, payload})` を呼ぶ。
  payload キーの慣例は `value` / `name` / `row.<フィールド>.value`
- **入力はトークン状態を読む**ので、クリックで設定した値が**入力の表示にも即反映**される（双方向）
- **viz 間のホバー同期**は `vizBus.jsx`（React context）。同一ツリーなので postMessage 不要

---

### 4.1 共有データソース（サーチの使い回し）★2026-08-10 追加

Studio から踏襲した機能。**同じサーチを複数パネルで共有し、実行は1回で済ませる**。

```jsonc
"dataSources": { "ds_hosts": { "name": "ホスト一覧", "spl": "…" } },
"panels": [
  { "search": { "ref": "ds_hosts" } },                                  // 参照
  { "search": { "ref": "ds_hosts", "postSearch": "| where cpu>60" } },  // 参照＋絞り込み
  { "search": { "spl": "…" } }                                          // 直書き（従来どおり動く）
]
```

- **Studio との違い**：Studio は `ds.search` / `ds.chain` / `ds.test` と型を分けるが、
  DPX は **「共有サーチ＋postSearch（後続パイプ）」の1種類に畳んだ**。
  `ds.chain` 相当は postSearch で足り、型を増やすほど編集 UI が複雑になるため
- ⚠ **postSearch の絞り込みは `| where`**。`| search` は 0 行になる
  （サブサーチではなく後続パイプなので `search` コマンドの意味が違う）
- 時間範囲は**パネル側の指定が優先**（入力から受け取る運用があるため）
- 参照先が消えた場合はパネルに「データソースが見つかりません」と出す（黙って空にしない）
- インスペクタ：ダッシュボード側に「データソース（共有サーチ）」セクション、
  パネル側に「サーチ元」ドロップダウン。直書きのパネルは
  **「このサーチを共有データソースにする」ボタン1つで切り出せる**
- **編集ツールバーの「データソース」ボタンから一元管理できる**（2026-08-11 追加。
  `DataSourceManager.jsx`）。Studio と同じく**サーチはダッシュボードに属する**
  という建て付けを UI でも見せるため、パネルを選ばなくても開ける位置に置いた:
  - 左に一覧（使用中パネル数つき）、右に SPL / 時間範囲 / 自動更新の編集
  - **削除時は使っているパネル名を挙げて確認する**（黙って壊さない）
  - 複製ボタンで似たサーチを増やせる
  - ⚠ ダイアログは **`createPortal` で body に出す**（§8.z）
- 実装は `components/engine/dataSources.js`（解決は `resolvePanelSearch`）

---

### 4.2 入力（2026-08-10 全面改修 / 2026-08-11 選択肢まわりを刷新）

**選択肢は「値」と「表示名」を別々の欄で入れる**（2026-08-11 変更）。
以前は `値|ラベル` の1行記法だったが、**区切り記号をユーザーに覚えさせるのは負担**
（色ルールで同じ理由で廃止済みだったのに、入力側に残っていた）。

**サーチによる動的選択肢（★Studio から移植）**:

```jsonc
{ "id":"in_host", "type":"dropdown", "token":"host",
  "choicesMode": "search",                       // static（既定）| search
  "choiceSearch": {
    "ref": "ds_hosts",                           // 共有データソース参照 or "spl" に直書き
    "valueField": "host",                        // トークンに入る列（空なら1列目）
    "labelField": "host"                         // 画面に出す列（空なら値と同じ）
  },
  "staticChoicesFirst": [ {"value":"*","label":"すべて"} ]   // 先頭に足す固定行
}
```

- 実装は `inputChoices.js`（`useInputChoices`）。**重複値は自動で落とす**
  （`stats count by host` の結果をそのまま使えるように）
- 選択肢サーチにも**トークンが展開される**（`$env$` で絞る等）。
  未解決トークンがある間は実行しない
- ⚠ **dropdown は選択肢が届いたら先頭を自動選択する。** これが無いと
  トークンが永久に未設定で、参照パネルが「トークン待ち」で止まる（実機で発生）
- ⚠ **multiselect は「未選択＝絞り込みなし」**として扱う。
  初期トークンを空文字で入れ、`applyTokens` の `optional` に渡して
  **空文字へ展開**する。これをしないと `$svc$` が SPL に**リテラルで残る**（実機で発生）

### 4.2.1 SPL 編集中はサーチを実行しない（2026-08-11 追加）

打鍵のたびに `patchSearch` すると**そのたびにジョブが飛ぶ**。書きかけの
SPL（`index=web | stat`）で実行され、実機に無駄な負荷がかかりエラー表示も点滅する。

→ **`SplEditor.jsx`**：編集中は手元の草稿だけを更新し、
**フォーカスを外したとき / Ctrl(⌘)+Enter** で確定する（Esc で取り消し）。
未反映の間は枠の色とヒント文で知らせる。

適用先は**パネルの SPL・共有データソースの SPL・選択肢サーチの SPL**の3か所
（データソースは参照している全パネルが再サーチするので特に効く）。

実測（実機・20文字を連続入力）: **打鍵中のサーチ実行 0 回 → blur で 1 回**。

### 4.2.2 入力型の一覧

**入力はキャンバス上の選択対象**になった。編集モードで入力をクリックすると
右ペインがその入力の設定に切り替わる（以前はインスペクタに常設されていて、
パネルを選んでいるのに入力設定が並ぶ状態だった）。**並べ替えはドラッグ**。

**入力型**（★は Studio に無い）:

| 型 | 値の入り方 |
|---|---|
| `dropdown` | token に選択値 |
| `multiselect` | token にカンマ区切り（SPL では `IN()`） |
| `text` | token に文字列 |
| `number` | token に数値 |
| `timerange` | `token.earliest` / `token.latest`（相対指定 `-24h@h` 等） |
| **`date`** ★ | カレンダーで1日選択 → token に `YYYY-MM-DD` |
| **`daterange`** ★ | カレンダーで期間選択 → `token.earliest` / `.latest` |

- **カレンダーは自前実装**。`<input type="date">` は**ダークテーマに追随せず浮く**ので使わない
  （自前ドロップダウンと同じ理由）
- ⚠ **コントロールの高さは `ui.jsx` の `CONTROL_H`（30px）に固定**。
  padding 任せだと型ごとに 1〜3px ずれて、横並びにしたとき下端が揃わない。
  **6型すべて 30px であることを実機で計測して確認済み**

### 4.3 編集ツールバー（Studio 準拠）

編集モードの上部に、カテゴリ別のドロップダウン（チャート / 入力 / 装飾 / 図形）と
undo / redo、タブ追加を並べた `EditToolbar.jsx`。
**こういう本質的でない部分は見慣れた形の方が使いやすい**ので Studio の並びを踏襲した。
undo/redo は `def` のスナップショットを 50 段まで保持する方式。

---

## 5. 見た目（テーマ・パネル質感・背景・タブ）

- **配色プリセット18種**（`themes.js`）。系列色パレットもプリセットごとに持つ（`useDpxTheme().palette`）:

  | preset | 印象 |
  |---|---|
  | `midnight`（既定） | 濃紺。標準的な NOC |
  | `carbon` | 無彩色・硬質。色で主張せず数値を読ませる |
  | `slate` | 落ち着いた青灰。長時間見る運用画面向け |
  | `amber` | 琥珀の管制盤。暖色系で目に優しい |
  | `matrix` | 緑のターミナル。**フォントも等幅になる** |
  | `neon` | ピンク×シアン。イベント・デモ向け |
  | `aurora` | 青緑のグラデーション |
  | `light` / `paper` | 明るい地（`paper` は印刷物風・高コントラスト） |
  | `letterpress` | 活版。生成りの紙＋刷りインクの色。**明朝**になる |
  | `blueprint` | 青焼き図面。プルシアンブルーの地に白/シアンの線。等幅 |
  | `thermal` | 熱画像の偽色（冷=暗紫の地、熱=橙の差し色） |
  | `eink` | 電子ペーパー。無彩色・低コントラスト。増減も濃淡で表す |
  | `watercolor` | **水彩**（v1.6.0）。水彩紙の生成り地に顔料のウォッシュ。乾いた縁が濃い「エッジの濃まり」。丸ゴシック |
  | `crayon` | **クレヨン／オイルパステル**（v1.6.0）。黒画用紙＝手描き系で唯一のダーク。紙の目＋こすった跡 |
  | `pencil` | **色鉛筆**（v1.6.0）。スケッチブックの紙目。青鉛筆がアクセント・赤鉛筆がエラー |
  | `inkwash` | **インク＋水彩（ペン画）**（v1.6.0）。旅帳の生成り＋群青のウォッシュ＋セピアインクの文字 |
  | `liquidGlass` | **Liquid Glass（iOS 26）**（v1.7.0）。WWDC25 の銀地＋細グリッド＋色の溜まり。Apple システムカラー系・SF Pro 系フォント |

  ⚠ **手描き画材4種（crayon / pencil / watercolor / inkwash）の「線」は
  CSS ではなく canvas で実描画する**（v0.1.0。`handDrawn.js` / `HandDrawnFrame.jsx`）。
  - **CSS で作れないもの**: `repeating-linear-gradient` と `box-shadow` は
    **完全な直線・等間隔・均一な太さ**しか作れない。画材の本質である
    「線がふらつく／筆圧で濃さが変わる／紙の目でかすれる／縁を二度なぞる」は
    **原理的に表現できない**。v1.6.0 の実装はこれを CSS でやろうとして
    「小手先で理想と遠い」と評価された（ユーザー指摘）
  - **分担**: 形のゆらぎ＝ **rough.js**（MIT・バンドル増 約 40KB）、
    画材固有の乗り方（重ね塗り・かすれ・紙の目）＝自前。
    **面の表現（水彩のエッジの濃まり等）は CSS のまま**でよい
    ——CSS が苦手なのは「線」であって「面」ではない
  - **p5.brush は採用しなかった**：peer に p5.js が要り **17MB**（DPX 本体が 4.5MB）。
    p5 は canvas と描画ループを own する設計で React と噛み合わない。
    rough.js は 170KB・フレームワーク非依存で、素の canvas に描ける
  - ⚠ **必ず seed を渡して決定的にする**（`seedFrom(panel.id)`）。
    `seed` 省略時は毎回違う絵になり、**React の再描画のたびに枠が変わってチラつく**。
    症状が「画面がなんとなく落ち着かない」としか出ないので原因特定が難しい
  - ⚠ **`bowing` は辺の長さに比例して弓なりになる。** 固定値のままだと
    **横長パネルで辺が内側に大きくたわむ**（実機・幅780pxで顕著）。
    辺が長いほどゆらぎを弱める（実際の手描きも長い線ほど相対的にまっすぐ）
  - **試作で分かった「効かなかった方法」4件**（`handDrawn.js` 冒頭に詳述）:
    ①紙の目を `destination-in` で抜く→暗い盤面で**黒い裂け目**に見える
    （**紙の色で上から散らす**のが正解）／②四角いセルのノイズを敷き詰める→
    **デジタルなノイズ／QRコード状**（丸い凹みをまばらに・density 0.08 前後）／
    ③短い区間を `lineCap:'round'` で並べてかすれを作る→**丸い錠剤が並ぶ**
    （パスは切らず `butt` で連続。かすれは細く薄い線を多数重ねて出す）／
    ④rough.js の `hachure` で面を塗る→**直線なので落書き**に見える
  - ⚠ **canvas の枠はレイアウト上の幅を持たない。** CSS の `border` と違って
    中身を押しのけないので、**そのままではタイトルやグラフに線が重なる**（実機で発生）。
    パネル側に枠のぶんの余白（`HAND_DRAWN_INSET`）を持たせて線の居場所を作る。
    ⚠ このとき**余白ぶん外へ広げようとして負のオフセットを使ってはいけない**：
    パネルは `overflow:hidden` なので**canvas がまるごと切り取られて枠が消える**
    （実際に消して気づいた）。絶対配置の基準は *padding box* なので `inset:0` のままにする
  - ⚠ **枠は中身より前面（`zIndex`）に置く。** 背面に敷くと、自前の背景を持つ viz
    （テーブルの見出し帯・行の縞など）に**塗り潰されて線が途切れる**（実機で発生）。
    実際の画材でも「紙の上に描いた線」は中身の上に乗るので物理的にも正しい。
    `pointerEvents:'none'` にすればクリックは透過する。
    ⚠ ただし**紙の目は枠の帯の内側に撒かない**（前面にあるので、全面に撒くと
    グラフや文字の上に粒が乗って汚れて見える）
  - ⚠ **バンドルされたかの判定は webpack のモジュールグラフで行う**。
    最小化で package 名が消えるので**文字列 grep は当てにならない**
    （canvas レンダラ経路では `hachure-fill` 等の推移的依存は含まれない、と実際に確認）
- ⚠⚠ **OSS 通知は共通ジェネレータで作る**（`scripts/gen-third-party-notices.mjs`／各所で `yarn notices`）。
  2026-08-13 に点検したところ、DPX は**バンドル 45 件中 42 件が通知に載っていなかった**
  （react-dom / styled-components / lodash / d3-* 等）。MIT・BSD・Apache-2.0 はいずれも
  「複製物に著作権表示と許諾条文を含めること」が条件なので、**条件を満たしていない状態**だった。
  - **【重要】`visualizations/*`（31件）は最初から機械生成されていた。**
    穴が空いていたのは **`apps/*`**（webpack ビルドなので esbuild metafile が無く、
    共通ジェネレータの対象外だった）。4アプリ中3つは通知そのものが無かった。
    → 共通ジェネレータを **webpack stats にも対応**させ（`WEBPACK_STATS` 環境変数）、
    apps/* 4つを同じ仕組みに載せた（2026-08-13）
  - ⚠ **新しく作る前に既存の仕組みを探す。** DPX 用の別ジェネレータを書きかけたが、
    既存のほうが厳格（**指紋照合**・宣言なしパッケージで**失敗**・非 OSS の別枠・
    `notices-data.json` での素材申告）だったので廃棄した
  - **`package.mjs` で指紋照合する**（`Fingerprint:` 行 vs 実バンドル）。
    これが無いと通知は必ず腐る。**apps/* にも同じ照合を入れた**
    （壊して落ちることを実機で確認済み）
  - ⚠ **`package.json` の dependencies から作らない**：react / styled-components / @splunk/* は
    devDependencies だが `external` 指定が無いのでバンドルされる。逆も然り
  - ⚠ **apps/dpx は姉妹 viz の `node_modules` も踏む**（移植した viz を import しているため）。
    パッケージ名だけで探すと `d3-sankey` 等を取りこぼす。**解決パスごと**集めること
  - ⚠ **LICENSE ファイルを同梱していないパッケージがある**（`styled-components` が実例）。
    共通ジェネレータは**条文を捏造せず**「宣言のみ（原文は配布元参照）」と事実だけ書く

  ⚠ **表示名は短い名前だけにする（説明を括弧で足さない）。** v0.1.0 で
  `カーボン（無彩色・硬質）` → `カーボン` のように全廃した。選択肢が18〜25個あるので、
  **括弧付きだとテーマピッカーのタイル内で名前が切れて読めない**（実機で確認）。
  上の表の「印象」列のような説明は**ドキュメントに置き、UI に持ち込まない**。
  例外は **識別に要る括弧**（`ライズ（下から）` と `スライド（左から）` は方角が
  名前から分からない）。この規約は `themes.test.mjs` が機械的に検査する。

  ⚠ **UI の並び順は `PRESET_ORDER`（`themes.js`）が持つ。** `DPX_PRESETS` の定義順は
  「追加した歴史」そのもので、発光系→紙→また発光系という並びになっていた。
  **定義ブロック（数百行）を動かさずに並べ替えられる**ようにこの配列へ分離してある。
  **プリセットを足したら `PRESET_ORDER` にも足すこと**（漏れたものは末尾に出る。
  テストが検出する）。一覧を出すときは `orderedPresets()` を使い、
  `Object.entries(DPX_PRESETS)` を直接回さない。

  ⚠ **ライト系プリセットを足したらトップバーの地色も確認する。**
  濃紺の決め打ちだったため `paper` で**ブレッドクラムが読めなくなった**（実機で発生）。
  `t.colorScheme` で分岐させること
- **角の丸み（`style.radius`）＝ 既定 2px**（2026-08-11 変更）。
  丸すぎると「アプリの UI」に見えて管制画面の硬質さが出ないため。
  ダッシュボード単位（`style.radius`）とパネル単位（`panel.style.radius`）の両方で設定でき、
  **テーマトークン `t.radius` が単一の出どころ**（決め打ちの `10` を全廃）
- **全体の質感を一度に動かす軸**（インスペクタの「デザイン」）:
  角の丸み / カギ括弧の色 / **パネルの間隔（`grid.gap`）** / **行の高さ（`grid.rowHeight`）**。
  間隔を詰めるほど情報密度が上がる（壁面表示向け）
- **パネル質感25種**（`style.variant`。一覧は `PANEL_VARIANTS`）。**既定は `noc`**（2026-08-11 変更）:
  - **`noc`（表示名「コーナーフレーム」・既定）** … **四隅のカギ括弧だけ**の枠。全周の枠線も
    **タイトル下の区切り線も引かない**。見出しは小さめ・大文字・字間広めの管制ラベルで、
    アクセントの丸も出さない。**枠が主張しないぶん数値やグラフが前に出る**
  - 実装は `cornerBrackets()`（`themes.js`）。**`linear-gradient` を8枚重ねる**方式。
    疑似要素は2つしか使えず4隅×2辺に足りないこと、余計な DOM を増やすと viz の
    レイアウト計算に影響すること、**面積比例の塗りではないので raster が軽い**ことが理由
  - 色は `style.bracketColor` で上書き可（既定は控えめな中性色。
    ⚠ アクセント色をそのまま使うと主張が強すぎる。**薄すぎると壁面表示で消える**ので
    実機で 0.42 → 0.62 に上げた）
  - 腕の長さは 11px。**長いと「枠線」に見えてしまう**ので短くする
- 他の質感:

  | variant | 用途 |
  |---|---|
  | `bracketSolid` | NOC の括弧＋不透明地。背景エフェクトが強くても読める |
  | `card` | 従来のカード（枠あり） |
  | `glass` | すりガラス（半透明＋blur） |
  | `solid` | 完全不透明 |
  | `outline` | 枠だけ・塗りなし。図形の上に重ねられる |
  | `underline` | 上辺だけアクセント線。表を並べるときに軽くまとまる |
  | `sideAccent` | 左辺だけアクセント線。縦積みのステータス一覧に合う |
  | `inset` | 沈み込み（内側の影）。押し込まれた計器盤 |
  | `elevated` | 浮き上がり（強い影）。重要な1枚を持ち上げる |
  | `holo` | ホログラム。斜めの薄い縞＋リムライト（**blur は使わない**） |
| `neonEdge` | ネオン管。枠だけ光らせ中身は暗く保つ |
| `blueprint` | 方眼紙。16px/80px の格子を重ねた設計図 |
| `ticket` | 伝票。上辺だけミシン目風の点線 |
| `letterpress` | 活版。ヘアライン1本の細罫（二重罫は帯に見えるので不可） |
| `polaroid` | 印画紙。下だけ広い白縁＋印画面（⚠区画では使えない） |
| `punchCard` | パンチカード。clip-path で上辺に切り欠き（⚠区画では使えない） |
| `titleBlock` | 図面の表題欄。右下に二重線 |
| `eink` | 電子ペーパー。影も光沢も無い平面 |
| `watercolor` | **水彩**（v1.6.0）。輪郭線なし・縁に顔料が溜まる inset＋ウォッシュ。角丸9px を自前で持つ |
| `crayon` | **クレヨン**（v1.6.0）。4px の蝋の線（半透明）＋ずらした二度塗り。角丸12px |
| `pencil` | **色鉛筆**（v1.6.0）。2方向クロスハッチ（115deg 密＋25deg 粗）＋二度引きの輪郭線 |
| `inkwash` | **インク＋水彩**（v1.6.0）。2px のインク線＋線からはみ出すウォッシュ＋右下にペンの溜まり |
| `liquidGlass` | **Liquid Glass**（v1.7.0）。**背景が縁で実際に屈折する**＝SVG 変位マップを `backdrop-filter: url(#dpx-liquid-lens)` で適用（⭐ **同一ドキュメント参照なので DPX でだけ成立**。iframe の Studio 拡張には持ち出せない。**Chromium 実機で屈折を確認済み**。定義は `liquidGlassDefs.jsx`、DpxDashboard が常設）。**色収差つき**＝R/G/B を別 scale で変位→加算合成（⚠ **scale 差を 20 にしたら端に実在しない青緑の帯**が出た。バックドロップ端のクランプ画素がチャンネルごとに別方向へずれるため。**差は 10 前後まで**。実機で確認）。＋スペキュラ／明縁／反射ストリーク／下辺の分光／厚みの影。角丸24px を自前で持つ。⚠ **ダークテーマは照りゼロ＋blur/saturateなし（url のみ）**＝微弱な白い照りや 2px のブラーでも暗い地では「霧状の滲み」に見える（実機で2回指摘されて確定。ライトだけ照りを持つ）。屈折帯は各辺20%に絞る（遷移が広いと中央まで滲む）。⚠ backdrop-filter を使うので**動く背景と重ねない**（毎フレーム再ブラー） |
| `frameless` | 枠なし・背景透過（タイトルバーも消える） |
- **タイトルの位置と質感**（2026-08-11 / v0.9.0 追加）。以前は**左上固定**だった:
  - パネル … `panel.style.titleAlign`（left/center/right）と
    `panel.style.titleSkin`（10種。`panelTitleSkin()` in themes.js）。
    **既定 `auto` は従来と同じ判定（`variant === 'noc'`）**なので既存ボードは不変
  - ダッシュボード … `style.header`（`align` / `size` / `skin` 6種 / `stamp`）。
    ⚠ **中央寄せのとき日付スタンプを同じ行に置くと見出しが中央からずれる**ので下段へ回す
  - ⚠ 既定値を変えると**既存の全ダッシュボードの見た目が黙って動く**。
    「auto」の分岐条件は改修前と1文字も変えないこと（`bracketSolid` を
    含めかけて戻した）
- **パネル個別の見た目上書き**（2026-08-11 追加。`panelStyleOverrides()`）。
  質感プリセットでは足りない「1枚だけ作り込む」ための逃げ道。
  **未指定のキーは触らない**（既定値で上書きしない）ので、値を入れたときだけ効く:

  | キー | 効果 |
  |---|---|
  | `accent` | このパネルだけアクセント色を変える（タイトルの丸・発光） |
  | `bg` / `borderColor` | 背景色・枠線色の直接指定 |
  | `radius` | 角の丸み（0〜36px） |
  | `opacity` | 不透明度（背面の図形を透かす） |
  | `glow` | 枠の外側の発光（0〜1） |
  | `blur` | 背面のぼかし（すりガラスの強さ） |
  | `rotate` | 傾き（deg）。⚠ §8.aa と §8.z の制約あり |

  ⚠ **`rotate` を使うと全画面表示とツールチップの位置がずれる**（transform が
  子孫の `position:fixed` の基準を変えるため）。インスペクタにも注意書きを出している
- **背景エフェクト40種**（`BackgroundLayer.jsx` の `BACKGROUND_OPTIONS`。v0.1.0 で 23→40）:
  canvas 系＝particles / constellation / rain / ripple / wave / starfield /
  **meteor / radar / bubbles / snow / fireflies**、
  パターン系＝grid / hex / dots / diagonal / scanlines / circuit / topo / weave / laid /
  graphPaper / halftone / **isometric / chevron / carbonFiber / blueprintFrame**、
  グラデ系＝glow / aurora / vignette / thermalScan / **washBlooms（水彩のにじみ。v1.6.0）** /
  **spotlight / cornerGlow / sunbeam**。
  canvas 系は `document.hidden` で描画停止。
  手描き系＝**paperTooth / sketchGrid / crayonScribble / pencilHatch / inkSplatter**
  （canvas 実描画。パネル枠と同じ `handDrawn.js` を使う）。
  **1920×1080・パネル6枚で全て 60fps を実測**（v0.1.0。既存の particles と同値）
  - ⚠ **手描きの背景は「静止画」にする**（`StaticCanvas`＝サイズ変更時だけ描く）。
    紙と画材は動かないし、全面 canvas を毎フレーム描くと面積比例の raster が乗る
  - ⚠ **選択肢と実装のズレは無言で失敗する。** 一覧にあるのに実装が無ければ
    背景がただ消え（エラーも出ない）、実装だけあれば死にコードになる。
    `test/backgrounds.test.mjs` が両方向を突き合わせるので、**足すときは
    一覧と実装の両方**を触る（canvas 系は `kind === '...'` の分岐も要る）
  - ⚠ washBlooms は**縁の輪だけ**を描く（内側に薄膜を敷くと生成り地で
    灰色の卵形の染みに見える。実機で確認して輪だけに変更した）
  - ⚠ **疎らに見せたい canvas 系は「待ち時間」を持たせる**（meteor が実例）。
    全個体が常に動いていると流星は**ただの雨**になる。個体ごとに
    `wait` フレームを持たせ、消えたら次の待ちを乱数で振り直す
  - ⚠ **inset box-shadow を重ねて二重罫は作れない**（blueprintFrame で踏んだ）。
    後の inset が先の inset を塗り潰すので、**間の透明な隙間が出ずに1本の帯**になる。
    辺ごとの線は `linear-gradient` ＋ `background-position` / `background-size` で置く
- **出現アニメ12種**（`DpxDashboard.jsx` の `ENTRANCE_ANIM`。v0.1.0 で 6→12）:
  rise / drop / fade / slide / slideRight / zoom / pop / unfold / unfoldX / flip / swing / tilt。
  - **値 → `'<keyframe名> <尺> <イージング> both'` の完全な指定**を持たせる形にしてある
    （drop の跳ね返りは 0.5s だと潰れるので尺を変える必要があった）
  - パネルは `index×70ms` でずれて出る（`animationDelay`）ので、
    **方向のあるアニメは盤面を波が走るように見える**
  - ⚠ **動かすのは `transform` / `opacity` だけ。** `filter` / `box-shadow` /
    `background-position` を animate すると毎フレーム再描画になる（§ viz-performance）。
    テストが keyframes の中身を検査して違反を落とす
- **タブ＋自動送り**: `tabs` と `rotate`。⚠ **ローテーションの effect を「現在タブ」に依存させない**
  （依存させると切替のたびに基準時刻がリセットされ、15秒設定が4秒間隔になる。実機で発生）。
  `useRef` に最終切替時刻を持ち、effect は張り直さない
- **Splunk ヘッダの非表示**: `body > header { display: none }` を注入（クラス名は
  ビルドごとに変わるので**構造で指定**する。noc-wall の実機知見）
- ⚠ **ヘッダを隠すなら「戻る導線」を自前で用意する**（v1.1.0 で追加。`SplunkHomeLink.jsx`）。
  Splunk ヘッダを消すと**Splunk 本体へ帰る手段が画面から消える**（ブラウザの戻るだけになる）。
  キオスク表示に ✕ を必ず残すのと同じ原則＝**抜け出せなくなる UI を作らない**（§6.8.8）。
  - 行き先は**実機のヘッダロゴの href に合わせる**：`<a data-test="header-logo"
    href="/en-US/app/launcher">`（DOM を読んで確認。推測で `app/launcher/home` と書かない）。
    ロケール接頭辞は **`createURL('app/launcher')`** に付けさせる
  - **Splunk 本体へ出るリンクは SPA 遷移にしない**（素の `<a href>`。DPX の
    pushState ルータの管轄外なので、`navigate()` に渡すとルートが解決できない）
  - ⚠ **Splunk のロゴ SVG を複製して同梱しない。** ヘッダから取れるので手軽に見えるが、
    **登録商標**であり「同梱素材は著作権フリーのみ」という本リポジトリの方針に反する。
    汎用のホーム記号＋「Splunk」の文字で用は足りる

---

## 6. 値→色の設定（`editor.colorRules`）／DOS 相当の書式

⭐ **Studio で DOS を手書きするしかなかった機能を、DPX では UI から設定できる**
（2026-08-11 実装・実機検証）。Studio 側の DOS 17関数の一覧と実機確認は
[studio-standard-viz.md](studio-standard-viz.md) §2.3.3。

| DOS の関数 | DPX での場所 | 備考 |
|---|---|---|
| `rangeValue` | 色のルール → **範囲** | しきい値→色 |
| `matchValue` | 色のルール → **一致** | 文字列→色 |
| **`gradient`** | 色のルール → **グラデーション** | **しきい値ゼロ**で最小〜最大を連続写像 |
| **`maxContrast`** | 値による色 → **文字色を自動で読みやすく** | 地の色から白/黒を自動選択 |
| **`divideBy`** | 数値の書式 → **割る数** | SPL を変えずに単位換算 |
| **`prefix`** | 数値の書式 → **接頭辞 / 単位** | 前後に文字を足す |

⚠ **`maxContrast` 相当は WCAG の相対輝度で判定する。**
単純な `(r+g+b)/3` だと**緑を暗いと誤判定**して緑の地に黒文字を置く。
`relativeLuminance()`（係数 0.2126/0.7152/0.0722）を使う。
また**実際に塗る色**（パネルの地と混ぜた後）で判定しないと見た目と合わない。

⚠ **書式（単位換算・接頭辞）は必ず「対象の列」を選べるようにする。**
列指定なしで全列に適用すると、**CPU まで `0.0 MiB`、ホスト名まで `srv-web-01`**
になる（実機で確認して列指定を後付けした）。

⚠ **色の計算はテストで押さえる。** 目視では「合っているか」が判定しづらい。
`apps/dpx/test/colorRules.test.mjs`（`yarn test`）に境界値
（最小・最大・**全行同値＝ゼロ除算**・非数値・解釈できない色）を入れてある。
※ `'bad'` は**妥当な3桁hex（`#bbaadd`）**なので「解釈できない色」のテストには使えない
（自分のテストが間違っていた実例）。



Splunk 標準の「動的色設定」に倣った UI（`ColorRulesEditor.jsx` / `colorRules.js`）。

```jsonc
"colors": {
  "mode": "range",                    // range（数値のしきい値）| match（文字列）
  "palette": "trafficDark",           // プリセット適用の記録
  "thresholds": [20, 40, 60, 80],     // 昇順。区間は thresholds.length + 1 個
  "colors": ["#c0392b", "…", "#3fa34d"],
  "matches": [ { "value": "稼働", "color": "#3cdcb4", "label": "RUNNING" } ],  // mode=match
  "defaultColor": ""
}
```

- **区切り記号を使う記法（`crit|重大`）は廃止**（ユーザー負担が大きいため）。
  一致モードは**1行1値**、同じ色にしたい値は行を分けて同じ色を選ぶ
- プリセットパレット5種をクリックで一括適用（区間数に合わせて等間隔サンプリング）、⇅ で反転
- **旧形式（`[{match,color,label}]` の配列）は読み込み時に自動移行**（`|` は1行1値へ展開）
- 適用先: `dpx.status`（状態の色＋表示名）/ `dpx.value`（しきい値）/ `dpx.line`（系列色）/
  `dpx.bar`（ラベル or 値）。**未設定なら従来どおりの既定色**

---


⚠ **見栄えを足すときの鉄則（viz-performance.md §2 の裏返し）**:
- アニメは **transform / opacity だけ**。`filter` / `box-shadow` を animate すると
  毎フレーム再描画になり、**パネル数に比例して重くなる**
- 質感に **`backdrop-filter` を新規で足さない**。下が動くたび再ブラーになり、
  **文字のサブピクセル AA も無効化**される（小さい文字がぼやける）。
  ガラス感は「不透明度を上げる＋色味と影」で出す
- canvas の点や線は**細く保つ**。塗り面積が増えなければ層を増やしても軽い
- **「canvas がある＝動いている」ではない。** 画素を読んで
  「何点描かれているか」「時間差で重心が動くか」まで見る（実際にこれで確認した）
- ⚠ **`background-position` を animate しない**（2026-08-11 実機で確定）。
  transform と違って**合成に載らず、毎フレーム全面が再描画される**。
  背景「グリッド」がこれで、1920×1080 で **22fps**（`transform` 方式へ変えて **60fps**）。
  流したいときは**外側 `overflow:hidden` ＋ 内側を1周期ぶん大きく取って `transform`**。

#### 6.7.1 fps が落ちたときの犯人の見つけ方（2026-08-11 実測手順）

**「重い要素を消して測る」を要素単位でやると外す。** 実際に外した:

| やったこと | 結果 | 学び |
|---|---|---|
| バー 454 本を `visibility:hidden` にして測る | **22.6 → 22.6fps**（変化なし） | `visibility:hidden` は**レイアウトも合成レイヤも残る**。消したことにならない |
| 「アニメ要素が 238 個ある。数が多いのが原因だろう」と推測 | **誤り** | 個数ではなく**プロパティの種類**で決まる |
| `dpxGrow` を 224 → 24 に減らした | **22.6 → 22.7fps**（効果ゼロ） | 「たくさんある方が犯人」は根拠にならない |
| **アニメ名ごとに1種類ずつ止めて測った** | `dpxGridPan`（**たった1個**）で **22 → 60.6fps** | ← これが正解 |

**手順（これをやる）**:
1. `* { animation: none !important }` を注入して測る。**戻らなければアニメは無罪**
2. 戻るなら**アニメ名ごとに1つずつ止めて**測る（`getComputedStyle(el).animationName` で選ぶ）
3. 犯人のプロパティを見る。`transform` / `opacity` **以外**を動かしていたらそれが原因

```js
// アニメ名の一覧と個数
[...document.querySelectorAll('*')].reduce((m,e)=>{const a=getComputedStyle(e).animationName;
  if(a&&a!=='none')m[a]=(m[a]||0)+1;return m},{})
```

**教訓**: 犯人は「重そうな要素」ではなく「**間違ったプロパティを動かしている1要素**」だった。
数や見た目の派手さで当たりを付けず、**必ず1種類ずつ潰して測る**。

### 6.8 パネルの右クリックメニュー（★Studio に無い）

表示モードでパネルを右クリックすると独自メニューが出る（`PanelContextMenu.jsx`）:
**サーチで開く** / SPL をコピー / 結果を CSV で保存 / 全画面表示。

**Studio では原理的にできない**——パネルが iframe に隔離されており、
iframe 内の `contextmenu` を親が横取りできず、親のメニューを重ねる位置合わせも
できないため。DPX は全パネルが同じ DOM ツリーにいるので素直に書ける。

- 「サーチで開く」の URL 形式は**実機で確認済み**:
  `<createURL(app/<app>/search)>?q=<SPL>&earliest=..&latest=..`
  → サーチバーに入りそのまま実行される（生成系 `| makeresults` も可）。
  ロケール接頭辞は自分で書かず **`createURL`** に付けさせる
- 生成系以外は `search ` を前置しないと検索にならない
- CSV はクライアント側で生成（サーバに投げ直さない）
- ⚠ メニューは **`createPortal` で body に出す**（§8.z の理由）
- **全画面表示も同じくポータルで出す**（2026-08-11 に実装し直し）。
  グリッド内で `position:fixed` にするだけでは**隅に潰れて全画面にならない**
  ことを実機で確認した。詳細と直し方は §8.z の追記を参照。
  Esc と ✕ ボタンの両方で戻れる（メニューからしか入れないため出口を明示する）

### 6.8.5 命名の方針（2026-08-11 見直し）

**社内語・略語を UI に出さない。** 「NOC 枠」は*ジャンル名*であって形の説明ではないので、
**「コーナーフレーム」**（＝四隅のカギ括弧）に改めた。あわせて viz 名の粒度も揃えた:

| 旧 | 新 |
|---|---|
| NOC 枠（四隅のカギ括弧） | **コーナーフレーム** |
| 矩形 / 線 / 矢印 / グロー（面） | 長方形 / 直線・矢印 / グラデーション面 |
| ライン / エリア | 折れ線・エリア |
| バー | 棒グラフ |
| ビッグナンバー | 単一値 |
| ステータスタイル | ステータス一覧 |
| テキスト | テキストラベル |

⚠ **スキーマ上のキー（`noc` / `shape.nocFrame` 等）は変えない。**
変えると既存ダッシュボードの `style.variant` / `viz` が解決できなくなる。
**表示名だけ**を変える。

### 6.8.6 編集の操作性（2026-08-11 追加）

| 操作 | 内容 |
|---|---|
| **Ctrl/⌘ + D** | 選択パネルを複製（右に空きがあれば右、無ければ真下） |
| **矢印キー** | 選択パネルを1マスずつ移動 |
| **Shift + 矢印** | 選択パネルをリサイズ |
| **Delete / Backspace** | 選択パネルを削除 |
| **Ctrl/⌘ + S** | 保存 |
| **Ctrl/⌘ + Z / Shift+Z / Y** | undo / redo |
| **Esc** | 選択解除 |

⚠ **入力欄にフォーカスがあるときは全部無効にする。**
SPL を打っている最中に Delete でパネルが消えたら事故になる
（`INPUT` / `TEXTAREA` / `contentEditable` を判定して素通しする）。

#### 6.8.6b 編集履歴（`engine/history.js`）★2026-08-12 全面改修

**「あらゆる操作を戻せる」「戻しきったら保存ボタンを押せなくする」**を成立させる仕組み。

**設計の要点**（どれも実機で踏んだ不具合の対策）:

| 決めたこと | 理由（踏んだ不具合） |
|---|---|
| **編集は必ず `edit(fn, key)` を通す**（`setDef` を直接呼ばない） | 履歴に載らない操作が生まれる。実際に「ソースタブの直接編集」「ドラッグ」が抜けていた |
| **「変更前」は `setDef` の更新関数の中で掴む** | 外側で `pushHistory(def)` すると**レンダー時のクロージャの古い値**が積まれ、1レンダーに2回編集すると Ctrl+Z が**2手前に飛ぶ** |
| **`dirty` は state で持たず、`base` との内容比較で導出** | undo で戻しきっても `dirty=true` のままになる。カウンタ方式は「変えて元に戻す」で壊れる |
| 比較は**キーをソートした直列化** | 参照比較だと undo は必ず別オブジェクトなので常に dirty。素の `JSON.stringify` はキー順の違いで誤検出 |
| ⭐ **書き込むタイミングを絞る**（v1.5.1 / v1.5.2） | **これが本筋**。ドラッグ中の座標も打鍵中の文字列も「**一時的な表示状態**」であって保存対象ではない。中間状態を定義に書くから履歴が埋まり、それを「まとめキー」で無かったことにする対症療法が要っていた。**確定時に1回だけ書く**ようにすれば、**JSON の変化＝1操作**が自然に成立する。ドラッグ＝`pointerup`（v1.5.1）、テキスト欄＝`blur`/Enter（v1.5.2） |
| 連続した同種操作は1手にまとめる（`coalesceKey`） | ⚠ **ドラッグにもテキスト欄にも不要になった**（上記で解決）。残るのは**確定点を決められない入力**だけ＝スライダー・数値欄・矢印キー連打・ソースタブの JSON 直接編集 |
| まとめキーは **patch の形から自動判定**（`coalesceKeyFor`） | インスペクタの入力は ~100 箇所。手で配ると必ず漏れる。「文字列/数値を1つだけ変える patch」だけまとめ、**真偽値・複数キー・構造変更はまとめない** |
| **undo/redo は `setHistory` を正として `setDef` を流し込む** | ⚠ **`setDef` の中で `setHistory` の結果を外の変数に書き戻すと古い値が返る**（React は更新関数を即時に走らせない）。矢印キーの移動が戻らない不具合として実機に出た |

```js
// ✗ 動かない（applied は setDef が返る時点でまだ古い）
setDef((d) => { let applied = d; setHistory((h) => { applied = undoHistory(h, d).definition; … }); return applied; });
// ✓ 正しい
setHistory((h) => { const r = undoHistory(h, defRef.current); if (!r) return h; setDef(r.definition); return r.history; });
```

**ドラッグ中のプレビュー**（`applyLayoutPreview` / `engine/groups.js`）:

掴んでいる間は `layoutPreview` state で**見た目だけ**差し替え、`pointerup` で1回だけ `edit()` を呼ぶ。

- ⚠ **区画の枠もこのプレビューを通す。** パネルだけ差し替えると、
  ドラッグ中に**枠だけ元の位置に取り残される**（区画は所属パネルの外接矩形で描くため）。
  → `allPanels` の生成時に一度だけ適用し、パネルと区画の両方が同じ値を見るようにする。
- ⚠ **クランプは区画全体で判定する**（プレビュー側でも）。メンバーごとに丸めると
  端に当たった1枚だけ止まって**形が崩れる**。
- **確かめ方**: ドラッグ中に「絵が動いている」かつ「保存ボタンが押せない」なら正しい
  （＝描画は追従し、定義は書いていない）。**この2つを同時に見るのが決め手**で、
  片方だけだと「動くが毎フレーム書いている」「書いてないが絵も動かない」を見分けられない。

**テキスト欄の確定**（`TextInput` / `engine/ui.jsx`・v1.5.2）:

打鍵中は内部の `draft` だけが変わり、**`blur` / Enter で1回だけ**親へ通知する。

- ⚠ **Escape 直後の `blur` では確定しない。** Escape は `setDraft` で戻すが**非同期**なので、
  続けて走る `blur` が読む `e.target.value` には**まだ捨てたはずの文字列が入っている**。
  そのまま commit すると「Escape したのに書き込まれる」。→ ref の印で `blur` を1回だけ抑止する。
  **DOM の値を信じた結果の取りこぼし**で、実機 E2E でしか出なかった。
- ⚠ **変換確定の Enter で入力欄を抜けない。** `keydown` は `compositionend` より**先に来ることがある**
  ので、`composing` の ref だけでなく **`e.nativeEvent.isComposing`** も見る。
- **クリアボタン（✕）は押した時点で確定**（ボタンは「操作」なので即書いてよい）。
  ⚠ **Playwright の `fill('')` はこのボタンを押してしまう**ので、
  「打鍵中」を再現したい E2E では `Control+a` で全選択して上書きする（誤診の実例あり）。

**検証**: 単体 `apps/dpx/test/history.test.mjs` / `test/groups.test.mjs`、
実機 `tools/dashboard-loop/src/dp-undo-e2e.mjs` / `dp-dragpreview-e2e.mjs` / `dp-textcommit-e2e.mjs`
（**IME は CDP の `Input.imeSetComposition` で本物の変換を起こして確認する**。`type()` では再現できない）。

### 6.8.7 ドリルダウン（クリックで別画面へ）

`panel.onEvent.drilldown` で、パネルのクリックから任意の URL へ飛ばせる。

```jsonc
"onEvent": {
  "drilldown": {
    "enabled": true,
    "url": "app/search/search?q=search%20host%3D$click.value$",
    "newTab": true
  }
}
```

- **押した要素の値が `$click.<キー>$` で使える**（`$click.value$` / `$click.name$` 等）。
  ダッシュボードのトークン（`$env$` 等）も同じ URL 内で展開される
- 相対パスなら `createURL` でロケール接頭辞が付く。絶対 URL はそのまま
- 実機確認済み：バーをクリック →
  `…/app/search/search?q=search host=host-01` が新しいタブで開く

### 6.8.8 キオスク表示（壁掛け用）

表示モードで **K** を押すと、DPX のトップバーごと消して**中身だけ**にする
（`Esc` か画面右上の小さな ✕ で戻る）。

⚠ **抜け出せなくなる UI を作らない。** キーだけだと気づけないので、
薄く常設した ✕ ボタンを必ず残す（ホバーで濃くなる）。

### 6.8.8b ⭐ パネルのグループ（`groups`）★Studio では原理的に不可能

**複数のパネルを1つの区画としてくくり、区画名を与える**（v1.4.0 / 2026-08-12 実機確認済み）。
「箱が並んでいる」画面を「1枚の管制盤」に変えるための意匠。

**なぜ Studio にできないか**: パネルが iframe に隔離されているため、ホストは
**パネルとパネルの隙間に 1px も描けない**。DPX は全パネルが同じ CSS grid に
載っているので、**同じグリッドに背面レイヤ（`zIndex:0`）として敷く**だけで済む。

- 実装は **`engine/groups.js`（純粋関数・テスト付き）** と `DpxDashboard.jsx` の `GroupFrame`、
  意匠は `themes.js` の `groupSurface()`、編集 UI は `Inspector.jsx` の `GroupEditor`

**⭐⭐ 区画は「入れ物」であって飾りではない**（2026-08-12 ユーザー指摘で設計変更）。

初版は**枠がパネルの座標を追いかけるだけ**で、まとめて移動する手段が無かった。
それだと既存の図形（`shape.nocFrame`）を手で置くのと本質的な差が小さい。
**区画がパネルを従える**形にして初めて機能単位になる:

| 操作 | 実装 |
|---|---|
| **区画ごと移動** | 区画名をドラッグ／選択して矢印キー → `movePanelsBy()` |
| **区画ごと複製** | メンバーのパネルも複製して新区画へ。⚠ サーチ（`search.ref`）は**共有したまま**（データソースまで複製すると同じ SPL が増えて管理が破綻する） |

⚠ **クランプは「区画全体」で判定する**（最重要）。パネルごとに
`clamp(0, columns - w)` すると、**端に当たった1枚だけが止まって区画の形が崩れる**。
先に「全体で動ける量」を求めてから全員に同じ量を足す。
⚠ **ドラッグは「差分」を渡す**（累積ではない）。累積を渡すと二重に動く。
⚠ 検証で「枠が動いた」を見ても意味が無い（枠はメンバーの外接矩形なので、
パネルが動かなければ枠も動かない）。**パネルの座標を前後で比較する**。

**⭐ 区画は「パネル・入力」と並ぶ第3の選択対象**（2026-08-12 ユーザー指定で設計変更）。
編集 UI に**タイプが1つ増えた**形なので、選択の排他・Esc の解除・モード切替の解除を
**3種すべてに通す**こと（片方だけ直すと「パネルと区画が同時に選択中」になる）:

| 操作 | 置き場所 |
|---|---|
| 追加 | **ツールバーの区画ボタン**（`onAddGroup`）。⚠ **選択中のパネルを最初のメンバーにする**（空の区画は枠が出ず「追加したのに何も起きない」に見えるため） |
| 選択 | **キャンバスの区画見出しをクリック** → 右ペインが区画の設定に切り替わる |
| メンバーを入れる | **パネル側**の「スタイル → 所属する区画」。⚠ 区画側からパネル名の一覧を選ぶ形は**どれがどれか分からない**ので採らない |
| メンバーを外す | 区画側のメンバー一覧の「外す」 |
| 削除 | 区画側。⚠ **中のパネルは消えない**ことを確認ダイアログで明示する |

⚠ **枠は `pointerEvents:'none'` のままにし、見出しだけ `auto` に戻す**。
枠全体をクリック可能にすると**下のパネルが触れなくなる**。
⚠ 名前なしの区画は編集中だけ `（区画）` と出す（出さないと掴む場所が無く選べない）。
⚠ **`TextInput` は `type` 属性を持たない**（`.dpx-input`）。E2E で
`input[type="text"]` を使うと**1件も当たらない**（実機で判明）。
- **枠はメンバーの座標から計算する**（外接矩形）。`gridColumn`/`gridRow` に載せるので
  **パネルと同じ配置規則**を通り、パネルを動かせば追従する
  （図形 `shape.nocFrame` を手で合わせる方式と違い**ズレようがない**）
- ⚠ **`pointerEvents:'none'` 必須**。付けないと枠の上のクリックがパネルに届かない
- ⚠ **タブで絞る**（`groupTab`）。絞らないとタブを切り替えても枠だけ残る

⚠ **意匠で踏んだこと（すべて実機のスクリーンショットで判明）**:

| 判断 | 何が起きたか |
|---|---|
| **四隅のカギ括弧はグループに使えない** | パネルの `noc` 質感と**見分けが付かない**。腕の長さを変えても「括弧が並ぶ」だけで階層が読めない。→ **グループはパネルが持たない device を使う**（上辺の罫にした） |
| **見出しの地を塗って罫を切り欠かない** | 背景エフェクトの上で**「地色の板」が浮いて見える**。罫の上に直接置く方が静か |
| **見出しを `subColor` にさらに opacity を掛けない** | 壁面表示で**読めなくなる**（カギ括弧を 0.42→0.62 に上げたのと同じ話）。弱さは**字間と大きさ**で表し、色は落とさない |
| **上方向へ margin を広げない** | 最上段のグループの罫が**ダッシュボードのタイトルを横切る**。見出し付きグループが最上段にある時だけグリッド上部に隙間を作る |
| **区画は自分の見出しの居場所を持つ**（`GROUP_HEADER_H`） | 見出しを枠の**外**へ逃がすと、**区画の上辺とパネルの上端が同じ帯に重なる**。外へ出す限り上にあるものと必ず衝突する。帯を確保して**中に**置く |
| **下辺の返しは「水平の短い罫」** | 上辺の罫だけでは**区画の終わりが分からない**。⚠ 垂直線にすると**パネルのカギ括弧と見分けが付かない一塊**に見える。上辺と同じ語彙（水平）にする |
| **左右いっぱいに広げない** | 隣り合う区画の罫が突き当たって**1本に繋がり、2区画が1つに見える**。`gap/2` までに留めて切れ目を作る |

**⭐ 区画の質感は `panelSurface()` を流用する**（2026-08-12・ユーザー指定）。
区画専用の質感を別実装で持つと**質感を足すたびに2か所を直す**ことになり、必ず片方が古くなる。
`groupSurface()` は**区画固有の `rule` 以外を `panelSurface()` に委譲する**だけ。
選択肢の一覧も **`themes.js` の `PANEL_VARIANTS`**（1つの配列）をインスペクタが共有する
（以前は Inspector に20行ベタ書きで、「描画は対応したのに選べない」ズレが起きうる状態だった）。

⚠ **「CSS が同じ＝流用できる」ではない**（2026-08-12・ユーザーの問いで判明）。
`groupSurface()` は `panelSurface()` と**バイト単位で同じ値**を返すのに、
**`polaroid` / `punchCard` は実機で破綻していた**。どちらも「**中身がある箱**」前提の造りで、
中身を持たない区画（パネルの背面に敷く空の箱）では意図した絵にならない:
`polaroid` は白縁を `padding` で作るので**印画面がベタ塗りの明るい面**になってパネルを覆い、
`punchCard` は **濃い地がパネルの背面全体を覆う**。
→ `GROUP_INCOMPATIBLE_VARIANTS` で選択肢から外し、指定されても既定に落とす。
**JSON 比較のテストでは検出できない**（スクリーンショットで気づいた）。
質感を足すときは「**中身の有無に依存していないか**」を必ず見る。

⚠ **区画は `gap` の内側にしか広がれない**（2026-08-12・ユーザー指摘）。
パネルは元のサイズのまま動かないので、**区画が gap を超えると必ず外側のパネルと重なる**:

| 方向 | 何が起きていたか | 対処 |
|---|---|---|
| 下・左右 | 左右だけ `gap/2`、**下は生の `pad`** という非対称な実装で、下端の余白が **4px** しか残らず下のパネルのカギ括弧と重なった | **4辺すべて `groupInset()`（gap/2 − 1px）** に統一 |
| 上 | ヘッダ帯（18px）が gap（12px）を超え、**区画の真上にパネルがあると 6px 食い込む** | 最上段だけ帯ぶん伸ばし、途中の行は `inset` までに留める |

⚠ **区画名の字面も `panelTitleSkin` から導く**（`groupTitleStyle()`。2026-08-12・ユーザー指摘）。
区画だけ `fontSize:10` / 字間 / 大文字を決め打ちしていたため、
**パネルのタイトル質感（10種）を変えても区画名だけが取り残され**、
「文字が小さい」「質感が違う」状態になっていた。
既定は**メンバー先頭のパネルの質感**。大きさはパネルより 1px 小さいだけで、
**最小 10px** を下回らない。親であることは**字間と色**で示し、大きさで差を付けない。
→ **意匠を2か所に書かない**という同じ原則（`groupSurface` の流用と同じ）。

⭐ **区画の見出しは「行を確保して」置く**（2026-08-12・ユーザー指定で対応）。
最上段はグリッド上部の余白に置けるが、途中の行では上のパネルとの隙間が `gap` しか無く、
**どちらへ逃がしても重なる**（下＝メンバーのタイトル／上＝上のパネルへ 5px 食い込み）。
→ **区画が始まる行の手前に見出し用の細い行（`GROUP_HEADER_H`=18px）を挿し込む**
（`reserveHeaderRows()`）。その下のパネルは描画上1行ずつ下へずれる。実測で上17px・下15px。

⚠ **定義（`panel.y`）は書き換えない。** 描画時の行番号だけをずらす
（座標を書き換えると、区画を消したときに元の配置へ戻せない）。
⚠ **`gridAutoRows` では「見出し行だけ低く」ができない**（全行が同じ高さになる）。
見出し行があるときだけ **`gridTemplateRows` を明示**する。
⚠ 見出しを持たない区画・最上段の区画は行を取らない＝**既存ボードは間延びしない**。

🛑 **測る対象を間違えると数値は嘘をつく**（この件の最大の教訓）。
「区画の**箱**は 7px 空いている」と測って**直ったと誤判定した**が、
**見出しは `position:absolute` で箱の外に出る**ため実際には重なっていた。
ユーザーのスクリーンショットで発覚。**枠ではなく「実際に描かれる要素」の座標を測る**。

**新規作成でも移動でも同じ**（2026-08-12・ユーザーの確認要望で実測）。
配置の判定は `rect.y === 0`＝**メンバーの座標から毎回計算する**ので、
「作成直後か、後から動かしたか」に依存しない。矢印キーで区画を真下へ動かして 7px を実測。
⚠ 「隣り合う区画の罫が繋がる」だけを見て左右を直したときに**外側パネルを見落とした**。
**1方向だけ直したら、残り3方向も同じ規則になっているか確かめる**。

⚠ **流用で踏んだ罠（実際に発生させた）**: `panelSurface` は「線なし」を
**`border: 'none'`（truthy な文字列）**で表す。色を差し替えるときに素朴な
`if (s.border) s.border = ...` を書くと、**コーナーフレームに全周の枠が生え、
枠なし（frameless）にも枠が付く**。`none` を除外し、**線幅と種別は元のまま色だけ**入れ替える。
見た目では気づきにくいので `test/groupSurface.test.mjs` で文字列比較して固定する。

⚠ **意匠の粗は全画面のスクリーンショットでは見えない。**
1600x1000 の全体像で「直った」ように見えた重なりが、**2x 拡大では残っていた**（2026-08-12）。
`dp-zoom.mjs`（deviceScaleFactor=2 ＋ clip で四隅を切り出す）で確認すること。

⚠ **枠のズレは目視で気づけない**（1マスずれてもそれらしく見える）。
`test/groups.test.mjs` で外接矩形を数値で押さえる。
⚠ **ライト系プリセット（`paper` 等）でも必ず撮る**。決め打ち色の混入はここで出る。

### 6.8.85 ⭐ 時間ブラシ（クロスパネル）★Studio では原理的に不可能

**折れ線の上を横にドラッグすると、選んだ区間がダッシュボード全体の時間範囲になる**
（v1.3.0 / 2026-08-12 実機確認済み）。時間範囲入力のトークンを書き換えるので、
**その入力を参照している全パネルが同時に追従する**。

**なぜ Studio にできないか**: パネルが iframe に隔離されており、パネル内の
ドラッグ座標をホストの時間ピッカーへ渡せない（トークン書き込みは合成クリック経由の
裏技しかなく、**ドラッグの連続値は流せない**）。DPX は全パネルが同一 React ツリーに
いるので `TokenProvider` を直接叩ける。

```
dpx.line（ドラッグ）→ onEventTrigger({type:'time.brush', payload:{earliest,latest}})
   → Panel が resolveBrushToken() で書き込み先を決める
   → setTokens({ '<token>.earliest': …, '<token>.latest': … })
   → その入力を参照する全パネルが再サーチ
```

- 実装は **`engine/timeBrush.js`（純粋関数・テスト付き）** と `nativeViz.jsx` の `DpxLine`、
  書き込みは `DpxDashboard.jsx` の `onEventTrigger` 先頭（`type === 'time.brush'`）
- **書き込み先は時間範囲入力のトークン**。パネル固有の earliest/latest を直接書くと
  「そのパネルだけ期間が変わる」ことになり、**全体に効く**という肝心の価値が消える
- 出す条件を厳しくしている（**ドラッグできるのに何も起きないのが最悪の UI**）:
  (1) X 軸が時刻として読める (2) 書き込み先の時間範囲入力がある (3) 表示モード
- **1バケット以上動いたときだけ**範囲にする（ただのクリックで絞られる事故を防ぐ）
- **戻り道を必ず用意する**（入力バーの「絞り込みを戻す」＝`undoTokens`）。
  絞る操作は必ず「絞りすぎ」を起こすので、1手で戻せないと時間ピッカーを
  手で打ち直すことになりブラシの利点が消える（キオスクの ✕ と同じ原則）

⚠ **実装で踏んだ罠（すべて実機で確定）**:

| 罠 | 症状 | 対処 |
|---|---|---|
| **右端バケットの解釈** | `timechart` の点は「バケットの**開始**時刻」。`latest` を `times[hi]` にすると**選んだ山のてっぺんが再サーチ後に消える** | 右端は**次のバケットの開始**まで含める。最終バケットは直前の間隔を足して補う |
| **タイムゾーン** | `toISOString()` で書くと UTC になり **JST では9時間ずれる** | ローカルの年月日時分秒をそのまま組み立てる（`toSplunkTime`） |
| **`Math.max(0, Math.min(n-1, NaN))` は NaN** | 丸めたつもりで NaN が素通りし `times[NaN]` で落ちる | 数値でないものは**丸める前に**弾く（テストで検出） |
| **ブラシが系列固定を誘発** | ドラッグは線の上を通るので、掴んだ瞬間に「その系列に固定」が効き、**絞り込み後も他系列が減光したまま** | ドラッグ開始で `setHoverSeries(null)`、確定直後の `click` を1回捨てる |
| **ポインタ捕捉なし** | パネル外へ出た瞬間に `pointermove` が来なくなり**選択帯が固まる** | `setPointerCapture` |
| **軸ラベルが文字選択される** | 横ドラッグはブラウザから見れば「文字の範囲選択」。軸ラベルが**青く反転してコピー状態**になる（ユーザー報告で発覚。自分のスクショにも写っていたのに見落とした） | `user-select:none` ＋ `pointerdown` の `preventDefault()` ＋ 確定時の `removeAllRanges()`。**CSS だけだと既に始まっていた選択が残る** |

⚠ **検証の落とし穴（実際に見逃した）**:
**「別パネルの表が変わったか」だけを見る判定は当てにならない。**
`makeresults` はサーチの度に値が変わるので、**期間が絞られていなくてもテキストが変わる**。
これで E2E が全項目 ✓ になったが、**スクリーンショットを見たら X 軸が 24 時間のまま**だった。
→ **X 軸ラベルの変化を正とする**（`dp-brush-e2e.mjs` に追加済み）。
そもそも**検証用の SPL が時間範囲を無視していた**のが原因で、
`| makeresults` で `now()` から `_time` を作ると**どの期間で実行しても同じデータ**が出る。
**`addinfo` の `info_min_time` / `info_max_time` から `_time` を作る**と
期間に追従するデータになる（これも実機で確認）。
→ **「時間で絞る機能」を検証するときは、まず検証データが時間に反応するかを確かめる。**

### 6.8.9 ⭐ 編集モードで viz 自身にポインタを渡す（`canvasEdit`）★Studio では不可能

**Studio 拡張 viz は編集モード中にドラッグ編集ができない**。パネルが iframe に隔離され、
ホストがポインタ入力をパネル選択に使ってしまうため（link-line が「表示モードで
線を整える」設計になっているのはこの制約が理由）。

**DPX では可能**（2026-08-12 実機で永続化まで確認）。ただし**2か所の壁**がある:

| 壁 | 症状 | 対処 |
|---|---|---|
| **編集モードの移動用オーバーレイ** | `DpxDashboard` が `position:absolute; inset:0` の div を viz の**上に**敷いており、viz のハンドルにポインタが**一切届かない** | `Viz.config.canvasEdit = true` を宣言した viz には**敷かない**。パネル移動はタイトルバー（タイトル非表示なら上端 10px の帯）で行う |
| **`onOptionsChange` が空実装だった** | `() => {}` が渡っていたため、viz からの書き戻しが**黙って捨てられる**。viz 側は保存された前提で描き続けるので**「動くのに保存されない」** | `onPatchPanel(panel.id, { options: {...} })` に接続（v1.2.0 で修正済み） |

```jsx
MyViz.config = { key: 'my.viz', canvasEdit: true, /* … */ };
// ハンドル側では必ず stopPropagation する（親の onSelect でパネル選択が動くため）
<circle onPointerDown={(e) => { e.stopPropagation(); setDragging(i); }} />
```

- **キャンバスで決まる値（点列・ラベル位置）は `optionsSchema` に載せない。**
  載せると編集パネルに JSON 欄が出るだけ。**スキーマ外のキーも定義に保存され viz に届く**
- ⚠ **`optionsSchema` の `default` は viz に届かない**（Inspector が表示に使うだけで
  options にマージされない）。「未設定なら既定で色分け」は**viz 側で自分でフォールバックする**。
  これを怠ると、置いた直後の viz が一律アクセント色になり「値で色が変わらない」と見える（実機で踏んだ）
- ⚠ **共通の既定パレット `trafficDark` は「低い値ほど赤」**（スコア向け）。
  遅延・エラー率のような **low=good の指標では good/bad が逆**になる。実機で 12ms が赤・
  95ms が緑になって発覚した。用途に合う並びを viz 側の既定で持つこと
- **E2E でパネルを狙えるように `data-panel-id` / `data-viz` が付いている**。
  これが無いと「ページ全体から `circle` を拾って別パネルを掴む」取り違えが起きる（実際に踏んだ）。
  ⚠ 画面外の要素は `scrollIntoViewIfNeeded()` してから掴む（mouse.move はビューポート座標）
- 検証は `tools/dashboard-loop/src/dp-linkline-e2e.mjs`（ドラッグ→保存→REST で永続化確認）

### 6.9 図形（★Studio に無い）

`shape.rect` / `shape.ellipse` / `shape.line`（矢印つき）/ `shape.glow`（グラデ面）/
**`shape.nocFrame`（NOC 枠）**。
**パネルの背面に敷いて構図を作る**ためのもので、データを読まない（サーチ不要）。
使い方は「質感＝枠なし（frameless）＋ `style.z` を小さく」。

⚠ 図形の SVG は **`overflow: hidden` が既定**。グロー（面）がはみ出すと
パネルの外まで光が漏れて構図が崩れる（実機で確認）。
端を出したい線／矢印だけ `overflow="visible"` を明示している。

**`shape.nocFrame`（2026-08-11 追加）＝ パネル質感 `noc` と同じ意匠の図形版。**
カスタム viz（world-map 等）は自前の背景・角丸を持つため、パネル質感を `noc` にしても
**枠だけ浮いて見える**ことがある。そのときは:
1. viz のパネルを**質感＝枠なし（frameless）**にする
2. **同じ位置・サイズに `shape.nocFrame` を置き、`style.z` を viz より小さく**する
→ 枠は図形が描き、viz は中身だけを描くので**意匠が揃う**（実機で描画確認済み）。
見出し（`label`）も枠の左上に出せる。

⚠ **SVG の `x1/y1/x2/y2` に `calc()` は使えない**（HTML/CSS 専用）。
`%` と `px` を混ぜた座標が要るので、**ResizeObserver で実寸を測って px で引く**。
（`<rect>`/`<ellipse>` の `width`/`height` は CSS 値が使えるので既存図形は calc のままでよい）

---

## 7. ネイティブ viz スイート（`nativeViz.jsx` / `decoViz.jsx`）

| key | 名前 | データ規約 | 主なインタラクション |
|---|---|---|---|
| `dpx.line` | ライン / エリア | 1列目=X、2列目以降=数値系列 | クロスヘア＋全系列ツールチップ、**系列ホバーでフォーカス（他を減光・対象を発光）**、凡例クリックでピン固定、描画アニメ、なめらか曲線 |
| `dpx.bar` | バー | 1列目=ラベル、2列目=値 | ホバーで強調＋他を減光、値ツールチップ、クリックでトークン、伸びるアニメ |
| `dpx.value` | ビッグナンバー | 最初の数値列 | カウントアップ、前回比 ▲▼%、スパークライン＋末端パルス |
| `dpx.status` | ステータスタイル | 1列目=名前、2列目=状態、3列目=補足 | ホバーで浮き上がり、状態ドットのパルス、クリックでトークン |
| `dpx.ranking` | ランキング（横棒） | 1列目=ラベル、2列目=値 | 上位 N 件を順位つきで。**ラベルが長いときは縦棒より読める** |
| `dpx.donut` | ドーナツ（構成比） | 1列目=ラベル、2列目=値 | 中央に合計、ホバーで割合、凡例（実数/割合を切替）、クリックでトークン |
| `dpx.table` | テーブル | 全列 | **ヘッダで並び替え**（昇順→降順→解除）、**値による色分け**（文字/セル/行）、**絞り込み**、**合計行**、数値書式、値バー、行クリックでトークン |
| `dpx.linkLine` | コネクタ線 | 値列の最終行（シングルバリュー） | **編集モードでキャンバスをドラッグして整形**（点移動・＋で折れ点追加・ダブルクリックで削除・ラベル移動）。値→色の3モード、質感4種、流れアニメ。データ無しは N/A グレーで描き続ける |
| `deco.text` | テキスト | 不要 | `$トークン$` 展開・グロー |
| `deco.clock` | 時計 | 不要 | ライブ更新 |


⚠ **表の行を並べ替えるときは「行インデックスの配列」を作る。**
DPX のデータは**縦持ち**（`columns[列][行]`）なので、列配列そのものを
`sort()` すると列ごとにバラバラの順に崩れて**行が混ざる**。
`order = [0,1,2,…]` を作って**順序だけ**入れ替え、描画時に `cols[c][order[i]]` と引く。
合計・最大値も**絞り込み後の `order` を対象にする**（表示していない行を混ぜない）。

⚠ **ソートや絞り込みの state を持つ viz は、フックを early return より前に置く**（§8.1）。
`useState` / `useMemo` を「データが無いときの return」より後に書くと、
**データ到着の瞬間にフック数が変わって落ちる**。

### 7.1 描画の性能方針（[viz-performance.md](viz-performance.md) 準拠）

**やらないこと**: SVG フィルタ（`feGaussianBlur`）/ SMIL / 面積に比例する半透明の大きな塗り。
**やること**: グローは**太さ・不透明度の違う実線の重ね**と `box-shadow`、
動きは **transform / opacity / stroke-dashoffset** に限定、rAF は**遷移中だけ**回す。

---

## 8. 実装で踏んだ罠（再発防止・すべて実機で確定）

### 8.1 React フックのルール違反で**画面が白紙**になる ⚠最重要

**データ有無で early return する viz で、フックを return より後に置くと、
データ到着（なし→あり）の瞬間にフック数が変わって React がクラッシュし、画面が真っ白になる。**
**コンソールにエラーが出ないことがある**ため原因特定が遅れる（ユーザーの「詳細タブでエラー」が決定打だった）。

→ **全フックを early return より前に呼ぶ。** 監査は機械的にできる:

```bash
# 各 export function 内で「最初の return より後ろにフック呼び出しがないか」を検査
python3 - <<'EOF'
import re, pathlib
src = pathlib.Path('src/main/webapp/components/engine/nativeViz.jsx').read_text().split('\n')
funcs = [(i, l) for i, l in enumerate(src) if l.startswith('export function ')] + [(len(src), '')]
hook = re.compile(r'(use[A-Z]\w*|React\.use[A-Z]\w*)\(')
for k in range(len(funcs) - 1):
    s, e = funcs[k][0], funcs[k + 1][0]
    body = src[s:e]
    first_ret = next((j for j, l in enumerate(body) if re.match(r'\s+return ', l)), None)
    bad = [j + s + 1 for j, l in enumerate(body)
           if first_ret is not None and j > first_ret and hook.search(l) and 'function' not in l]
    print(funcs[k][1].split('(')[0], 'OK' if not bad else f'NG {bad[:3]}')
EOF
```

### 8.2 自前ドロップダウンで「選んでも値が変わらない」

ポップアップを `position: fixed` で出すと **DOM 上はトリガーの外**。
外側クリック判定（capture の pointerdown）が**項目クリックを外側と誤判定して先に閉じる**。
→ **ポップアップにも ref を持たせて除外**する（scroll の自動クローズも同様）。

### 8.3 チャートが既定幅（600px）のまま固まる

データ到着前に「データなし」を early return する viz では、**mount 時 effect の ref がまだ null**で
ResizeObserver の観測が永久に始まらない。→ **callback ref で観測を開始する**。

### 8.4 `makeresults format=csv` はフィールドがアルファベット順

列順に規約のある viz（status など）に渡すときは **`| table` で順序を固定**する。
さらに **`useSplunkSearch` は SPL 末尾の `| table` / `| fields` 句の順序を正とする**
（応答の `fields` 配列・行キー順に依存しない）。

**⚠ これは「一部の viz の話」ではない。ほぼ全 viz に効く**（2026-08-11 に再度踏んだ）。
多くの viz は **値列の既定を「最終列」** にしている（`resolveFieldIndex(opts.valueField,
fieldNames, rows, colCount - 1)` が定型）。したがって:

- `| table` を書かないと **アルファベット順の最終列が値として読まれる**。
  実例: `data="log_level,count"` → 実際は `count,log_level` の順で届き、
  **`log_level`（文字列）を値と解釈して「数値データが見つかりません」**（donut-graph / gauge-arc で発生）
- 汎用の SPL を作って全 viz に流すのも同じ罠。**最終列を `_time` にすると軒並み空になる**
  （検証ダッシュボードでこれをやって kpi-tile / icon-status / gauge-arc が全滅した）
- → **検証用ダッシュボードは「各 viz の README のサンプル SPL」を使う**のが正解。
  README から機械抽出でき、`| table` が無いものだけ CSV ヘッダ順で補えばよい

**⚠ サーチ不要の viz にサーチを付けない**：`config.json` の `dataContract` が
`requiredDataSources: []` かつ `optionalDataSources: []` の viz（tab-selector 等）は
**オプションだけで描画する**。README のサンプル SPL は「その viz が設定するトークンを
受ける“下流パネル”の例」であることがあり、それを本人に食わせると
`トークン待ち: $region$` で止まる（実際に踏んだ）。**README の SPL を機械適用する前に
dataContract を見る。**

### 8.4.1 SPL が **HTTP 200 のまま 0 行**を返す2つの罠（2026-08-11 実機）

どちらも**エラーにならない**ので、画面には「データがありません」だけが出て原因が見えない。
`| table` の罠（§8.4）と違い、**行そのものが返らない**。

1. **CSV の改行を `\n` の2文字で書いた**
   JSON 定義を生成するスクリプトで `"...\\n..."` と書くと、SPL には
   **リテラルのバックスラッシュ+n** が渡り、CSV 全体が**1行**になる。
   → 定義ファイルには**本物の改行**を入れる。`JSON.stringify(spl)` で
   `\\n` になっていないか目視するのが早い。
2. **`eval` で日本語のフィールド名を裸で参照した**
   `| eval 未達率 = round(100 - 達成率, 2)` は **200 で 0 行**。
   `'達成率'` と**単引用符で囲む**と通る（`| eval 未達率 = round(100 - '達成率', 2)`）。
   §8.4 の `| table 送信元 件数` は**引用符不要**なので、
   「日本語フィールドはそのまま書ける」と勘違いしやすい。**eval の中だけ別扱い**。

→ **ダッシュボードを push する前に、全データソースの SPL を
`search/jobs/export` に投げて「行数 > 0」を確認する。** 描画を見て切り分けるより速い。
`(t.match(/"result"/g)||[]).length` で行数が取れる。

### 8.4.2 ⚠ `exec_mode=blocking` を使わない（Studio に合わせる）★実機で確定

**症状**: リバースプロキシ（Cloudflare トンネル）越しにダッシュボードを開くと、
一部のパネルが **`[object Response]`** になって描画されない。**IP 直では出ない**。
しかも**落ちるパネルが毎回変わる**（2026-08-12 実機で再現・原因確定）。

**原因は3層あり、どれも「Cloudflare のせい」ではない**:

| 層 | 事実 |
|---|---|
| 表示 | `handleResponse` は**生の `Response` を reject する**（`Error` ではない）。受け側の `String(err?.message ?? err)` が `[object Response]` になる |
| 直接原因 | `exec_mode=blocking` が**ジョブ完了まで HTTP 接続を握る**ので同時実行ジョブが並走し、`srchJobsQuota`（既定10）超過で **HTTP 503** |
| 露出条件 | HTTP/1.1 は**1オリジン同時6接続**でブラウザが偶然スロットリングしていた。トンネルは **h3/HTTP/2 で多重化**が効き、12本が一斉到達して上限に届く |

**Studio はどうしているか（実機で POST body を観測）**:
```
output_mode=json / preview=true / search=... / sid= / check_risky_command=true
label=<dsName> / provenance=UI:dashboard:<name>
```
**`exec_mode` を送っていない**。標準 Studio ダッシュボードは 12 パネルを **19ms 以内に
一斉ディスパッチしても 503 が出ない**（同じ実機・同じ h3）。
**キューで絞っているのではなく、blocking を使っていないから**。

**実測（同一実機・同時12本・同じ URL）**:

| 条件 | 結果 |
|---|---|
| `exec_mode=blocking` | 201×10 / **503×2** |
| `exec_mode` 指定なし（Studio 相当） | **201×12** |
| トンネル h3 のまま `--disable-http2` | **201×12**（多重化を切ると露出しない） |

→ **非ブロッキングで投げ、`dispatchState` を 250ms 間隔でポーリングして完了を待つ**
（`waitForJob()` in `useSplunkSearch.js`）。`FAILED` は `messages[]` から理由を取り出して throw。

⚠ **`handleResponse` は必ず `handleError` と対で使う。**
Splunk 自身の `splunk-utils/search.js` が全箇所でそうしている:
```js
.then(handleResponse(201))
.catch(handleError('サーチジョブの作成に失敗しました'))  // ← messages[].text を本物の Error にする
```
片方だけだと**サーバがちゃんと返している理由を捨てて** `[object Response]` になる。

**教訓**:
- **「プロキシ経由でだけ壊れる」はプロキシが原因とは限らない。**
  多重化で並列度が上がり、**元からあった上限違反が見えるようになっただけ**だった
- **推測を3回外した**: ①CSRF のポート依存（実機では `MRSPARKLE_PORT_NUMBER` は
  トンネルでも 8000 のままで無罪）②RTT が長いから滞留（実測 71ms vs 61ms で
  説明がつかない）③クライアント側キューが要る（**Studio は queue を持っていない**）。
  **標準実装が何を送っているかを最初に見るべきだった**

### 8.5 その他

- **ビルドは `NODE_OPTIONS=--max-old-space-size=8192` が必須**（terser の worker が OOM）
- **`stage/` はビルド間で残骸が残る** → `rm -rf stage` してから package する
- **REST の POST/DELETE にも `?output_mode=json` を付ける**
  （付けないと XML が返り `handleResponse(200)` が落ちる＝保存成功なのに失敗表示）
- **アプリ共有オブジェクトの更新先 owner は状況で変わる** → `[username, 'nobody']` を順に試す
- **「直したのに直らない」の正体がビュー再作成の空振り**だったことがある
  → **保存された実体を REST で読んで検証**してから悩む
- **ラベル文字列に全角スペースが混入**すると Playwright の完全一致セレクタが外れる

---

### 8.x 白フラッシュ（画面が一瞬まっ白になる）— 原因は2つある

**片方だけ直しても消えない**（2026-08-10 に実機で計測して確定）。

1. **JS が動く前にブラウザが塗る「地」が白い**
   → **Mako テンプレートの `<style>` で `html, body` を暗くする**。React では間に合わない。
   ⚠ **`!important` が要る**。Splunk Web の共通 CSS が後から読み込まれて body を
   `rgb(242,244,245)` に上書きする（**600ms 時点で反転するのを実測**）。
   併せて起動スプラッシュ `#dpx-boot` を Mako 側に置き、ランタイムが準備できたら消す。
2. **モード切替でページを再読込していた**
   → `location.href` の書き換えをやめ、**mode を state で持って History API で URL を追随**させる。
   DPX は表示/編集が同じ React ツリーなので再読込は不要（**Studio と違ってここが自由**）。
   `popstate` で戻る/進むにも追随させること。

### 8.y 線グラフの線が途中で切れる（描き込みアニメの後始末）

`stroke-dasharray` を**設定したまま放置すると、後からパネル幅が変わったときに
「古い長さの破線」が線を途中で切る**。塗り（area）は dasharray の影響を受けないため、
**線だけが途中で消えて塗りは端まで続く**という紛らわしい絵になる。

- 実測: `getTotalLength()=1717` に対し `strokeDasharray=1220.47px` が残っていた
  （ResizeObserver で後から広がったぶんズレた）
- 対策: `animationend` で `strokeDasharray` / `strokeDashoffset` / `animation` を**必ず捨てる**。
  アニメが走らない場合（タブ非表示など）に備えて `setTimeout` の保険も置く
- 共通ヘルパは `vizKit.jsx` の **`applyDrawIn(pathEl, enabled, delaySec)`**（ref に渡す）

---

### 8.z position:fixed が効かない（DOM に在るのに画面に出ない）

**祖先に `transform` が掛かっていると `position: fixed` はビューポートではなく
その祖先を基準に解決される**（CSS 仕様）。さらに祖先の `overflow: hidden` で
切り取られると、**DOM には存在するのに画面には出ない**という紛らわしい状態になる。

- 2026-08-10 に右クリックメニューで発生。`document.body.innerText` には項目が
  含まれるのにスクリーンショットには写らない、で気づいた
- パネルは出現アニメ（`animation`）等で transform が付くため、**パネル内から
  出すオーバーレイは全部これを踏む**
- **対策は `createPortal(..., document.body)`**。位置計算（fixed + clientX/Y）は
  そのままでよい
- 同種のバグの見つけ方: 「見えない要素」の祖先を辿って
  `overflow !== visible` / `transform !== none` の要素を列挙する

**2026-08-11 追記：全画面表示も同じ罠を踏んだ。**
グリッド項目に `position: fixed; inset: 12` を付けるだけでは全画面にならない。
実機では**パネルが隅に潰れた**（115x75px）。理由は2つ:
1. グリッド項目のままなので shrink-wrap されて内容サイズに縮む
2. 祖先の transform で fixed がビューポート基準にならず、スクロール枠に切られる

→ **`createPortal(..., document.body)` で DOM ごと外に出す**。あわせて:
- 全画面中は `gridColumn` / `gridRow` を**付けない**（付けると再びグリッド項目になる）
- **中身の高さはビューポートから逆算する**（`panel.h * rowHeight` のままだと
  枠だけ広がって中身が元サイズで残る）。viz には数値の height が要る
- 全画面中は entrance アニメと `style.rotate` を無効化する（transform を作らない）

### 8.hh スプラッシュの文字サイズが途中で変わる（Webフォントの遅延）

起動スプラッシュの「DPX」が**読み込み途中でサイズ（字形）が変わる**
（2026-08-11 実機・ユーザー報告）。

計測すると **0〜101ms は `Times New Roman`、110ms で `Splunk Platform Sans` に切替**。
`font-size` は 22px のまま変わらないが、**字形と字幅が変わるので「サイズが変わった」ように見える**。

→ **スプラッシュに Webフォントを使わない。** 一瞬しか出ない画面なので、
最初から確実にあるシステムフォント（`-apple-system` 等）だけで描く。
`@font-face` の `font-display` は Splunk 側の定義なので**こちらからは制御できない**。

⚠ **Mako 側と React 側で同じフォント指定にする**（片方だけ変えると入れ替わりで見た目が動く）。

### 8.gg 図形パネルに既定の枠を付けると枠が二重になる

コーナーフレーム図形を置くと、**図形自身の括弧＋パネル質感の括弧で二重**になった
（2026-08-11 実機・ユーザー報告）。パネルの既定質感を `noc` にしたとき、
図形・装飾にも一律で適用してしまったのが原因。

→ **既定質感は viz のカテゴリで決める**（`defaultVariantFor()`）。
`shape` / `deco` は **`frameless`**（図形は「絵そのもの」なのでパネル側の装飾を載せない）。

⚠ あわせて**既定値の決定を1関数に集約した**。§8.dd と同じ轍
（描画側とインスペクタで別々にベタ書き）を踏まないため、
`DpxDashboard` も `Inspector` も同じ `defaultVariantFor()` を呼ぶ。

### 8.dd 「既定値」を2か所に書くと UI と実物がズレる

インスペクタの質感ドロップダウンが**「カード」を選択済みに見えるのに、
実際は NOC で描かれている**という食い違いが起きた（2026-08-11 実機）。

原因は単純で、**既定値が2か所にベタ書きされていた**:
- 描画側 `DpxDashboard`: `panel.style?.variant ?? 'noc'`
- インスペクタ `Select`: `p.style?.variant ?? 'card'` ← 既定を変えたとき直し忘れた

**未設定のオプションは「どちらが既定か」を両方が知っている必要がある**ので、
既定を変えるときは**同じキーを読んでいる場所を全部 grep する**（`?? '` で引く）。

### 8.ee カテゴリ順の `indexOf` は未知の値で -1 → 先頭に来る

viz ピッカーで**図形が一番上に出ていた**。並び順の配列に `'shape'` を
書き忘れていて、`CATEGORY_ORDER.indexOf('shape')` が **-1**（＝どれより小さい）
になっていたため。

→ **`indexOf` の結果をそのまま比較キーにしない。**
見つからない場合は末尾に送る `rank()` を通す:
```js
const rank = (c) => { const i = ORDER.indexOf(c ?? 'custom'); return i < 0 ? ORDER.length : i; };
```
並びは**データを見せるものが先、飾りは後**（chart → status → custom → deco → shape）。

### 8.ff 背の低いパネルでカギ括弧が「二重」に見える

高さ1行（約74px）のパネルで、**タイトルの上下に括弧が二重にあるように見える**
（2026-08-11 実機で再現）。実際は上下の括弧が近づきすぎているだけで、
要素は1組しかない（`backgroundImage` の `linear-gradient` を数えて確認）。

→ **腕の長さをパネル高に応じて詰める**（`bracketArmLength()`。パネル高の 1/6 を上限、最小 6px）。

⚠ この手の「二重に見える」は**要素を数えて確かめる**。
DOM を見ずに CSS を触ると、実在しない重複を探して時間を溶かす。

### 6.9 ⭐ SPL のシンタックスハイライトは「自前実装しない」（2026-08-11 実機確定）

**Splunk 本体のサーチバーと同じ実装がそのまま使える。**

| | 内容 |
|---|---|
| 使うもの | **`@splunk/react-search/components/Ace`**（Ace エディタ＋`ace/mode/spl`） |
| ライセンス | **Apache-2.0**（LICENSE 同梱）。ただしファイル冒頭は "SPLUNK CONFIDENTIAL" の定型ヘッダ ⇒ **`package.json` の `license` を見る**こと |
| 入手 | **`@splunk/dashboard` の依存で既に node_modules にある**（追加インストール不要） |
| モード | `ace/mode/spl` / `ace/mode/spl_highlight_rules` がバンドル内に実在（`grep 'ace/mode/'` で確認できる） |

**⚠ 踏んだ罠3つ（どれも「動いているのに正しくない」形で出る）**:

1. **`ed.setTheme('ace/theme/...')` は効かない。**
   Ace はテーマを**実行時に動的 import** しようとして
   `Unable to infer path to ace from script src` で失敗する。
   このとき **エディタは出るし、トークン分割も効くのに、色だけ全部黒**になる
   （実測: `distinctColors: 1` / `rgb(0,0,0)` / class は `ace_pipe` で正しい）。
   → **`.ace_command` 等の class に自前 CSS で色を当てる**。DPX のテーマにも合わせられる。
2. **既定では色がほとんど付かない。** SPL モードは
   **`new Mode(commandRules)` に渡された定義から動的にルールを生成する**設計で、
   何も渡さないと `pipe` と `quoted` しか色が付かない。
   形（バンドルを読んで判明）:
   `{ "<cmd>-command": { other:[], args:[], functions:[], keywords:[] } }`＋**`search-command` が開始状態**。
   ⚠ 4 キーとも**必ず配列**で渡す（`e.other.forEach` を無条件に呼ぶので欠けると落ちる）。
3. **コマンド一覧を手書きしない。** Splunk Web のサーチ画面が実際に叩いているのは
   **`configs/conf-searchbnf?count=0`**（ネットワークを観測して確認）。
   手元の実機で **560 スタンザ / `*-command` が 166 個**。
   これを読めば**その環境のカスタムコマンドまで色が付く**。
   ⚠ `count=0` が無いと既定 30 件で切られる。
   ⚠ 長い名前から先に並べる（`stats` が `eventstats` より先に当たると途中でマッチする）。

**⚠ 重いコンポーネントは必ずフォールバックを用意する。**
Ace は DOM を直接握るので、失敗したら**素の textarea に落とす**
（`getDerivedStateFromError` の境界）。**SPL が編集できない＝DPX が使えない**ため。
アンマウント時の `ed.destroy()` も必須（残すとダイアログを開くたびエディタが増える）。

**⚠ バンドルした OSS の条文を同梱する。** `src/main/resources/splunk/` に置けば
`.spl` にそのまま入る（`THIRD-PARTY-NOTICES.txt`）。

### 8.ss ⚠ 「固定ヘッダを不透明にする」と「ヘッダに色を付ける」は別物

v0.9.0 でスクロール時の透け（§8.mm）を直すために地を敷いたら、
**「カラム名に背景色が付いていて重い」**と指摘された（2026-08-11）。

- 透け対策に必要なのは **「不透明であること」だけ**で、**別の色である必要はない**
- → 地は **`panelBg` と同一の色**にする。見た目は「背景なし」のまま、
  スクロールした行はきちんと隠れる
  （実測: ヘッダの計算背景色 `rgb(12,20,36)` ＝ パネル地と同一、
  かつ `elementFromPoint` は `TH` を返す）
- **ヘッダらしさは色ではなく書体で出す**：小さめ・大文字・字間広め・少し太字＋下罫線。
  罫線もアクセント色ではなく中性色にする（並び替え中の列だけアクセント）

### 8.tt 入力コントロールが「安っぽい」ときに効いたもの

「浮いている / チープ」という指摘への対処（2026-08-11）。**色を増やすのではなく**:

- **内側の 1px ハイライト＋弱い落ち影**（`inset 0 1px 0 …` ＋ `0 1px 2px …`）で厚みを出す
- **hover / focus の状態差**を付ける（枠色＋リング）
- ⚠ **フォーカスリングは `outline` ではなく `box-shadow`**。
  `outline` は**角丸に沿わない**ので、丸角の入力欄で矩形がはみ出して余計に安く見える
- ⚠ **影を animate しない**（毎フレーム再描画）。`transition` は色・影の切り替えだけ。
  押した感触は `transform: translateY(1px)`（合成のみ）で出す

### 8.qq ⚠ `new Date(任意の文字列)` を日時判定に使わない

X 軸を「時刻軸かどうか」で分岐する実装で踏んだ（2026-08-11・テストで検出）。

```js
new Date('srv-web-01')   // → 2001-01-01（Invalid Date にならない！）
```

**ホスト名の軸が「1/1, 2/1, 3/1 …」に化ける。** `Number.isNaN(d.getTime())` の
ガードでは防げない（有効な Date が返るため）。
→ **先頭が `YYYY-MM-DD` / `YYYY/MM/DD` であることを正規表現で厳密に確かめてから** Date に渡す。

同種の罠: ISO 文字列を**先頭 N 文字で切り詰めると時刻が真っ先に消える**。
`2026-08-11T15:00:00` を10文字で切ると `2026-08-1…` になり、
**軸ラベルが全部同じ文字列**になる（実機で `allSame: true` のパネルが3枚）。
時刻軸は「切り詰め」ではなく**書式化**する（`15:00` ＋ 日付が変わる位置だけ `8/12`）。

### 8.rr ⚠ 追従するツールチップは「入る行数」を数えてから出す

10 系列の折れ線でツールチップがパネル下端を **20px はみ出し、隣のパネルに重なった**
（2026-08-11 実機で計測）。

- 位置のクランプ（`Math.min(y, height - boxH)`）**だけでは足りない**。
  そもそも入らない高さなら、どこに置いてもはみ出す
- → **高さから入る行数を逆算して打ち切り**、残りは「ほか N 件」と出す
- ⚠ **打ち切るなら並べ替える。** 値の大きい順にしないと、
  「たまたま後ろにいた重要な系列」が消える
- ⚠ **枠の固定高（padding/border/タイトル）を小さく見積もると、
  クランプをすり抜けて再びはみ出す**（16px 見積もり→実際 39px で 10px 超過）。
  見積もりに加えて **`maxHeight` でも止める**（二重の保険）
- 検証は**矩形の差**で見る: `tooltip.bottom - panel.bottom` が**負**であること

### 8.pp ⚠ flex の子は縮まない（`min-width: auto`）＝長い文字列が隣に重なる

**viz 選択画面でカスタム viz の名前が隣のカードに重なった**（2026-08-11 実機・実害）。

原因は CSS の仕様。**flex アイテムの `min-width` の初期値は `auto`**（`0` ではない）ので、
中身より小さくならない。`overflow:hidden` + `text-overflow:ellipsis` を
**子の span に付けても、親の flex アイテムが縮まなければ効かない**。

```jsx
<button style={{ display:'flex' }}>
  <Icon />
  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>   {/* ← これが必須 */}
    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{type}</span>
  </span>
</button>
```

- **省略指定は「はみ出しうる全ての行」に付ける。** 名前だけ付けて
  **type 行に付け忘れていた**のが今回の実害（`custom_viz_x.custom_viz_x` は非常に長い）
- 検出は**矩形で測る**（`span.right > button.right`）。
  目視だと「詰まっているだけ」に見えて見逃す

### 8.oo ⚠ 「意味を変えない整形」は必ずテストする（SPL の `|` 分割）

SPL をパイプで改行する整形機能で踏んだもの（2026-08-11）。

1. **素朴な `split('|')` は文字列リテラルを壊す。**
   `eval x="a|b"` や rex の `(?<a>x|y)` が普通に出てくる。
   壊れても画面上は「改行されただけ」に見えるので**目視では気づけない**
2. **冪等でないと押すたびに壊れる。** `buf = '| '` と空白を足したため、
   整形するたびインデントが1つ増えた（`| stats` → `|  stats` → `|   stats`）
3. ⚠ **テスト側が同じバグを持つと「正しい実装」を落とす。**
   期待値を `src.replace(/\s*\|\s*/g,' | ')` で作ったら、
   **その置換自身がリテラル内の `|` に空白を入れて** `"a|b"` → `"a | b"` になり、
   正しい実装の方が「不一致」と判定された。
   → 期待値は**素朴な変換で作らない**。トークン列の比較などに寄せる

`spl.js` / `test/spl.test.mjs` に隔離してある。**JSX ファイルに書くと
`node test/*.mjs` から import できずテストが書けない**ので、純粋関数は必ず `.js` へ。

### 8.mm ⚠ `position: sticky` のヘッダに行が透ける（`background: inherit` の罠）

**テーブルをスクロールするとカラム名と値が重なって読めない**（2026-08-11 実機・実害）。

原因は `<th>` の **`background: 'inherit'`**。親の `<tr>` は透明なので
**継承した計算値が `rgba(0,0,0,0)`** になり、`sticky` は効いているのに
**行がヘッダを突き抜けて見える**。

```js
// 実機の計測（修正前 → 修正後）
getComputedStyle(th).backgroundColor  // 'rgba(0, 0, 0, 0)' → 'rgb(13, 21, 38)'
document.elementFromPoint(x, y).tagName  // 'TD' → 'TH'
```

- **`sticky` を疑うと原因に辿り着けない**（position も top も正しい）。
  見るのは**計算後の背景色**と `elementFromPoint`
- 固定ヘッダ・固定フッタの地は**必ず不透明色**にする。
  `inherit` も `transparent` も、**半透明（`rgba(...,0.94)`）もダメ**
  （合計行が 0.94 で、実際に下の行が透けていた）
- パネルの質感は半透明でも、**表の固定部分だけは不透明**でよい
  （むしろそうしないと読めない）

### 8.nn ⚠ flex の `gap` 固定は「件数が増えるとバーが消える」

**棒グラフに 200 行を渡したらバーが1本も見えなくなった**（2026-08-11 実機・実害）。

`display:flex` + `gap: 8px` + 各バー `flex: 1` の構成だと、
**件数 × 8px が幅を食い尽くして `flex-basis` に回る幅が 0 になる**。

```js
// 実機計測（幅 ~1550px のパネル）
{ count: 171, minW: 0, maxW: 0, zeroWidth: 171 }   // 修正前：全部 0px
{ count: 171, minW: 6.06, maxW: 6.06, zeroWidth: 0 } // 修正後
```

- **画面上は「ラベルだけが重なって散らばっている」ように見える**ので、
  「ラベルの重なりの不具合」と誤診しやすい（実際そう見えた）
- 直し方は**間隔を幅から算出する**: `slot = 幅 / 件数` を先に決め、
  隙間は `min(slot * 0.18, 6)`、バーには**最低 1px を必ず残す**
- ⚠ **`.getBoundingClientRect().width` を測って確かめる。**
  「要素が 171 個ある」は「描かれている」の証明にならない
- 大量行の描画は**標準 viz に寄せる**のが正解（`splunk.column` は 200 行でも
  全部描き、**ラベルは間引き、値軸で大きさを読ませる**。実機で撮って確認した）

### 8.jj ⚠ CSS の `background`（一括）がパネルの枠を消す（最重要・実害）

**パネルの枠（コーナーフレーム）が丸ごと消える**不具合の真犯人（2026-08-11 実機で確定）。

`panelStyleOverrides()` が `style.bg` を **`background`（一括）** で書いていた。
一括プロパティは **`background-image` を `none` にリセットする**ので、
カギ括弧を描く `linear-gradient` 8枚が**全部消える**。

```js
// ✗ 枠が消える。transparent に限らず「どんな色でも」消える
if (style.bg) css.background = style.bg;
// ✓ 地の色だけ変えて、backgroundImage（＝枠）は残す
if (style.bg) css.backgroundColor = style.bg;
```

実測（Chromium）：`background` を後から書くと括弧の層が **8 → 0**。
`backgroundColor` なら **8 のまま**で地の色も変わる。

⚠ **「透明にすると消える」と早合点しない。** 発生条件は
**「背景色に何か値が入っていること」**だけ。ユーザーの「一度透明を解いて
再度透明にすると枠が無くなる」という報告は、**解除時に色が `style.bg` に
書き込まれ、それも一括プロパティなので枠が戻らない**ことの現れだった。

**この罠は DPX 内に3か所ある**（`panelSurface` の `noc` / `bracketSolid` は
対策済み、`panelStyleOverrides` が漏れていた）。
**`backgroundImage` を使う要素に後から色を足すときは必ず `backgroundColor`。**

**誤診の記録（同じ轍を踏まないために）**:
この不具合は**2回続けて誤診した**。1回目は「カギ括弧の色の透明化が原因」（v0.4.1）、
2回目は「SVG 図形の半ストローク欠けが原因」（v0.4.2）。どちらも実在する別の不具合で、
**ユーザーが見ていた症状の原因ではなかった**。
原因は、**ユーザーの設定（`style.bg` が入った状態）を一度も再現せずに**、
「透明」「テーマ切替」という言葉から犯人を推定したこと。
→ **まず定義（`eai:data` の JSON）を取得して、ユーザーの実際の設定を再現する。**
症状の再現より先に原因を探し始めない。

### 8.ii SVG の枠線が端で消える（半ストロークが `overflow:hidden` に削られる）

図形「コーナーフレーム」（`shape.nocFrame`）で、**右辺と下辺のカギ括弧4本が
完全に消えていた**（2026-08-11 実機。画素の輝度を測って確定：8本中4本が背景と同値）。

原因は **SVG の線が座標の「中心」に引かれる**こと。腕を箱の端ちょうど
（`x=W` / `y=H`）に置くと、**太さの半分が外にはみ出して `overflow:hidden` で削られる**。
1px 線なら残るのは 0.5px で、さらに `shapeRendering="crispEdges"` が
ピクセル境界に丸めて**完全に消す**。
**左辺・上辺（`x=0` / `y=0`）だけ生き残る**のは、内側の半分が箱に残るため
── この「片側だけ出る」非対称が最大の手がかり。

```jsx
// ✗ 端ちょうど。右辺・下辺が消える
const x1 = W - pad;
// ✓ 線の太さの半分だけ内側へ。ストローク全体が箱に収まる
const half = strokeWidth / 2;
const x1 = W - pad - half;
```

⚠ **`crispEdges` は併用しない。** 内寄せをピクセル境界に丸め戻して端に返してしまう。
⚠ 同じ罠は `<rect>`/`<ellipse>` にもあるが、**`ShapeRect`/`ShapeEllipse` は既に
半分ぶん内寄せ済み**（`inset = strokeWidth / 2`）。新しい図形を足すときも同じ形にする。

**⚠ 「コーナーフレーム」は実装が2つある（誤診の温床）**:

| 呼び名 | 実体 | 描き方 |
|---|---|---|
| パネルの**質感** | `style.variant = 'noc'`（`panelSurface`） | CSS `linear-gradient` 8枚 |
| **図形パネル** | `viz = 'shape.nocFrame'`（`shapeViz.jsx`） | SVG `<line>` 8本 |

今回壊れていたのは**後者だけ**。前者は正常だったのに、名前が同じなので
「テーマ／質感のせい」と誤診しかけた。**枠の不具合を見たら、まずどちらの実装かを
DOM で確かめる**（`<line>` が8本あれば図形、`backgroundImage` が8層なら質感）。

### 8.aa `transform` は entrance アニメに打ち消される

`style.rotate` を付けたのに**傾かなかった**（2026-08-11 実機）。
`dpxRiseIn` が `transform: translateY(14px) → none` を animate するアニメで、
**アニメーションは inline style より後勝ち**なので `rotate()` が消える。

→ 傾きを付けたパネルは transform を触らない `fade` に落とす。
**「CSS は書いたのに効かない」ときは、同じプロパティを animate している
アニメーションが無いかを疑う。**

### 8.bb ⚠ Mako テンプレートで**アプリ全体が 500** になる（2026-08-11 実機・実害）

`appserver/templates/` に**構文エラーのある .html を1枚置くだけで、
そのアプリの全ページが HTTP 500** になる（壊れたテンプレートを使っていない
ページも巻き込まれる）。実機のエラー:

```
CompileException: No such tag: 'doc' in file
  '/opt/splunk/etc/apps/dpx/appserver/templates/dpx_boot.html' at line: 27
```

**原因**: **Mako は CSS コメントや HTML コメントの中も解釈する**。
`/* … <%doc> … */` と書いたことで未終端ブロック扱いになった。
→ **テンプレート内のコメントに Mako のタグ名（`<%…>`）を書かない。**
コメントは Mako 行コメント `##` を使うのが安全。

**さらに厄介な点（ここで時間を溶かした）**:
- **アプリの更新（upgrade）は「消したファイル」を実機から削除しない。**
  壊れたファイルをリポジトリから消しても**実機には残り続け、500 も直らない**。
  → **中身を空（有効な Mako）にしたファイルを配って上書きする**しかない
- `stage/` は webpack の CopyPlugin が積むだけで**古いファイルが残る**。
  `src` から消しても `yarn package` には入り続ける。**`stage/` を確認する**
- `_bump` / `_reload` / **splunkd 再起動でも直らない**（キャッシュではなく
  ディスク上のファイルが壊れているため）。**再起動で直らないなら実体を疑う**
- 切り分けは `page-html.mjs <path>` で HTTP コードを見るのが速い。
  500 の本文には traceback が出ないので、**内部ログ（web_service.log）の
  `Mako failed to render` の直後の行にファイル名と行番号が出る**

### 8.cc 白フラッシュの正体は「3点リーダー画面」だった（2026-08-11 訂正）

**【訂正】** §8.x では「遷移中の白は地の色で潰す」としていたが、
実機で測ると**それだけでは消えなかった**。正体は
**`@splunk/react-page` が描く明るいローディング画面**（`rgb(242,244,245)` の面＋
中央に3つの点）で、これが**自前の起動スプラッシュの上に重なって**いた。

- 決め手は「DOM 上は暗いのにスクリーンショットが白い」という食い違い。
  `elementFromPoint` で追うと 58ms 地点に styled-components の
  `DIV{bg:rgb(242,244,245)}` が居た
- **原因は `layout(<Page/>, { theme })` に Splunk のユーザーテーマ（多くの環境で
  light）を渡していたこと。** DPX のシェルは常にダークなので食い違う
- → **`layout(<Page/>, { theme: 'dark' })` で固定する**（`getUserTheme()` は使わない）
- 実測（遷移前後を連続撮影・輝度 >120 を白と判定）:

  | | 対策前 | 対策後 |
  |---|---|---|
  | ダッシュボード → ホーム | 白 3 フレーム（最大輝度 244） | **0**（最大 30） |
  | ダッシュボードを素でリロード | 白 3〜4 フレーム | **0** |
  | DPX → Splunk 標準 search | 白 16 | 白 16（**遷移先が白いページなので対象外**） |

- ⚠ **フレーム数が少ない計測を信用しない。** 一度 `frames=5` で「白 0」と出たが、
  単に撮り逃していただけだった（`frames=72` で測り直すと白 3）。
  **サンプル数も一緒に出す**こと

**【追加訂正 2026-08-11】「3点リーダーの画面」は別物だった。**
上の `theme:'dark'` で白フラッシュは消えたが、ユーザーが言っていた
**「一瞬3点リーダーの画面が挟まる」は残っていた**。
「白い一瞬」を追っていたので輝度フィルタに引っかからず、取り逃していた
（**この画面は暗い**。Splunk のダークグレー `#181d24` 系）。

正体は **`@splunk/react-page` の `layout()` が出す全面ローダー**:
- `position: fixed; z-index: 10000` の面＋**10x10 / border-radius:5px の点が3つ**
  （`18.js` 内の `LoadingStyles` / `Loading.jsx`。opacity を明滅させるアニメ）
- **差し替えるオプションは無い**（`options.loader` は script ローダーの指定で別物）
- 自前スプラッシュ `#dpx-boot` が **z-index:9999 で下に潜っていた**ため上に出ていた

→ **`#dpx-boot` を `z-index: 10001` にして上に重ねる**（実機で解消を確認）。
クラス名（`sc-xxxx`）はビルドごとに変わるので**構造では狙わない**。

**追い方の教訓（同じ取り逃しを防ぐ）**:
- **「白い」と決めつけて輝度で絞らない。** 症状を言い換えて確認する
  （今回はユーザーの「明るいフレームが入るわけではなく、3つの点が並ぶ画面」で判明）
- **`Page.startScreencast` はナビゲーションで切れる**（3フレームしか撮れない）。
  遷移をまたいで記録するなら **Playwright の `recordVideo`**（コンテキスト単位なので途切れない）
- ffmpeg が無くてもフレームは取り出せる:
  **webm を `data:` URL で `<video>` に食わせ、`currentTime` を進めて canvas に描く**

---

### 8.ll `<input type="color">` は「未設定」を表現できない（UI が嘘をつく）

**`<input type="color">` は空の値を持てない。** 何を渡しても必ず色が表示されるので、
未設定の欄にフォールバック色を渡すと**「その色が設定済み」に見えてしまう**。
DPX では新規パネルの「見た目の詳細 → 背景色」が `#4ea1ff` に見えていた
（実際は未指定でプリセットの色が効いている。2026-08-11 にユーザー指摘で発覚）。

→ **未設定のときは「実際に適用されている色」を出す**（v0.5.8 でこの形に落ち着いた）:
- 未設定 … **実効値をスウォッチに塗り、プレースホルダにも `#4ea1ff（プリセットのまま）`
  のように出す**。「未設定」であることは**枠を破線**にして区別する。
  押すとその実効値で確定できる
  - ⚠ 一度は「未設定なら色を隠す」実装にしたが、**今どの色が効いているのか
    分からない**のでユーザー指摘で作り直した。**隠すのではなく実物を見せる**
  - ⚠ 実効値は**描画と同じ関数から導く**こと（DPX では `panelSurface()`。
    `effectivePanelColor()` が窓口）。値を手で書き写すと質感を足したときに
    片方だけ古くなり、**UI が実物と食い違う**（この問題の再発そのもの）
- 指定済み … 通常のピッカー＋**`×`（未設定へ戻す）ボタン**
  ⚠ 戻す手段を用意しないと、一度色を入れたら未設定に戻せなくなる

⚠ **「未設定」の意味は欄によって違う。取り違えない**:
- **実効値が必ずある欄**（ダッシュボードのアクセント色・カギ括弧の色）…
  未設定でも**テーマの色が実際に効いている**。ここは実効値をそのまま見せるのが正しい
  → `ColorInput` の **`allowUnset={false}`**
- **未指定＝何も適用しない欄**（パネル個別の背景色・枠線色・アクセント色）…
  未設定を明示する → 既定の `allowUnset={true}`

**同種の罠**：`placeholder` の文言も「（既定）」だと
**「何らかの既定色が入っている」**と読めてしまう。「未設定」と書く。

### 8.kk アプリアイコンの置き場所と、10.4 で表示されない件（実機確定）

**アイコンは `<app>/static/` に置く**（公式ドキュメント準拠）。ファイル名と寸法は
**実機の標準アプリ `search` を計測して確認したもの**（docs の記述ではなく実物に合わせる）:

| ファイル | 寸法 |
|---|---|
| `static/appIcon.png` | 36×36 |
| `static/appIcon_2x.png` | 72×72 |
| `static/appLogo.png` | 155×43 |
| `static/appLogo_2x.png` | 310×86 |

⚠ **`appserver/static/` に置いても配信され、しかもそちらが優先される**
（赤い判定用画像を片側だけに置いて A/B し、画素の色で確定）。
⚠ **アップグレードでは「消したファイル」が実機から削除されない。**
誤って `appserver/static/` に置いた版が残っていると、`static/` に正しく置き直しても
**古いアイコンが出続ける**。→ **同じ絵で上書きして無害化する**（消す手段が無い）。
§8.bb の「消したファイルは実機から削除されない」と同じ性質。

⚠ **Splunk 10.4 のホーム画面・アプリ管理画面は `appIcon.png` を表示しない**（実機で確認）。
左袖のアプリ一覧は汎用の「App」プレースホルダのまま。
**ファイルが配信されていること（HTTP 200・正しい寸法）と、画面に出ることは別**なので、
「アイコンが出ない＝置き方が間違い」と即断しない。まず URL を直接叩いて確かめる。

⚠ **`appIcon` と `appLogo` は置かれる地が違う。同じ配色を使い回さない**（実機で確認）:
- **`appIcon`** … 自前の**濃紺タイルを敷く**ので、レターマークは**白**でよい
- **`appLogo`** … **白地にも暗い地にも置かれる**。白にすると白背景で消え、
  濃紺にすると暗い背景で消える。→ **中間の色**（青系）にして両方で成立させる
- 判定は**明地と暗地に並べて1枚に撮る**のが早い（片方だけ見ると気づけない）

⚠ **ブラウザの画像キャッシュで「差し替えたのに古い絵が出る」。**
`fetch` にだけクエリを付けても `<img>` は古いままなので、**確認用の HTML でも
URL にクエリを付ける**。**バイト数を比べる**と「実機に届いていない」のか
「表示が古いだけ」なのかを切り分けられる（これで一度誤診しかけた）。

**アイコンの作り方（このリポジトリの方針）**:
- 原本は SVG（`apps/dpx/assets/`）、配布は PNG（`static/`）。
- **ラスタライズは Chromium で行う**（`playwright`）。`ImageMagick` の `convert` は
  **SVG のグラデーションを落として真っ黒にする**（実際に踏んだ）。
- **表示用とアイコン用で SVG を分ける。** 36px では線が細ると消え、
  輪の内側の穴が先に潰れる。小さく焼く版は線を太く・輪を広く取る。
- 図案の教訓（DPX ロゴで実際に描いて確認）:
  - 同じ大きさの輪を2つ縦に積むと **B にしか見えない**（非対称にする）。
    **角を丸めず面取りにする**と直線部が立って D/P として読みやすくなる
  - 交差する要素は **`stroke` ではなく `path` の塗り**で作る。stroke だと
    交差部が同色で溶けるが、塗りなら**重ね順で前後（編み込み）**を作れる
  - 斜線を「左上→右下」に引くと**打ち消し線（禁止マーク）**に見える
  - **同じ色・同じ太さで重ねた線は輪郭が溶けて1つの塊になる。**
    別色・別太さにして要素を分離させる

### 8.mm 日本語だけのタイトルは `slugify` すると**空になる**（2026-08-13 実機・実害）

ホームの新規作成で、タイトルから ID を自動生成していた:

```js
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
slugify('売上ダッシュボード')  // → ''  ⚠
slugify('P1P2 テーマ確認')     // → 'p1p2'（ASCII の断片だけ残る）
```

**日本語タイトルはこの環境では普通**なので、ID 欄が空のまま「作成」ボタンが
`disabled` になり、**なぜ押せないのか画面から分からない**という詰み方をする。

→ **ASCII が残らないときは日付ベースの一意な ID を宛てがう**
（`dpx_YYYYMMDD_hhmmss`。利用者は ID 欄でいつでも書き換えられる）。
**ダイアログを開いた時点で ID を埋めておく**のが要点で、
「タイトル入力時に補う」だけでは打鍵のたびに ID が振り直されて落ち着かない。

### 8.nn `TextInput` は**打鍵では反映されない**（blur / Enter で確定する）

`engine/ui.jsx` の `TextInput` は draft/commit 方式で、
**`onChange` を呼ぶのは blur か Enter のときだけ**（打鍵ごとに定義 JSON を
書くと編集履歴が1文字ずつ積まれるため。意図した設計）。

⚠ **E2E で `fill()` しただけでは React の state が変わらない。**
DOM の value は入っているのでスクリーンショット上は正しく見えるのに、
`disabled` なボタンが有効にならず「実装のバグ」に見える（実際に誤診しかけた）。

```js
await input.fill('タイトル');
await input.press('Tab');   // ← 必須。blur させて初めて onChange が走る
```

**「画面には入っているのにボタンが押せない」ときは、まず確定操作の有無を疑う。**

## 9. 検証ツール（`tools/dashboard-loop/src/`）

DPX 専用の E2E / 撮影ツール。**実装したら必ずどれかで実機確認する。**

| ツール | 用途 |
|---|---|
| `shot-page.mjs <path>` | 任意ページの撮影（DPX は全部これ。`shot.mjs` は Studio 専用で使えない） |
| `page-html.mjs <path>` | 生 HTML 取得（テンプレート 500 の切り分け） |
| `dp-edit-check.mjs <app> <view> <クリック文字列> <out>` | 編集モードで要素をクリックして撮影 |
| `dp-scroll-shot.mjs` | インスペクタを最下部までスクロールして撮影 |
| `dp-click-shot.mjs` / `dp-hover-viz.mjs`（座標）/ `dp-hover-el.mjs`（要素） | クリック・ホバー状態の撮影 |
| `dp-save-check.mjs` | 編集→保存→REST 永続化の E2E |
| `dp-settings-e2e.mjs` | **ドロップダウン＋テキストを変更→保存→REST 検証** |
| `dp-push.mjs <def.json> <app> <view> [label]` | **DPX 定義（JSON）を実機のビューへ push**（作成／更新。owner は自動で切替） |
| `dp-linkline-e2e.mjs <app> <view> <panelId>` | **編集モードでハンドルをドラッグ→保存→REST で永続化を確認**（canvasEdit の回帰テスト） |
| `dp-brush-e2e.mjs <app> <view> [panelId]` | **時間ブラシ**（横ドラッグ→全パネルの期間が変わる）。⚠ 判定は**X 軸ラベルの変化**で行う（明細の行内容は `makeresults` だと毎回変わるので当てにならない） |
| `dp-group-e2e.mjs <app> <view>` | **区画（グループ）の編集 UI**。ツールバーで追加→キャンバスで選択→改名→保存→REST 検証 |
| `dp-groupmove-e2e.mjs <app> <view> [groupId]` | **区画ごと移動**。ドラッグ→保存→REST で**全メンバーの移動量が同じ**ことを確認 |
| `dp-zoom.mjs <app> <view> [view\|edit]` | **意匠の粗を 2x 拡大で撮る**（区画の四隅を clip）。⚠ 罫の途切れ・見出しの重なりは**全画面では見えない** |
| `dp-undo-e2e.mjs <app> <view> [out.png]` | **Ctrl+Z（編集履歴）の通し検証**。入力・ドラッグ・複製・削除・矢印移動・区画追加・redo と、**戻しきったら保存ボタンが押せなくなる**ことを確認 |
| `dp-dragpreview-e2e.mjs <app> <view> [out.png]` | **ドラッグ中に定義を書いていないこと**の検証。「絵は動く」かつ「保存ボタンは押せない」を同時に見る（片方だけでは退行を見逃す） |
| `dp-textcommit-e2e.mjs <app> <view> [out.png]` | **テキスト欄が確定時だけ書くこと**の検証。打鍵中／確定／Ctrl+Z／Enter／Escape／**IME**（CDP で本物の変換）を通しで見る |
| `dp-drag-check.mjs` | パネルのドラッグ移動→保存→REST 検証 |
| `dp-token-check.mjs` | クリック→トークン→再サーチの連鎖 |
| `dp-tab-check.mjs` | タブ自動送りの間隔測定 |
| `dp-timemode-e2e.mjs` | パネル時間範囲の入力束縛 |
| `dp-inputorder-e2e.mjs` | 入力の並べ替え永続化 |
| `dp-hover-check.mjs` | viz 間ホバー同期（リンクドハイライト） |
| `apps/dpx/tools/probe-views.mjs` | ビュー XML の CRUD（`create` / `get` / `delete`） |

⚠ **E2E を書くときの注意（実際に誤診した）**:
- 「最初の `.dpx-input`」のような曖昧なセレクタは別要素を掴む → `filter({ hasText })` で特定する
- **折りたたみセクションは既に開いていることがある**。クリックすると閉じるので、
  **対象ボタンが見えているかを先に判定**してから必要な時だけ開く
- **`getByText` は `<select>` の `<option>` にも当たる**（不可視で click タイムアウト）
  → パネル内を狙うなら `div:text-is("…")`
- **自動送りの初回切替は「表示から intervalSec 後」**。描画直後から測ると短く見えるので、
  **1回目の切替を待ってから2回目までを測る**
- ⚠ **`page.evaluate` の `document.querySelectorAll` ではインスペクタの入力欄が取れない**
  （2026-08-12 に誤診）。`input[type=text]` が **3個しか返らず**「要素が無い」と判断したが、
  実際は**画面に出ていた**。**Playwright のロケータは貫通するので、必ずロケータで掴む**。
  逆に `input[type=text]` の**素の先頭は Splunk の非表示検索欄**（`Search settings...`）なので、
  `.first()` は使わない。
- ⚠ **テキスト欄は自前コンポーネントで、ロケータからは `visible=false` に見える**。
  数値欄（配置 x,y,w,h）は掴めるので、**「入力→履歴」の検証は数値欄で代用する**（同じ patch 経路）。
- ⚠ **パネルは中央をクリックしない**。隣のパネルの子 div が pointer を奪って
  `subtree intercepts pointer events` で 30 秒固まる。**タイトルバー（上端 +10px）を掴む**。
- ⚠ **アイコンだけのボタンは `getByRole('button', {name})` で引けない**（テキストが無い）。
  `button[title^="…"]` で引く（区画の追加ボタンが実例）。
- ⚠ **`viz` の type は `dpx.table` / `dpx.bar`**。`table` と書くと
  **「未登録の viz」と表示され、パネルの枠だけ出て中身が描かれない**（検証用ボードで踏んだ）。
- ⚠ **メンバーが居ない区画は枠を描かない**（外接矩形が無いため）。
  「枠の数」で判定すると「追加されていない」と誤診する → **保存ボタンの活性**で見る。

---

## 10. 現在の到達点と残件（2026-08-10 時点）

**動いているもの（すべて実機確認済み）**: 一覧/新規作成（テンプレート4種・所属アプリ選択）・
表示/編集モード・保存・パネルのドラッグ/リサイズ・インスペクタ（自動生成フォーム含む）・
タブ＋自動送り・入力/トークン/クリック連携・背景14種・ネイティブ viz 7種・
world-map の iframe なしホスティング・viz 間ホバー同期。

**残件**:
- ~~undo/redo~~ … **v1.5.0 で完了**（あらゆる操作を Ctrl+Z で戻せる／戻しきると保存不可。§6.8.6b）
- パネルの重なり検知、複数選択
- 残り28 viz の登録（**設計の柱ではない**。必要になったら §3.2 の手順で）
- `@splunk/dashboard-*` が `package.json` に**未使用のまま残っている**（削除してよい）
- バージョンは `0.1.0` のまま。README・リリースノート・OSS ライセンス通知は未整備
- 実機に残っている検証用ダッシュボード: `dp_dpx1`〜`dp_dpx4`, `dp_bg`, `dp_demo`,
  `dp_demo_search`（search アプリ）。不要なら管理ページから削除できる
