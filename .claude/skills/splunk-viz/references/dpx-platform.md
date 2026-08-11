# DPX（Dash Platform）— 独自ダッシュボード基盤の実装ナレッジ

**2026-08-10 に構築・実機検証（Splunk Enterprise 10.4.2）。実装は [apps/dash-platform/](../../../../apps/dash-platform/)、
アプリ ID は `dash_platform`。この文書は「DPX を触る前に読むファイル」。**

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
| 成果物 | `dash_platform` アプリ 1 つ。定義は**ビュー XML 1 枚＝1 ダッシュボード**（isVisible=False の入れ物） |
| 画面 | **ホストビュー `dpx` の1枚だけ**（v0.2.0 で1ビュー集約）。`/app/dash_platform/dpx` がホーム、`?id=<app>/<name>` がダッシュボード。**画面間は pushState の SPA＝再読込ゼロ** |
| 描画 | 自前エンジン `DpxDashboard`（CSS grid）。Studio の `@splunk/dashboard-*` に**依存しない** |
| データ | ページ自身が splunkd に `search/jobs` を投げる（iframe が無いのでセッション認証がそのまま効く）。⚠ **名前空間は所属アプリ**（`SearchAppContext`。URL が常に dash_platform なので明示必須） |
| 保存 | ビュー XML の `<definition><![CDATA[ JSON ]]></definition>`（Studio と同型の入れ物） |
| 配信 | **Splunk 同梱テンプレート `pages/splunk_ui_app.html`** が同名 JS `pages/dpx.js` を読む。**Mako 不使用**（v0.2.0 で全廃）。ダッシュボードを増やしても**再パッケージ不要** |
| viz | `vizRegistry.js` の Map に React コンポーネントを登録するだけ。**iframe なし・config.json なし・再起動なし** |
| 編集 | 独自インスペクタ（`Inspector.jsx`）。viz の `editorConfig` からフォームを自動生成 |

**開発ループ**（全部で10秒程度）:

```bash
cd apps/dash-platform
rm -rf stage && NODE_OPTIONS=--max-old-space-size=8192 yarn build   # ← heap 拡張は必須（後述）
yarn package && node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/dash_platform/<view> --out /tmp/shots
```

---

## 1. アーキテクチャ（なぜこの形なのか）— v0.2.0 で1ビュー集約・Mako 全廃

