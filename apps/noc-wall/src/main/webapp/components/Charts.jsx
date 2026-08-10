import React, { useId } from 'react';
import { C } from './theme';

/**
 * スパークライン。KPI カードの下敷きに使う。
 * 面グラデーション＋末端のドットで「今」を示す。
 */
export function Sparkline({ values, color = C.info, width = 240, height = 52 }) {
    const gid = useId();
    // height に "100%" を渡すと親いっぱいに伸びる。
    // その場合でも座標計算には数値が要るので、viewBox 用の高さは別に持つ。
    const isFluid = typeof height === 'string';
    const vbHeight = isFluid ? 200 : height;
    const svgHeight = isFluid ? height : height;

    const nums = (values || []).map(Number).filter(Number.isFinite);
    if (nums.length < 2) {
        return <svg width="100%" height={svgHeight} viewBox={`0 0 ${width} ${vbHeight}`} />;
    }

    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const pad = 3;
    const stepX = width / (nums.length - 1);

    const pts = nums.map((v, i) => [
        i * stepX,
        pad + (vbHeight - pad * 2) * (1 - (v - min) / span),
    ]);

    // なめらかな曲線にする（カトマル・ロム風の簡易スムージング）
    let d = `M ${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        const cx = (x0 + x1) / 2;
        d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    const area = `${d} L ${width},${vbHeight} L 0,${vbHeight} Z`;
    const last = pts[pts.length - 1];

    return (
        <svg
            width="100%"
            height={svgHeight}
            viewBox={`0 0 ${width} ${vbHeight}`}
            preserveAspectRatio="none"
            style={isFluid ? { display: 'block' } : undefined}
        >
            <defs>
                <linearGradient id={`sg-${gid}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.42" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={area} fill={`url(#sg-${gid})`} />
            <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {/* preserveAspectRatio="none" だと円が楕円に潰れるので、
                末端の点は線分＋非スケーリング線幅で描く */}
            <line
                x1={last[0]}
                y1={last[1]}
                x2={last[0]}
                y2={last[1]}
                stroke={color}
                strokeWidth="7"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/**
 * 円環ゲージ。0〜1 の比率を弧で示す。
 * 中央に数値、外周に目盛りを置いて計器らしくする。
 */
export function RingGauge({ ratio, label, value, color = C.info, size = 168 }) {
    const r = Math.max(0.001, Math.min(1, Number(ratio) || 0));
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 18;
    const circumference = 2 * Math.PI * radius;
    // 上端から時計回りに始まるよう -90 度回す
    const dash = circumference * r;

    // 外周の目盛り（36 本）
    const ticks = Array.from({ length: 36 }, (_, i) => {
        const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
        const inner = radius + 6;
        const outer = radius + (i % 9 === 0 ? 13 : 9);
        return {
            x1: cx + Math.cos(a) * inner,
            y1: cy + Math.sin(a) * inner,
            x2: cx + Math.cos(a) * outer,
            y2: cy + Math.sin(a) * outer,
            lit: i / 36 <= r,
        };
    });

    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {ticks.map((t, i) => (
                <line
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    x1={t.x1}
                    y1={t.y1}
                    x2={t.x2}
                    y2={t.y2}
                    stroke={t.lit ? color : C.textFaint}
                    strokeOpacity={t.lit ? 0.85 : 0.3}
                    strokeWidth="1.5"
                />
            ))}
            <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke="rgba(80,120,200,0.16)"
                strokeWidth="9"
            />
            <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference}`}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{
                    filter: `drop-shadow(0 0 8px ${color})`,
                    transition: 'stroke-dasharray 900ms cubic-bezier(0.22,1,0.36,1)',
                }}
            />
            <text
                x={cx}
                y={cy - 2}
                textAnchor="middle"
                fill={C.text}
                fontSize="30"
                fontWeight="700"
                style={{ fontVariantNumeric: 'tabular-nums' }}
            >
                {value}
            </text>
            <text x={cx} y={cy + 20} textAnchor="middle" fill={C.textFaint} fontSize="10.5" letterSpacing="2">
                {label}
            </text>
        </svg>
    );
}

/**
 * レーダー（多角形）チャート。カテゴリ別のスコアを一目で比べる。
 * 3 軸未満だと図形にならないので、その場合は描かない。
 */
export function Radar({ items, color = C.accent, size = 260, responsive = false }) {
    const gid = useId();
    const data = (items || []).slice(0, 8);
    if (data.length < 3) return <svg width={size} height={size} />;

    // responsive の場合は viewBox だけ固定して、実寸は親に合わせて伸縮させる。
    // 大画面ほど図が大きくなり、余白が残らない。
    const svgSize = responsive
        ? { width: '100%', height: '100%', style: { maxHeight: '100%' } }
        : { width: size, height: size };

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 44;
    const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);

    const pt = (i, ratio) => {
        const a = (i / data.length) * Math.PI * 2 - Math.PI / 2;
        return [cx + Math.cos(a) * radius * ratio, cy + Math.sin(a) * radius * ratio];
    };

    const poly = data.map((d, i) => pt(i, (Number(d.value) || 0) / max).join(',')).join(' ');
    const rings = [0.25, 0.5, 0.75, 1];

    return (
        // eslint-disable-next-line react/jsx-props-no-spreading
        <svg {...svgSize} viewBox={`0 0 ${size} ${size}`} preserveAspectRatio="xMidYMid meet">
            <defs>
                <radialGradient id={`rg-${gid}`}>
                    <stop offset="0%" stopColor={color} stopOpacity="0.55" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.12" />
                </radialGradient>
            </defs>

            {rings.map((rr) => (
                <polygon
                    key={rr}
                    points={data.map((_, i) => pt(i, rr).join(',')).join(' ')}
                    fill="none"
                    stroke={C.border}
                    strokeWidth="1"
                />
            ))}
            {data.map((_, i) => {
                const [x, y] = pt(i, 1);
                // eslint-disable-next-line react/no-array-index-key
                return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={C.border} strokeWidth="1" />;
            })}

            <polygon
                points={poly}
                fill={`url(#rg-${gid})`}
                stroke={color}
                strokeWidth="2"
                style={{ filter: `drop-shadow(0 0 10px ${color}aa)`, transition: 'all 800ms ease' }}
            />
            {data.map((d, i) => {
                const [x, y] = pt(i, (Number(d.value) || 0) / max);
                // eslint-disable-next-line react/no-array-index-key
                return <circle key={i} cx={x} cy={y} r="3.5" fill={color} />;
            })}
            {data.map((d, i) => {
                const [x, y] = pt(i, 1.19);
                return (
                    <text
                        key={d.label}
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={C.textDim}
                        fontSize="10.5"
                    >
                        {String(d.label).slice(0, 12)}
                    </text>
                );
            })}
        </svg>
    );
}

/**
 * 縦棒の時系列。時間帯別の件数などに使う。
 * 値に応じて色を変え、最大値だけ強調する。
 */
export function ColumnChart({ items, height = 190, colorFor }) {
    const data = (items || []).slice(0, 48);
    if (!data.length) return null;
    const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 3,
                height,
                width: '100%',
                minHeight: 0,
            }}
        >
            {data.map((d, i) => {
                const v = Number(d.value) || 0;
                const pct = (v / max) * 100;
                const col = colorFor ? colorFor(d, v / max) : C.info;
                return (
                    <div
                        key={d.label ?? i}
                        title={`${d.label}: ${v}`}
                        style={{
                            flex: 1,
                            minWidth: 0,
                            height: `${Math.max(2, pct)}%`,
                            background: `linear-gradient(180deg, ${col}, ${col}33)`,
                            boxShadow: `0 0 10px ${col}66`,
                            borderRadius: '2px 2px 0 0',
                            transition: 'height 700ms cubic-bezier(0.22,1,0.36,1)',
                        }}
                    />
                );
            })}
        </div>
    );
}
