// ── DPX のエントリ（極小のシム）─────────────────────────────────
//
// **このファイルは意図的に「ほぼ空」にしてある。** 中身を足さないこと。
//
// ## なぜ分けるのか（2026-08-15 実測で確定）
//
// 標準テンプレート（`pages/splunk_ui_app.html`）は「ビュー名と同名の JS」を
// 1 本だけ読む。以前はそこにアプリ全体（**4.88MB / gzip 1.36MB**）を詰めていた。
//
// `bootPaint`（地を暗くする処理）はその**先頭の import** に置いてあったが、
// **モジュールの評価はバンドル全体のダウンロード＋パースが終わるまで始まらない**。
// 実測（コールド遷移・遷移開始を 0ms とする）:
//
// | | 旧（単一バンドル） |
// |---|---|
// | HTML 応答完了 | 26ms |
// | dpx.js 取得 | 78〜603ms |
// | **bootPaint 実行** | **800ms** |
// | **first-paint** | **808ms** |
//
// → **HTML が来てから 800ms、ブラウザは「前のページ」を出したまま**だった。
// これが「白フラッシュ」の正体（Splunk の他ページは明るいので白く見える）。
//
// ⚠ **旧ナレッジの「HTML 表示〜JS 開始の数百 ms は構造上塗れない」は誤り**だった。
//   塗れないのではなく、**塗る処理を巨大バンドルの後ろに置いていた**のが原因。
//   テンプレートが読む JS は 1 本でよく、**その 1 本を小さくすれば**先に塗れる。
//
// ## 仕組み
//
// 1. このファイル（数 KB）だけが同期で読まれ、**即座に**暗転＋スプラッシュを出す
// 2. アプリ本体（`app.jsx`）は **動的 import** で別チャンクとして読む
// 3. チャンクの取得先は `__webpack_public_path__` を実行時に組み立てて教える
//    （⚠ Splunk の静的 URL は `_bump` のたびに変わるキャッシュキーを含むので、
//      ビルド時に固定できない。**自分自身の script タグの src から逆算する**）
// ────────────────────────────────────────────────────────────────

import './bootPaint';

// ⚠ **動的 import より前に publicPath を決める**（webpack はこの変数を見て
//   チャンクの URL を組み立てる。後から代入しても間に合わない）。
//
//   自分自身（pages/dpx.js）の URL からディレクトリ部分を取る。
//   例: /en-US/static/@<hash>/app/dpx/pages/dpx.js
//       → /en-US/static/@<hash>/app/dpx/pages/
//   ⚠ `document.currentScript` はモジュール評価時には null になりうるので、
//     フォールバックとして src の末尾一致でも探す。
(() => {
    let base = '';
    const self = document.currentScript;
    if (self && self.src) {
        base = self.src.replace(/[^/]*$/, '');
    } else {
        const tag = [...document.querySelectorAll('script[src]')].find((s) =>
            /\/pages\/dpx\.js(\?|$)/.test(s.src)
        );
        if (tag) base = tag.src.replace(/[^/]*$/, '');
    }
    if (base) {
        // eslint-disable-next-line camelcase, no-undef
        __webpack_public_path__ = base;
    }
})();

// アプリ本体を読み込む。**ここで初めて React も 30 種の viz も落ちてくる。**
// 失敗したらスプラッシュのままになってしまうので、必ず知らせる。
import(/* webpackChunkName: "dpx-app" */ './app').catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[dpx] アプリの読み込みに失敗しました', err);
    const boot = document.getElementById('dpx-boot');
    if (boot) {
        boot.innerHTML =
            '<div style="text-align:center;font:14px/1.7 sans-serif;color:#e8eefc">' +
            '<div style="font-weight:600;letter-spacing:.2em;margin-bottom:10px">DPX</div>' +
            '読み込みに失敗しました。<br>再読み込みしてください。</div>';
    }
});
