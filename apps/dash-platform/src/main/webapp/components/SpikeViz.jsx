import React from 'react';

import { useVizHover } from './vizBus';

// ── preset に直接登録するカスタム viz（iframe なし） ───────────────
// 受け取る props は VizProps（@splunk/dashboard-types）:
//   dataSources: { primary: { data: {fields, columns}, meta, error } }
//   options / width / height / loading / mode / onOptionsChange / onEventTrigger ...
//
// ホバーバス連携（Phase 3）:
//   同じラベルの行を持つ別パネルとホバーが同期する（useVizHover）。
//   全パネルが同一 React ツリーだから成立する＝ Studio（iframe 分離）では不可能。
// ────────────────────────────────────────────────────────────────

const DEFAULT_ACCENT = '#f2545b';

const SpikeViz = ({ dataSources, options = {}, height, loading, onEventTrigger }) => {
    const accent = typeof options.accent === 'string' ? options.accent : DEFAULT_ACCENT;
    const { hoverKey, setHoverKey } = useVizHover();
    const data = dataSources?.primary?.data;
    const fields = Array.isArray(data?.fields) ? data.fields : [];
    const columns = Array.isArray(data?.columns) ? data.columns : [];

    if (loading && columns.length === 0) {
        return <div style={{ padding: 16 }}>読み込み中…</div>;
    }
    if (columns.length < 2) {
        return <div style={{ padding: 16 }}>データがありません（2列必要: ラベル, 値）</div>;
    }

    const labels = columns[0].map((v) => String(v));
    const values = columns[1].map((v) => Number(v));
    const max = Math.max(...values.filter((v) => Number.isFinite(v)), 1);
    const valueName = fields[1]?.name ?? 'value';
    const hoverActive = typeof hoverKey === 'string' && hoverKey.startsWith('spike:');

    return (
        <div
            className="dpx-scroll"
            style={{
                padding: '12px 16px',
                height: typeof height === 'number' ? height : '100%',
                boxSizing: 'border-box',
                overflow: 'auto',
                fontFamily: 'inherit',
            }}
        >
            {labels.map((label, i) => {
                const v = values[i];
                const ratio = Number.isFinite(v) ? v / max : 0;
                const key = `spike:${label}`;
                const highlighted = hoverKey === key;
                const dimmed = hoverActive && !highlighted;
                return (
                    <div
                        key={label + i}
                        onMouseEnter={() => setHoverKey(key)}
                        onMouseLeave={() => setHoverKey(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'row.click',
                                originalEvent,
                                payload: {
                                    name: fields[0]?.name ?? 'label',
                                    value: label,
                                    [`row.${fields[0]?.name ?? 'label'}.value`]: label,
                                    [`row.${valueName}.value`]: v,
                                },
                            })
                        }
                        style={{
                            cursor: onEventTrigger ? 'pointer' : 'default',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            marginBottom: 8,
                            opacity: dimmed ? 0.35 : 1,
                            transition: 'opacity 0.15s ease',
                            outline: highlighted ? `2px solid ${accent}` : 'none',
                            outlineOffset: 2,
                            borderRadius: 4,
                        }}
                    >
                        <div style={{ width: 72, textAlign: 'right', fontSize: 12, opacity: 0.8 }}>{label}</div>
                        <div style={{ flex: 1, background: 'rgba(128,128,128,0.15)', borderRadius: 9, height: 18 }}>
                            <div
                                style={{
                                    width: `${Math.max(ratio * 100, 2)}%`,
                                    height: '100%',
                                    borderRadius: 9,
                                    background: `linear-gradient(90deg, ${accent}66, ${accent})`,
                                    boxShadow: `0 0 8px ${accent}55`,
                                    transition: 'width 0.4s ease',
                                }}
                            />
                        </div>
                        <div style={{ width: 48, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                            {Number.isFinite(v) ? v : '—'}
                        </div>
                    </div>
                );
            })}
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>custom.spike / {valueName}（iframe なし）</div>
        </div>
    );
};

// VizStatics（@splunk/dashboard-types の Preset.d.ts / Visualizations.d.ts で確認した形）
SpikeViz.config = {
    key: 'custom.spike',
    name: 'Spike Viz',
    category: 'custom',
    dataContract: {
        requiredDataSources: ['primary'],
        optionalDataSources: [],
    },
    optionsSchema: {
        accent: { type: 'string', default: DEFAULT_ACCENT, description: 'バーのアクセント色' },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [[{ label: 'アクセント色', option: 'accent', editor: 'editor.color' }]],
        },
    ],
};
SpikeViz.showTitleAndDescription = true;
SpikeViz.showProgressBar = true;
SpikeViz.includeInVizSwitcher = true;

export default SpikeViz;
