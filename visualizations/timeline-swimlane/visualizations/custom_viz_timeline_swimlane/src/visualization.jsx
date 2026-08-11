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
// Timeline Swimlane（タイムライン・スイムレーン）
//
// ホスト／ユーザー／プロセスなどのエンティティごとに「レーン」を作り、
// 各イベントを時刻順の帯（期間イベント）または点（瞬間イベント）で並べる。
// インシデント調査で最も欲しい「誰が・いつ・何をしたか」の時系列並置は
// Splunk 標準の timechart（集計されてしまう）や Events（レーン分割できない）
// では再現できない。
//
// データモデル:
//   レーン列 + 開始時刻列 [+ 終了時刻列] [+ 分類列] [+ ラベル列]
//     例: | stats min(_time) as start max(_time) as end by host, action
//     例: | table _time host action           （終了列なし = 点イベント）
//   時刻は epoch 秒 / epoch ミリ秒 / ISO 文字列 / Splunk の _time 形式を受ける。
//   列の明示選択（editor.columnSelector）は自動判定より優先。
//
// 分類（色分け）は分類列の値ごとに 8 色のパレットを巡回して割り当てる。
// 表示モードでは横方向ドラッグで時間範囲をブラシ選択でき（拡大）、
// ダブルクリックで全体に戻る。ブラシ範囲はオプションに保存され、
// 編集→保存でダッシュボード定義に永続化できる。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    laneField: '', // レーン（縦軸）フィールド（'' = 自動）
    startField: '', // 開始時刻フィールド（'' = 自動）
    endField: '', // 終了時刻フィールド（'' = 自動。無ければ点イベント）
    categoryField: '', // 分類（色分け）フィールド（'' = 自動）
    labelField: '', // ラベルフィールド（ツールチップ用）

    sortLanes: 'count', // レーンの並び順（count = 件数の多い順）
    maxLanes: 40, // レーンの最大数
    autoLaneHeight: true, // レーンの高さをパネル高さから自動計算
    laneMaxHeight: 60, // 自動時のレーン高さ上限（px）
    laneHeight: 26, // レーンの高さ（px、自動オフ時）
    minBarWidth: 3, // バーの最小幅（px）
    barRadius: 3, // バーの角丸（px）
    barOpacity: 0.9, // バーの不透明度

    showLaneLabels: true, // レーン名を表示
    showLaneCount: true, // レーン名の横に件数を表示
    showAxis: true, // 時間軸を表示
    showGrid: true, // グリッド線を表示
    showLegend: true, // 凡例を表示
    showBarLabels: false, // バーにラベルを表示
    stripeLanes: false, // レーンを縞模様で塗り分け（既定オフ。区切りはヘアライン）
    showCrosshair: true, // ホバー時に時刻クロスヘアを表示
    showNowLine: false, // 現在時刻の線を表示
    animate: true, // フェードインアニメーション

    enableBrush: true, // ドラッグで時間範囲を絞り込む
    brushStart: null, // ブラシ選択の開始（epoch ミリ秒）
    brushEnd: null, // ブラシ選択の終了（epoch ミリ秒）

    rangeStart: '', // 表示開始時刻（空欄 = データ最小）
    rangeEnd: '', // 表示終了時刻（空欄 = データ最大）
    padRangePercent: 2, // 時間軸の余白（％）
};

// 既定の分類パレット。色覚特性（第2色覚）でも隣接色が潰れないよう色相を広く取り、
// 明度も単調に振ってある（緑と青緑を並べない、赤と橙を隣に置かない）。
// editor.seriesColors が未設定・空・不正なときのフォールバック。
// config.json の optionsSchema.seriesColors.default と一致させること。
const DEFAULT_COLORS = [
    '#4c9be8', // 青
    '#26c2a5', // 青緑
    '#f2b53c', // 黄
    '#f2653f', // 橙赤
    '#a97bf0', // 紫
    '#f75d97', // 桃
    '#5ed4f0', // 空
    '#94a3b5', // 灰
];

// 描画上限
const MAX_LANES_HARD = 200;
const MAX_EVENTS = 20000;
// アニメーションを行うイベント数の上限（超過時は即時表示）
const MAX_ANIMATED_EVENTS = 3000;

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

// おおまかな相対輝度（0..1）。バー内テキストの白黒切替に使う
function luminance(c) {
    if (!c) return 0;
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
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
// 時刻パース（epoch 秒 / epoch ミリ秒 / ISO / Splunk _time 形式）
// ---------------------------------------------------------------------------

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// epoch と解釈してよい範囲（1990-01-01 〜 2100-01-01）
const EPOCH_S_MIN = 631152000;
const EPOCH_S_MAX = 4102444800;

// 戻り値: epoch ミリ秒（数値）／解釈できなければ NaN
function parseTime(v) {
    if (v === null || v === undefined) return NaN;
    if (v instanceof Date) return v.getTime();

    if (typeof v === 'number' && Number.isFinite(v)) return epochToMs(v);

    const s = String(v).trim();
    if (s === '') return NaN;

    // 純粋な数値文字列は epoch 秒／ミリ秒として扱う
    if (/^-?\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) return epochToMs(n);
    }

    // 日付のみ（YYYY-MM-DD）は UTC 解釈を避けてローカル日付として組み立てる
    if (ISO_DATE_ONLY_RE.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d).getTime();
    }

    // "2026-07-25 09:00:00" のようなスペース区切りは Safari 等で不安定なため T に寄せる。
    // タイムゾーン指定が無い場合はローカル時刻として解釈される（Splunk の _time 表示に合わせる）。
    const t1 = Date.parse(s.replace(' ', 'T'));
    if (Number.isFinite(t1)) return t1;
    const t2 = Date.parse(s);
    return Number.isFinite(t2) ? t2 : NaN;
}

