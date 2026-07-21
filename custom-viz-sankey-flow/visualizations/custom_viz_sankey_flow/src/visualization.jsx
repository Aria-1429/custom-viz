import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sankey, sankeyJustify, sankeyLinkHorizontal } from 'd3-sankey';
import './visualization.css';

// ---------------------------------------------------------------------------
// Sankey フロー図（多段対応・オートフィット版）
//
// データモデル:
//   最終列 = 数値（フロー量）。それより前の列 = 経路のステージ。
//   - 3列 [source, target, value] … 自由グラフモード。source/target は同じ名前空間を
//     共有し、a→b と b→c を行として並べれば多段の連鎖になる（循環リンクは自動除去）。
//   - 4列以上 [stage1, stage2, ..., value] … ステージモード。列がそのまま段になり、
//     各行が stage1→stage2→…→stageN のパスとして値ぶんの流量を運ぶ。
//
// 同じ (source, target) ペアは合算する。値が数値でない・0以下・名前が空の行は捨てる。
// レイアウトは d3-sankey（純粋な計算ライブラリ。ネットワーク通信なし・バンドル同梱）。
//
// 表示はコンテナ実寸に自動フィット（ResizeObserver、無い環境は初回計測フォールバック）。
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
// 編集画面で設定した値は useOptions() で受け取り、normalizeOptions で安全側に補正する。
//
// 【リンクの色分け】
// editor.dynamicColor はカスタム viz では使えない（範囲配列が options に来ない）ため、
// 値→色は「低値色 →(中間色)→ 高値色」を線形補間する自前カラースケールで実装する。
// - useGradientLinks: ソースノード色→ターゲットノード色の SVG グラデーション（既定）
// - useValueColors:   リンクの値でカラースケール着色（gradient より優先）
const DEFAULTS = {
    useGradientLinks: true, // リンクを source→target 色のグラデーションにする
    linkOpacity: 40, // リンクの不透明度（%）
    useValueColors: false, // ON でリンクを値ベースのカラースケールで着色
    lowColor: '#3fb950', // スケール低値側（安全＝緑）
    highColor: '#ef4d4d', // スケール高値側（危険＝赤）
    useMidColor: true, // 中間色を挟んで 3 色スケールにする
    midColor: '#f5c518', // 中間色（黄）
    reverse: false, // 低↔高を反転
    nodeWidth: 12, // ノード（縦棒）の幅 px
    nodePadding: 14, // 同一段内のノード間の余白 px
    showLabels: true, // ノードラベルを表示
    showValues: true, // ラベルに値を併記
    labelSize: 0, // ラベル文字サイズ px（0 = 自動）
    showHeader: true, // 上部サマリー（総流量・ノード数など）
    highlightOnHover: true, // ホバーで関連フローをハイライト
    debug: false, // options の生値を画面に出す診断オーバーレイ
};

// ノードのカテゴリカルパレット（Splunk のデータビズ配色に寄せた 12 色。
// ライト/ダーク両テーマで視認できる中彩度〜高彩度）
const PALETTE = [
    '#7B56DB', '#009CEB', '#00CDAF', '#DD9900', '#FF677B', '#CB2196',
    '#5A4575', '#6B85FA', '#8CD156', '#F6540B', '#B6C75A', '#0051B5',
];

// レイアウト破綻を防ぐための上限（値の大きい順に残す）
const MAX_LINKS = 500;

// ステージモードのノード ID 区切り（フィールド値に現れない制御文字）
const SEP = '';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

// サーチ結果を rows 形式に正規化（rows / columns 両対応・落とさない）
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        // 想定外の形式でも落とさない
    }
    return [];
}

