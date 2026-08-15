import React from 'react';

import {
    EmptyHint,
    VizTooltip,
    buildFlowGraph,
    colorForValue,
    colorIndexByName,
    fmtNumber,
    forceLayout,
    resolveColorRules,
    useContainerSize,
    useDpxTheme,
    usePointer,
    useVizData,
    useVizKitStyles,
} from '..';

// ── dpx.linkGraph（関係図・ネットワーク図）──────────────────────
//
// データ規約: **3 列** … `src, dst, value`
// （4 列以上でも動くが、多段フローなら `dpx.sankey` のほうが読みやすい）
//
// ## 標準 `splunk.networkGraph` と何が違うか
//
// ⚠ **標準はかなり高機能**（2026-08-09 実機確認）。力学配置も階層配置も、
//   DOS 式による**ノードの色分け・大小**も**標準でできる**。
//   なので「レイアウトがある/ない」では差別化にならない。
//   **標準が実機でできなかったこと**だけを埋める:
//
// | | splunk.networkGraph | dpx.linkGraph |
// |---|---|---|
// | Force / 階層レイアウト | ✅ ある | ✅ ある |
// | ノードの色・大小を値で変える | ✅ DOS 式でできる | ✅ 色ルールでできる |
// | **エッジの太さを値に連動** | ❌ **できない**（実機確認） | ✅ **流量で太くなる** |
// | **ホバーの強調・ツールチップ** | ❌ **出ない**（docs も未対応と明記） | ✅ **隣接を強調＋詳細** |
// | **流れのアニメーション** | ❌ 無い | ✅ 破線が流れる（向きが分かる） |
//
// ## レイアウトを自前で持つ理由
//
// d3-force を足すと**依存が増える**うえ、**毎フレーム再計算する**ので
// パネルを何枚も置くと重い（→ viz-performance の知見）。
// ここでは**反復回数を固定した簡易な力学計算を 1 回だけ回して座標を確定**する。
// アニメーションするのは**破線のオフセットだけ**（＝面積に比例した再描画をしない）。
// ────────────────────────────────────────────────────────────────

const HINTS = {
    columns: 'データがありません（3列: 送信元, 送信先, 値）',
    nolinks: '描ける関係がありません（値が正の行がない）',
};

