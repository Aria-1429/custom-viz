import React, { useEffect, useState } from 'react';

import { applyTokens, useDpxTokens } from './tokens';

// ── 装飾 viz（サーチ不要のビルトイン）────────────────────────────
// ウォールボード・SOC 壁面の必需品。データソースを持たず、パネルに
// 置くだけで動く。deco.text はトークン展開に対応（例: "選択中: $svc$"）。
// ────────────────────────────────────────────────────────────────

export function DecoText({ options = {}, height }) {
    const { tokens } = useDpxTokens();
    const { text } = applyTokens(options.text ?? 'TEXT', tokens);
    const size = Number(options.size) || 28;
    const align = options.align || 'left';
    const color = options.color || 'inherit';
    const weight = options.bold === false ? 400 : 700;
    return (
        <div
            style={{
                height: typeof height === 'number' ? height : '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
                padding: '0 16px',
                boxSizing: 'border-box',
                overflow: 'hidden',
            }}
        >
            <span
                style={{
                    fontSize: size,
                    fontWeight: weight,
                    letterSpacing: options.wide === false ? 'normal' : '0.14em',
                    color,
                    textTransform: options.uppercase === false ? 'none' : 'uppercase',
                    whiteSpace: 'nowrap',
                    textShadow: options.glow ? `0 0 12px ${typeof color === 'string' && color !== 'inherit' ? color : '#4ea1ff'}` : 'none',
                }}
            >
                {text}
            </span>
        </div>
    );
}

DecoText.config = {
    key: 'deco.text',
    name: 'テキストラベル',
    category: 'deco',
    dataContract: { requiredDataSources: [], optionalDataSources: [] },
    optionsSchema: {
        text: { type: 'string', default: 'TEXT' },
        size: { type: 'number', default: 28 },
        align: { type: 'string', default: 'left' },
        color: { type: 'string', default: '' },
        glow: { type: 'boolean', default: false },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: 'テキスト（$トークン$ 可）', option: 'text', editor: 'editor.text' }],
                [{ label: 'サイズ(px)', option: 'size', editor: 'editor.number' }],
                [
                    {
                        label: '配置',
                        option: 'align',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { label: '左', value: 'left' },
                                { label: '中央', value: 'center' },
                                { label: '右', value: 'right' },
                            ],
                        },
                    },
                ],
                [{ label: '色', option: 'color', editor: 'editor.color' }],
                [{ label: 'グロー', option: 'glow', editor: 'editor.checkbox' }],
            ],
        },
    ],
};

export function DecoClock({ options = {}, height }) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);
    const size = Number(options.size) || 40;
    const time = now.toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        ...(options.showSeconds === false ? {} : { second: '2-digit' }),
    });
    const date = now.toLocaleDateString('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
    });
    return (
        <div
            style={{
                height: typeof height === 'number' ? height : '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                justifyContent: 'center',
                padding: '0 16px',
                boxSizing: 'border-box',
                lineHeight: 1.1,
            }}
        >
            <span style={{ fontSize: size, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
            {options.showDate === false ? null : (
                <span style={{ fontSize: Math.max(11, size * 0.3), opacity: 0.6 }}>{date}</span>
            )}
        </div>
    );
}

DecoClock.config = {
    key: 'deco.clock',
    name: '時計',
    category: 'deco',
    dataContract: { requiredDataSources: [], optionalDataSources: [] },
    optionsSchema: {
        size: { type: 'number', default: 40 },
        showSeconds: { type: 'boolean', default: true },
        showDate: { type: 'boolean', default: true },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: 'サイズ(px)', option: 'size', editor: 'editor.number' }],
                [{ label: '秒を表示', option: 'showSeconds', editor: 'editor.checkbox' }],
                [{ label: '日付を表示', option: 'showDate', editor: 'editor.checkbox' }],
            ],
        },
    ],
};
