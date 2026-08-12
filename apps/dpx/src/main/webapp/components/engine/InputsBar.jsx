import React, { useEffect, useRef, useState } from 'react';

import DateInput from './DateInput';
import TimeRangePicker from './TimeRangePicker';
import { NumberInput, Select, TextInput } from './ui';
import { useDpxTokens } from './tokens';
import { useInputChoices } from './inputChoices';

// ── DPX 入力バー ─────────────────────────────────────────────────
// definition.inputs をダッシュボード上部に描画し、トークンを設定する。
//
// 【2026-08-10 変更】編集モードでは**入力自体がキャンバス上の選択対象**になった。
//   以前はインスペクタに「入力（トークン）」セクションが常設されていたが、
//   パネルを選んでいるのに入力の設定が並ぶのは筋が悪い（Studio も入力は
//   キャンバス側で選ぶ）。クリックで選択 → 右ペインにその入力の設定だけが出る。
//   並べ替えは**ドラッグ**（インスペクタの上下ボタンではなく直接操作）。
//
// 入力型:
//   dropdown    … choices から選択 → token に値
//   multiselect … 複数選択 → token にカンマ区切り（SPL では IN() で使う）
//   text        … 自由入力
//   number      … 数値（min/max/step）
//   timerange   … Splunk 標準相当のピッカー → token.earliest / token.latest
//   date        … ★カレンダーで1日選択（Studio に無い）→ token に YYYY-MM-DD
//   daterange   … ★カレンダーで期間選択（Studio に無い）→ token.earliest / .latest
//   ⚠ 高さは全型 30px に揃える（実測して合わせた。バラつくと1行に並べたとき汚い）
// ────────────────────────────────────────────────────────────────

/** 全入力コントロールの共通の高さ。ここを変えるときは全型を実機で見比べる。 */
export const INPUT_H = 30;

