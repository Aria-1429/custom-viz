import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Treemap（ツリーマップ）
//
// 階層構造を「面積」で表すビジュアライゼーション。
// index > sourcetype > host のような入れ子を一画面に収め、
// どこが容量・件数を食っているかを一目で示す。
//
// データモデル:
//   階層ラベル列（1〜3列）+ 数値列
//     例: | stats count by index, sourcetype, host
//     例: | stats sum(bytes) as bytes by index, sourcetype
//   列の明示選択（editor.columnSelector）は自動判定より優先。
//   同じ組み合わせの行は合算する。
//
// レイアウトは squarified treemap（Bruls et al. 2000）。単純な slice-and-dice
// だと細長い短冊になって面積の比較ができなくなるため、縦横比が 1 に近づくよう
// 行を積む方式を実装している。
//
// タイルをクリックすると、その枝を根として掘り下げる（ドリルダウン）。
// 現在位置はパンくずリストに出し、クリックで任意の階層へ戻れる。
// 掘り下げ位置は drillPath オプションに保存され、編集→保存で永続化できる。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '1.1.0';

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 値（面積）フィールド（'' = 自動）
    level1Field: '', // 第1階層フィールド（'' = 自動）
    level2Field: '', // 第2階層フィールド
    level3Field: '', // 第3階層フィールド

    // 色覚特性（第2色覚）でも隣接色が潰れないよう色相を広く取ったパレット
    color1: '#4c9be8',
    color2: '#26c2a5',
    color3: '#f2b53c',
    color4: '#f2653f',
    color5: '#a97bf0',
    color6: '#f75d97',
    color7: '#5ed4f0',
    color8: '#94a3b5',
    shadeChildren: true, // 子タイルを濃淡で塗り分ける

    maxDepth: 2, // 同時に表示する階層数（1〜3）
    maxTiles: 300, // タイルの最大数（超過分は「その他」へ集約）
    tileGap: 2, // タイルの間隔（px）
    tileRadius: 3, // タイルの角丸（px）

    showLabels: true, // タイル名を表示
    showValues: true, // 値を表示
    showPercent: false, // 全体に占める割合を表示
    showGroupHeaders: true, // グループ見出しを表示
    showBreadcrumb: true, // パンくずリストを表示
    showLegend: false, // 凡例を表示
    enableDrilldown: true, // クリックで掘り下げる
    animate: true, // フェードインアニメーション

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: true, // 1.5M などの省略表記

    drillPath: '', // 掘り下げ位置（"index\u0001sourcetype" のような区切り文字列）

    debug: false, // options デバッグ表示
};

// 階層フィールドのオプションキー（第1〜第3階層）
const LEVEL_KEYS = ['level1Field', 'level2Field', 'level3Field'];
const PALETTE_KEYS = ['color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'color8'];

// drillPath の区切り（ラベルに現れない制御文字を使う）
const PATH_SEP = '\u0001';

// 描画上限
const MAX_TILES_HARD = 2000;
// アニメーションを行うタイル数の上限（超過時は即時表示）
const MAX_ANIMATED_TILES = 800;
// グループ見出しの高さ（px）
const HEADER_H = 16;

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function clamp01(v) {
    return clamp(v, 0, 1);
}

// 数値正規化（カンマ・空白を許容）
function parseNum(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[,\s]/g, '').trim();
    if (s === '') return NaN;
    return Number(s);
}

function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

function rgbCss(c) {
    return `rgb(${c.r},${c.g},${c.b})`;
}

// 色を白/黒側へ寄せる（子タイルの濃淡づけに使う）
function shiftColor(hex, amount) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    const t = clamp(amount, -1, 1);
    const target = t >= 0 ? 255 : 0;
    const k = Math.abs(t);
    return rgbCss({
        r: Math.round(c.r + (target - c.r) * k),
        g: Math.round(c.g + (target - c.g) * k),
        b: Math.round(c.b + (target - c.b) * k),
    });
}

// おおまかな相対輝度（0..1）。タイル内テキストの白黒切替に使う
function luminanceOf(cssColor) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(cssColor));
    let c;
    if (m) {
        c = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    } else {
        c = hexToRgb(cssColor);
    }
    if (!c) return 0;
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

// 数値フォーマット（カンマ区切り / 省略表記）
function fmtValue(n, decimals, abbreviate) {
    if (!Number.isFinite(n)) return '-';
    if (abbreviate) {
        const abs = Math.abs(n);
        const units = [
            [1e12, 'T'],
            [1e9, 'B'],
            [1e6, 'M'],
            [1e3, 'K'],
        ];
        for (const [u, suf] of units) {
            if (abs >= u) {
                const v = n / u;
                const str = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
                return str + suf;
            }
        }
    }
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    const d = clamp(Math.round(decimals) || 0, 0, 6);
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// CJK を含むかで文字幅を推定（SVG に measureText が無いための近似）
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.62;
    }
    return w;
}

// 推定幅が maxW に収まるよう末尾を … で切り詰める
function truncateToWidth(text, fontSize, maxW) {
    const s = String(text);
    if (estimateTextWidth(s, fontSize) <= maxW) return s;
    let out = '';
    let w = 0;
    const ell = fontSize * 0.62;
    for (const ch of s) {
        const cw = ch.codePointAt(0) > 0x2e7f ? fontSize : fontSize * 0.62;
        if (w + cw + ell > maxW) break;
        out += ch;
        w += cw;
    }
    return out.length > 0 ? `${out}…` : '…';
}

