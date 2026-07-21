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
// Heat Matrix（ヒートマップ・マトリクス）
//
// 任意の2軸クロス集計を「色の行列」で表示する汎用ヒートマップ。
// `stats count by A B`（縦持ち）と `chart ... over A by B` / `timechart by`
// （クロス集計）の両形式を自動判別してそのまま描画できる。
// Splunk 標準にはドットサイズで表す punchcard しかなく、連続カラースケール・
// セル値表示・行/列ごとの色正規化・合計マージン・合計順ソートを備えた
// 本物のヒートマップは標準ビジュアライゼーションでは再現できない。
//
// データモデル:
//   縦持ち（tidy）  : 行ラベル列 + 列ラベル列 + 数値列（例: stats count by host, status）
//                     …2列目が非数値なら自動で縦持ちと判定。同一セルは合算。
//   クロス集計(matrix): 第1列 = 行ラベル、残りの数値列 = 横軸（例: chart/timechart の出力）
//   列の明示選択（editor.columnSelector）はどちらの形式でも自動判定より優先。
//   _time / ISO 日付のラベルは粒度に応じて自動整形（同日なら HH:MM 等）。
//
// 色は「値→low(→mid)→high の連続補間」を自前実装（editor.dynamicColor は
// カスタム viz では使えないため）。欠損セル（組み合わせにデータが無い）は
// 0 とは区別し、薄いニュートラル色で描画する。
// コンテナ実寸へ自動フィットし、行数が多いときは縦スクロール。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    rowField: '', // 行（縦軸）フィールド（'' = 自動）
    colField: '', // 列（横軸）フィールド（縦持ち時。'' = 自動）
    valueField: '', // 値フィールド（'' = 自動）

    lowColor: '#4575b4', // 低値の色
    midColor: '#fee08b', // 中間の色
    highColor: '#d73027', // 高値の色
    useMidColor: true, // 中間色を使う
    reverseScale: false, // 低⇔高を反転
    scaleMin: null, // スケール下限（null/空欄 = データ最小）
    scaleMax: null, // スケール上限（null/空欄 = データ最大）
    normalizeByRow: false, // 行ごとに色を正規化
    normalizeByColumn: false, // 列ごとに色を正規化

    showValues: true, // セルに値を表示
    showXLabels: true, // 列（横軸）ラベルを表示
    showYLabels: true, // 行（縦軸）ラベルを表示
    showRowTotals: false, // 行の合計を表示
    showColTotals: false, // 列の合計を表示
    showLegend: true, // カラー凡例を表示
    sortRowsByTotal: false, // 行を合計の大きい順に並べ替え
    sortColsByTotal: false, // 列を合計の大きい順に並べ替え
    animate: true, // フェードインアニメーション

    cellGap: 2, // セルの間隔（px）
    cellRadius: 2, // セルの角丸（px）
    maxCellSize: 0, // セルの最大サイズ（px、0=無制限）

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: false, // 1.5M などの省略表記

    debug: false, // options デバッグ表示
};

// 巨大マトリクスの描画上限（超過分は先頭を残して省略し、凡例行に注記）
const MAX_ROWS = 300;
const MAX_COLS = 120;
// アニメーションを行うセル数の上限（超過時は即時表示）
const MAX_ANIMATED_CELLS = 1500;

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

function lerpRgb(a, b, t) {
    return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
    };
}

function rgbCss(c) {
    return `rgb(${c.r},${c.g},${c.b})`;
}

