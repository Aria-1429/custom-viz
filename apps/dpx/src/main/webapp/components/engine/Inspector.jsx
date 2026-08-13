import React, { useEffect, useRef, useState } from 'react';

import { BACKGROUND_OPTIONS } from './BackgroundLayer';
import ColorRulesEditor from './ColorRulesEditor';
import { getDataSources, nextSourceId, panelsUsingSource } from './dataSources';
import { assignPanelToGroup, getGroups, groupOfPanel, nextGroupId, removeGroup } from './groups';
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
import {
    DPX_PRESETS,
    PANEL_VARIANTS,
    effectivePanelColor,
    groupVariants,
    orderedPresets,
    resolveTheme,
} from './themes';
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
/**
 * グループ（区画）1つ分の設定。
 *
 * ⚠ **グループはパネル・入力と並ぶ「選択できるもの」**（2026-08-12 ユーザー指定）。
 *   キャンバスで区画の見出しをクリックすると、右ペインがこの編集に切り替わる。
 *   ダッシュボード設定の中に一覧として埋めると、
 *   「どの区画のことか」をキャンバスと突き合わせられない。
 */
function GroupEditor({ t, group, definition, patchDef, onRemoved, onDuplicate }) {
    const groups = getGroups(definition);
    const panels = definition.panels ?? [];
    const patch = (p) => patchDef({ groups: groups.map((g) => (g.id === group.id ? { ...g, ...p } : g)) });

    const members = (group.panels ?? []).filter((id) => panels.some((p) => String(p.id) === String(id)));

    const removeSelf = () => {
        if (members.length > 0) {
            // ⚠ **枠が消えるだけでパネルは残る**ことを明示する。
            //   「パネルごと消える」と誤解させない
            const ok = window.confirm(
                `区画「${group.label || group.id}」を削除します。枠が消えるだけで、${members.length} 個のパネルは残ります。続けますか？`
            );
            if (!ok) return;
        }
        patchDef({ groups: removeGroup(definition, group.id) });
        onRemoved?.();
    };

    return (
        <>
            <Field t={t} label="区画名（空で名前なし）">
                <TextInput t={t} value={group.label ?? ''} onChange={(v) => patch({ label: v })} />
            </Field>
            <Field t={t} label="枠の質感">
                <Select
                    t={t}
                    value={group.variant ?? 'rule'}
                    // ⭐ **パネルと同じ質感を流用する**（実装も一覧も1か所）。
                    //   区画固有の「上辺の罫」だけ先頭に足す
                    options={[{ value: 'rule', label: '上辺の罫' }, ...groupVariants()]}
                    onChange={(v) => patch({ variant: v })}
                />
            </Field>
            <Field t={t} label="枠の色（空でテーマ既定）">
                <ColorInput t={t} value={group.color ?? ''} onChange={(v) => patch({ color: v })} />
            </Field>
            <Field t={t} label="外側の余白(px)">
                <Slider t={t} value={Number(group.pad ?? 8)} min={0} max={24} step={1} onChange={(v) => patch({ pad: v })} />
            </Field>

            {/* メンバー。ここで**外す**ことはできるが、入れるのはパネル側から。
                「どのパネルか」はキャンバスで見た方が早い */}
            <div style={{ fontSize: 11, color: t.subColor, margin: '10px 0 6px', lineHeight: 1.6 }}>
                {members.length === 0 ? (
                    <span style={{ color: t.errorColor }}>
                        パネルが入っていません（枠は表示されません）。パネルを選んで「スタイル」の
                        <b>所属する区画</b>で入れます。
                    </span>
                ) : (
                    <>この区画のパネル（{members.length}）</>
                )}
            </div>
            {members.map((id) => {
                const p = panels.find((x) => String(x.id) === String(id));
                return (
                    <div
                        key={id}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 8px',
                            marginBottom: 5,
                            border: '1px solid rgba(140,175,235,0.18)',
                            borderRadius: 6,
                        }}
                    >
                        <span
                            style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {p?.title || id}
                        </span>
                        <Button
                            t={t}
                            label="外す"
                            onClick={() => patchDef({ groups: assignPanelToGroup(definition, id, '') })}
                        />
                    </div>
                );
            })}

            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {/* 「同じ構成をもう1系統」を1操作で。パネルもまとめて複製する */}
                <Button
                    t={t}
                    full
                    label="区画ごと複製"
                    disabled={members.length === 0}
                    onClick={() => onDuplicate?.(group.id)}
                />
                <Button t={t} full danger label="この区画を削除" onClick={removeSelf} />
            </div>
            <div style={{ fontSize: 11, color: t.subColor, marginTop: 9, lineHeight: 1.6 }}>
                キャンバスの区画名を<b>ドラッグすると区画ごと移動</b>できます（矢印キーでも移動）。
            </div>
        </>
    );
}

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
        // 作ったばかりのデータソースを開いた状態にする
        onOpenDataSources?.(id);
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
                {/* ⚠ **このパネルが参照している** データソースを開く。
                    引数なしで開くと一覧の先頭が選ばれてしまい、
                    「パネルから飛んだのに別のサーチが出る」ことになる（実機で発生） */}
                <Button
                    t={t}
                    label="データソースを編集…"
                    onClick={() => onOpenDataSources?.(currentRef)}
                    full
                />
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