// ---------------------------------------------------------------------------
// オプション正規化（型・範囲を安全側へ）
// ---------------------------------------------------------------------------

function normalizeOptions(raw) {
    const o = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
    const numOr = (v, d) => {
        const n = parseNum(v);
        return Number.isFinite(n) ? n : d;
    };
    const colorOr = (v, d) => (hexToRgb(v) ? v : d);
    const fieldOr = (v) => (typeof v === 'string' || Array.isArray(v) ? v : '');
    const strOr = (v, d) => (typeof v === 'string' ? v : d);

    const out = {
        valueField: fieldOr(o.valueField),
        level1Field: fieldOr(o.level1Field),
        level2Field: fieldOr(o.level2Field),
        level3Field: fieldOr(o.level3Field),

        shadeChildren: bool(o.shadeChildren, DEFAULTS.shadeChildren),

        maxDepth: clamp(Math.round(numOr(o.maxDepth, DEFAULTS.maxDepth)), 1, 3),
        maxTiles: clamp(Math.round(numOr(o.maxTiles, DEFAULTS.maxTiles)), 1, MAX_TILES_HARD),
        tileGap: clamp(numOr(o.tileGap, DEFAULTS.tileGap), 0, 16),
        tileRadius: clamp(numOr(o.tileRadius, DEFAULTS.tileRadius), 0, 20),

        showLabels: bool(o.showLabels, DEFAULTS.showLabels),
        showValues: bool(o.showValues, DEFAULTS.showValues),
        showPercent: bool(o.showPercent, DEFAULTS.showPercent),
        showGroupHeaders: bool(o.showGroupHeaders, DEFAULTS.showGroupHeaders),
        showBreadcrumb: bool(o.showBreadcrumb, DEFAULTS.showBreadcrumb),
        showLegend: bool(o.showLegend, DEFAULTS.showLegend),
        enableDrilldown: bool(o.enableDrilldown, DEFAULTS.enableDrilldown),
        animate: bool(o.animate, DEFAULTS.animate),

        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),

        drillPath: strOr(o.drillPath, ''),

        debug: bool(o.debug, DEFAULTS.debug),
    };

    out.palette = PALETTE_KEYS.map((k) => colorOr(o[k], DEFAULTS[k]));
    return out;
}

// ---------------------------------------------------------------------------
// データ正規化（rows / columns 両形式・マルチバリュー救済）
// ---------------------------------------------------------------------------

function normalizeData(data) {
    try {
        if (!data) return [];
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

function fieldNamesOf(data) {
    try {
        return (data?.fields || []).map((f) => (typeof f === 'string' ? f : f?.name || ''));
    } catch (e) {
        return [];
    }
}

// editor.columnSelector は選択結果を DOS 文字列（"> primary | seriesByName('x')"）で書く。
// カスタム viz には未解決で届くので自前パース。将来ホストが配列で渡す場合にも対応。
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    if (Array.isArray(spec)) {
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) {
                    ok = false;
                    break;
                }
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

// Splunk のマルチバリューセルを平行展開して救済（トークン数一致時のみ）
function cellTokens(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c.includes('\n')) return c.split('\n');
    return [c];
}

function expandMultivalueRows(rows) {
    const out = [];
    for (const row of rows) {
        if (!Array.isArray(row)) {
            out.push(row);
            continue;
        }
        const tokens = row.map(cellTokens);
        const L = tokens.reduce((m, t) => Math.max(m, t.length), 0);
        if (L <= 1) {
            out.push(tokens.map((t) => t[0]));
            continue;
        }
        if (tokens.every((t) => t.length === L)) {
            for (let k = 0; k < L; k += 1) out.push(tokens.map((t) => t[k]));
        } else {
            out.push(new Array(row.length).fill(null));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 階層ツリーの構築
// ---------------------------------------------------------------------------

function buildModel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows).filter((r) => Array.isArray(r));
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length === 0 || colCount === 0) return { error: 'empty' };

    const isNumericCol = (i) => rows.some((r) => Number.isFinite(parseNum(r[i])));

    // --- 値列の解決: 明示選択 > 最後の数値列（stats の集計列は末尾に来る） ---
    let valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, -1);
    if (valIdx < 0) {
        for (let i = colCount - 1; i >= 0; i -= 1) {
            if (isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) {
                valIdx = i;
                break;
            }
        }
        if (valIdx < 0) {
            for (let i = colCount - 1; i >= 0; i -= 1) {
                if (isNumericCol(i)) {
                    valIdx = i;
                    break;
                }
            }
        }
    }
    if (valIdx < 0) return { error: 'novalue' };

    // --- 階層列の解決: 明示選択 > 値列以外の非数値列を左から順に ---
    const explicit = LEVEL_KEYS.map((k) => resolveFieldIndex(opts[k], fieldNames, rows, -1));
    let levelIdx = explicit.filter((i) => i >= 0 && i !== valIdx);
    if (levelIdx.length === 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (i === valIdx || isNumericCol(i)) continue;
            if ((fieldNames[i] || '').startsWith('_')) continue;
            levelIdx.push(i);
            if (levelIdx.length >= 3) break;
        }
    }
    // 非数値列が1つも無い場合は、値列以外の列をそのままラベルとして使う
    if (levelIdx.length === 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (i !== valIdx) {
                levelIdx.push(i);
                break;
            }
        }
    }
    if (levelIdx.length === 0) return { error: 'nolevel' };
    levelIdx = levelIdx.slice(0, 3);

    // --- ツリーへ積む（同じ組み合わせは合算） ---
    const root = { name: '', value: 0, children: new Map(), depth: 0, path: [] };
    let negatives = 0;
    let skipped = 0;

    for (const r of rows) {
        const v = parseNum(r[valIdx]);
        if (!Number.isFinite(v)) {
            skipped += 1;
            continue;
        }
        // 面積は負値を表現できない。落とさず件数だけ数えて注記する。
        if (v < 0) {
            negatives += 1;
            continue;
        }
        if (v === 0) continue;

        let node = root;
        root.value += v;
        for (const li of levelIdx) {
            const raw = r[li];
            const key = raw === null || raw === undefined || raw === '' ? '(なし)' : String(raw);
            let child = node.children.get(key);
            if (!child) {
                child = {
                    name: key,
                    value: 0,
                    children: new Map(),
                    depth: node.depth + 1,
                    path: [...node.path, key],
                };
                node.children.set(key, child);
            }
            child.value += v;
            node = child;
        }
    }

    if (root.value <= 0) return { error: 'novalue' };

    // Map を配列へ（値の降順）。squarified は降順入力を前提にする。
    const toArray = (node) => {
        const kids = Array.from(node.children.values());
        kids.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
        node.children = kids;
        for (const k of kids) toArray(k);
        return node;
    };
    toArray(root);

    return {
        root,
        levelNames: levelIdx.map((i) => fieldNames[i] || `列${i + 1}`),
        valueName: fieldNames[valIdx] || '値',
        negatives,
        skipped,
        usedIdx: { valIdx, levelIdx },
    };
}

