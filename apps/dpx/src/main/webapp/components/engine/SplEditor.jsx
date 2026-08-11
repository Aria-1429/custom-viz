import React, { useEffect, useRef, useState } from 'react';

import SplAce from './SplAce';
import { formatSpl } from './spl';
import { inputStyle } from './ui';

// ── SPL エディタ（編集中はサーチを実行しない）──────────────────
//
// ⚠ 打鍵ごとに `patchSearch` すると**そのたびにサーチが走る**。
//   書きかけの SPL（`index=web | stat` 等）でジョブが飛ぶので、
//   実機に無駄な負荷がかかるうえエラー表示が点滅して読みにくい。
//
// → **編集中は手元の草稿だけを更新し、確定時にだけ定義へ反映する。**
//   確定するのは「フォーカスを外したとき」「Ctrl/⌘ + Enter」「実行ボタン」。
//   Esc で編集前に戻す。
//
// 見やすさ（2026-08-11 改善）:
//   - **行番号**を左に出す（長い SPL でどこを見ているか分かる）
//   - **パイプで改行して整形**するボタン（1行に伸びた SPL が読めるようになる）
//   - **Tab でインデント**（既定だとフォーカスが移動してしまい書きにくい）
//   - 行数・文字数の表示
//
// **シンタックスハイライト（2026-08-11 実装）**:
//   ⭐ **Splunk 公式の SPL エディタをそのまま使う**（自前実装ではない）。
//   `@splunk/react-search`（Apache-2.0・`@splunk/dashboard` の依存で既に入っている）が
//   **Ace エディタ＋`ace/mode/spl` / `ace/mode/spl_highlight_rules` を同梱**しており、
//   これは Splunk 本体のサーチバーが使っているものと同じ。
//   → コマンド・関数・引数・文字列が本家と同じ配色で色分けされる。
//
//   ⚠ **読み込みに失敗しても編集できなくならないこと**を最優先にする。
//     Ace は DOM を直接触る重いコンポーネントなので、
//     取り込みに失敗した／例外が出た場合は**素の textarea に自動で落とす**
//     （SPL が編集できないと DPX が使い物にならないため）。
// ────────────────────────────────────────────────────────────────

const MONO = 'Menlo, Consolas, monospace';
const FONT_SIZE = 11;
const LINE_H = 1.6;
// ⚠ 行番号と本文の**縦位置を合わせるための唯一の出どころ**。
//    片方だけ変えるとズレるので、必ず両方でこの定数を使う。
const PAD_Y = 6;

export default function SplEditor({ t, value, onCommit, height = 120, placeholder, plain = false }) {
    // ハイライト付き（Ace）を既定にする。読み込めない環境では自動で下の textarea 版へ落ちる
    if (!plain) {
        return (
            <AceBoundary fallback={<PlainSplEditor t={t} value={value} onCommit={onCommit} height={height} placeholder={placeholder} />}>
                <SplAce t={t} value={value} onCommit={onCommit} height={height} placeholder={placeholder} />
            </AceBoundary>
        );
    }
    return <PlainSplEditor t={t} value={value} onCommit={onCommit} height={height} placeholder={placeholder} />;
}

/**
 * Ace が落ちても編集不能にしないための境界。
 * ⚠ **SPL が編集できない ＝ DPX が使えない**ので、ここは必ず握りつぶして
 *   素の textarea に落とす（エラーを画面に出して終わりにしない）。
 */
class AceBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(err) {
        // 開発時に気づけるようにログは残す（ユーザー操作は止めない）
        // eslint-disable-next-line no-console
        console.warn('[DPX] SPL ハイライトエディタの初期化に失敗しました。素のエディタに切り替えます。', err);
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

function PlainSplEditor({ t, value, onCommit, height = 120, placeholder }) {
    const [draft, setDraft] = useState(null);
    const lastProp = useRef(value);
    const taRef = useRef(null);
    const gutterRef = useRef(null);

    useEffect(() => {
        // 自分の確定で親が変わった場合は書き戻さない（カーソルが飛ぶため）
        if (value !== lastProp.current) {
            lastProp.current = value;
            setDraft(null);
        }
    }, [value]);

    const text = draft ?? value ?? '';
    const dirty = draft !== null && draft !== (value ?? '');
    const lines = text.split('\n');

    const commit = (next) => {
        const v = next !== undefined ? next : draft;
        if (v === null || v === undefined) return;
        if (v !== (value ?? '')) {
            lastProp.current = v;
            onCommit(v);
        }
        setDraft(null);
    };

    // 行番号は textarea と同じだけスクロールさせる（ズレると意味がない）
    const syncScroll = () => {
        if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
    };

    const applyFormat = () => {
        const formatted = formatSpl(text);
        if (formatted === text) return;
        setDraft(formatted);
        // 整形はそのまま確定してよい（意味は変わらないため）
        commit(formatted);
    };

    return (
        <>
            <div
                style={{
                    display: 'flex',
                    borderRadius: 6,
                    overflow: 'hidden',
                    border: `1px solid ${dirty ? `${t.accent}aa` : 'rgba(140,175,235,0.28)'}`,
                    background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(0,0,0,0.28)',
                }}
            >
                {/* 行番号。⚠ textarea と**同じ font/line-height** にしないと行がズレる */}
                <div
                    ref={gutterRef}
                    aria-hidden="true"
                    style={{
                        flex: 'none',
                        width: 30,
                        height,
                        overflow: 'hidden',
                        // ⚠ **textarea と縦の基準を1pxもずらさない。**
                        //    inputStyle は `padding: '0 9px'`（上下 0）なので、
                        //    行番号側に上 padding を入れると**その分だけ行番号が上にずれる**
                        //    （実機のスクリーンショットで指摘された）。
                        //    padding は上下 0 に揃え、位置合わせは PAD_Y 定数で共有する。
                        padding: `${PAD_Y}px 4px ${PAD_Y}px 0`,
                        textAlign: 'right',
                        fontFamily: MONO,
                        fontSize: FONT_SIZE,
                        lineHeight: LINE_H,
                        color: t.subColor,
                        opacity: 0.55,
                        userSelect: 'none',
                        borderRight: '1px solid rgba(140,175,235,0.16)',
                    }}
                >
                    {lines.map((_, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <div key={i}>{i + 1}</div>
                    ))}
                </div>
                <textarea
                    ref={taRef}
                    className="dpx-input dpx-scroll"
                    spellCheck={false}
                    placeholder={placeholder}
                    value={text}
                    onChange={(e) => setDraft(e.target.value)}
                    onScroll={syncScroll}
                    onBlur={() => commit()}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            commit();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setDraft(null);
                            e.currentTarget.blur();
                        } else if (e.key === 'Tab') {
                            // ⚠ 既定では Tab でフォーカスが飛ぶ。SPL は字下げして
                            //   読みやすくしたいので、ここではインデントとして扱う
                            e.preventDefault();
                            const el = e.currentTarget;
                            const { selectionStart: a, selectionEnd: b } = el;
                            const next = `${text.slice(0, a)}  ${text.slice(b)}`;
                            setDraft(next);
                            requestAnimationFrame(() => {
                                el.selectionStart = a + 2;
                                el.selectionEnd = a + 2;
                            });
                        }
                    }}
                    style={{
                        ...inputStyle(t),
                        flex: 1,
                        minWidth: 0,
                        height,
                        resize: 'vertical',
                        fontFamily: MONO,
                        fontSize: FONT_SIZE,
                        lineHeight: LINE_H,
                        // 枠は外側の div が持つので二重に描かない
                        border: 'none',
                        borderRadius: 0,
                        background: 'transparent',
                        // ⚠ inputStyle の `padding:'0 9px'` を上書きして
                        //    行番号側と**同じ上下 padding** にする（ズレの原因）
                        padding: `${PAD_Y}px 9px`,
                        // ⚠ 折り返すと行番号と行が対応しなくなる。横スクロールにする
                        whiteSpace: 'pre',
                        overflowX: 'auto',
                    }}
                />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 10, color: dirty ? t.accent : t.subColor, flex: 1, minWidth: 0 }}>
                    {dirty ? '未反映：Ctrl+Enter か「実行」で反映（Esc で取り消し）' : `${lines.length} 行 / ${text.length} 文字`}
                </span>
                <MiniBtn t={t} onClick={applyFormat} title="パイプごとに改行して整形します">
                    整形
                </MiniBtn>
                <MiniBtn
                    t={t}
                    onClick={() => commit()}
                    disabled={!dirty}
                    accent={dirty}
                    title="サーチを実行して反映します（Ctrl+Enter）"
                >
                    実行
                </MiniBtn>
            </div>
        </>
    );
}

function MiniBtn({ t, onClick, children, disabled, accent, title }) {
    return (
        <button
            type="button"
            // ⚠ textarea の blur より先に押下を拾う。onClick だけだと
            //   blur→再描画でボタンが動き、クリックが外れることがある
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            disabled={disabled}
            title={title}
            style={{
                flex: 'none',
                padding: '3px 9px',
                borderRadius: 5,
                fontSize: 10,
                fontFamily: 'inherit',
                cursor: disabled ? 'default' : 'pointer',
                border: `1px solid ${accent ? t.accent : 'rgba(140,175,235,0.28)'}`,
                background: accent ? `${t.accent}22` : 'transparent',
                color: disabled ? t.subColor : accent ? t.accent : t.titleColor,
                opacity: disabled ? 0.45 : 1,
            }}
        >
            {children}
        </button>
    );
}