```
Splunk Web
 └ ホストビュー dpx（default/data/ui/views/dpx.xml。画面はこの1枚だけ）
    ├ template="pages/splunk_ui_app.html"     ← Splunk 同梱（Mako ではない）
    │   └ pages/dpx.js                        ← 唯一のランタイム（同名 JS 規則）
    │       /app/dash_platform/dpx            → ホーム（一覧）
    │       /app/dash_platform/dpx?id=<app>/<name> → ダッシュボード（SPA 切替）
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
   URL が常に dash_platform になったので、明示しないと**他アプリのマクロ・ルックアップが
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
開く URL は `/app/dash_platform/dpx?id=<app>/<name>`（ビュー自体は直接開かない）。

- 移行先に **`dash_platform` アプリが入っていること**が前提（テンプレートの提供元）
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

**⭐ AppInspect は審査で落とし始める（2026-08-11 ソース確認）**:
`check_for_custom_mako_templates` = **`appserver/templates/`（または `appserver/modules/`）に
`.html` が存在するだけで `FailMessage`**（内容不問。DPX の dashboard.html / home.html は無条件該当。
空ファイルでも引っかかる）。
- 現行 AppInspect 4.3.0 では `release_version=4.4.0` 指定により **`future_failure`（予告）**。
  **AppInspect 4.4.0 から本物の `failure`** になる（`FailMessage.__init__` の実装で確認）
- 対象タグは `cloud` / `private_app` / `private_victoria` / `private_classic` / `migration_victoria`
  ＝ **Splunkbase 提出と Splunk Cloud の私有アプリ審査**。**セルフマネージド Enterprise の実行時には
  何も強制されない**
- → **DPX は Splunk Cloud には持ち込めない**（審査で落ちる）。Enterprise 専用と割り切る
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

- **配色プリセット9種**（`themes.js`）。系列色パレットもプリセットごとに持つ（`useDpxTheme().palette`）:

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
- **パネル質感11種**（`style.variant`）。**既定は `noc`**（2026-08-11 変更）:
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
  | `frameless` | 枠なし・背景透過（タイトルバーも消える） |
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
- **背景エフェクト14種**（`BackgroundLayer.jsx`）:
  canvas 系＝particles / constellation / rain / ripple / wave、
  パターン系＝grid / hex / dots / diagonal / scanlines、
  グラデ系＝glow / aurora / vignette。canvas 系は `document.hidden` で描画停止
- **タブ＋自動送り**: `tabs` と `rotate`。⚠ **ローテーションの effect を「現在タブ」に依存させない**
  （依存させると切替のたびに基準時刻がリセットされ、15秒設定が4秒間隔になる。実機で発生）。
  `useRef` に最終切替時刻を持ち、effect は張り直さない
- **Splunk ヘッダの非表示**: `body > header { display: none }` を注入（クラス名は
  ビルドごとに変わるので**構造で指定**する。noc-wall の実機知見）

---

## 6. 値→色の設定（`editor.colorRules`）

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
| `dpx.table` | テーブル | 全列 | 行ホバー強調、**数値列に値バー**、行クリックでトークン |
| `deco.text` | テキスト | 不要 | `$トークン$` 展開・グロー |
| `deco.clock` | 時計 | 不要 | ライブ更新 |

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
  '/opt/splunk/etc/apps/dash_platform/appserver/templates/dpx_boot.html' at line: 27
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
| `dp-drag-check.mjs` | パネルのドラッグ移動→保存→REST 検証 |
| `dp-token-check.mjs` | クリック→トークン→再サーチの連鎖 |
| `dp-tab-check.mjs` | タブ自動送りの間隔測定 |
| `dp-timemode-e2e.mjs` | パネル時間範囲の入力束縛 |
| `dp-inputorder-e2e.mjs` | 入力の並べ替え永続化 |
| `dp-hover-check.mjs` | viz 間ホバー同期（リンクドハイライト） |
| `apps/dash-platform/tools/probe-views.mjs` | ビュー XML の CRUD（`create` / `get` / `delete`） |

⚠ **E2E を書くときの注意（実際に誤診した）**:
- 「最初の `.dpx-input`」のような曖昧なセレクタは別要素を掴む → `filter({ hasText })` で特定する
- **折りたたみセクションは既に開いていることがある**。クリックすると閉じるので、
  **対象ボタンが見えているかを先に判定**してから必要な時だけ開く
- **`getByText` は `<select>` の `<option>` にも当たる**（不可視で click タイムアウト）
  → パネル内を狙うなら `div:text-is("…")`
- **自動送りの初回切替は「表示から intervalSec 後」**。描画直後から測ると短く見えるので、
  **1回目の切替を待ってから2回目までを測る**

---

## 10. 現在の到達点と残件（2026-08-10 時点）

**動いているもの（すべて実機確認済み）**: 一覧/新規作成（テンプレート4種・所属アプリ選択）・
表示/編集モード・保存・パネルのドラッグ/リサイズ・インスペクタ（自動生成フォーム含む）・
タブ＋自動送り・入力/トークン/クリック連携・背景14種・ネイティブ viz 7種・
world-map の iframe なしホスティング・viz 間ホバー同期。

**残件**:
- undo/redo、パネルの重なり検知、複数選択
- 残り28 viz の登録（**設計の柱ではない**。必要になったら §3.2 の手順で）
- `@splunk/dashboard-*` が `package.json` に**未使用のまま残っている**（削除してよい）
- バージョンは `0.1.0` のまま。README・リリースノート・OSS ライセンス通知は未整備
- 実機に残っている検証用ダッシュボード: `dp_dpx1`〜`dp_dpx4`, `dp_bg`, `dp_demo`,
  `dp_demo_search`（search アプリ）。不要なら管理ページから削除できる
