import React from 'react';

import { COLOR_PALETTES, defaultColorRules, resolveColorRules, samplePalette } from './colorRules';
import { Button, Select, inputStyle } from './ui';

// ── 値→色の設定エディタ（Splunk 標準の「動的色設定」に相当）─────
// 構成:
//   メソッド : 範囲（数値のしきい値）/ 一致（文字列）をセグメント切替
//   パレット : プリセットから一括適用（範囲モード）
//   行編集   : 範囲＝しきい値の数値、一致＝値そのもの（区切り記号は不要）
//
// 「crit|重大」のような記法は廃止。同じ色にしたい値は行を分けて同じ色を選ぶ。
// ────────────────────────────────────────────────────────────────

function Segmented({ t, value, options, onChange }) {
    return (
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(140,175,235,0.28)' }}>
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        onClick={() => onChange(o.value)}
                        style={{
                            flex: 1,
                            padding: '6px 4px',
                            border: 'none',
                            borderLeft: o.value === options[0].value ? 'none' : '1px solid rgba(140,175,235,0.22)',
                            background: on ? `${t.accent}2e` : 'transparent',
                            color: on ? t.accent : t.subColor,
                            fontSize: 11,
                            fontWeight: on ? 700 : 400,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

function PaletteBar({ colors, onClick, title }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            style={{
                display: 'flex',
                width: '100%',
                height: 22,
                borderRadius: 5,
                overflow: 'hidden',
                border: '1px solid rgba(140,175,235,0.28)',
                cursor: onClick ? 'pointer' : 'default',
                padding: 0,
                background: 'transparent',
            }}
        >
            {colors.map((c, i) => (
                <span key={i} style={{ flex: 1, background: c }} />
            ))}
        </button>
    );
}

const iconBtn = (t) => ({
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 5,
    border: '1px solid rgba(140,175,235,0.25)',
    background: 'transparent',
    color: t.subColor,
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
});

const swatch = (color) => ({
    width: 28,
    height: 26,
    flex: 'none',
    padding: 0,
    border: '1px solid rgba(140,175,235,0.28)',
    borderRadius: 5,
    background: 'transparent',
    cursor: 'pointer',
});

export default function ColorRulesEditor({ t, value, onChange, valueHint = '値' }) {
    const cfg = resolveColorRules(value, defaultColorRules('range'));
    const isRange = cfg.mode === 'range';
    const isGradient = cfg.mode === 'gradient';

    const setCfg = (patch) => onChange({ ...cfg, ...patch });

    // ── 範囲モード ────────────────────────────────────────────
    // thresholds を昇順に保ち、colors は thresholds.length + 1 個に揃える
    const normalizeRange = (thresholds, colors, palette) => {
        const th = thresholds.slice().sort((a, b) => a - b);
        const need = th.length + 1;
        let cols = (colors ?? []).slice(0, need);
        if (cols.length < need) {
            cols = samplePalette(palette ?? cfg.palette ?? 'trafficDark', need);
        }
        return { thresholds: th, colors: cols };
    };

    const applyPalette = (paletteId) => {
        const need = (cfg.thresholds ?? []).length + 1;
        setCfg({ palette: paletteId, colors: samplePalette(paletteId, need) });
    };

    const addThreshold = () => {
        const th = (cfg.thresholds ?? []).slice();
        const last = th.length > 0 ? th[th.length - 1] : 0;
        th.push(last + 20);
        setCfg(normalizeRange(th, [...(cfg.colors ?? []), null].filter(Boolean), cfg.palette));
    };

    const removeThreshold = (i) => {
        const th = (cfg.thresholds ?? []).filter((x, j) => j !== i);
        const colors = (cfg.colors ?? []).filter((x, j) => j !== i);
        setCfg(normalizeRange(th, colors, cfg.palette));
    };

    const setThreshold = (i, v) => {
        const th = (cfg.thresholds ?? []).slice();
        th[i] = Number(v);
        // 並べ替えても色の対応が崩れないよう、値だけ更新して昇順化は onBlur で行う
        setCfg({ thresholds: th });
    };

    const sortThresholds = () => setCfg(normalizeRange(cfg.thresholds ?? [], cfg.colors, cfg.palette));

    const setRangeColor = (i, color) => {
        const colors = (cfg.colors ?? []).slice();
        colors[i] = color;
        setCfg({ colors, palette: undefined });
    };

    const reverse = () => setCfg({ colors: (cfg.colors ?? []).slice().reverse() });

    // ── 一致モード ────────────────────────────────────────────
    const matches = cfg.matches ?? [];
    const patchMatch = (i, patch) =>
        setCfg({ matches: matches.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
    const moveMatch = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= matches.length) return;
        const next = matches.slice();
        [next[i], next[j]] = [next[j], next[i]];
        setCfg({ matches: next });
    };

    return (
        <div>
            <div style={{ fontSize: 10, color: t.subColor, marginBottom: 5 }}>メソッド</div>
            <Segmented
                t={t}
                value={cfg.mode}
                options={[
                    { value: 'range', label: '範囲' },
                    { value: 'gradient', label: 'グラデーション' },
                    { value: 'match', label: '一致' },
                ]}
                onChange={(m) => onChange(defaultColorRules(m))}
            />

            {isGradient ? (
                <>
                    {/* しきい値を持たない。最小〜最大を色の並びに連続で写像する */}
                    <div style={{ fontSize: 10, color: t.subColor, margin: '12px 0 5px' }}>
                        プリセットパレット（最小 → 最大）
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                        {COLOR_PALETTES.map((p) => (
                            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span
                                    style={{ fontSize: 10, color: cfg.palette === p.id ? t.accent : t.subColor, width: 76, flex: 'none' }}
                                >
                                    {p.name}
                                </span>
                                <PaletteBar
                                    colors={p.colors}
                                    onClick={() => setCfg({ palette: p.id, colors: samplePalette(p.id, 3) })}
                                    title="このパレットを適用"
                                />
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'flex', gap: 6, margin: '12px 0 8px' }}>
                        <button type="button" onClick={reverse} title="色の並びを反転" style={iconBtn(t)}>
                            ⇅
                        </button>
                        <Button
                            t={t}
                            label="＋ 色を追加"
                            onClick={() => setCfg({ colors: [...(cfg.colors ?? []), (cfg.colors ?? []).slice(-1)[0] || '#4ea1ff'], palette: undefined })}
                        />
                    </div>

                    {(cfg.colors ?? []).map((c, i, arr) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <input
                                type="color"
                                value={/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : '#4ea1ff'}
                                onChange={(e) => {
                                    const colors = arr.slice();
                                    colors[i] = e.target.value;
                                    setCfg({ colors, palette: undefined });
                                }}
                                style={swatch()}
                            />
                            <span style={{ fontSize: 11, color: t.subColor, flex: 1 }}>
                                {i === 0 ? '最小値' : i === arr.length - 1 ? '最大値' : `中間 ${i}`}
                            </span>
                            {arr.length > 2 ? (
                                <button
                                    type="button"
                                    onClick={() => setCfg({ colors: arr.filter((x, j) => j !== i), palette: undefined })}
                                    style={iconBtn(t)}
                                    title="削除"
                                >
                                    ×
                                </button>
                            ) : null}
                        </div>
                    ))}

                    <div style={{ fontSize: 10, color: t.subColor, margin: '12px 0 5px' }}>
                        範囲（空ならデータの最小・最大を自動で使う）
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                            className="dpx-input"
                            type="number"
                            placeholder="最小（自動）"
                            value={cfg.min ?? ''}
                            onChange={(e) => setCfg({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
                            style={{ ...inputStyle(t), width: 0, flex: 1 }}
                        />
                        <span style={{ fontSize: 11, color: t.subColor, flex: 'none' }}>〜</span>
                        <input
                            className="dpx-input"
                            type="number"
                            placeholder="最大（自動）"
                            value={cfg.max ?? ''}
                            onChange={(e) => setCfg({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
                            style={{ ...inputStyle(t), width: 0, flex: 1 }}
                        />
                    </div>
                    <div style={{ fontSize: 10, color: t.subColor, marginTop: 6, lineHeight: 1.5 }}>
                        しきい値を決めずに、値の大小をそのまま色の濃淡にします。
                    </div>
                </>
            ) : isRange ? (
                <>
                    <div style={{ fontSize: 10, color: t.subColor, margin: '12px 0 5px' }}>プリセットパレット</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                        {COLOR_PALETTES.map((p) => (
                            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span
                                    style={{
                                        fontSize: 10,
                                        color: cfg.palette === p.id ? t.accent : t.subColor,
                                        width: 76,
                                        flex: 'none',
                                    }}
                                >
                                    {p.name}
                                </span>
                                <PaletteBar colors={p.colors} onClick={() => applyPalette(p.id)} title="このパレットを適用" />
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'flex', gap: 6, margin: '12px 0 8px' }}>
                        <button type="button" onClick={reverse} title="色の並びを反転" style={iconBtn(t)}>
                            ⇅
                        </button>
                        <Button t={t} label="＋ 範囲を追加" onClick={addThreshold} />
                    </div>

                    {/* 上端の区間（最大側）から順に表示する＝標準 viz と同じ並び */}
                    {(() => {
                        const th = cfg.thresholds ?? [];
                        const colors = cfg.colors ?? [];
                        const rows = [];
                        for (let i = th.length - 1; i >= 0; i--) {
                            const upper = i === th.length - 1 ? null : th[i + 1];
                            rows.push(
                                <div key={`th${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                    <input
                                        type="color"
                                        value={/^#/.test(colors[i + 1] ?? '') ? colors[i + 1] : '#4ea1ff'}
                                        onChange={(e) => setRangeColor(i + 1, e.target.value)}
                                        style={swatch()}
                                    />
                                    <input
                                        className="dpx-input"
                                        type="number"
                                        value={th[i]}
                                        onChange={(e) => setThreshold(i, e.target.value)}
                                        onBlur={sortThresholds}
                                        style={{ ...inputStyle(t), width: 0, flex: 1 }}
                                    />
                                    <span style={{ fontSize: 11, color: t.subColor, width: 62, flex: 'none' }}>
                                        {upper === null ? '以上' : `〜 ${upper}`}
                                    </span>
                                    <button type="button" onClick={() => removeThreshold(i)} style={iconBtn(t)} title="削除">
                                        ×
                                    </button>
                                </div>
                            );
                        }
                        // 最小側の区間（しきい値未満）
                        rows.push(
                            <div key="min" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <input
                                    type="color"
                                    value={/^#/.test(colors[0] ?? '') ? colors[0] : '#4ea1ff'}
                                    onChange={(e) => setRangeColor(0, e.target.value)}
                                    style={swatch()}
                                />
                                <span style={{ fontSize: 11, color: t.subColor, flex: 1 }}>
                                    {th.length > 0 ? `${th[0]} より小さい` : 'すべて'}
                                </span>
                            </div>
                        );
                        return rows;
                    })()}
                </>
            ) : (
                <>
                    <div style={{ fontSize: 10, color: t.subColor, margin: '12px 0 5px' }}>
                        値ごとの色（1行に1つの値。同じ色にしたい値は行を分けて同じ色を選ぶ）
                    </div>
                    {matches.map((m, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                            <input
                                type="color"
                                value={/^#/.test(m.color ?? '') ? m.color : '#4ea1ff'}
                                onChange={(e) => patchMatch(i, { color: e.target.value })}
                                style={swatch()}
                            />
                            <input
                                className="dpx-input"
                                value={m.value ?? ''}
                                placeholder={valueHint}
                                onChange={(e) => patchMatch(i, { value: e.target.value })}
                                style={{ ...inputStyle(t), width: 0, flex: 1.2, fontSize: 11 }}
                            />
                            <input
                                className="dpx-input"
                                value={m.label ?? ''}
                                placeholder="表示名（任意）"
                                onChange={(e) => patchMatch(i, { label: e.target.value })}
                                style={{ ...inputStyle(t), width: 0, flex: 1, fontSize: 11 }}
                            />
                            <button type="button" onClick={() => moveMatch(i, -1)} style={iconBtn(t)} title="上へ">
                                ↑
                            </button>
                            <button type="button" onClick={() => moveMatch(i, 1)} style={iconBtn(t)} title="下へ">
                                ↓
                            </button>
                            <button
                                type="button"
                                onClick={() => setCfg({ matches: matches.filter((x, j) => j !== i) })}
                                style={{ ...iconBtn(t), color: '#ff8a9c' }}
                                title="削除"
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <Button
                        t={t}
                        label="＋ 値を追加"
                        onClick={() =>
                            setCfg({
                                matches: [
                                    ...matches,
                                    { value: '', color: samplePalette('trafficDark', 5)[matches.length % 5], label: '' },
                                ],
                            })
                        }
                    />
                </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <span style={{ fontSize: 10, color: t.subColor, flex: 1 }}>どれにも当たらない時</span>
                <input
                    type="color"
                    value={/^#/.test(cfg.defaultColor ?? '') ? cfg.defaultColor : '#6b7a94'}
                    onChange={(e) => setCfg({ defaultColor: e.target.value })}
                    style={swatch()}
                />
                {cfg.defaultColor ? (
                    <button type="button" onClick={() => setCfg({ defaultColor: '' })} style={iconBtn(t)} title="既定に戻す">
                        ×
                    </button>
                ) : null}
            </div>
        </div>
    );
}