// "1,234" / " 42 " などを数値化。数値化できなければ NaN
function parseNum(v) {
    if (v === null || v === undefined) return NaN;
    return Number(String(v).replace(/,/g, '').trim());
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function isHexColor(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
}

// options を型・範囲の面で安全側に補正（未設定・型不一致に耐える）
function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const bool = (key) => (o[key] === undefined ? DEFAULTS[key] : !!o[key]);
    const num = (key, lo, hi) => {
        const n = parseNum(o[key]);
        if (!Number.isFinite(n)) return DEFAULTS[key];
        return clamp(n, lo, hi);
    };
    const color = (key) => (isHexColor(o[key]) ? o[key].trim() : DEFAULTS[key]);
    return {
        useGradientLinks: bool('useGradientLinks'),
        linkOpacity: num('linkOpacity', 5, 100),
        useValueColors: bool('useValueColors'),
        lowColor: color('lowColor'),
        highColor: color('highColor'),
        useMidColor: bool('useMidColor'),
        midColor: color('midColor'),
        reverse: bool('reverse'),
        nodeWidth: num('nodeWidth', 4, 60),
        nodePadding: num('nodePadding', 2, 80),
        showLabels: bool('showLabels'),
        showValues: bool('showValues'),
        labelSize: num('labelSize', 0, 32),
        showHeader: bool('showHeader'),
        highlightOnHover: bool('highlightOnHover'),
        debug: bool('debug'),
    };
}

// ---------------------------------------------------------------------------
// 値→色カラースケール（editor.dynamicColor の代替。knowledge §4 の定番パターン）
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = clamp(t, 0, 1);
    const c = a.map((av, i) => Math.round(av + (b[i] - av) * u));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// t(0..1) をオプションに従って色へ。reverse / 3色スケールに対応
