import React from 'react';
import { sankey as d3Sankey, sankeyJustify, sankeyLeft, sankeyLinkHorizontal } from 'd3-sankey';

import {
    EmptyHint,
    VizTooltip,
    buildFlowGraph,
    colorIndexByName,
    fmtNumber,
    lossByStage,
    tracePath,
    useContainerSize,
    useDpxTheme,
    usePointer,
    useVizData,
} from '..';

// ── dpx.sankey（フロー図）──────────────────────────────────────
//
// データ規約:
//   - **3 列** … `src, dst, value`（2 段のフロー）
//   - **4 列以上** … `stage1, stage2, …, value`（**多段フロー**）
//
// ## 標準 `splunk.sankey` と何が違うか
//
// **実測（2026-08-09 実機・バンドルから schema 抽出）**: 標準のオプションは
// **7 個だけ**（`backgroundColor` / `colorMode` / `linkColors` / `linkOpacity` /
// `linkValues` / `resultLimit` / `seriesColors`）。
//
// | | splunk.sankey | dpx.sankey |
// |---|---|---|
// | **4 列以上のデータ** | ❌ **3 列目以降を黙って捨てる**（実機確認） | ✅ **全段を描く** |
// | 段内の並び順 | ✗ | ✅ 値順 / 名前順 / 自動 |
// | ノード幅・間隔 | ✗ | ✅ |
// | **経路の追跡** | ✗（隣接すら光らない） | ✅ ホバーで**上流〜下流を全部**強調 |
// | **段ごとの損失** | ✗ | ✅ 離脱・ロスを数値で表示 |
// | 上位 N 件への集約 | ✗（`resultLimit` は**切り捨て**） | ✅ 「その他」へ**畳む**（合計が合う） |
// | 循環データ | ✗ | ✅ 検出して除去（件数を表示） |
//
// ⚠ **`resultLimit` の切り捨てと `topN` の集約は別物**。切り捨ては合計が
//   合わなくなるが、集約は「その他」に足すので**合計が保たれる**。
// ────────────────────────────────────────────────────────────────

/** 何も無いときの説明。⚠ 列数が足りない場合は「何が足りないか」を書く。 */
const HINTS = {
    columns: 'データがありません（3列以上: 送信元, 送信先, 値）',
    nolinks: '描けるフローがありません（値が正の行がない／全て循環）',
};

