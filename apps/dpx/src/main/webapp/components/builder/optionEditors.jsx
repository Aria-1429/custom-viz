import React, { useMemo } from 'react';

import { Button, ColorInput, NumberInput, Select, TextInput } from '../shared/ui';
// ⭐ DOS はデータの表現形式なので **Data 層**から取る。
//   ⚠ ここ（Property Editor の UI）に定義を置くと、値を読む側の viz が
//     Builder を import することになる（実際にその層違反が起きていた）。
import { dosToField, fieldToDos, toFieldNames } from '../data/dos';

// ── 追加の editor 型 ─────────────────────────────────────────────
// Studio 拡張 viz の config.json に出てくる editor 型のうち、DPX の
// インスペクタが素で扱えなかったものをここで実装する。
//
// 方針:
//   - Studio と「届く値の形」を合わせる。viz 側のコードを一切変えずに
//     載せ替えられることが移植の前提なので、ここが違うと意味がない。
//   - Studio の見た目は真似しない（DPX 独自 UI）。合わせるのは値の形だけ。
//
// 値の形（studio-extension-viz.md の実機検証結果に準拠）:
//   columnSelector  … DOS 文字列 `> primary | seriesByName("<列名>")`
//                     ※ 生のフィールド名ではない。ここを間違えると viz 側の
//                       パーサが黙って空を返す
//   threshold       … [{from, to, value}]（from/to は null 可＝開区間）
//   arrayOfStrings  … string[]
//   seriesColors    … string[]（色だけの配列）
//   presetSelector  … options を一括で patch する（値そのものは保存しない）
// ────────────────────────────────────────────────────────────────

const rowStyle = { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 };

const iconBtn = (t) => ({
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 5,
    border: '1px solid rgba(140,175,235,0.25)',
    background: 'transparent',
    color: t.subColor,
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
});

const hintStyle = (t) => ({ fontSize: 10, color: t.subColor, marginTop: 4, lineHeight: 1.5 });

/** 列を1つ選ぶ。候補はパネルのサーチ結果の列名。 */
export function ColumnSelector({ t, value, onChange, fields = [], dataSourceKey = 'primary' }) {
    const current = dosToField(value);
    // 結果に無い列が既に設定されている場合も選択肢に残す（サーチ実行前や
    // 時間範囲によって列が消えることがあるため、勝手に選択を捨てない）
    const options = useMemo(() => {
        const list = toFieldNames(fields);
        const withCurrent = current && !list.includes(current) ? [current, ...list] : list;
        return [
            { value: '', label: '（未設定）' },
            ...withCurrent.map((f) => ({ value: f, label: f })),
        ];
    }, [fields, current]);

    return (
        <div>
            <Select
                t={t}
                value={current}
                options={options}
                placeholder="列を選択…"
                onChange={(f) => onChange(f ? fieldToDos(f, dataSourceKey) : '')}
            />
            {options.length <= 1 ? (
                <div style={hintStyle(t)}>
                    サーチ結果がまだありません。サーチを実行すると列名が候補に出ます。
                </div>
            ) : null}
        </div>
    );
}

/** 列を複数選ぶ（columnMultiSelectionByFieldNameEditor。生のフィールド名の配列）。 */
export function ColumnMultiSelector({ t, value, onChange, fields = [] }) {
    const selected = Array.isArray(value) ? value : [];
    const names = toFieldNames(fields);
    const toggle = (f) => {
        onChange(selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f]);
    };
    if (names.length === 0) {
        return <div style={hintStyle(t)}>サーチ結果がまだありません。実行すると列が選べます。</div>;
    }
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {names.map((f) => {
                const on = selected.includes(f);
                return (
                    <button
                        key={f}
                        type="button"
                        onClick={() => toggle(f)}
                        style={{
                            padding: '3px 9px',
                            borderRadius: 999,
                            fontSize: 11,
                            cursor: 'pointer',
                            border: `1px solid ${on ? t.accent : 'rgba(140,175,235,0.3)'}`,
                            background: on ? `${t.accent}22` : 'transparent',
                            color: on ? t.accent : t.subColor,
                        }}
                    >
                        {f}
                    </button>
                );
            })}
        </div>
    );
}

