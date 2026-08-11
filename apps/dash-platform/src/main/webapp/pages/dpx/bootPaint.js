// ── 早期暗転＋起動スプラッシュ（白フラッシュ対策の第一手）──────────
// Mako 時代は <head> の <style> がこれを担っていた。標準テンプレート
// （pages/splunk_ui_app.html）には <head> を握る口が無いので、
// **JS バンドルの評価先頭**で同じことをやる。
//
// 必ず index.jsx の最初の import にすること（依存ゼロ・副作用のみ。
// import は評価順が保証されるので、React や react-page より先に走る）。
//
// これで消せるのは「JS 開始〜React 描画」の間の白。
// 「HTML 表示〜JS 開始」の数百 ms は公式テンプレートの構造上塗れない
// （実測と全数調査の結論。references/dpx-platform.md §1.1）。
// ────────────────────────────────────────────────────────────────

/**
 * スプラッシュ #dpx-boot を（再）表示する。
 * コールド起動は import 時に自動で呼ばれる。SPA 遷移（ホーム⇄ボード）でも
 * ルーター（pages/dpx/index.jsx の navigate）がこれを呼び、
 * 「かっこいいロード画面」を最低表示時間ぶん見せる。
 */
export function showBootSplash() {
    // 表示開始時刻を毎回リセット（dismissBootSplash の最低表示時間の起点）
    window.__DPX_BOOT_T0 = Date.now();
    const old = document.getElementById('dpx-boot');
    if (old) old.remove(); // フェード中の残骸ごと作り直す（dismissing フラグも消える）
    const boot = document.createElement('div');
    boot.id = 'dpx-boot';
    boot.innerHTML =
        '<div class="dpx-boot-inner" style="text-align:center">' +
        '<div class="dpx-boot-mark">DPX</div>' +
        '<div class="dpx-boot-bar"><i></i></div>' +
        '</div>';
    document.body.appendChild(boot);
}

(function dpxBootPaint() {
    if (document.getElementById('dpx-boot-style')) return; // 二重実行ガード

    // (1) 地を暗くする。⚠ !important が要る：Splunk の共通 CSS が後から
    //     body を明るい色に上書きする（Mako 時代に実測した既知の挙動）。
    const style = document.createElement('style');
    style.id = 'dpx-boot-style';
    style.textContent = [
        ':root { color-scheme: dark; }',
        'html, body { margin: 0 !important; padding: 0 !important;',
        '  background: #0a1020 !important; color: #e8eefc; }',
        // react-page の全面ローダー（3つの点・z-index:10000）より上に出す。
        // 下だと「一瞬3点リーダーの画面が挟まる」（実機で確認済みの既知問題）
        '#dpx-boot { position: fixed; inset: 0; z-index: 10001;',
        '  display: flex; align-items: center; justify-content: center;',
        '  background: #0a1020; transition: opacity 0.25s ease; }',
        '#dpx-boot.dpx-boot-hide { opacity: 0; pointer-events: none; }',
        // ⚠ Web フォントを使わない。読み込み完了の瞬間に字形が変わって
        //   「文字サイズが変わった」ように見える（実機で計測して確認）
        '#dpx-boot .dpx-boot-mark {',
        '  font: 600 22px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,',
        '        "Helvetica Neue", Arial, sans-serif;',
        '  letter-spacing: 0.34em; color: #4ea1ff; margin-bottom: 18px; min-width: 190px;',
        '  text-align: center; }',
        '#dpx-boot .dpx-boot-bar { width: 190px; height: 2px; border-radius: 2px;',
        '  background: rgba(120, 160, 220, 0.18); overflow: hidden; }',
        '#dpx-boot .dpx-boot-bar i { display: block; width: 40%; height: 100%;',
        '  border-radius: 2px;',
        '  background: linear-gradient(90deg, transparent, #4ea1ff, transparent);',
        '  animation: dpxBootSlide 1.05s ease-in-out infinite; }',
        // BootScreen.jsx（React 側スプラッシュ）もこの keyframes を使う。
        // Mako 亡き今、ここが唯一の定義元
        '@keyframes dpxBootSlide {',
        '  0%   { transform: translateX(-100%); }',
        '  100% { transform: translateX(350%); }',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  #dpx-boot .dpx-boot-bar i { animation: none; width: 100%; opacity: 0.5; }',
        '}',
    ].join('\n');
    document.head.appendChild(style);

    // ブラウザ UI（スクロールバー等）にもダークを宣言しておく
    const meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark';
    document.head.appendChild(meta);

    // (2) スプラッシュ本体（旧 Mako が出していた #dpx-boot と同一の DOM）
    showBootSplash();
})();
