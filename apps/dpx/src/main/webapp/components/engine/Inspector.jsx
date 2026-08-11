import React, { useEffect, useRef, useState } from 'react';

import { BACKGROUND_OPTIONS } from './BackgroundLayer';
import ColorRulesEditor from './ColorRulesEditor';
import { getDataSources, nextSourceId, panelsUsingSource } from './dataSources';
import {
    ColumnMultiSelector,
    ColumnSelector,
    PresetSelector,
    SeriesColorsEditor,
    StringListEditor,
    ThresholdEditor,
} from './optionEditors';
import { needsChoices, normalizeChoices } from './inputChoices';
import SplEditor from './SplEditor';
import { usePanelFields } from './panelFields';
import TimeRangePicker from './TimeRangePicker';
import { DPX_PRESETS, effectivePanelColor, resolveTheme } from './themes';
import { Button, ColorInput, Field, NumberInput, Section, Select, Slider, TextInput, Toggle, inputStyle, isTransparent } from './ui';
import { VIZ_CATEGORY_LABELS, defaultVariantFor, listViz, vizEditorConfig, vizOptionsSchema } from './vizRegistry';

// ── DPX インスペクタ（編集モードの右ペイン）─────────────────────
// 折りたたみセクション構成。全コントロールは幅いっぱい（見切れ防止）で、
// ドロップダウンは自前 Select（OS 既定ポップアップを使わない）。
// viz のオプションは editorConfig からフォームを自動生成する。
// ────────────────────────────────────────────────────────────────

// editor 型 → 入力 UI
// 第5引数 ctx には、単体の値では足りない editor 向けの文脈を渡す:
//   ctx.fields         … パネルのサーチ結果の列名（列を選ぶ editor 用）
//   ctx.applyOptions   … 複数オプションの一括反映（presetSelector 用）
const EDITOR_RENDERERS = {
    'editor.colorRules': (t, value, onChange, props) => (
        <ColorRulesEditor t={t} value={value} onChange={onChange} valueHint={props?.valueHint} />
    ),
    // 列を選ぶ。値は Studio と同じ DOS 文字列で保存する（viz 側を変えないため）
    'editor.columnSelector': (t, value, onChange, props, ctx) => (
        <ColumnSelector
            t={t}
            value={value}
            onChange={onChange}
            fields={ctx?.fields ?? []}
            dataSourceKey={props?.dataSourceKey ?? 'primary'}
        />
    ),
    'editor.columnMultiSelectionByFieldNameEditor': (t, value, onChange, props, ctx) => (
        <ColumnMultiSelector t={t} value={value} onChange={onChange} fields={ctx?.fields ?? []} />
    ),
    'editor.threshold': (t, value, onChange, props) => (
        <ThresholdEditor t={t} value={value} onChange={onChange} openRanges={props?.openRanges !== false} />
    ),
    'editor.arrayOfStrings': (t, value, onChange) => <StringListEditor t={t} value={value} onChange={onChange} />,
    'editor.seriesColors': (t, value, onChange) => <SeriesColorsEditor t={t} value={value} onChange={onChange} />,
    // プリセットは「値」ではなく「複数オプションの一括適用」なので onChange を使わない
    'editor.presetSelector': (t, value, onChange, props, ctx) => (
        <PresetSelector t={t} presets={props?.presets ?? []} onApplyOptions={ctx?.applyOptions ?? (() => {})} />
    ),
    'editor.text': (t, value, onChange) => <TextInput t={t} value={value} onChange={onChange} />,
    'editor.number': (t, value, onChange, props) => (
        <NumberInput t={t} value={value} onChange={onChange} min={props?.min} max={props?.max} step={props?.step} />
    ),
    'editor.checkbox': (t, value, onChange) => <Toggle t={t} checked={Boolean(value)} onChange={onChange} />,
    'editor.toggle': (t, value, onChange) => <Toggle t={t} checked={Boolean(value)} onChange={onChange} />,
    'editor.select': (t, value, onChange, props) => (
        <Select
            t={t}
            value={value ?? ''}
            options={(props?.values ?? []).map((v) => ({ value: v.value, label: v.label ?? String(v.value) }))}
            onChange={onChange}
        />
    ),
    'editor.radioBar': (t, value, onChange, props) => EDITOR_RENDERERS['editor.select'](t, value, onChange, props),
    'editor.color': (t, value, onChange) => <ColorInput t={t} value={value} onChange={onChange} />,
    'editor.slider': (t, value, onChange, props) => (
        <Slider t={t} value={value} onChange={onChange} min={props?.min} max={props?.max} step={props?.step} />
    ),
};

// チェックボックス系はラベルを右に置く（トグルは幅を取らない）
const INLINE_EDITORS = new Set(['editor.checkbox', 'editor.toggle']);

const smallBtn = (t) => ({
    width: 24,
    height: 24,
    flex: 'none',
    borderRadius: 5,
    border: '1px solid rgba(140,175,235,0.25)',
    background: 'transparent',
    color: t.subColor,
    fontSize: 11,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
});