/** 範囲→色（threshold）。[{from,to,value}] を保つ。 */
export function ThresholdEditor({ t, value, onChange, openRanges = true }) {
    const rows = Array.isArray(value) ? value : [];

    const patch = (i, p) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

    const add = () => {
        const last = rows[rows.length - 1];
        const from = last && last.to != null ? last.to : (last?.from ?? 0) + 100;
        // 直前の行が開区間（to=null）なら閉じてから足す
        const next = rows.map((r, j) =>
            j === rows.length - 1 && r.to == null ? { ...r, to: from } : r
        );
        onChange([...next, { from, to: null, value: '#ff5a2e' }]);
    };

    const remove = (i) => onChange(rows.filter((r, j) => j !== i));

    return (
        <div>
            {rows.length === 0 ? (
                <div style={hintStyle(t)}>しきい値がありません。「範囲を追加」で作成します。</div>
            ) : null}
            {rows.map((r, i) => (
                <div key={i} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <NumberInput
                            t={t}
                            value={r.from ?? ''}
                            onChange={(v) => patch(i, { from: v === '' || v == null ? null : Number(v) })}
                        />
                    </div>
                    <span style={{ fontSize: 10, color: t.subColor, flex: 'none' }}>以上</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <NumberInput
                            t={t}
                            value={r.to ?? ''}
                            onChange={(v) => patch(i, { to: v === '' || v == null ? null : Number(v) })}
                        />
                    </div>
                    <span style={{ fontSize: 10, color: t.subColor, flex: 'none' }}>未満</span>
                    <div style={{ flex: 'none' }}>
                        <ColorInput t={t} value={r.value} onChange={(c) => patch(i, { value: c })} />
                    </div>
                    <button type="button" style={iconBtn(t)} onClick={() => remove(i)} title="削除">
                        ×
                    </button>
                </div>
            ))}
            <Button t={t} label="＋ 範囲を追加" onClick={add} />
            {openRanges ? (
                <div style={hintStyle(t)}>空欄は「制限なし」（最初の行の下限・最後の行の上限）。</div>
            ) : null}
        </div>
    );
}

/** 文字列のリスト（arrayOfStrings）。1 行 1 要素で編集する。 */
export function StringListEditor({ t, value, onChange, placeholder = '' }) {
    const rows = Array.isArray(value) ? value : [];
    const patch = (i, v) => onChange(rows.map((r, j) => (j === i ? v : r)));
    const remove = (i) => onChange(rows.filter((r, j) => j !== i));
    const move = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= rows.length) return;
        const next = rows.slice();
        [next[i], next[j]] = [next[j], next[i]];
        onChange(next);
    };
    return (
        <div>
            {rows.map((r, i) => (
                <div key={i} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <TextInput t={t} value={r} onChange={(v) => patch(i, v)} placeholder={placeholder} />
                    </div>
                    <button type="button" style={iconBtn(t)} onClick={() => move(i, -1)} title="上へ">
                        ↑
                    </button>
                    <button type="button" style={iconBtn(t)} onClick={() => move(i, 1)} title="下へ">
                        ↓
                    </button>
                    <button type="button" style={iconBtn(t)} onClick={() => remove(i)} title="削除">
                        ×
                    </button>
                </div>
            ))}
            <Button t={t} label="＋ 追加" onClick={() => onChange([...rows, ''])} />
        </div>
    );
}

