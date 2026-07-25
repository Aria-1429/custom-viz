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
// Sunburst（サンバースト）
//
// 階層構造を同心円の輪で表す放射状チャート。
// 中心が根、外側へ向かうほど下の階層になり、扇形の角度が値の大きさを表す。
//
// Treemap が「面積の大小」を比べるのに向くのに対し、こちらは
// 「どこで枝分かれしているか」という階層の構造そのものが読みやすい。
// 同じ親から出た子は必ず親の角度範囲に収まるため、包含関係が一目で分かる。
//
// データモデル:
//   階層ラベル列（何列でも可・最大16）+ 数値列
//     例: | stats count by index, sourcetype, host
//     例: | stats sum(bytes) as bytes by dept, team, user
//   列の明示選択（editor.columnSelector）は自動判定より優先（明示は4つまで）。
//   同じ組み合わせの行は合算する。
//
// 「一度に表示する輪の数」(maxDepth) は見た目の密度を決めるだけで、
// データの深さは制限しない。輪の上限に当たった枝もクリックすれば
// さらに掘り下げられるので、何階層でも辿っていける。
//
// 扇形をクリックするとその枝を中心に据えて拡大する（ドリルダウン）。
// 現在位置はパンくずリストと中央の見出しに出し、中央をクリックすると1つ戻る。
// 掘り下げ位置は drillPath オプションに保存され、編集→保存で永続化できる。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 値（角度）フィールド（'' = 自動）
    level1Field: '', // 第1階層フィールド（内側の輪）
    level2Field: '',
    level3Field: '',
    level4Field: '', // 第4階層フィールド（外側の輪）

    fadeChildren: true, // 外側の輪ほど淡くする

    maxDepth: 3, // 一度に表示する輪の数（掘り下げ位置からの相対。データの深さは制限しない）
    maxSlices: 400, // 扇形の最大数
    minAnglePercent: 0.3, // これ未満の角度（％）は「その他」へ集約
    innerRadiusPercent: 22, // 中心の空き半径（％）
    ringGap: 1, // 輪どうしの間隔（px）
    sliceGap: 0.4, // 扇形どうしの間隔（度）
    cornerRadius: 2, // 扇形の角丸（px）

    dimOthers: true, // ホバー中、その系統以外の扇形を暗くする
    showLabels: true, // 扇形にラベルを表示
    showCenter: true, // 中央に合計を表示
    centerTitle: '', // 中央の見出し（空欄=自動）
    showBreadcrumb: true, // パンくずリストを表示
    showLegend: false, // 凡例を表示
    enableDrilldown: true, // クリックで掘り下げる
    animate: true, // アニメーション

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: true, // 1.5M などの省略表記

    drillPath: '', // 掘り下げ位置
};

// 既定の扇形パレット（editor.seriesColors 未設定時のフォールバック）。
// 色覚特性（第2色覚）でも隣接色が潰れないよう色相を広く取っている。
const DEFAULT_COLORS = [
    '#4c9be8',
    '#26c2a5',
    '#f2b53c',
    '#f2653f',
    '#a97bf0',
    '#f75d97',
    '#5ed4f0',
    '#94a3b5',
];

// 階層フィールドのオプションキー（第1〜第4階層）
const LEVEL_KEYS = ['level1Field', 'level2Field', 'level3Field', 'level4Field'];
// ツリーが持てる階層の上限。編集画面で明示選択できるのは LEVEL_KEYS の4つまでだが、
// 自動判定ではサーチが返した非数値列をすべて階層として使うため、列数ぶんだけ深くなる。
// 「一度に表示する輪の数」(maxDepth) とは別物で、掘り下げはここまで辿れる。
const MAX_TREE_DEPTH = 16;

// drillPath の区切り（ラベルに現れない制御文字を使う）。
// ソースに生の制御文字を置くと grep がバイナリ扱いするのでエスケープで書く。
const PATH_SEP = '\u0001';