function OptionsForm({ t, vizType, options, onOptionChange, fields, onApplyOptions }) {
    const editorConfig = vizEditorConfig(vizType);
    const schema = vizOptionsSchema(vizType);
    if (!editorConfig) {
        return <div style={{ fontSize: 12, color: t.subColor }}>この viz にオプションはありません。</div>;
    }
    const ctx = { fields: fields ?? [], applyOptions: onApplyOptions };
    const unsupported = [];
    return (
        <>
            {editorConfig.map((section, si) => (
                <div key={si} style={{ marginBottom: si < editorConfig.length - 1 ? 10 : 0 }}>
                    {editorConfig.length > 1 ? (
                        <div style={{ fontSize: 10, color: t.subColor, marginBottom: 6, letterSpacing: '0.08em' }}>
                            {section.label ?? ''}
                        </div>
                    ) : null}
                    {(section.layout ?? []).flat().map((item, ii) => {
                        const render = EDITOR_RENDERERS[item.editor];
                        if (!render) {
                            unsupported.push(item);
                            return null;
                        }
                        const value = options?.[item.option] ?? schema?.[item.option]?.default;
                        return (
                            <Field
                                // presetSelector のように option を持たない項目があるのでキーを補う
                                key={item.option ?? `${item.editor}-${si}-${ii}`}
                                t={t}
                                label={item.label ?? item.option ?? ''}
                                inline={INLINE_EDITORS.has(item.editor)}
                            >
                                {render(t, value, (v) => onOptionChange(item.option, v), item.editorProps, ctx)}
                            </Field>
                        );
                    })}
                </div>
            ))}
            {unsupported.length > 0 ? (
                <div style={{ fontSize: 10, color: t.subColor }}>
                    フォーム未対応: {unsupported.map((u) => u.label ?? u.option).join(' / ')}（JSON で編集できます）
                </div>
            ) : null}
        </>
    );
}

function OptionsJson({ t, panel, patchPanel }) {
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(null);
    return (
        <>
            <textarea
                className="dpx-input dpx-scroll"
                spellCheck={false}
                value={draft ?? JSON.stringify(panel.options ?? {}, null, 2)}
                onChange={(e) => {
                    setDraft(e.target.value);
                    try {
                        JSON.parse(e.target.value);
                        setError(null);
                    } catch (err) {
                        setError('JSON エラー');
                    }
                }}
                onBlur={() => {
                    if (draft == null) return;
                    try {
                        patchPanel(panel.id, { options: JSON.parse(draft) });
                        setError(null);
                    } catch {
                        /* 不正な間は反映しない */
                    }
                    setDraft(null);
                }}
                style={{
                    ...inputStyle(t),
                    height: 90,
                    resize: 'vertical',
                    fontFamily: 'Menlo, Consolas, monospace',
                    fontSize: 11,
                }}
            />
            {error ? <div style={{ fontSize: 10, color: t.errorColor, marginTop: 3 }}>{error}</div> : null}
        </>
    );
}

/** パネルの時間範囲設定。
 *  「プリセットから選ぶ」か「時間範囲入力から受け取る」かを選択できる。
 *  後者は earliest/latest に `$<token>.earliest$` / `$<token>.latest$` を入れる
 *  （トークン置換はエンジン側が行う）。 */
// ── 共有データソースの一覧・編集（ダッシュボード単位）─────────────
function DataSourcesEditor({ t, definition, patchDef }) {
    const sources = getDataSources(definition);
    const ids = Object.keys(sources);

    const patchSource = (id, patch) =>
        patchDef({ dataSources: { ...sources, [id]: { ...sources[id], ...patch } } });

    const addSource = () => {
        const id = nextSourceId(definition);
        patchDef({
            dataSources: {
                ...sources,
                [id]: { name: `データソース ${ids.length + 1}`, spl: '', earliest: '-24h', latest: 'now' },
            },
        });
    };

    const removeSource = (id) => {
        const used = panelsUsingSource(definition, id);
        if (used.length > 0) {
            const ok = window.confirm(
                `${used.length} 個のパネル（${used.join(', ')}）がこのデータソースを使っています。削除するとそれらは表示できなくなります。続けますか？`
            );
            if (!ok) return;
        }
        const next = { ...sources };
        delete next[id];
        patchDef({ dataSources: next });
    };

    if (ids.length === 0) {
        return (
            <>
                <div style={{ fontSize: 11, color: t.subColor, marginBottom: 8, lineHeight: 1.6 }}>
                    同じサーチを複数パネルで使い回せます。パネル側で「サーチ元」に選ぶだけで、
                    <b>サーチは1回だけ実行</b>されます。
                </div>
                <Button t={t} label="＋ データソースを追加" onClick={addSource} full />
            </>
        );
    }

    return (
        <>
            {ids.map((id) => {
                const s = sources[id];
                const used = panelsUsingSource(definition, id);
                return (
                    <div
                        key={id}
                        style={{
                            border: '1px solid rgba(140,175,235,0.2)',
                            borderRadius: 8,
                            padding: 9,
                            marginBottom: 9,
                        }}
                    >
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <TextInput
                                    t={t}
                                    value={s.name ?? id}
                                    placeholder="表示名"
                                    onChange={(v) => patchSource(id, { name: v })}
                                />
                            </div>
                            <button
                                type="button"
                                style={smallBtn(t)}
                                title="削除"
                                onClick={() => removeSource(id)}
                            >
                                ×
                            </button>
                        </div>
                        <textarea
                            className="dpx-input dpx-scroll"
                            spellCheck={false}
                            value={s.spl ?? ''}
                            placeholder="index=… | stats count by host"
                            onChange={(e) => patchSource(id, { spl: e.target.value })}
                            style={{
                                ...inputStyle(t),
                                height: 84,
                                resize: 'vertical',
                                fontFamily: 'Menlo, Consolas, monospace',
                                fontSize: 11,
                                lineHeight: 1.5,
                            }}
                        />
                        <div style={{ fontSize: 10, color: t.subColor, marginTop: 5 }}>
                            <code>{id}</code> ／ 使用中: {used.length > 0 ? `${used.length} パネル` : 'なし'}
                        </div>
                    </div>
                );
            })}
            <Button t={t} label="＋ データソースを追加" onClick={addSource} full />
        </>
    );
}