/** 色の配列（seriesColors）。系列色パレット。 */
export function SeriesColorsEditor({ t, value, onChange }) {
    const rows = Array.isArray(value) ? value : [];
    const patch = (i, c) => onChange(rows.map((r, j) => (j === i ? c : r)));
    const remove = (i) => onChange(rows.filter((r, j) => j !== i));
    return (
        <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
                {rows.map((c, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                        <ColorInput t={t} value={c} onChange={(v) => patch(i, v)} />
                        <button
                            type="button"
                            onClick={() => remove(i)}
                            title="削除"
                            style={{
                                position: 'absolute',
                                top: -6,
                                right: -6,
                                width: 16,
                                height: 16,
                                borderRadius: '50%',
                                border: 'none',
                                background: 'rgba(20,28,48,0.95)',
                                color: t.subColor,
                                fontSize: 10,
                                lineHeight: 1,
                                cursor: 'pointer',
                                padding: 0,
                            }}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
            <Button t={t} label="＋ 色を追加" onClick={() => onChange([...rows, '#4ea1ff'])} />
        </div>
    );
}

/**
 * フィールド名 → 色（`editor.seriesColorsByField`）。
 *
 * 値の形は Studio と同じ `{ フィールド名: 色 }`。
 *
 * ⚠ **`seriesColors`（配列）と混同しない。** あちらは「系列の並び順に色を当てる」
 *   ので、系列が増減すると色が総入れ替えになる。こちらは名前で結ぶので
 *   **並び順が変わっても色が付いてくる**（サーチ結果の順序が不定なときはこちら）。
 *
 * ⚠ 列は**サーチ結果から選べるようにする**（手入力だと綴り間違いで無反応になり、
 *   「効かない」と誤診する。実機で列名を打ち間違えて詰まった前例がある）。
 */
export function SeriesColorsByFieldEditor({ t, value, onChange, fields = [] }) {
    const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const keys = Object.keys(map);
    // まだ色を割り当てていない列だけを追加候補に出す
    const remaining = (Array.isArray(fields) ? fields : []).filter((f) => !keys.includes(f));
    const setColor = (k, c) => onChange({ ...map, [k]: c });
    const remove = (k) => {
        const next = { ...map };
        delete next[k];
        onChange(next);
    };
    return (
        <div>
            {keys.map((k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <div
                        title={k}
                        style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 11,
                            color: t.textColor,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {k}
                    </div>
                    <ColorInput t={t} value={map[k]} onChange={(v) => setColor(k, v)} />
                    <button
                        type="button"
                        onClick={() => remove(k)}
                        title="削除"
                        style={{
                            width: 18,
                            height: 18,
                            flex: 'none',
                            borderRadius: 4,
                            border: 'none',
                            background: 'transparent',
                            color: t.subColor,
                            fontSize: 12,
                            lineHeight: 1,
                            cursor: 'pointer',
                            padding: 0,
                        }}
                    >
                        ×
                    </button>
                </div>
            ))}
            {remaining.length > 0 ? (
                <Select
                    t={t}
                    value=""
                    options={[{ value: '', label: '＋ フィールドを追加' }].concat(
                        remaining.map((f) => ({ value: f, label: f }))
                    )}
                    onChange={(f) => {
                        if (f) setColor(f, '#4ea1ff');
                    }}
                />
            ) : null}
            {keys.length === 0 && remaining.length === 0 ? (
                <div style={{ fontSize: 10, color: t.subColor }}>
                    サーチ結果が届くと列を選べます
                </div>
            ) : null}
        </div>
    );
}

/** 複数オプションの一括切替（presetSelector）。値は保存せず options を patch する。 */
export function PresetSelector({ t, presets = [], onApplyOptions }) {
    if (!Array.isArray(presets) || presets.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {presets.map((p, i) => (
                <button
                    key={p.name ?? i}
                    type="button"
                    onClick={() => onApplyOptions(p?.value?.options ?? {})}
                    style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: 'pointer',
                        border: '1px solid rgba(140,175,235,0.3)',
                        background: 'transparent',
                        color: t.textColor,
                    }}
                >
                    {p.label ?? p.name ?? `プリセット${i + 1}`}
                </button>
            ))}
        </div>
    );
}