function scaleColorFor(t, opts) {
    let u = clamp(Number.isFinite(t) ? t : 0.5, 0, 1);
    if (opts.reverse) u = 1 - u;
    if (opts.useMidColor) {
        if (u <= 0.5) return lerpColor(opts.lowColor, opts.midColor, u / 0.5);
        return lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

// ---------------------------------------------------------------------------
// 数値フォーマット
// ---------------------------------------------------------------------------

function fmtCompact(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
}

function fmtFull(v) {
    if (!Number.isFinite(v)) return '-';
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// グラフ構築（行 → ノード/リンク）
// ---------------------------------------------------------------------------

// 自由グラフモード用: リンク u→v を追加すると循環になるか（v から u へ到達可能か）
function reaches(adj, from, to, seen) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const nexts = adj.get(from);
    if (!nexts) return false;
    for (const n of nexts) {
        if (reaches(adj, n, to, seen)) return true;
    }
    return false;
}

// rows からノード/リンクを組み立てる。返り値:
//   { nodes, links, staged, droppedCyclic, droppedInvalid, truncated, error }
function buildGraph(rows) {
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount < 3) return { error: 'columns' };

    const valueIdx = colCount - 1;
    const stageCount = colCount - 1; // value 列より前が全部ステージ
    const staged = stageCount > 2; // 4列以上 → ステージモード

    // (source id, target id) → 合算値
    const linkMap = new Map();
    // node id → { id, name, firstStage }
    const nodeMap = new Map();
    let droppedInvalid = 0;

    const addNode = (id, name, stage) => {
        if (!nodeMap.has(id)) nodeMap.set(id, { id, name, firstStage: stage });
    };
    const addLink = (srcId, tgtId, value) => {
        const key = srcId + SEP + SEP + tgtId;
        linkMap.set(key, (linkMap.get(key) || 0) + value);
    };

    for (const row of rows) {
        if (!Array.isArray(row)) {
            droppedInvalid += 1;
            continue;
        }
        const value = parseNum(row[valueIdx]);
        if (!Number.isFinite(value) || value <= 0) {
            droppedInvalid += 1;
            continue;
        }
        const names = [];
        let bad = false;
        for (let i = 0; i < stageCount; i += 1) {
            const name = row[i] === null || row[i] === undefined ? '' : String(row[i]).trim();
            if (name === '') bad = true;
            names.push(name);
        }
        if (bad) {
            droppedInvalid += 1;
            continue;
        }
        if (staged) {
            // ステージモード: 列位置を ID に含めて段を分離（同名でも段が違えば別ノード）
            for (let i = 0; i < names.length - 1; i += 1) {
                const a = `${i}${SEP}${names[i]}`;
                const b = `${i + 1}${SEP}${names[i + 1]}`;
                addNode(a, names[i], i);
                addNode(b, names[i + 1], i + 1);
                addLink(a, b, value);
            }
        } else {
            // 自由グラフモード: 名前空間共有。自己ループは捨てる
            const [src, tgt] = names;
            if (src === tgt) {
                droppedInvalid += 1;
                continue;
            }
            addNode(src, src, 0);
            addNode(tgt, tgt, 1);
            addLink(src, tgt, value);
        }
    }

    // 値の大きい順に整列（循環除去・上限カットとも「大きいフローを優先して残す」方針）
    let entries = Array.from(linkMap.entries())
        .map(([key, value]) => {
            const [source, target] = key.split(SEP + SEP);
            return { source, target, value };
        })
        .sort((a, b) => b.value - a.value);

    let truncated = 0;
    if (entries.length > MAX_LINKS) {
        truncated = entries.length - MAX_LINKS;
        entries = entries.slice(0, MAX_LINKS);
    }

    // 自由グラフモードのみ循環を除去（ステージモードは構造上 DAG）
    let droppedCyclic = 0;
    if (!staged) {
        const adj = new Map();
        const kept = [];
        for (const link of entries) {
            if (reaches(adj, link.target, link.source, new Set())) {
                droppedCyclic += 1;
                continue;
            }
            if (!adj.has(link.source)) adj.set(link.source, []);
            adj.get(link.source).push(link.target);
            kept.push(link);
        }
        entries = kept;
    }

    if (entries.length === 0) return { error: 'nolinks', droppedInvalid, droppedCyclic };

    // リンクに残ったノードだけ拾う
    const used = new Set();
    entries.forEach((l) => {
        used.add(l.source);
        used.add(l.target);
    });
    const nodes = Array.from(nodeMap.values()).filter((n) => used.has(n.id));

    // 色は「表示名」単位で割り当て（ステージをまたいで同名なら同色 → 流れを追いやすい）
    const colorByName = new Map();
    nodes
        .slice()
        .sort((a, b) => a.firstStage - b.firstStage)
        .forEach((n) => {
            if (!colorByName.has(n.name)) colorByName.set(n.name, colorByName.size);
        });
    nodes.forEach((n) => {
        n.color = PALETTE[colorByName.get(n.name) % PALETTE.length];
    });

    return { nodes, links: entries, staged, droppedCyclic, droppedInvalid, truncated };
}

// ---------------------------------------------------------------------------
// コンテナ実寸を購読するフック（ResizeObserver、無い環境では初回計測フォールバック）
// ---------------------------------------------------------------------------

function useContainerSize(ref) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const measure = () => {
            setSize((prev) => {
                const width = el.clientWidth;
                const height = el.clientHeight;
                if (prev.width === width && prev.height === height) return prev;
                return { width, height };
            });
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function themeColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#e1e6eb',
            muted: '#8a9aa8',
            nodeStroke: 'rgba(255,255,255,0.18)',
            tooltipBg: 'rgba(23,29,36,0.96)',
            tooltipBorder: 'rgba(255,255,255,0.14)',
            headerBorder: 'rgba(255,255,255,0.10)',
        };
    }
    return {
        text: '#31373e',
        muted: '#6b7785',
        nodeStroke: 'rgba(0,0,0,0.22)',
        tooltipBg: 'rgba(255,255,255,0.97)',
        tooltipBorder: 'rgba(0,0,0,0.14)',
        headerBorder: 'rgba(0,0,0,0.08)',
    };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

let uidSeq = 0;

