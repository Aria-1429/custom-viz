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
// Horizon Chart（ホライズンチャート）
//
// 多数の時系列を「畳んで色帯にする」ことで、1系列あたり 20〜30px の高さでも
// 数十系列を同時に比較できるようにするチャート。
//
// 原理:
//   通常の折れ線は値域が広いほど縦に場所を食う。ホライズンチャートは値域を
//   bands 個の等幅バンドに切り、上のバンドを下へ折り返して重ねる。
//   バンドが上（値が大きい）ほど色を濃くするため、「高さ」で読んでいた情報が
//   「色の濃さ」に置き換わり、レーン高さを 1/bands に圧縮できる。
//   基準値より下（負側）は反対色で同じように折り返す。
//   → 面積・折れ線では潰れる「多系列の同時スパイク」が一目で分かる。
//
// Splunk 標準の timechart は系列が 5 本を超えると重なって読めなくなるため、
// 「100 台のホストの CPU を縦に積んで、どこが同時に跳ねたか」を見る用途は
// 標準ビジュアライゼーションでは再現できない。
//
// データモデル:
//   クロス集計(wide) : 第1列 = 時刻、残りの数値列 = 系列（timechart の出力そのまま）
//   縦持ち(tidy)     : 時刻列 + 系列ラベル列 + 数値列（例: stats ... by _time, host）
//                      …2列目が非数値かつ3列目以降に数値列があれば自動で縦持ちと判定。
//   フィールドの明示選択（editor.columnSelector）はどちらの形式でも自動判定より優先。
//
// 色は「基準より上＝positiveColor、下＝negativeColor」を bands 段の不透明度で
// 濃淡表現（editor.dynamicColor はカスタム viz では使えないため自前実装）。
// コンテナ実寸へ自動フィットし、系列が多いときは縦スクロール。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    timeField: '', // 時刻フィールド（'' = 自動）
    seriesField: '', // 系列フィールド（縦持ち時。'' = 自動）
    valueField: '', // 値フィールド（'' = 自動）

    bands: 3, // バンド数（1〜6）
    bandBase: null, // 基準値（null/空欄 = 0）
    bandStep: null, // 1バンドの幅（null/空欄 = 自動）
    perSeriesScale: false, // 系列ごとに高さを正規化
    showNegative: true, // 基準値より下を反対色で表示

    positiveColor: '#1f78b4', // 基準より上の色
    negativeColor: '#d73027', // 基準より下の色
    bandOpacityFloor: 0.28, // 最下バンドの濃さ

    laneHeight: 34, // レーンの高さ（px）
    laneGap: 2, // レーンの間隔（px）
    autoFitLanes: true, // パネル高さに自動フィット
    curve: true, // 曲線でなめらかに描く

    sortByPeak: false, // 最大値の大きい順に並べ替え
    sortByTotal: false, // 合計の大きい順に並べ替え
    maxSeries: 60, // 最大表示系列数

    showLabels: true, // 系列名を表示
    labelWidth: 0, // 系列名の幅（px、0=自動）
    showPeakValue: true, // 各レーンの最大値を表示
    showTimeAxis: true, // 時刻軸を表示
    showLegend: true, // 凡例を表示
    showCrosshair: true, // カーソルの縦線を表示
    showLaneSeparator: true, // レーンの区切り線を表示
    animate: true, // 描画アニメーション

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: true, // 1.5M などの省略表記

    debug: false, // options デバッグ表示
};

// 描画上限
const MAX_SERIES_CAP = 200; // maxSeries オプションの上限
const MAX_POINTS = 2000; // 1系列あたりの時刻点の上限（超過分は間引き）
const LANE_MIN_H = 8; // レーンの最小高さ（これ未満はスクロールに切替）

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

