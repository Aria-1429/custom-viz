import React from 'react';
import { createURL } from '@splunk/splunk-utils/url';

// ── Splunk へ戻るリンク（トップバー左端）────────────────────────────
// DPX は `body > header { display: none }` で Splunk のヘッダを丸ごと隠すため、
// **Splunk 本体へ戻る導線が画面上に一つも無い**（ブラウザの戻るしか無かった）。
// ここがその出口。
//
// 遷移先は Splunk のヘッダロゴと同じ `app/launcher`（実機の
// `<a data-test="header-logo" href="/en-US/app/launcher">` を確認して合わせた）。
// ⚠ ロケール接頭辞は自分で書かず **createURL に付けさせる**（§6.8 と同じ理由）。
//
// ⚠ 絵柄は Splunk のロゴ SVG を複製していない。あれは Splunk の登録商標で、
//    サードパーティのアプリにバイト単位で同梱するのは
//    「同梱素材は著作権フリーのみ」という本リポジトリの方針から外れる。
//    代わりに**方向を示す汎用のホームアイコン**を自前で描き、
//    行き先は文字（「Splunk」）で示す。
// ────────────────────────────────────────────────────────────────

/** Splunk 本体のホーム（ランチャー）。ヘッダロゴと同じ行き先。 */
export const splunkHomeHref = () => createURL('app/launcher');

function HomeIcon({ size = 15 }) {
    // 家＋左向きの含みを持たせず、素直な「ホーム」記号にする。
    // stroke は currentColor＝親の色に追随（テーマ切替で色が取り残されない）
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ flex: 'none', display: 'block' }}
        >
            <path d="M2.2 6.8 8 2.2l5.8 4.6" />
            <path d="M3.8 8v5.4h8.4V8" />
        </svg>
    );
}

/**
 * Splunk へ戻るボタン。
 *
 * DPX 内の遷移と違い**これは Splunk 本体へ出る**ので、SPA 遷移ではなく
 * 素の `<a href>`（フルロード）にしている。onClick で preventDefault しないので
 * Ctrl/⌘ クリックの別タブもそのまま効く。
 */
export default function SplunkHomeLink({ t, compact = false }) {
    const [hover, setHover] = React.useState(false);
    const light = t?.colorScheme === 'light';
    // ⚠ 地の色はテーマで分ける。決め打ちだと light / paper で文字が読めなくなる
    //   （トップバー本体で実際に踏んだ轍。§5 の注意書きと同じ）
    const base = light ? 'rgba(20,24,31,0.62)' : 'rgba(232,238,252,0.62)';
    const hoverBg = light ? 'rgba(20,24,31,0.07)' : 'rgba(140,175,235,0.14)';
    const border = light ? 'rgba(20,24,31,0.18)' : 'rgba(140,175,235,0.28)';

    return (
        <a
            href={splunkHomeHref()}
            title="Splunk のホームへ戻る"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 26,
                padding: compact ? '0 8px' : '0 10px',
                borderRadius: 6,
                border: `1px solid ${hover ? border : 'transparent'}`,
                background: hover ? hoverBg : 'transparent',
                color: hover ? t?.titleColor ?? base : base,
                fontSize: 11.5,
                lineHeight: 1,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                // 色と背景だけを遷移させる（影・フィルタは animate しない。§7.1）
                transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
            }}
        >
            <HomeIcon />
            {compact ? null : <span>Splunk</span>}
        </a>
    );
}