// おおまかな相対輝度（0..1）。セル内テキストの白黒切替に使う
function luminance(c) {
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
    const numOrNull = (v) => {
        const n = parseNum(v);
        return Number.isFinite(n) ? n : null;
    };
    const colorOr = (v, d) => (hexToRgb(v) ? v : d);
    const fieldOr = (v) => (typeof v === 'string' || Array.isArray(v) ? v : '');

    return {
        rowField: fieldOr(o.rowField),
        colField: fieldOr(o.colField),
        valueField: fieldOr(o.valueField),

        lowColor: colorOr(o.lowColor, DEFAULTS.lowColor),
        midColor: colorOr(o.midColor, DEFAULTS.midColor),
        highColor: colorOr(o.highColor, DEFAULTS.highColor),
        useMidColor: bool(o.useMidColor, DEFAULTS.useMidColor),
        reverseScale: bool(o.reverseScale, DEFAULTS.reverseScale),
        scaleMin: numOrNull(o.scaleMin),
        scaleMax: numOrNull(o.scaleMax),
        normalizeByRow: bool(o.normalizeByRow, DEFAULTS.normalizeByRow),
        normalizeByColumn: bool(o.normalizeByColumn, DEFAULTS.normalizeByColumn),

        showValues: bool(o.showValues, DEFAULTS.showValues),
        showXLabels: bool(o.showXLabels, DEFAULTS.showXLabels),
        showYLabels: bool(o.showYLabels, DEFAULTS.showYLabels),
        showRowTotals: bool(o.showRowTotals, DEFAULTS.showRowTotals),
        showColTotals: bool(o.showColTotals, DEFAULTS.showColTotals),
        showLegend: bool(o.showLegend, DEFAULTS.showLegend),
        sortRowsByTotal: bool(o.sortRowsByTotal, DEFAULTS.sortRowsByTotal),
        sortColsByTotal: bool(o.sortColsByTotal, DEFAULTS.sortColsByTotal),
        animate: bool(o.animate, DEFAULTS.animate),

        cellGap: clamp(numOr(o.cellGap, DEFAULTS.cellGap), 0, 12),
        cellRadius: clamp(numOr(o.cellRadius, DEFAULTS.cellRadius), 0, 20),
        maxCellSize: clamp(numOr(o.maxCellSize, DEFAULTS.maxCellSize), 0, 400),

        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),

        debug: bool(o.debug, DEFAULTS.debug),
    };
}

// ---------------------------------------------------------------------------
// 値→色スケール（editor.dynamicColor はカスタム viz で使えないため自前実装）
// ---------------------------------------------------------------------------

