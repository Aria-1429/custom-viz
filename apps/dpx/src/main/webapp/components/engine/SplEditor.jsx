import React, { useEffect, useRef, useState } from 'react';

import { inputStyle } from './ui';

// ── SPL エディタ（編集中はサーチを実行しない）──────────────────
//
// ⚠ 打鍵ごとに `patchSearch` すると**そのたびにサーチが走る**。
//   書きかけの SPL（`index=web | stat` 等）でジョブが飛ぶので、
//   実機に無駄な負荷がかかるうえエラー表示が点滅して読みにくい。
//
// → **編集中は手元の草稿だけを更新し、確定時にだけ定義へ反映する。**
//   確定するのは「フォーカスを外したとき」と「Ctrl/⌘ + Enter」。
//   Esc で編集前に戻す。
//
// 外から値が変わったとき（ソース編集・undo 等）は草稿を捨てて追従する。
export default function SplEditor({ t, value, onCommit, height = 120, placeholder }) {
    const [draft, setDraft] = useState(null);
    const lastProp = useRef(value);

    useEffect(() => {
        // 自分の確定で親が変わった場合は書き戻さない（カーソルが飛ぶため）
        if (value !== lastProp.current) {
            lastProp.current = value;
            setDraft(null);
        }
    }, [value]);

    const dirty = draft !== null && draft !== (value ?? '');
    const commit = () => {
        if (draft === null) return;
        if (draft !== (value ?? '')) {
            lastProp.current = draft;
            onCommit(draft);
        }
        setDraft(null);
    };

    return (
        <>
            <textarea
                className="dpx-input dpx-scroll"
                spellCheck={false}
                placeholder={placeholder}
                value={draft ?? value ?? ''}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        commit();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setDraft(null);
                        e.currentTarget.blur();
                    }
                }}
                style={{
                    ...inputStyle(t),
                    height,
                    resize: 'vertical',
                    fontFamily: 'Menlo, Consolas, monospace',
                    fontSize: 11,
                    lineHeight: 1.5,
                    borderColor: dirty ? `${t.accent}aa` : undefined,
                }}
            />
            <div style={{ fontSize: 10, color: dirty ? t.accent : t.subColor, marginTop: 3 }}>
                {dirty
                    ? '未反映：フォーカスを外すか Ctrl+Enter で実行（Esc で取り消し）'
                    : 'フォーカスを外すか Ctrl+Enter でサーチを実行します'}
            </div>
        </>
    );
}