// ── パネルのサーチ元（データソース参照のみ）─────────────────────
// **サーチはパネルに直書きしない**（v0.4.0 で統一）。同じ SPL が複数パネルに
// 散らばると管理できなくなるため、パネルは必ずデータソースを参照する。
// Studio のように ds.search / ds.chain と型は分けず、「参照＋後続パイプ」に畳んである。
function PanelSearchSource({ t, panel, definition, patchSearch, patchDef, onOpenDataSources }) {
    const sources = getDataSources(definition);
    const ids = Object.keys(sources);
    const currentRef = panel.search?.ref;
    const missing = currentRef && !sources[currentRef];

    // データソースを作ってこのパネルに割り当てる（空のサーチから始める）
    const createAndAssign = () => {
        const id = nextSourceId(definition);
        patchDef({
            dataSources: { ...sources, [id]: { name: panel.title || id, spl: '' } },
        });
        patchSearch(panel.id, { ref: id, spl: undefined });
        onOpenDataSources?.();
    };

    return (
        <>
            <Field t={t} label="データソース" hint="サーチ本体は上部の「データソース」で編集します">
                <Select
                    t={t}
                    value={currentRef ?? ''}
                    placeholder={ids.length ? 'データソースを選択…' : '（まだありません）'}
                    options={[
                        ...ids.map((id) => ({ value: id, label: sources[id].name || id })),
                        { value: '__new__', label: '＋ 新しいデータソースを作る' },
                    ]}
                    onChange={(v) => {
                        if (v === '__new__') createAndAssign();
                        else patchSearch(panel.id, { ref: v, spl: undefined });
                    }}
                />
            </Field>

            {missing ? (
                <div style={{ fontSize: 11, color: t.errorColor ?? '#ff7b7b', marginTop: -4, marginBottom: 10 }}>
                    参照先のデータソース「{currentRef}」がありません。選び直してください。
                </div>
            ) : null}

            <Field
                t={t}
                label="このパネルだけの絞り込み（後続パイプ・任意）"
                hint="例: | where status>=500  ※ | search は 0 行になるので使わない"
            >
                <TextInput
                    t={t}
                    mono
                    value={panel.search?.postSearch ?? ''}
                    placeholder="| where …"
                    onChange={(v) => patchSearch(panel.id, { postSearch: v })}
                />
            </Field>
            <div style={{ marginBottom: 10 }}>
                <Button t={t} label="データソースを編集…" onClick={() => onOpenDataSources?.()} full />
            </div>
        </>
    );
}

function PanelTimeRange({ t, panel, definition, patchSearch }) {
    const timeInputs = (definition.inputs ?? []).filter((x) => x.type === 'timerange' && x.token);
    const e = panel.search?.earliest ?? '-24h';
    const l = panel.search?.latest ?? 'now';
    // $tok.earliest$ の形かどうかでモードを判定する
    const tokenMatch = String(e).match(/^\$([A-Za-z0-9_.]+)\.earliest\$$/);
    const boundToken = tokenMatch ? tokenMatch[1] : null;
    const mode = boundToken ? 'input' : 'preset';

    const options = [
        { value: 'preset', label: 'このパネルで指定する' },
        ...(timeInputs.length > 0
            ? [{ value: 'input', label: '入力から受け取る' }]
            : [{ value: 'input', label: '入力から受け取る（時間範囲入力が未作成）' }]),
    ];

    return (
        <>
            <Field t={t} label="時間範囲の決め方">
                <Select
                    t={t}
                    value={mode}
                    options={options}
                    onChange={(v) => {
                        if (v === 'input') {
                            const tok = timeInputs[0]?.token;
                            if (!tok) return; // 入力が無ければ何もしない（ラベルで案内済み）
                            patchSearch(panel.id, { earliest: `$${tok}.earliest$`, latest: `$${tok}.latest$` });
                        } else {
                            patchSearch(panel.id, { earliest: '-24h', latest: 'now' });
                        }
                    }}
                />
            </Field>
            {mode === 'input' ? (
                <Field t={t} label="受け取る入力" hint={`$${boundToken}.earliest$ / $${boundToken}.latest$`}>
                    <Select
                        t={t}
                        value={boundToken ?? ''}
                        options={timeInputs.map((x) => ({
                            value: x.token,
                            label: `${x.label ?? x.token}（$${x.token}$）`,
                        }))}
                        onChange={(tok) =>
                            patchSearch(panel.id, { earliest: `$${tok}.earliest$`, latest: `$${tok}.latest$` })
                        }
                    />
                </Field>
            ) : (
                <Field t={t} label="時間範囲">
                    <TimeRangePicker
                        t={t}
                        width="100%"
                        earliest={e}
                        latest={l}
                        onChange={({ earliest, latest }) => patchSearch(panel.id, { earliest, latest })}
                    />
                </Field>
            )}
        </>
    );
}


// ── 入力の選択肢エディタ（静的 / サーチ由来）──────────────────────
//
// 【2026-08-11 変更】`値|ラベル` の1行記法を廃止した。
// 色ルールで同じ理由（区切り記号をユーザーに覚えさせるのは負担）で廃止済みなのに、
// 入力側に残っていた。**値とラベルは別々の入力欄**にする。
//
// あわせて **サーチによる動的選択肢**（Studio 相当）を追加。
// 「ホスト一覧をサーチで出す」ような使い方ができる。

