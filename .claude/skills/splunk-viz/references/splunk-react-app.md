# Splunk App with React（独立 React ページ）実装ナレッジ

**2026-08-10 実機検証（Splunk Enterprise 10.4.2）。参照実装は [apps/ops-console/](../../../../apps/ops-console/)。**

カスタム viz の 2 方式（classic / Studio 拡張）とは別系統の**第 3 の方式**。
成果物は「ダッシュボードのパネル」ではなく **Splunk のナビから開く 1 枚のページ**。

> ⚠ このファイルは以前 `dashboard-framework.md` として参照されていたが、**実体が無かった**。
> また旧記述では「Dashboard Framework」と一括りにされていたが、これは**別物の混同**だった。
> 下の「用語の整理」を参照。

---

## 0. 用語の整理（旧ナレッジの訂正）

`custom-viz-methods.md` には「Dashboard Framework（`@splunk/create` の独立 React アプリ／
`DashboardCore` + preset）は Mako テンプレート依存で 10.4 では非推奨」とあったが、
**2 つの別物が混ざっている**:

| | 実体 | 状態 |
|---|---|---|
| **`@splunk/create` の独立 React アプリ** | Splunk アプリの中に React のページを作る | **現役。10.4.2 で動作確認済み** |
| `DashboardCore` + preset | 作った React アプリの**中に Splunk のダッシュボードを描画**するライブラリ | 別の話。ここでは扱わない |

**前者そのものは非推奨ではない。** さらに、**Mako テンプレートを自分で書く必要も無い**（§2）。

---

## 1. 3 方式の対比

| | Studio 拡張 viz | classic カスタム viz | **React アプリページ** |
|---|---|---|---|
| 成果物 | パネル 1 個 | パネル 1 個 | **ページ 1 枚** |
| どこに出る | ダッシュボード内 | ダッシュボード内 | **`/app/<appId>/<page>`** |
| データ | ホストが渡す（受動） | 自分で増分要求できる | **自分で SPL を投げる（能動）** |
| iframe 隔離 | あり | なし | **なし** |
| ダッシュボードに載る | ○ | ○ | **✕** |
| 編集画面のオプション | `config.json` | `formatter.html` | **無い**（UI は自分で作る） |
| splunkd 再起動 | `config.json` 変更時に必要 | — | **不要**（静的アセットのみ） |

**選び方**: ダッシュボードに載せたい → カスタム viz。
**1 枚の画面として作り込みたい・ページ自身にサーチさせたい** → この方式。

### ⚠ 「クラシックダッシュボードの上に作っている」わけではない（実機確認済み）

紛らわしいが、**HTML ビューとクラシックダッシュボードは `data/ui/views` という
同じ棚に並ぶ別カテゴリの兄弟**であって、上下関係ではない。
実機の全 158 ビューを `eai:data` のルート要素で分類した結果（2026-08-10）:

| 中身 | 件数 | 正体 |
|---|---|---|
| `<view type="html">` | 122 | **HTML ビュー**（この方式） |
| `<dashboard>` / `<form>` | 24 | クラシックダッシュボード |
| その他の `<view>` | 12 | — |

**ルート要素からして別物**で、Splunk がダッシュボードとして解釈するのは後者だけ。
HTML ビューに来た時点でパネル・トークン・`<search>` は**一切起動しない**。
共有しているのは「アプリに属する画面オブジェクトである」という登録の枠だけ。

> **⚠ `isDashboard` を根拠にしないこと（誤読の実例）。**
> REST で見ると HTML ビューでも `isDashboard: true` が返ることがあり、
> これを「ダッシュボード扱いされている証拠」と読んだが**誤りだった**。
> 実機の HTML ビュー 122 件を調べると:
> - XML に `isDashboard="False"` を**明示**している 27 件 → `false`
> - **何も書いていない** 95 件（自作のものを含む）→ `true`
>
> つまり **`true` は「宣言していない」というだけの既定値**。
> 値が付いていることに意味を読み取ってはいけない。

---

## 2. ページの器（Mako は書かなくてよい）★重要

`default/data/ui/views/<page>.xml` の 5 行だけでページになる:

```xml
<view template="pages/splunk_ui_app.html" type="html">
    <label>Overview</label>
</view>
```

`pages/splunk_ui_app.html` は **Splunk 同梱の共通テンプレート**で、
**ビューと同名の JS**（`appserver/static/pages/<page>.js`）を自動で読み込む。

> `@splunk/create` には自前の Mako（`${make_url(...)}` を書いた `.html`）を出す
> **legacy モード**もある（`useLegacyTemplate: true`）。**使わなくてよい。**
> 「Mako 依存だから非推奨」という旧認識は、この legacy 側だけを見た誤りだった。

**10.4.2 実機では `type="html"` のビューが 33 個稼働中**（`search`/`splunk-dashboard-studio` 等の
同梱アプリ自身が使っている）＝ HTML ビューの仕組みは現役。

---

## 3. ディレクトリ構成

