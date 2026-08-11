import React, { useEffect, useRef, useState } from 'react';

import { formatSpl } from './spl';
import { loadSplSyntax, toAceSyntax } from './splSyntax';

// ── SPL エディタ（Splunk 公式の Ace＋SPL モード）─────────────────
//
// ⭐ **自前でハイライトを実装していない。** Splunk 本体のサーチバーが使っている
//    `@splunk/react-search` の Ace コンポーネントをそのまま載せている。
//    このパッケージは **Apache-2.0**（LICENSE 同梱）で、`@splunk/dashboard` の
//    依存として**すでに node_modules に入っている**（新規インストール不要）。
//    バンドルに `ace/mode/spl` と `ace/mode/spl_highlight_rules` が含まれる。
//
// ⚠ **編集中はサーチを実行しない**という SplEditor の約束はここでも守る。
//    打鍵では親に通知せず、**フォーカスを外す / Ctrl+Enter / 実行ボタン**で確定する。
//
// ⚠ Ace は DOM を直接握るので、**アンマウント時に必ず破棄**する
//    （残すとエディタが二重に生えたり、ダイアログを開くたび増える）。
// ────────────────────────────────────────────────────────────────

const MONO = 'Menlo, Consolas, monospace';

/** Ace 本体（`window.ace`）を読み込む。副作用 import なので1回で足りる。 */
function loadAce() {
    // ⚠ webpack に静的解決させる（動的な文字列だと解決できない）。
    //    このモジュール自身が `window.ace` を生やす。
    // eslint-disable-next-line global-require
    require('@splunk/react-search/components/Ace');
    return typeof window !== 'undefined' ? window.ace : null;
}

/**
 * Ace の配色を CSS で与える。
 *
 * ⚠ **`ed.setTheme('ace/theme/...')` は使えない。**
 *   Ace はテーマを**実行時に動的 import** しようとするが、webpack バンドル内では
 *   スクリプトの src からパスを推測できず失敗する:
 *     `Unable to infer path to ace from script src, use ace.config.set('basePath', ...)`
 *   このとき **エディタは出るしトークン分割も効くのに、色だけ全部黒**になる
 *   （実機で確認: distinctColors=1 / rgb(0,0,0) / class は ace_pipe など正しい）。
 *   → **トークンの class に自分で色を当てる**のが確実。
 *     ついでに DPX のテーマ色に合わせられる。
 *
 * SPL モードが出すトークン（バンドルから抽出）:
 *   command / function / operator / argument / modifier / quoted / pipe / subsearch / invalid
 */
function useAceThemeCss(t) {
    useEffect(() => {
        const id = 'dpx-ace-spl-css';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        const light = t?.colorScheme === 'light';
        const c = light
            ? {
                  fg: '#1a1c20', bg: 'transparent', gutter: '#8a93a6', gutterBg: 'rgba(0,0,0,0.03)',
                  command: '#0b6bcb', func: '#7b3fb8', op: '#c2410c', arg: '#0f766e',
                  mod: '#b45309', str: '#15803d', pipe: '#475569', sub: '#7c3aed',
                  active: 'rgba(0,0,0,0.04)', cursor: '#1a1c20', sel: 'rgba(11,107,203,0.18)',
              }
            : {
                  fg: '#dbe4f3', bg: 'transparent', gutter: '#6d7b96', gutterBg: 'rgba(255,255,255,0.03)',
                  command: '#6cc4ff', func: '#c79bff', op: '#ff9f6b', arg: '#5fd7c0',
                  mod: '#ffcf6b', str: '#8fdf8f', pipe: '#9fb3d1', sub: '#c79bff',
                  active: 'rgba(255,255,255,0.05)', cursor: '#dbe4f3', sel: 'rgba(110,170,255,0.24)',
              };
        el.textContent = `
.dpx-ace .ace_editor,.dpx-ace.ace_editor{background:${c.bg};color:${c.fg}}
.dpx-ace .ace_gutter{background:${c.gutterBg};color:${c.gutter}}
.dpx-ace .ace_gutter-active-line{background:${c.active}}
.dpx-ace .ace_active-line{background:${c.active}}
.dpx-ace .ace_cursor{color:${c.cursor}}
.dpx-ace .ace_marker-layer .ace_selection{background:${c.sel}}
.dpx-ace .ace_command{color:${c.command};font-weight:600}
.dpx-ace .ace_function{color:${c.func}}
.dpx-ace .ace_operator{color:${c.op}}
.dpx-ace .ace_argument{color:${c.arg}}
.dpx-ace .ace_modifier{color:${c.mod}}
.dpx-ace .ace_quoted{color:${c.str}}
.dpx-ace .ace_pipe{color:${c.pipe};font-weight:700}
.dpx-ace .ace_subsearch{color:${c.sub}}
.dpx-ace .ace_invalid{color:#ff7b7b;text-decoration:underline wavy}
.dpx-ace .ace_print-margin{display:none}
`;
    }, [t?.colorScheme]);
}