function ChoicesEditor({ t, input, definition, patchInput }) {
    const mode = input.choicesMode === 'search' ? 'search' : 'static';
    const rows = normalizeChoices(input.choices);
    const cs = input.choiceSearch ?? {};
    const sources = getDataSources(definition);
    const sourceIds = Object.keys(sources);

    const setRows = (next) => patchInput({ choices: next });
    const patchRow = (i, patch) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    const patchSearch2 = (patch) => patchInput({ choiceSearch: { ...cs, ...patch } });

    return (
        <>
            <Field t={t} label="選択肢の作り方">
                <Select
                    t={t}
                    value={mode}
                    options={[
                        { value: 'static', label: '固定（手で並べる）' },
                        { value: 'search', label: 'サーチ結果から作る' },
                    ]}
                    onChange={(v) => patchInput({ choicesMode: v })}
                />
            </Field>

            {mode === 'static' ? (
                <>
                    <div style={{ fontSize: 11, color: t.subColor, marginBottom: 6 }}>
                        「値」がトークンに入り、「表示名」が画面に出ます。
                    </div>
                    {rows.map((r, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <TextInput
                                    t={t}
                                    value={r.value}
                                    placeholder="値"
                                    onChange={(v) => patchRow(i, { value: v })}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <TextInput
                                    t={t}
                                    value={r.label}
                                    placeholder="表示名"
                                    onChange={(v) => patchRow(i, { label: v })}
                                />
                            </div>
                            <button
                                type="button"
                                style={smallBtn(t)}
                                title="削除"
                                onClick={() => setRows(rows.filter((_, k) => k !== i))}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <div style={{ marginBottom: 10 }}>
                        <Button
                            t={t}
                            label="＋ 選択肢を追加"
                            full
                            onClick={() => setRows([...rows, { value: '', label: '' }])}
                        />
                    </div>
                </>
            ) : (
                <>
                    <Field t={t} label="サーチ元">
                        <Select
                            t={t}
                            value={cs.ref ? cs.ref : '__inline__'}
                            options={[
                                ...sourceIds.map((id) => ({ value: id, label: `共有: ${sources[id].name || id}` })),
                                { value: '__inline__', label: 'ここに直接書く' },
                            ]}
                            onChange={(v) =>
                                patchSearch2(v === '__inline__' ? { ref: undefined } : { ref: v, spl: undefined })
                            }
                        />
                    </Field>
                    {cs.ref ? null : (
                        <Field t={t} label="SPL" hint="例: index=web | stats count by host">
                            <SplEditor
                                t={t}
                                height={76}
                                value={cs.spl ?? ''}
                                onCommit={(v) => patchSearch2({ spl: v })}
                            />
                        </Field>
                    )}
                    <Field t={t} label="値にする列" hint="トークンに入る列。空なら1列目">
                        <TextInput t={t} value={cs.valueField ?? ''} onChange={(v) => patchSearch2({ valueField: v })} />
                    </Field>
                    <Field t={t} label="表示名にする列" hint="空なら値と同じ">
                        <TextInput t={t} value={cs.labelField ?? ''} onChange={(v) => patchSearch2({ labelField: v })} />
                    </Field>
                    <Field t={t} label="先頭に足す固定の選択肢" hint="「すべて」のような行を先頭に置きたいとき">
                        <div>
                            {normalizeChoices(input.staticChoicesFirst).map((r, i) => (
                                // eslint-disable-next-line react/no-array-index-key
                                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <TextInput
                                            t={t}
                                            value={r.value}
                                            placeholder="値"
                                            onChange={(v) =>
                                                patchInput({
                                                    staticChoicesFirst: normalizeChoices(
                                                        input.staticChoicesFirst
                                                    ).map((x, k) => (k === i ? { ...x, value: v } : x)),
                                                })
                                            }
                                        />
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <TextInput
                                            t={t}
                                            value={r.label}
                                            placeholder="表示名"
                                            onChange={(v) =>
                                                patchInput({
                                                    staticChoicesFirst: normalizeChoices(
                                                        input.staticChoicesFirst
                                                    ).map((x, k) => (k === i ? { ...x, label: v } : x)),
                                                })
                                            }
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        style={smallBtn(t)}
                                        onClick={() =>
                                            patchInput({
                                                staticChoicesFirst: normalizeChoices(
                                                    input.staticChoicesFirst
                                                ).filter((_, k) => k !== i),
                                            })
                                        }
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                            <Button
                                t={t}
                                label="＋ 固定の選択肢を追加"
                                full
                                onClick={() =>
                                    patchInput({
                                        staticChoicesFirst: [
                                            ...normalizeChoices(input.staticChoicesFirst),
                                            { value: '*', label: 'すべて' },
                                        ],
                                    })
                                }
                            />
                        </div>
                    </Field>
                </>
            )}
        </>
    );
}

function InputEditor({ t, input, index, definition, patchDef, onRemoved }) {
    const inputs = definition.inputs ?? [];
    const patchInput = (patch) => {
        patchDef({ inputs: inputs.map((x, j) => (j === index ? { ...x, ...patch } : x)) });
    };
    const remove = () => {
        patchDef({ inputs: inputs.filter((x, j) => j !== index) });
        onRemoved?.();
    };
    const move = (dir) => {
        const j = index + dir;
        if (j < 0 || j >= inputs.length) return;
        const next = inputs.slice();
        [next[index], next[j]] = [next[j], next[index]];
        patchDef({ inputs: next });
    };

    return (
        <div
            style={{
                border: '1px solid rgba(140,175,235,0.18)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
                background: 'rgba(0,0,0,0.15)',
            }}
        >
            {/* 並べ替えヘッダ（入力バーの表示順がそのまま変わる） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: t.subColor, flex: 1 }}>
                    {index + 1} / {inputs.length}
                </span>
                <button
                    type="button"
                    onClick={() => move(-1)}
                    disabled={index === 0}
                    title="左（上）へ"
                    style={{ ...smallBtn(t), opacity: index === 0 ? 0.3 : 1 }}
                >
                    ↑
                </button>
                <button
                    type="button"
                    onClick={() => move(1)}
                    disabled={index === inputs.length - 1}
                    title="右（下）へ"
                    style={{ ...smallBtn(t), opacity: index === inputs.length - 1 ? 0.3 : 1 }}
                >
                    ↓
                </button>
            </div>
            <Field t={t} label="種類">
                <Select
                    t={t}
                    value={input.type ?? 'dropdown'}
                    options={[
                        { value: 'dropdown', label: 'ドロップダウン' },
                        { value: 'multiselect', label: '複数選択' },
                        { value: 'text', label: 'テキスト' },
                        { value: 'number', label: '数値' },
                        { value: 'timerange', label: '時間範囲' },
                        { value: 'date', label: 'カレンダー（日付）' },
                        { value: 'daterange', label: 'カレンダー（期間）' },
                    ]}
                    onChange={(v) => patchInput({ type: v })}
                />
            </Field>
            <Field t={t} label="ラベル">
                <TextInput t={t} value={input.label} onChange={(v) => patchInput({ label: v })} />
            </Field>
            <Field t={t} label="トークン名" hint={input.type === 'timerange' ? `$${input.token || 'time'}.earliest$ / .latest$ で参照` : `$${input.token || 'token'}$ で参照`}>
                <TextInput t={t} value={input.token} onChange={(v) => patchInput({ token: v })} />
            </Field>
            {input.type === 'timerange' ? (
                <Field t={t} label="既定の時間範囲">
                    <TimeRangePicker
                        t={t}
                        width="100%"
                        earliest={(input.defaultValue ?? '-24h,now').split(',')[0]}
                        latest={(input.defaultValue ?? '-24h,now').split(',')[1]}
                        onChange={({ earliest, latest }) => patchInput({ defaultValue: `${earliest},${latest}` })}
                    />
                </Field>
            ) : (
                <Field t={t} label="既定値">
                    <TextInput t={t} value={input.defaultValue} onChange={(v) => patchInput({ defaultValue: v })} />
                </Field>
            )}
            {needsChoices(input) ? (
                <ChoicesEditor t={t} input={input} definition={definition} patchInput={patchInput} />
            ) : null}
            <Button t={t} kind="danger" label="この入力を削除" onClick={remove} />
        </div>
    );
}

export default function Inspector({
    definition,
    selectedPanel,
    selectedInputId,
    onSelectInput,
    patchDef,
    patchPanel,
    patchSearch,
    setOption,
    addPanel,
    removePanel,
    duplicatePanel,
    activeTab,
    onOpenDataSources,
}) {
    const t = resolveTheme(definition);
    // 列を選ぶ editor の候補に使う。⚠ フックなので早期 return より前に置くこと
    const { fieldsByPanel } = usePanelFields();
    const vizList = listViz();
    const vizOptions = vizList.map((v) => ({
        value: v.type,
        label: v.name,
        group: VIZ_CATEGORY_LABELS[v.category] ?? v.category,
    }));
    const tabs = definition.tabs ?? [];

    const paneStyle = {
        width: 330,
        flex: 'none',
        overflowY: 'auto',
        background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(12, 20, 38, 0.96)',
        borderLeft: '1px solid rgba(140,175,235,0.2)',
        color: t.titleColor,
        fontSize: 12,
    };

    // 入力が選ばれているときは、その入力の設定だけを出す（Studio と同じ考え方）。
    const selectedInput = (definition.inputs ?? []).find((x) => (x.id ?? x.token) === selectedInputId) ?? null;
    if (selectedInput) {
        const idx = (definition.inputs ?? []).indexOf(selectedInput);
        return (
            <div style={paneStyle} className="dpx-scroll">
                <Section t={t} title={`入力：${selectedInput.label || selectedInput.token}`}>
                    <InputEditor
                        t={t}
                        input={selectedInput}
                        index={idx}
                        definition={definition}
                        patchDef={patchDef}
                        onRemoved={() => onSelectInput?.(null)}
                    />
                </Section>
                <div style={{ padding: '0 14px 14px' }}>
                    <Button t={t} full label="選択を解除" onClick={() => onSelectInput?.(null)} />
                </div>
            </div>
        );
    }

    if (!selectedPanel) {
        return (
            <div className="dpx-scroll" style={paneStyle}>
                <Section t={t} title="ダッシュボード">
                    <Field t={t} label="タイトル">
                        <TextInput t={t} value={definition.title} onChange={(v) => patchDef({ title: v })} />
                    </Field>
                    <Field t={t} label="説明">
                        <TextInput t={t} value={definition.description} onChange={(v) => patchDef({ description: v })} />
                    </Field>
                    <Field t={t} label="見出し行">
                        <Select
                            t={t}
                            value={definition.hideHeader ? 'hide' : 'show'}
                            options={[
                                { value: 'show', label: '表示する' },
                                { value: 'hide', label: '隠す（全面レイアウト）' },
                            ]}
                            onChange={(v) => patchDef({ hideHeader: v === 'hide' })}
                        />
                    </Field>
                    <Field t={t} label="Splunk ヘッダ">
                        <Select
                            t={t}
                            value={definition.chrome ?? 'dpx'}
                            options={[
                                { value: 'dpx', label: 'DPX のみ（非表示）' },
                                { value: 'splunk', label: 'Splunk ヘッダを残す' },
                            ]}
                            onChange={(v) => patchDef({ chrome: v })}
                        />
                    </Field>
                </Section>

                <Section t={t} title="デザイン">
                    <Field t={t} label="配色プリセット">
                        <Select
                            t={t}
                            value={definition.style?.preset ?? 'midnight'}
                            options={Object.entries(DPX_PRESETS).map(([key, p]) => ({ value: key, label: p.name }))}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), preset: v } })}
                        />
                    </Field>
                    <Field t={t} label="アクセント色">
                        <ColorInput
                            t={t}
                            value={definition.style?.accent}
                            fallback={t.accent}
                            allowUnset={false}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), accent: v } })}
                        />
                    </Field>
                    <Field t={t} label="背景エフェクト">
                        <Select
                            t={t}
                            value={definition.style?.background ?? 'none'}
                            options={BACKGROUND_OPTIONS}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), background: v } })}
                        />
                    </Field>
                    <Field t={t} label="出現アニメ">
                        <Select
                            t={t}
                            value={definition.style?.entrance ?? 'rise'}
                            options={[
                                { value: 'rise', label: 'ライズ（下から）' },
                                { value: 'fade', label: 'フェード' },
                                { value: 'none', label: 'なし' },
                            ]}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), entrance: v } })}
                        />
                    </Field>

                    {/* ── 全体の質感を一度に動かす軸 ────────────────────────
                        個々のパネルを触らなくても、この3つで board 全体の
                        印象（硬い/柔らかい・詰まってる/ゆったり）が変わる。 */}
                    <Field
                        t={t}
                        label={`角の丸み（${definition.style?.radius ?? 2}px）`}
                        hint="小さいほど硬質。既定 2px"
                    >
                        <Slider
                            t={t}
                            min={0}
                            max={20}
                            step={1}
                            value={Number(definition.style?.radius ?? 2)}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), radius: v } })}
                        />
                    </Field>
                    <Field t={t} label="カギ括弧の色" hint="コーナーフレームの四隅の色">
                        <ColorInput
                            t={t}
                            value={definition.style?.bracketColor}
                            fallback={t.bracketColor}
                            allowUnset={false}
                            onChange={(v) => patchDef({ style: { ...(definition.style ?? {}), bracketColor: v } })}
                        />
                        {/* 透明にすると枠が完全に見えなくなる。「壊れた」と誤解されるので
                            意図的な設定であることを明示し、戻し方も添える */}
                        {isTransparent(definition.style?.bracketColor) ? (
                            <div style={{ fontSize: 10, color: '#ffb020', marginTop: 4, lineHeight: 1.5 }}>
                                透明のため<b>コーナーフレームは表示されません</b>。
                                「透明」ボタンをもう一度押すと戻ります。
                            </div>
                        ) : null}
                    </Field>
                    <Field
                        t={t}
                        label={`パネルの間隔（${definition.grid?.gap ?? 12}px）`}
                        hint="詰めるほど情報密度が上がる（壁面表示向け）"
                    >
                        <Slider
                            t={t}
                            min={0}
                            max={32}
                            step={1}
                            value={Number(definition.grid?.gap ?? 12)}
                            onChange={(v) => patchDef({ grid: { ...(definition.grid ?? {}), gap: v } })}
                        />
                    </Field>
                    <Field
                        t={t}
                        label={`行の高さ（${definition.grid?.rowHeight ?? 72}px）`}
                        hint="グリッド1行分の高さ"
                    >
                        <Slider
                            t={t}
                            min={40}
                            max={140}
                            step={4}
                            value={Number(definition.grid?.rowHeight ?? 72)}
                            onChange={(v) => patchDef({ grid: { ...(definition.grid ?? {}), rowHeight: v } })}
                        />
                    </Field>
                </Section>

                <Section t={t} title="タブ" defaultOpen={tabs.length > 0}>
                    <Field t={t} label="タブの配置" hint="サイドバーは Studio には無い配置です">
                        <Select
                            t={t}
                            value={definition.tabPosition === 'left' ? 'left' : 'top'}
                            options={[
                                { value: 'top', label: '上部（横並び）' },
                                { value: 'left', label: 'サイドバー（左・縦）' },
                            ]}
                            onChange={(v) => patchDef({ tabPosition: v })}
                        />
                    </Field>
                    {tabs.length === 0 ? (
                        <div style={{ fontSize: 11, color: t.subColor, marginBottom: 8 }}>
                            タブなし（全パネルが1画面）。追加するとパネルをタブに振り分けられます。
                        </div>
                    ) : (
                        tabs.map((tab, i) => (
                            <div key={tab.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <TextInput
                                        t={t}
                                        value={tab.label}
                                        onChange={(v) =>
                                            patchDef({ tabs: tabs.map((x, j) => (j === i ? { ...x, label: v } : x)) })
                                        }
                                    />
                                </div>
                                <Button
                                    t={t}
                                    kind="danger"
                                    label="×"
                                    onClick={() => {
                                        const removed = tabs[i];
                                        patchDef({
                                            tabs: tabs.filter((x, j) => j !== i),
                                            // 削除タブのパネルは先頭タブへ寄せる
                                            panels: (definition.panels ?? []).map((p) =>
                                                (p.tab ?? tabs[0]?.id) === removed.id
                                                    ? { ...p, tab: tabs.find((x, j) => j !== i)?.id }
                                                    : p
                                            ),
                                        });
                                    }}
                                />
                            </div>
                        ))
                    )}
                    <Button
                        t={t}
                        full
                        label="＋ タブを追加"
                        onClick={() => {
                            const n = tabs.length + 1;
                            const id = `tab${n}`;
                            const next = [...tabs, { id, label: `タブ ${n}` }];
                            // 初回追加時は既存パネルを最初のタブに固定する
                            const panels =
                                tabs.length === 0
                                    ? (definition.panels ?? []).map((p) => ({ ...p, tab: p.tab ?? id }))
                                    : definition.panels;
                            patchDef(tabs.length === 0 ? { tabs: [{ id, label: 'タブ 1' }], panels } : { tabs: next });
                        }}
                    />
                    {tabs.length >= 2 ? (
                        <div style={{ marginTop: 12 }}>
                            <Field t={t} label="自動送り" inline>
                                <Toggle
                                    t={t}
                                    checked={Boolean(definition.rotate?.enabled)}
                                    onChange={(v) =>
                                        patchDef({ rotate: { ...(definition.rotate ?? {}), enabled: v } })
                                    }
                                />
                            </Field>
                            {definition.rotate?.enabled ? (
                                <Field t={t} label="切替間隔（秒）">
                                    <NumberInput
                                        t={t}
                                        min={3}
                                        value={definition.rotate?.intervalSec ?? 15}
                                        onChange={(v) =>
                                            patchDef({ rotate: { ...(definition.rotate ?? {}), intervalSec: v } })
                                        }
                                    />
                                </Field>
                            ) : null}
                        </div>
                    ) : null}
                </Section>

                <Section
                    t={t}
                    title="データソース（共有サーチ）"
                    defaultOpen={Object.keys(getDataSources(definition)).length > 0}
                >
                    <DataSourcesEditor t={t} definition={definition} patchDef={patchDef} />
                </Section>

                <Section t={t} title="パネル">
                    <Button t={t} kind="primary" full label="＋ パネルを追加" onClick={() => addPanel(activeTab)} />
                    <div style={{ fontSize: 11, color: t.subColor, marginTop: 10, lineHeight: 1.6 }}>
                        パネルをクリックすると設定を編集できます。タイトルバーのドラッグで移動、右下ハンドルでリサイズ。
                        SPL・タイトル・時間範囲では <code>$トークン$</code> が使えます。
                    </div>
                </Section>
            </div>
        );
    }

    const p = selectedPanel;
    // ⚠ 質感は**描画側と同じ解決**にする（`defaultVariantFor`）。
    //    色欄の「実効値」はこの質感から導くので、ここがズレると UI が実物と食い違う。
    const panelVariant = p.style?.variant ?? defaultVariantFor(p.viz);
    return (
        <div className="dpx-scroll" style={paneStyle}>
            <Section t={t} title={`パネル：${p.title || p.id}`}>
                <Field t={t} label="タイトル">
                    <TextInput t={t} value={p.title} onChange={(v) => patchPanel(p.id, { title: v })} />
                </Field>
                <Field t={t} label="ビジュアル">
                    <Select
                        t={t}
                        value={p.viz}
                        options={vizOptions}
                        onChange={(v) => patchPanel(p.id, { viz: v, options: {} })}
                    />
                </Field>
                {tabs.length > 0 ? (
                    <Field t={t} label="所属タブ">
                        <Select
                            t={t}
                            value={p.tab ?? tabs[0].id}
                            options={tabs.map((tab) => ({ value: tab.id, label: tab.label ?? tab.id }))}
                            onChange={(v) => patchPanel(p.id, { tab: v })}
                        />
                    </Field>
                ) : null}
                <Field t={t} label="配置（列 x / 行 y / 幅 w / 高 h）">
                    <div style={{ display: 'flex', gap: 6 }}>
                        {['x', 'y', 'w', 'h'].map((k) => (
                            <input
                                key={k}
                                className="dpx-input"
                                type="number"
                                value={p[k]}
                                onChange={(e) => patchPanel(p.id, { [k]: Number(e.target.value) })}
                                style={{ ...inputStyle(t), width: 0, flex: 1, textAlign: 'center' }}
                            />
                        ))}
                    </div>
                </Field>
            </Section>

            <Section t={t} title="サーチ">
                <PanelSearchSource
                    t={t}
                    panel={p}
                    definition={definition}
                    patchSearch={patchSearch}
                    patchDef={patchDef}
                    onOpenDataSources={onOpenDataSources}
                />
                <PanelTimeRange t={t} panel={p} definition={definition} patchSearch={patchSearch} />
                <Field t={t} label="自動更新（秒・0 で無効）">
                    <NumberInput
                        t={t}
                        min={0}
                        value={p.search?.refresh ?? 0}
                        onChange={(v) => patchSearch(p.id, { refresh: v || 0 })}
                    />
                </Field>
            </Section>

            <Section t={t} title="スタイル">
                <Field t={t} label="質感">
                    <Select
                        t={t}
                        // ⚠ 既定は defaultVariantFor() から取る。描画側と同じ関数を使うこと
                        //    （別々にベタ書きして「実物は NOC なのに UI はカード」とズレた前科あり）
                        value={panelVariant}
                        options={[
                            { value: 'noc', label: 'コーナーフレーム（四隅のカギ括弧）' },
                            { value: 'bracketSolid', label: 'コーナーフレーム＋不透明' },
                            { value: 'card', label: 'カード（枠あり）' },
                            { value: 'glass', label: 'すりガラス' },
                            { value: 'solid', label: '不透明' },
                            { value: 'outline', label: '枠線のみ' },
                            { value: 'underline', label: '上線' },
                            { value: 'sideAccent', label: '左線' },
                            { value: 'inset', label: '沈み込み' },
                            { value: 'elevated', label: '浮き上がり' },
                            { value: 'frameless', label: '枠なし（透過）' },
                        ]}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), variant: v } })}
                    />
                </Field>
                <Field t={t} label="タイトルバーを表示" inline>
                    <Toggle
                        t={t}
                        checked={!(p.style?.hideTitle || p.style?.variant === 'frameless')}
                        disabled={p.style?.variant === 'frameless'}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), hideTitle: !v } })}
                    />
                </Field>
                <Field t={t} label="重なり順（z）">
                    <NumberInput
                        t={t}
                        value={p.style?.z ?? 1}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), z: v } })}
                    />
                </Field>
            </Section>

            {/* ── 1枚ごとの見た目の作り込み ────────────────────────────
                質感プリセットだけでは「もっと自由に」に応えられないので、
                パネル単位で色・角丸・発光・傾き・透過を触れるようにする。
                既定は「未指定」＝プリセットのまま（値を入れたときだけ効く）。 */}
            <Section t={t} title="見た目の詳細" defaultOpen={false}>
                <Field t={t} label="アクセント色（このパネルだけ）">
                    <ColorInput
                        t={t}
                        value={p.style?.accent ?? ''}
                        effective={effectivePanelColor('accent', t, panelVariant)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), accent: v } })}
                    />
                </Field>
                <Field t={t} label="背景色">
                    <ColorInput
                        t={t}
                        value={p.style?.bg ?? ''}
                        effective={effectivePanelColor('bg', t, panelVariant)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), bg: v } })}
                    />
                </Field>
                <Field t={t} label="枠線の色">
                    <ColorInput
                        t={t}
                        value={p.style?.borderColor ?? ''}
                        effective={effectivePanelColor('borderColor', t, panelVariant)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), borderColor: v } })}
                    />
                </Field>
                <Field t={t} label={`角の丸み（${p.style?.radius ?? t.radius}px）`}>
                    <Slider
                        t={t}
                        min={0}
                        max={36}
                        step={1}
                        value={Number(p.style?.radius ?? t.radius)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), radius: v } })}
                    />
                </Field>
                <Field t={t} label={`不透明度（${Math.round((p.style?.opacity ?? 1) * 100)}%）`}>
                    <Slider
                        t={t}
                        min={0.2}
                        max={1}
                        step={0.05}
                        value={Number(p.style?.opacity ?? 1)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), opacity: v } })}
                    />
                </Field>
                <Field t={t} label={`外側の発光（${Math.round((p.style?.glow ?? 0) * 100)}%）`}>
                    <Slider
                        t={t}
                        min={0}
                        max={1}
                        step={0.05}
                        value={Number(p.style?.glow ?? 0)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), glow: v } })}
                    />
                </Field>
                <Field
                    t={t}
                    label={`傾き（${p.style?.rotate ?? 0}°）`}
                    hint="⚠ 傾けたパネルでは全画面表示・ツールチップの位置がずれます（CSS の制約）"
                >
                    <Slider
                        t={t}
                        min={-15}
                        max={15}
                        step={0.5}
                        value={Number(p.style?.rotate ?? 0)}
                        onChange={(v) => patchPanel(p.id, { style: { ...(p.style ?? {}), rotate: v } })}
                    />
                </Field>
            </Section>

            <Section t={t} title="オプション">
                <OptionsForm
                    t={t}
                    vizType={p.viz}
                    options={p.options}
                    onOptionChange={(k, v) => setOption(p.id, k, v)}
                    fields={fieldsByPanel?.[p.id] ?? []}
                    onApplyOptions={(patch) => patchPanel(p.id, { options: { ...(p.options ?? {}), ...patch } })}
                />
                <div style={{ marginTop: 10, fontSize: 10, color: t.subColor, marginBottom: 4 }}>JSON で編集</div>
                <OptionsJson t={t} panel={p} patchPanel={patchPanel} />
            </Section>

            <Section t={t} title="インタラクション" defaultOpen={Object.keys(p.onEvent?.setTokens ?? {}).length > 0}>
                {/* ── ドリルダウン（クリックで別画面へ）────────────────
                    Studio の「リンク」相当。押した行の値を URL に差し込める。 */}
                <Field t={t} label="クリックで画面遷移する" inline>
                    <Toggle
                        t={t}
                        checked={Boolean(p.onEvent?.drilldown?.enabled)}
                        onChange={(v) =>
                            patchPanel(p.id, {
                                onEvent: {
                                    ...(p.onEvent ?? {}),
                                    drilldown: { ...(p.onEvent?.drilldown ?? {}), enabled: v },
                                },
                            })
                        }
                    />
                </Field>
                {p.onEvent?.drilldown?.enabled ? (
                    <>
                        <Field
                            t={t}
                            label="遷移先 URL"
                            hint="$トークン$ と $click.value$（押した値）が使えます。相対パス可"
                        >
                            <TextInput
                                t={t}
                                value={p.onEvent?.drilldown?.url ?? ''}
                                placeholder="app/search/search?q=index%3Dweb host%3D$click.value$"
                                onChange={(v) =>
                                    patchPanel(p.id, {
                                        onEvent: {
                                            ...(p.onEvent ?? {}),
                                            drilldown: { ...(p.onEvent?.drilldown ?? {}), url: v },
                                        },
                                    })
                                }
                            />
                        </Field>
                        <Field t={t} label="新しいタブで開く" inline>
                            <Toggle
                                t={t}
                                checked={p.onEvent?.drilldown?.newTab !== false}
                                onChange={(v) =>
                                    patchPanel(p.id, {
                                        onEvent: {
                                            ...(p.onEvent ?? {}),
                                            drilldown: { ...(p.onEvent?.drilldown ?? {}), newTab: v },
                                        },
                                    })
                                }
                            />
                        </Field>
                    </>
                ) : null}

                <div style={{ fontSize: 11, color: t.subColor, margin: '10px 0 8px' }}>
                    クリックした要素の値をトークンに入れます。
                </div>
                {Object.entries(p.onEvent?.setTokens ?? {}).map(([tok, key]) => (
                    <div key={tok} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                        <input
                            className="dpx-input"
                            value={tok}
                            onChange={(e) => {
                                const next = { ...(p.onEvent?.setTokens ?? {}) };
                                delete next[tok];
                                next[e.target.value] = key;
                                patchPanel(p.id, { onEvent: { ...(p.onEvent ?? {}), setTokens: next } });
                            }}
                            style={{ ...inputStyle(t), width: 0, flex: 1 }}
                        />
                        <span style={{ color: t.subColor, fontSize: 11 }}>←</span>
                        <input
                            className="dpx-input"
                            value={key}
                            onChange={(e) =>
                                patchPanel(p.id, {
                                    onEvent: {
                                        ...(p.onEvent ?? {}),
                                        setTokens: { ...(p.onEvent?.setTokens ?? {}), [tok]: e.target.value },
                                    },
                                })
                            }
                            style={{ ...inputStyle(t), width: 0, flex: 1 }}
                        />
                        <Button
                            t={t}
                            kind="danger"
                            label="×"
                            onClick={() => {
                                const next = { ...(p.onEvent?.setTokens ?? {}) };
                                delete next[tok];
                                patchPanel(p.id, { onEvent: { ...(p.onEvent ?? {}), setTokens: next } });
                            }}
                        />
                    </div>
                ))}
                <Button
                    t={t}
                    full
                    label="＋ トークン設定を追加"
                    onClick={() =>
                        patchPanel(p.id, {
                            onEvent: {
                                ...(p.onEvent ?? {}),
                                setTokens: { ...(p.onEvent?.setTokens ?? {}), token1: 'value' },
                            },
                        })
                    }
                />
                <div style={{ fontSize: 10, color: t.subColor, marginTop: 6 }}>
                    payload キー例: <code>value</code> / <code>name</code> / <code>row.&lt;フィールド&gt;.value</code>
                </div>
            </Section>

            <div style={{ padding: 14 }}>
                <div style={{ marginBottom: 8 }}>
                    <Button
                        t={t}
                        full
                        label="パネルを複製（Ctrl/⌘ + D）"
                        onClick={() => duplicatePanel?.(p.id)}
                    />
                </div>
                <Button t={t} kind="danger" full label="パネルを削除（Delete）" onClick={() => removePanel(p.id)} />
            </div>
        </div>
    );
}