// epoch 秒とミリ秒を桁数で判別
function epochToMs(n) {
    if (!Number.isFinite(n)) return NaN;
    const abs = Math.abs(n);
    if (abs >= EPOCH_S_MIN && abs <= EPOCH_S_MAX) return n * 1000; // 秒
    if (abs >= EPOCH_S_MIN * 1000 && abs <= EPOCH_S_MAX * 1000) return n; // ミリ秒
    return NaN;
}

// 列が時刻として解釈できるかの判定（サンプルの過半が時刻ならOK）
function looksLikeTimeColumn(rows, idx) {
    let ok = 0;
    let seen = 0;
    for (const r of rows) {
        const c = Array.isArray(r) ? r[idx] : undefined;
        if (c === null || c === undefined || c === '') continue;
        seen += 1;
        if (Number.isFinite(parseTime(c))) ok += 1;
        if (seen >= 40) break;
    }
    return seen > 0 && ok / seen >= 0.6;
}

const pad2 = (n) => String(n).padStart(2, '0');

// 期間の長さに応じて軸目盛りのラベル書式を決める
function makeTickFormatter(spanMs) {
    if (spanMs <= 0 || !Number.isFinite(spanMs)) return (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (spanMs < 2 * 60 * 1000) return (d) => `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (spanMs < 24 * 3600 * 1000) return (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (spanMs < 7 * 24 * 3600 * 1000) return (d) => `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (spanMs < 365 * 24 * 3600 * 1000) return (d) => `${d.getMonth() + 1}/${d.getDate()}`;
    return (d) => `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`;
}

// クロスヘアのチップ用。軸目盛りより1段細かく出す（軸が分なら秒まで見せる）
function makeScrubFormatter(spanMs) {
    if (spanMs < 24 * 3600 * 1000) {
        return (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }
    if (spanMs < 365 * 24 * 3600 * 1000) {
        return (d) => `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    return (d) => `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}

// ツールチップ用の完全な時刻表記
function fmtFullTime(ms) {
    if (!Number.isFinite(ms)) return '-';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
        d.getMinutes()
    )}:${pad2(d.getSeconds())}`;
}

// 期間の人間可読表記
function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}秒`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}分`;
    const h = m / 60;
    if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}時間`;
    return `${(h / 24).toFixed(1)}日`;
}

// 「切りのよい」目盛り間隔を選ぶ
const NICE_STEPS_MS = [
    1000, 2000, 5000, 10000, 15000, 30000,
    60000, 2 * 60000, 5 * 60000, 10 * 60000, 15 * 60000, 30 * 60000,
    3600000, 2 * 3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000,
    24 * 3600000, 2 * 24 * 3600000, 7 * 24 * 3600000, 14 * 24 * 3600000,
    30 * 24 * 3600000, 90 * 24 * 3600000, 180 * 24 * 3600000, 365 * 24 * 3600000,
];