function SankeyFlow({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const containerRef = useRef(null);
    const { width, height } = useContainerSize(containerRef);
    const [hover, setHover] = useState(null); // {type:'node'|'link', key} | null
    const [tooltip, setTooltip] = useState(null); // {x, y, lines} | null
    const uid = useMemo(() => `skf${(uidSeq += 1)}`, []);
    const colors = themeColors(mode);

    const data = dataSources?.primary?.data;
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);

    // 行 → グラフ（ノード/リンク）
    const graph = useMemo(() => buildGraph(rows), [rows]);

    // ヘッダー分を差し引いた描画領域
    const headerH = opts.showHeader ? 34 : 0;
    const chartW = width;
    const chartH = Math.max(0, height - headerH);

    // d3-sankey レイアウト（入力を毎回コピー: d3 が nodes/links を破壊的に書き換えるため)
    const layout = useMemo(() => {
        if (graph.error || chartW < 60 || chartH < 60) return null;
        try {
            const gen = sankey()
                .nodeId((d) => d.id)
                .nodeAlign(sankeyJustify)
                .nodeWidth(opts.nodeWidth)
                .nodePadding(opts.nodePadding)
                .extent([[6, 6], [chartW - 6, chartH - 8]]);
            const out = gen({
                nodes: graph.nodes.map((n) => ({ ...n })),
                links: graph.links.map((l) => ({ ...l })),
            });
            // 総流量 = 入力リンクを持たない「源流ノード」の値の合計
            const totalFlow = out.nodes
                .filter((n) => (n.targetLinks || []).length === 0)
                .reduce((s, n) => s + (n.value || 0), 0);
            // リンク値カラースケール用の min/max
            let minL = Infinity;
            let maxL = -Infinity;
            out.links.forEach((l) => {
                if (l.value < minL) minL = l.value;
                if (l.value > maxL) maxL = l.value;
            });
            const stages = 1 + out.nodes.reduce((m, n) => Math.max(m, n.depth || 0), 0);
            return { ...out, totalFlow, minL, maxL, stages };
        } catch (e) {
            return { layoutError: String(e && e.message ? e.message : e) };
        }
    }, [graph, chartW, chartH, opts.nodeWidth, opts.nodePadding]);

    // ラベルサイズ（0 = 自動: 高さに応じて 10〜13px）
    const fontSize = opts.labelSize > 0
        ? opts.labelSize
        : clamp(Math.round(chartH / 30), 10, 13);

    // ホバー状態からリンク/ノードの強調度を決める
    const baseLinkOpacity = opts.linkOpacity / 100;
    const linkOpacityFor = (link, idx) => {
        if (!opts.highlightOnHover || !hover) return baseLinkOpacity;
        const active = hover.type === 'link'
            ? hover.key === idx
            : link.source.id === hover.key || link.target.id === hover.key;
        return active ? clamp(baseLinkOpacity * 2, 0.55, 0.95) : baseLinkOpacity * 0.15;
    };
    const nodeOpacityFor = (node) => {
        if (!opts.highlightOnHover || !hover) return 1;
        if (hover.type === 'node') {
            const active = node.id === hover.key
                || (node.sourceLinks || []).some((l) => l.target.id === hover.key)
                || (node.targetLinks || []).some((l) => l.source.id === hover.key);
            return active ? 1 : 0.3;
        }
        const link = layout?.links?.[hover.key];
        if (!link) return 1;
        return node.id === link.source.id || node.id === link.target.id ? 1 : 0.3;
    };

    // ツールチップ（コンテナ相対座標に変換し、右端では左に反転）
    const showTooltip = (evt, lines) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = evt.clientX - rect.left + 12;
        const y = clamp(evt.clientY - rect.top + 12, 0, Math.max(0, height - 70));
        if (x > width - 180) x = Math.max(0, evt.clientX - rect.left - 192);
        setTooltip({ x, y, lines });
    };
    const clearHover = () => {
        setHover(null);
        setTooltip(null);
    };

    // ---- 状態別の表示 ----------------------------------------------------

    const centerBox = (child) => (
        <div
            ref={containerRef}
            style={{
                width: '100%', height: '100%', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
            }}
        >
            {child}
        </div>
    );

    if (loading && rows.length === 0) return centerBox(<WaitSpinner size="medium" />);
    if (!data || rows.length === 0) {
        return centerBox(<Paragraph>No data. Run a search that returns results.</Paragraph>);
    }
    if (graph.error === 'columns') {
        return centerBox(
            <Paragraph>
                Sankey needs at least 3 columns: source, target, value
                (or stage1, stage2, …, value).
            </Paragraph>
        );
    }
    if (graph.error === 'nolinks') {
        return centerBox(
            <Paragraph>
                No valid flow links found. Check that the last column is numeric ({'>'} 0)
                and the category columns are non-empty.
            </Paragraph>
        );
    }

    const notices = [];
    if (graph.droppedCyclic > 0) notices.push(`${graph.droppedCyclic} cyclic`);
    if (graph.truncated > 0) notices.push(`${graph.truncated} smallest`);

    // ---- 描画 ------------------------------------------------------------

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
            onMouseLeave={clearHover}
        >
            {opts.showHeader && layout && !layout.layoutError && (
                <div
                    style={{
                        height: headerH - 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        padding: '0 8px',
                        fontSize: 12,
                        color: colors.muted,
                        borderBottom: `1px solid ${colors.headerBorder}`,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    <span>
                        Total{' '}
                        <strong style={{ color: colors.text }}>{fmtFull(layout.totalFlow)}</strong>
                    </span>
                    <span>{layout.stages} stages</span>
                    <span>{layout.nodes.length} nodes</span>
                    <span>{layout.links.length} links</span>
                    {notices.length > 0 && <span>(dropped: {notices.join(', ')})</span>}
                    {opts.useValueColors && (
                        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{fmtCompact(layout.minL)}</span>
                            <span
                                style={{
                                    width: 72,
                                    height: 8,
                                    borderRadius: 4,
                                    background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
                                        .map((t) => scaleColorFor(t, opts))
                                        .join(', ')})`,
                                }}
                            />
                            <span>{fmtCompact(layout.maxL)}</span>
                        </span>
                    )}
                </div>
            )}

            {layout && layout.layoutError && centerBox(
                <Paragraph>Layout failed: {layout.layoutError}</Paragraph>
            )}

            {layout && !layout.layoutError && (
                <svg
                    width={chartW}
                    height={chartH}
                    style={{ display: 'block' }}
                    role="img"
                    aria-label="Sankey flow diagram"
                >
                    {/* リンク用グラデーション定義（source色 → target色） */}
                    {opts.useGradientLinks && !opts.useValueColors && (
                        <defs>
                            {layout.links.map((link, i) => (
                                <linearGradient
                                    key={`g${i}`}
                                    id={`${uid}-g${i}`}
                                    gradientUnits="userSpaceOnUse"
                                    x1={link.source.x1}
                                    x2={link.target.x0}
                                    y1="0"
                                    y2="0"
                                >
                                    <stop offset="0%" stopColor={link.source.color} />
                                    <stop offset="100%" stopColor={link.target.color} />
                                </linearGradient>
                            ))}
                        </defs>
                    )}

                    {/* リンク */}
                    <g fill="none">
                        {layout.links.map((link, i) => {
                            let stroke;
                            if (opts.useValueColors) {
                                const span = layout.maxL - layout.minL;
                                const t = span > 0 ? (link.value - layout.minL) / span : 0.5;
                                stroke = scaleColorFor(t, opts);
                            } else if (opts.useGradientLinks) {
                                stroke = `url(#${uid}-g${i})`;
                            } else {
                                stroke = link.source.color;
                            }
                            const pct = layout.totalFlow > 0
                                ? ((link.value / layout.totalFlow) * 100).toFixed(1)
                                : null;
                            return (
                                <path
                                    key={`l${i}`}
                                    d={sankeyLinkHorizontal()(link)}
                                    stroke={stroke}
                                    strokeWidth={Math.max(1, link.width)}
                                    strokeOpacity={linkOpacityFor(link, i)}
                                    style={{ transition: 'stroke-opacity 120ms', cursor: 'default' }}
                                    onMouseEnter={() => setHover({ type: 'link', key: i })}
                                    onMouseMove={(evt) => showTooltip(evt, [
                                        `${link.source.name} → ${link.target.name}`,
                                        `${fmtFull(link.value)}${pct !== null ? ` (${pct}% of total)` : ''}`,
                                    ])}
                                    onMouseLeave={clearHover}
                                />
                            );
                        })}
                    </g>

                    {/* ノード */}
                    <g>
                        {layout.nodes.map((node) => {
                            const h = Math.max(1, node.y1 - node.y0);
                            const pct = layout.totalFlow > 0
                                ? ((node.value / layout.totalFlow) * 100).toFixed(1)
                                : null;
                            return (
                                <rect
                                    key={node.id}
                                    x={node.x0}
                                    y={node.y0}
                                    width={Math.max(1, node.x1 - node.x0)}
                                    height={h}
                                    rx={2}
                                    fill={node.color}
                                    stroke={colors.nodeStroke}
                                    strokeWidth={0.5}
                                    opacity={nodeOpacityFor(node)}
                                    style={{ transition: 'opacity 120ms', cursor: 'default' }}
                                    onMouseEnter={() => setHover({ type: 'node', key: node.id })}
                                    onMouseMove={(evt) => showTooltip(evt, [
                                        node.name,
                                        `${fmtFull(node.value)}${pct !== null ? ` (${pct}% of total)` : ''}`,
                                        `${(node.targetLinks || []).length} in / ${(node.sourceLinks || []).length} out`,
                                    ])}
                                    onMouseLeave={clearHover}
                                />
                            );
                        })}
                    </g>

                    {/* ラベル（左半分のノードは右側に、右半分のノードは左側に） */}
                    {opts.showLabels && (
                        <g style={{ pointerEvents: 'none' }}>
                            {layout.nodes.map((node) => {
                                const h = node.y1 - node.y0;
                                const hovered = hover && hover.type === 'node' && hover.key === node.id;
                                if (h < fontSize * 0.55 && !hovered) return null;
                                const onLeftHalf = (node.x0 + node.x1) / 2 < chartW / 2;
                                return (
                                    <text
                                        key={`t${node.id}`}
                                        x={onLeftHalf ? node.x1 + 6 : node.x0 - 6}
                                        y={(node.y0 + node.y1) / 2}
                                        dy="0.35em"
                                        textAnchor={onLeftHalf ? 'start' : 'end'}
                                        fontSize={fontSize}
                                        fill={colors.text}
                                        opacity={nodeOpacityFor(node)}
                                        style={{ transition: 'opacity 120ms' }}
                                    >
                                        {node.name}
                                        {opts.showValues && (
                                            <tspan fill={colors.muted} fontSize={fontSize - 1}>
                                                {` ${fmtCompact(node.value)}`}
                                            </tspan>
                                        )}
                                    </text>
                                );
                            })}
                        </g>
                    )}
                </svg>
            )}

            {/* ツールチップ */}
            {tooltip && (
                <div
                    style={{
                        position: 'absolute',
                        left: tooltip.x,
                        top: tooltip.y,
                        maxWidth: 240,
                        padding: '6px 10px',
                        borderRadius: 6,
                        background: colors.tooltipBg,
                        border: `1px solid ${colors.tooltipBorder}`,
                        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                        color: colors.text,
                        fontSize: 12,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                        zIndex: 10,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {tooltip.lines.map((line, i) => (
                        <div key={i} style={i === 0 ? { fontWeight: 600 } : { color: colors.muted }}>
                            {line}
                        </div>
                    ))}
                </div>
            )}

            {/* 診断オーバーレイ（options の生値を確認する。dynamicColor 事件の教訓） */}
            {opts.debug && (
                <pre
                    style={{
                        position: 'absolute',
                        right: 4,
                        bottom: 4,
                        maxWidth: '60%',
                        maxHeight: '60%',
                        overflow: 'auto',
                        margin: 0,
                        padding: 8,
                        fontSize: 10,
                        background: colors.tooltipBg,
                        border: `1px solid ${colors.tooltipBorder}`,
                        borderRadius: 6,
                        color: colors.text,
                        zIndex: 20,
                    }}
                >
                    {JSON.stringify({ options, normalized: opts }, null, 2)}
                </pre>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（テーマガード必須: テーマ未取得の間はレンダリングしない）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <SankeyFlow mode={mode} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。公式フックは購読登録時に現在値を再送しないため、
// 初期 state がマウントより後に届くと取り逃して永久に描画されないことがある。
// 最大5秒待っても揃わない場合はフォールバック描画（テーマは light 既定）に入る。
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
    } catch (e) {
        return false;
    }
}

function mountApp() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(
        <VisualizationExtensionProvider>
            <App />
        </VisualizationExtensionProvider>
    );
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