function rgbaCss(c, a) {
    return `rgba(${c.r},${c.g},${c.b},${Number(a.toFixed(3))})`;
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

// 「きりのいい」目盛り幅（1/2/5×10^n）に切り下げる。
// 切り上げにすると最上バンドが最後まで埋まらず、レーン上部が常に余る
// （例: 最大300/3バンド → 切り上げ 500 では peak が 60% までしか伸びない）。
// 切り下げれば最大値は必ず最上バンドを振り切るので、レーン高さを使い切れる。
function niceStepDown(raw) {
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const exp = Math.floor(Math.log10(raw));
    const pow = Math.pow(10, exp);
    const f = raw / pow;
    let nice;
    if (f >= 5) nice = 5;
    else if (f >= 2) nice = 2;
    else nice = 1;
    return nice * pow;
}

// バンド幅の自動決定。きりのいい値を優先しつつ、それだと表示が痩せすぎる
// （最上バンドの埋まりが 50% 未満になる）場合は厳密な等分に切り替える。
function autoBandStep(maxDev, bands) {
    if (!Number.isFinite(maxDev) || maxDev <= 0 || bands <= 0) return 1;
    const exact = maxDev / bands;
    const nice = niceStepDown(exact);
    // nice は exact 以下なので peak は必ず最上バンドを超えるが、
    // 小さすぎると「全バンド振り切り」で階調が失われる。その場合は等分を使う。
    return nice >= exact * 0.5 ? nice : exact;
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

    // bandStep は正の値のみ意味を持つ（0 や負値は自動に落とす）
    const step = numOrNull(o.bandStep);

    return {
        timeField: fieldOr(o.timeField),
        seriesField: fieldOr(o.seriesField),
        valueField: fieldOr(o.valueField),

        bands: clamp(Math.round(numOr(o.bands, DEFAULTS.bands)), 1, 6),
        bandBase: numOrNull(o.bandBase),
        bandStep: step !== null && step > 0 ? step : null,
        perSeriesScale: bool(o.perSeriesScale, DEFAULTS.perSeriesScale),
        showNegative: bool(o.showNegative, DEFAULTS.showNegative),

        positiveColor: colorOr(o.positiveColor, DEFAULTS.positiveColor),
        negativeColor: colorOr(o.negativeColor, DEFAULTS.negativeColor),
        bandOpacityFloor: clamp(numOr(o.bandOpacityFloor, DEFAULTS.bandOpacityFloor), 0.05, 1),

        laneHeight: clamp(numOr(o.laneHeight, DEFAULTS.laneHeight), 8, 200),
        laneGap: clamp(numOr(o.laneGap, DEFAULTS.laneGap), 0, 20),
        autoFitLanes: bool(o.autoFitLanes, DEFAULTS.autoFitLanes),
        curve: bool(o.curve, DEFAULTS.curve),

        sortByPeak: bool(o.sortByPeak, DEFAULTS.sortByPeak),
        sortByTotal: bool(o.sortByTotal, DEFAULTS.sortByTotal),
        maxSeries: clamp(Math.round(numOr(o.maxSeries, DEFAULTS.maxSeries)), 1, MAX_SERIES_CAP),

        showLabels: bool(o.showLabels, DEFAULTS.showLabels),
        labelWidth: clamp(numOr(o.labelWidth, DEFAULTS.labelWidth), 0, 400),
        showPeakValue: bool(o.showPeakValue, DEFAULTS.showPeakValue),
        showTimeAxis: bool(o.showTimeAxis, DEFAULTS.showTimeAxis),
        showLegend: bool(o.showLegend, DEFAULTS.showLegend),
        showCrosshair: bool(o.showCrosshair, DEFAULTS.showCrosshair),
        showLaneSeparator: bool(o.showLaneSeparator, DEFAULTS.showLaneSeparator),
        animate: bool(o.animate, DEFAULTS.animate),

        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),

        debug: bool(o.debug, DEFAULTS.debug),
    };
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
// 時刻パース（epoch 秒/ミリ秒・ISO・"YYYY-MM-DD HH:MM:SS"）
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 時刻らしければ epoch ミリ秒、そうでなければ null
function parseTime(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    const s = String(v).trim();
    if (s === '') return null;

    // 純粋な数値は epoch（10桁前後=秒、13桁前後=ミリ秒）
    if (/^-?\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        const abs = Math.abs(n);
        if (abs >= 1e11) return n; // ミリ秒
        if (abs >= 1e8) return n * 1000; // 秒
        return null; // 小さすぎる数値は時刻とみなさない（ただの数値列）
    }
    // 日付のみは UTC 解釈を避けてローカル日付として組み立てる
    if (ISO_DATE_RE.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return Number.isNaN(dt.getTime()) ? null : dt.getTime();
    }
    if (ISO_DATETIME_RE.test(s)) {
        const dt = new Date(s.replace(' ', 'T'));
        return Number.isNaN(dt.getTime()) ? null : dt.getTime();
    }
    return null;
}

// 時刻列らしさの判定（過半数がパースできれば時刻列とみなす）
function looksLikeTimeColumn(rows, idx, fieldName) {
    if (fieldName === '_time') return true;
    let ok = 0;
    let n = 0;
    for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const v = r[idx];
        if (v === null || v === undefined || v === '') continue;
        n += 1;
        if (parseTime(v) !== null) ok += 1;
        if (n >= 20) break;
    }
    return n > 0 && ok / n >= 0.7;
}

const pad2 = (n) => String(n).padStart(2, '0');

// 時刻軸ラベルの整形（表示範囲の粒度に応じて短い表記を選ぶ）
function makeTimeFormatter(tMin, tMax) {
    const span = Math.max(tMax - tMin, 0);
    const DAY = 86400000;
    if (span <= 0) {
        return (t) => {
            const d = new Date(t);
            return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        };
    }
    if (span < 2 * DAY) {
        // 2日未満: 時:分
        return (t) => {
            const d = new Date(t);
            return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        };
    }
    if (span < 365 * DAY) {
        // 1年未満: 月/日
        return (t) => {
            const d = new Date(t);
            return `${d.getMonth() + 1}/${d.getDate()}`;
        };
    }
    return (t) => {
        const d = new Date(t);
        return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
    };
}

