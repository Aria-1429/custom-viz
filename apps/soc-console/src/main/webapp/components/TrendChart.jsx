import React from 'react';
import { C } from './theme';

/**
 * severity 別の積み上げ縦棒（24 時間の推移）。
 *
 * 積む順は下から low → medium → high → critical。
 * 深刻なものを上に置くと、棒の天面の色で「今どれくらいヤバいか」が分かる。
 */
export function StackedTrend({ rows, height = 150 }) {
    const data = (rows || []).map((r) => ({
        hour: Number(r.hour),
        low: Math.max(0, Number(r.low) || 0),
        medium: Math.max(0, Number(r.medium) || 0),
        high: Math.max(0, Number(r.high) || 0),
        critical: Math.max(0, Number(r.critical) || 0),
    }));

    if (!data.length) return null;

    const totals = data.map((d) => d.low + d.medium + d.high + d.critical);
    const max = Math.max(...totals, 1);

    const layers = [
        { key: 'low', color: C.ok },
        { key: 'medium', color: C.warn },
        { key: 'high', color: C.high },
        { key: 'critical', color: C.crit },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 3,
                    flex: 1,
                    minHeight: 0,
                    height,
                }}
            >
                {data.map((d, i) => {
                    const total = totals[i];
                    return (
                        <div
                            key={d.hour ?? i}
                            title={`${d.hour}:00 — crit ${d.critical} / high ${d.high} / med ${d.medium} / low ${d.low}`}
                            style={{
                                flex: 1,
                                minWidth: 0,
                                height: `${Math.max(2, (total / max) * 100)}%`,
                                display: 'flex',
                                flexDirection: 'column-reverse', // 下から積む
                                borderRadius: '2px 2px 0 0',
                                overflow: 'hidden',
                                transition: 'height 600ms cubic-bezier(0.22,1,0.36,1)',
                            }}
                        >
                            {layers.map((L) => {
                                const v = d[L.key];
                                if (!v) return null;
                                return (
                                    <div
                                        key={L.key}
                                        style={{
                                            height: `${(v / total) * 100}%`,
                                            background: L.color,
                                            boxShadow: `0 0 6px ${L.color}55`,
                                        }}
                                    />
                                );
                            })}
                        </div>
                    );
                })}
            </div>

            {/* 時間軸の目盛り。6 時間ごとだけラベルを出す */}
            <div
                style={{
                    display: 'flex',
                    gap: 3,
                    marginTop: 5,
                    fontSize: 9.5,
                    color: C.textFaint,
                    flex: 'none',
                }}
            >
                {data.map((d, i) => (
                    <div key={d.hour ?? i} style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
                        {i % 6 === 0 ? `${String(d.hour).padStart(2, '0')}` : ''}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** 凡例。色と意味の対応をその場で示す。 */
export function TrendLegend() {
    const items = [
        { label: 'CRIT', color: C.crit },
        { label: 'HIGH', color: C.high },
        { label: 'MED', color: C.warn },
        { label: 'LOW', color: C.ok },
    ];
    return (
        <div style={{ display: 'flex', gap: 12, marginLeft: 'auto' }}>
            {items.map((it) => (
                <div
                    key={it.label}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5 }}
                >
                    <span
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: it.color,
                            boxShadow: `0 0 6px ${it.color}`,
                            display: 'inline-block',
                        }}
                    />
                    <span style={{ color: C.textFaint, letterSpacing: '0.1em' }}>{it.label}</span>
                </div>
            ))}
        </div>
    );
}