function MultiSelect({ t, choices, value, onChange }) {
    const selected = String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const toggle = (v) => {
        const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
        onChange(next.join(','));
    };
    return (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', minHeight: INPUT_H }}>
            {choices.map((c) => {
                const on = selected.includes(String(c.value));
                return (
                    <button
                        key={String(c.value)}
                        type="button"
                        onClick={() => toggle(String(c.value))}
                        style={{
                            padding: '5px 11px',
                            borderRadius: 13,
                            border: `1px solid ${on ? t.accent : 'rgba(140,175,235,0.3)'}`,
                            background: on ? `${t.accent}2e` : 'transparent',
                            color: on ? t.accent : t.subColor,
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        {c.label ?? String(c.value)}
                    </button>
                );
            })}
        </div>
    );
}

/** 入力1つぶんのコントロール（型ごとの出し分け）。 */
function InputControl({ t, input, tokens, setToken, setTokens, width, definition }) {
    // 選択肢（静的 or サーチ由来）を解決する。
    // ⚠ フックなので switch より前で必ず呼ぶ（型によって呼んだり呼ばなかったりしない）。
    const { choices, loading: choicesLoading } = useInputChoices(input, definition, tokens);

    // ── サーチ由来の選択肢が届いたら、未設定のトークンを先頭の値で埋める ──
    // これが無いと、動的選択肢の入力は**永久に未選択**のままで、
    // それを参照するパネルが「トークン待ち」で止まる（実機で発生）。
    // Studio の dropdown も既定で先頭を選ぶので、その挙動に合わせる。
    // ⚠ 一度でも値が入ったら触らない（ユーザーの選択を上書きしない）。
    const current = tokens[input.token];
    const firstValue = choices[0]?.value;
    useEffect(() => {
        if (input.type !== 'dropdown') return; // multiselect は「未選択＝全部」の運用があるので埋めない
        if (current !== undefined && current !== '') return;
        if (firstValue === undefined) return;
        setToken(input.token, firstValue);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input.type, input.token, current, firstValue]);

    switch (input.type) {
        case 'dropdown':
            return (
                <Select
                    t={t}
                    value={tokens[input.token] ?? ''}
                    placeholder={choicesLoading ? '読み込み中…' : '選択…'}
                    options={choices.map((c) => ({ value: c.value, label: c.label }))}
                    onChange={(v) => setToken(input.token, v)}
                />
            );
        case 'multiselect':
            return (
                <MultiSelect
                    t={t}
                    choices={choices}
                    value={tokens[input.token]}
                    onChange={(v) => setToken(input.token, v)}
                />
            );
        case 'number':
            return (
                <NumberInput
                    t={t}
                    value={tokens[input.token] ?? ''}
                    min={input.min}
                    max={input.max}
                    step={input.step}
                    onChange={(v) => setToken(input.token, v)}
                />
            );
        case 'timerange':
            return (
                <TimeRangePicker
                    t={t}
                    width={width}
                    earliest={tokens[`${input.token}.earliest`]}
                    latest={tokens[`${input.token}.latest`]}
                    onChange={({ earliest, latest }) =>
                        setTokens({
                            [`${input.token}.earliest`]: earliest,
                            [`${input.token}.latest`]: latest,
                        })
                    }
                />
            );
        case 'date':
            return (
                <DateInput
                    t={t}
                    width={width}
                    value={tokens[input.token] ?? ''}
                    onChange={(v) => setToken(input.token, v)}
                />
            );
        case 'daterange':
            return (
                <DateInput
                    t={t}
                    mode="range"
                    width={width}
                    value={{
                        from: (tokens[`${input.token}.earliest`] ?? '').slice(0, 10),
                        to: (tokens[`${input.token}.latest`] ?? '').slice(0, 10),
                    }}
                    onChange={({ from, to }) =>
                        setTokens({
                            // その日の 00:00 〜 翌日 00:00。SPL の earliest/latest にそのまま渡せる
                            [`${input.token}.earliest`]: from ? `${from}T00:00:00` : '',
                            [`${input.token}.latest`]: to ? `${to}T23:59:59` : '',
                        })
                    }
                />
            );
        default:
            return (
                <TextInput
                    t={t}
                    value={tokens[input.token] ?? ''}
                    placeholder={input.placeholder}
                    onChange={(v) => setToken(input.token, v)}
                />
            );
    }
}

export default function InputsBar({
    definition,
    theme: t,
    editing = false,
    selectedInputId = null,
    onSelectInput,
    onReorder,
}) {
    const { tokens, setToken, setTokens, undoTokens, canUndo } = useDpxTokens();
    const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];
    const [dragIdx, setDragIdx] = useState(null);
    const [overIdx, setOverIdx] = useState(null);
    const barRef = useRef(null);

    // 表示モードで入力が無いなら、バーごと出さない（余白を作らない）
    if (inputs.length === 0 && !editing) return null;

    const commitDrop = (to) => {
        if (dragIdx == null || to == null || dragIdx === to) return;
        const next = inputs.slice();
        const [moved] = next.splice(dragIdx, 1);
        next.splice(to, 0, moved);
        onReorder?.(next);
    };

    return (
        <div
            ref={barRef}
            style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 10,
                flexWrap: 'wrap',
                marginBottom: 14,
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(140,175,235,0.16)',
                borderRadius: 10,
                minHeight: editing && inputs.length === 0 ? 56 : undefined,
            }}
        >
            {inputs.length === 0 && editing ? (
                <div style={{ fontSize: 11, color: t.subColor, alignSelf: 'center' }}>
                    入力はまだありません。ツールバーの「入力」から追加します。
                </div>
            ) : null}

            {inputs.map((input, i) => {
                const width = Number(input.width) || 190;
                const id = input.id ?? input.token;
                const isSel = editing && selectedInputId === id;
                const isOver = editing && overIdx === i && dragIdx !== null && dragIdx !== i;
                return (
                    <div
                        key={id}
                        draggable={editing}
                        onDragStart={(e) => {
                            setDragIdx(i);
                            e.dataTransfer.effectAllowed = 'move';
                            // Firefox はデータが無いと dragover が来ない
                            e.dataTransfer.setData('text/plain', id);
                        }}
                        onDragOver={(e) => {
                            if (!editing || dragIdx == null) return;
                            e.preventDefault();
                            setOverIdx(i);
                        }}
                        onDrop={(e) => {
                            if (!editing) return;
                            e.preventDefault();
                            commitDrop(i);
                            setDragIdx(null);
                            setOverIdx(null);
                        }}
                        onDragEnd={() => {
                            setDragIdx(null);
                            setOverIdx(null);
                        }}
                        onPointerDown={
                            editing
                                ? (e) => {
                                      e.stopPropagation();
                                      onSelectInput?.(id);
                                  }
                                : undefined
                        }
                        style={{
                            minWidth: 0,
                            padding: editing ? '5px 7px' : 0,
                            margin: editing ? -1 : 0,
                            borderRadius: 8,
                            cursor: editing ? 'grab' : 'default',
                            border: editing
                                ? `1px solid ${isSel ? t.accent : isOver ? `${t.accent}88` : 'transparent'}`
                                : '1px solid transparent',
                            background: isSel ? `${t.accent}14` : isOver ? `${t.accent}0a` : 'transparent',
                            opacity: dragIdx === i ? 0.45 : 1,
                            transition: 'border-color .12s ease, background .12s ease',
                        }}
                    >
                        <div
                            style={{
                                fontSize: 10,
                                color: isSel ? t.accent : t.subColor,
                                marginBottom: 4,
                                letterSpacing: '0.06em',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                            }}
                        >
                            {editing ? <span style={{ opacity: 0.65, cursor: 'grab' }}>⠿</span> : null}
                            {input.label ?? input.token}
                        </div>
                        {/* 編集中はコントロールを操作させない（選択・ドラッグを優先） */}
                        <div
                            style={{
                                width: input.type === 'multiselect' ? 'auto' : width,
                                pointerEvents: editing ? 'none' : 'auto',
                            }}
                        >
                            <InputControl
                                t={t}
                                input={input}
                                tokens={tokens}
                                setToken={setToken}
                                setTokens={setTokens}
                                width={width}
                                definition={definition}
                            />
                        </div>
                    </div>
                );
            })}

            {/* 時間ブラシ・クリック絞り込みの「1手戻す」。
                ⚠ **絞る操作には必ず戻り道を用意する**（キオスク表示に ✕ を
                  常設するのと同じ原則）。ドラッグで期間を絞ると必ず
                  「絞りすぎ」が起きるので、戻せないと時間ピッカーを手で
                  打ち直すことになり、ブラシの速さという利点が消える。
                操作されるまでは出さない（何もしていない画面にボタンを増やさない）。 */}
            {!editing && canUndo ? (
                <button
                    type="button"
                    onClick={undoTokens}
                    title="直前の絞り込み（時間ブラシ・クリック）を取り消す"
                    style={{
                        alignSelf: 'flex-end',
                        marginBottom: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        height: 30,
                        padding: '0 11px',
                        borderRadius: 8,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 11,
                        color: t.titleColor,
                        background: 'transparent',
                        border: `1px solid ${t.accent}55`,
                    }}
                >
                    <span style={{ color: t.accent }}>↩</span>
                    絞り込みを戻す
                </button>
            ) : null}
        </div>
    );
}