// drillPath をたどって表示の根ノードを得る（見つからなければ全体へフォールバック）
function resolveDrillRoot(root, drillPath) {
    if (!drillPath) return { node: root, path: [] };
    const parts = drillPath.split(PATH_SEP).filter((s) => s !== '');
    let node = root;
    const path = [];
    for (const p of parts) {
        const next = Array.isArray(node.children) ? node.children.find((c) => c.name === p) : null;
        // 葉まで掘った場合はそこで止める（それ以上は掘れない）
        if (!next || !next.children || next.children.length === 0) break;
        node = next;
        path.push(p);
    }
    return { node, path };
}

// タイル数の上限を超える枝は「その他」へ集約する
function capChildren(nodes, cap) {
    if (!Array.isArray(nodes) || nodes.length <= cap) return { list: nodes, folded: 0 };
    const keep = nodes.slice(0, Math.max(cap - 1, 1));
    const rest = nodes.slice(Math.max(cap - 1, 1));
    const restSum = rest.reduce((s, n) => s + n.value, 0);
    if (restSum <= 0) return { list: keep, folded: rest.length };
    return {
        list: [
            ...keep,
            {
                name: `その他（${rest.length}件）`,
                value: restSum,
                children: [],
                depth: keep.length > 0 ? keep[0].depth : 1,
                path: null, // 集約タイルは掘り下げ不可
                isOther: true,
            },
        ],
        folded: rest.length,
    };
}

// ---------------------------------------------------------------------------
// squarified treemap レイアウト（Bruls, Huizing, van Wijk 2000）
//
// 単純な slice-and-dice は細長い短冊を生み、面積の比較が破綻する。
// 「行に1つ足したとき最悪アスペクト比が改善するなら足す、しないなら行を確定」
// を繰り返して、各タイルを正方形に近づける。
// ---------------------------------------------------------------------------