function buildTicks(lo, hi, targetCount) {
    if (!(hi > lo)) return [];
    const rough = (hi - lo) / Math.max(targetCount, 1);
    let step = NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
    for (const s of NICE_STEPS_MS) {
        if (s >= rough) {
            step = s;
            break;
        }
    }
    const ticks = [];
    // 1日以上の間隔はローカル日付の境界に合わせる（UTC 基準の丸めだと日付がずれる）
    if (step >= 24 * 3600 * 1000) {
        const days = Math.round(step / (24 * 3600 * 1000));
        const d0 = new Date(lo);
        d0.setHours(0, 0, 0, 0);
        for (let t = d0.getTime(); t <= hi; ) {
            if (t >= lo) ticks.push(t);
            const d = new Date(t);
            d.setDate(d.getDate() + days);
            t = d.getTime();
            if (ticks.length > 200) break;
        }
        return ticks;
    }
    // 1日未満はローカルの日境界を起点に刻む（UTC 起点だと 30 分ずれの TZ で目盛りが半端になる）
    const base = new Date(lo);
    base.setHours(0, 0, 0, 0);
    const baseMs = base.getTime();
    const first = baseMs + Math.ceil((lo - baseMs) / step) * step;
    for (let t = first; t <= hi; t += step) {
        ticks.push(t);
        if (ticks.length > 200) break;
    }
    return ticks;
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
    const isHexColor = (v) => typeof v === 'string' && Boolean(hexToRgb(v.trim()));
    const fieldOr = (v) => (typeof v === 'string' || Array.isArray(v) ? v : '');
    const strOr = (v, d) => (typeof v === 'string' ? v : d);

    const out = {
        laneField: fieldOr(o.laneField),
        startField: fieldOr(o.startField),
        endField: fieldOr(o.endField),
        categoryField: fieldOr(o.categoryField),
        labelField: fieldOr(o.labelField),

        sortLanes: strOr(o.sortLanes, DEFAULTS.sortLanes),
        maxLanes: clamp(Math.round(numOr(o.maxLanes, DEFAULTS.maxLanes)), 1, MAX_LANES_HARD),
        autoLaneHeight: bool(o.autoLaneHeight, DEFAULTS.autoLaneHeight),
        laneMaxHeight: clamp(numOr(o.laneMaxHeight, DEFAULTS.laneMaxHeight), 10, 400),
        laneHeight: clamp(numOr(o.laneHeight, DEFAULTS.laneHeight), 8, 120),
        minBarWidth: clamp(numOr(o.minBarWidth, DEFAULTS.minBarWidth), 1, 40),
        barRadius: clamp(numOr(o.barRadius, DEFAULTS.barRadius), 0, 20),
        barOpacity: clamp(numOr(o.barOpacity, DEFAULTS.barOpacity), 0.1, 1),

        showLaneLabels: bool(o.showLaneLabels, DEFAULTS.showLaneLabels),
        showLaneCount: bool(o.showLaneCount, DEFAULTS.showLaneCount),
        showAxis: bool(o.showAxis, DEFAULTS.showAxis),
        showGrid: bool(o.showGrid, DEFAULTS.showGrid),
        showLegend: bool(o.showLegend, DEFAULTS.showLegend),
        showBarLabels: bool(o.showBarLabels, DEFAULTS.showBarLabels),
        stripeLanes: bool(o.stripeLanes, DEFAULTS.stripeLanes),
        showCrosshair: bool(o.showCrosshair, DEFAULTS.showCrosshair),
        showNowLine: bool(o.showNowLine, DEFAULTS.showNowLine),
        animate: bool(o.animate, DEFAULTS.animate),

        enableBrush: bool(o.enableBrush, DEFAULTS.enableBrush),
        brushStart: numOrNull(o.brushStart),
        brushEnd: numOrNull(o.brushEnd),

        rangeStart: strOr(o.rangeStart, ''),
        rangeEnd: strOr(o.rangeEnd, ''),
        padRangePercent: clamp(numOr(o.padRangePercent, DEFAULTS.padRangePercent), 0, 25),
    };

    // editor.seriesColors は hex 文字列の配列を生で渡してくる。要素数はユーザーが
    // 増減できるため、既定より短くても長くても壊れないようにする（消費側は % length）。
    // ⚠ 旧 color1..color8 は意図的に読まない（既定値は options に載らないホスト挙動のため、
    //    旧キーへフォールバックすると「既定値を選んだときだけ直らない」不具合になる）。
    const palette = Array.isArray(o.seriesColors)
        ? o.seriesColors.filter(isHexColor).map((c) => c.trim())
        : [];
    out.palette = palette.length > 0 ? palette : DEFAULT_COLORS.slice();

    // ブラシ範囲は逆転していたら入れ替え、幅ゼロなら無効化
    if (out.brushStart !== null && out.brushEnd !== null) {
        if (out.brushEnd < out.brushStart) {
            const t = out.brushStart;
            out.brushStart = out.brushEnd;
            out.brushEnd = t;
        }
        if (out.brushEnd - out.brushStart < 1) {
            out.brushStart = null;
            out.brushEnd = null;
        }
    } else {
        out.brushStart = null;
        out.brushEnd = null;
    }

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
// モデル構築（rows → {lanes, events, tMin, tMax, categories}）
// ---------------------------------------------------------------------------

// 時刻列らしい名前（自動判定の優先度づけに使う）
const START_NAME_RE = /^(_?time|start|starttime|start_time|begin|first|firsttime|_?earliest|min\(_time\))$/i;
const END_NAME_RE = /^(end|endtime|end_time|finish|last|lasttime|_?latest|max\(_time\))$/i;

function buildModel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows).filter((r) => Array.isArray(r));
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length === 0 || colCount === 0) return { error: 'empty' };

    // --- 列の解決 ---------------------------------------------------------
    const selLane = resolveFieldIndex(opts.laneField, fieldNames, rows, -1);
    const selStart = resolveFieldIndex(opts.startField, fieldNames, rows, -1);
    const selEnd = resolveFieldIndex(opts.endField, fieldNames, rows, -1);
    const selCat = resolveFieldIndex(opts.categoryField, fieldNames, rows, -1);
    const selLabel = resolveFieldIndex(opts.labelField, fieldNames, rows, -1);

    // 時刻として使える列を洗い出す
    const timeCols = [];
    for (let i = 0; i < colCount; i += 1) {
        if (looksLikeTimeColumn(rows, i)) timeCols.push(i);
    }

    // 開始列: 明示選択 > 名前が start/_time 系 > 最初の時刻列
    let startIdx = selStart;
    if (startIdx < 0) {
        startIdx = timeCols.find((i) => START_NAME_RE.test(fieldNames[i] || '')) ?? -1;
        if (startIdx < 0) startIdx = timeCols.length > 0 ? timeCols[0] : -1;
    }
    if (startIdx < 0) return { error: 'notime' };

    // 終了列: 明示選択 > 名前が end 系 > 開始列以外の時刻列
    let endIdx = selEnd;
    if (endIdx < 0) {
        endIdx = timeCols.find((i) => i !== startIdx && END_NAME_RE.test(fieldNames[i] || '')) ?? -1;
        if (endIdx < 0) endIdx = timeCols.find((i) => i !== startIdx) ?? -1;
    }
    if (endIdx === startIdx) endIdx = -1;

    // レーン列: 明示選択 > 時刻列以外の最初の非数値列 > 時刻列以外の最初の列
    const isTimeCol = (i) => i === startIdx || i === endIdx;
    const isNumericCol = (i) => rows.some((r) => Number.isFinite(parseNum(r[i])));
    let laneIdx = selLane;
    if (laneIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (!isTimeCol(i) && !isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) {
                laneIdx = i;
                break;
            }
        }
        if (laneIdx < 0) {
            for (let i = 0; i < colCount; i += 1) {
                if (!isTimeCol(i)) {
                    laneIdx = i;
                    break;
                }
            }
        }
    }

    // 分類列: 明示選択 > レーン列・時刻列以外の最初の非数値列（無ければ分類なし）
    let catIdx = selCat;
    if (catIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (i !== laneIdx && !isTimeCol(i) && !isNumericCol(i) && !(fieldNames[i] || '').startsWith('_')) {
                catIdx = i;
                break;
            }
        }
    }

    // ラベル列: 明示選択のみ（自動では選ばない）
    const labelIdx = selLabel;

    // --- イベント化 -------------------------------------------------------
    const events = [];
    let tMin = Infinity;
    let tMax = -Infinity;
    let skipped = 0;
    let anyDuration = false;

    for (const r of rows) {
        if (events.length >= MAX_EVENTS) {
            skipped += 1;
            continue;
        }
        const s = parseTime(r[startIdx]);
        if (!Number.isFinite(s)) {
            skipped += 1;
            continue;
        }
        let e = endIdx >= 0 ? parseTime(r[endIdx]) : NaN;
        if (!Number.isFinite(e) || e < s) e = s; // 終了が無い／逆転なら点イベント扱い
        if (e > s) anyDuration = true;

        const rawLane = laneIdx >= 0 ? r[laneIdx] : null;
        const lane = rawLane === null || rawLane === undefined || rawLane === '' ? '(なし)' : String(rawLane);
        const rawCat = catIdx >= 0 ? r[catIdx] : null;
        const cat = rawCat === null || rawCat === undefined || rawCat === '' ? '' : String(rawCat);
        const rawLabel = labelIdx >= 0 ? r[labelIdx] : null;
        const label = rawLabel === null || rawLabel === undefined ? '' : String(rawLabel);

        if (s < tMin) tMin = s;
        if (e > tMax) tMax = e;
        events.push({ lane, cat, label, s, e });
    }

    if (events.length === 0) return { error: 'notime' };

    // --- レーン集約 -------------------------------------------------------
    const laneMap = new Map();
    for (const ev of events) {
        let info = laneMap.get(ev.lane);
        if (!info) {
            info = { name: ev.lane, count: 0, first: Infinity, last: -Infinity, order: laneMap.size };
            laneMap.set(ev.lane, info);
        }
        info.count += 1;
        if (ev.s < info.first) info.first = ev.s;
        if (ev.e > info.last) info.last = ev.e;
    }

    let lanes = Array.from(laneMap.values());
    if (opts.sortLanes === 'count') {
        lanes.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    } else if (opts.sortLanes === 'name') {
        lanes.sort((a, b) => a.name.localeCompare(b.name));
    } else if (opts.sortLanes === 'first') {
        lanes.sort((a, b) => a.first - b.first || a.name.localeCompare(b.name));
    } else {
        lanes.sort((a, b) => a.order - b.order);
    }

    const truncatedLanes = lanes.length > opts.maxLanes;
    if (truncatedLanes) lanes = lanes.slice(0, opts.maxLanes);

    const laneIndex = new Map(lanes.map((l, i) => [l.name, i]));
    const visibleEvents = events.filter((ev) => laneIndex.has(ev.lane));
    for (const ev of visibleEvents) ev.laneIdx = laneIndex.get(ev.lane);

    // --- 分類（色の割り当ては出現順） ------------------------------------
    const catOrder = [];
    const catSeen = new Set();
    for (const ev of visibleEvents) {
        if (ev.cat !== '' && !catSeen.has(ev.cat)) {
            catSeen.add(ev.cat);
            catOrder.push(ev.cat);
        }
    }
    const catIndex = new Map(catOrder.map((c, i) => [c, i]));
    for (const ev of visibleEvents) ev.catIdx = ev.cat === '' ? -1 : catIndex.get(ev.cat);

    // レーン内で時刻順に並べる（重なりの前後関係を安定させる）
    visibleEvents.sort((a, b) => a.laneIdx - b.laneIdx || a.s - b.s);

    return {
        lanes,
        events: visibleEvents,
        categories: catOrder,
        tMin,
        tMax,
        anyDuration,
        truncatedLanes,
        totalLanes: laneMap.size,
        skipped,
        usedIdx: { laneIdx, startIdx, endIdx, catIdx, labelIdx },
    };
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

