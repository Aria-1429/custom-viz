import React from 'react';

import {
    EmptyHint,
    colorForValue,
    labelForValue,
    resolveColorRules,
    useDpxTheme,
    useVizHover,
    useVizKitStyles,
} from '..';

// ── dpx.status（ステータス一覧）─────────────────────────────────
//
// データ規約: 1列目 = 名前、2列目 = 状態、3列目 = 補足（任意）
// ────────────────────────────────────────────────────────────────

// ⚠ 既定の状態→色。**`DpxStatus` だけが使う**。
//   （分割前は `nativeViz.jsx` の DpxValue 付近に置かれていて、
//     どの viz のものか読めなかった。使う viz の隣に置く。）
const DEFAULT_STATUS_MATCHES = [
    { value: 'ok', color: '#3cdcb4', label: '' },
    { value: 'warn', color: '#ffb020', label: '' },
    { value: 'crit', color: '#ff5c8a', label: '' },
];
const DEFAULT_STATUS_COLORS = {
    ok: '#3cdcb4', up: '#3cdcb4', normal: '#3cdcb4', healthy: '#3cdcb4', success: '#3cdcb4', good: '#3cdcb4', green: '#3cdcb4',
    warn: '#ffb020', warning: '#ffb020', degraded: '#ffb020', slow: '#ffb020', amber: '#ffb020', yellow: '#ffb020',
    crit: '#ff5c8a', critical: '#ff5c8a', down: '#ff5c8a', error: '#ff5c8a', fail: '#ff5c8a', failed: '#ff5c8a', red: '#ff5c8a',
    info: '#4ea1ff', blue: '#4ea1ff',
};

export function DpxStatus({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const { hoverKey, setHoverKey } = useVizHover();
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=名前、2列目=状態）" />;
    }

    const h = typeof height === 'number' ? height : 200;
    const names = cols[0].map((v) => String(v));
    const states = cols[1].map((v) => String(v ?? ''));
    const details = cols[2] ?? [];
    const columns = Math.max(1, Number(options.columns) || 3);
    const showDetail = options.showDetail !== false && cols.length > 2;
    // options.colors（新形式）→ 旧 options.rules（配列）→ 未設定 の順で解決する
    const colorCfg = resolveColorRules(options.colors ?? options.rules, null);
    const upperState = options.upperCaseState !== false;

    return (
        <div
            className="dpx-scroll"
            style={{
                height: h,
                overflow: 'auto',
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: 8,
                padding: 10,
                boxSizing: 'border-box',
                alignContent: 'start',
            }}
        >
            {names.map((name, i) => {
                const state = states[i];
                // 設定があればそれに従い、無ければ「よくある表記」の既定色にフォールバック
                const configured = colorCfg ? colorForValue(colorCfg, state) : null;
                const color = configured || DEFAULT_STATUS_COLORS[String(state).toLowerCase()] || t.subColor;
                const stateLabel = (colorCfg ? labelForValue(colorCfg, state) : null) || state;
                const hkey = `status:${name}`;
                const hovered = hoverKey === hkey;
                const dimmed = hoverKey?.startsWith('status:') && !hovered;
                return (
                    <div
                        key={name + i}
                        onMouseEnter={() => setHoverKey(hkey)}
                        onMouseLeave={() => setHoverKey(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'status.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'name',
                                    value: name,
                                    [`row.${fields[0] ?? 'name'}.value`]: name,
                                    [`row.${fields[1] ?? 'status'}.value`]: state,
                                },
                            })
                        }
                        style={{
                            border: `1px solid ${color}${hovered ? '99' : '55'}`,
                            borderLeft: `4px solid ${color}`,
                            borderRadius: 8,
                            padding: '8px 10px',
                            background: hovered ? `${color}1f` : `${color}0d`,
                            cursor: onEventTrigger ? 'pointer' : 'default',
                            minWidth: 0,
                            transform: hovered ? 'translateY(-2px)' : 'none',
                            boxShadow: hovered ? `0 6px 18px rgba(0,0,0,0.35), 0 0 0 1px ${color}44` : 'none',
                            opacity: dimmed ? 0.45 : 1,
                            transition: 'transform 0.15s ease, background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ position: 'relative', width: 8, height: 8, flex: 'none' }}>
                                {options.pulse !== false ? (
                                    <span
                                        style={{
                                            position: 'absolute',
                                            inset: 0,
                                            borderRadius: 4,
                                            background: color,
                                            animation: 'dpxPulse 1.8s ease-in-out infinite',
                                        }}
                                    />
                                ) : null}
                                <span
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        borderRadius: 4,
                                        background: color,
                                        boxShadow: `0 0 8px ${color}`,
                                    }}
                                />
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {name}
                            </span>
                        </div>
                        <div
                            style={{
                                fontSize: 10,
                                color: t.subColor,
                                marginTop: 3,
                                textTransform: upperState ? 'uppercase' : 'none',
                            }}
                        >
                            {stateLabel}
                            {showDetail && details[i] !== undefined ? ` ・ ${details[i]}` : ''}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

DpxStatus.config = {
    key: 'dpx.status',
    name: 'ステータス一覧',
    category: 'status',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        columns: { type: 'number', default: 3 },
        showDetail: { type: 'boolean', default: true },
        upperCaseState: { type: 'boolean', default: true },
        pulse: { type: 'boolean', default: true },
        colors: { type: 'object', default: { mode: 'match', matches: DEFAULT_STATUS_MATCHES, defaultColor: '' } },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '列数', option: 'columns', editor: 'editor.slider', editorProps: { min: 1, max: 6, step: 1 } }],
                [{ label: '補足列を表示', option: 'showDetail', editor: 'editor.checkbox' }],
                [{ label: '状態を大文字で表示', option: 'upperCaseState', editor: 'editor.checkbox' }],
                [{ label: 'ドットを脈動させる', option: 'pulse', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [{ label: '状態の色', option: 'colors', editor: 'editor.colorRules', editorProps: { valueHint: '状態（例: ok）' } }],
            ],
        },
    ],
};

// ── dpx.table ────────────────────────────────────────────────────