function scaleRgb(t, opts) {
    let u = clamp01(t);
    if (opts.reverseScale) u = 1 - u;
    const low = hexToRgb(opts.lowColor) || hexToRgb(DEFAULTS.lowColor);
    const high = hexToRgb(opts.highColor) || hexToRgb(DEFAULTS.highColor);
    if (opts.useMidColor) {
        const mid = hexToRgb(opts.midColor) || hexToRgb(DEFAULTS.midColor);
        return u <= 0.5 ? lerpRgb(low, mid, u / 0.5) : lerpRgb(mid, high, (u - 0.5) / 0.5);
    }
    return lerpRgb(low, high, u);
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
// 時刻ラベルの自動整形（_time / ISO 日付 → 粒度に応じた短い表記）
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function maybeFormatTimeLabels(labels, fieldName) {
    if (!labels || labels.length === 0) return null;
    const looksTime =
        fieldName === '_time' ||
        labels.every((s) => ISO_DATETIME_RE.test(String(s)) || ISO_DATE_RE.test(String(s)));
    if (!looksTime) return null;
    // 日付のみ（YYYY-MM-DD）は JS では UTC 解釈になるため、ローカル日付として組み立てる
    const dates = labels.map((s) => {
        const str = String(s);
        const m = ISO_DATE_RE.exec(str);
        if (m) {
            const [y0, m0, d0] = str.split('-').map(Number);
            return new Date(y0, m0 - 1, d0);
        }
        return new Date(str);
    });
    if (dates.some((d) => Number.isNaN(d.getTime()))) return null;

    const pad2 = (n) => String(n).padStart(2, '0');
    const spanYears = new Set(dates.map((d) => d.getFullYear())).size > 1;
    const allMidnight = dates.every((d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0);
    const sameDay = new Set(dates.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)).size === 1;

    return dates.map((d) => {
        const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        const md = `${d.getMonth() + 1}/${d.getDate()}`;
        if (sameDay && !allMidnight) return hm;
        if (allMidnight) return spanYears ? `${d.getFullYear()}/${md}` : md;
        return spanYears ? `${String(d.getFullYear()).slice(2)}/${md} ${hm}` : `${md} ${hm}`;
    });
}

// ---------------------------------------------------------------------------
// モデル構築（rows → {ys, xs, grid, totals, min/max, per-row/col range}）
// ---------------------------------------------------------------------------

function buildModel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows).filter((r) => Array.isArray(r));
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length === 0 || colCount === 0) return { error: 'empty' };

    const isNumericCol = (i) => rows.some((r) => Number.isFinite(parseNum(r[i])));

    // 明示選択（columnSelector の DOS 文字列を自前解決）
    const selRow = resolveFieldIndex(opts.rowField, fieldNames, rows, -1);
    const selCol = resolveFieldIndex(opts.colField, fieldNames, rows, -1);
    const selVal = resolveFieldIndex(opts.valueField, fieldNames, rows, -1);

    // 形式判定: 列フィールドの明示選択、または「2列目が非数値かつ3列目以降に数値列」なら縦持ち
    const autoTidy =
        colCount >= 3 && !isNumericCol(1) && Array.from({ length: colCount - 2 }, (_, k) => k + 2).some(isNumericCol);
    const tidy = selCol >= 0 || (selCol < 0 && autoTidy);

    // (yラベル, xラベル, 値) の一覧に落とす
    const triples = [];
    let usedIdx = {};
    if (tidy) {
        const rowIdx = selRow >= 0 ? selRow : selCol === 0 ? 1 : 0;
        const colIdx = selCol >= 0 ? selCol : rowIdx === 1 ? 0 : 1;
        let valIdx = selVal >= 0 && selVal !== rowIdx && selVal !== colIdx ? selVal : -1;
        if (valIdx < 0) {
            // _span などの内部フィールド（アンダースコア始まり）は自動選択から除外
            for (let i = 0; i < colCount; i += 1) {
                if (i !== rowIdx && i !== colIdx && isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) {
                    valIdx = i;
                    break;
                }
            }
        }
        if (valIdx < 0) {
            for (let i = 0; i < colCount; i += 1) {
                if (i !== rowIdx && i !== colIdx && isNumericCol(i)) {
                    valIdx = i;
                    break;
                }
            }
        }
        if (valIdx < 0) return { error: 'novalue' };
        usedIdx = { mode: 'tidy', rowIdx, colIdx, valIdx };
        for (const r of rows) {
            const v = parseNum(r[valIdx]);
            const y = r[rowIdx];
            const x = r[colIdx];
            if (y === null || y === undefined || x === null || x === undefined) continue;
            triples.push([String(y), String(x), v]);
        }
    } else {
        // クロス集計: 行ラベル列 = 明示選択 > 最初の非数値列 > 第1列
        let rowIdx = selRow;
        if (rowIdx < 0 && colCount > 1) {
            for (let i = 0; i < colCount; i += 1) {
                if (!isNumericCol(i)) {
                    rowIdx = i;
                    break;
                }
            }
            if (rowIdx < 0) rowIdx = 0;
        }
        // 横軸 = 値フィールド明示選択ならその1列、それ以外は行ラベル以外の数値列すべて
        const xCols = [];
        if (selVal >= 0 && selVal !== rowIdx) {
            xCols.push(selVal);
        } else {
            // _span などの内部フィールド（アンダースコア始まり）は横軸から除外
            for (let i = 0; i < colCount; i += 1) {
                if (i !== rowIdx && isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) xCols.push(i);
            }
            if (xCols.length === 0) {
                for (let i = 0; i < colCount; i += 1) {
                    if (i !== rowIdx && isNumericCol(i)) xCols.push(i);
                }
            }
        }
        if (xCols.length === 0) return { error: 'novalue' };
        usedIdx = { mode: 'matrix', rowIdx, xCols };
        rows.forEach((r, ri) => {
            const rawY = rowIdx >= 0 ? r[rowIdx] : null;
            const y = rawY === null || rawY === undefined ? `#${ri + 1}` : String(rawY);
            for (const c of xCols) {
                triples.push([y, fieldNames[c] || `col${c + 1}`, parseNum(r[c])]);
            }
        });
    }

    // ラベルの出現順を保持しつつ集計（同一セルは合算）
    let ys = [];
    let xs = [];
    const yPos = new Map();
    const xPos = new Map();
    const cellSum = new Map();
    const cellHas = new Map();
    for (const [y, x, v] of triples) {
        if (!yPos.has(y)) {
            yPos.set(y, ys.length);
            ys.push(y);
        }
        if (!xPos.has(x)) {
            xPos.set(x, xs.length);
            xs.push(x);
        }
        if (Number.isFinite(v)) {
            const key = `${yPos.get(y)}:${xPos.get(x)}`;
            cellSum.set(key, (cellSum.get(key) || 0) + v);
            cellHas.set(key, true);
        }
    }
    if (cellHas.size === 0) return { error: 'novalue' };

    // 描画上限（先頭を残して省略）
    const truncatedRows = ys.length > MAX_ROWS;
    const truncatedCols = xs.length > MAX_COLS;
    if (truncatedRows) ys = ys.slice(0, MAX_ROWS);
    if (truncatedCols) xs = xs.slice(0, MAX_COLS);

    // グリッド化（欠損セルは null のまま = 0 と区別）
    let grid = ys.map((y, i) =>
        xs.map((x, j) => {
            const key = `${i}:${j}`;
            return cellHas.get(key) ? cellSum.get(key) : null;
        })
    );

    // 合計順ソート（欠損は 0 として合算）
    const sumOf = (arr) => arr.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
    if (opts.sortRowsByTotal) {
        const order = ys.map((_, i) => i).sort((a, b) => sumOf(grid[b]) - sumOf(grid[a]));
        ys = order.map((i) => ys[i]);
        grid = order.map((i) => grid[i]);
    }
    if (opts.sortColsByTotal) {
        const colSum = xs.map((_, j) => sumOf(grid.map((row) => row[j])));
        const order = xs.map((_, j) => j).sort((a, b) => colSum[b] - colSum[a]);
        xs = order.map((j) => xs[j]);
        grid = grid.map((row) => order.map((j) => row[j]));
    }

    // 時刻ラベルの整形（表示用。集計キーは元の文字列のまま）
    const rowFieldName = usedIdx.mode === 'tidy' ? fieldNames[usedIdx.rowIdx] || '' : fieldNames[usedIdx.rowIdx] || '';
    const colFieldName = usedIdx.mode === 'tidy' ? fieldNames[usedIdx.colIdx] || '' : '';
    const yLabels = maybeFormatTimeLabels(ys, rowFieldName) || ys;
    const xLabels = maybeFormatTimeLabels(xs, colFieldName) || xs;

    // 統計（全体・行ごと・列ごとの min/max と合計）
    let min = Infinity;
    let max = -Infinity;
    let grandTotal = 0;
    let anyNegative = false;
    const rowRange = ys.map(() => ({ min: Infinity, max: -Infinity }));
    const colRange = xs.map(() => ({ min: Infinity, max: -Infinity }));
    const rowTotals = ys.map(() => 0);
    const colTotals = xs.map(() => 0);
    grid.forEach((row, i) => {
        row.forEach((v, j) => {
            if (!Number.isFinite(v)) return;
            if (v < min) min = v;
            if (v > max) max = v;
            if (v < 0) anyNegative = true;
            grandTotal += v;
            rowTotals[i] += v;
            colTotals[j] += v;
            if (v < rowRange[i].min) rowRange[i].min = v;
            if (v > rowRange[i].max) rowRange[i].max = v;
            if (v < colRange[j].min) colRange[j].min = v;
            if (v > colRange[j].max) colRange[j].max = v;
        });
    });

    return {
        ys,
        xs,
        yLabels,
        xLabels,
        grid,
        rowTotals,
        colTotals,
        grandTotal,
        anyNegative,
        min,
        max,
        rowRange,
        colRange,
        truncatedRows,
        truncatedCols,
        usedIdx,
    };
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#c9d1d9',
            subText: '#8b98a5',
            emptyCell: 'rgba(139,152,165,0.10)',
            cellTextDark: '#14181c',
            cellTextLight: '#f5f7fa',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
        };
    }
    return {
        text: '#2b3033',
        subText: '#5c6773',
        emptyCell: 'rgba(92,103,115,0.08)',
        cellTextDark: '#14181c',
        cellTextLight: '#f5f7fa',
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
        const dur = 700;
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

function HeatMatrix({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const model = useMemo(() => buildModel(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 560, h: 360 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 560;
        const h = el.clientHeight || 360;
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

    // アニメーション（データの形が変わったら再生）
    const signature = useMemo(
        () => (model.error ? '' : `${model.ys.length}x${model.xs.length}:${model.min}:${model.max}:${model.grandTotal}`),
        [model]
    );
    const nCells = model.error ? 0 : model.ys.length * model.xs.length;
    const progress = useFadeProgress(signature, opts.animate && nCells <= MAX_ANIMATED_CELLS);

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
        return <CenterMessage>数値データが見つかりません。値フィールドの選択を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    const pal = chartColors(mode);
    const { ys, xs, yLabels, xLabels, grid } = model;
    const ny = ys.length;
    const nx = xs.length;

    const pad = 8;
    const s = clamp(Math.min(w, h) / 420, 0.75, 1.3);
    const labelFont = Math.round(clamp(11 * s, 9, 13));

    // --- 凡例・注記の行 ---
    const truncated = model.truncatedRows || model.truncatedCols;
    const legendVisible = opts.showLegend && h >= 120;
    const legendH = legendVisible ? 30 : truncated ? 16 : 0;

    // --- 左右マージン（行ラベル・行合計） ---
    const totalStrs = model.rowTotals.map((t) => fmtValue(t, opts.valueDecimals, opts.abbreviateValue));
    let showY = opts.showYLabels && w >= 120;
    const maxYw = yLabels.reduce((m, t) => Math.max(m, estimateTextWidth(t, labelFont)), 0);
    let yLabelW = showY ? Math.ceil(clamp(maxYw + 10, 28, w * 0.32)) : 0;
    let rowTotW = opts.showRowTotals
        ? Math.ceil(totalStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, labelFont)), 0) + 12)
        : 0;
    if (w - pad * 2 - yLabelW - rowTotW < 60) rowTotW = 0;
    if (w - pad * 2 - yLabelW < 60) {
        yLabelW = Math.min(yLabelW, Math.max(28, w * 0.2));
        if (w - pad * 2 - yLabelW < 60) {
            showY = false;
            yLabelW = 0;
        }
    }
    const showRowTot = rowTotW > 0;

    const gridX = pad + yLabelW;
    const gridW = Math.max(w - gridX - rowTotW - pad, 24);
    let cellW = gridW / nx;
    if (opts.maxCellSize > 0) cellW = Math.min(cellW, opts.maxCellSize);
    const usedGridW = cellW * nx;

    // --- 上マージン（列ラベル。横書きで入らなければ縦書きに退避） ---
    const maxXw = xLabels.reduce((m, t) => Math.max(m, estimateTextWidth(t, labelFont)), 0);
    let showX = opts.showXLabels && cellW >= 7 && h >= 90;
    const xHorizontal = maxXw <= cellW - 4;
    let xLabelH = 0;
    if (showX) {
        xLabelH = xHorizontal ? labelFont + 8 : Math.ceil(clamp(maxXw + 8, labelFont + 8, h * 0.3));
    }
    const xLabelMaxW = xHorizontal ? cellW - 4 : xLabelH - 6;

    // --- 下マージン（列合計） ---
    const colTotStrs = model.colTotals.map((t) => fmtValue(t, opts.valueDecimals, opts.abbreviateValue));
    const colTotUnit = colTotStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, 1)), 0.001);
    let colTotFont = Math.min(labelFont, Math.floor((cellW - 4) / colTotUnit));
    const showColTot = opts.showColTotals && colTotFont >= 8;
    const colTotalH = showColTot ? colTotFont + 8 : 0;

    // --- セル高さ（収まらなければ縦スクロール） ---
    const availGridH = h - pad * 2 - xLabelH - legendH - colTotalH;
    let cellH = availGridH / ny;
    const scrolls = cellH < 12;
    if (scrolls) cellH = 12;
    if (opts.maxCellSize > 0) cellH = Math.min(cellH, opts.maxCellSize);
    const usedGridH = cellH * ny;
    const gridY = pad + xLabelH;
    const contentH = gridY + usedGridH + colTotalH + pad;

    // --- セル内の値表示（フォントを縮めても入らなければ自動で隠す） ---
    const valStrs = grid.map((row) => row.map((v) => (Number.isFinite(v) ? fmtValue(v, opts.valueDecimals, opts.abbreviateValue) : '')));
    let valueFont = 0;
    if (opts.showValues) {
        const unit = valStrs.reduce((m, row) => row.reduce((m2, t) => Math.max(m2, estimateTextWidth(t, 1)), m), 0.001);
        const fitW = Math.floor((cellW - 5) / unit);
        valueFont = Math.min(Math.round(Math.min(13, cellH * 0.6)), fitW);
        if (valueFont < 8 || cellH < 11) valueFont = 0;
    }
    const showVals = valueFont > 0;

    // --- 色の正規化範囲 ---
    const globalLo = opts.scaleMin !== null ? opts.scaleMin : model.min;
    const globalHi = opts.scaleMax !== null ? opts.scaleMax : model.max;
    const tOf = (v, i, j) => {
        let lo = globalLo;
        let hi = globalHi;
        if (opts.normalizeByRow) {
            lo = model.rowRange[i].min;
            hi = model.rowRange[i].max;
        } else if (opts.normalizeByColumn) {
            lo = model.colRange[j].min;
            hi = model.colRange[j].max;
        }
        if (!(hi > lo)) return 0.5;
        return clamp01((v - lo) / (hi - lo));
    };

    const gap = clamp(opts.cellGap, 0, Math.min(cellW, cellH) * 0.4);
    const rx = Math.min(opts.cellRadius, (Math.min(cellW, cellH) - gap) / 2);

    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const cellOpacity = (i, j) => {
        if (progress >= 1) return 1;
        const delay = ((i + j) / Math.max(ny + nx - 2, 1)) * 0.35;
        return ease(clamp01((progress - delay) / 0.65));
    };

    // 凡例の値ラベル（行/列正規化時は相対表記）
    const relative = opts.normalizeByRow || opts.normalizeByColumn;
    const legendLo = relative ? '低' : fmtValue(globalLo, opts.valueDecimals, opts.abbreviateValue);
    const legendHi = relative ? '高' : fmtValue(globalHi, opts.valueDecimals, opts.abbreviateValue);
    const legendNote = relative ? (opts.normalizeByRow ? '（行内で正規化）' : '（列内で正規化）') : '';
    const truncNote = truncated
        ? `※ 表示上限（${MAX_ROWS}行×${MAX_COLS}列）を超えたため一部を省略`
        : '';

    // 凡例グラデーションは「実際の値→色」の並び（左端=最小値の色。反転もそのまま反映）
    const legendStops = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, c: rgbCss(scaleRgb(t, opts)) }));

    const cellTip = (i, j, v) => {
        const y = yLabels[i];
        const x = xLabels[j];
        if (!Number.isFinite(v)) return `${y} × ${x}: データなし`;
        let tip = `${y} × ${x}: ${fmtValue(v, opts.valueDecimals, false)}`;
        if (!model.anyNegative && model.grandTotal > 0) {
            const p = (v / model.grandTotal) * 100;
            tip += `（全体の ${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%）`;
        }
        return tip;
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
            <div style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: scrolls ? 'auto' : 'hidden' }}>
                <svg width={w} height={Math.max(contentH, 10)} style={{ display: 'block' }}>
                    {/* 列（横軸）ラベル */}
                    {showX &&
                        xLabels.map((x, j) => {
                            const cx = gridX + j * cellW + cellW / 2;
                            const label = truncateToWidth(x, labelFont, xLabelMaxW);
                            if (xHorizontal) {
                                return (
                                    <text
                                        key={`x${j}`}
                                        data-role="hm-xlabel"
                                        x={cx}
                                        y={gridY - 5}
                                        textAnchor="middle"
                                        fontSize={labelFont}
                                        fill={pal.subText}
                                    >
                                        {label}
                                    </text>
                                );
                            }
                            const px = cx + labelFont * 0.35;
                            const py = gridY - 5;
                            return (
                                <text
                                    key={`x${j}`}
                                    data-role="hm-xlabel"
                                    x={px}
                                    y={py}
                                    transform={`rotate(-90 ${px} ${py})`}
                                    textAnchor="start"
                                    fontSize={labelFont}
                                    fill={pal.subText}
                                >
                                    {label}
                                </text>
                            );
                        })}

                    {/* 行（縦軸）ラベル */}
                    {showY &&
                        yLabels.map((y, i) => (
                            <text
                                key={`y${i}`}
                                data-role="hm-ylabel"
                                x={gridX - 6}
                                y={gridY + i * cellH + cellH / 2 + labelFont * 0.35}
                                textAnchor="end"
                                fontSize={labelFont}
                                fill={pal.text}
                            >
                                {truncateToWidth(y, labelFont, yLabelW - 8)}
                            </text>
                        ))}

                    {/* セル */}
                    {grid.map((row, i) =>
                        row.map((v, j) => {
                            const cx0 = gridX + j * cellW + gap / 2;
                            const cy0 = gridY + i * cellH + gap / 2;
                            const cw = Math.max(cellW - gap, 0.5);
                            const ch = Math.max(cellH - gap, 0.5);
                            const empty = !Number.isFinite(v);
                            const rgb = empty ? null : scaleRgb(tOf(v, i, j), opts);
                            const fill = empty ? pal.emptyCell : rgbCss(rgb);
                            const op = cellOpacity(i, j);
                            return (
                                <g key={`c${i}-${j}`}>
                                    <rect
                                        data-role="hm-cell"
                                        data-row={i}
                                        data-col={j}
                                        data-empty={empty ? '1' : '0'}
                                        x={cx0}
                                        y={cy0}
                                        width={cw}
                                        height={ch}
                                        rx={rx}
                                        fill={fill}
                                        opacity={op}
                                    >
                                        <title>{cellTip(i, j, v)}</title>
                                    </rect>
                                    {showVals && !empty && (
                                        <text
                                            data-role="hm-val"
                                            x={cx0 + cw / 2}
                                            y={cy0 + ch / 2 + valueFont * 0.35}
                                            textAnchor="middle"
                                            fontSize={valueFont}
                                            fill={luminance(rgb) > 0.55 ? pal.cellTextDark : pal.cellTextLight}
                                            opacity={op}
                                            style={{ pointerEvents: 'none' }}
                                        >
                                            {valStrs[i][j]}
                                        </text>
                                    )}
                                </g>
                            );
                        })
                    )}

                    {/* 行の合計（右） */}
                    {showRowTot &&
                        totalStrs.map((t, i) => (
                            <text
                                key={`rt${i}`}
                                data-role="hm-rowtotal"
                                x={gridX + usedGridW + 8}
                                y={gridY + i * cellH + cellH / 2 + labelFont * 0.35}
                                textAnchor="start"
                                fontSize={labelFont}
                                fontWeight={600}
                                fill={pal.subText}
                            >
                                {t}
                            </text>
                        ))}

                    {/* 列の合計（下） */}
                    {showColTot &&
                        colTotStrs.map((t, j) => (
                            <text
                                key={`ct${j}`}
                                data-role="hm-coltotal"
                                x={gridX + j * cellW + cellW / 2}
                                y={gridY + usedGridH + colTotFont + 3}
                                textAnchor="middle"
                                fontSize={colTotFont}
                                fontWeight={600}
                                fill={pal.subText}
                            >
                                {t}
                            </text>
                        ))}
                </svg>
            </div>

            {/* カラー凡例（スクロール領域の外・常に表示） */}
            {legendH > 0 && (
                <svg width={w} height={legendH} style={{ display: 'block', flex: 'none' }}>
                    {legendVisible && (
                        <g>
                            <defs>
                                <linearGradient id="hmGrad" x1="0" y1="0" x2="1" y2="0">
                                    {legendStops.map(({ t, c }) => (
                                        <stop key={t} offset={`${t * 100}%`} stopColor={c} />
                                    ))}
                                </linearGradient>
                            </defs>
                            <text
                                data-role="hm-legend-min"
                                x={pad}
                                y={19}
                                textAnchor="start"
                                fontSize={10}
                                fill={pal.subText}
                            >
                                {legendLo}
                            </text>
                            <rect
                                data-role="hm-legend"
                                x={pad + estimateTextWidth(legendLo, 10) + 6}
                                y={11}
                                width={clamp(w * 0.35, 60, 240)}
                                height={9}
                                rx={4}
                                fill="url(#hmGrad)"
                            />
                            <text
                                data-role="hm-legend-max"
                                x={pad + estimateTextWidth(legendLo, 10) + 6 + clamp(w * 0.35, 60, 240) + 6}
                                y={19}
                                textAnchor="start"
                                fontSize={10}
                                fill={pal.subText}
                            >
                                {legendHi}
                                {legendNote}
                            </text>
                        </g>
                    )}
                    {truncated && (
                        <text
                            data-role="hm-trunc-note"
                            x={w - pad}
                            y={legendVisible ? 19 : 12}
                            textAnchor="end"
                            fontSize={10}
                            fill={pal.subText}
                        >
                            {truncNote}
                        </text>
                    )}
                </svg>
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
                            fields: fieldNames,
                            usedIdx: model.usedIdx,
                            ys: model.ys,
                            xs: model.xs,
                            min: model.min,
                            max: model.max,
                            grandTotal: model.grandTotal,
                            truncatedRows: model.truncatedRows,
                            truncatedCols: model.truncatedCols,
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
            <HeatMatrix mode={mode} />
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
