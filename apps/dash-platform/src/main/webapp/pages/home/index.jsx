// ── 旧ホーム URL の後方互換スタブ ────────────────────────────────
// /app/dash_platform/home → /app/dash_platform/dpx へ即リダイレクトする。
// v0.1.x まではここが Mako テンプレート＋React の実体だった。
// 1ビュー集約（v0.2.0）で実体は pages/dpx.js に移り、この JS は
// 「暗転してから転送する」だけの数行になった（React 不要・依存ゼロ）。
//
// ⚠ ここを消してはいけない：標準テンプレートは「ビュー名と同名の JS」を
//   読むので、home.js が無いと旧 URL が白紙のまま固まる。
(function redirectHomeToDpx() {
    // 転送の一瞬も白を見せない
    document.documentElement.style.background = '#0a1020';
    if (document.body) document.body.style.background = '#0a1020';

    const target = window.location.pathname.replace(/\/home(?=$|[/?#])/, '/dpx');
    window.location.replace(target + window.location.search + window.location.hash);
})();