// 配色の考え方: 図の主役はイベントバーなので、目盛り・区切り・レーン地は
// 「あることが分かる最小の強さ」まで落とす。グリッドは全高の線ではなく軸際の
// 短い刻みにし、レーン地はヘアラインの区切りだけにする（縞は既定オフ）。
function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#e3e8ee',
            subText: '#8b98a5',
            faintText: '#66727f',
            axis: 'rgba(139,152,165,0.28)',
            grid: 'rgba(139,152,165,0.10)',
            laneStripe: 'rgba(139,152,165,0.045)',
            laneLine: 'rgba(139,152,165,0.12)',
            laneHover: 'rgba(139,152,165,0.07)',
            barTextDark: '#12161a',
            barTextLight: '#f5f7fa',
            nowLine: '#f2b53c',
            crosshair: 'rgba(227,232,238,0.55)',
            crosshairChipBg: 'rgba(20,26,32,0.94)',
            crosshairChipText: '#e3e8ee',
            brushFill: 'rgba(76,155,232,0.14)',
            brushStroke: 'rgba(76,155,232,0.85)',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
        };
    }
    return {
        text: '#1e2429',
        subText: '#5c6773',
        faintText: '#8b98a5',
        axis: 'rgba(92,103,115,0.30)',
        grid: 'rgba(92,103,115,0.11)',
        laneStripe: 'rgba(92,103,115,0.038)',
        laneLine: 'rgba(92,103,115,0.11)',
        laneHover: 'rgba(92,103,115,0.06)',
        barTextDark: '#12161a',
        barTextLight: '#f5f7fa',
        nowLine: '#c77f1a',
        crosshair: 'rgba(30,36,41,0.45)',
        crosshairChipBg: 'rgba(255,255,255,0.96)',
        crosshairChipText: '#1e2429',
        brushFill: 'rgba(76,155,232,0.12)',
        brushStroke: 'rgba(76,155,232,0.8)',
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
// スピナー永久表示（サーチ完了通知の取りこぼし）対策
//
// 公式 useDataSources は「render 時に getDataSources() でシード → useEffect で購読」
// の構造で、シードと購読の間に届いた更新を取り逃す（ホストは購読登録時に現在値を
// 再送しない。実機確認済み）。取り逃したのがサーチ完了の最終通知だと、以後更新が
// 来ないため loading:true のまま固まり、スピナーが回り続ける。
// 対策として、公式フックが loading の間は getDataSources() を定期的に読み直し、
// ホスト側がすでに完了していればその値を採用する。完了後は何もしない（コストゼロ）。
// ---------------------------------------------------------------------------

const RESCUE_POLL_MS = 500;

function useDataSourcesWithRescue() {
    const official = useDataSources();
    const [rescue, setRescue] = useState(null);
    const officialLoading = Boolean(official?.loading);

    useEffect(() => {
        if (!officialLoading) return undefined;
        setRescue(null); // 新しいロードサイクル。前回の回収値は使わない
        let timer = 0;
        const tick = () => {
            try {
                const cur = globalThis.DashboardExtensionAPI?.getDataSources?.();
                if (cur && !cur.loading) {
                    setRescue(cur); // ホストは完了済み＝最終通知を取り逃していた。回収して終了
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

function TimelineSwimlane({ mode }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
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
    const [dims, setDims] = useState({ w: 720, h: 400 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 720;
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

    // ブラシ（ドラッグ中の一時状態。確定時に setOptions へ保存）
    const [drag, setDrag] = useState(null); // { x0, x1 }
    // スクラブ用クロスヘア（ホバー中のカーソルX。縦スライスの相関読み取りが主目的）
    const [scrubX, setScrubX] = useState(null);
    // 表示モードの setOptions はホスト定義に載らないため、ローカル draft でライブプレビューする
    const [brushDraft, setBrushDraft] = useState(null); // { start, end } | 'clear' | null
    const pendingRef = useRef(null);

    // 編集モードに切り替わった瞬間に未反映のブラシ範囲を再送（表示モードの setOptions は永続化されない）
    useEffect(() => {
        if (!setOptions) return;
        const p = pendingRef.current;
        if (!p) return;
        const same =
            (p.brushStart === null && opts.brushStart === null && p.brushEnd === null && opts.brushEnd === null) ||
            (p.brushStart === opts.brushStart && p.brushEnd === opts.brushEnd);
        if (same) pendingRef.current = null;
    }, [opts.brushStart, opts.brushEnd, setOptions]);

    // アニメーション（データの形が変わったら再生）
    const signature = useMemo(
        () => (model.error ? '' : `${model.lanes.length}:${model.events.length}:${model.tMin}:${model.tMax}`),
        [model]
    );
    const progress = useFadeProgress(
        signature,
        opts.animate && !model.error && model.events.length <= MAX_ANIMATED_EVENTS
    );

    const applyBrush = useCallback(
        (start, end) => {
            const next = start === null ? { brushStart: null, brushEnd: null } : { brushStart: start, brushEnd: end };
            setBrushDraft(start === null ? 'clear' : { start, end });
            pendingRef.current = next;
            if (setOptions) {
                try {
                    setOptions(next);
                } catch (e) {
                    /* 表示モードでは無視されることがある */
                }
            }
        },
        [setOptions]
    );

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
            <CenterMessage>
                時刻フィールドが見つかりません。開始時刻フィールドの選択を確認してください（_time / epoch 秒 / ISO 形式に対応）。
            </CenterMessage>
        );
    }

    const { w, h } = dims;
    const pal = chartColors(mode);
    const { lanes, events, categories } = model;
    const nLanes = lanes.length;

    const pad = 8;
    const labelFont = 11;

    // --- 表示する時間範囲（優先度: ブラシ > 固定範囲オプション > データ全体） ---
    const fixedLo = opts.rangeStart ? parseTime(opts.rangeStart) : NaN;
    const fixedHi = opts.rangeEnd ? parseTime(opts.rangeEnd) : NaN;

    let baseLo = Number.isFinite(fixedLo) ? fixedLo : model.tMin;
    let baseHi = Number.isFinite(fixedHi) ? fixedHi : model.tMax;
    if (!(baseHi > baseLo)) {
        // 全イベントが同時刻（点イベント1件など）のときは前後に幅を持たせる
        const half = Math.max((Math.abs(baseLo) || 1) * 0, 30000);
        baseLo -= half;
        baseHi += half;
    } else if (opts.padRangePercent > 0 && !Number.isFinite(fixedLo) && !Number.isFinite(fixedHi)) {
        const padMs = (baseHi - baseLo) * (opts.padRangePercent / 100);
        baseLo -= padMs;
        baseHi += padMs;
    }

    // ブラシは draft（表示モードのライブプレビュー）を options より優先
    let brush = null;
    if (brushDraft === 'clear') {
        brush = null;
    } else if (brushDraft && typeof brushDraft === 'object') {
        brush = { start: brushDraft.start, end: brushDraft.end };
    } else if (opts.brushStart !== null && opts.brushEnd !== null) {
        brush = { start: opts.brushStart, end: opts.brushEnd };
    }

    let viewLo = baseLo;
    let viewHi = baseHi;
    if (brush && brush.end > brush.start) {
        viewLo = brush.start;
        viewHi = brush.end;
    }
    const viewSpan = Math.max(viewHi - viewLo, 1);
    const zoomed = Boolean(brush) && (viewLo > baseLo || viewHi < baseHi);

    // --- レイアウト -------------------------------------------------------
    const axisH = opts.showAxis ? 20 : 0;
    const legendH = opts.showLegend && categories.length > 0 ? 22 : 0;
    const noteH = model.truncatedLanes || model.skipped > 0 || zoomed ? 15 : 0;

    // レーン名の幅（実ラベルの推定幅から算出。収まらなければ段階的に退避）
    const laneLabelTexts = lanes.map((l) => (opts.showLaneCount ? `${l.name} (${l.count})` : l.name));
    let showLaneLabels = opts.showLaneLabels && w >= 160;
    const maxLaneW = laneLabelTexts.reduce((m, t) => Math.max(m, estimateTextWidth(t, labelFont)), 0);
    // 余白は「ラベル本体 + 左右のアキ(10px) + 端の余裕(4px)」。truncateToWidth へ渡す
    // 有効幅と揃えておかないと、収まるはずのラベルが … で切られる。
    let laneLabelW = showLaneLabels ? Math.ceil(clamp(maxLaneW + 14, 40, w * 0.3)) : 0;
    if (w - pad * 2 - laneLabelW < 80) {
        laneLabelW = Math.min(laneLabelW, Math.max(40, w * 0.2));
        if (w - pad * 2 - laneLabelW < 80) {
            showLaneLabels = false;
            laneLabelW = 0;
        }
    }

    const plotX = pad + laneLabelW;
    const plotW = Math.max(w - plotX - pad, 24);

    // レーン高さ:
    //   自動（既定）… 領域の高さをレーン数で割って広げる。ただし laneMaxHeight を上限に
    //                  し、1〜2レーンのときに極端に太いバーにならないようにする。
    //   手動        … laneHeight を固定値として使う。
    // どちらの場合も、入りきらなければ最低 10px まで詰めて縦スクロールへ退避する。
    const availH = h - pad * 2 - axisH - legendH - noteH;
    let laneH;
    if (opts.autoLaneHeight) {
        laneH = clamp(availH / nLanes, 10, opts.laneMaxHeight);
    } else {
        laneH = opts.laneHeight;
        if (nLanes * laneH > availH) laneH = Math.max(availH / nLanes, 10);
    }
    const plotH = laneH * nLanes;
    // 上限に当たって余白が残る場合は、プロット全体を上下中央に寄せる（下だけ空くのを防ぐ）
    const slack = Math.max(availH - plotH, 0);
    const plotY = pad + (opts.autoLaneHeight ? slack / 2 : 0);
    const scrolls = plotH > availH + 0.5;
    const contentH = plotY + plotH + axisH + pad;

    const xOf = (t) => plotX + ((t - viewLo) / viewSpan) * plotW;
    const tOfX = (x) => viewLo + ((x - plotX) / plotW) * viewSpan;

    // --- 目盛り -----------------------------------------------------------
    const tickFmt = makeTickFormatter(viewSpan);
    const scrubChipFmt = makeScrubFormatter(viewSpan);
    const targetTicks = clamp(Math.floor(plotW / 90), 2, 12);
    const ticks = opts.showAxis || opts.showGrid ? buildTicks(viewLo, viewHi, targetTicks) : [];

    // --- バーの描画情報 ---------------------------------------------------
    const barPad = clamp(laneH * 0.18, 1, 6);
    const barH = Math.max(laneH - barPad * 2, 2);
    const rx = Math.min(opts.barRadius, barH / 2);
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const colorOfCat = (catIdx) => {
        if (catIdx === null || catIdx === undefined || catIdx < 0) return opts.palette[0];
        return opts.palette[catIdx % opts.palette.length];
    };

    // 表示範囲に重なるイベントだけ描く
    const visible = events.filter((ev) => ev.e >= viewLo && ev.s <= viewHi);

    const barLabelFont = Math.min(11, Math.floor(barH * 0.72));
    const showBarLabels = opts.showBarLabels && barLabelFont >= 8;

    // --- スクラブ用クロスヘア -------------------------------------------
    // ホバー位置の縦線に触れるバーを「その瞬間に起きていたこと」として強調する。
    // 点イベントは幅が細く線に当たりにくいので、判定だけ左右に少し余裕を持たせる。
    const scrubbing = opts.showCrosshair && scrubX !== null && !drag;
    const SCRUB_TOLERANCE = 3;
    const scrubHit = (ev, bx0, bx1) =>
        scrubbing && scrubX >= bx0 - SCRUB_TOLERANCE && scrubX <= bx1 + SCRUB_TOLERANCE;
    const scrubTime = scrubbing ? tOfX(scrubX) : null;
    const scrubHitCount = scrubbing
        ? visible.filter((ev) => {
              const bx0 = xOf(Math.max(ev.s, viewLo));
              const bx1 = bx0 + Math.max(xOf(Math.min(ev.e, viewHi)) - bx0, opts.minBarWidth);
              return scrubHit(ev, bx0, bx1);
          }).length
        : 0;

    const tipOf = (ev) => {
        const dur = ev.e > ev.s ? `\n期間: ${fmtDuration(ev.e - ev.s)}` : '';
        const catLine = ev.cat ? `\n分類: ${ev.cat}` : '';
        const labelLine = ev.label ? `\n${ev.label}` : '';
        const endLine = ev.e > ev.s ? `\n終了: ${fmtFullTime(ev.e)}` : '';
        return `${ev.lane}${catLine}\n開始: ${fmtFullTime(ev.s)}${endLine}${dur}${labelLine}`;
    };

    // --- ブラシ操作 -------------------------------------------------------
    // 座標は必ずハンドラ本体で確定させる。setDrag の更新関数の中で evt を読むと、
    // React が合成イベントを再利用した後に評価されて currentTarget が null になる。
    const localX = (evt) => {
        const target = evt.currentTarget;
        const svg = (target && (target.ownerSVGElement || target)) || null;
        const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0 };
        return clamp(evt.clientX - rect.left, plotX, plotX + plotW);
    };

    const onBrushDown = (evt) => {
        if (!opts.enableBrush || evt.button !== 0) return;
        const x = localX(evt);
        setDrag({ x0: x, x1: x });
    };
    const onBrushMove = (evt) => {
        const x = localX(evt);
        setScrubX(x); // クロスヘアはドラッグ中かどうかに関わらず追従させる
        if (!drag) return;
        setDrag((d) => (d ? { ...d, x1: x } : d));
    };
    const onBrushUp = () => {
        if (!drag) return;
        const { x0, x1 } = drag;
        setDrag(null);
        if (Math.abs(x1 - x0) < 4) return; // クリック扱い（選択しない）
        const a = tOfX(Math.min(x0, x1));
        const b = tOfX(Math.max(x0, x1));
        applyBrush(a, b);
    };
    const onLeave = () => {
        setScrubX(null);
        onBrushUp();
    };
    // mouseleave は環境によって拾えないことがあるため mouseout でも退出を検知する。
    // ただし mouseout は子要素間の移動でも飛ぶので、SVG の外へ出たときだけ処理する。
    const onMouseOut = (evt) => {
        const to = evt.relatedTarget;
        const svg = evt.currentTarget;
        if (to && svg && typeof svg.contains === 'function' && svg.contains(to)) return;
        onLeave();
    };
    const onDoubleClick = () => {
        if (brush) applyBrush(null, null);
    };

    const notes = [];
    if (model.truncatedLanes) notes.push(`※ レーン上限（${opts.maxLanes}）を超えたため ${model.totalLanes} 中 ${nLanes} を表示`);
    if (model.skipped > 0) notes.push(`※ 時刻を解釈できない ${model.skipped} 行を除外`);
    if (zoomed) notes.push('※ 時間範囲を絞り込み中（ダブルクリックで解除）');

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
                    style={{ display: 'block', cursor: opts.enableBrush ? 'crosshair' : 'default' }}
                    onMouseDown={onBrushDown}
                    onMouseMove={onBrushMove}
                    onMouseUp={onBrushUp}
                    onMouseLeave={onLeave}
                    onMouseOut={onMouseOut}
                    onDoubleClick={onDoubleClick}
                >
                    {/* レーンの地（縞は既定オフ。区切りはヘアライン1本だけ） */}
                    {lanes.map((lane, i) => (
                        <g key={`lane${i}`}>
                            {opts.stripeLanes && i % 2 === 1 && (
                                <rect
                                    data-role="tl-lane-stripe"
                                    x={plotX}
                                    y={plotY + i * laneH}
                                    width={plotW}
                                    height={laneH}
                                    fill={pal.laneStripe}
                                />
                            )}
                            {/* レーン間のヘアライン（先頭レーンの上には引かない） */}
                            {i > 0 && (
                                <line
                                    data-role="tl-lane-sep"
                                    x1={plotX}
                                    y1={plotY + i * laneH + 0.5}
                                    x2={plotX + plotW}
                                    y2={plotY + i * laneH + 0.5}
                                    stroke={pal.laneLine}
                                    strokeWidth={1}
                                />
                            )}
                            {showLaneLabels && (
                                <text
                                    data-role="tl-lane-label"
                                    x={plotX - 10}
                                    y={plotY + i * laneH + laneH / 2 + labelFont * 0.35}
                                    textAnchor="end"
                                    fontSize={labelFont}
                                    fill={pal.text}
                                    letterSpacing="0.01em"
                                >
                                    {truncateToWidth(laneLabelTexts[i], labelFont, laneLabelW - 12)}
                                    <title>{`${lane.name}（${lane.count} 件）`}</title>
                                </text>
                            )}
                        </g>
                    ))}

                    {/* 目盛りの刻み（全高のグリッド線はデータと競合するので軸際だけに留める） */}
                    {opts.showGrid &&
                        ticks.map((t) => (
                            <line
                                key={`g${t}`}
                                data-role="tl-grid"
                                x1={xOf(t)}
                                y1={plotY}
                                x2={xOf(t)}
                                y2={plotY + plotH}
                                stroke={pal.grid}
                                strokeWidth={1}
                            />
                        ))}

                    {/* イベントバー */}
                    {visible.map((ev, k) => {
                        const x0 = xOf(Math.max(ev.s, viewLo));
                        const x1 = xOf(Math.min(ev.e, viewHi));
                        const bw = Math.max(x1 - x0, opts.minBarWidth);
                        const by = plotY + ev.laneIdx * laneH + barPad;
                        const fill = colorOfCat(ev.catIdx);
                        let op =
                            progress >= 1
                                ? opts.barOpacity
                                : opts.barOpacity * ease(clamp01((progress - (ev.laneIdx / Math.max(nLanes, 1)) * 0.3) / 0.7));
                        // スクラブ中: クロスヘアが横切るバーだけを残し、他は退かせる。
                        // これが「その瞬間に誰が何をしていたか」を縦一列で読ませる仕掛け。
                        const hit = scrubHit(ev, x0, x0 + bw);
                        if (scrubbing && !hit) op *= 0.28;
                        const label = ev.label || ev.cat;
                        const canLabel = showBarLabels && label && estimateTextWidth(label, barLabelFont) + 6 <= bw;
                        return (
                            <g key={`e${k}`}>
                                <rect
                                    data-role="tl-bar"
                                    data-lane={ev.laneIdx}
                                    data-cat={ev.catIdx}
                                    data-hit={hit ? '1' : '0'}
                                    x={x0}
                                    y={by}
                                    width={bw}
                                    height={barH}
                                    rx={rx}
                                    fill={fill}
                                    opacity={op}
                                >
                                    <title>{tipOf(ev)}</title>
                                </rect>
                                {canLabel && (
                                    <text
                                        data-role="tl-bar-label"
                                        x={x0 + bw / 2}
                                        y={by + barH / 2 + barLabelFont * 0.35}
                                        textAnchor="middle"
                                        fontSize={barLabelFont}
                                        fill={luminance(hexToRgb(fill)) > 0.55 ? pal.barTextDark : pal.barTextLight}
                                        opacity={op}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {label}
                                    </text>
                                )}
                            </g>
                        );
                    })}

                    {/* 現在時刻の線 */}
                    {opts.showNowLine &&
                        (() => {
                            const now = Date.now();
                            if (now < viewLo || now > viewHi) return null;
                            return (
                                <line
                                    data-role="tl-now"
                                    x1={xOf(now)}
                                    y1={plotY}
                                    x2={xOf(now)}
                                    y2={plotY + plotH}
                                    stroke={pal.nowLine}
                                    strokeWidth={1.5}
                                    strokeDasharray="4 3"
                                />
                            );
                        })()}

                    {/* スクラブ用クロスヘア（縦スライスの読み取り） */}
                    {scrubbing &&
                        (() => {
                            const chipText = scrubChipFmt(new Date(scrubTime));
                            const chipW = Math.ceil(estimateTextWidth(chipText, 10)) + 14;
                            const chipH = 17;
                            // 端に寄ったらチップを内側へ折り返す（見切れ防止）
                            let chipX = scrubX - chipW / 2;
                            chipX = clamp(chipX, plotX, plotX + plotW - chipW);
                            const chipY = plotY + plotH + 2;
                            return (
                                <g style={{ pointerEvents: 'none' }}>
                                    <line
                                        data-role="tl-crosshair"
                                        x1={scrubX}
                                        y1={plotY}
                                        x2={scrubX}
                                        y2={plotY + plotH}
                                        stroke={pal.crosshair}
                                        strokeWidth={1}
                                    />
                                    {axisH > 0 && (
                                        <g data-role="tl-crosshair-chip">
                                            <rect
                                                x={chipX}
                                                y={chipY}
                                                width={chipW}
                                                height={chipH}
                                                rx={3}
                                                fill={pal.crosshairChipBg}
                                                stroke={pal.crosshair}
                                                strokeWidth={0.5}
                                            />
                                            <text
                                                x={chipX + chipW / 2}
                                                y={chipY + chipH / 2 + 3.5}
                                                textAnchor="middle"
                                                fontSize={10}
                                                fontWeight={600}
                                                fill={pal.crosshairChipText}
                                            >
                                                {chipText}
                                            </text>
                                        </g>
                                    )}
                                </g>
                            );
                        })()}

                    {/* ドラッグ中のブラシ矩形 */}
                    {drag && Math.abs(drag.x1 - drag.x0) >= 2 && (
                        <rect
                            data-role="tl-brush"
                            x={Math.min(drag.x0, drag.x1)}
                            y={plotY}
                            width={Math.abs(drag.x1 - drag.x0)}
                            height={plotH}
                            fill={pal.brushFill}
                            stroke={pal.brushStroke}
                            strokeWidth={1}
                            style={{ pointerEvents: 'none' }}
                        />
                    )}

                    {/* 時間軸 */}
                    {opts.showAxis && (
                        <g>
                            <line
                                data-role="tl-axis"
                                x1={plotX}
                                y1={plotY + plotH + 0.5}
                                x2={plotX + plotW}
                                y2={plotY + plotH + 0.5}
                                stroke={pal.axis}
                                strokeWidth={1}
                            />
                            {ticks.map((t) => (
                                <g key={`t${t}`}>
                                    <line
                                        x1={xOf(t)}
                                        y1={plotY + plotH}
                                        x2={xOf(t)}
                                        y2={plotY + plotH + 3}
                                        stroke={pal.axis}
                                        strokeWidth={1}
                                    />
                                    <text
                                        data-role="tl-tick"
                                        x={xOf(t)}
                                        y={plotY + plotH + 14}
                                        textAnchor="middle"
                                        fontSize={10}
                                        fill={scrubbing ? pal.faintText : pal.subText}
                                        letterSpacing="0.04em"
                                    >
                                        {tickFmt(new Date(t))}
                                    </text>
                                </g>
                            ))}
                        </g>
                    )}
                </svg>
            </div>

            {/* 凡例（スクロール領域の外・常に表示） */}
            {legendH > 0 && (
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
                    {categories.map((c, i) => (
                        <span
                            key={c}
                            data-role="tl-legend-item"
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
                            <span
                                style={{
                                    fontSize: 11,
                                    color: pal.subText,
                                    whiteSpace: 'nowrap',
                                    letterSpacing: '0.01em',
                                }}
                            >
                                {c}
                            </span>
                        </span>
                    ))}
                    {/* スクラブ中はその時刻に重なっているイベント数を右端に出す */}
                    {scrubbing && scrubHitCount > 0 && (
                        <span
                            data-role="tl-scrub-count"
                            style={{
                                marginLeft: 'auto',
                                flex: 'none',
                                fontSize: 11,
                                color: pal.text,
                                whiteSpace: 'nowrap',
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            {scrubChipFmt(new Date(scrubTime))} — {scrubHitCount} 件
                        </span>
                    )}
                </div>
            )}

            {/* 注記 */}
            {noteH > 0 && (
                <div
                    data-role="tl-note"
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
            <TimelineSwimlane mode={mode} />
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

// DPX（apps/dpx）が iframe なしでこの viz をホストする場合の受け渡し口。
// `export` を使わないのは、esbuild が成果物末尾に export{} を出力して
// Studio の iframe が SyntaxError になるため（実機で確認済み）。
// DPX 側は host.jsx がこのファイルを副作用 import してから受け取る。
globalThis.__TIMELINE_SWIMLANE_APP__ = App;

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