// ホバー時に系統外の扇形へ掛ける不透明度。
// 消しすぎると全体の構成が見えなくなるので、輪郭が残る程度に留める。
const DIM_OPACITY = 0.25;

// 描画上限
const MAX_SLICES_HARD = 3000;
// アニメーションを行う扇形数の上限（超過時は即時表示）
const MAX_ANIMATED_SLICES = 900;

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

// 色を白/黒側へ寄せる（外側の輪の淡さづけに使う）
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

// おおまかな相対輝度（0..1）。扇形内テキストの白黒切替に使う
function luminanceOf(cssColor) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(cssColor));
    const c = m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : hexToRgb(cssColor);
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
    const fieldOr = (v) => (typeof v === 'string' || Array.isArray(v) ? v : '');
    const strOr = (v, d) => (typeof v === 'string' ? v : d);

    const out = {
        valueField: fieldOr(o.valueField),
        level1Field: fieldOr(o.level1Field),
        level2Field: fieldOr(o.level2Field),
        level3Field: fieldOr(o.level3Field),
        level4Field: fieldOr(o.level4Field),

        fadeChildren: bool(o.fadeChildren, DEFAULTS.fadeChildren),

        // 「一度に見せる輪の数」。掘り下げ位置からの相対なので、深い階層も
        // クリックしていけば必ず到達できる（データの深さを制限するものではない）。
        maxDepth: clamp(Math.round(numOr(o.maxDepth, DEFAULTS.maxDepth)), 1, MAX_TREE_DEPTH),
        maxSlices: clamp(Math.round(numOr(o.maxSlices, DEFAULTS.maxSlices)), 1, MAX_SLICES_HARD),
        minAnglePercent: clamp(numOr(o.minAnglePercent, DEFAULTS.minAnglePercent), 0, 10),
        innerRadiusPercent: clamp(numOr(o.innerRadiusPercent, DEFAULTS.innerRadiusPercent), 0, 70),
        ringGap: clamp(numOr(o.ringGap, DEFAULTS.ringGap), 0, 12),
        sliceGap: clamp(numOr(o.sliceGap, DEFAULTS.sliceGap), 0, 5),
        cornerRadius: clamp(numOr(o.cornerRadius, DEFAULTS.cornerRadius), 0, 12),

        dimOthers: bool(o.dimOthers, DEFAULTS.dimOthers),
        showLabels: bool(o.showLabels, DEFAULTS.showLabels),
        showCenter: bool(o.showCenter, DEFAULTS.showCenter),
        centerTitle: strOr(o.centerTitle, ''),
        showBreadcrumb: bool(o.showBreadcrumb, DEFAULTS.showBreadcrumb),
        showLegend: bool(o.showLegend, DEFAULTS.showLegend),
        enableDrilldown: bool(o.enableDrilldown, DEFAULTS.enableDrilldown),
        animate: bool(o.animate, DEFAULTS.animate),

        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),

        drillPath: strOr(o.drillPath, ''),
    };

    // editor.seriesColors は hex 文字列の配列を生で渡してくる。
    // 要素数はユーザーが増減できるため、既定色より短くても長くても壊れないようにする
    // （描画側は % length で循環させる）。
    // ※ 旧 color1..color8 は意図的に読まない。既定値と同じ値は options に載らないため、
    //   旧キーへフォールバックすると「既定値を選んだときだけ直らない」不具合になる。
    const palette = Array.isArray(o.seriesColors)
        ? o.seriesColors.filter((c) => typeof c === 'string' && hexToRgb(c.trim()))
        : [];
    out.palette = palette.length > 0 ? palette.map((c) => c.trim()) : DEFAULT_COLORS.slice();
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
            if (levelIdx.length >= MAX_TREE_DEPTH) break;
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
    levelIdx = levelIdx.slice(0, MAX_TREE_DEPTH);

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
        // 角度は負値を表現できない。落とさず件数だけ数えて注記する。
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

    // Map を配列へ（値の降順）。扇形も大きい順に並べたほうが読みやすい。
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