// 行 row（面積の配列）を長さ len の辺に並べたときの最悪アスペクト比
function worstRatio(row, len, sum) {
    if (row.length === 0 || len <= 0 || sum <= 0) return Infinity;
    const max = row[0] > row[row.length - 1] ? row[0] : row[row.length - 1];
    const min = row[0] < row[row.length - 1] ? row[0] : row[row.length - 1];
    // 行の厚み = sum / len。各タイルの幅 = area / 厚み。
    const s2 = sum * sum;
    const l2 = len * len;
    return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

// nodes を rect {x,y,w,h} に敷き詰めて [{node, x, y, w, h}] を返す
function squarify(nodes, rect) {
    const out = [];
    const total = nodes.reduce((s, n) => s + n.value, 0);
    if (!(total > 0) || rect.w <= 0 || rect.h <= 0) return out;

    // 値を面積へ換算する係数
    const scale = (rect.w * rect.h) / total;
    const items = nodes.map((n) => ({ node: n, area: n.value * scale }));

    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;
    let i = 0;

    while (i < items.length) {
        const len = Math.min(w, h); // 行を並べる辺（短い方）
        const row = [];
        let rowSum = 0;

        // 行に足せるだけ足す（最悪アスペクト比が悪化する直前で止める）
        while (i < items.length) {
            const a = items[i].area;
            if (row.length === 0) {
                row.push(a);
                rowSum += a;
                i += 1;
                continue;
            }
            const cur = worstRatio(row, len, rowSum);
            const next = worstRatio([...row, a], len, rowSum + a);
            if (next > cur) break;
            row.push(a);
            rowSum += a;
            i += 1;
        }

        // 行を実際に配置する
        const rowNodes = items.slice(i - row.length, i);
        const thick = len > 0 ? rowSum / len : 0;

        if (w >= h) {
            // 縦に積む行（幅 thick の列）
            let cy = y;
            for (const it of rowNodes) {
                const th = rowSum > 0 ? (it.area / rowSum) * h : 0;
                out.push({ node: it.node, x, y: cy, w: thick, h: th });
                cy += th;
            }
            x += thick;
            w -= thick;
        } else {
            // 横に並べる行（高さ thick の行）
            let cx = x;
            for (const it of rowNodes) {
                const tw = rowSum > 0 ? (it.area / rowSum) * w : 0;
                out.push({ node: it.node, x: cx, y, w: tw, h: thick });
                cx += tw;
            }
            y += thick;
            h -= thick;
        }

        // 数値誤差で負の残領域になったら打ち切る
        if (w <= 0.01 || h <= 0.01) break;
    }

    return out;
}

// 表示する階層ぶんだけ再帰的にレイアウトしてタイル一覧を作る
function layoutTiles(node, rect, opts, depth, maxDepth, colorIdxOf, out, budget) {
    if (depth > maxDepth || rect.w <= 0.5 || rect.h <= 0.5) return;
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length === 0) return;

    const { list } = capChildren(kids, Math.max(budget.remaining, 1));
    const placed = squarify(list, rect);

    for (const p of placed) {
        if (budget.remaining <= 0) return;
        const isLeaf = !p.node.children || p.node.children.length === 0 || depth === maxDepth;
        const gap = opts.tileGap;
        // 見出しを出すのは「まだ子を描く」かつ十分な高さがある場合だけ
        const hasHeader =
            !isLeaf && opts.showGroupHeaders && p.h > HEADER_H + gap * 2 + 8 && p.w > 24;

        budget.remaining -= 1;
        out.push({
            node: p.node,
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            depth,
            isLeaf,
            hasHeader,
            // 色は第1階層で決まり、子は再帰時に渡される colorIdxOf が
            // 親の色をそのまま返すことで引き継がれる。
            colorIdx: colorIdxOf(p.node.name),
        });

        if (!isLeaf) {
            // 子は親の矩形から余白（と見出し）を引いた内側に敷く。
            // このとき内側の余白が親の角丸より小さいと、子の直線的な縁が親の丸みを
            // 覆い隠してしまい、とくに下辺が「角が立っている＝見切れている」ように見える。
            // そこで親の内側余白は必ず角丸ぶん以上を確保する。
            const groupPad = Math.max(gap, opts.tileRadius);
            const inner = {
                x: p.x + groupPad,
                y: p.y + gap + (hasHeader ? HEADER_H : 0),
                w: p.w - groupPad * 2,
                h: p.h - gap - groupPad - (hasHeader ? HEADER_H : 0),
            };
            const parentColor = out[out.length - 1].colorIdx;
            layoutTiles(
                p.node,
                inner,
                opts,
                depth + 1,
                maxDepth,
                () => parentColor,
                out,
                budget
            );
        }
    }
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#e3e8ee',
            subText: '#8b98a5',
            faintText: '#66727f',
            tileStroke: 'rgba(13,16,20,0.55)',
            headerText: '#e3e8ee',
            tileTextDark: '#12161a',
            tileTextLight: '#f5f7fa',
            crumbBg: 'rgba(139,152,165,0.12)',
            crumbText: '#c9d1d9',
            crumbActive: '#e3e8ee',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
        };
    }
    return {
        text: '#1e2429',
        subText: '#5c6773',
        faintText: '#8b98a5',
        tileStroke: 'rgba(255,255,255,0.75)',
        headerText: '#1e2429',
        tileTextDark: '#12161a',
        tileTextLight: '#f5f7fa',
        crumbBg: 'rgba(92,103,115,0.10)',
        crumbText: '#3d4954',
        crumbActive: '#1e2429',
        panelBg: 'rgba(255,255,255,0.98)',
        panelBorder: 'rgba(92,103,115,0.4)',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// フェードインアニメーション（データ変更で 0→1 を再生。無効時は常に 1）
// ---------------------------------------------------------------------------

function useFadeProgress(signature, enabled) {
    const [progress, setProgress] = useState(enabled ? 0 : 1);

    useEffect(() => {
        if (!enabled || typeof requestAnimationFrame === 'undefined') {
            setProgress(1);
            return undefined;
        }
        setProgress(0);
        const dur = 600;
        let rafId = 0;
        let t0 = 0;
        const step = (ts) => {
            if (!t0) t0 = ts;
            const t = clamp01((ts - t0) / dur);
            setProgress(t);
            if (t < 1) rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
        return () => cancelAnimationFrame(rafId);
    }, [signature, enabled]);

    return enabled ? progress : 1;
}

// ---------------------------------------------------------------------------
// メッセージ表示（ガード用）
// ---------------------------------------------------------------------------

function CenterMessage({ children }) {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                padding: 12,
            }}
        >
            <Paragraph>{children}</Paragraph>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function Treemap({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;
    const setOptions = optionsApi?.setOptions;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const model = useMemo(() => buildModel(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 640, h: 420 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 640;
        const h = el.clientHeight || 420;
        setDims((d) => (Math.abs(d.w - w) > 1 || Math.abs(d.h - h) > 1 ? { w, h } : d));
    }, []);
    const setContainer = useCallback(
        (el) => {
            containerRef.current = el;
            if (!el) return;
            measure(el);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => measure(el));
                ro.observe(el);
                el.__ro = ro;
            }
        },
        [measure]
    );

    // ドリルダウン位置。表示モードの setOptions はホスト定義に載らないため、
    // ローカル draft でライブプレビューし、編集モードで再送して永続化する。
    const [drillDraft, setDrillDraft] = useState(null);
    const pendingRef = useRef(null);
    // ホバー状態（強調表示とツールチップ）。pos は viz 内のローカル座標。
    const [hoverKey, setHoverKey] = useState(null);
    const [hoverPos, setHoverPos] = useState(null);

    useEffect(() => {
        const p = pendingRef.current;
        if (p !== null && p === opts.drillPath) pendingRef.current = null;
    }, [opts.drillPath]);

    // データが変わったら掘り下げ位置の下書きを捨てる（存在しない枝を指し続けないため）
    const dataKey = useMemo(() => `${rows.length}:${fieldNames.join(',')}`, [rows, fieldNames]);
    useEffect(() => {
        setDrillDraft(null);
    }, [dataKey]);

    const effectiveDrill = drillDraft !== null ? drillDraft : opts.drillPath;

    const applyDrill = useCallback(
        (nextPath) => {
            setDrillDraft(nextPath);
            pendingRef.current = nextPath;
            if (setOptions) {
                try {
                    setOptions({ drillPath: nextPath });
                } catch (e) {
                    /* 表示モードでは無視されることがある */
                }
            }
        },
        [setOptions]
    );

    const drill = useMemo(
        () => (model.error ? { node: null, path: [] } : resolveDrillRoot(model.root, effectiveDrill)),
        [model, effectiveDrill]
    );

    // アニメーション（データ・掘り下げ位置が変わったら再生）
    const signature = useMemo(
        () => (model.error ? '' : `${dataKey}:${drill.path.join('/')}:${opts.maxDepth}`),
        [model, dataKey, drill.path, opts.maxDepth]
    );

    const { w, h } = dims;
    const pal = chartColors(mode);
    const pad = 8;

    // --- レイアウト計算（フックの前に return しないよう、ガードより先に済ませる） ---
    // パンくず・凡例・注記はいずれも SVG の外に置く独立した flex 行なので、
    // SVG に与える高さからは「それらを引いた残り」だけを渡す。
    // ここで二重に引いたり引き忘れたりすると、タイルが SVG の外へはみ出して
    // 下端が見切れる（凡例ぶんの引き忘れが実際に起きていた）。
    const crumbH = !model.error && opts.showBreadcrumb ? 22 : 0;
    const noteH = !model.error && (model.negatives > 0 || model.skipped > 0) ? 15 : 0;
    const legendVisible =
        !model.error && opts.showLegend && Array.isArray(model.root?.children) && model.root.children.length > 0;
    const legendH = legendVisible ? 22 : 0;
    const plotW = Math.max(w - pad * 2, 10);
    const plotH = Math.max(h - pad * 2 - crumbH - noteH - legendH, 10);

    // 第1階層の色はルート直下の並び順で決める（掘り下げても色が変わらないように、
    // 掘り下げ先の親の色を引き継ぐ）
    const rootColorIndex = useMemo(() => {
        const m = new Map();
        if (!model.error && Array.isArray(model.root.children)) {
            model.root.children.forEach((c, i) => m.set(c.name, i));
        }
        return m;
    }, [model]);

    const tiles = useMemo(() => {
        if (model.error || !drill.node) return [];
        const out = [];
        const budget = { remaining: opts.maxTiles };
        // 掘り下げ中は、その枝がルートで持っていた色を全体に使う
        const baseIdx = drill.path.length > 0 ? rootColorIndex.get(drill.path[0]) ?? 0 : null;
        const colorIdxOf = (name) => (baseIdx !== null ? baseIdx : rootColorIndex.get(name) ?? 0);
        layoutTiles(
            drill.node,
            // 原点は SVG のローカル座標。パンくずは SVG の外にあるので加算しない。
            { x: pad, y: pad, w: plotW, h: plotH },
            opts,
            1,
            opts.maxDepth,
            colorIdxOf,
            out,
            budget
        );
        return out;
    }, [model, drill, opts, plotW, plotH, pad, rootColorIndex]);

    const progress = useFadeProgress(signature, opts.animate && tiles.length <= MAX_ANIMATED_TILES);

    // --- ガード（フックはすべて呼び終えてから return する） ---
    if (loading) {
        return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WaitSpinner size="medium" />
            </div>
        );
    }
    if (!rawData || rows.length === 0 || model.error === 'empty') {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }
    if (model.error === 'novalue') {
        return <CenterMessage>正の数値データが見つかりません。値フィールドの選択を確認してください。</CenterMessage>;
    }
    if (model.error === 'nolevel') {
        return <CenterMessage>階層フィールドが見つかりません。階層フィールドの選択を確認してください。</CenterMessage>;
    }

    const shownTotal = drill.node.value;
    const grandTotal = model.root.value;

    // タイルの塗り色（深さで濃淡をつけて階層を示す）
    const fillOf = (t) => {
        const base = opts.palette[(t.colorIdx ?? 0) % opts.palette.length];
        if (!opts.shadeChildren) return base;
        // 親（グループ）は暗め、葉は基準色寄り。dark/light で寄せる向きを変える。
        const dir = mode === 'dark' ? -1 : 1;
        if (!t.isLeaf) return shiftColor(base, dir * 0.45);
        const step = clamp((t.depth - 1) * 0.16, 0, 0.5);
        return shiftColor(base, -dir * step);
    };

    const ease = (e) => 1 - Math.pow(1 - e, 3);
    const tileOpacity = (t, i) => {
        if (progress >= 1) return 1;
        const delay = (i / Math.max(tiles.length, 1)) * 0.4;
        return ease(clamp01((progress - delay) / 0.6));
    };

    const pctOf = (v) => {
        if (!(grandTotal > 0)) return '';
        const p = (v / grandTotal) * 100;
        return `${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%`;
    };

    // タイルの読み上げ用テキスト（自前ツールチップと重ならないよう aria-label に使う）
    const ariaOf = (t) =>
        `${Array.isArray(t.node.path) && t.node.path.length > 0 ? t.node.path.join(' › ') : t.node.name}: ` +
        `${fmtValue(t.node.value, opts.valueDecimals, false)}` +
        `${grandTotal > 0 ? `（全体の ${pctOf(t.node.value)}）` : ''}`;

    // 掘り下げ可能か（集約タイル「その他」と葉は不可）。
    // tipDataOf から参照するので先に宣言しておく。
    const canDrill = (t) =>
        opts.enableDrilldown &&
        !t.node.isOther &&
        Array.isArray(t.node.children) &&
        t.node.children.length > 0 &&
        Array.isArray(t.node.path);

    // ツールチップの中身（見出し＋明細行）。<title> と違い即座に出る。
    const tipDataOf = (t) => {
        const n = t.node;
        const rows = [];
        rows.push([model.valueName, fmtValue(n.value, opts.valueDecimals, opts.abbreviateValue)]);
        if (grandTotal > 0) rows.push(['全体比', pctOf(n.value)]);
        if (shownTotal > 0 && shownTotal !== grandTotal) {
            const p = (n.value / shownTotal) * 100;
            rows.push(['表示範囲比', `${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%`]);
        }
        const kidCount = Array.isArray(n.children) ? n.children.length : 0;
        if (kidCount > 0) rows.push(['内訳', `${kidCount} 件`]);
        return {
            // 階層のパスを見出しに出す（どの枝の話かが一目で分かる）
            crumb: Array.isArray(n.path) && n.path.length > 0 ? n.path.join(' › ') : n.name,
            rows,
            hint: canDrill(t) ? 'クリックで掘り下げ' : '',
        };
    };

    const onTileClick = (t) => {
        if (!canDrill(t)) return;
        applyDrill(t.node.path.join(PATH_SEP));
    };

    const crumbs = [
        { label: '全体', path: '' },
        ...drill.path.map((p, i) => ({ label: p, path: drill.path.slice(0, i + 1).join(PATH_SEP) })),
    ];

    const notes = [];
    if (model.negatives > 0) notes.push(`※ 負の値 ${model.negatives} 行は面積で表せないため除外`);
    if (model.skipped > 0) notes.push(`※ 数値でない ${model.skipped} 行を除外`);

    // 凡例は第1階層（ルート直下）の並びで出す
    const legendItems = Array.isArray(model.root.children) ? model.root.children.slice(0, 12) : [];

    // ホバー中のタイル（キーは描画側と同じ規則で組み立てる）
    const keyOfTile = (t, i) => `${t.depth}:${t.node.path ? t.node.path.join('/') : t.node.name}:${i}`;
    const hoveredTile = hoverKey === null ? null : tiles.find((t, i) => keyOfTile(t, i) === hoverKey) || null;
    const tip = hoveredTile && hoverPos ? tipDataOf(hoveredTile) : null;

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                fontFamily: FONT_STACK,
            }}
        >
            {/* パンくずリスト */}
            {crumbH > 0 && (
                <div
                    style={{
                        flex: 'none',
                        height: crumbH,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: `0 ${pad}px`,
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                    }}
                >
                    {crumbs.map((c, i) => {
                        const isLast = i === crumbs.length - 1;
                        return (
                            <span key={`${c.path}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                {i > 0 && <span style={{ color: pal.faintText, fontSize: 11, flex: 'none' }}>›</span>}
                                <button
                                    type="button"
                                    data-role="tm-crumb"
                                    data-path={c.path}
                                    onClick={() => applyDrill(c.path)}
                                    disabled={isLast}
                                    title={c.label}
                                    style={{
                                        border: 'none',
                                        background: isLast ? pal.crumbBg : 'transparent',
                                        color: isLast ? pal.crumbActive : pal.crumbText,
                                        fontFamily: 'inherit',
                                        fontSize: 11,
                                        fontWeight: isLast ? 600 : 400,
                                        padding: '2px 6px',
                                        borderRadius: 3,
                                        cursor: isLast ? 'default' : 'pointer',
                                        maxWidth: 160,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {c.label}
                                </button>
                            </span>
                        );
                    })}
                    <span
                        data-role="tm-total"
                        style={{
                            marginLeft: 'auto',
                            flex: 'none',
                            fontSize: 11,
                            color: pal.subText,
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {fmtValue(shownTotal, opts.valueDecimals, opts.abbreviateValue)}
                        {shownTotal !== grandTotal ? `（全体の ${pctOf(shownTotal)}）` : ''}
                    </span>
                </div>
            )}

            {/* 本体 */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <svg width={w} height={Math.max(plotH + pad * 2, 10)} style={{ display: 'block' }}>
                    {tiles.map((t, i) => {
                        const gap = opts.tileGap;
                        // 親タイルは枠として使うので、葉だけ内側に余白を入れる
                        const inset = t.isLeaf ? gap / 2 : 0;
                        const rw = Math.max(t.w - inset * 2, 0.5);
                        const rh = Math.max(t.h - inset * 2, 0.5);
                        // 入れ子の同心円状の角丸: 内側ほど半径を少し小さくすると、
                        // 親の丸みと子の丸みが平行に見えて「切れている」感じが出ない。
                        const depthRadius = Math.max(opts.tileRadius - (t.depth - 1), 1);
                        const rx = Math.min(
                            t.isLeaf ? depthRadius : opts.tileRadius,
                            Math.min(rw, rh) / 2
                        );
                        const fill = fillOf(t);
                        const op = tileOpacity(t, i);
                        const key = keyOfTile(t, i);
                        const drillable = canDrill(t);
                        const hovered = hoverKey === key;

                        // ラベルは葉タイルの中、グループは見出し帯に出す。
                        // 「入らなければ即あきらめる」のではなく、フォントを縮める →
                        // 値を落とす → 名前を … で詰める、の順に段階退避させて
                        // できるだけ何かが読める状態を保つ。
                        const nameStr = t.node.name;
                        const valStr = fmtValue(t.node.value, opts.valueDecimals, opts.abbreviateValue);
                        const pctStr = opts.showPercent ? pctOf(t.node.value) : '';
                        const metaStr = [opts.showValues ? valStr : '', pctStr].filter(Boolean).join('  ');

                        const labelPadX = 6; // 左右の内側余白（テキストが縁に触れないように）
                        const availTextW = rw - labelPadX * 2;
                        // 高さから決まる上限と、幅から決まる上限の小さい方を採る
                        const fontByH = Math.min(rh * 0.34, 13);
                        const nameUnit = Math.max(estimateTextWidth(nameStr, 1), 0.001);
                        // 最低でも 3 文字ぶんは読めるサイズまでしか縮めない
                        const fontByW = availTextW / Math.min(nameUnit, estimateTextWidth(nameStr.slice(0, 3), 1) * 2.2);
                        const labelFont = Math.floor(clamp(Math.min(fontByH, fontByW), 8, 13));
                        const valueFont = Math.max(labelFont - 2, 8);

                        const canName = opts.showLabels && availTextW >= 14 && rh >= labelFont + 5;
                        // 値は「名前と2行ぶんの高さが取れて、かつ横幅に収まる」ときだけ出す
                        const canMeta =
                            canName &&
                            metaStr &&
                            rh >= labelFont + valueFont + 7 &&
                            estimateTextWidth(metaStr, valueFont) <= availTextW;

                        return (
                            <g
                                key={key}
                                data-role="tm-tile-group"
                                onClick={() => onTileClick(t)}
                                onMouseMove={(evt) => {
                                    // 座標はハンドラ本体で確定させる（setState の更新関数内で
                                    // 合成イベントを読むと再利用後に null になる）
                                    const host = containerRef.current;
                                    const r = host && host.getBoundingClientRect
                                        ? host.getBoundingClientRect()
                                        : { left: 0, top: 0 };
                                    const px = evt.clientX - r.left;
                                    const py = evt.clientY - r.top;
                                    setHoverKey(key);
                                    setHoverPos({ x: px, y: py });
                                }}
                                onMouseLeave={() => {
                                    setHoverKey((k) => (k === key ? null : k));
                                    setHoverPos(null);
                                }}
                                style={{ cursor: drillable ? 'pointer' : 'default' }}
                            >
                                <rect
                                    data-role="tm-tile"
                                    data-depth={t.depth}
                                    data-leaf={t.isLeaf ? '1' : '0'}
                                    data-name={t.node.name}
                                    x={t.x + inset}
                                    y={t.y + inset}
                                    width={rw}
                                    height={rh}
                                    rx={rx}
                                    fill={fill}
                                    stroke={pal.tileStroke}
                                    strokeWidth={t.isLeaf ? 0.75 : 1}
                                    opacity={op}
                                />
                                {/* ホバー中の枝を明示（掘り下げ可能なものだけ） */}
                                {hovered && drillable && (
                                    <rect
                                        data-role="tm-tile-hover"
                                        x={t.x + inset}
                                        y={t.y + inset}
                                        width={rw}
                                        height={rh}
                                        rx={rx}
                                        fill="none"
                                        stroke={pal.crumbActive}
                                        strokeWidth={1.5}
                                        style={{ pointerEvents: 'none' }}
                                    />
                                )}

                                {/* グループ見出し */}
                                {t.hasHeader && opts.showLabels && (
                                    <text
                                        data-role="tm-header"
                                        x={t.x + 6}
                                        y={t.y + HEADER_H * 0.5 + 4.5}
                                        fontSize={11}
                                        fontWeight={600}
                                        fill={luminanceOf(fill) > 0.55 ? pal.tileTextDark : pal.tileTextLight}
                                        opacity={op}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {(() => {
                                            // 見出しは x+6 から始まるので、右にも同じだけ余白を残す
                                            const headW = t.w - 12;
                                            const withVal = `${nameStr}  ${valStr}`;
                                            // 名前＋値が入らないなら値を捨てて名前を優先する
                                            if (opts.showValues && estimateTextWidth(withVal, 11) <= headW) {
                                                return withVal;
                                            }
                                            return truncateToWidth(nameStr, 11, headW);
                                        })()}
                                    </text>
                                )}

                                {/* 葉タイルのラベル */}
                                {t.isLeaf && canName && (
                                    <text
                                        data-role="tm-label"
                                        x={t.x + inset + rw / 2}
                                        y={t.y + inset + (canMeta ? rh / 2 - 2 : rh / 2 + labelFont * 0.35)}
                                        textAnchor="middle"
                                        fontSize={labelFont}
                                        fontWeight={500}
                                        fill={luminanceOf(fill) > 0.55 ? pal.tileTextDark : pal.tileTextLight}
                                        opacity={op}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {truncateToWidth(nameStr, labelFont, availTextW)}
                                    </text>
                                )}
                                {t.isLeaf && canName && canMeta && (
                                    <text
                                        data-role="tm-value"
                                        x={t.x + inset + rw / 2}
                                        y={t.y + inset + rh / 2 + valueFont + 1}
                                        textAnchor="middle"
                                        fontSize={valueFont}
                                        fill={luminanceOf(fill) > 0.55 ? pal.tileTextDark : pal.tileTextLight}
                                        opacity={op * 0.85}
                                        style={{ pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        {metaStr}
                                    </text>
                                )}

                                <desc>{ariaOf(t)}</desc>
                            </g>
                        );
                    })}
                </svg>
            </div>

            {/* 凡例（第1階層） */}
            {opts.showLegend && legendItems.length > 0 && (
                <div
                    style={{
                        flex: 'none',
                        height: 22,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: `0 ${pad}px`,
                        overflowX: 'auto',
                        overflowY: 'hidden',
                        boxSizing: 'border-box',
                    }}
                >
                    {legendItems.map((c, i) => (
                        <span
                            key={c.name}
                            data-role="tm-legend-item"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}
                        >
                            <span
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: 2,
                                    background: opts.palette[i % opts.palette.length],
                                    flex: 'none',
                                }}
                            />
                            <span style={{ fontSize: 11, color: pal.subText, whiteSpace: 'nowrap' }}>{c.name}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* 注記 */}
            {noteH > 0 && (
                <div
                    data-role="tm-note"
                    style={{
                        flex: 'none',
                        height: noteH,
                        padding: `0 ${pad}px`,
                        fontSize: 10,
                        lineHeight: `${noteH}px`,
                        color: pal.subText,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        boxSizing: 'border-box',
                    }}
                >
                    {notes.join('　')}
                </div>
            )}

            {/* ホバー時のツールチップ（カーソル追従・パネル端で折り返す） */}
            {tip && (
                (() => {
                    // 中身から実寸を見積もり、右端・下端で見切れないよう反対側へ寄せる
                    const tipFont = 11;
                    const labelW = tip.rows.reduce((m, [k]) => Math.max(m, estimateTextWidth(k, tipFont)), 0);
                    const valueW = tip.rows.reduce((m, [, v]) => Math.max(m, estimateTextWidth(v, tipFont)), 0);
                    const crumbW = estimateTextWidth(tip.crumb, tipFont + 1);
                    const hintW = tip.hint ? estimateTextWidth(tip.hint, 10) : 0;
                    const innerW = Math.max(labelW + valueW + 14, crumbW, hintW);
                    const tipW = clamp(Math.ceil(innerW) + 20, 90, Math.max(w - 16, 90));
                    const tipH = 26 + tip.rows.length * 16 + (tip.hint ? 16 : 0);

                    const OFFSET = 14;
                    let tx = hoverPos.x + OFFSET;
                    if (tx + tipW > w - 4) tx = hoverPos.x - OFFSET - tipW; // 右端 → 左へ
                    tx = clamp(tx, 4, Math.max(w - tipW - 4, 4));
                    let ty = hoverPos.y + OFFSET;
                    if (ty + tipH > h - 4) ty = hoverPos.y - OFFSET - tipH; // 下端 → 上へ
                    ty = clamp(ty, 4, Math.max(h - tipH - 4, 4));

                    return (
                        <div
                            data-role="tm-tooltip"
                            style={{
                                position: 'absolute',
                                left: tx,
                                top: ty,
                                width: tipW,
                                boxSizing: 'border-box',
                                padding: '6px 10px 7px',
                                background: pal.panelBg,
                                border: `1px solid ${pal.panelBorder}`,
                                borderRadius: 5,
                                boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
                                pointerEvents: 'none',
                                zIndex: 30,
                            }}
                        >
                            <div
                                data-role="tm-tooltip-title"
                                style={{
                                    fontSize: tipFont + 1,
                                    fontWeight: 600,
                                    color: pal.text,
                                    marginBottom: 4,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {tip.crumb}
                            </div>
                            {tip.rows.map(([k, v]) => (
                                <div
                                    key={k}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        gap: 12,
                                        fontSize: tipFont,
                                        lineHeight: '16px',
                                        color: pal.subText,
                                    }}
                                >
                                    <span>{k}</span>
                                    <span style={{ color: pal.text, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
                                </div>
                            ))}
                            {tip.hint && (
                                <div style={{ fontSize: 10, lineHeight: '16px', color: pal.faintText }}>{tip.hint}</div>
                            )}
                        </div>
                    );
                })()
            )}

            {/* デバッグ */}
            {opts.debug && (
                <pre
                    style={{
                        position: 'absolute',
                        right: 8,
                        bottom: 8,
                        maxWidth: '60%',
                        maxHeight: '60%',
                        overflow: 'auto',
                        margin: 0,
                        padding: 8,
                        fontSize: 10,
                        lineHeight: 1.3,
                        background: pal.panelBg,
                        color: pal.subText,
                        border: `1px solid ${pal.panelBorder}`,
                        borderRadius: 6,
                        zIndex: 20,
                    }}
                >
                    {JSON.stringify(
                        {
                            version: VIZ_VERSION,
                            fields: fieldNames,
                            usedIdx: model.usedIdx,
                            levelNames: model.levelNames,
                            valueName: model.valueName,
                            drillPath: drill.path,
                            tiles: tiles.length,
                            grandTotal,
                            shownTotal,
                            negatives: model.negatives,
                            skipped: model.skipped,
                            options,
                            normalized: opts,
                        },
                        null,
                        1
                    )}
                </pre>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（テーマガード必須）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <Treemap mode={mode} />
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