export default function SplAce({ t, value, onCommit, height = 120, placeholder }) {
    const hostRef = useRef(null);
    const edRef = useRef(null);
    const onCommitRef = useRef(onCommit);
    const lastPushed = useRef(value ?? '');
    const [dirty, setDirty] = useState(false);
    const [info, setInfo] = useState({ lines: 1, chars: 0 });
    const [ready, setReady] = useState(false);
    useAceThemeCss(t);

    // ⚠ ハンドラは ref 経由で呼ぶ。Ace の初期化を value 依存にすると
    //    打鍵のたびにエディタが作り直されてカーソルが飛ぶ
    onCommitRef.current = onCommit;

    // ⚠ **effect の中から呼ぶので、effect より前に定義する。**
    //    `const commitNow = …` を後ろに書くと、Ace の keybinding が
    //    先に評価されて TDZ（初期化前アクセス）で落ちる
    const commitNow = React.useCallback(() => {
        const ed = edRef.current;
        if (!ed) return;
        const text = ed.getValue();
        if (text === lastPushed.current) return;
        lastPushed.current = text;
        setDirty(false);
        onCommitRef.current?.(text);
    }, []);

    useEffect(() => {
        const ace = loadAce();
        if (!ace || !hostRef.current) {
            // 読めなかったら SplEditor 側の境界に落とす
            throw new Error('ace が読み込めませんでした');
        }
        const ed = ace.edit(hostRef.current);
        edRef.current = ed;

        // ⚠ `setTheme` は呼ばない（動的 import に失敗して色が全部黒になる）。
        //    配色は useAceThemeCss の CSS で当てる。
        // まずは素の SPL モード（パイプ・文字列は色が付く）で描画し、
        // コマンド一覧が届いたらモードを作り直して**コマンド名にも色を付ける**。
        // ⚠ 一覧の取得を待ってから描画すると、その間エディタが出ない
        const SPLMode = ace.require('ace/mode/spl')?.Mode;
        ed.session.setMode('ace/mode/spl');
        let disposed = false;
        loadSplSyntax()
            .then((syn) => {
                if (disposed || !SPLMode) return;
                // eslint-disable-next-line new-cap
                ed.session.setMode(new SPLMode(toAceSyntax(syn)));
            })
            .catch(() => {
                /* 取れなくても素のモードのまま使える */
            });
        ed.setOptions({
            fontSize: 12,
            fontFamily: MONO,
            showPrintMargin: false,
            highlightActiveLine: true,
            // 折り返すと行番号と行が対応しなくなるので折り返さない（横スクロール）
            wrap: false,
            showGutter: true,
            tabSize: 2,
            useSoftTabs: true,
        });
        ed.setValue(value ?? '', -1); // -1 = カーソルを先頭に（全選択させない）
        ed.renderer.setScrollMargin(6, 6, 0, 0);
        // ⚠ Splunk のサーチバーと違い、ここでは Enter は改行のまま使う
        //    （複数行の SPL を書くため）。確定は Ctrl/⌘+Enter。
        ed.commands.addCommand({
            name: 'dpxCommit',
            bindKey: { win: 'Ctrl-Enter', mac: 'Command-Enter' },
            exec: () => commitNow(),
        });

        const onChange = () => {
            const text = ed.getValue();
            setDirty(text !== lastPushed.current);
            setInfo({ lines: ed.session.getLength(), chars: text.length });
        };
        const onBlur = () => commitNow();
        ed.on('change', onChange);
        ed.on('blur', onBlur);
        onChange();
        setReady(true);

        return () => {
            disposed = true;
            ed.off('change', onChange);
            ed.off('blur', onBlur);
            // ⚠ 破棄しないとダイアログを開き直すたびにエディタが残る
            ed.destroy();
            edRef.current = null;
        };
        // 初期化は1回だけ。value の追従は下の effect で行う
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外から値が変わったとき（undo・データソース切替）だけ追従する。
    // ⚠ 自分の確定で戻ってきた値は書き戻さない（カーソルが先頭に飛ぶ）
    useEffect(() => {
        const ed = edRef.current;
        if (!ed) return;
        const next = value ?? '';
        if (next === lastPushed.current || next === ed.getValue()) return;
        lastPushed.current = next;
        ed.setValue(next, -1);
        setDirty(false);
    }, [value]);

    const applyFormat = () => {
        const ed = edRef.current;
        if (!ed) return;
        const formatted = formatSpl(ed.getValue());
        if (formatted === ed.getValue()) return;
        ed.setValue(formatted, -1);
        lastPushed.current = formatted;
        setDirty(false);
        onCommitRef.current?.(formatted);
    };

    return (
        <>
            <div
                style={{
                    position: 'relative',
                    height,
                    borderRadius: 6,
                    overflow: 'hidden',
                    border: `1px solid ${dirty ? `${t.accent}aa` : 'rgba(140,175,235,0.28)'}`,
                    background: t?.colorScheme === 'light' ? '#ffffff' : 'rgba(0,0,0,0.28)',
                }}
            >
                <div ref={hostRef} className="dpx-ace" style={{ position: 'absolute', inset: 0 }} />
                {/* Ace には placeholder が無いので自前で出す（空のときだけ） */}
                {ready && info.chars === 0 && placeholder ? (
                    <span
                        style={{
                            position: 'absolute',
                            left: 48,
                            top: 8,
                            fontSize: 12,
                            fontFamily: MONO,
                            color: t.subColor,
                            opacity: 0.6,
                            pointerEvents: 'none',
                        }}
                    >
                        {placeholder}
                    </span>
                ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 10, color: dirty ? t.accent : t.subColor, flex: 1, minWidth: 0 }}>
                    {dirty
                        ? '未反映：Ctrl+Enter か「実行」で反映'
                        : `${info.lines} 行 / ${info.chars} 文字`}
                </span>
                <MiniBtn t={t} onClick={applyFormat} title="パイプごとに改行して整形します">
                    整形
                </MiniBtn>
                <MiniBtn t={t} onClick={commitNow} disabled={!dirty} accent={dirty} title="サーチを実行して反映します（Ctrl+Enter）">
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
            // ⚠ Ace の blur より先に押下を拾う（onClick だけだと取りこぼす）
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