```
apps/<name>/
├── package.json / webpack.config.js / .babelrc.js
├── bin/package.mjs                       ← stage/ を .spl に固める
└── src/main/
    ├── resources/splunk/                 ← そのまま Splunk アプリの中身になる
    │   └── default/
    │       ├── app.conf                  ← [id] name / version, [ui] label
    │       └── data/ui/
    │           ├── views/<page>.xml      ← ページの器（§2）
    │           └── nav/default.xml       ← ナビ
    └── webapp/
        ├── pages/<page>/index.jsx        ← エントリ（webpack が自動で拾う）
        └── components/                   ← 実装本体
```

`webpack.config.js` は `pages/` 配下のディレクトリを**自動でエントリ化**する。
ページを増やすときはディレクトリを足すだけ（設定は触らない）。

出力先は `stage/appserver/static/pages/<page>.js`。`resources/splunk/` は `stage/` へコピーされる。

---

## 4. エントリの書き方

```jsx
import layout from '@splunk/react-page/18';      // React 18 (createRoot) 版
import { getUserTheme } from '@splunk/splunk-utils/themes';

getUserTheme()
    .then((theme) => layout(<App />, { theme }))
    .catch(() => layout(<App />, { theme: 'light' }));  // 失敗しても必ず描画する
```

`layout()` が **Splunk のヘッダ・アプリバーごと描画**し、渡した要素を本文に差し込む。

### テーマ（実機で踏んだ落とし穴）

ユーザーのテーマ設定は **`user-prefs` の 2 つのキー**にある:

- `display.theme` … `light` / `dark`
- **`theme`** … `default_system_theme` など ← **`getUserTheme()` はこちらを見る**

`display.theme` だけ `dark` にしても**ページは light のまま**だった。
`theme=dark` にして初めて切り替わる（実機確認済み）。
ダークで見た目を確認したいときは両方を設定する。

---

## 5. サーチの実行（この方式の主眼）

**iframe に閉じ込められていないので、ログイン中のセッションのまま splunkd を叩ける。**
拡張 viz で全滅する認証付き fetch の制約（`studio-hacks.md`）が**そもそも無い**。

```js
import { createRESTURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit, handleResponse } from '@splunk/splunk-utils/fetch';

// defaultFetchInit に CSRF ヘッダとセッションが入る（認証処理を自分で書かなくてよい）
await fetch(createRESTURL('search/jobs'), {
    ...defaultFetchInit,
    method: 'POST',
    headers: { ...defaultFetchInit.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        search: '| makeresults ...',
        exec_mode: 'blocking',     // ジョブ完了まで splunkd 側で待つ＝ポーリング不要
        output_mode: 'json',
    }).toString(),
}).then(handleResponse(201));      // 成功は 201。200 を期待すると落ちる
// → 返る sid で GET search/jobs/<sid>/results
```

実装例は [`apps/ops-console/src/main/webapp/components/useSearch.js`](../../../../apps/ops-console/src/main/webapp/components/useSearch.js)。

> **`@splunk/search-job` は採用しなかった。** 最新 3.1.0 が `rxjs@5` と
> `@splunk/splunk-utils@3` を要求し、ページ側の `splunk-utils@4` と衝突する。
> REST を直接叩けば依存が増えない（上記のとおり 2 エンドポイントだけ）。

---

## 6. ビルド・インストール・撮影

```bash
cd apps/<name>
yarn install && yarn build && yarn package     # dist/<appId>-<ver>-<hash>.spl

# viz と同じインストーラがそのまま使える（.spl の直接指定に対応している）
node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)

# 撮影は shot-page.mjs（shot.mjs はダッシュボード専用で使えない）
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/<appId>/<page> --out /tmp/shots
```

- **`.spl` の中身は `<appId>/...` で始まる tar.gz**。`stage/` をそのまま固めると
  `stage/` がルートになって**インストールできない**（`bin/package.mjs` は appId 名でコピーしてから固める）。
- **splunkd の再起動は要らない。** `appserver/static/` は静的アセットなので `_bump` で反映される。
  カスタム viz の `config.json` キャッシュ問題（§7.1）は**この方式には存在しない**。

---

## 7. 権限

- **`install_apps` だけでインストールできた**（実機確認済み）。
- **`edit_view_html` は持っていないが問題なかった。** アプリに同梱した HTML ビューは動く。
  ただし **Splunk Web の画面から HTML ビューを新規作成・編集する**操作には
  この権限が要る可能性がある（**未検証**）。

---

## 7.5 全画面ページ（壁掛けボード）を作るときの注意

参照実装は [apps/noc-wall/](../../../../apps/noc-wall/)（2026-08-10 実機検証）。

- **Splunk のヘッダはクラス名で狙えない。** 10.4 実機のヘッダには styled-components が
  生成したクラス（`.sc-gsFSXq` 等）しか付いておらず**ビルドごとに変わる**。
  実体は `body` 直下の素の `<header>` なので **`body > header { display: none }`** と
  構造で指定する（DOM を probe して確認）。
