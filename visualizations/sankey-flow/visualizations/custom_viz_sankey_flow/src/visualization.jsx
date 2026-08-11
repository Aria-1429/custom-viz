import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
// ⚠ addDrilldownListener は /react ではなく /visualization にある（実機・型定義で確認済み）
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sankey, sankeyJustify, sankeyLinkHorizontal } from 'd3-sankey';
import './visualization.css';

// ---------------------------------------------------------------------------
// Sankey フロー図（多段対応・経路追跡・ドリルダウン対応）
//
// データモデル:
//   最終列 = 数値（フロー量）。それより前の列 = 経路のステージ。
//   - 3列 [source, target, value] … 自由グラフモード。source/target は同じ名前空間を
//     共有し、a→b と b→c を行として並べれば多段の連鎖になる。
//   - 4列以上 [stage1, stage2, ..., value] … ステージモード。列がそのまま段になり、
//     各行が stage1→stage2→…→stageN のパスとして値ぶんの流量を運ぶ。
//     ※ 標準 splunk.sankey は 4 列以上を渡すと 3 列目以降を黙って捨てる（実機確認済み）。
//
// 同じ (source, target) ペアは合算する。値が数値でない・0以下・名前が空の行は捨てる。
// レイアウトは d3-sankey（純粋な計算ライブラリ。ネットワーク通信なし・バンドル同梱）。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '2.0.2';

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
//
// 【リンクの色分け】colorMode で3方式を切り替える:
//   categorical … ノード色（既定。useGradientLinks で source→target グラデーション）
//   scale       … 値を low→(mid)→high で線形補間（自前カラースケール）
//   threshold   … editor.threshold の帯（配列が生で届く。dynamicColor は使えないため）
const DEFAULTS = {
    useGradientLinks: true,
    linkOpacity: 40,
    colorMode: 'categorical',
    lowColor: '#3fb950',
    highColor: '#ef4d4d',
    useMidColor: true,
    midColor: '#f5c518',
    reverse: false,
    colorBands: [
        { from: 0, to: 1000, value: '#3fb950' },
        { from: 1000, to: null, value: '#ef4d4d' },
    ],
    nodeColors: [],
    nodeWidth: 12,
    nodePadding: 14,
    nodeSort: 'auto',
    showLabels: true,
    showValues: true,
    labelSize: 0,
    valueUnit: '',
    unitPosition: 'after',
    showLinkLabels: false,
    showHeader: true,
    highlightOnHover: true,
    traceMode: 'path',
    topN: 0,
    otherLabel: 'その他',
    showLoss: false,
    lossColor: '#8a6d3b',
    cycleMode: 'drop',
};

// ノードのカテゴリカルパレット（Splunk のデータビズ配色に寄せた 12 色）
const PALETTE = [
    '#7B56DB', '#009CEB', '#00CDAF', '#DD9900', '#FF677B', '#CB2196',
    '#5A4575', '#6B85FA', '#8CD156', '#F6540B', '#B6C75A', '#0051B5',
];

// レイアウト破綻を防ぐための上限（値の大きい順に残す）
const MAX_LINKS = 500;

// ステージモードのノード ID 区切り（フィールド値に現れない制御文字）
const SEP = '\u0000';

const NODE_SORTS = ['auto', 'value', 'name'];
const COLOR_MODES = ['categorical', 'scale', 'threshold'];
const TRACE_MODES = ['path', 'adjacent', 'off'];
const CYCLE_MODES = ['drop', 'unroll'];
const UNIT_POSITIONS = ['after', 'before'];

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

// editor.threshold の帯を正規化。from/to が null（開いた範囲）を ±Infinity に倒す。
// 帯が壊れている場合は既定に戻す（色が付かない状態を作らない）。
function normalizeBands(raw) {
    const src = Array.isArray(raw) ? raw : DEFAULTS.colorBands;
    const out = [];
    src.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        if (!isHexColor(b.value)) return;
        const from = b.from === null || b.from === undefined ? -Infinity : parseNum(b.from);
        const to = b.to === null || b.to === undefined ? Infinity : parseNum(b.to);
        if (!Number.isFinite(from) && from !== -Infinity) return;
        if (!Number.isFinite(to) && to !== Infinity) return;
        out.push({ from, to, value: b.value.trim() });
    });
    if (out.length === 0) {
        return DEFAULTS.colorBands.map((b) => ({
            from: b.from === null ? -Infinity : b.from,
            to: b.to === null ? Infinity : b.to,
            value: b.value,
        }));
    }
    return out.sort((a, b) => a.from - b.from);
}