export function DpxLinkGraph({ dataSources, options = {}, width, height, loading, onEventTrigger, id }) {
    // ⚠ フックは early return より前（§8.1）
    useVizKitStyles(); // `dpxLinkFlow` の keyframes を注入する
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const [pt, pointerProps] = usePointer();
    const [hover, setHover] = React.useState(null);
    // ⚠ `width` プロップではなく実測を使う（プロップは既定値のことがある）
    const [sizeRef, measuredW] = useContainerSize();
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    const topN = Number(options.topN) || 0;
    const graph = React.useMemo(
        () => buildFlowGraph(d.isEmpty ? [] : d.rows(), { topN, otherLabel: options.otherLabel }),
        [d, topN, options.otherLabel]
    );

    // ⚠ 力学計算は**重い**ので、グラフが変わったときだけ回す
    //   （ホバーのたびに再計算すると 60fps を割る）
    const positions = React.useMemo(() => {
        if (graph.error) return new Map();
        return forceLayout(graph.nodes, graph.links, Number(options.iterations) || 220);
    }, [graph, options.iterations]);

    const colorIdx = React.useMemo(() => colorIndexByName(graph.nodes), [graph.nodes]);

    // 隣接の索引（ホバー強調用）
    const adjacency = React.useMemo(() => {
        const m = new Map();
        if (graph.error) return m;
        graph.links.forEach((l, i) => {
            if (!m.has(l.source)) m.set(l.source, { nodes: new Set(), links: new Set() });
            if (!m.has(l.target)) m.set(l.target, { nodes: new Set(), links: new Set() });
            m.get(l.source).nodes.add(l.target);
            m.get(l.source).links.add(i);
            m.get(l.target).nodes.add(l.source);
            m.get(l.target).links.add(i);
        });
        return m;
    }, [graph]);

    // ⚠ 早期 return でも計測用の div を描く（幅が測れないと配置が偏る）
    if (graph.error) {
        return (
            <div ref={sizeRef} style={{ width: '100%', height: typeof height === 'number' ? height : 300 }}>
                <EmptyHint loading={loading} message={HINTS[graph.error] ?? HINTS.nolinks} />
            </div>
        );
    }

    const w = measuredW > 20 ? measuredW : typeof width === 'number' ? width : 480;
    const h = typeof height === 'number' ? height : 300;
    const pad = 26; // ラベルがはみ出さないだけの余白
    const innerW = Math.max(10, w - pad * 2);
    const innerH = Math.max(10, h - pad * 2);
    const at = (nodeId) => {
        const p = positions.get(nodeId) ?? { x: 0.5, y: 0.5 };
        return { x: pad + p.x * innerW, y: pad + p.y * innerH };
    };

    const palette = t.palette ?? [];
    const values = graph.links.map((l) => l.value);
    const maxV = Math.max(...values, 1);
    const minV = Math.min(...values);
    const maxWidth = Number(options.maxLinkWidth) || 8;

    // ⭐ エッジの太さを値に連動（**標準 networkGraph にはできない**）
    const widthFor = (v) => {
        if (options.scaleLinkWidth === false) return 1.5;
        if (maxV === minV) return Math.max(1.5, maxWidth / 2);
        return 1.2 + ((v - minV) / (maxV - minV)) * (maxWidth - 1.2);
    };

    // ノードの合計流量（大小と色に使う）
    const totals = new Map();
    for (const l of graph.links) {
        totals.set(l.source, (totals.get(l.source) ?? 0) + l.value);
        totals.set(l.target, (totals.get(l.target) ?? 0) + l.value);
    }
    const maxTotal = Math.max(...totals.values(), 1);
    const baseR = Number(options.nodeSize) || 7;
    const radiusFor = (nodeId) => {
        if (options.scaleNodeSize === false) return baseR;
        const share = (totals.get(nodeId) ?? 0) / maxTotal;
        return baseR * (0.6 + share * 0.9);
    };

    const focus = hover?.type === 'node' ? adjacency.get(hover.key) : null;
    const activeLinks = hover?.type === 'link' ? new Set([hover.key]) : focus?.links;
    const activeNodes = hover?.type === 'node' ? new Set([hover.key, ...(focus?.nodes ?? [])]) : null;
    const dimAll = Boolean(hover);
    const fields = d.fieldNames;
    const labelSize = Number(options.labelSize) || 11;
    const flow = options.animateFlow !== false;

    let tipTitle = null;
    let tipRows = [];
    if (hover?.type === 'node') {
        tipTitle = graph.nodes.find((n) => n.id === hover.key)?.name ?? hover.key;
        tipRows = [
            { label: '合計', value: fmtNumber(totals.get(hover.key) ?? 0) },
            { label: '接続数', value: String(focus?.nodes.size ?? 0) },
        ];
    } else if (hover?.type === 'link') {
        const l = graph.links[hover.key];
        if (l) {
            const nameOf = (nid) => graph.nodes.find((n) => n.id === nid)?.name ?? nid;
            tipTitle = `${nameOf(l.source)} → ${nameOf(l.target)}`;
            tipRows = [{ label: '流量', value: fmtNumber(l.value) }];
        }
    }

    return (
        <div ref={sizeRef} style={{ position: 'relative', width: '100%', height: h }} {...pointerProps}>
            <svg width={w} height={h} style={{ display: 'block' }}>
                {/* 矢印（向きを示す）。⚠ 色は線から引き継ぐ（context-stroke）
                    ⚠⚠ **`markerUnits="userSpaceOnUse"` を必ず付ける。**
                      既定は `strokeWidth` 基準なので、太い線ほど矢印が比例して
                      巨大化する（9px の線に 45px の矢印が付いて絵を潰した。実機で発生）。
                      向きが分かればよいので、**太さに関係なく一定の大きさ**にする。 */}
                <defs>
                    <marker
                        id={`dpx-arrow-${id}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="9"
                        markerHeight="9"
                        markerUnits="userSpaceOnUse"
                        orient="auto-start-reverse"
                    >
                        <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
                    </marker>
                </defs>

                {/* エッジ。⚠ 先に描いてノードの下に敷く */}
                <g fill="none">
                    {graph.links.map((l, i) => {
                        const a = at(l.source);
                        const b = at(l.target);
                        const on = !dimAll || activeLinks?.has(i);
                        const sw = widthFor(l.value);
                        // 少し曲げる（直線だと往復の2本が完全に重なって1本に見える）
                        const mx = (a.x + b.x) / 2;
                        const my = (a.y + b.y) / 2;
                        const nx = -(b.y - a.y);
                        const ny = b.x - a.x;
                        const len = Math.sqrt(nx * nx + ny * ny) || 1;
                        const bow = Math.min(28, len * 0.13);
                        const cx = mx + (nx / len) * bow;
                        const cy = my + (ny / len) * bow;
                        return (
                            <path
                                key={`${l.source}->${l.target}`}
                                d={`M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`}
                                stroke={palette[(colorIdx.get(graph.nodes.find((n) => n.id === l.source)?.name) ?? 0) % (palette.length || 1)] || t.accent}
                                strokeWidth={sw}
                                strokeOpacity={on ? 0.75 : 0.12}
                                strokeLinecap="round"
                                markerEnd={options.showArrows === false ? undefined : `url(#dpx-arrow-${id})`}
                                // ⭐ 流れのアニメ（標準には無い）。⚠ 動かすのは
                                //   dashoffset だけ＝再描画面積が増えない
                                strokeDasharray={flow ? `${Math.max(6, sw * 2)} ${Math.max(4, sw * 1.5)}` : undefined}
                                style={{
                                    transition: 'stroke-opacity 0.12s ease',
                                    // ⚠ 既存の `dpxLinkFlow`（stroke-dashoffset のみを動かす）を使う。
                                    //   独自 keyframes を足さない＝合成に載る性質を保つ（§6.7.1）
                                    animation: flow
                                        ? `dpxLinkFlow ${Math.max(0.8, 3 - sw * 0.15)}s linear infinite`
                                        : undefined,
                                }}
                                onMouseEnter={() => setHover({ type: 'link', key: i })}
                                onMouseLeave={() => setHover(null)}
                                onClick={(originalEvent) =>
                                    onEventTrigger?.({
                                        type: 'link.click',
                                        originalEvent,
                                        payload: {
                                            name: fields[0] ?? 'source',
                                            value: l.source,
                                            [`row.${fields[0] ?? 'source'}.value`]: l.source,
                                            [`row.${fields[1] ?? 'target'}.value`]: l.target,
                                            'row.value.value': l.value,
                                        },
                                    })
                                }
                            />
                        );
                    })}
                </g>

                {/* ノード */}
                <g>
                    {graph.nodes.map((n) => {
                        const p = at(n.id);
                        const on = !dimAll || activeNodes?.has(n.id) || activeLinks === undefined;
                        const shown = !dimAll || activeNodes?.has(n.id);
                        const r = radiusFor(n.id);
                        const ruled = colorCfg ? colorForValue(colorCfg, totals.get(n.id) ?? 0) : null;
                        const fill = ruled || palette[(colorIdx.get(n.name) ?? 0) % (palette.length || 1)] || t.accent;
                        return (
                            <g
                                key={n.id}
                                style={{ opacity: shown ? 1 : 0.18, transition: 'opacity 0.12s ease' }}
                                onMouseEnter={() => setHover({ type: 'node', key: n.id })}
                                onMouseLeave={() => setHover(null)}
                                onClick={(originalEvent) =>
                                    onEventTrigger?.({
                                        type: 'node.click',
                                        originalEvent,
                                        payload: {
                                            name: fields[0] ?? 'node',
                                            value: n.name,
                                            [`row.${fields[0] ?? 'node'}.value`]: n.name,
                                        },
                                    })
                                }
                            >
                                <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={r}
                                    fill={fill}
                                    stroke={t.panelBg || 'rgba(0,0,0,0.35)'}
                                    strokeWidth={1.5}
                                    style={{ cursor: onEventTrigger ? 'pointer' : 'default' }}
                                />
                                {options.showLabels === false ? null : (
                                    <text
                                        x={p.x}
                                        y={p.y - r - 4}
                                        textAnchor="middle"
                                        style={{ fontSize: labelSize, fill: t.titleColor, pointerEvents: 'none' }}
                                    >
                                        {n.name}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </g>
            </svg>

            <VizTooltip
                t={t}
                x={pt.x}
                y={pt.y}
                width={w}
                height={h}
                title={tipTitle}
                rows={tipRows}
                accent={t.accent}
            />
        </div>
    );
}

DpxLinkGraph.config = {
    key: 'dpx.linkGraph',
    name: '関係図（ネットワーク）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        nodeSize: { type: 'number', default: 7 },
        scaleNodeSize: { type: 'boolean', default: true },
        maxLinkWidth: { type: 'number', default: 8 },
        scaleLinkWidth: { type: 'boolean', default: true },
        showArrows: { type: 'boolean', default: true },
        animateFlow: { type: 'boolean', default: true },
        showLabels: { type: 'boolean', default: true },
        labelSize: { type: 'number', default: 11 },
        iterations: { type: 'number', default: 220 },
        topN: { type: 'number', default: 0 },
        otherLabel: { type: 'string', default: 'その他' },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: 'ノード',
            layout: [
                [{ label: '大きさ(px)', option: 'nodeSize', editor: 'editor.slider', editorProps: { min: 3, max: 20, step: 1 } }],
                [{ label: '流量で大小を変える', option: 'scaleNodeSize', editor: 'editor.checkbox' }],
                [{ label: '名前を表示', option: 'showLabels', editor: 'editor.checkbox' }],
                [{ label: '文字の大きさ(px)', option: 'labelSize', editor: 'editor.number', editorProps: { min: 8, max: 20 } }],
            ],
        },
        {
            label: '線',
            layout: [
                [{ label: '最大の太さ(px)', option: 'maxLinkWidth', editor: 'editor.slider', editorProps: { min: 2, max: 20, step: 1 } }],
                [{ label: '流量で太さを変える', option: 'scaleLinkWidth', editor: 'editor.checkbox' }],
                [{ label: '矢印を表示', option: 'showArrows', editor: 'editor.checkbox' }],
                [{ label: '流れを動かす', option: 'animateFlow', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '配置と集約',
            layout: [
                [{ label: '配置の収束回数', option: 'iterations', editor: 'editor.slider', editorProps: { min: 60, max: 500, step: 20 } }],
                [{ label: '上位N件に集約(0で全件)', option: 'topN', editor: 'editor.number', editorProps: { min: 0, max: 200 } }],
                [{ label: '集約先の名前', option: 'otherLabel', editor: 'editor.text' }],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};
