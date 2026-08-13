import React, { createContext, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// ⚠ **ポータル先の document を配るためのコンテキスト。**
//   ダイアログ類は `createPortal(..., document.body)` と書かれているが、
//   別ウィンドウの中で使うと **親ページの body** に出てしまい、
//   「ボタンを押したのに何も起きない（実は後ろの本体ページに出ている）」になる。
//   実機で再現・確認済み（2026-08-12）。
//   → 別ウィンドウ配下では**その窓の body** を配り、各ダイアログはこれを使う。
export const PortalHostContext = createContext(null);

/** ポータル先の要素を返す。別ウィンドウ内ならその窓の body、通常は現ページの body。 */
export function usePortalHost() {
    const host = useContext(PortalHostContext);
    return host ?? (typeof document === 'undefined' ? null : document.body);
}

// ── 設定を「別ウィンドウ」に出すための器 ─────────────────────────
//
// ダッシュボードを全幅で見たまま設定をいじるための浮遊ウィンドウ。
// 中身は React の children をそのまま描くだけで、何を出すかは呼び出し側が決める。
//
// ⚠ 実機で確認した事実（2026-08-12 / Splunk 10.4.2・Chromium）:
//   - `documentPictureInPicture.requestWindow()` は**開けて DOM も書ける**
//     （URL バー・ブックマークバーの無い浮遊ウィンドウ＝要件そのもの）
//   - `window.open` も同一オリジンで開けて DOM を書ける（PiP 非対応時の代替）
//   - **どちらも `document.styleSheets.length === 0`**＝**CSS を一切引き継がない**。
//     親のスタイルを明示的にコピーしないと**素の HTML の見た目**になる
// ────────────────────────────────────────────────────────────────

/**
 * 親ページのスタイルを子ウィンドウへ複製する。
 *
 * ⚠ `<link rel=stylesheet>` は**そのままコピーしても子で読み直しになる**ので
 *   要素ごと複製する。インラインの `<style>` は textContent を写す。
 * ⚠ `cssRules` へのアクセスは**別オリジンの CSS で例外**になる（Splunk の CDN 等）。
 *   try/catch で握りつぶし、読めないものは link 複製にフォールバックする。
 */
function copyStyles(srcDoc, dstDoc) {
    for (const sheet of Array.from(srcDoc.styleSheets)) {
        try {
            if (sheet.cssRules) {
                const style = dstDoc.createElement('style');
                style.textContent = Array.from(sheet.cssRules)
                    .map((r) => r.cssText)
                    .join('\n');
                dstDoc.head.appendChild(style);
            }
        } catch {
            // 読めない（クロスオリジン）ものは link を複製して子側に読ませる
            if (sheet.href) {
                const link = dstDoc.createElement('link');
                link.rel = 'stylesheet';
                link.href = sheet.href;
                dstDoc.head.appendChild(link);
            }
        }
    }
    // ⚠ 子ウィンドウは body の既定マージンを持つ。親の見た目に寄せる
    const base = dstDoc.createElement('style');
    base.textContent =
        'html,body{margin:0;padding:0;height:100%;overflow:hidden;}' +
        '*{box-sizing:border-box;}';
    dstDoc.head.appendChild(base);
}

/**
 * 別ウィンドウ（PiP 優先・window.open 代替）に children を描く。
 *
 * @param title   ウィンドウのタイトル
 * @param width   初期幅
 * @param height  初期高さ
 * @param onClose ウィンドウが閉じられたときに呼ばれる（親の state を戻す用）
 */
export default function DetachedWindow({ title = '設定', width = 420, height = 680, onClose, children }) {
    const [container, setContainer] = useState(null);

    useEffect(() => {
        let win = null;
        let closed = false;
        // ⚠ StrictMode の二重実行や再マウントで**ウィンドウが二つ開く**のを防ぐ
        let cancelled = false;

        const setup = (w) => {
            if (cancelled || !w) return;
            win = w;
            w.document.title = title;
            copyStyles(document, w.document);
            const host = w.document.createElement('div');
            host.style.height = '100%';
            w.document.body.appendChild(host);
            setContainer(host);
            // ユーザーがウィンドウを閉じたら親に知らせる（右カラムを戻すため）
            w.addEventListener('pagehide', () => {
                if (!closed) {
                    closed = true;
                    onClose?.();
                }
            });
        };

        const open = async () => {
            // 第1候補：Document Picture-in-Picture（URL バーもブックマークも無い）
            if ('documentPictureInPicture' in window) {
                try {
                    const w = await window.documentPictureInPicture.requestWindow({ width, height });
                    setup(w);
                    return;
                } catch {
                    // 非対応・ユーザー拒否・呼び出し文脈が不正 → 下へフォールバック
                }
            }
            // 代替：window.open。chrome を可能な限り削る指定を付ける
            // ⚠ 近代ブラウザは toolbar/menubar の指定を無視することがある。
            //    それでも**ポップアップ扱いになれば URL バーは細くなる**（環境依存）
            const w = window.open(
                '',
                'dpx_inspector',
                `popup=yes,width=${width},height=${height},left=${Math.max(0, (window.screen?.availWidth ?? 1200) - width - 40)},top=80`
            );
            if (!w) {
                // ポップアップブロック等で開けなかった → 親に戻す
                onClose?.();
                return;
            }
            setup(w);
        };
        open();

        return () => {
            cancelled = true;
            closed = true;
            try {
                win?.close();
            } catch {
                /* 既に閉じられている場合は何もしない */
            }
        };
        // ⚠ 依存に children を入れない（毎回ウィンドウが開き直る）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ⚠ 親ページを離れるときに子ウィンドウを閉じる（孤児ウィンドウを残さない）
    useEffect(() => {
        const bye = () => {
            try {
                container?.ownerDocument?.defaultView?.close();
            } catch {
                /* noop */
            }
        };
        window.addEventListener('beforeunload', bye);
        return () => window.removeEventListener('beforeunload', bye);
    }, [container]);

    if (!container) return null;
    // 配下のダイアログが「この窓の body」へポータルできるようにする
    return createPortal(
        <PortalHostContext.Provider value={container.ownerDocument.body}>{children}</PortalHostContext.Provider>,
        container
    );
}