- **セクションを重ねて切り替えるときは `visibility` と `z-index` を併用する。**
  `opacity: 0` だけだと**透明な要素が上に乗ったままで下が透けて二重に見える**（実機で発生）。
- **自動送りは `setInterval` の発火回数で数えない。** タブが非アクティブだと
  間隔が詰まって**一気に何枚も飛ぶ**。開始時刻からの経過で判定する。
- **時刻を SPL の `strftime()` で文字列にしない。** サーバのタイムゾーンで解釈されるため、
  ブラウザで描く時計と**数時間ズレる**（実機で UTC 01:18 と JST 16:18 が並んだ）。
  **エポック秒のまま返して描画側で整形する。**
- **SVG を親いっぱいに伸ばすときは viewBox 用の高さと実寸を分ける。**
  `height="100%"` を座標計算にも使うと NaN になる。
  また `preserveAspectRatio="none"` だと**円が楕円に潰れる**ので、
  点は `<circle>` ではなく `vectorEffect="non-scaling-stroke"` の線分で描く。
- **パネル内の行は `justify-content: space-evenly` で分配する。**
  固定 margin だと大画面で下半分が空く（実機で発生）。

---

## 7.6 「選択駆動」の 1 ページ画面を作るとき

参照実装は [apps/soc-console/](../../../../apps/soc-console/)（2026-08-10 実機検証）。
一覧を選ぶと詳細・関連情報が追従する形。**ダッシュボードでは作れない**（パネル間に
選択状態を持てない。トークンバスを使っても iframe 越しで遅い）。

- **⚠ SPL に値を埋め込むときは必ずサニタイズする。**
  選択した行の値をサーチに使う設計では、**データ由来の文字列が SPL に入る**。
  `replace(/[^A-Za-z0-9._-]/g, '')` のような許可リストを通す。
  SPL が壊れるだけでなく**コマンド注入になりうる**。
- **「何も選ばれていない」状態を作らない。**
  `selectedId` を state に持ちつつ、表示は
  `filtered.find(r => r.id === selectedId) || filtered[0]` で解決する。
  フィルタで選択行が消えても詳細ペインが空にならない。
- **再検索は SPL 文字列の同一性で制御する。**
  `useMemo` で SPL を組み立てれば、同じ文字列のときは `useSearch` が再実行しない。
- **列幅は実機で確かめる。** バッジは折り返さないので、
  長い値（`INVESTIGATING` = 13 文字）が入る列は切れる（実機で発生）。
  一覧では短縮表記にして、原文は `title` 属性と詳細ペインに残す。
- **並び順はドメインの優先度で決める。** severity を数値化して
  「重い順 → 新しい順」の 2 段ソートにする。時刻順だけだと critical が埋もれる。

---

## 8. 実装上の注意（実機で踏んだもの）

- **`@splunk/react-ui` の `TextArea` は隠し `textarea` を持つ。**
  Playwright で操作するときは `textarea:not([aria-hidden="true"])` を狙う
  （`textarea` の素の first は不可視要素に当たってタイムアウトする）。
- **`ControlGroup` は入力部を既定幅で止める。** 幅いっぱいに伸ばすには
  ラッパの子孫まで `width: 100%` を当てる必要がある（`controlsLayout="fill"` だけでは足りなかった）。
- **列名を決め打ちしない。** 数値列・ラベル列を実データから推定すると、
  ユーザーが SPL を書き換えても壊れない（実機で列構成ごと差し替えて確認済み）。
- バンドルは 1.1MB 程度になる（`@splunk/react-ui` + `react-page`）。
  webpack が size 警告を出すが**エラーではない**。

---

## 9. `@splunk/create` を非対話で回す

CLI は対話前提だが、ジェネレータを直接呼べば非対話で回せる。
**ただしオプションを 1 つでも落とすとそこで無言でプロンプト待ちになる**（実際に 2 回ハマった）:

```js
await Create(fsStore, {
  mode: 'splunkapp',
  generatorMode: ['repo', 'app', 'page', 'component'],
  appName: 'MyApp',
  pageName: 'overview',
  componentType: 'basic',      // ← 忘れるとプロンプト待ちで固まる
  useLegacyTemplate: false,    // ← 同上
});
await fsStore.commit();        // コールバック版を使うと謎の例外が出る
```

> 実際にはこの方法で生成すると **`_ComponentName_` / `_PackageName_` などの
> プレースホルダが置換されずに残った**。構造の把握には有用だが、
> **成果物としては手で書いた方が早い**（参照実装はそうしている）。

---

## 10. できないこと

- **ダッシュボードのパネルとしては使えない。** ダッシュボードに載せたいならカスタム viz を作る。
- 編集画面のオプション（`optionsSchema` / `editorConfig`）に相当する仕組みは無い。
  設定 UI が要るなら自分で作る。
- **大量データの性能は未検証**（参照実装は表示を 100 行に制限している）。
- **複数ページ構成は未検証**（webpack のエントリは自動生成なので通るはずだが、実機では 1 枚のみ）。