/**
 * 広いウィンドウ用のタブ切り替え。
 *
 * 縦に積んだセクションを**タブで切り替える**ことで、
 *   1) スクロールしないと辿り着けない項目を無くす
 *   2) 「今どのカテゴリを触っているか」を常に見せる（境界が曖昧という問題への答え）
 * ⚠ タブは**選択対象が変わったら先頭に戻す**（パネルAの「オプション」を見たまま
 *   パネルBに切り替わると、Bに無いタブが選ばれたままになりうる）。
 */
function WideTabs({ t, tabs }) {
    const keys = tabs.map((x) => x.key).join('|');
    const [cur, setCur] = useState(tabs[0]?.key);
    useEffect(() => {
        // 対象が変わってタブ構成が変わったら先頭に戻す
        if (!tabs.some((x) => x.key === cur)) setCur(tabs[0]?.key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keys]);
    const active = tabs.find((x) => x.key === cur) ?? tabs[0];
    return (
        <>
            <div
                style={{
                    display: 'flex',
                    gap: 2,
                    padding: '8px 10px 0',
                    borderBottom: `1px solid ${t.colorScheme === 'light' ? 'rgba(20,24,31,0.14)' : 'rgba(140,175,235,0.2)'}`,
                    flex: 'none',
                    flexWrap: 'wrap',
                }}
            >
                {tabs.map((x) => {
                    const on = x.key === active?.key;
                    return (
                        <button
                            key={x.key}
                            type="button"
                            onClick={() => setCur(x.key)}
                            style={{
                                border: 'none',
                                background: on ? `${t.accent}1f` : 'transparent',
                                // 選択中のタブだけ下線を出して「今ここ」を明示する
                                boxShadow: on ? `inset 0 -2px 0 ${t.accent}` : 'none',
                                color: on ? t.titleColor : t.subColor,
                                fontSize: 12,
                                fontWeight: on ? 700 : 500,
                                padding: '8px 14px',
                                cursor: 'pointer',
                                borderRadius: '6px 6px 0 0',
                                fontFamily: 'inherit',
                            }}
                        >
                            {x.label}
                        </button>
                    );
                })}
            </div>
            {/* ⚠ **スクロールする器と段組みの器を分ける。**
                CSS の段組みは「高さが決まっていると、あふれたぶんを**右へ新しい段**として作る」。
                そのため器自体を高さ固定＋縦スクロールにすると、
                **あふれた項目が画面外の右側に置かれて見えなくなる**
                （実機で `scrollWidth 1499 / clientWidth 1000` を実測＝オプションが切れていた原因）。
                → 外側だけを縦スクロールにし、内側の段組みには高さを与えない。
                  こうすると段は**下へ伸びて**、普通に縦スクロールで全部読める。 */}
            <div
                className="dpx-scroll"
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
            >
                <div
                    className="dpx-wide-cols"
                    style={{
                        padding: '12px 14px 20px',
                        // 幅に応じて列数が自動で決まる（メディアクエリ不要）
                        columnWidth: 320,
                        columnGap: 26,
                    }}
                >
                    {active?.content}
                </div>
            </div>
        </>
    );
}

export default function Inspector({
    definition,
    selectedPanel,
    selectedInputId,
    onSelectInput,
    // グループ（区画）＝パネル・入力と並ぶ第3の選択対象
    selectedGroupId,
    onSelectGroup,
    onDuplicateGroup,
    patchDef,
    patchPanel,
    patchSearch,
    setOption,
    addPanel,
    removePanel,
    duplicatePanel,
    activeTab,
    onOpenDataSources,
    // 別ウィンドウ用の広いレイアウト。
    // true のとき: 幅を固定せず、セクションを**タブに分けて**横に並べる。
    // 右カラム（幅 330px 固定）では縦積みのままにする（従来の見た目を変えない）。
    wide = false,
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

    // ⚠ 右カラムは幅 330px 固定。**wide のときは固定しない**
    //   （固定したままだと、別ウィンドウを広げても中身が細い1列のままで、
    //   「縦長でやりにくい」という元の問題が何も解決しない）
    const paneStyle = wide
        ? {
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(12, 20, 38, 0.96)',
              color: t.titleColor,
              fontSize: 12,
          }
        : {
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
        // ⚠ wide の paneStyle は overflow:hidden なので、
        //   スクロールする子を必ず内側に置く（入力はセクション1つなのでタブにしない）
        return (
            <div style={paneStyle} className={wide ? undefined : 'dpx-scroll'}>
            <div className="dpx-scroll" style={wide ? { flex: 1, minHeight: 0, overflowY: 'auto' } : undefined}>
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
            </div>
        );
    }

    // グループが選ばれているときは、その区画の設定だけを出す（入力と同じ考え方）
    const selectedGroup = getGroups(definition).find((g) => g.id === selectedGroupId) ?? null;
    if (selectedGroup) {
        return (
            <div style={paneStyle} className={wide ? undefined : 'dpx-scroll'}>
                <div className="dpx-scroll" style={wide ? { flex: 1, minHeight: 0, overflowY: 'auto' } : undefined}>
                    <Section t={t} title={`区画：${selectedGroup.label || selectedGroup.id}`}>
                        <GroupEditor
                            t={t}
                            group={selectedGroup}
                            definition={definition}
                            patchDef={patchDef}
                            onRemoved={() => onSelectGroup?.(null)}
                            onDuplicate={onDuplicateGroup}
                        />
                    </Section>
                    <div style={{ padding: '0 14px 14px' }}>
                        <Button t={t} full label="選択を解除" onClick={() => onSelectGroup?.(null)} />
                    </div>
                </div>
            </div>
        );
    }

    if (!selectedPanel) {
        // ⚠ パネル側と同じく、セクションを変数にして縦積み／タブで使い回す
        const dashBoard = (
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
                    {/* ダッシュボードの見出しも「左上・20px・固定」だったので、
                        パネルのタイトルと同じ粒度で位置・大きさ・質感を出す */}
                    {!definition.hideHeader ? (
                        <>
                            <Field t={t} label="タイトルの位置">
                                <Select
                                    t={t}
                                    value={definition.style?.header?.align ?? 'left'}
                                    options={[
                                        { value: 'left', label: '左' },
                                        { value: 'center', label: '中央' },
                                        { value: 'right', label: '右' },
                                    ]}
                                    onChange={(v) =>
                                        patchDef({
                                            style: {
                                                ...(definition.style ?? {}),
                                                header: { ...(definition.style?.header ?? {}), align: v },
                                            },
                                        })
                                    }
                                />
                            </Field>
                            <Field t={t} label="タイトルの質感">
                                <Select
                                    t={t}
                                    value={definition.style?.header?.skin ?? 'plain'}
                                    options={[
                                        { value: 'plain', label: '素' },
                                        { value: 'accentBar', label: '左に色帯' },
                                        { value: 'underline', label: '下線' },
                                        { value: 'filled', label: '地を敷く' },
                                        { value: 'glow', label: '発光' },
                                        { value: 'mono', label: '等幅' },
                                    ]}
                                    onChange={(v) =>
                                        patchDef({
                                            style: {
                                                ...(definition.style ?? {}),
                                                header: { ...(definition.style?.header ?? {}), skin: v },
                                            },
                                        })
                                    }
                                />
                            </Field>
                            <Field t={t} label={`タイトルの大きさ（${definition.style?.header?.size ?? 20}px）`}>
                                <Slider
                                    t={t}
                                    min={14}
                                    max={48}
                                    step={1}
                                    value={Number(definition.style?.header?.size ?? 20)}
                                    onChange={(v) =>
                                        patchDef({
                                            style: {
                                                ...(definition.style ?? {}),
                                                header: { ...(definition.style?.header ?? {}), size: v },
                                            },
                                        })
                                    }
                                />
                            </Field>
                            <Field t={t} label="右端の日付を出す" inline>
                                <Toggle
                                    t={t}
                                    checked={definition.style?.header?.stamp !== false}
                                    onChange={(v) =>
                                        patchDef({
                                            style: {
                                                ...(definition.style ?? {}),
                                                header: { ...(definition.style?.header ?? {}), stamp: v },
                                            },
                                        })
                                    }
                                />
                            </Field>
                            {/* 時計はパネルとしても置けるが、
                                「常に上に出しておきたい」用途が多いのでヘッダにも出せるようにする */}
                            <Field t={t} label="時計を表示" inline hint="パネルを置かずにヘッダへ出せます">
                                <Toggle
                                    t={t}
                                    checked={definition.style?.header?.clock === true}
                                    onChange={(v) =>
                                        patchDef({
                                            style: {
                                                ...(definition.style ?? {}),
                                                header: { ...(definition.style?.header ?? {}), clock: v },
                                            },
                                        })
                                    }
                                />
                            </Field>
                            {definition.style?.header?.clock ? (
                                <>
                                    <Field
                                        t={t}
                                        label={`時計の大きさ（${definition.style?.header?.clockSize ?? 22}px）`}
                                    >
                                        <Slider
                                            t={t}
                                            min={12}
                                            max={64}
                                            step={1}
                                            value={Number(definition.style?.header?.clockSize ?? 22)}
                                            onChange={(v) =>
                                                patchDef({
                                                    style: {
                                                        ...(definition.style ?? {}),
                                                        header: {
                                                            ...(definition.style?.header ?? {}),
                                                            clockSize: v,
                                                        },
                                                    },
                                                })
                                            }
                                        />
                                    </Field>
                                    <Field t={t} label="秒を表示" inline>
                                        <Toggle
                                            t={t}
                                            checked={definition.style?.header?.seconds !== false}
                                            onChange={(v) =>
                                                patchDef({
                                                    style: {
                                                        ...(definition.style ?? {}),
                                                        header: { ...(definition.style?.header ?? {}), seconds: v },
                                                    },
                                                })
                                            }
                                        />
                                    </Field>
                                    <Field t={t} label="日付を添える" inline>
                                        <Toggle
                                            t={t}
                                            checked={definition.style?.header?.clockDate !== false}
                                            onChange={(v) =>
                                                patchDef({
                                                    style: {
                                                        ...(definition.style ?? {}),
                                                        header: { ...(definition.style?.header ?? {}), clockDate: v },
                                                    },
                                                })
                                            }
                                        />
                                    </Field>
                                </>
                            ) : null}
                        </>
                    ) : null}
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
        );
        const dashDesign = (
                <Section t={t} title="デザイン">
                    <Field t={t} label="配色プリセット">
                        <Select
                            t={t}
                            value={definition.style?.preset ?? 'midnight'}
                            options={orderedPresets().map(([key, p]) => ({ value: key, label: p.name }))}
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
                                { value: 'none', label: 'なし' },
                                { value: 'fade', label: 'フェード' },
                                // 方角は名前から分からないので括弧を残す（説明ではなく識別情報）
                                { value: 'rise', label: 'ライズ（下から）' },
                                { value: 'drop', label: 'ドロップ（上から）' },
                                { value: 'slide', label: 'スライド（左から）' },
                                { value: 'slideRight', label: 'スライド（右から）' },
                                { value: 'zoom', label: 'ズーム（拡大）' },
                                { value: 'pop', label: 'ポップ（縮小）' },
                                { value: 'unfold', label: 'アンフォールド（縦）' },
                                { value: 'unfoldX', label: 'アンフォールド（横）' },
                                { value: 'flip', label: 'フリップ（X 軸）' },
                                { value: 'swing', label: 'スイング（Y 軸）' },
                                { value: 'tilt', label: 'ティルト' },
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
                            <div style={{ fontSize: 10, color: t.errorColor, marginTop: 4, lineHeight: 1.5 }}>
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
        );
        const dashTabs = (
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
        );
        const dashSources = (
                <Section
                    t={t}
                    title="データソース（共有サーチ）"
                    defaultOpen={Object.keys(getDataSources(definition)).length > 0}
                >
                    <DataSourcesEditor t={t} definition={definition} patchDef={patchDef} />
                </Section>
        );
        const dashPanels = (
                <Section t={t} title="パネル">
                    <Button t={t} kind="primary" full label="＋ パネルを追加" onClick={() => addPanel(activeTab)} />
                    <div style={{ fontSize: 11, color: t.subColor, marginTop: 10, lineHeight: 1.6 }}>
                        パネルをクリックすると設定を編集できます。タイトルバーのドラッグで移動、右下ハンドルでリサイズ。
                        SPL・タイトル・時間範囲では <code>$トークン$</code> が使えます。
                    </div>
                </Section>
        );

        // 広いウィンドウ：カテゴリをタブで分ける
        if (wide) {
            return (
                <div style={paneStyle}>
                    <WideTabs
                        t={t}
                        tabs={[
                            { key: 'board', label: 'ダッシュボード', content: dashBoard },
                            { key: 'design', label: 'デザイン', content: dashDesign },
                            { key: 'tabs', label: 'タブ', content: dashTabs },
                            { key: 'sources', label: 'データソース', content: dashSources },
                            { key: 'panels', label: 'パネル', content: dashPanels },
                        ]}
                    />
                </div>
            );
        }

        return (
            <div className="dpx-scroll" style={paneStyle}>
                {dashBoard}
                {dashDesign}
                {dashTabs}
                {dashSources}
                {dashPanels}
            </div>
        );
    }

    const p = selectedPanel;
    // ⚠ 質感は**描画側と同じ解決**にする（`defaultVariantFor`）。
    //    色欄の「実効値」はこの質感から導くので、ここがズレると UI が実物と食い違う。
    const panelVariant = p.style?.variant ?? defaultVariantFor(p.viz);
    // ⚠ セクションは**一度だけ書いて**、縦積み（右カラム）とタブ（別ウィンドウ）で
    //   同じものを使い回す。二重に書くと必ず片方が古くなる。
    const secPanel = (
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
    );
    const secSearch = (
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
    );
    const secStyle = (
            <Section t={t} title="スタイル">
                {/* 所属する区画。**入れるのはここから**（区画側からパネル名を選ぶ形だと
                    どれがどれか分からない。キャンバスで対象を見ながら操作させる） */}
                <Field t={t} label="所属する区画">
                    <Select
                        t={t}
                        value={groupOfPanel(definition, p.id)?.id ?? ''}
                        options={[
                            { value: '', label: '（区画に入れない）' },
                            ...getGroups(definition).map((g) => ({
                                value: g.id,
                                label: g.label || g.id,
                            })),
                        ]}
                        onChange={(v) => patchDef({ groups: assignPanelToGroup(definition, p.id, v) })}
                    />
                </Field>
                <Field t={t} label="質感">
                    <Select
                        t={t}
                        // ⚠ 既定は defaultVariantFor() から取る。描画側と同じ関数を使うこと
                        //    （別々にベタ書きして「実物は NOC なのに UI はカード」とズレた前科あり）
                        value={panelVariant}
                        // ⚠ 一覧は themes.js（panelSurface と同じファイル）から取る。
                        //   ここにベタ書きすると、質感を足したとき
                        //   「描画は対応したのに選べない」というズレが起きる
                        options={PANEL_VARIANTS}
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
                {/* タイトルは長らく「左上・固定」だった。パネルの質感は選べるのに
                    見出しだけ動かせないのは不釣り合いなので、位置と質感を出す。
                    既定（自動）は従来の見た目のままなので既存ボードは変わらない */}
                <Field t={t} label="タイトルの位置">
                    <Select
                        t={t}
                        value={p.style?.titleAlign ?? 'left'}
                        options={[
                            { value: 'left', label: '左' },
                            { value: 'center', label: '中央' },
                            { value: 'right', label: '右' },
                        ]}
                        onChange={(v) =>
                            patchPanel(p.id, {
                                style: { ...(p.style ?? {}), titleAlign: v === 'left' ? undefined : v },
                            })
                        }
                    />
                </Field>
                <Field t={t} label="タイトルの質感">
                    <Select
                        t={t}
                        value={p.style?.titleSkin ?? 'auto'}
                        options={[
                            // 「自動」だけは挙動の説明を残す（他は見た目の名前なので不要）
                            { value: 'auto', label: '自動（質感に合わせる）' },
                            { value: 'plain', label: '素' },
                            { value: 'bold', label: '太字' },
                            { value: 'control', label: '管制ラベル' },
                            { value: 'mono', label: '等幅' },
                            { value: 'underline', label: '下線' },
                            { value: 'accentBar', label: '左に色帯' },
                            { value: 'filled', label: '地を敷く' },
                            { value: 'badge', label: 'バッジ' },
                            { value: 'ribbon', label: 'リボン' },
                            { value: 'stamp', label: 'ゴム印' },
                        ]}
                        onChange={(v) =>
                            patchPanel(p.id, {
                                style: { ...(p.style ?? {}), titleSkin: v === 'auto' ? undefined : v },
                            })
                        }
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
    );
    const secDetail = (
            <Section t={t} title="見た目の詳細" defaultOpen={false}>
                <Field t={t} label="常時アニメ">
                    <Select
                        t={t}
                        value={p.style?.ambient ?? 'none'}
                        options={[
                            { value: 'none', label: 'なし' },
                            { value: 'float', label: 'ふわふわ（上下）' },
                            { value: 'breathe', label: '明滅（呼吸）' },
                        ]}
                        onChange={(v) =>
                            patchPanel(p.id, { style: { ...(p.style ?? {}), ambient: v === 'none' ? undefined : v } })
                        }
                    />
                </Field>
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
    );
    const secOptions = (
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
    );
    const secInteract = (
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
    );

    const panelActions = (
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
    );

    // 広いウィンドウ：カテゴリをタブに分ける（スクロールと境界の曖昧さを解消）
    if (wide) {
        return (
            <div style={paneStyle}>
                <WideTabs
                    t={t}
                    tabs={[
                        { key: 'panel', label: 'パネル', content: <>{secPanel}{panelActions}</> },
                        { key: 'search', label: 'サーチ', content: secSearch },
                        { key: 'style', label: 'スタイル', content: <>{secStyle}{secDetail}</> },
                        { key: 'options', label: 'オプション', content: secOptions },
                        { key: 'interact', label: 'インタラクション', content: secInteract },
                    ]}
                />
            </div>
        );
    }

    // 右カラム（従来）：縦積みのまま
    return (
        <div className="dpx-scroll" style={paneStyle}>
            {secPanel}
            {secSearch}
            {secStyle}
            {secDetail}
            {secOptions}
            {secInteract}
            {panelActions}
        </div>
    );
}