// 細すぎる扇形・数が多すぎる枝を「その他」へ集約する。
// サンバーストは扇形が細くなるとクリックもホバーもできない“ゴミ”になるので、
// 角度ベースの下限（minAngleRatio）が実用上いちばん効く。
function foldSmall(nodes, parentValue, minAngleRatio, cap) {
    if (!Array.isArray(nodes) || nodes.length === 0) return { list: [], folded: 0 };
    const keep = [];
    const rest = [];
    for (const n of nodes) {
        const ratio = parentValue > 0 ? n.value / parentValue : 0;
        if (ratio >= minAngleRatio && keep.length < cap) keep.push(n);
        else rest.push(n);
    }
    if (rest.length === 0) return { list: keep, folded: 0 };
    const restSum = rest.reduce((s, n) => s + n.value, 0);
    if (restSum <= 0) return { list: keep, folded: rest.length };
    // 集約が1件だけなら、わざわざ「その他」にせずそのまま出す
    if (rest.length === 1) return { list: [...keep, rest[0]], folded: 0 };
    return {
        list: [
            ...keep,
            {
                name: `その他（${rest.length}件）`,
                value: restSum,
                children: [],
                depth: rest[0].depth,
                path: null, // 集約は掘り下げ不可
                isOther: true,
            },
        ],
        folded: rest.length,
    };
}

// ---------------------------------------------------------------------------
// 放射レイアウト（角度は値に比例、半径は階層の深さ）
// ---------------------------------------------------------------------------

function layoutSlices(node, opts, depth, maxDepth, a0, a1, colorIdxOf, out, budget) {
    if (depth > maxDepth || budget.remaining <= 0) return;
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length === 0) return;

    const { list } = foldSmall(kids, node.value, opts.minAnglePercent / 100, budget.remaining);
    const total = list.reduce((s, n) => s + n.value, 0);
    if (!(total > 0)) return;

    const span = a1 - a0;
    let cur = a0;
    for (const kid of list) {
        if (budget.remaining <= 0) return;
        const frac = kid.value / total;
        const kidA0 = cur;
        const kidA1 = cur + span * frac;
        cur = kidA1;

        const colorIdx = colorIdxOf(kid.name);
        budget.remaining -= 1;
        out.push({
            node: kid,
            depth,
            a0: kidA0,
            a1: kidA1,
            colorIdx,
        });

        // 子は親の角度範囲の中に必ず収まる（包含関係が視覚的に保証される）
        layoutSlices(kid, opts, depth + 1, maxDepth, kidA0, kidA1, () => colorIdx, out, budget);
    }
}

