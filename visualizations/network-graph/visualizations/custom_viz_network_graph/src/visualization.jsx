import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン（編集画面の「インタラクション」）は /react にフックが無いので、
// コアの /visualization から関数を直接 import する（severity-table / link-line と同じ）。
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// フォースダイレクテッド・ネットワークグラフ
//
// データモデル:
//   [source, target, value?] … 第1列=接続元, 第2列=接続先, 第3列=数値(省略時は1)。
//   同じ (source, target) ペアは合算。自己ループ・不正値・空名は除去して件数を表示。
//   ノード数はオプション maxNodes で上位(合計流量順)に制限（silent cap にしない）。
//
// 特徴（デフォルト viz では不可能な領域）:
//   - 自前の物理シミュレーション（反発・スプリング・中心重力・衝突回避）を
//     requestAnimationFrame ループで実行し、SVG 属性を直接更新（React の再レンダリング無し）
//   - エッジ線そのものが「流れる破線」として src→dest 方向へ動く（点は動かさない）。
//     dashoffset を進めるだけなので軽量で、線が生きているように見える
//   - 矢印は線幅に連動する実三角で、頂点がノード縁にぴったり刺さる
//   - ノードのドラッグ / ホイールズーム / 背景ドラッグでパン / ダブルクリックでリセット
//   - ホバーで隣接ノード・エッジをハイライト、ツールチップに in/out 統計
//
// 位置(transform / d / dashoffset)は rAF ループが命令的に書く。React(JSX) は構造と
// 色・太さ・不透明度のみを宣言的に持つ。両者が同じ属性を触らないことが規約。
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    // 列指定（空 = 従来どおり 0/1/2 列目を使う）
    sourceField: '',
    targetField: '',
    valueField: '',
    enableDrilldown: true, // ノードのクリックでインタラクションを発火
    labelMaxChars: 14, // ラベルの最大文字数（超える分は … で省略）
    maxNodes: 60, // 表示ノード数上限（流量上位を残す）
    nodeScale: 100, // ノード半径スケール（%）
    spacing: 95, // ノード間隔（%）。反発・リンク距離・衝突半径を一括スケール（大きいほど広がる）
    linkDistance: 90, // スプリング自然長 px（面積由来の自動値との大きい方を使う）
    repulsion: 45, // ノード間反発の強さ（%）。散らばりすぎないよう既定を下げた（v1.2.1→v1.2.2 で更に）
    autoFit: true, // グラフ全体が画面に収まるようカメラを自動調整（ズーム/パンで解除）
    curved: true, // エッジを曲線にする
    showArrows: true, // 向きの矢印
    edgeOpacity: 55, // エッジ不透明度（%）
    edgeScale: 100, // エッジ太さスケール（%）
    showFlow: true, // 流れる破線でフロー方向を表現（点は動かさない）
    flowSpeed: 100, // フロー速度（%）
    flowDash: 60, // 破線の密度（%。小さいほど短い破片が細かく流れる）
    glow: true, // ダークテーマ時のグロー
    showLabels: true,
    labelSize: 11,
    showValues: false, // ラベルに流量を併記
    showHeader: true,
    highlightOnHover: true,
    useValueColors: false, // ノード/エッジを値ベースのカラースケールで着色
    lowColor: '#3fb950',
    midColor: '#f5c518',
    highColor: '#ef4d4d',
    useMidColor: true,
    reverse: false,
};

// ノードのパレット（editor.seriesColors）。config.json の seriesColors.default と一致させる。
// ユーザーが色数を増減できるため、消費側は必ず `% length` で循環参照する。
const DEFAULT_PALETTE = [
    '#7B56DB', // 紫
    '#009CEB', // 青
    '#00CDAF', // ティール
    '#DD9900', // オレンジ
    '#FF677B', // ピンク
    '#CB2196', // マゼンタ
];

const MAX_LINKS = 800; // レイアウト破綻を防ぐ上限（値の大きい順に残す）
const MIN_RADIUS = 6; // ノード最小半径 px

// Barnes-Hut（反発の近似計算）のパラメータ
//   THETA … セル幅 / 距離 がこの値より小さければ「遠い」とみなして重心1点で代用する。
//           0 に近いほど厳密（=遅い）、大きいほど粗い。0.9 は一般的な既定値。
//   MIN_NODES … これ以下のノード数では木を作るコストの方が高いので総当たりにする。
const BARNES_HUT_THETA = 0.9;
const BARNES_HUT_MIN_NODES = 24;

// ドリルダウンで発火するイベント名。config.json の `events` に宣言した名前と一致させる。
// ホストは宣言済みの名前しか認識しないので、両方を同時に直すこと。
const NODE_CLICK_ACTION = 'node.click';

// ---------------------------------------------------------------------------
// Barnes-Hut 四分木（反発力を O(n^2) → O(n log n) にする）
//
// ノードを含む正方領域を再帰的に4分割し、各セルに「質量（=ノード数）」と「重心」を持たせる。
// 力を求めるときは、十分遠いセルは中身を展開せず重心1点として扱う。
// ※ここでの質量はすべて 1（ノードの値で重み付けはしない）。値で重み付けすると
//   流量の大きいノードだけが極端に他を押しのけ、レイアウトが読みにくくなるため。
// ---------------------------------------------------------------------------
function buildQuadTree(nodes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
        const p = nodes[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return null;
    // 正方形にそろえる（セル幅の判定を単純にするため）
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.01;
    const root = { x: minX, y: minY, size, mass: 0, cx: 0, cy: 0, body: null, kids: null };

    const insert = (cell, p, depth) => {
        // 深すぎる分割は打ち切る（同一座標のノードが複数あると無限に割れてしまう）
        if (depth > 20) {
            cell.mass += 1;
            cell.cx += p.x;
            cell.cy += p.y;
            return;
        }
        if (cell.mass === 0 && !cell.kids) {
            cell.mass = 1;
            cell.cx = p.x;
            cell.cy = p.y;
            cell.body = p;
            return;
        }
        if (!cell.kids) {
            // 既に1点入っている葉 → 4分割して既存点を押し下げる
            const existing = cell.body;
            cell.kids = [null, null, null, null];
            cell.body = null;
            if (existing) pushDown(cell, existing, depth);
        }
        cell.mass += 1;
        cell.cx += p.x;
        cell.cy += p.y;
        pushDown(cell, p, depth);
    };

    const pushDown = (cell, p, depth) => {
        const half = cell.size / 2;
        const qx = p.x >= cell.x + half ? 1 : 0;
        const qy = p.y >= cell.y + half ? 1 : 0;
        const idx = qy * 2 + qx;
        if (!cell.kids[idx]) {
            cell.kids[idx] = {
                x: cell.x + qx * half,
                y: cell.y + qy * half,
                size: half,
                mass: 0,
                cx: 0,
                cy: 0,
                body: null,
                kids: null,
            };
        }
        insert(cell.kids[idx], p, depth + 1);
    };

    for (let i = 0; i < nodes.length; i += 1) {
        const p = nodes[i];
        if (root.mass === 0 && !root.kids) {
            root.mass = 1;
            root.cx = p.x;
            root.cy = p.y;
            root.body = p;
        } else {
            insert(root, p, 0);
        }
    }
    return root;
}

// 四分木をたどってノード a に働く反発力を加える（strength = charge * alpha）
function applyRepulsion(cell, a, strength) {
    if (!cell || cell.mass === 0) return;
    // 葉（実体1つ）は自分自身をスキップ
    if (cell.body) {
        if (cell.body === a) return;
        accumulate(a, cell.body.x, cell.body.y, 1, strength);
        return;
    }
    const comX = cell.cx / cell.mass;
    const comY = cell.cy / cell.mass;
    const dx = comX - a.x;
    const dy = comY - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
    if (cell.size / d < BARNES_HUT_THETA) {
        // 十分遠い → このセルはまとめて1点として扱う
        accumulate(a, comX, comY, cell.mass, strength);
        return;
    }
    if (cell.kids) {
        for (let i = 0; i < 4; i += 1) applyRepulsion(cell.kids[i], a, strength);
    }
}

function accumulate(a, bx, by, mass, strength) {
    let dx = bx - a.x;
    let dy = by - a.y;
    let d2 = dx * dx + dy * dy;
    if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 0.5; }
    const d = Math.sqrt(d2);
    // 総当たり版と同じ上限（1ノードあたり 60）を質量ぶんに拡張する
    const f = Math.min((strength * mass) / d2, 60 * mass);
    a.vx -= (dx / d) * f;
    a.vy -= (dy / d) * f;
}

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
        // 列指定（columnSelector の DOS 文字列 / 生名 / 配列のいずれでも来うる）
        sourceField: o.sourceField ?? DEFAULTS.sourceField,
        targetField: o.targetField ?? DEFAULTS.targetField,
        valueField: o.valueField ?? DEFAULTS.valueField,
        enableDrilldown: bool('enableDrilldown'),
        labelMaxChars: num('labelMaxChars', 4, 40),
        // Barnes-Hut 化で計算量が下がったため上限を 300 → 400 に引き上げ
        maxNodes: num('maxNodes', 2, 400),
        nodeScale: num('nodeScale', 20, 300),
        spacing: num('spacing', 50, 300),
        linkDistance: num('linkDistance', 20, 400),
        repulsion: num('repulsion', 10, 400),
        autoFit: bool('autoFit'),
        curved: bool('curved'),
        showArrows: bool('showArrows'),
        edgeOpacity: num('edgeOpacity', 5, 100),
        edgeScale: num('edgeScale', 10, 400),
        showFlow: bool('showFlow'),
        flowSpeed: num('flowSpeed', 10, 500),
        flowDash: num('flowDash', 20, 200),
        glow: bool('glow'),
        showLabels: bool('showLabels'),
        labelSize: num('labelSize', 6, 24),
        showValues: bool('showValues'),
        showHeader: bool('showHeader'),
        highlightOnHover: bool('highlightOnHover'),
        useValueColors: bool('useValueColors'),
        lowColor: color('lowColor'),
        midColor: color('midColor'),
        highColor: color('highColor'),
        useMidColor: bool('useMidColor'),
        reverse: bool('reverse'),
        // editor.seriesColors は hex 文字列の配列を生で渡してくる。要素数はユーザーが
        // 増減できるので、不正要素を落としたうえで空なら既定パレットへ倒す。
        // 旧 color1..color6 へのフォールバックは意図的に行わない（既定値は options に
        // 載らないため、読み替えると「既定値を選んだときだけ直らない」不具合になる）。
        palette: paletteOf(o.seriesColors),
    };
}