// 値 → 帯の色。どの帯にも入らなければ最後の帯（＝上端開放の意図）に倒す
function bandColorFor(value, bands, fallback) {
    for (const b of bands) {
        if (value >= b.from && value < b.to) return b.value;
    }
    const last = bands[bands.length - 1];
    if (last && value >= last.from) return last.value;
    return fallback;
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
    const oneOf = (key, allowed) => (allowed.includes(o[key]) ? o[key] : DEFAULTS[key]);
    const text = (key, maxLen) => {
        if (typeof o[key] !== 'string') return DEFAULTS[key];
        return o[key].slice(0, maxLen);
    };
    // editor.seriesColors は配列が生で届く。DOS 文字列が来たら既定（空＝内蔵パレット）に倒す
    const palette = Array.isArray(o.nodeColors)
        ? o.nodeColors.filter((c) => isHexColor(c)).map((c) => c.trim())
        : DEFAULTS.nodeColors;

    return {
        useGradientLinks: bool('useGradientLinks'),
        linkOpacity: num('linkOpacity', 5, 100),
        colorMode: oneOf('colorMode', COLOR_MODES),
        lowColor: color('lowColor'),
        highColor: color('highColor'),
        useMidColor: bool('useMidColor'),
        midColor: color('midColor'),
        reverse: bool('reverse'),
        colorBands: normalizeBands(o.colorBands),
        nodeColors: palette,
        nodeWidth: num('nodeWidth', 4, 60),
        nodePadding: num('nodePadding', 2, 80),
        nodeSort: oneOf('nodeSort', NODE_SORTS),
        showLabels: bool('showLabels'),
        showValues: bool('showValues'),
        labelSize: num('labelSize', 0, 32),
        valueUnit: text('valueUnit', 12),
        unitPosition: oneOf('unitPosition', UNIT_POSITIONS),
        showLinkLabels: bool('showLinkLabels'),
        showHeader: bool('showHeader'),
        highlightOnHover: bool('highlightOnHover'),
        traceMode: oneOf('traceMode', TRACE_MODES),
        topN: num('topN', 0, 200),
        otherLabel: text('otherLabel', 24) || DEFAULTS.otherLabel,
        showLoss: bool('showLoss'),
        lossColor: color('lossColor'),
        cycleMode: oneOf('cycleMode', CYCLE_MODES),
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

// 単位を付ける（オプションの valueUnit / unitPosition）
function withUnit(text, opts) {
    if (!opts.valueUnit) return text;
    return opts.unitPosition === 'before'
        ? `${opts.valueUnit}${text}`
        : `${text} ${opts.valueUnit}`;
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

// 上位 N 件に集約する。value 降順で N 件を残し、残りを otherLabel にまとめる。
// ステージモードでは「段ごとに」上位 N を決める（段をまたいで名前が混ざらないように）。
function applyTopN(links, nodeMap, staged, topN, otherLabel) {
    if (topN <= 0) return { links, rolled: 0 };

    // ノードごとの総流量（in/out の大きい方）で重要度を測る
    const weight = new Map();
    const bump = (id, v) => weight.set(id, (weight.get(id) || 0) + v);
    links.forEach((l) => {
        bump(l.source, l.value);
        bump(l.target, l.value);
    });

    // 段ごとにノードを分け、各段で上位 N を残す
    const byStage = new Map();
    nodeMap.forEach((n) => {
        const stage = staged ? n.firstStage : 0;
        if (!byStage.has(stage)) byStage.set(stage, []);
        byStage.get(stage).push(n);
    });

    const keep = new Set();
    const rolledIds = new Set();
    byStage.forEach((nodes, stage) => {
        const sorted = nodes
            .slice()
            .sort((a, b) => (weight.get(b.id) || 0) - (weight.get(a.id) || 0));
        sorted.forEach((n, i) => {
            if (i < topN) keep.add(n.id);
            else rolledIds.add(n.id);
        });
        // 段内が N 件以下なら集約しない
        if (sorted.length <= topN) {
            sorted.forEach((n) => rolledIds.delete(n.id));
        }
        void stage;
    });

    if (rolledIds.size === 0) return { links, rolled: 0 };

    // 集約ノードの ID（段ごとに1つ）
    const otherIdFor = (id) => {
        const n = nodeMap.get(id);
        const stage = staged && n ? n.firstStage : 0;
        return staged ? `${stage}${SEP}${otherLabel}` : otherLabel;
    };

    const merged = new Map();
    links.forEach((l) => {
        const s = keep.has(l.source) ? l.source : otherIdFor(l.source);
        const t = keep.has(l.target) ? l.target : otherIdFor(l.target);
        if (s === t) return; // 集約同士が自己ループになったら捨てる
        const key = s + SEP + SEP + t;
        merged.set(key, (merged.get(key) || 0) + l.value);
    });

    // 集約ノードを nodeMap に登録
    rolledIds.forEach((id) => {
        const n = nodeMap.get(id);
        if (!n) return;
        const oid = otherIdFor(id);
        if (!nodeMap.has(oid)) {
            nodeMap.set(oid, {
                id: oid,
                name: otherLabel,
                firstStage: staged ? n.firstStage : 0,
                isOther: true,
            });
        }
    });

    const out = Array.from(merged.entries()).map(([key, value]) => {
        const [source, target] = key.split(SEP + SEP);
        return { source, target, value };
    });
    return { links: out, rolled: rolledIds.size };
}

// rows からノード/リンクを組み立てる
function buildGraph(rows, opts) {
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount < 3) return { error: 'columns' };

    const valueIdx = colCount - 1;
    const stageCount = colCount - 1; // value 列より前が全部ステージ
    const staged = stageCount > 2; // 4列以上 → ステージモード

    const linkMap = new Map();
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

    let entries = Array.from(linkMap.entries())
        .map(([key, value]) => {
            const [source, target] = key.split(SEP + SEP);
            return { source, target, value };
        })
        .sort((a, b) => b.value - a.value);

    // 上位 N 件への集約（循環除去より前にやる：集約でリンク本数が減る）
    const rollup = applyTopN(entries, nodeMap, staged, opts.topN, opts.otherLabel);
    entries = rollup.links;
    const rolledNodes = rollup.rolled;

    let truncated = 0;
    if (entries.length > MAX_LINKS) {
        entries.sort((a, b) => b.value - a.value);
        truncated = entries.length - MAX_LINKS;
        entries = entries.slice(0, MAX_LINKS);
    }

    // 自由グラフモードのみ循環処理（ステージモードは構造上 DAG）
    let droppedCyclic = 0;
    let unrolled = 0;
    if (!staged) {
        const adj = new Map();
        const kept = [];
        for (const link of entries) {
            if (reaches(adj, link.target, link.source, new Set())) {
                if (opts.cycleMode === 'unroll') {
                    // 循環の戻り先を「段を増やした別ノード」として複製し、流れを残す
                    const base = nodeMap.get(link.target);
                    const dupId = `${link.target}${SEP}r`;
                    if (!nodeMap.has(dupId)) {
                        nodeMap.set(dupId, {
                            id: dupId,
                            name: base ? base.name : link.target,
                            firstStage: 2,
                            isUnrolled: true,
                        });
                    }
                    kept.push({ source: link.source, target: dupId, value: link.value });
                    unrolled += 1;
                    continue;
                }
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

    const used = new Set();
    entries.forEach((l) => {
        used.add(l.source);
        used.add(l.target);
    });
    const nodes = Array.from(nodeMap.values()).filter((n) => used.has(n.id));

    // 色は「表示名」単位で割り当て（段をまたいで同名なら同色 → 流れを追いやすい）
    const palette = opts.nodeColors.length > 0 ? opts.nodeColors : PALETTE;
    const colorByName = new Map();
    nodes
        .slice()
        .sort((a, b) => a.firstStage - b.firstStage)
        .forEach((n) => {
            if (!colorByName.has(n.name)) colorByName.set(n.name, colorByName.size);
        });
    nodes.forEach((n) => {
        n.color = palette[colorByName.get(n.name) % palette.length];
    });

    return {
        nodes,
        links: entries,
        staged,
        droppedCyclic,
        droppedInvalid,
        truncated,
        rolledNodes,
        unrolled,
    };
}

// ---------------------------------------------------------------------------
// 経路追跡（あるノードを通るフロー全体を上流〜下流までたどる）
//
// 標準 splunk.sankey には無い機能。隣接だけでなく「その先」まで光らせることで、
// 多段フローのどこから来てどこへ抜けたかが1目で分かる。
// ---------------------------------------------------------------------------

function tracePath(layout, startId) {
    const nodeIds = new Set([startId]);
    const linkSet = new Set();
    if (!layout) return { nodeIds, linkSet };

    // 下流へ
    const down = [startId];
    while (down.length) {
        const cur = down.pop();
        const node = layout.nodeById.get(cur);
        if (!node) continue;
        (node.sourceLinks || []).forEach((l) => {
            if (linkSet.has(l.index)) return;
            linkSet.add(l.index);
            if (!nodeIds.has(l.target.id)) {
                nodeIds.add(l.target.id);
                down.push(l.target.id);
            }
        });
    }
    // 上流へ
    const up = [startId];
    while (up.length) {
        const cur = up.pop();
        const node = layout.nodeById.get(cur);
        if (!node) continue;
        (node.targetLinks || []).forEach((l) => {
            if (linkSet.has(l.index)) return;
            linkSet.add(l.index);
            if (!nodeIds.has(l.source.id)) {
                nodeIds.add(l.source.id);
                up.push(l.source.id);
            }
        });
    }
    return { nodeIds, linkSet };
}

// ---------------------------------------------------------------------------
// コンテナ実寸を購読するフック
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
            labelHalo: 'rgba(13,17,23,0.85)',
        };
    }
    return {
        text: '#31373e',
        muted: '#6b7785',
        nodeStroke: 'rgba(0,0,0,0.22)',
        tooltipBg: 'rgba(255,255,255,0.97)',
        tooltipBorder: 'rgba(0,0,0,0.14)',
        headerBorder: 'rgba(0,0,0,0.08)',
        labelHalo: 'rgba(255,255,255,0.85)',
    };
}

// ---------------------------------------------------------------------------
// スピナー永久表示（サーチ完了通知の取りこぼし）対策
// ---------------------------------------------------------------------------

const RESCUE_POLL_MS = 500;

function useDataSourcesWithRescue() {
    const official = useDataSources();
    const [rescue, setRescue] = useState(null);
    const officialLoading = Boolean(official?.loading);

    useEffect(() => {
        if (!officialLoading) return undefined;
        setRescue(null);
        let timer = 0;
        const tick = () => {
            try {
                const cur = globalThis.DashboardExtensionAPI?.getDataSources?.();
                if (cur && !cur.loading) {
                    setRescue(cur);
                    return;
                }
            } catch (e) {
                /* ホスト未応答でも落とさない。次のtickで再試行 */
            }
            timer = setTimeout(tick, RESCUE_POLL_MS);
        };
        timer = setTimeout(tick, RESCUE_POLL_MS);
        return () => clearTimeout(timer);
    }, [officialLoading]);

    return officialLoading && rescue ? rescue : official;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

let uidSeq = 0;

function SankeyFlow({ mode }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
    const { options } = useOptions();
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const containerRef = useRef(null);
    const { width, height } = useContainerSize(containerRef);
    const [hover, setHover] = useState(null); // {type:'node'|'link', key} | null
    const [tooltip, setTooltip] = useState(null);
    const uid = useMemo(() => `skf${(uidSeq += 1)}`, []);
    const colors = themeColors(mode);

    const data = dataSources?.primary?.data;
    const fields = useMemo(
        () => (data?.fields || []).map((f) => (f && f.name ? f.name : f)),
        [data]
    );
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);

    const graph = useMemo(() => buildGraph(rows, opts), [rows, opts]);

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

            // 段内の並び順（標準 sankey には無い制御）
            if (opts.nodeSort === 'value') {
                gen.nodeSort((a, b) => b.value - a.value);
            } else if (opts.nodeSort === 'name') {
                gen.nodeSort((a, b) => String(a.name).localeCompare(String(b.name)));
            }

            const out = gen({
                nodes: graph.nodes.map((n) => ({ ...n })),
                links: graph.links.map((l) => ({ ...l })),
            });

            out.links.forEach((l, i) => {
                l.index = i;
            });
            const nodeById = new Map(out.nodes.map((n) => [n.id, n]));

            // 総流量 = 入力リンクを持たない「源流ノード」の値の合計
            const totalFlow = out.nodes
                .filter((n) => (n.targetLinks || []).length === 0)
                .reduce((s, n) => s + (n.value || 0), 0);

            let minL = Infinity;
            let maxL = -Infinity;
            out.links.forEach((l) => {
                if (l.value < minL) minL = l.value;
                if (l.value > maxL) maxL = l.value;
            });
            const stages = 1 + out.nodes.reduce((m, n) => Math.max(m, n.depth || 0), 0);

            // 段ごとの損失（その段に入った量 − 次の段へ出た量）。
            // 標準 sankey には無い。ファネルの離脱・パケットロスを数値で出す。
            const lossByStage = [];
            for (let d = 0; d < stages; d += 1) {
                const inStage = out.nodes.filter((n) => (n.depth || 0) === d);
                if (inStage.length === 0) continue;
                const incoming = inStage.reduce((s, n) => s + (n.value || 0), 0);
                const outgoing = inStage.reduce(
                    (s, n) => s + (n.sourceLinks || []).reduce((t, l) => t + l.value, 0),
                    0
                );
                // 最終段は出口が無いので損失としない
                const hasNext = out.nodes.some((n) => (n.depth || 0) === d + 1);
                if (!hasNext) continue;
                lossByStage.push({
                    depth: d,
                    incoming,
                    outgoing,
                    loss: Math.max(0, incoming - outgoing),
                });
            }

            return { ...out, nodeById, totalFlow, minL, maxL, stages, lossByStage };
        } catch (e) {
            return { layoutError: String(e && e.message ? e.message : e) };
        }
    }, [graph, chartW, chartH, opts.nodeWidth, opts.nodePadding, opts.nodeSort]);

    // ---- ドリルダウン（クリックでトークン設定） --------------------------
    // 発火するのは addDrilldownListener で登録した DOM ノードのクリックだけ。
    // triggerDrilldown は効かない（ナレッジ §5・実機確認済み）。
    // 登録はノード1つにつき1回にし、payload は WeakMap で毎レンダー差し替える。
    const payloadMap = useRef(new WeakMap());
    const registered = useRef(new WeakSet());

    const attachNode = useCallback((el, action, payload) => {
        if (!el) return;
        if (typeof addDrilldownListener !== 'function') return;
        payloadMap.current.set(el, payload);
        if (registered.current.has(el)) return;
        registered.current.add(el);
        try {
            addDrilldownListener({
                node: el,
                action,
                payloadCallback: () => payloadMap.current.get(el) || {},
            });
        } catch (e) {
            /* ホストが未対応でも描画は続ける */
        }
    }, []);

    // ラベルサイズ（0 = 自動: 高さに応じて 10〜13px）
    const fontSize = opts.labelSize > 0
        ? opts.labelSize
        : clamp(Math.round(chartH / 30), 10, 13);

    // ホバー状態 → 強調対象（経路追跡 or 隣接のみ）
    const traced = useMemo(() => {
        if (!layout || layout.layoutError) return null;
        if (!opts.highlightOnHover || opts.traceMode === 'off' || !hover) return null;
        if (hover.type === 'node') {
            if (opts.traceMode === 'path') return tracePath(layout, hover.key);
            const nodeIds = new Set([hover.key]);
            const linkSet = new Set();
            const node = layout.nodeById.get(hover.key);
            if (node) {
                (node.sourceLinks || []).forEach((l) => {
                    linkSet.add(l.index);
                    nodeIds.add(l.target.id);
                });
                (node.targetLinks || []).forEach((l) => {
                    linkSet.add(l.index);
                    nodeIds.add(l.source.id);
                });
            }
            return { nodeIds, linkSet };
        }
        const link = layout.links[hover.key];
        if (!link) return null;
        return {
            nodeIds: new Set([link.source.id, link.target.id]),
            linkSet: new Set([link.index]),
        };
    }, [layout, hover, opts.highlightOnHover, opts.traceMode]);

    const baseLinkOpacity = opts.linkOpacity / 100;
    const linkOpacityFor = (link) => {
        if (!traced) return baseLinkOpacity;
        return traced.linkSet.has(link.index)
            ? clamp(baseLinkOpacity * 2, 0.55, 0.95)
            : baseLinkOpacity * 0.12;
    };
    const nodeOpacityFor = (node) => {
        if (!traced) return 1;
        return traced.nodeIds.has(node.id) ? 1 : 0.25;
    };

    // リンクの色（3方式）
    const linkStrokeFor = (link) => {
        if (opts.colorMode === 'threshold') {
            return bandColorFor(link.value, opts.colorBands, opts.lowColor);
        }
        if (opts.colorMode === 'scale') {
            const span = layout.maxL - layout.minL;
            const t = span > 0 ? (link.value - layout.minL) / span : 0.5;
            return scaleColorFor(t, opts);
        }
        if (opts.useGradientLinks) return `url(#${uid}-g${link.index})`;
        return link.source.color;
    };

    // リンク値ラベルの配置を決める。
    // 太さだけで判定すると、別々のリンクのラベル同士が縦に近接して重なる
    // （実機で「90」「80」が重なる症状を確認）。x が近いラベル同士は
    // 縦の間隔が足りなければ値の大きい方を優先して出す。
    const linkLabels = useMemo(() => {
        if (!opts.showLinkLabels || !layout || layout.layoutError) return [];

        const minGapY = fontSize * 1.25;
        // 重なりを避けるために動かせる量。帯の内側に収める（帯からはみ出すと
        // どのリンクのラベルか分からなくなるため）
        const slackFor = (link) => Math.max(0, (link.width - fontSize) / 2);

        const cands = layout.links
            .map((link, i) => ({
                link,
                i,
                x: (link.source.x1 + link.target.x0) / 2,
                y: (link.y0 + link.y1) / 2,
                homeY: (link.y0 + link.y1) / 2,
            }))
            // 帯より文字がはみ出すものは出さない
            .filter((c) => c.link.width >= fontSize * 1.15)
            // 値の大きい順に置き、後から来た小さい方をずらす
            .sort((a, b) => b.link.value - a.link.value);

        const placed = [];
        const nearX = Math.max(40, fontSize * 4);
        // 水平方向の逃がし幅（縦にずらしても収まらないとき用）。
        // 帯の中央から左右へどれだけ動かせるか。
        const spanFor = (c) =>
            Math.max(0, (c.link.target.x0 - c.link.source.x1) / 2 - fontSize * 1.5);

        const collidesWith = (c, y, x) =>
            placed.find(
                (p) => Math.abs(p.x - x) < nearX && Math.abs(p.y - y) < minGapY
            );

        cands.forEach((c) => {
            // ① そのままの位置に置ける？
            if (!collidesWith(c, c.y, c.x)) {
                placed.push(c);
                return;
            }
            // ② 帯の内側で上下にずらして逃がす（±slack まで）
            const slack = slackFor(c.link);
            let done = false;
            for (let d = minGapY * 0.6; d <= slack + 0.01 && !done; d += minGapY * 0.6) {
                for (const dir of [-1, 1]) {
                    const y = c.homeY + dir * d;
                    if (!collidesWith(c, y, c.x)) {
                        c.y = y;
                        placed.push(c);
                        done = true;
                        break;
                    }
                }
            }
            if (done) return;
            // ③ 縦で逃げ切れないので水平方向にずらす（帯に沿って左右へ）
            const span = spanFor(c);
            for (let dx = nearX * 0.5; dx <= span + 0.01 && !done; dx += nearX * 0.5) {
                for (const dir of [-1, 1]) {
                    const x = c.x + dir * dx;
                    if (!collidesWith(c, c.homeY, x)) {
                        c.x = x;
                        c.y = c.homeY;
                        placed.push(c);
                        done = true;
                        break;
                    }
                }
            }
            if (done) return;
            // ④ どうしても逃げ場が無い場合だけ、引き出し線を付けて帯の外に出す。
            //    「値が消える」ことは避ける（消すと欠損なのか間引きなのか区別できない）。
            const slackOut = Math.max(slack, minGapY);
            for (let d = slackOut; d <= slackOut + minGapY * 6; d += minGapY * 0.8) {
                for (const dir of [-1, 1]) {
                    const y = c.homeY + dir * d;
                    if (!collidesWith(c, y, c.x)) {
                        c.y = y;
                        c.leader = { x: c.x, y1: c.homeY, y2: y };
                        placed.push(c);
                        done = true;
                        break;
                    }
                }
            }
            // それでも空きが無ければ最後の手段としてそのまま重ねて出す（消さない）
            if (!done) placed.push(c);
        });
        return placed;
    }, [layout, opts.showLinkLabels, fontSize]);

    const showTooltip = (evt, lines) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = evt.clientX - rect.left + 12;
        const y = clamp(evt.clientY - rect.top + 12, 0, Math.max(0, height - 88));
        if (x > width - 190) x = Math.max(0, evt.clientX - rect.left - 202);
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
        return centerBox(<Paragraph>データがありません。サーチ結果を確認してください。</Paragraph>);
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
    if (graph.droppedCyclic > 0) notices.push(`循環 ${graph.droppedCyclic}`);
    if (graph.truncated > 0) notices.push(`下位 ${graph.truncated}`);

    const totalLoss = layout && !layout.layoutError
        ? (layout.lossByStage || []).reduce((s, x) => s + x.loss, 0)
        : 0;

    // ---- 描画 ------------------------------------------------------------

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
            onMouseLeave={clearHover}
            data-viz-version={VIZ_VERSION}
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
                        <strong style={{ color: colors.text }}>
                            {withUnit(fmtFull(layout.totalFlow), opts)}
                        </strong>
                    </span>
                    <span>{layout.stages} stages</span>
                    <span>{layout.nodes.length} nodes</span>
                    <span>{layout.links.length} links</span>
                    {opts.showLoss && totalLoss > 0 && (
                        <span style={{ color: opts.lossColor }}>
                            損失 {withUnit(fmtCompact(totalLoss), opts)}
                            {layout.totalFlow > 0
                                ? ` (${((totalLoss / layout.totalFlow) * 100).toFixed(1)}%)`
                                : ''}
                        </span>
                    )}
                    {graph.rolledNodes > 0 && <span>集約 {graph.rolledNodes}</span>}
                    {graph.unrolled > 0 && <span>循環展開 {graph.unrolled}</span>}
                    {notices.length > 0 && <span>(除外: {notices.join(', ')})</span>}
                    {opts.colorMode === 'scale' && (
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
                    {opts.colorMode === 'threshold' && (
                        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                            {opts.colorBands.map((b, i) => (
                                <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span
                                        style={{
                                            width: 10, height: 10, borderRadius: 2,
                                            background: b.value, display: 'inline-block',
                                        }}
                                    />
                                    <span>
                                        {b.from === -Infinity ? '' : fmtCompact(b.from)}
                                        {'–'}
                                        {b.to === Infinity ? '' : fmtCompact(b.to)}
                                    </span>
                                </span>
                            ))}
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
                    {opts.colorMode === 'categorical' && opts.useGradientLinks && (
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

                    {/* 段ごとの損失（次の段へ届かなかった量を細い帯で示す） */}
                    {opts.showLoss && (
                        <g>
                            {layout.nodes.map((node) => {
                                const outSum = (node.sourceLinks || []).reduce((s, l) => s + l.value, 0);
                                const loss = (node.value || 0) - outSum;
                                if (loss <= 0 || (node.sourceLinks || []).length === 0) return null;
                                const h = (node.y1 - node.y0) * (loss / (node.value || 1));
                                if (!Number.isFinite(h) || h < 0.5) return null;
                                // 損失は「ノードの右肩から下に垂れる帯」として描く。
                                // リンクの上に重ねるため、ハッチング風の縁取りを付けて埋もれないようにする。
                                const w = Math.max(6, opts.nodeWidth * 0.9);
                                return (
                                    <g key={`loss${node.id}`} style={{ pointerEvents: 'none' }}>
                                        <rect
                                            x={node.x1}
                                            y={node.y1 - h}
                                            width={w}
                                            height={h}
                                            fill={opts.lossColor}
                                            opacity={nodeOpacityFor(node) * 0.95}
                                        />
                                        <rect
                                            x={node.x1}
                                            y={node.y1 - h}
                                            width={w}
                                            height={h}
                                            fill="none"
                                            stroke={colors.labelHalo}
                                            strokeWidth={1}
                                            opacity={nodeOpacityFor(node) * 0.6}
                                        />
                                    </g>
                                );
                            })}
                        </g>
                    )}

                    {/* リンク */}
                    <g fill="none">
                        {layout.links.map((link, i) => {
                            const pct = layout.totalFlow > 0
                                ? ((link.value / layout.totalFlow) * 100).toFixed(1)
                                : null;
                            const payload = {
                                'row.source.value': link.source.name,
                                'row.target.value': link.target.name,
                                'row.value.value': link.value,
                                name: 'link',
                                value: `${link.source.name} → ${link.target.name}`,
                            };
                            if (fields.length >= 3) {
                                payload[`row.${fields[0]}.value`] = link.source.name;
                                payload[`row.${fields[fields.length - 2]}.value`] = link.target.name;
                                payload[`row.${fields[fields.length - 1]}.value`] = link.value;
                            }
                            return (
                                <path
                                    key={`l${i}`}
                                    ref={(el) => attachNode(el, 'link.click', payload)}
                                    d={sankeyLinkHorizontal()(link)}
                                    stroke={linkStrokeFor(link)}
                                    strokeWidth={Math.max(1, link.width)}
                                    strokeOpacity={linkOpacityFor(link)}
                                    style={{ transition: 'stroke-opacity 120ms', cursor: 'pointer' }}
                                    onMouseEnter={() => setHover({ type: 'link', key: i })}
                                    onMouseMove={(evt) => showTooltip(evt, [
                                        `${link.source.name} → ${link.target.name}`,
                                        `${withUnit(fmtFull(link.value), opts)}${pct !== null ? ` (全体の ${pct}%)` : ''}`,
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
                            const outSum = (node.sourceLinks || []).reduce((s, l) => s + l.value, 0);
                            const loss = (node.sourceLinks || []).length > 0
                                ? Math.max(0, (node.value || 0) - outSum)
                                : 0;
                            const payload = {
                                'row.node.value': node.name,
                                'row.value.value': node.value,
                                name: 'node',
                                value: node.name,
                            };
                            if (fields.length >= 1) {
                                payload[`row.${fields[0]}.value`] = node.name;
                            }
                            const lines = [
                                node.name,
                                `${withUnit(fmtFull(node.value), opts)}${pct !== null ? ` (全体の ${pct}%)` : ''}`,
                                `${(node.targetLinks || []).length} in / ${(node.sourceLinks || []).length} out`,
                            ];
                            if (opts.showLoss && loss > 0) {
                                lines.push(`損失 ${withUnit(fmtCompact(loss), opts)} (${((loss / (node.value || 1)) * 100).toFixed(1)}%)`);
                            }
                            return (
                                <rect
                                    key={node.id}
                                    ref={(el) => attachNode(el, 'node.click', payload)}
                                    x={node.x0}
                                    y={node.y0}
                                    width={Math.max(1, node.x1 - node.x0)}
                                    height={h}
                                    rx={2}
                                    fill={node.color}
                                    stroke={colors.nodeStroke}
                                    strokeWidth={0.5}
                                    opacity={nodeOpacityFor(node)}
                                    style={{ transition: 'opacity 120ms', cursor: 'pointer' }}
                                    onMouseEnter={() => setHover({ type: 'node', key: node.id })}
                                    onMouseMove={(evt) => showTooltip(evt, lines)}
                                    onMouseLeave={clearHover}
                                />
                            );
                        })}
                    </g>

                    {/* リンク上の値ラベル（太いリンクにだけ出す） */}
                    {opts.showLinkLabels && (
                        <g style={{ pointerEvents: 'none' }}>
                            {linkLabels.map(({ link, i, x, y, leader }) => {
                                const op = linkOpacityFor(link) > baseLinkOpacity * 0.5 ? 0.95 : 0.2;
                                return (
                                    <g key={`ll${i}`}>
                                        {/* 帯の外へ逃がしたラベルは、どのリンクの値かを引き出し線で示す */}
                                        {leader && (
                                            <line
                                                x1={leader.x}
                                                y1={leader.y1}
                                                x2={leader.x}
                                                y2={leader.y2}
                                                stroke={colors.text}
                                                strokeWidth={0.75}
                                                opacity={op * 0.5}
                                            />
                                        )}
                                        <text
                                            x={x}
                                            y={y}
                                            dy="0.35em"
                                            textAnchor="middle"
                                            fontSize={fontSize - 1}
                                            fill={colors.text}
                                            opacity={op}
                                            stroke={colors.labelHalo}
                                            strokeWidth={2.5}
                                            paintOrder="stroke"
                                        >
                                            {withUnit(fmtCompact(link.value), opts)}
                                        </text>
                                    </g>
                                );
                            })}
                        </g>
                    )}

                    {/* ノードラベル（左半分は右側に、右半分は左側に） */}
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
                                                {` ${withUnit(fmtCompact(node.value), opts)}`}
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
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（マウントゲート必須）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light';
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <SankeyFlow mode={mode} />
        </SplunkThemeProvider>
    );
}

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

// DPX（apps/dash-platform）が iframe なしでこの viz をホストする場合の受け渡し口。
// `export` を使わないのは、esbuild が成果物末尾に export{} を出力して
// Studio の iframe が SyntaxError になるため（実機で確認済み）。
// DPX 側は host.jsx がこのファイルを副作用 import してから受け取る。
globalThis.__SANKEY_FLOW_APP__ = App;

// DPX にホストされている場合は自己マウントしない（ホストがコンポーネントとして描画する）。
// iframe（Studio 拡張）では従来どおり自己マウントする。
if (!globalThis.__DASH_PLATFORM_HOST__) {
    (function mountWhenReady() {
        if (hostReady() || Date.now() - MOUNT_START >= 5000) {
            mountApp();
        } else {
            setTimeout(mountWhenReady, 50);
        }
    })();
}