// ツールチップ用のフル表記
function fmtTimeFull(t) {
    const d = new Date(t);
    const hasTime = d.getHours() || d.getMinutes() || d.getSeconds();
    const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return hasTime ? `${ymd} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : ymd;
}

// ---------------------------------------------------------------------------
// モデル構築（rows → {times, series[{name, values, peak, total}], base, step}）
// ---------------------------------------------------------------------------

function buildModel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows).filter((r) => Array.isArray(r));
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length === 0 || colCount === 0) return { error: 'empty' };

    const isNumericCol = (i) => rows.some((r) => Number.isFinite(parseNum(r[i])));

    // 明示選択（columnSelector の DOS 文字列を自前解決）
    const selTime = resolveFieldIndex(opts.timeField, fieldNames, rows, -1);
    const selSeries = resolveFieldIndex(opts.seriesField, fieldNames, rows, -1);
    const selValue = resolveFieldIndex(opts.valueField, fieldNames, rows, -1);

    // --- 時刻列の決定: 明示選択 > 時刻らしい最初の列 > 第1列 ---
    let timeIdx = selTime;
    if (timeIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (looksLikeTimeColumn(rows, i, fieldNames[i])) {
                timeIdx = i;
                break;
            }
        }
    }
    // 時刻列が見つからない場合は第1列を「順序インデックス」として扱う（カテゴリ軸）
    const hasRealTime = timeIdx >= 0;
    if (timeIdx < 0) timeIdx = 0;

    // --- 形式判定: 系列列の明示選択、または「時刻列以外の最初の列が非数値」なら縦持ち ---
    let autoSeriesIdx = -1;
    for (let i = 0; i < colCount; i += 1) {
        if (i === timeIdx) continue;
        if (!isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) {
            autoSeriesIdx = i;
            break;
        }
    }
    const numericCols = [];
    for (let i = 0; i < colCount; i += 1) {
        if (i === timeIdx) continue;
        if (isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) numericCols.push(i);
    }
    const tidy = selSeries >= 0 || (autoSeriesIdx >= 0 && numericCols.length > 0);

    // (時刻キー, 系列名, 値) の一覧に落とす
    const triples = [];
    let usedIdx = {};
    if (tidy) {
        const seriesIdx = selSeries >= 0 ? selSeries : autoSeriesIdx;
        if (seriesIdx < 0) return { error: 'novalue' };
        let valIdx = selValue >= 0 && selValue !== timeIdx && selValue !== seriesIdx ? selValue : -1;
        if (valIdx < 0) valIdx = numericCols.find((i) => i !== seriesIdx) ?? -1;
        if (valIdx < 0) {
            // アンダースコア始まりを許容してでも数値列を探す
            for (let i = 0; i < colCount; i += 1) {
                if (i !== timeIdx && i !== seriesIdx && isNumericCol(i)) {
                    valIdx = i;
                    break;
                }
            }
        }
        if (valIdx < 0) return { error: 'novalue' };
        usedIdx = { mode: 'tidy', timeIdx, seriesIdx, valIdx, hasRealTime };
        rows.forEach((r, ri) => {
            const tRaw = r[timeIdx];
            const t = hasRealTime ? parseTime(tRaw) : ri;
            if (t === null) return;
            const name = r[seriesIdx];
            if (name === null || name === undefined) return;
            triples.push([t, String(name), parseNum(r[valIdx])]);
        });
    } else {
        // クロス集計（timechart 出力）: 時刻列以外の数値列すべてが系列
        let valueCols = numericCols;
        if (selValue >= 0 && selValue !== timeIdx) valueCols = [selValue];
        if (valueCols.length === 0) {
            for (let i = 0; i < colCount; i += 1) {
                if (i !== timeIdx && isNumericCol(i)) valueCols.push(i);
            }
        }
        if (valueCols.length === 0) return { error: 'novalue' };
        usedIdx = { mode: 'wide', timeIdx, valueCols, hasRealTime };
        rows.forEach((r, ri) => {
            const t = hasRealTime ? parseTime(r[timeIdx]) : ri;
            if (t === null) return;
            for (const c of valueCols) {
                triples.push([t, fieldNames[c] || `col${c + 1}`, parseNum(r[c])]);
            }
        });
    }

    if (triples.length === 0) return { error: 'notime' };

    // --- 時刻軸と系列を組み立てる（時刻は昇順、系列は出現順） ---
    const timeSet = new Set();
    const seriesOrder = [];
    const seriesPos = new Map();
    for (const [t, name] of triples) {
        timeSet.add(t);
        if (!seriesPos.has(name)) {
            seriesPos.set(name, seriesOrder.length);
            seriesOrder.push(name);
        }
    }
    let times = [...timeSet].sort((a, b) => a - b);

    // 時刻点が多すぎる場合は等間隔に間引く（描画コスト対策）
    let downsampled = false;
    if (times.length > MAX_POINTS) {
        const stride = times.length / MAX_POINTS;
        const picked = [];
        for (let k = 0; k < MAX_POINTS; k += 1) picked.push(times[Math.floor(k * stride)]);
        picked.push(times[times.length - 1]);
        times = [...new Set(picked)];
        downsampled = true;
    }
    const timePos = new Map(times.map((t, i) => [t, i]));

    // 値グリッド（同一 (時刻, 系列) は合算。欠損は null のまま = 0 と区別）
    const nT = times.length;
    const grids = seriesOrder.map(() => new Array(nT).fill(null));
    for (const [t, name, v] of triples) {
        if (!Number.isFinite(v)) continue;
        const ti = timePos.get(t);
        if (ti === undefined) continue; // 間引きで落ちた時刻
        const si = seriesPos.get(name);
        grids[si][ti] = (grids[si][ti] || 0) + v;
    }

    // 系列ごとの統計
    let series = seriesOrder.map((name, si) => {
        const values = grids[si];
        let peak = -Infinity;
        let trough = Infinity;
        let total = 0;
        let count = 0;
        let last = null;
        for (const v of values) {
            if (!Number.isFinite(v)) continue;
            if (v > peak) peak = v;
            if (v < trough) trough = v;
            total += v;
            count += 1;
            last = v;
        }
        return {
            name,
            values,
            peak: count > 0 ? peak : NaN,
            trough: count > 0 ? trough : NaN,
            total,
            count,
            last,
            mean: count > 0 ? total / count : NaN,
        };
    }).filter((s) => s.count > 0);

    if (series.length === 0) return { error: 'novalue' };

    // 並べ替え
    if (opts.sortByPeak) {
        series = [...series].sort((a, b) => b.peak - a.peak);
    } else if (opts.sortByTotal) {
        series = [...series].sort((a, b) => b.total - a.total);
    }

    // 最大表示系列数
    const truncatedSeries = series.length > opts.maxSeries;
    const hiddenCount = truncatedSeries ? series.length - opts.maxSeries : 0;
    if (truncatedSeries) series = series.slice(0, opts.maxSeries);

    // --- バンドの基準値と幅 ---
    const base = opts.bandBase !== null ? opts.bandBase : 0;
    let globalMaxDev = 0; // 基準からの最大乖離（上下とも）
    for (const s of series) {
        const up = Number.isFinite(s.peak) ? s.peak - base : 0;
        const dn = Number.isFinite(s.trough) ? base - s.trough : 0;
        globalMaxDev = Math.max(globalMaxDev, up, opts.showNegative ? dn : 0);
    }
    if (!(globalMaxDev > 0)) globalMaxDev = 1; // 全て基準と同値なら潰れないよう 1 にする

    // 1バンドの幅: 明示指定 > 全体乖離 / バンド数（きりのいい値に切り下げ）
    const step = opts.bandStep !== null ? opts.bandStep : autoBandStep(globalMaxDev, opts.bands);

    // --- 系列ごとの基準値とバンド幅（perSeriesScale 用） ---
    //
    // 「系列ごとに高さを正規化」では、基準を 0（または bandBase）に固定したまま
    // 最大値だけで割ると、0 から遠い高水準で推移する系列が破綻する。
    // 例: 値が 120〜132 の系列で最大132/3段=44 とすると、平常値 120 でも 2.7 段ぶんに
    //     達し、下2段が常時満杯の「塗り潰し」になって変動が読めない。
    // そこで正規化時は基準を「その系列の最小値」に取り、
    // 変動幅（最小〜最大）をバンド全体へ引き伸ばす。これにより 120→132 の
    // わずかな揺らぎもレーン内で薄→濃のグラデーションとして読める。
    series = series.map((s) => {
        if (!opts.perSeriesScale) {
            // 通常モード: 全系列共通の基準・バンド幅
            return { ...s, laneBase: base, laneStep: step };
        }
        const lo = Number.isFinite(s.trough) ? s.trough : base;
        const hi = Number.isFinite(s.peak) ? s.peak : base;
        const spread = hi - lo;
        if (!(spread > 0)) {
            // 全時刻が同値（変動なし）の系列は、引き伸ばすと意味のない絵になる。
            // 基準を値そのものに置き、描画されない（＝平坦）状態にする。
            return { ...s, laneBase: lo, laneStep: step > 0 ? step : 1, flat: true };
        }
        return { ...s, laneBase: lo, laneStep: spread / opts.bands };
    });

    const tMin = times[0];
    const tMax = times[times.length - 1];

    return {
        times,
        tMin,
        tMax,
        series,
        base,
        step,
        globalMaxDev,
        hasRealTime,
        downsampled,
        truncatedSeries,
        hiddenCount,
        usedIdx,
    };
}

// ---------------------------------------------------------------------------
// ホライズンバンドのパス生成
//
// バンド b（0 起点）は「値が base + b*step を超えた分」を描く層。
// レーン高さ H に対し、値 v の層内での高さは
//   h = clamp((|v - base| - b*step) / step, 0, 1) * H
// となり、上から下へ塗り重ねると「折り返して重ねた」表現になる。
// 負側（showNegative）は同じ計算を反対色で行う。
// ---------------------------------------------------------------------------

// 値 → 層内の正規化高さ（0..1）
function bandFraction(dev, bandIndex, step) {
    if (!(step > 0)) return 0;
    return clamp01((dev - bandIndex * step) / step);
}

// 点列 → SVG パス（曲線は Catmull-Rom 風の単調カージナル補間、末端は直線で閉じる）
function areaPath(pts, baselineY, curve) {
    if (pts.length === 0) return '';
    if (pts.length === 1) {
        // 単一点は細い縦棒として見えるように微小幅を持たせる
        const [x, y] = pts[0];
        return `M ${x - 0.5} ${baselineY} L ${x - 0.5} ${y} L ${x + 0.5} ${y} L ${x + 0.5} ${baselineY} Z`;
    }
    const n = pts.length;
    let d = `M ${pts[0][0]} ${baselineY} L ${pts[0][0]} ${pts[0][1]}`;
    if (!curve) {
        for (let i = 1; i < n; i += 1) d += ` L ${pts[i][0]} ${pts[i][1]}`;
    } else {
        // 単調性を壊さないよう、制御点の縦方向の張り出しを隣接値の範囲内に抑える
        for (let i = 0; i < n - 1; i += 1) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[i + 1];
            const cx = (x0 + x1) / 2;
            d += ` C ${cx} ${y0} ${cx} ${y1} ${x1} ${y1}`;
        }
    }
    d += ` L ${pts[n - 1][0]} ${baselineY} Z`;
    return d;
}

// 1レーン分のバンドパス一覧を作る
// 返り値: [{ d, color, opacity, sign, band }]
function buildLaneBands(values, xs, laneH, base, step, opts, progress) {
    const out = [];
    const nBands = opts.bands;
    const posRgb = hexToRgb(opts.positiveColor) || hexToRgb(DEFAULTS.positiveColor);
    const negRgb = hexToRgb(opts.negativeColor) || hexToRgb(DEFAULTS.negativeColor);

    // アニメーション: 左から右へ描き出す（progress=1 で全点）
    const shown = Math.max(2, Math.ceil(values.length * clamp01(progress)));

    const signs = opts.showNegative ? [1, -1] : [1];
    for (const sign of signs) {
        for (let b = 0; b < nBands; b += 1) {
            const pts = [];
            let hasArea = false;
            for (let i = 0; i < Math.min(shown, values.length); i += 1) {
                const v = values[i];
                if (!Number.isFinite(v)) continue;
                const dev = sign > 0 ? v - base : base - v;
                const f = dev > 0 ? bandFraction(dev, b, step) : 0;
                if (f > 0) hasArea = true;
                // レーンの下辺を基線とし、上に向かって伸ばす
                pts.push([xs[i], laneH - f * laneH]);
            }
            if (!hasArea || pts.length === 0) continue;
            // 上のバンドほど濃く（最下バンド = bandOpacityFloor、最上 = 1.0）
            const opacity =
                nBands === 1
                    ? 1
                    : opts.bandOpacityFloor + ((1 - opts.bandOpacityFloor) * b) / (nBands - 1);
            out.push({
                d: areaPath(pts, laneH, opts.curve),
                color: rgbaCss(sign > 0 ? posRgb : negRgb, opacity),
                sign,
                band: b,
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#c9d1d9',
            subText: '#8b98a5',
            laneBg: 'rgba(139,152,165,0.06)',
            laneBgAlt: 'rgba(139,152,165,0.11)',
            separator: 'rgba(139,152,165,0.22)',
            axis: 'rgba(139,152,165,0.35)',
            crosshair: '#f5f7fa',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
            hoverLane: 'rgba(139,152,165,0.10)',
        };
    }
    return {
        text: '#2b3033',
        subText: '#5c6773',
        laneBg: 'rgba(92,103,115,0.045)',
        laneBgAlt: 'rgba(92,103,115,0.09)',
        separator: 'rgba(92,103,115,0.20)',
        axis: 'rgba(92,103,115,0.35)',
        crosshair: '#2b3033',
        panelBg: 'rgba(255,255,255,0.98)',
        panelBorder: 'rgba(92,103,115,0.4)',
        hoverLane: 'rgba(92,103,115,0.07)',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// 描き出しアニメーション（データ変更で 0→1 を再生。無効時は常に 1）
// ---------------------------------------------------------------------------

function useDrawProgress(signature, enabled) {
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
            // ease-out で最後がゆっくり止まる
            setProgress(1 - Math.pow(1 - t, 3));
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

function CenterMessage({ children, sub }) {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                padding: 12,
                textAlign: 'center',
            }}
        >
            <Paragraph>{children}</Paragraph>
            {sub && (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, fontFamily: FONT_STACK }}>{sub}</div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function HorizonChart({ mode }) {
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
    const [dims, setDims] = useState({ w: 640, h: 400 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 640;
        const h = el.clientHeight || 400;
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

    // クロスヘア（ホバー中の時刻インデックス）
    const [hover, setHover] = useState(null); // { ti, laneIdx } | null

    // アニメーション（データの形が変わったら再生）
    const signature = useMemo(
        () =>
            model.error
                ? ''
                : `${model.series.length}:${model.times.length}:${model.tMin}:${model.tMax}:${model.step}`,
        [model]
    );
    const progress = useDrawProgress(signature, opts.animate);

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
    if (model.error === 'notime') {
        return (
            <CenterMessage sub="例: index=_internal | timechart span=5m count by sourcetype">
                データがありません。サーチ結果を確認してください。
            </CenterMessage>
        );
    }
    if (model.error === 'novalue') {
        return (
            <CenterMessage sub="時刻列と数値列が必要です（timechart の出力、または _time・系列名・数値の3列）">
                データがありません。サーチ結果を確認してください。
            </CenterMessage>
        );
    }

    const { w, h } = dims;
    const pal = chartColors(mode);
    const { times, series, base, step, tMin, tMax } = model;
    const nS = series.length;
    const nT = times.length;

    const pad = 8;
    const fontSize = 11;

    // --- 凡例・注記の高さ ---
    const noteText = [
        model.truncatedSeries ? `※ 上位 ${opts.maxSeries} 系列のみ表示（残り ${model.hiddenCount} 系列を省略）` : '',
        model.downsampled ? `※ 時刻点が多いため間引き表示` : '',
    ]
        .filter(Boolean)
        .join('　');
    const legendVisible = opts.showLegend && h >= 140;
    const legendH = legendVisible ? 26 : noteText ? 15 : 0;

    // --- 時刻軸の高さ ---
    const axisVisible = opts.showTimeAxis && h >= 110;
    const axisH = axisVisible ? 16 : 0;

    // --- 左マージン（系列名） ---
    let showLabels = opts.showLabels && w >= 160;
    const maxLabelW = series.reduce((m, s) => Math.max(m, estimateTextWidth(s.name, fontSize)), 0);
    let labelW = 0;
    if (showLabels) {
        labelW =
            opts.labelWidth > 0
                ? opts.labelWidth
                : Math.ceil(clamp(maxLabelW + 10, 40, w * 0.28));
    }

    // --- 右マージン（各レーンの最大値） ---
    const peakStrs = series.map((s) => fmtValue(s.peak, opts.valueDecimals, opts.abbreviateValue));
    let peakW = opts.showPeakValue
        ? Math.ceil(peakStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, fontSize)), 0) + 10)
        : 0;

    // 幅が足りないときの段階退避: 最大値 → 系列名の順に諦める
    if (w - pad * 2 - labelW - peakW < 80) peakW = 0;
    if (w - pad * 2 - labelW < 80) {
        labelW = Math.min(labelW, Math.max(40, w * 0.2));
        if (w - pad * 2 - labelW < 80) {
            showLabels = false;
            labelW = 0;
        }
    }
    const showPeak = peakW > 0;

    const plotX = pad + labelW;
    const plotW = Math.max(w - plotX - peakW - pad, 24);

    // --- レーンの高さ（自動フィット or 固定。収まらなければ縦スクロール） ---
    const availH = h - pad * 2 - axisH - legendH;
    const gap = opts.laneGap;
    let laneH;
    if (opts.autoFitLanes) {
        laneH = (availH - gap * (nS - 1)) / nS;
        laneH = Math.min(laneH, opts.laneHeight); // laneHeight は自動フィット時の上限
    } else {
        laneH = opts.laneHeight;
    }
    const scrolls = laneH < LANE_MIN_H;
    if (scrolls) laneH = LANE_MIN_H;
    laneH = Math.max(laneH, 2);

    const lanesH = nS * laneH + gap * Math.max(nS - 1, 0);
    const plotY = pad;
    const contentH = plotY + lanesH + axisH + pad;

    // --- 時刻 → x 座標 ---
    const xOf = (i) => {
        if (nT <= 1) return plotX + plotW / 2;
        if (!model.hasRealTime || tMax === tMin) {
            // 時刻でない/全て同時刻なら等間隔
            return plotX + (i / (nT - 1)) * plotW;
        }
        return plotX + ((times[i] - tMin) / (tMax - tMin)) * plotW;
    };
    const xs = times.map((_, i) => xOf(i));

    // --- 時刻軸の目盛り（等間隔に最大6個） ---
    const tickCount = clamp(Math.floor(plotW / 90), 2, 6);
    const timeFmt = makeTimeFormatter(tMin, tMax);
    const ticks = [];
    if (axisVisible && nT > 0) {
        for (let k = 0; k < tickCount; k += 1) {
            const i = Math.round((k / (tickCount - 1)) * (nT - 1));
            const label = model.hasRealTime ? timeFmt(times[i]) : String(times[i] + 1);
            ticks.push({ x: xs[i], label, i });
        }
    }

    // --- ホバー位置から時刻インデックスを引く ---
    const tiFromX = (px) => {
        if (nT === 0) return null;
        if (nT === 1) return 0;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < nT; i += 1) {
            const d = Math.abs(xs[i] - px);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    };

    const onMove = (e) => {
        if (!opts.showCrosshair) return;
        const svg = e.currentTarget;
        const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
        if (!rect) return;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (px < plotX - 4 || px > plotX + plotW + 4) {
            setHover(null);
            return;
        }
        const ti = tiFromX(px);
        const laneIdx = clamp(Math.floor((py - plotY) / (laneH + gap)), 0, nS - 1);
        setHover((prev) =>
            prev && prev.ti === ti && prev.laneIdx === laneIdx ? prev : { ti, laneIdx }
        );
    };
    const onLeave = () => setHover(null);

    // --- 凡例（バンドの濃さ = 値の帯） ---
    const legendBands = Array.from({ length: opts.bands }, (_, b) => ({
        b,
        opacity: opts.bands === 1 ? 1 : opts.bandOpacityFloor + ((1 - opts.bandOpacityFloor) * b) / (opts.bands - 1),
        from: base + b * step,
        to: base + (b + 1) * step,
    }));
    const posRgb = hexToRgb(opts.positiveColor) || hexToRgb(DEFAULTS.positiveColor);
    const negRgb = hexToRgb(opts.negativeColor) || hexToRgb(DEFAULTS.negativeColor);

    // 凡例テキストと、その実幅から求めた負側スウォッチの位置
    // 正規化時は基準・幅が系列ごとに異なるため、固定値を出すと誤解を招く
    const legendLabel = opts.perSeriesScale
        ? `濃いほど大きい（系列ごとに正規化・各レーンの最小〜最大を${opts.bands}段に展開）`
        : `濃いほど大きい（1段=${fmtValue(step, opts.valueDecimals, opts.abbreviateValue)}） 基準=${fmtValue(
              base,
              opts.valueDecimals,
              opts.abbreviateValue
          )}`;
    const legendTextX = pad + opts.bands * 16 + 6;
    const legendNegX = legendTextX + estimateTextWidth(legendLabel, 10) + 14;

    // ホバー中の値（ツールチップ相当のインライン表示）
    const hoverInfo =
        hover && hover.ti !== null && series[hover.laneIdx]
            ? {
                  time: model.hasRealTime ? fmtTimeFull(times[hover.ti]) : `#${times[hover.ti] + 1}`,
                  name: series[hover.laneIdx].name,
                  value: series[hover.laneIdx].values[hover.ti],
              }
            : null;

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
                <svg
                    width={w}
                    height={Math.max(contentH, 10)}
                    style={{ display: 'block' }}
                    onMouseMove={onMove}
                    onMouseLeave={onLeave}
                >
                    <defs>
                        {/* レーンごとに矩形でクリップし、バンドがレーンをはみ出さないようにする */}
                        {series.map((s, si) => (
                            <clipPath key={`clip${si}`} id={`hzClip${si}`}>
                                <rect x={plotX} y={0} width={plotW} height={laneH} />
                            </clipPath>
                        ))}
                    </defs>

                    {series.map((s, si) => {
                        const laneY = plotY + si * (laneH + gap);
                        // 基準値・バンド幅はモデル側で系列ごとに確定済み
                        // （perSeriesScale 時は laneBase=その系列の最小値、laneStep=変動幅/段数）
                        const laneBase = s.laneBase;
                        const laneStep = s.laneStep;
                        const bands = buildLaneBands(s.values, xs, laneH, laneBase, laneStep, opts, progress);
                        const isHovered = hover && hover.laneIdx === si;
                        return (
                            <g key={`lane${si}`} data-role="hz-lane" data-series={s.name} transform={`translate(0,${laneY})`}>
                                {/* レーン背景（縞で行を追いやすくする） */}
                                <rect
                                    data-role="hz-lane-bg"
                                    x={plotX}
                                    y={0}
                                    width={plotW}
                                    height={laneH}
                                    fill={isHovered ? pal.hoverLane : si % 2 === 0 ? pal.laneBg : pal.laneBgAlt}
                                />

                                {/* ホライズンバンド（下のバンドから順に塗り重ねる） */}
                                <g clipPath={`url(#hzClip${si})`}>
                                    {bands.map((bd, k) => (
                                        <path
                                            key={`b${k}`}
                                            data-role="hz-band"
                                            data-sign={bd.sign > 0 ? 'pos' : 'neg'}
                                            data-band={bd.band}
                                            d={bd.d}
                                            fill={bd.color}
                                        />
                                    ))}
                                </g>

                                {/* 系列名（レーン内・左） */}
                                {showLabels && laneH >= 9 && (
                                    <text
                                        data-role="hz-label"
                                        x={plotX - 6}
                                        y={laneH / 2 + fontSize * 0.35}
                                        textAnchor="end"
                                        fontSize={Math.min(fontSize, Math.max(8, laneH - 2))}
                                        fill={isHovered ? pal.text : pal.subText}
                                        fontWeight={isHovered ? 600 : 400}
                                    >
                                        {truncateToWidth(s.name, fontSize, labelW - 8)}
                                    </text>
                                )}

                                {/* 各レーンの最大値（右） */}
                                {showPeak && laneH >= 9 && (
                                    <text
                                        data-role="hz-peak"
                                        x={plotX + plotW + 6}
                                        y={laneH / 2 + fontSize * 0.35}
                                        textAnchor="start"
                                        fontSize={Math.min(fontSize, Math.max(8, laneH - 2))}
                                        fill={pal.subText}
                                    >
                                        {peakStrs[si]}
                                    </text>
                                )}

                                {/* レーン区切り線 */}
                                {opts.showLaneSeparator && (
                                    <line
                                        data-role="hz-sep"
                                        x1={plotX}
                                        y1={laneH}
                                        x2={plotX + plotW}
                                        y2={laneH}
                                        stroke={pal.separator}
                                        strokeWidth={1}
                                    />
                                )}

                                {/* ホバー中のレーンの値ドット */}
                                {isHovered && hover.ti !== null && Number.isFinite(s.values[hover.ti]) && (
                                    <circle
                                        data-role="hz-hoverdot"
                                        cx={xs[hover.ti]}
                                        cy={laneH - bandFraction(
                                            Math.abs(s.values[hover.ti] - laneBase),
                                            0,
                                            laneStep
                                        ) * laneH}
                                        r={2.5}
                                        fill={pal.crosshair}
                                    />
                                )}

                                {/* レーン全体のツールチップ（ネイティブ title） */}
                                <title>
                                    {`${s.name}: 最大 ${fmtValue(s.peak, opts.valueDecimals, false)} / 平均 ${fmtValue(
                                        s.mean,
                                        Math.max(opts.valueDecimals, 1),
                                        false
                                    )}${
                                        // 正規化時は最小値がそのレーンの基準になるので常に併記する
                                        opts.perSeriesScale || (Number.isFinite(s.trough) && s.trough < base)
                                            ? ` / 最小 ${fmtValue(s.trough, opts.valueDecimals, false)}`
                                            : ''
                                    }${opts.perSeriesScale ? `（このレーンの基準=${fmtValue(s.laneBase, opts.valueDecimals, false)}）` : ''}`}
                                </title>
                            </g>
                        );
                    })}

                    {/* 時刻軸 */}
                    {axisVisible && (
                        <g data-role="hz-axis">
                            <line
                                x1={plotX}
                                y1={plotY + lanesH + 0.5}
                                x2={plotX + plotW}
                                y2={plotY + lanesH + 0.5}
                                stroke={pal.axis}
                                strokeWidth={1}
                            />
                            {ticks.map((tk, k) => (
                                <text
                                    key={`tk${k}`}
                                    data-role="hz-tick"
                                    x={clamp(tk.x, plotX + 2, plotX + plotW - 2)}
                                    y={plotY + lanesH + 12}
                                    textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}
                                    fontSize={10}
                                    fill={pal.subText}
                                >
                                    {tk.label}
                                </text>
                            ))}
                        </g>
                    )}

                    {/* クロスヘア（全レーンを貫く縦線） */}
                    {opts.showCrosshair && hover && hover.ti !== null && (
                        <line
                            data-role="hz-crosshair"
                            x1={xs[hover.ti]}
                            y1={plotY}
                            x2={xs[hover.ti]}
                            y2={plotY + lanesH}
                            stroke={pal.crosshair}
                            strokeWidth={1}
                            strokeDasharray="3 2"
                            opacity={0.55}
                            style={{ pointerEvents: 'none' }}
                        />
                    )}
                </svg>
            </div>

            {/* 凡例（スクロール領域の外・常に表示） */}
            {legendH > 0 && (
                <svg width={w} height={legendH} style={{ display: 'block', flex: 'none' }}>
                    {legendVisible && (
                        <g data-role="hz-legend">
                            {legendBands.map((lb, k) => (
                                <rect
                                    key={`lg${k}`}
                                    data-role="hz-legend-band"
                                    data-band={lb.b}
                                    x={pad + k * 16}
                                    y={8}
                                    width={14}
                                    height={10}
                                    fill={rgbaCss(posRgb, lb.opacity)}
                                />
                            ))}
                            <text
                                data-role="hz-legend-text"
                                x={legendTextX}
                                y={17}
                                fontSize={10}
                                fill={pal.subText}
                            >
                                {legendLabel}
                            </text>
                            {/* 負側の色見本（実テキスト幅から位置を出すのでラベル長が変わってもずれない） */}
                            {opts.showNegative && legendNegX + 14 + estimateTextWidth('基準より下', 10) < w - pad && (
                                <>
                                    <rect
                                        data-role="hz-legend-neg"
                                        x={legendNegX}
                                        y={8}
                                        width={14}
                                        height={10}
                                        fill={rgbaCss(negRgb, 1)}
                                    />
                                    <text
                                        data-role="hz-legend-negtext"
                                        x={legendNegX + 18}
                                        y={17}
                                        fontSize={10}
                                        fill={pal.subText}
                                    >
                                        基準より下
                                    </text>
                                </>
                            )}
                        </g>
                    )}
                    {noteText && (
                        <text
                            data-role="hz-note"
                            x={w - pad}
                            y={legendVisible ? 17 : 11}
                            textAnchor="end"
                            fontSize={10}
                            fill={pal.subText}
                        >
                            {noteText}
                        </text>
                    )}
                </svg>
            )}

            {/* ホバー中の値表示（クロスヘア連動） */}
            {hoverInfo && (
                <div
                    data-role="hz-hoverinfo"
                    style={{
                        position: 'absolute',
                        left: pad,
                        top: pad,
                        pointerEvents: 'none',
                        background: pal.panelBg,
                        border: `1px solid ${pal.panelBorder}`,
                        borderRadius: 4,
                        padding: '3px 7px',
                        fontSize: 11,
                        color: pal.text,
                        whiteSpace: 'nowrap',
                        zIndex: 10,
                    }}
                >
                    {`${hoverInfo.time}　${hoverInfo.name}: ${
                        Number.isFinite(hoverInfo.value)
                            ? fmtValue(hoverInfo.value, opts.valueDecimals, false)
                            : 'データなし'
                    }`}
                </div>
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
                            seriesCount: model.series.length,
                            seriesNames: model.series.map((s) => s.name),
                            timeCount: model.times.length,
                            base: model.base,
                            step: model.step,
                            globalMaxDev: model.globalMaxDev,
                            hasRealTime: model.hasRealTime,
                            downsampled: model.downsampled,
                            truncatedSeries: model.truncatedSeries,
                            laneH,
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
            <HorizonChart mode={mode} />
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