// 扇環（ドーナツの一部）のパスを作る。角丸は半径方向の端を丸める簡易版。
function arcPath(cx, cy, r0, r1, a0, a1, corner) {
    const sweep = a1 - a0;
    if (!(sweep > 0) || r1 <= r0) return '';
    // ほぼ全周のときは2つの弧に分けないと SVG の弧が閉じない
    const full = sweep >= Math.PI * 2 - 1e-6;
    if (full) {
        const m = a0 + Math.PI;
        return [
            `M ${cx + r1 * Math.cos(a0)} ${cy + r1 * Math.sin(a0)}`,
            `A ${r1} ${r1} 0 0 1 ${cx + r1 * Math.cos(m)} ${cy + r1 * Math.sin(m)}`,
            `A ${r1} ${r1} 0 0 1 ${cx + r1 * Math.cos(a0)} ${cy + r1 * Math.sin(a0)}`,
            `M ${cx + r0 * Math.cos(a0)} ${cy + r0 * Math.sin(a0)}`,
            `A ${r0} ${r0} 0 0 0 ${cx + r0 * Math.cos(m)} ${cy + r0 * Math.sin(m)}`,
            `A ${r0} ${r0} 0 0 0 ${cx + r0 * Math.cos(a0)} ${cy + r0 * Math.sin(a0)}`,
            'Z',
        ].join(' ');
    }

    const large = sweep > Math.PI ? 1 : 0;
    const P = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;

    // 角丸なし（既定に近い経路）。4隅を素直に結ぶ。
    const square = () =>
        [
            `M ${P(r0, a0)}`,
            `L ${P(r1, a0)}`,
            `A ${r1} ${r1} 0 ${large} 1 ${P(r1, a1)}`,
            `L ${P(r0, a1)}`,
            r0 > 0 ? `A ${r0} ${r0} 0 ${large} 0 ${P(r0, a0)}` : `L ${cx} ${cy}`,
            'Z',
        ].join(' ');

    // 角丸は「輪の厚み」と「内側の弧の長さ」の両方に収まる範囲でしか付けられない。
    // 内側の弧（r0 側）がいちばん短いので、そこを基準にする。
    const thick = r1 - r0;
    const innerArc = r0 > 0 ? sweep * r0 : sweep * r1;
    const c = Math.min(corner, thick / 2, innerArc / 2);
    if (!(c > 0.3)) return square();

    // 半径方向のオフセットは c そのもの、角度方向のオフセットは c を弧長として角度に直す。
    // ここを取り違えて「半径方向にずらした点」と「角度方向にずらした点」を直線で
    // 結ぶと、扇形の内側の角がえぐれて隙間に見える（v1.0.0 の不具合）。
    const aOut = c / r1; // 外周での角度オフセット
    const aIn = r0 > 0 ? c / r0 : 0; // 内周での角度オフセット
    // オフセットが扇形の角度幅を食い尽くす場合は角丸を諦める
    if (a0 + aOut >= a1 - aOut || (r0 > 0 && a0 + aIn >= a1 - aIn)) return square();

    // 各隅で「半径方向に c」「角度方向に c 相当」の2点を二次ベジェで結ぶ。
    // 制御点は隅そのものなので、丸みが隅の内側に収まる。
    const parts = [
        `M ${P(r0 + c, a0)}`, // 内側・始端（半径方向に c 内寄り）
        `L ${P(r1 - c, a0)}`, // 半径方向の辺
        `Q ${P(r1, a0)} ${P(r1, a0 + aOut)}`, // 外側・始端の角丸
        `A ${r1} ${r1} 0 ${large} 1 ${P(r1, a1 - aOut)}`, // 外周の弧
        `Q ${P(r1, a1)} ${P(r1 - c, a1)}`, // 外側・終端の角丸
        `L ${P(r0 + c, a1)}`, // 反対側の半径方向の辺
    ];
    if (r0 > 0) {
        parts.push(
            `Q ${P(r0, a1)} ${P(r0, a1 - aIn)}`, // 内側・終端の角丸
            `A ${r0} ${r0} 0 ${large} 0 ${P(r0, a0 + aIn)}`, // 内周の弧（逆回り）
            `Q ${P(r0, a0)} ${P(r0 + c, a0)}` // 内側・始端の角丸
        );
    } else {
        // 中心まで届く扇形は内周が無いので中心へ集める
        parts.push(`L ${cx} ${cy}`, `L ${P(r0 + c, a0)}`);
    }
    parts.push('Z');
    return parts.join(' ');
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
            sliceStroke: 'rgba(13,16,20,0.55)',
            sliceTextDark: '#12161a',
            sliceTextLight: '#f5f7fa',
            centerBg: 'rgba(139,152,165,0.06)',
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
        sliceStroke: 'rgba(255,255,255,0.8)',
        sliceTextDark: '#12161a',
        sliceTextLight: '#f5f7fa',
        centerBg: 'rgba(92,103,115,0.05)',
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
// アニメーション（データ・掘り下げ位置が変わったら 0→1 を再生）
// ---------------------------------------------------------------------------

function useFadeProgress(signature, enabled) {
    const [progress, setProgress] = useState(enabled ? 0 : 1);

    useEffect(() => {
        if (!enabled || typeof requestAnimationFrame === 'undefined') {
            setProgress(1);
            return undefined;
        }
        setProgress(0);
        const dur = 650;
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

function Sunburst({ mode }) {
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
    const [dims, setDims] = useState({ w: 560, h: 460 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 560;
        const h = el.clientHeight || 460;
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

    const signature = useMemo(
        () => (model.error ? '' : `${dataKey}:${drill.path.join('/')}:${opts.maxDepth}`),
        [model, dataKey, drill.path, opts.maxDepth]
    );

    const { w, h } = dims;
    const pal = chartColors(mode);
    const pad = 8;

    // --- レイアウト（フックの前に return しないよう、ガードより先に済ませる） ---
    const crumbH = !model.error && opts.showBreadcrumb ? 22 : 0;
    const noteH = !model.error && (model.negatives > 0 || model.skipped > 0) ? 15 : 0;
    const legendVisible =
        !model.error && opts.showLegend && Array.isArray(model.root?.children) && model.root.children.length > 0;
    const legendH = legendVisible ? 22 : 0;
    const plotW = Math.max(w - pad * 2, 10);
    const plotH = Math.max(h - pad * 2 - crumbH - noteH - legendH, 10);

    // 第1階層の色はルート直下の並び順で決める（掘り下げても枝の色が変わらないように）
    const rootColorIndex = useMemo(() => {
        const m = new Map();
        if (!model.error && Array.isArray(model.root.children)) {
            model.root.children.forEach((c, i) => m.set(c.name, i));
        }
        return m;
    }, [model]);

    const slices = useMemo(() => {
        if (model.error || !drill.node) return [];
        const out = [];
        const budget = { remaining: opts.maxSlices };
        // 掘り下げ中は、その枝がルートで持っていた色を全体に使う
        const baseIdx = drill.path.length > 0 ? rootColorIndex.get(drill.path[0]) ?? 0 : null;
        const colorIdxOf = (name) => (baseIdx !== null ? baseIdx : rootColorIndex.get(name) ?? 0);
        // -90度から開始（真上が起点）
        layoutSlices(drill.node, opts, 1, opts.maxDepth, -Math.PI / 2, Math.PI * 1.5, colorIdxOf, out, budget);
        return out;
    }, [model, drill, opts, rootColorIndex]);

    const progress = useFadeProgress(signature, opts.animate && slices.length <= MAX_ANIMATED_SLICES);

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

    // --- 円の幾何 ---
    const cx = pad + plotW / 2;
    const cy = pad + plotH / 2;
    const outerR = Math.max(Math.min(plotW, plotH) / 2 - 2, 8);
    const innerR = (outerR * opts.innerRadiusPercent) / 100;
    // 実際に描く階層数（データの深さと maxDepth の小さい方）
    const usedDepth = slices.reduce((m, s) => Math.max(m, s.depth), 0) || 1;
    const ringSpan = Math.max((outerR - innerR) / usedDepth, 1);

    const radiusOf = (depth) => {
        const r0 = innerR + ringSpan * (depth - 1);
        const r1 = r0 + ringSpan - opts.ringGap;
        return { r0, r1: Math.max(r1, r0 + 0.5) };
    };

    const ease = (t) => 1 - Math.pow(1 - t, 3);
    // アニメーションは「中心から外へ広がる」向きに見せる
    const sliceProgress = (s) => {
        if (progress >= 1) return 1;
        const delay = ((s.depth - 1) / Math.max(usedDepth, 1)) * 0.45;
        return ease(clamp01((progress - delay) / 0.55));
    };

    const fillOf = (s) => {
        const base = opts.palette[(s.colorIdx ?? 0) % opts.palette.length];
        if (!opts.fadeChildren) return base;
        // 外側の輪ほど淡く（dark は白側、light は黒側へ寄せる）
        const dir = mode === 'dark' ? 1 : -1;
        const step = clamp((s.depth - 1) * 0.16, 0, 0.55);
        return shiftColor(base, dir * step);
    };

    const pctOf = (v) => {
        if (!(grandTotal > 0)) return '';
        const p = (v / grandTotal) * 100;
        return `${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%`;
    };

    // 掘り下げ可能か（集約「その他」と葉は不可）
    const canDrill = (s) =>
        opts.enableDrilldown &&
        !s.node.isOther &&
        Array.isArray(s.node.children) &&
        s.node.children.length > 0 &&
        Array.isArray(s.node.path);

    const onSliceClick = (s) => {
        if (!canDrill(s)) return;
        applyDrill(s.node.path.join(PATH_SEP));
    };

    // 中央クリックで1つ戻る
    const onCenterClick = () => {
        if (!opts.enableDrilldown || drill.path.length === 0) return;
        applyDrill(drill.path.slice(0, -1).join(PATH_SEP));
    };

    const keyOfSlice = (s, i) => `${s.depth}:${s.node.path ? s.node.path.join('/') : s.node.name}:${i}`;
    const hoveredSlice = hoverKey === null ? null : slices.find((s, i) => keyOfSlice(s, i) === hoverKey) || null;

    const tipDataOf = (s) => {
        const n = s.node;
        const rows2 = [];
        rows2.push([model.valueName, fmtValue(n.value, opts.valueDecimals, opts.abbreviateValue)]);
        if (grandTotal > 0) rows2.push(['全体比', pctOf(n.value)]);
        if (shownTotal > 0 && shownTotal !== grandTotal) {
            const p = (n.value / shownTotal) * 100;
            rows2.push(['表示範囲比', `${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%`]);
        }
        const kidCount = Array.isArray(n.children) ? n.children.length : 0;
        if (kidCount > 0) rows2.push(['内訳', `${kidCount} 件`]);
        return {
            crumb: Array.isArray(n.path) && n.path.length > 0 ? n.path.join(' › ') : n.name,
            rows: rows2,
            hint: canDrill(s) ? 'クリックで掘り下げ' : '',
        };
    };
    const tip = hoveredSlice && hoverPos ? tipDataOf(hoveredSlice) : null;

    // ホバー中は「その枝の系統」だけを明るく残し、無関係な枝を暗くする。
    // 明るく残すのは 祖先（中心側の経路）＋自分＋子孫 の3つ。
    // 祖先を含めるのは、根からどう辿ってきた枝なのかを1本の帯として見せるため。
    // 集約タイル（その他）は path を持たないので、常に系統外＝暗くする。
    const hoverPath = hoveredSlice && Array.isArray(hoveredSlice.node.path) ? hoveredSlice.node.path : null;
    const isInHoverLineage = (s) => {
        if (!hoverPath) return true; // ホバーしていなければ全部そのまま
        const p = s.node.path;
        if (!Array.isArray(p)) return false;
        const n = Math.min(p.length, hoverPath.length);
        // 短い方の長さまで一致すれば、祖先・自分・子孫のいずれか
        for (let i = 0; i < n; i += 1) {
            if (p[i] !== hoverPath[i]) return false;
        }
        return true;
    };

    const crumbs = [
        { label: '全体', path: '' },
        ...drill.path.map((p, i) => ({ label: p, path: drill.path.slice(0, i + 1).join(PATH_SEP) })),
    ];

    const notes = [];
    if (model.negatives > 0) notes.push(`※ 負の値 ${model.negatives} 行は角度で表せないため除外`);
    if (model.skipped > 0) notes.push(`※ 数値でない ${model.skipped} 行を除外`);

    const legendItems = Array.isArray(model.root.children) ? model.root.children.slice(0, 12) : [];

    // 中央の見出し（明示指定 > 掘り下げ先の名前 > 階層名）
    const centerLabel =
        opts.centerTitle ||
        (drill.path.length > 0 ? drill.path[drill.path.length - 1] : model.levelNames[0] || '全体');

    const clearHover = () => {
        setHoverKey(null);
        setHoverPos(null);
    };

    const trackMouse = (evt, key) => {
        const host = containerRef.current;
        const r = host && host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
        setHoverKey(key);
        setHoverPos({ x: evt.clientX - r.left, y: evt.clientY - r.top });
    };

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
                                    data-role="sb-crumb"
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
                        data-role="sb-total"
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
                {/* 扇形ごとの onMouseLeave だけだと、扇形の外（円の余白や中心）へ
                    カーソルが抜けたときに減光が残る。SVG からの退出でも必ず解除する。
                    mouseleave はバブルせず React のルート委譲に届かないため mouseout も見る。 */}
                <svg
                    width={w}
                    height={Math.max(plotH + pad * 2, 10)}
                    style={{ display: 'block' }}
                    onMouseLeave={clearHover}
                    onMouseOut={(evt) => {
                        const to = evt.relatedTarget;
                        const svgEl = evt.currentTarget;
                        if (to && svgEl && typeof svgEl.contains === 'function' && svgEl.contains(to)) return;
                        clearHover();
                    }}
                >
                    {slices.map((s, i) => {
                        const key = keyOfSlice(s, i);
                        const { r0, r1 } = radiusOf(s.depth);
                        // 扇形どうしの隙間（度→ラジアン）。細い扇形では隙間を詰める
                        const gapRad = (opts.sliceGap * Math.PI) / 180;
                        const span = s.a1 - s.a0;
                        const g = Math.min(gapRad, span * 0.25);
                        const a0 = s.a0 + g / 2;
                        const a1 = s.a1 - g / 2;
                        if (!(a1 > a0)) return null;

                        const p = sliceProgress(s);
                        // 中心から外へ広がるアニメーション
                        const rr1 = r0 + (r1 - r0) * p;
                        const fill = fillOf(s);
                        const drillable = canDrill(s);
                        const hovered = hoverKey === key;
                        // 系統外は暗くする（オプションで無効化できる）
                        const inLineage = !opts.dimOthers || isInHoverLineage(s);

                        // ラベルは扇形の中央（角度・半径とも）に沿って置く
                        const mid = (a0 + a1) / 2;
                        const rMid = (r0 + r1) / 2;
                        const arcLen = (a1 - a0) * rMid;
                        const labelFont = clamp(Math.min(r1 - r0, 12), 9, 12);
                        // 弧の長さが足りないとラベルが読めないので出さない
                        const canLabel =
                            opts.showLabels && p >= 0.99 && arcLen >= labelFont * 2.2 && r1 - r0 >= labelFont + 2;
                        // 半径方向に書くか、円周方向に書くかを扇形の形で決める
                        const radial = arcLen < (r1 - r0) * 1.2;
                        let deg = (mid * 180) / Math.PI;
                        let labelMaxW;
                        if (radial) {
                            // 半径方向：左半分では上下が逆さになるので反転させる
                            const flip = deg > 90 && deg < 270;
                            deg = flip ? deg + 180 : deg;
                            labelMaxW = (r1 - r0) - 6;
                        } else {
                            deg = deg + 90;
                            const flip = deg > 90 && deg < 270;
                            deg = flip ? deg + 180 : deg;
                            labelMaxW = arcLen - 6;
                        }
                        const lx = cx + rMid * Math.cos(mid);
                        const ly = cy + rMid * Math.sin(mid);

                        return (
                            <g
                                key={key}
                                data-role="sb-slice-group"
                                onClick={() => onSliceClick(s)}
                                onMouseMove={(evt) => trackMouse(evt, key)}
                                onMouseLeave={() => {
                                    setHoverKey((k) => (k === key ? null : k));
                                    setHoverPos(null);
                                }}
                                style={{ cursor: drillable ? 'pointer' : 'default' }}
                            >
                                <path
                                    data-role="sb-slice"
                                    data-depth={s.depth}
                                    data-name={s.node.name}
                                    // 葉かどうかは「実際に子を持つか」で決める。
                                    // 表示上の輪の上限に当たっただけの枝は葉ではなく、
                                    // クリックすればさらに掘り下げられる。
                                    data-leaf={
                                        !Array.isArray(s.node.children) || s.node.children.length === 0 ? '1' : '0'
                                    }
                                    d={arcPath(cx, cy, r0, rr1, a0, a1, opts.cornerRadius)}
                                    fill={fill}
                                    stroke={hovered && drillable ? pal.crumbActive : pal.sliceStroke}
                                    strokeWidth={hovered && drillable ? 1.5 : 0.75}
                                    opacity={inLineage ? (hovered ? 1 : 0.95) : DIM_OPACITY}
                                />
                                {canLabel && (
                                    <text
                                        data-role="sb-label"
                                        x={lx}
                                        y={ly}
                                        transform={`rotate(${deg} ${lx} ${ly})`}
                                        textAnchor="middle"
                                        dominantBaseline="central"
                                        fontSize={labelFont}
                                        fontWeight={500}
                                        fill={luminanceOf(fill) > 0.55 ? pal.sliceTextDark : pal.sliceTextLight}
                                        // 扇形が暗くなったらラベルも一緒に引く（浮いて見えないように）
                                        opacity={inLineage ? 1 : DIM_OPACITY}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {truncateToWidth(s.node.name, labelFont, labelMaxW)}
                                    </text>
                                )}
                                <desc>
                                    {`${Array.isArray(s.node.path) && s.node.path.length > 0 ? s.node.path.join(' › ') : s.node.name}: ${fmtValue(s.node.value, opts.valueDecimals, false)}`}
                                </desc>
                            </g>
                        );
                    })}

                    {/* 中央の KPI（クリックで1つ戻る） */}
                    {opts.showCenter && innerR > 18 && (
                        <g
                            data-role="sb-center"
                            onClick={onCenterClick}
                            style={{ cursor: opts.enableDrilldown && drill.path.length > 0 ? 'pointer' : 'default' }}
                        >
                            <circle cx={cx} cy={cy} r={innerR - 2} fill={pal.centerBg} />
                            <text
                                data-role="sb-center-label"
                                x={cx}
                                y={cy - innerR * 0.24}
                                textAnchor="middle"
                                fontSize={clamp(innerR * 0.2, 9, 12)}
                                fill={pal.subText}
                            >
                                {truncateToWidth(centerLabel, clamp(innerR * 0.2, 9, 12), innerR * 1.7)}
                            </text>
                            <text
                                data-role="sb-center-value"
                                x={cx}
                                y={cy + innerR * 0.12}
                                textAnchor="middle"
                                fontSize={clamp(innerR * 0.42, 12, 30)}
                                fontWeight={600}
                                fill={pal.text}
                                style={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {fmtValue(shownTotal, opts.valueDecimals, opts.abbreviateValue)}
                            </text>
                            {drill.path.length > 0 && (
                                <text
                                    data-role="sb-center-back"
                                    x={cx}
                                    y={cy + innerR * 0.46}
                                    textAnchor="middle"
                                    fontSize={clamp(innerR * 0.16, 8, 10)}
                                    fill={pal.faintText}
                                >
                                    ← 戻る
                                </text>
                            )}
                        </g>
                    )}
                </svg>
            </div>

            {/* 凡例（第1階層） */}
            {legendVisible && (
                <div
                    style={{
                        flex: 'none',
                        height: legendH,
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
                            data-role="sb-legend-item"
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
                    data-role="sb-note"
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
            {tip &&
                (() => {
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
                    if (tx + tipW > w - 4) tx = hoverPos.x - OFFSET - tipW;
                    tx = clamp(tx, 4, Math.max(w - tipW - 4, 4));
                    let ty = hoverPos.y + OFFSET;
                    if (ty + tipH > h - 4) ty = hoverPos.y - OFFSET - tipH;
                    ty = clamp(ty, 4, Math.max(h - tipH - 4, 4));

                    return (
                        <div
                            data-role="sb-tooltip"
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
                                data-role="sb-tooltip-title"
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
                })()}
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
            <Sunburst mode={mode} />
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