export function DpxSankey({ dataSources, options = {}, width, height, loading, onEventTrigger, id }) {
    // ⚠ フックは early return より前（§8.1 の白紙バグ対策）
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const [pt, pointerProps] = usePointer();
    const [hover, setHover] = React.useState(null);
    // ⚠ **`width` プロップではなく実測を使う**。プロップは既定値のことがあり、
    //   そのまま SVG 幅にすると**パネルの一部しか使わない絵**になる（実機で発生）
    const [sizeRef, measuredW] = useContainerSize();

    const topN = Number(options.topN) || 0;
    const graph = React.useMemo(
        () => buildFlowGraph(d.isEmpty ? [] : d.rows(), { topN, otherLabel: options.otherLabel }),
        [d, topN, options.otherLabel]
    );

    // 実測が取れていればそちらを優先（プロップは初期値のことがある）
    const w = measuredW > 20 ? measuredW : typeof width === 'number' ? width : 480;
    const h = typeof height === 'number' ? height : 300;
    const showLoss = options.showLoss !== false;
    // 損失の帯を出す段だけ下に余白を作る（出さないなら詰める）
    const footH = showLoss ? 18 : 0;
    const chartW = Math.max(40, w - 8);
    const chartH = Math.max(40, h - 8 - footH);

    const layout = React.useMemo(() => {
        if (graph.error || chartW < 60 || chartH < 60) return null;
        try {
            const gen = d3Sankey()
                .nodeId((n) => n.id)
                // ⚠ 段構造は「左詰め」でないと段が揃わない（justify は
                //   末端ノードを右端へ寄せるので、段の意味が崩れる）
                .nodeAlign(graph.staged ? sankeyLeft : sankeyJustify)
                .nodeWidth(Number(options.nodeWidth) || 14)
                .nodePadding(Number(options.nodePadding) || 10)
                .extent([
                    [4, 6],
                    [chartW - 4, chartH - 6],
                ]);

            if (options.nodeSort === 'value') gen.nodeSort((a, b) => b.value - a.value);
            else if (options.nodeSort === 'name') {
                gen.nodeSort((a, b) => String(a.name).localeCompare(String(b.name)));
            }

            // ⚠ d3-sankey は入力を**破壊的に書き換える**。必ず複製して渡す
            //   （渡さないと useMemo の再計算で二重に加工される）
            const out = gen({
                nodes: graph.nodes.map((n) => ({ ...n })),
                links: graph.links.map((l) => ({ ...l })),
            });
            out.links.forEach((l, i) => {
                l.index = i;
            });
            const nodeById = new Map(out.nodes.map((n) => [n.id, n]));
            return { ...out, nodeById, loss: lossByStage(out.nodes) };
        } catch (e) {
            // レイアウトが解けなくても**パネルは残す**（白紙にしない）
            return { layoutError: String(e?.message ?? e) };
        }
    }, [graph, chartW, chartH, options.nodeWidth, options.nodePadding, options.nodeSort]);

    // ホバー → 強調対象。⚠ フックなので early return より前に置く
    const traced = React.useMemo(() => {
        if (!layout || layout.layoutError || !hover) return null;
        if (hover.type === 'node') {
            // 経路追跡（標準には無い）。off なら隣接だけ
            if (options.traceMode !== 'neighbor') return tracePath(layout, hover.key);
            const node = layout.nodeById.get(hover.key);
            const nodeIds = new Set([hover.key]);
            const linkSet = new Set();
            (node?.sourceLinks ?? []).forEach((l) => {
                linkSet.add(l.index);
                nodeIds.add(l.target.id);
            });
            (node?.targetLinks ?? []).forEach((l) => {
                linkSet.add(l.index);
                nodeIds.add(l.source.id);
            });
            return { nodeIds, linkSet };
        }
        const link = layout.links[hover.key];
        if (!link) return null;
        return { nodeIds: new Set([link.source.id, link.target.id]), linkSet: new Set([link.index]) };
    }, [layout, hover, options.traceMode]);

    const colorIdx = React.useMemo(() => colorIndexByName(graph.nodes), [graph.nodes]);

    // ⚠⚠ **早期 return でも計測用の div を必ず描く。**
    //   ref が付いた要素が DOM に出ないと幅が測れず、`layout` が永久に
    //   null のまま＝「狭すぎます」から抜け出せない**デッドロック**になる
    const notice = graph.error
        ? (HINTS[graph.error] ?? HINTS.nolinks)
        : !layout
          ? null // 幅の計測待ち。文言を出さない（一瞬で消えるため）
          : layout.layoutError
            ? `レイアウトできません: ${layout.layoutError}`
            : null;
    if (graph.error || !layout || layout.layoutError) {
        return (
            <div ref={sizeRef} style={{ width: '100%', height: h }}>
                {notice ? <EmptyHint loading={loading} message={notice} /> : null}
            </div>
        );
    }

    const palette = t.palette ?? [];
    const colorOf = (node) => palette[(colorIdx.get(node.name) ?? 0) % (palette.length || 1)] || t.accent;
    const linkOpacity = Number.isFinite(Number(options.linkOpacity)) ? Number(options.linkOpacity) : 0.42;
    const fields = d.fieldNames;
    const labelSize = Number(options.labelSize) || Math.max(10, Math.min(13, Math.round(chartH / 26)));
    const dim = (on) => (traced ? (on ? 1 : 0.15) : 1);

    // ツールチップの中身（ホバー対象で変わる）
    let tipTitle = null;
    let tipRows = [];
    if (hover?.type === 'node') {
        const n = layout.nodeById.get(hover.key);
        if (n) {
            tipTitle = n.name;
            tipRows = [
                { label: '合計', value: fmtNumber(n.value ?? 0) },
                { label: '入力', value: String((n.targetLinks ?? []).length) },
                { label: '出力', value: String((n.sourceLinks ?? []).length) },
            ];
        }
    } else if (hover?.type === 'link') {
        const l = layout.links[hover.key];
        if (l) {
            tipTitle = `${l.source.name} → ${l.target.name}`;
            tipRows = [{ label: '流量', value: fmtNumber(l.value) }];
        }
    }

    return (
        <div ref={sizeRef} style={{ position: 'relative', width: '100%', height: h }} {...pointerProps}>
            <svg width={chartW} height={chartH} style={{ display: 'block' }}>
                {/* リボン（リンク）。⚠ 先に描く＝ノードの下に敷く */}
                <g fill="none">
                    {layout.links.map((l) => {
                        const on = !traced || traced.linkSet.has(l.index);
                        return (
                            <path
                                key={l.index}
                                d={sankeyLinkHorizontal()(l)}
                                stroke={colorOf(l.source)}
                                // ⚠ 幅は 1px 未満にしない（0 だと消えて「欠けた」ように見える）
                                strokeWidth={Math.max(1, l.width || 0)}
                                strokeOpacity={on ? linkOpacity : linkOpacity * 0.3}
                                style={{ opacity: dim(on), transition: 'opacity 0.12s ease' }}
                                onMouseEnter={() => setHover({ type: 'link', key: l.index })}
                                onMouseLeave={() => setHover(null)}
                                onClick={(originalEvent) =>
                                    onEventTrigger?.({
                                        type: 'link.click',
                                        originalEvent,
                                        payload: {
                                            name: fields[0] ?? 'source',
                                            value: l.source.name,
                                            [`row.${fields[0] ?? 'source'}.value`]: l.source.name,
                                            [`row.${fields[1] ?? 'target'}.value`]: l.target.name,
                                            'row.value.value': l.value,
                                        },
                                    })
                                }
                            />
                        );
                    })}
                </g>
                {/* ノード（縦棒）とラベル */}
                <g>
                    {layout.nodes.map((n) => {
                        const on = !traced || traced.nodeIds.has(n.id);
                        const nh = Math.max(1, (n.y1 ?? 0) - (n.y0 ?? 0));
                        const nw = Math.max(1, (n.x1 ?? 0) - (n.x0 ?? 0));
                        // ラベルは右に出すのが既定。右端に近いノードだけ左に返す
                        const flip = (n.x1 ?? 0) + 60 > chartW;
                        return (
                            <g
                                key={n.id}
                                style={{ opacity: dim(on), transition: 'opacity 0.12s ease' }}
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
                                <rect
                                    x={n.x0}
                                    y={n.y0}
                                    width={nw}
                                    height={nh}
                                    rx={2}
                                    fill={colorOf(n)}
                                    style={{ cursor: onEventTrigger ? 'pointer' : 'default' }}
                                />
                                {options.showLabels === false || nh < 8 ? null : (
                                    <text
                                        x={flip ? (n.x0 ?? 0) - 5 : (n.x1 ?? 0) + 5}
                                        y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2}
                                        dominantBaseline="middle"
                                        textAnchor={flip ? 'end' : 'start'}
                                        style={{ fontSize: labelSize, fill: t.titleColor, pointerEvents: 'none' }}
                                    >
                                        {n.name}
                                        {options.showValues !== false ? (
                                            <tspan style={{ fill: t.subColor }}>{` ${fmtNumber(n.value ?? 0)}`}</tspan>
                                        ) : null}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </g>
            </svg>

            {/* 段ごとの損失（標準には無い）。⚠ 損失 0 の段は出さない（帯が無意味に伸びる） */}
            {showLoss && layout.loss.some((s) => s.loss > 0) ? (
                <div
                    style={{
                        display: 'flex',
                        gap: 12,
                        padding: '2px 6px',
                        fontSize: 10,
                        color: t.subColor,
                        fontVariantNumeric: 'tabular-nums',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {layout.loss
                        .filter((s) => s.loss > 0)
                        .map((s) => (
                            <span key={s.depth}>
                                {`${s.depth + 1}→${s.depth + 2} 段 離脱 `}
                                <b style={{ color: t.errorColor || '#e5534b' }}>{fmtNumber(s.loss)}</b>
                                {` (${Math.round((s.loss / (s.incoming || 1)) * 100)}%)`}
                            </span>
                        ))}
                </div>
            ) : null}

            <VizTooltip
                t={t}
                x={pt.x}
                y={pt.y}
                width={chartW}
                height={chartH}
                title={tipTitle}
                rows={tipRows}
                accent={t.accent}
            />
        </div>
    );
}

DpxSankey.config = {
    key: 'dpx.sankey',
    name: 'フロー図（サンキー）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        nodeWidth: { type: 'number', default: 14 },
        nodePadding: { type: 'number', default: 10 },
        nodeSort: { type: 'string', default: 'auto' },
        linkOpacity: { type: 'number', default: 0.42 },
        showLabels: { type: 'boolean', default: true },
        showValues: { type: 'boolean', default: true },
        labelSize: { type: 'number', default: 0 },
        traceMode: { type: 'string', default: 'path' },
        showLoss: { type: 'boolean', default: true },
        topN: { type: 'number', default: 0 },
        otherLabel: { type: 'string', default: 'その他' },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: 'ノードの幅(px)', option: 'nodeWidth', editor: 'editor.slider', editorProps: { min: 4, max: 40, step: 1 } }],
                [{ label: 'ノードの間隔(px)', option: 'nodePadding', editor: 'editor.slider', editorProps: { min: 2, max: 40, step: 1 } }],
                [{ label: 'リボンの濃さ', option: 'linkOpacity', editor: 'editor.slider', editorProps: { min: 0.05, max: 1, step: 0.05 } }],
                [
                    {
                        label: '段内の並び順',
                        option: 'nodeSort',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'auto', label: '自動（交差を減らす）' },
                                { value: 'value', label: '値の大きい順' },
                                { value: 'name', label: '名前順' },
                            ],
                        },
                    },
                ],
            ],
        },
        {
            label: 'ラベル',
            layout: [
                [{ label: '名前を表示', option: 'showLabels', editor: 'editor.checkbox' }],
                [{ label: '値も表示', option: 'showValues', editor: 'editor.checkbox' }],
                [{ label: '文字の大きさ(px、0で自動)', option: 'labelSize', editor: 'editor.number', editorProps: { min: 0, max: 24 } }],
            ],
        },
        {
            label: '強調と集約',
            layout: [
                [
                    {
                        label: 'ホバー時の強調',
                        option: 'traceMode',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'path', label: '経路全体（上流〜下流）' },
                                { value: 'neighbor', label: '隣だけ' },
                            ],
                        },
                    },
                ],
                [{ label: '段ごとの離脱を表示', option: 'showLoss', editor: 'editor.checkbox' }],
                [{ label: '上位N件に集約(0で全件)', option: 'topN', editor: 'editor.number', editorProps: { min: 0, max: 200 } }],
                [{ label: '集約先の名前', option: 'otherLabel', editor: 'editor.text' }],
            ],
        },
    ],
};