function paletteOf(raw) {
    const list = Array.isArray(raw) ? raw.filter(isHexColor).map((c) => c.trim()) : [];
    return list.length > 0 ? list : DEFAULT_PALETTE.slice();
}

// ---------------------------------------------------------------------------
// 値→色カラースケール（editor.dynamicColor の代替。knowledge §4 の定番パターン）
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    let h = String(hex).replace('#', '');
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
// グラフ構築（行 → ノード/リンク。ガードと集約はここで完結させる）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// フィールド解決（editor.columnSelector は DOS 文字列で届くのでパースする）
//   例: "> primary | seriesByName('src')" / "> primary | seriesByIndex(2)"
//   生のフィールド名やホスト解決済みの配列で届く場合にも耐える。
//   未指定・解決不能なら fallbackIdx（従来の位置固定）に倒す。
//   参照実装: severity-table / chord-flow の resolveFieldIndex()
// ---------------------------------------------------------------------------
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    if (Array.isArray(spec)) {
        // ホストが解決済みの列（値の配列）を渡してきた場合：中身の一致で列を特定する
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) { ok = false; break; }
            }
            if (ok) return i;
        }
        return fallbackIdx;
    }
    if (typeof spec !== 'string') return fallbackIdx;
    const s = spec.trim();
    if (s === '') return fallbackIdx;
    let name = s;
    if (s.startsWith('>')) {
        const byName = s.match(/seriesByName\(\s*['"]([^'"]+)['"]\s*\)/);
        const byIndex = s.match(/seriesByIndex\(\s*(\d+)\s*\)/);
        if (byName) {
            name = byName[1];
        } else if (byIndex) {
            const idx = Number(byIndex[1]);
            return idx >= 0 && idx < fieldNames.length ? idx : fallbackIdx;
        } else {
            return fallbackIdx;
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// ラベルを最大文字数で切り詰める（CJK も1文字として数える素朴な方式）
function truncateLabel(text, maxChars) {
    const s = String(text ?? '');
    if (!Number.isFinite(maxChars) || maxChars <= 0 || s.length <= maxChars) return s;
    return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

function buildGraph(rows, colCount, maxNodes, idx) {
    const stats = { invalid: 0, selfLoops: 0, cappedNodes: 0, droppedLinks: 0 };
    const pairKey = (s, t) => `${s}\u0000${t}`;
    const pairs = new Map();

    rows.forEach((row) => {
        if (!Array.isArray(row)) { stats.invalid += 1; return; }
        const src = String(row[idx.src] ?? '').trim();
        const tgt = String(row[idx.tgt] ?? '').trim();
        let v = 1;
        // 値の列が解決できていれば使う。無ければ「1件=1」として本数で数える。
        if (idx.val >= 0 && idx.val < colCount) {
            v = parseNum(row[idx.val]);
            if (!Number.isFinite(v) || v <= 0) { stats.invalid += 1; return; }
        }
        if (!src || !tgt) { stats.invalid += 1; return; }
        if (src === tgt) { stats.selfLoops += 1; return; }
        pairs.set(pairKey(src, tgt), (pairs.get(pairKey(src, tgt)) || 0) + v);
    });

    // ノード集計（in/out 流量）
    const nodeMap = new Map();
    const touch = (name) => {
        if (!nodeMap.has(name)) nodeMap.set(name, { id: name, name, inV: 0, outV: 0, value: 0 });
        return nodeMap.get(name);
    };
    pairs.forEach((v, key) => {
        const [s, t] = key.split('\u0000');
        touch(s).outV += v;
        touch(t).inV += v;
    });
    nodeMap.forEach((n) => { n.value = n.inV + n.outV; });

    // ノード上限（流量上位を残す。silent cap にせず件数を返す）
    let nodes = [...nodeMap.values()].sort((a, b) => b.value - a.value);
    if (nodes.length > maxNodes) {
        stats.cappedNodes = nodes.length - maxNodes;
        nodes = nodes.slice(0, maxNodes);
    }
    const kept = new Set(nodes.map((n) => n.id));
    nodes.forEach((n, i) => { n.rank = i; });

    // リンク（残ったノード間のみ。上限は値の大きい順）
    let links = [];
    pairs.forEach((v, key) => {
        const [s, t] = key.split('\u0000');
        if (kept.has(s) && kept.has(t)) links.push({ sId: s, tId: t, value: v });
        else stats.droppedLinks += 1;
    });
    links.sort((a, b) => b.value - a.value);
    if (links.length > MAX_LINKS) {
        stats.droppedLinks += links.length - MAX_LINKS;
        links = links.slice(0, MAX_LINKS);
    }

    // リンクを持たない孤立ノードは除去（cap でリンクが消えた場合に発生し得る）
    const linked = new Set();
    links.forEach((l) => { linked.add(l.sId); linked.add(l.tId); });
    nodes = nodes.filter((n) => linked.has(n.id));

    const linkVals = links.map((l) => l.value);
    const nodeVals = nodes.map((n) => n.value);
    return {
        nodes,
        links,
        stats,
        totalFlow: linkVals.reduce((a, b) => a + b, 0),
        minL: linkVals.length ? Math.min(...linkVals) : 0,
        maxL: linkVals.length ? Math.max(...linkVals) : 0,
        minN: nodeVals.length ? Math.min(...nodeVals) : 0,
        maxN: nodeVals.length ? Math.max(...nodeVals) : 0,
    };
}

// 文字列 → 32bit シード（決定的レイアウトのため Math.random は初期配置に使わない）
function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const nowMs = () => (
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
);

// ラベルの推定表示幅（SVG に measureText は無いので文字種から近似）。
// CJK ≈ 1.0×fontSize、その他 ≈ 0.6×fontSize（knowledge §ラベル見切れ防止）。
function estimateLabelWidth(text, fontSize) {
    let w = 0;
    for (let i = 0; i < text.length; i += 1) {
        const cp = text.codePointAt(i);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.6;
    }
    return w;
}

// ---------------------------------------------------------------------------
// ベジェ幾何（エッジ・矢印・パーティクルが同じ曲線を共有する）
// ---------------------------------------------------------------------------

function edgeGeometry(link, curved) {
    const s = link.source;
    const t = link.target;
    let dx = t.x - s.x;
    let dy = t.y - s.y;
    const len = Math.max(Math.hypot(dx, dy), 0.01);
    const ux = dx / len;
    const uy = dy / len;
    // ノード縁までトリム（重なっている場合は潰れないよう比率でクランプ）
    const trimS = Math.min(s.r + 2, len * 0.4);
    const trimT = Math.min(t.r + 2, len * 0.4);
    const x0 = s.x + ux * trimS;
    const y0 = s.y + uy * trimS;
    const x1 = t.x - ux * trimT;
    const y1 = t.y - uy * trimT;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    // 曲率：曲線 ON なら片側に緩く膨らませる。双方向エッジは膨らみを強めて確実に分離。
    // 曲線 OFF でも双方向のときだけは小さくオフセットして 2 本の重なりを防ぐ。
    let ratio = 0;
    if (curved) ratio = link.biDir ? 0.24 : 0.14;
    else if (link.biDir) ratio = 0.12;
    // 垂線 (-uy,ux) は走査方向 (s→t) で自動的に反転する。A→B と B→A は u が逆向きなので
    // 垂線も逆になり、そのまま物理的に反対側へ膨らむ（curveSign で追加反転すると逆に一致して
    // しまい重なるので掛けない）。片方向エッジは常に進行方向左へ緩く曲がる。
    const off = len * ratio;
    const cx = mx + -uy * off;
    const cy = my + ux * off;
    // トリム後の弦の長さ（破線のダッシュ計算・矢印スケールに使う。負にはならない）
    const span = Math.max(Math.hypot(x1 - x0, y1 - y0), 0.01);
    return {
        x0, y0, x1, y1, cx, cy, len, span,
        rT: trimT,
    };
}

function bezPoint(g, t) {
    const u = 1 - t;
    return {
        x: u * u * g.x0 + 2 * u * t * g.cx + t * t * g.x1,
        y: u * u * g.y0 + 2 * u * t * g.cy + t * t * g.y1,
    };
}

function bezTangent(g, t) {
    const u = 1 - t;
    return {
        x: 2 * u * (g.cx - g.x0) + 2 * t * (g.x1 - g.cx),
        y: 2 * u * (g.cy - g.y0) + 2 * t * (g.y1 - g.cy),
    };
}

// ---------------------------------------------------------------------------
// メイン viz
// ---------------------------------------------------------------------------

function NetworkGraph({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const opts = useMemo(() => normalizeOptions(options), [options]);

    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const worldRef = useRef(null);
    const tooltipRef = useRef(null);

    const nodeEls = useRef(new Map()); // id -> <g>
    const labelEls = useRef(new Map()); // id -> <text>
    const linkEls = useRef(new Map()); // idx -> <path>（土台エッジ）
    const flowEls = useRef(new Map()); // idx -> <path>（流れる破線オーバーレイ）
    const arrowEls = useRef(new Map()); // idx -> <polygon>

    const simRef = useRef(null); // { nodes, links, byId, adjacency }
    const alphaRef = useRef(0);
    const needsDrawRef = useRef(true);
    const viewRef = useRef({ k: 1, tx: 0, ty: 0 });
    const autoFitRef = useRef(true); // ユーザーがズーム/パンしたら false（dblclick で復帰）
    const draggingRef = useRef(false); // ノードをドラッグ中（この間は力を弱めて操作しやすくする）
    const svgSizeRef = useRef({ w: 800, h: 460 }); // ヘッダー分を引いた svg 実寸
    const hoverRef = useRef({ id: null, dirty: false });
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const flowPhaseRef = useRef(0); // 破線の共通位相（rAF で進める）
    const edgeWidthRef = useRef(() => 2); // 各エッジの見た目の太さ（render 側で毎回更新）

    const [size, setSize] = useState({ w: 0, h: 0 });
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const [tooltip, setTooltip] = useState(null); // { lines } 位置は命令的に更新

    const uid = useMemo(() => `ng${hashStr(String(nowMs())).toString(36)}`, []);

    const colors = mode === 'dark'
        ? {
            text: '#e8ecf1',
            muted: '#9aa4b2',
            nodeStroke: 'rgba(255,255,255,0.4)',
            edgeBase: '#5c6773',
            tooltipBg: 'rgba(24,28,34,0.95)',
            tooltipBorder: 'rgba(255,255,255,0.15)',
        }
        : {
            text: '#31373e',
            muted: '#6b7785',
            nodeStroke: 'rgba(0,0,0,0.35)',
            edgeBase: '#8fa0b0',
            tooltipBg: 'rgba(255,255,255,0.97)',
            tooltipBorder: 'rgba(0,0,0,0.15)',
        };

    // ---- コンテナ実寸へのオートフィット（ResizeObserver + 初回計測フォールバック）
    // ガード表示 → 本表示のマウント切替に耐えるよう callback ref で接続する
    // （useEffect([]) だとガード時にマウントした要素を掴んだままになる）
    const roRef = useRef(null);
    const setContainer = (el) => {
        containerRef.current = el;
        if (roRef.current) {
            roRef.current.disconnect();
            roRef.current = null;
        }
        if (!el) return;
        const measure = () => {
            const w = el.clientWidth || 800;
            const h = el.clientHeight || 500;
            setSize((prev) => {
                if (Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) return prev;
                alphaRef.current = Math.max(alphaRef.current, 0.2); // 中心が移動するので再加熱
                return { w, h };
            });
        };
        measure();
        if (typeof ResizeObserver !== 'undefined') {
            roRef.current = new ResizeObserver(measure);
            roRef.current.observe(el);
        }
    };

    // ---- データ → グラフ
    const primary = dataSources?.primary;
    const data = primary?.data;
    const rows = useMemo(() => normalizeData(data || {}), [data]);
    const fieldCount = useMemo(() => {
        const fields = data?.fields || [];
        if (fields.length > 0) return fields.length;
        return rows.length > 0 && Array.isArray(rows[0]) ? rows[0].length : 0;
    }, [data, rows]);

    // 列の解決。未指定なら従来どおり 0/1/2 列目（後方互換）。
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && typeof f === 'object' ? f.name : f)),
        [data]
    );
    // 各列の「数値らしさ」（0..1）。先頭20行のうち数値として読めた割合。
    // ★二値の判定にしない。実データは欠損や不正値が混ざるので、しきい値を切ると
    //   少し汚れただけで判定が反転する（実機・テストの両方で踏んだ）。
    //   割合として持っておき、「相対的に最も数値らしい列」を値列に選ぶ。
    const numericScore = useMemo(() => {
        const sample = rows.slice(0, 20);
        const out = [];
        for (let i = 0; i < fieldCount; i += 1) {
            let num = 0;
            let seen = 0;
            sample.forEach((r) => {
                const cell = Array.isArray(r) ? r[i] : undefined;
                if (cell === null || cell === undefined || String(cell).trim() === '') return;
                seen += 1;
                if (Number.isFinite(parseNum(cell))) num += 1;
            });
            out.push(seen > 0 ? num / seen : 0);
        }
        return out;
    }, [rows, fieldCount]);

    const colIdx = useMemo(() => {
        // ★送信元/宛先の既定は「0/1列目」ではなく「最初の2つの非数値列」。
        //   実機で bytes,src,dst の並びを食わせたところ、数値列(bytes)を送信元として
        //   扱ってノード名が「300」「930」になってしまった（v1.2.0 で修正）。
        //   非数値列が2つ未満のときだけ従来の 0/1 に倒す。
        // 数値らしさが低い順（＝名前らしい順）に2列を選ぶ。同点なら左の列を優先する
        // ので、素直な src,dst,value の並びは従来どおり 0/1 列目になる。
        const order = Array.from({ length: fieldCount }, (_, i) => i)
            .sort((a, b) => (numericScore[a] - numericScore[b]) || (a - b));
        const defSrc = order.length >= 2 ? order[0] : 0;
        const defTgt = order.length >= 2 ? order[1] : 1;
        const src = resolveFieldIndex(opts.sourceField, fieldNames, rows, defSrc);
        const tgt = resolveFieldIndex(opts.targetField, fieldNames, rows, defTgt);
        // 値列。明示指定があればそれを優先し、無ければ「送信元/宛先以外の最初の数値列」を探す。
        // ★単純に「3列目」に固定してはいけない。列を入れ替えた指定（例 bytes,from,to で
        //   送信元=from・宛先=to）のとき、残りは 0 列目なのに 2 列目（＝宛先と同じ文字列列）を
        //   値として読んでしまい、全行が「非数値」で捨てられてグラフが空になる。
        let val = -1;
        if (opts.valueField) {
            val = resolveFieldIndex(opts.valueField, fieldNames, rows, -1);
        } else {
            // 値列は「送信元/宛先以外の最初の数値列」。位置（3列目）に固定しない。
            for (let i = 0; i < fieldCount; i += 1) {
                if (i === src || i === tgt) continue;
                // 残りのうち最も数値らしい列を値列にする（0.5 未満なら値なしとみなす）
                if (numericScore[i] >= 0.5 && (val < 0 || numericScore[i] > numericScore[val])) val = i;
            }
        }
        return { src, tgt, val };
    }, [opts.sourceField, opts.targetField, opts.valueField, fieldNames, rows, fieldCount, numericScore]);

    const graph = useMemo(
        () => buildGraph(rows, fieldCount, opts.maxNodes, colIdx),
        [rows, fieldCount, opts.maxNodes, colIdx]
    );

    // 本表示がマウントされているか（ガード → 本表示への切替でリスナーを張り直す）
    const hasViz = !!data && rows.length > 0 && fieldCount >= 2 && graph.links.length > 0;

    // ---- 色の解決（宣言的レンダリングとパーティクル生成が共有する）
    const nodeColorOf = (n) => {
        if (opts.useValueColors) {
            const span = graph.maxN - graph.minN;
            return scaleColorFor(span > 0 ? (n.value - graph.minN) / span : 0.5, opts);
        }
        return opts.palette[n.rank % opts.palette.length];
    };
    const linkColors = useMemo(() => {
        // ★v1.2.0：以前は links.map の中で nodes.find() を呼んでおり O(ノード数×エッジ数)
        //   だった（60ノード×800エッジで約4.8万回の走査）。id → ノードの Map を先に作る。
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        return graph.links.map((l) => {
        if (opts.useValueColors) {
            const span = graph.maxL - graph.minL;
            return scaleColorFor(span > 0 ? (l.value - graph.minL) / span : 0.5, opts);
        }
        const sN = byId.get(l.sId);
        const tN = byId.get(l.tId);
        const cA = sN ? opts.palette[sN.rank % opts.palette.length] : colors.edgeBase;
        const cB = tN ? opts.palette[tN.rank % opts.palette.length] : colors.edgeBase;
        return lerpColor(cA, cB, 0.5);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graph, opts]);

    // ---- シミュレーション構築（位置は id で引き継ぎ、初期配置は決定的な円周+ジッタ）
    useEffect(() => {
        const { w, h } = sizeRef.current;
        const cx = (w || 800) / 2;
        const cy = (h || 500) / 2;
        const prev = simRef.current;
        const prevPos = new Map((prev?.nodes || []).map((n) => [n.id, n]));
        const rng = mulberry32(hashStr(graph.nodes.map((n) => n.id).join('|')) || 1);
        const oNow = optsRef.current;
        const radiusSpan = MIN_RADIUS + 22 * (oNow.nodeScale / 100);

        const nodes = graph.nodes.map((gn, i) => {
            const old = prevPos.get(gn.id);
            const angle = (i / Math.max(graph.nodes.length, 1)) * Math.PI * 2 + rng() * 0.5;
            const rad = Math.min(cx, cy) * (0.35 + rng() * 0.4);
            const t = graph.maxN > graph.minN
                ? (gn.value - graph.minN) / (graph.maxN - graph.minN) : 0.5;
            // 衝突半径にラベルの実幅（推定）の半分を足すため、名前幅を持たせる
            const labelHalf = oNow.showLabels
                ? estimateLabelWidth(gn.name, oNow.labelSize) / 2 : 0;
            return {
                ...gn,
                r: MIN_RADIUS + Math.sqrt(clamp(t, 0, 1)) * (radiusSpan - MIN_RADIUS),
                labelHalf: clamp(labelHalf, 0, 90), // 極端に長い名前でレイアウトが破綻しない上限
                x: old ? old.x : cx + Math.cos(angle) * rad,
                y: old ? old.y : cy + Math.sin(angle) * rad,
                vx: old ? old.vx : 0,
                vy: old ? old.vy : 0,
                fx: null,
                fy: null,
            };
        });
        const byId = new Map(nodes.map((n) => [n.id, n]));
        // 双方向エッジ（A→B と B→A）を検出。edgeGeometry 側で走査方向により
        // 自動的に反対側へ膨らむので、ここでは biDir フラグ（膨らみ量を強める）だけ持たせる。
        const present = new Set(graph.links.map((l) => `${l.sId}\u0000${l.tId}`));
        const links = graph.links
            .map((l, i) => ({
                ...l, idx: i, source: byId.get(l.sId), target: byId.get(l.tId),
                biDir: present.has(`${l.tId}\u0000${l.sId}`),
            }))
            .filter((l) => l.source && l.target);

        // 隣接（ホバーハイライト用）
        const adjacency = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
        links.forEach((l) => {
            adjacency.get(l.sId)?.add(l.tId);
            adjacency.get(l.tId)?.add(l.sId);
        });

        simRef.current = { nodes, links, byId, adjacency };
        const isFirst = prevPos.size === 0;
        // 間隔・ラベル変更時は配置を大きく組み替えるので強めに再加熱
        alphaRef.current = isFirst ? 1 : Math.max(alphaRef.current, 0.6);
        if (isFirst) {
            // 初期の暴れを画面に出さないよう同期でならしてから、残りをアニメーション。
            // 反発を強めたぶん広がりきるまでのステップ数を増やす（40→90）
            for (let i = 0; i < 90; i += 1) {
                physicsStep();
                alphaRef.current *= 0.985;
            }
        }
        hoverRef.current = { id: null, dirty: true };
        needsDrawRef.current = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graph, opts.nodeScale, opts.spacing, opts.labelSize, opts.showLabels]);

    // ---- 物理 1 ステップ（O(n^2) 反発 + スプリング + 中心重力 + 衝突）
    function physicsStep() {
        const sim = simRef.current;
        if (!sim) return;
        const o = optsRef.current;
        // ★ドラッグ中は力を大きく弱める（0.15倍）。
        //   重なり回避（反発・衝突）は本来ありがたい力だが、掴んでいる間もフルに効くと
        //   周囲のノードが逃げ回り、掴んだノードも押し返されて「狙った場所に置けない」。
        //   0.35→0.15 でもまだ動きすぎたので 0.07 倍まで下げた（v1.2.2）。
        //   これで「置いた場所にとどまり、周囲はほとんど動かない」挙動になる。
        const alpha = alphaRef.current * (draggingRef.current ? 0.07 : 1);
        const { w, h } = sizeRef.current;
        const cx = (w || 800) / 2;
        const cy = (h || 500) / 2;
        const nodes = sim.nodes;
        const n = nodes.length;
        // 間隔スケール（オプション）。反発・リンク距離・衝突半径を一括で広げる。
        const spc = o.spacing / 100;
        // 描画領域の面積とノード数から理想間隔を求め、力を面積に応じてスケールする。
        // 固定値だと広いパネル・少ノードで中央に固まり、エッジが混雑する。
        const base = Math.sqrt(((w || 800) * (h || 500)) / Math.max(n, 1));
        // 反発を強め（0.06→0.09）、下限も引き上げて確実に押し広げる。間隔スケールを乗算。
        const charge = (o.repulsion / 100) * spc * spc * Math.max(1600, 0.09 * base * base);
        const linkDist = Math.max(o.linkDistance, base * 0.7) * spc;
        // ラベルの分まで衝突半径に含める。実ラベル幅の推定も使い、横方向の重なりを抑える。
        const labelPad = o.showLabels ? o.labelSize + 8 : 4;

        // --- 反発 ---
        // ★v1.2.0：総当たり O(n^2) から Barnes-Hut 近似 O(n log n) に置き換えた。
        //   遠くのノード群は「重心1点」にまとめて扱う（四分木のセル幅 / 距離 < THETA なら近似）。
        //   これでノード数の上限を上げても破綻しない。少数のときは木を作る方が高くつくので
        //   従来どおり総当たりにする（分岐点は実測ではなく一般的な目安）。
        if (n <= BARNES_HUT_MIN_NODES) {
            for (let i = 0; i < n; i += 1) {
                const a = nodes[i];
                for (let j = i + 1; j < n; j += 1) {
                    const b = nodes[j];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 0.5; }
                    const d = Math.sqrt(d2);
                    const f = Math.min((charge * alpha) / d2, 60);
                    const fx = (dx / d) * f;
                    const fy = (dy / d) * f;
                    a.vx -= fx; a.vy -= fy;
                    b.vx += fx; b.vy += fy;
                }
            }
        } else {
            const tree = buildQuadTree(nodes);
            for (let i = 0; i < n; i += 1) applyRepulsion(tree, nodes[i], charge * alpha);
        }
        // スプリング（次数の大きいノードは動きにくくする）
        sim.links.forEach((l) => {
            const s = l.source;
            const t = l.target;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const d = Math.max(Math.hypot(dx, dy), 0.1);
            const want = linkDist + s.r + t.r;
            const k = ((d - want) / d) * 0.25 * alpha;
            const wS = (t.value + 1) / (s.value + t.value + 2);
            s.vx += dx * k * wS; s.vy += dy * k * wS;
            t.vx -= dx * k * (1 - wS); t.vy -= dy * k * (1 - wS);
        });
        // 中心重力（弱め。強いと中央に固まる。画面いっぱいの利用は自動フィットが担う）
        for (let i = 0; i < n; i += 1) {
            const a = nodes[i];
            a.vx += (cx - a.x) * 0.01 * alpha;
            a.vy += (cy - a.y) * 0.01 * alpha;
        }
        // 衝突（重なりを直接ほどく。alpha 非依存でしっかり離すため 2 回反復。
        // ラベル込みの矩形的な最小間隔を「縦=半径+ラベル高、横=半径+ラベル半幅」で近似する）
        // ★v1.2.0：総当たりから格子（空間ハッシュ）に変更した。
        //   衝突は「近くにあるノード同士」しか起きないので、セル幅を最大の必要間隔にすると
        //   自分のセルと隣接8セルだけ見れば十分。ノードが増えても計算量が線形に近くなる。
        const maxLabelHalf = nodes.reduce((m, p) => Math.max(m, p.labelHalf || 0), 0);
        const maxR = nodes.reduce((m, p) => Math.max(m, p.r), 0);
        const cellSize = Math.max(2 * maxR + Math.max(labelPad, maxLabelHalf), 8);
        for (let pass = 0; pass < 2; pass += 1) {
            const grid = new Map();
            for (let i = 0; i < n; i += 1) {
                const p = nodes[i];
                const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
                const bucket = grid.get(key);
                if (bucket) bucket.push(i);
                else grid.set(key, [i]);
            }
            for (let i = 0; i < n; i += 1) {
                const a = nodes[i];
                const gx = Math.floor(a.x / cellSize);
                const gy = Math.floor(a.y / cellSize);
                for (let ox = -1; ox <= 1; ox += 1) {
                    for (let oy = -1; oy <= 1; oy += 1) {
                        const bucket = grid.get(`${gx + ox},${gy + oy}`);
                        if (!bucket) continue;
                        for (let bi = 0; bi < bucket.length; bi += 1) {
                            const j = bucket[bi];
                            if (j <= i) continue; // 各ペアを1回だけ処理する
                            const b = nodes[j];
                            let dx = b.x - a.x;
                            let dy = b.y - a.y;
                            let d = Math.hypot(dx, dy);
                            if (d < 0.01) { dx = (i % 2 ? 0.6 : -0.6); dy = 0.6; d = 0.85; }
                            // 縦方向はラベル高さ、横方向はラベル半幅ぶん余分に離す
                            const minX = a.r + b.r + (o.showLabels ? (a.labelHalf + b.labelHalf) * 0.5 : 6);
                            const minY = a.r + b.r + labelPad;
                            const nx = dx / d;
                            const ny = dy / d;
                            const minD = Math.abs(nx) * minX + Math.abs(ny) * minY;
                            const overlap = minD - d;
                            if (overlap > 0) {
                                // 衝突は alpha に依存させず常に効かせる（重なりを確実にほどくため）が、
                                // ドラッグ中だけは弱める。掴んだノードを押し返すと狙った場所に置けない。
                                // ※掴んでいるノード自体は積分側で fx/fy に固定されるので動かない。
                                const push = (overlap / d) * (draggingRef.current ? 0.03 : 0.5);
                                a.vx -= dx * push; a.vy -= dy * push;
                                b.vx += dx * push; b.vy += dy * push;
                            }
                        }
                    }
                }
            }
        }
        // 積分（ドラッグ中のノードは固定座標に従う）
        nodes.forEach((a) => {
            if (a.fx !== null && a.fy !== null) {
                a.x = a.fx; a.y = a.fy; a.vx = 0; a.vy = 0;
                return;
            }
            a.vx *= 0.6; a.vy *= 0.6;
            a.x += a.vx; a.y += a.vy;
            if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
                a.x = cx; a.y = cy; a.vx = 0; a.vy = 0;
            }
        });
    }

    // ---- DOM 更新（React を介さず SVG 属性を書く）
    function updateDOM(dtSec) {
        const sim = simRef.current;
        if (!sim) return;
        const o = optsRef.current;
        const view = viewRef.current;

        // 自動フィット：ノード＋ラベルのバウンディングボックスへカメラを緩やかに追従。
        // ユーザーがズーム/パンしたら解除し、ダブルクリックで復帰する。
        if (o.autoFit && autoFitRef.current && sim.nodes.length > 0) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            sim.nodes.forEach((nd) => {
                const pad = nd.r + 10;
                minX = Math.min(minX, nd.x - pad);
                maxX = Math.max(maxX, nd.x + pad);
                minY = Math.min(minY, nd.y - pad);
                maxY = Math.max(maxY, nd.y + pad + (o.showLabels ? o.labelSize + 8 : 0));
            });
            const { w: vw, h: vh } = svgSizeRef.current;
            const bw = Math.max(maxX - minX, 1);
            const bh = Math.max(maxY - minY, 1);
            const margin = 24;
            // 間隔を広げると bbox が大きくなるので、縮小側の下限を緩め（0.3→0.15）て
            // 広がったグラフでもパネル内に必ず収まるようにする
            const kFit = clamp(
                Math.min((vw - margin * 2) / bw, (vh - margin * 2) / bh),
                0.15,
                1.3
            );
            const targetTx = (vw - bw * kFit) / 2 - minX * kFit;
            const targetTy = (vh - bh * kFit) / 2 - minY * kFit;
            // 急に飛ばないよう easing で追従（収束中はカメラが滑らかに寄っていく）
            view.k += (kFit - view.k) * 0.12;
            view.tx += (targetTx - view.tx) * 0.12;
            view.ty += (targetTy - view.ty) * 0.12;
            if (
                Math.abs(kFit - view.k) > 0.002
                || Math.abs(targetTx - view.tx) > 0.5
                || Math.abs(targetTy - view.ty) > 0.5
            ) {
                needsDrawRef.current = true; // easing が終わるまで描画を続ける
            }
        }

        if (worldRef.current) {
            worldRef.current.setAttribute(
                'transform',
                `translate(${view.tx},${view.ty}) scale(${view.k})`
            );
        }

        // エッジ幾何を一度だけ計算して 土台path / 流れる破線 / 矢印 で共有
        const geoms = sim.links.map((l) => edgeGeometry(l, o.curved));

        // 破線の位相を共通で前進（src→dest 方向。dashoffset を負に進めると流れが前進する）。
        // 位置は物理が止まっても流し続けたいので、alpha とは独立に毎フレーム進める。
        const flowOn = o.showFlow;
        if (flowOn) {
            const pxPerSec = 42 * (o.flowSpeed / 100);
            flowPhaseRef.current = (flowPhaseRef.current + dtSec * pxPerSec) % 100000;
        }
        const phase = flowPhaseRef.current;

        sim.links.forEach((l, i) => {
            const g = geoms[i];
            const d = `M ${g.x0} ${g.y0} Q ${g.cx} ${g.cy} ${g.x1} ${g.y1}`;
            const el = linkEls.current.get(i);
            if (el) el.setAttribute('d', d);

            // 流れる破線オーバーレイ：土台と同じ曲線に dash を載せ、offset を進めて流す。
            // ダッシュ長は「破片:隙間 ≈ 1:2」。速い/流量の多いエッジほど破片を長くして勢いを出す。
            const flow = flowEls.current.get(i);
            if (flow) {
                if (!flowOn) {
                    flow.setAttribute('stroke-dashoffset', '0');
                    flow.setAttribute('stroke-dasharray', 'none');
                } else {
                    const w = edgeWidthRef.current(l);
                    const dash = clamp((o.flowDash / 100) * (8 + w * 2), 4, 60);
                    const gap = dash * 2;
                    flow.setAttribute('stroke-dasharray', `${dash} ${gap}`);
                    // dashoffset を減らすと破片は path の向き（src→dest）へ進む
                    flow.setAttribute('stroke-dashoffset', String(-phase % (dash + gap)));
                    flow.setAttribute('d', d);
                }
            }

            // 矢印：ノード縁（path 終端 = t=1）に頂点を正確に置き、太さに比例させる。
            const arrow = arrowEls.current.get(i);
            if (arrow) {
                const tan = bezTangent(g, 1);
                const ang = (Math.atan2(tan.y, tan.x) * 180) / Math.PI;
                arrow.setAttribute('transform', `translate(${g.x1},${g.y1}) rotate(${ang})`);
            }
        });
        sim.nodes.forEach((n) => {
            const el = nodeEls.current.get(n.id);
            if (el) el.setAttribute('transform', `translate(${n.x},${n.y})`);
        });

        // ホバーハイライト（opacity 属性のみを書く。React は opacity を持たない規約）
        if (hoverRef.current.dirty) {
            hoverRef.current.dirty = false;
            const hovId = hoverRef.current.id;
            const highlight = o.highlightOnHover && hovId !== null;
            const near = highlight ? sim.adjacency.get(hovId) || new Set() : null;
            sim.nodes.forEach((n) => {
                const el = nodeEls.current.get(n.id);
                if (!el) return;
                el.setAttribute('opacity', !highlight || near.has(n.id) ? '1' : '0.18');
            });
            sim.links.forEach((l, i) => {
                const el = linkEls.current.get(i);
                const touching = highlight && (l.sId === hovId || l.tId === hovId);
                const op = !highlight ? '1' : (touching ? '1' : '0.08');
                if (el) el.setAttribute('opacity', op);
                const flow = flowEls.current.get(i);
                if (flow) flow.setAttribute('opacity', op);
                const arrow = arrowEls.current.get(i);
                if (arrow) arrow.setAttribute('opacity', op);
            });
        }

        // ツールチップ位置（ホバーノードに追従）
        const tipEl = tooltipRef.current;
        const hovId = hoverRef.current.id;
        if (tipEl && hovId !== null) {
            const n = sim.byId.get(hovId);
            if (n) {
                const sx = n.x * view.k + view.tx;
                const sy = n.y * view.k + view.ty;
                const { w, h } = sizeRef.current;
                tipEl.style.left = `${clamp(sx + n.r * view.k + 10, 4, Math.max(w - 180, 4))}px`;
                tipEl.style.top = `${clamp(sy - 14, 4, Math.max(h - 80, 4))}px`;
            }
        }
    }

    // ---- rAF ループ（設営はマウント時に一度。設定は ref 経由で常に最新を見る）
    useEffect(() => {
        let rafId = 0;
        let last = nowMs();
        const loop = () => {
            const t = nowMs();
            const dt = Math.min(0.1, Math.max((t - last) / 1000, 0));
            last = t;
            if (simRef.current) {
                if (alphaRef.current > 0.004) {
                    physicsStep();
                    alphaRef.current *= 0.985;
                    needsDrawRef.current = true;
                }
                if (optsRef.current.showFlow) needsDrawRef.current = true;
                if (needsDrawRef.current || hoverRef.current.dirty) {
                    // updateDOM がカメラ easing 継続のため再度フラグを立てられるよう先にクリア
                    needsDrawRef.current = false;
                    updateDOM(dt);
                }
            }
            rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(rafId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- ホイールズーム（React の onWheel は passive のため native で登録）
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg || typeof svg.addEventListener !== 'function') return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            autoFitRef.current = false; // 手動ズームが始まったら自動フィット解除
            const rect = svg.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            const view = viewRef.current;
            const k2 = clamp(view.k * Math.exp(-e.deltaY * 0.0015), 0.2, 5);
            // カーソル位置を不動点にしてズーム
            view.tx = px - ((px - view.tx) / view.k) * k2;
            view.ty = py - ((py - view.ty) / view.k) * k2;
            view.k = k2;
            needsDrawRef.current = true;
        };
        svg.addEventListener('wheel', onWheel, { passive: false });
        return () => svg.removeEventListener('wheel', onWheel);
    }, [hasViz]);

    // ---- マウス操作
    const screenToWorld = (clientX, clientY) => {
        const svg = svgRef.current;
        const rect = svg ? svg.getBoundingClientRect() : { left: 0, top: 0 };
        const view = viewRef.current;
        return {
            x: (clientX - rect.left - view.tx) / view.k,
            y: (clientY - rect.top - view.ty) / view.k,
        };
    };

    // ---- ドリルダウン（編集画面の「インタラクション」）
    // 発火するのは addDrilldownListener に登録した DOM ノードのクリックだけ。
    // ★登録は「ノード1つにつき1回」。API に解除手段が無いため、再レンダリングのたびに
    //   登録し直すと同じ要素にリスナーが積み上がり1クリックで多重発火する。
    //   payload は WeakMap に毎回入れ直し、クリック時にそこから読む。
    // ★ドラッグとクリックの区別：ノードは掴んで動かせるので、動かした後に指を離した場合は
    //   ドリルダウンを発火させない（movedRef を見て抑制する）。
    const drillPayloads = useRef(new WeakMap());
    const drillRegistered = useRef(new WeakSet());
    const dragMovedRef = useRef(false);

    const attachDrill = useCallback((el, node) => {
        if (!el || typeof addDrilldownListener !== 'function') return;
        drillPayloads.current.set(el, {
            'row.node.value': node.name,
            'row.value.value': node.value,
            'row.in.value': node.inV,
            'row.out.value': node.outV,
            name: 'node',
            value: node.name,
        });
        if (drillRegistered.current.has(el)) return;
        drillRegistered.current.add(el);
        try {
            addDrilldownListener({
                node: el,
                action: NODE_CLICK_ACTION,
                payloadCallback: () => {
                    // ドラッグ直後のクリックは無視する（位置を動かしただけのつもりで
                    // トークンが変わると操作が予測できなくなる）
                    if (dragMovedRef.current) return {};
                    if (!optsRef.current.enableDrilldown) return {};
                    return drillPayloads.current.get(el) || {};
                },
            });
        } catch (e) {
            /* ドリルダウン未対応のホストでも描画は続ける */
        }
    }, []);

    const onNodeMouseDown = (id) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        const node = simRef.current?.byId.get(id);
        if (!node) return;
        // ★v1.2.0：ドラッグ中の操作性を優先する。
        //   従来は mousemove のたびに alpha を 0.35 へ再加熱していたため、
        //   1つ掴んだだけでグラフ全体が動き出し、掴んだノードも指から逃げていた。
        //   ここでは「掴んだノードは指に完全追従」「周囲はゆっくり譲る」を狙い、
        //   ・再加熱は控えめ（0.12）で、毎フレーム上書きせず下限としてだけ効かせる
        //   ・自動フィットを止める（カメラが追いかけると余計に逃げて見える）
        //   ・離した瞬間に飛び散らないよう、速度を落としてから解放する
        draggingRef.current = true;
        dragMovedRef.current = false; // 動かさずに離せばクリック扱い
        autoFitRef.current = false;
        const move = (ev) => {
            dragMovedRef.current = true; // 1px でも動かしたらドラッグ
            const p = screenToWorld(ev.clientX, ev.clientY);
            node.fx = p.x;
            node.fy = p.y;
            node.x = p.x; // 追従を1フレーム待たせない（指とのズレを無くす）
            node.y = p.y;
            node.vx = 0;
            node.vy = 0;
            if (alphaRef.current < 0.12) alphaRef.current = 0.12;
            needsDrawRef.current = true;
        };
        const up = () => {
            node.fx = null;
            node.fy = null;
            node.vx = 0; // 離した瞬間に弾かれないように速度を消す
            node.vy = 0;
            draggingRef.current = false;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };

    const onBackgroundMouseDown = (e) => {
        if (e.target !== svgRef.current) return; // ノード上は各ノードが処理
        e.preventDefault();
        autoFitRef.current = false; // 手動パンが始まったら自動フィット解除
        let lastX = e.clientX;
        let lastY = e.clientY;
        const move = (ev) => {
            const view = viewRef.current;
            view.tx += ev.clientX - lastX;
            view.ty += ev.clientY - lastY;
            lastX = ev.clientX;
            lastY = ev.clientY;
            needsDrawRef.current = true;
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };

    const resetView = () => {
        viewRef.current = { k: 1, tx: 0, ty: 0 };
        autoFitRef.current = true; // autoFit ON なら次フレームから再フィット
        needsDrawRef.current = true;
    };

    const setHoverNode = (id) => {
        hoverRef.current = { id, dirty: true };
        if (id === null) {
            setTooltip(null);
            return;
        }
        const n = simRef.current?.byId.get(id);
        if (!n) return;
        const adj = simRef.current?.adjacency.get(id);
        const neighbors = adj ? adj.size - 1 : 0;
        setTooltip({
            lines: [
                n.name,
                `in ${fmtFull(n.inV)} / out ${fmtFull(n.outV)}`,
                `${neighbors} neighbor${neighbors === 1 ? '' : 's'}`,
            ],
        });
    };

    // ---- ガード表示
    const empty = (children) => (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">{children}</div>
        </div>
    );
    if (loading && !data) {
        return empty(<WaitSpinner size="medium" />);
    }
    if (!data || rows.length === 0) {
        return empty(<Paragraph>データがありません。サーチ結果を確認してください。</Paragraph>);
    }
    if (fieldCount < 2) {
        return empty(
            <Paragraph>
                Network graph requires at least 2 columns: source, target, and an optional
                numeric value. Example: <code>| stats count by src, dest</code>
            </Paragraph>
        );
    }
    if (graph.links.length === 0) {
        return empty(
            <Paragraph>
                No valid network links found. Rows need non-empty source/target names,
                a positive numeric value, and source ≠ target.
            </Paragraph>
        );
    }

    // ---- ヘッダー
    const notes = [];
    if (graph.stats.selfLoops > 0) notes.push(`自己ループ ${graph.stats.selfLoops} 件`);
    if (graph.stats.invalid > 0) notes.push(`不正な行 ${graph.stats.invalid} 件`);
    if (graph.stats.cappedNodes > 0) notes.push(`ノード ${graph.stats.cappedNodes} 件`);
    if (graph.stats.droppedLinks > 0) notes.push(`エッジ ${graph.stats.droppedLinks} 件`);

    const legendGradient = opts.useMidColor
        ? `linear-gradient(to right, ${opts.reverse ? opts.highColor : opts.lowColor}, ${opts.midColor}, ${opts.reverse ? opts.lowColor : opts.highColor})`
        : `linear-gradient(to right, ${opts.reverse ? opts.highColor : opts.lowColor}, ${opts.reverse ? opts.lowColor : opts.highColor})`;

    const edgeWidthOf = (l) => {
        const span = graph.maxL - graph.minL;
        const t = span > 0 ? (l.value - graph.minL) / span : 0.5;
        return (1 + t * 5) * (opts.edgeScale / 100);
    };
    // rAF ループ（破線の長さ・矢印の向き）が最新の太さを読めるよう毎レンダー差し替える
    edgeWidthRef.current = edgeWidthOf;

    // 矢印は太さ連動。頂点を原点(0,0)＝ノード縁に置き、三角形は後方(-L)へ伸ばす。
    // これでどの太さ・曲率でも「線の先端がノードに刺さる」見た目になる。
    const arrowPointsOf = (l) => {
        const w = edgeWidthOf(l);
        const half = clamp(2.6 + w * 1.1, 3, 12); // 矢羽根の半幅
        const len = half * 2.2; // 頂点から後方への長さ
        return `0,0 ${-len},${-half} ${(-len) * 0.72},0 ${-len},${half}`;
    };

    // シミュレーション構築時と同じ式（物理用の r と見た目の r を一致させる）
    const radiusOf = (n) => {
        const radiusSpan = MIN_RADIUS + 22 * (opts.nodeScale / 100);
        const t = graph.maxN > graph.minN
            ? (n.value - graph.minN) / (graph.maxN - graph.minN) : 0.5;
        return MIN_RADIUS + Math.sqrt(clamp(t, 0, 1)) * (radiusSpan - MIN_RADIUS);
    };

    const glowOn = opts.glow && mode === 'dark';

    // svg 実寸（ヘッダー分を差し引く）。自動フィットのビューポート計算と共有する
    const svgW = Math.max(size.w - 16, 0);
    // ★ヘッダーは狭いパネルでは出さない／操作ヒントは幅が足りるときだけ出す。
    //   実機で 240x170 のパネルにするとヘッダーが2行に折り返してグラフが消えていた。
    const headerVisible = opts.showHeader && size.h >= 170;
    const hintVisible = headerVisible && size.w >= 460;
    const svgH = Math.max(size.h - (headerVisible ? 34 : 12), 0);
    svgSizeRef.current = { w: svgW, h: svgH };

    return (
        <div
            ref={setContainer}
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
                padding: 8,
                overflow: 'hidden',
                position: 'relative',
            }}
        >
            {headerVisible && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        // ★折り返さない。折り返すとヘッダーが2行になり、狭いパネルでは
                        //   グラフの領域を食い潰してしまう（実機で確認）。
                        flexWrap: 'nowrap',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        padding: '2px 6px 6px',
                        fontSize: 12,
                        color: colors.muted,
                        flex: 'none',
                    }}
                >
                    <span style={{ color: colors.text, fontWeight: 600, flex: 'none' }}>
                        ノード {graph.nodes.length} ・ エッジ {graph.links.length} ・ 合計 {fmtFull(graph.totalFlow)}
                    </span>
                    {notes.length > 0 && (
                        <span
                            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={`省略: ${notes.join('、')}`}
                        >
                            省略: {notes.join('、')}
                        </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {opts.useValueColors ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span>{fmtCompact(graph.minL)}</span>
                            <span
                                style={{
                                    display: 'inline-block',
                                    width: 90,
                                    height: 8,
                                    borderRadius: 4,
                                    background: legendGradient,
                                }}
                            />
                            <span>{fmtCompact(graph.maxL)}</span>
                        </span>
                    ) : (
                        hintVisible && (
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                ドラッグで移動 ／ ホイールで拡大縮小 ／ ダブルクリックで元に戻す
                            </span>
                        )
                    )}
                </div>
            )}

            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <svg
                    ref={svgRef}
                    width={svgW}
                    height={svgH}
                    style={{ display: 'block', cursor: 'grab', userSelect: 'none' }}
                    onMouseDown={onBackgroundMouseDown}
                    onDoubleClick={resetView}
                >
                    <defs>
                        <filter id={`${uid}-blur`} x="-80%" y="-80%" width="260%" height="260%">
                            <feGaussianBlur stdDeviation="5" />
                        </filter>
                    </defs>
                    <g ref={worldRef}>
                        {/* エッジ */}
                        <g fill="none">
                            {graph.links.map((l, i) => (
                                <path
                                    key={`${l.sId}\u0000${l.tId}`}
                                    ref={(el) => {
                                        if (el) linkEls.current.set(i, el);
                                        else linkEls.current.delete(i);
                                    }}
                                    className="ng-edge"
                                    stroke={linkColors[i]}
                                    strokeWidth={edgeWidthOf(l)}
                                    strokeOpacity={opts.edgeOpacity / 100}
                                    strokeLinecap="round"
                                />
                            ))}
                        </g>
                        {/* 流れる破線オーバーレイ：土台の上に同色の破片を載せ、dashoffset で
                            src→dest 方向へ流す（点は動かさない）。d/dash は rAF が命令的に更新 */}
                        {opts.showFlow && (
                            <g fill="none" style={{ pointerEvents: 'none' }}>
                                {graph.links.map((l, i) => (
                                    <path
                                        key={`f${l.sId}\u0000${l.tId}`}
                                        ref={(el) => {
                                            if (el) flowEls.current.set(i, el);
                                            else flowEls.current.delete(i);
                                        }}
                                        className="ng-flow"
                                        stroke={linkColors[i]}
                                        strokeWidth={edgeWidthOf(l) + 0.6}
                                        strokeOpacity={Math.min(1, opts.edgeOpacity / 100 + 0.35)}
                                        strokeLinecap="round"
                                    />
                                ))}
                            </g>
                        )}
                        {/* 矢印 */}
                        {opts.showArrows && (
                            <g>
                                {graph.links.map((l, i) => (
                                    <polygon
                                        key={`a${l.sId}\u0000${l.tId}`}
                                        ref={(el) => {
                                            if (el) arrowEls.current.set(i, el);
                                            else arrowEls.current.delete(i);
                                        }}
                                        className="ng-arrow"
                                        points={arrowPointsOf(l)}
                                        fill={linkColors[i]}
                                        fillOpacity={Math.min(1, opts.edgeOpacity / 100 + 0.4)}
                                    />
                                ))}
                            </g>
                        )}
                        {/* ノード */}
                        <g>
                            {graph.nodes.map((n) => {
                                const fill = nodeColorOf(n);
                                const r = radiusOf(n);
                                return (
                                    <g
                                        key={n.id}
                                        ref={(el) => {
                                            if (el) {
                                                nodeEls.current.set(n.id, el);
                                                attachDrill(el, n);
                                            } else nodeEls.current.delete(n.id);
                                        }}
                                        style={{ cursor: 'pointer' }}
                                        onMouseDown={onNodeMouseDown(n.id)}
                                        onMouseEnter={() => setHoverNode(n.id)}
                                        onMouseLeave={() => setHoverNode(null)}
                                    >
                                        {glowOn && (
                                            <circle
                                                className="ng-halo"
                                                r={r * 1.35}
                                                fill={fill}
                                                opacity={0.5}
                                                filter={`url(#${uid}-blur)`}
                                                style={{ pointerEvents: 'none' }}
                                            />
                                        )}
                                        <circle className="ng-hit" r={r + 8} fill="transparent" stroke="none" />
                                        <circle
                                            className="ng-node"
                                            r={r}
                                            data-id={n.id}
                                            fill={fill}
                                            stroke={colors.nodeStroke}
                                            strokeWidth={1.5}
                                        />
                                        {opts.showLabels && (
                                            <text
                                                className="ng-label"
                                                textAnchor="middle"
                                                y={r + opts.labelSize + 3}
                                                fontSize={opts.labelSize}
                                                fill={colors.text}
                                                style={{ pointerEvents: 'none' }}
                                            >
                                                {truncateLabel(n.name, opts.labelMaxChars)}
                                                {opts.showValues && (
                                                    <tspan fill={colors.muted} fontSize={Math.max(opts.labelSize - 1, 6)}>
                                                        {` ${fmtCompact(n.value)}`}
                                                    </tspan>
                                                )}
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </g>
                    </g>
                </svg>

                {/* ツールチップ（位置は rAF が追従させる） */}
                {tooltip && (
                    <div
                        ref={tooltipRef}
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
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
        </div>
    );
}

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <NetworkGraph mode={mode} />
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
