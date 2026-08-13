import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePortalHost } from './DetachedWindow';
import { createURL } from '@splunk/splunk-utils/url';

// ── パネルの右クリックメニュー（表示モード）─────────────────────
//
// **これは DPX だからできる。** Studio ではパネルが iframe に隔離されていて、
// iframe 内の contextmenu を親のダッシュボードが横取りできない（イベントが
// 親に上がらないうえ、親のメニューを iframe の上に重ねる位置合わせもできない）。
// DPX は全パネルが同じ DOM ツリーにいるので、素直に実装できる。
//
// できること:
//   - このパネルのサーチを Splunk のサーチ画面で開く（新しいタブ）
//   - SPL をクリップボードにコピー
//   - 結果を CSV でダウンロード（クライアント側で生成。サーバに投げ直さない）
//   - パネルを全画面表示
//   - 手動で再実行
// ────────────────────────────────────────────────────────────────

/** Splunk のサーチ画面 URL を作る。時間範囲もそのまま引き継ぐ。
 *  ⚠ ロケール接頭辞（/en-US 等）は自分で書かず createURL に付けさせる。
 *  形式は実機で確認済み：`?q=<SPL>&earliest=..&latest=..` で
 *  サーチバーに入り、そのまま実行される（生成系 `| makeresults` も可）。 */
export function buildSearchUrl({ app, spl, earliest, latest }) {
    const q = new URLSearchParams();
    // 生成系（`|` 始まり）はそのまま。それ以外は `search ` を前置しないと検索にならない
    q.set('q', /^\s*\|/.test(spl) ? spl : `search ${spl}`);
    if (earliest) q.set('earliest', earliest);
    if (latest) q.set('latest', latest);
    return `${createURL(`app/${encodeURIComponent(app || 'search')}/search`)}?${q.toString()}`;
}

/** 列指向の {fields, columns} を CSV にする。 */
export function toCsv(data) {
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    const cols = data?.columns ?? [];
    const rows = cols[0]?.length ?? 0;
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [fields.map(esc).join(',')];
    for (let r = 0; r < rows; r += 1) {
        lines.push(cols.map((c) => esc(c[r])).join(','));
    }
    return lines.join('\n');
}

export default function PanelContextMenu({ t, x, y, items, onClose }) {
    const portalHost = usePortalHost();
    const ref = useRef(null);

    useEffect(() => {
        const onDown = (e) => {
            if (ref.current?.contains(e.target)) return;
            onClose();
        };
        const onKey = (e) => e.key === 'Escape' && onClose();
        // capture で拾う（下のパネルに先に取られないように）
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('blur', onClose);
        };
    }, [onClose]);

    // 画面端で見切れないように寄せる
    const W = 232;
    const H = items.length * 34 + 12;
    const left = Math.min(x, window.innerWidth - W - 8);
    const top = Math.min(y, window.innerHeight - H - 8);

    // ⚠ body へポータルする。パネルの祖先に transform が掛かっていると
    //   position:fixed が**その祖先を基準に解決され**、さらに overflow:hidden で
    //   切り取られてメニューが画面に出ない（DOM には在るのに見えない。実機で発生）。
    //   ポータルで外に出すのが唯一確実な回避策。
    return createPortal(
        <div
            ref={ref}
            style={{
                position: 'fixed',
                top,
                left,
                width: W,
                zIndex: 6000,
                padding: 5,
                borderRadius: 9,
                border: '1px solid rgba(140,175,235,0.28)',
                background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(12,20,38,0.99)',
                boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
            }}
        >
            {items.map((it, i) =>
                it.divider ? (
                    <div
                        key={`d${i}`}
                        style={{ height: 1, background: 'rgba(140,175,235,0.18)', margin: '4px 6px' }}
                    />
                ) : (
                    <button
                        key={it.label}
                        type="button"
                        disabled={it.disabled}
                        onClick={() => {
                            it.onClick?.();
                            onClose();
                        }}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 9,
                            width: '100%',
                            textAlign: 'left',
                            padding: '7px 9px',
                            borderRadius: 6,
                            border: 'none',
                            background: 'transparent',
                            // 破壊的な項目は赤で出す（「削除」を他と同じ見た目にしない）
                            color: it.disabled ? t.subColor : it.danger ? t.errorColor : t.textColor,
                            opacity: it.disabled ? 0.45 : 1,
                            cursor: it.disabled ? 'default' : 'pointer',
                            fontSize: 12,
                            fontFamily: 'inherit',
                        }}
                        onMouseEnter={(e) => {
                            if (!it.disabled) {
                                e.currentTarget.style.background = it.danger
                                    ? 'rgba(220,70,90,0.16)'
                                    : `${t.accent}18`;
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        <span style={{ width: 15, flex: 'none', textAlign: 'center', opacity: 0.85 }}>{it.icon}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
                        {it.hint ? <span style={{ fontSize: 10, color: t.subColor }}>{it.hint}</span> : null}
                    </button>
                )
            )}
        </div>,
        portalHost
    );
}
