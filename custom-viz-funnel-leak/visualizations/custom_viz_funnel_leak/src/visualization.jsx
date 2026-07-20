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
// Funnel Leak（アニメ付きファネル×リーク図）
//
// 標準の「円」「横棒」やサンキーでは表せない「ファネルの各段で "どこで・どれだけ"
// 離脱したか」を、通過フロー（下方向に流れる粒子）と離脱フロー（左右にこぼれ落ちる
// 粒子）で可視化する。コンバージョン分析、ログイン→購入、攻撃チェーンの生存分析など。
//
// データモデル（1行 = 1ステップ、行順が上→下の段順）:
//   ステップ列 = 段階名（文字列）      … 既定は第1列
//   件数列     = その段に到達した件数   … 既定は最終列
// フィールドは editor.columnSelector で選択可（DOS 文字列で届くので自前パース）。
//
// 各段のバー幅 ∝ 件数（最大＝先頭段を基準に相対化）。段 i→i+1 の通過ぶんは下へ、
// 離脱ぶん（count[i] − count[i+1]）は左右にこぼれる帯として描く。粒子の量・速度は
// フロー量に連動。60fps の位置更新は rAF で setAttribute 直更新（React は構造/色のみ）。
//
// 表示はコンテナ実寸に自動フィット（ResizeObserver、無い環境は初回計測フォールバック）。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    stepField: '', // 段階名フィールド（'' = 第1列）
    valueField: '', // 件数フィールド（'' = 最終列）

    flowColor: '#3b82f6', // 通過フローの色
    leakColor: '#ef4d4d', // 離脱（リーク）の色
    useRateColors: false, // 通過率で段の色を変える
    lowColor: '#ef4d4d', // 低い通過率の色
    highColor: '#3fb950', // 高い通過率の色

    animationPeriod: 6, // 粒子が1周する秒数（0 で停止）
    particleDensity: 50, // 粒子密度 1〜100

    barThickness: 46, // バーの太さ px（0 で自動）
    stepGap: 54, // 段の縦間隔 px（0 で自動）
    cornerRadius: 8, // 角の丸み px
    leakWidth: 34, // リークの帯の最大幅 px

    showFlowBands: false, // 粒子の下に敷くリボン/リーク帯の塗り（既定OFF＝粒子のみ）
    showStepLabels: true, // 段階名を表示
    showCounts: true, // 件数を表示
    showRate: true, // 通過率を表示
    showLeak: true, // 離脱（リーク）を表示（粒子・離脱数）
    showOverallRate: true, // 総合通過率ヘッダー
    labelSize: 0, // ラベル px（0 = 自動）

    highlightOnHover: true, // ホバーで段をハイライト
    showHeader: true, // サマリーヘッダー
    debug: false, // options デバッグ表示
};

// テーマ別パレット
function palette(mode) {
    if (mode === 'dark') {
        return {
            text: '#e6edf3',
            subText: '#8b98a5',
            grid: 'rgba(255,255,255,0.08)',
            barBg: 'rgba(255,255,255,0.05)',
            panel: 'rgba(255,255,255,0.04)',
            trackShadow: 'rgba(0,0,0,0.5)',
        };
    }
    return {
        text: '#1a1c20',
        subText: '#5c6773',
        grid: 'rgba(0,0,0,0.08)',
        barBg: 'rgba(0,0,0,0.04)',
        panel: 'rgba(0,0,0,0.03)',
        trackShadow: 'rgba(0,0,0,0.15)',
    };
}

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function clamp01(v) {
    return clamp(v, 0, 1);
}

// 決定的 PRNG（粒子の初期位相を安定に散らす。Math.random は使わない）
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 数値正規化（カンマ・空白・全角を許容）
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

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    if (!a || !b) return hexA || hexB || '#888888';
    const u = clamp01(t);
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `rgb(${r},${g},${bl})`;
}

// color を toward（白/黒など）へ ratio だけ寄せる（陰影・ハイライト用）。'rgb(...)' を返す
function mixColor(color, toward, ratio) {
    const a = hexToRgb(color) || parseRgb(color);
    const b = hexToRgb(toward) || parseRgb(toward);
    if (!a || !b) return color;
    const u = clamp01(ratio);
    return `rgb(${Math.round(a.r + (b.r - a.r) * u)},${Math.round(a.g + (b.g - a.g) * u)},${Math.round(
        a.b + (b.b - a.b) * u
    )})`;
}

function parseRgb(color) {
    const m = String(color).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

// rgba 化（不透明度付き）。hex/rgb どちらでも受ける
function withAlpha(color, alpha) {
    const rgb = hexToRgb(color);
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    const m = String(color).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
    return color;
}

function fmtInt(n) {
    if (!Number.isFinite(n)) return '-';
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    return Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
    if (!Number.isFinite(n)) return '-';
    const p = n * 100;
    if (p >= 100) return `${p.toFixed(0)}%`;
    if (p >= 10) return `${p.toFixed(1)}%`;
    return `${p.toFixed(1)}%`;
}

// CJK を含むかで文字幅を推定（SVG に measureText が無いための近似）
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.6;
    }
    return w;
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

    return {
        stepField: typeof o.stepField === 'string' || Array.isArray(o.stepField) ? o.stepField : '',
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',

        flowColor: colorOr(o.flowColor, DEFAULTS.flowColor),
        leakColor: colorOr(o.leakColor, DEFAULTS.leakColor),
        useRateColors: bool(o.useRateColors, DEFAULTS.useRateColors),
        lowColor: colorOr(o.lowColor, DEFAULTS.lowColor),
        highColor: colorOr(o.highColor, DEFAULTS.highColor),

        animationPeriod: clamp(numOr(o.animationPeriod, DEFAULTS.animationPeriod), 0, 120),
        particleDensity: clamp(Math.round(numOr(o.particleDensity, DEFAULTS.particleDensity)), 1, 100),

        barThickness: clamp(numOr(o.barThickness, DEFAULTS.barThickness), 0, 200),
        stepGap: clamp(numOr(o.stepGap, DEFAULTS.stepGap), 0, 400),
        cornerRadius: clamp(numOr(o.cornerRadius, DEFAULTS.cornerRadius), 0, 40),
        leakWidth: clamp(numOr(o.leakWidth, DEFAULTS.leakWidth), 0, 200),

        showStepLabels: bool(o.showStepLabels, DEFAULTS.showStepLabels),
        showCounts: bool(o.showCounts, DEFAULTS.showCounts),
        showRate: bool(o.showRate, DEFAULTS.showRate),
        showFlowBands: bool(o.showFlowBands, DEFAULTS.showFlowBands),
        showLeak: bool(o.showLeak, DEFAULTS.showLeak),
        showOverallRate: bool(o.showOverallRate, DEFAULTS.showOverallRate),
        labelSize: clamp(numOr(o.labelSize, DEFAULTS.labelSize), 0, 48),

        highlightOnHover: bool(o.highlightOnHover, DEFAULTS.highlightOnHover),
        showHeader: bool(o.showHeader, DEFAULTS.showHeader),
        debug: bool(o.debug, DEFAULTS.debug),
    };
}

// ---------------------------------------------------------------------------
// データ正規化（rows / columns 両形式）
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
// カスタム viz には未解決で届くので自前パース。ホストが列配列で渡す将来にも配列照合で対応。
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
// ファネル構築（行 → ステップ配列）
// 返り値: { steps:[{name,count}], error }
// ---------------------------------------------------------------------------

function buildFunnel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount < 2) return { error: 'columns', steps: [] };

    const stepIdx = resolveFieldIndex(opts.stepField, fieldNames, rows, 0);
    const valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, colCount - 1);
    // ステップ列と件数列が同一に解決されたら、件数を別列にずらす
    let vIdx = valIdx;
    if (vIdx === stepIdx) vIdx = stepIdx === colCount - 1 ? 0 : colCount - 1;

    const steps = [];
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const rawName = row[stepIdx];
        const name = rawName === null || rawName === undefined ? '' : String(rawName);
        const count = parseNum(row[vIdx]);
        if (!Number.isFinite(count) || count < 0) continue;
        if (name === '' && count === 0) continue;
        steps.push({ name: name === '' ? `Step ${steps.length + 1}` : name, count });
    }
    if (steps.length === 0) return { error: 'empty', steps: [] };
    return { steps, stepIdx, vIdx };
}

// ---------------------------------------------------------------------------
// レイアウト計算（コンテナ実寸 → 各段の矩形・リボン・粒子経路）
// ---------------------------------------------------------------------------

function computeLayout(steps, opts, width, height, pal) {
    const n = steps.length;
    const maxCount = Math.max(1, ...steps.map((s) => s.count));

    const baseFont = opts.labelSize > 0 ? opts.labelSize : clamp(Math.round(Math.min(width, height) / 34), 11, 16);

    // 縦レイアウト。ラベル帯を左に確保するかは幅次第。ここでは中央にファネル、
    // 各段の右側に注記（件数/率）を出す。左側にリーク帯を出す。
    const padTop = opts.showHeader ? Math.round(baseFont * 3.0) : Math.round(baseFont * 1.2);
    const padBottom = Math.round(baseFont * 1.4);
    const usableH = Math.max(40, height - padTop - padBottom);

    // 段の縦ピッチ：バー太さ + 段間ギャップ。0 指定は自動フィット。
    // 方針：収まるならスクロールを出さず領域いっぱいに広げる。段数が多くて
    // 「最小ピッチ」でも収まらない場合に限りオーバーフロー（＝縦スクロール）させる。
    const MIN_BAR = 20; // これ以上は縮めない（可読性の下限）
    const MIN_GAP = 22; // 段間の最小（リークの弧と粒子が通る最低限）
    const MIN_PITCH = MIN_BAR + MIN_GAP;

    let bar = opts.barThickness;
    let gap = opts.stepGap;
    if (bar <= 0 || gap <= 0) {
        // 自動：総高から均等割り（末尾 gap は不要なので n 段は (n-1) ギャップ）
        const pitch = n > 1 ? (usableH - MIN_BAR) / (n - 1) : usableH;
        if (bar <= 0) bar = clamp(Math.round(pitch * 0.48), MIN_BAR, 64);
        if (gap <= 0) gap = clamp(Math.round(pitch * 0.52), MIN_GAP, 96);
    }
    let pitch = bar + gap;

    // 必要総高（末尾 gap は不要）
    let totalNeeded = pitch * n - gap;
    // はみ出す場合はまず縮めてフィットを試みる（最小ピッチまで）
    if (totalNeeded > usableH && totalNeeded > 0) {
        const scale = usableH / totalNeeded;
        bar = Math.max(MIN_BAR, bar * scale);
        gap = Math.max(MIN_GAP, gap * scale);
        pitch = bar + gap;
        totalNeeded = pitch * n - gap;
    }
    // 最小ピッチでも収まらない＝段数が多すぎる → オーバーフロー（縦スクロール）を許容
    const overflow = totalNeeded > usableH + 0.5;

    // 中央線 X。左は「段階名ラベル帯 + リーク帯」、右は注記帯を確保する。
    // ラベルは全段そろえて左の枠外に置くので、最長ラベルの推定幅ぶんの余白を取る。
    const longestLabel = steps.reduce((m, s) => Math.max(m, estimateTextWidth(s.name, baseFont)), 0);
    const labelPad = opts.showStepLabels ? clamp(Math.round(longestLabel + 20), 40, Math.round(width * 0.32)) : 12;
    // 左向きに出るリークの逃げ幅（リーク表示時のみ）
    const leakPad = opts.showLeak ? clamp(Math.round(width * 0.11), 60, 150) : 0;
    const leftPad = labelPad + leakPad;
    const rightPad = clamp(Math.round(width * 0.24), 90, 220);
    const centerX = leftPad + (width - leftPad - rightPad) / 2;
    const maxBarW = Math.max(40, width - leftPad - rightPad);

    const rate0to1 = (c, prev) => (prev > 0 ? clamp01(c / prev) : c > 0 ? 1 : 0);

    const nodes = [];
    for (let i = 0; i < n; i += 1) {
        const c = steps[i].count;
        const w = clamp((c / maxCount) * maxBarW, 6, maxBarW);
        const y = padTop + i * pitch;
        const prev = i > 0 ? steps[i - 1].count : c;
        const passRate = i === 0 ? 1 : rate0to1(c, prev);
        const drop = i === 0 ? 0 : Math.max(0, prev - c);

        let fill;
        if (opts.useRateColors) {
            fill = lerpColor(opts.lowColor, opts.highColor, passRate);
        } else {
            fill = opts.flowColor;
        }
        nodes.push({
            i,
            name: steps[i].name,
            count: c,
            x: centerX - w / 2,
            y,
            w,
            h: bar,
            cx: centerX,
            top: y,
            bottom: y + bar,
            passRate,
            drop,
            overallRate: steps[0].count > 0 ? c / steps[0].count : 0,
            fill,
        });
    }

    // 段間のリボン（通過フロー）と離脱リボン
    const ribbons = [];
    const leaks = [];
    for (let i = 0; i < n - 1; i += 1) {
        const a = nodes[i];
        const b = nodes[i + 1];
        // 通過リボン：a の下辺（a の幅）から b の上辺（b の幅）へ滑らかに絞る「首」。
        // 上端は a の幅、下端は b の幅にすることで「太いバーの下に細い柱」ではなく
        // 本物のファネル（漏斗）に見える。両端とも中心軸 cx で揃える。
        const topW = a.w;
        const botW = b.w;
        ribbons.push({
            i,
            cx: a.cx,
            xTopL: a.cx - topW / 2,
            xTopR: a.cx + topW / 2,
            xBotL: b.cx - botW / 2,
            xBotR: b.cx + botW / 2,
            y1: a.bottom,
            y2: b.top,
            widthTop: topW,
            widthBot: botW,
            fill: opts.useRateColors ? b.fill : opts.flowColor,
        });

        if (opts.showLeak && b.drop > 0) {
            // 離脱ぶんの帯幅は drop/prev に比例（最大 leakWidth）
            const frac = a.count > 0 ? b.drop / a.count : 0;
            const lw = clamp(opts.leakWidth * Math.sqrt(frac), 3, opts.leakWidth);
            // 左右交互にこぼす（同段の見た目バランス）。ただし高さは全段そろえて
            // 「漏れ元＝次段バー b の中央の高さ」から水平に湧き出させる。
            const side = i % 2 === 0 ? -1 : 1;
            const startX = b.cx + (side * botW) / 2; // 次段バーの左右端
            const startY = b.top + bar / 2; // ★ バー中央の高さ（全段統一）
            const reach = side < 0 ? Math.min(leakPad - 8, 140) : Math.min(rightPad * 0.55, 140);
            const endX = b.cx + side * (botW / 2 + Math.max(48, reach));
            const endY = startY + bar * 0.5; // 水平寄りに湧いて、ほんの少し下へ
            // 制御点：まず真横に湧き出し（同じ高さ）→ 外側でわずかに落ちる
            const c1x = startX + side * reach * 0.6;
            const c1y = startY;
            const c2x = endX - side * reach * 0.15;
            const c2y = endY - bar * 0.15;
            leaks.push({
                i,
                side,
                x1: startX,
                y1: startY,
                c1x,
                c1y,
                c2x,
                c2y,
                x2: endX,
                y2: endY,
                lw,
                drop: b.drop,
                fill: opts.leakColor,
            });
        }
    }

    const contentBottom = nodes.length ? nodes[nodes.length - 1].bottom + padBottom : height;

    return {
        nodes,
        ribbons,
        leaks,
        centerX,
        leftPad,
        labelPad,
        leakPad,
        rightPad,
        maxBarW,
        baseFont,
        padTop,
        contentBottom,
        overflow, // 段数が多く領域に収まらない → 縦スクロールを許容
        boxHeight: height, // レイアウトが前提にしたスクロール領域の高さ
        maxCount,
    };
}

// 通過リボン（漏斗の首）の SVG パス。上端 a 幅 → 下端 b 幅へ S 字で滑らかに絞る。
function ribbonPath(r) {
    const my = (r.y1 + r.y2) / 2;
    return [
        `M ${r.xTopL.toFixed(2)} ${r.y1.toFixed(2)}`,
        `C ${r.xTopL.toFixed(2)} ${my.toFixed(2)} ${r.xBotL.toFixed(2)} ${my.toFixed(2)} ${r.xBotL.toFixed(2)} ${r.y2.toFixed(2)}`,
        `L ${r.xBotR.toFixed(2)} ${r.y2.toFixed(2)}`,
        `C ${r.xBotR.toFixed(2)} ${my.toFixed(2)} ${r.xTopR.toFixed(2)} ${my.toFixed(2)} ${r.xTopR.toFixed(2)} ${r.y1.toFixed(2)}`,
        'Z',
    ].join(' ');
}

// リーク中心線（cubic ベジェ）。粒子はこの線＋レーンオフセットで流す。
function cubic(p0, c1, c2, p1, t) {
    const u = 1 - t;
    const a = u * u * u;
    const bb = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
        x: a * p0.x + bb * c1.x + c * c2.x + d * p1.x,
        y: a * p0.y + bb * c1.y + c * c2.y + d * p1.y,
    };
}

function leakPointAt(lk, t) {
    return cubic(
        { x: lk.x1, y: lk.y1 },
        { x: lk.c1x, y: lk.c1y },
        { x: lk.c2x, y: lk.c2y },
        { x: lk.x2, y: lk.y2 },
        t
    );
}

// リーク帯：中心 cubic に沿って、根元は太く終端は先細りする「こぼれ落ちる筋」。
function leakBandPath(lk) {
    const STEPS = 14;
    const top = [];
    const bot = [];
    for (let s = 0; s <= STEPS; s += 1) {
        const t = s / STEPS;
        const p = leakPointAt(lk, t);
        // 進行方向の法線を数値微分で求め、そこへ半幅を振る
        const p2 = leakPointAt(lk, Math.min(1, t + 0.01));
        let dx = p2.x - p.x;
        let dy = p2.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const nx = -dy;
        const ny = dx;
        // 根元(半幅最大)→終端(ほぼ0)。少し膨らませてから細くする
        const half = (lk.lw / 2) * Math.pow(1 - t, 1.4) * (0.7 + 0.3 * Math.sin(t * Math.PI));
        top.push({ x: p.x + nx * half, y: p.y + ny * half });
        bot.push({ x: p.x - nx * half, y: p.y - ny * half });
    }
    let d = `M ${top[0].x.toFixed(2)} ${top[0].y.toFixed(2)}`;
    for (let s = 1; s < top.length; s += 1) d += ` L ${top[s].x.toFixed(2)} ${top[s].y.toFixed(2)}`;
    for (let s = bot.length - 1; s >= 0; s -= 1) d += ` L ${bot[s].x.toFixed(2)} ${bot[s].y.toFixed(2)}`;
    return d + ' Z';
}

// 角丸矩形（上下だけ丸める簡易版）
function roundedRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    return [
        `M ${(x + rr).toFixed(2)} ${y.toFixed(2)}`,
        `L ${(x + w - rr).toFixed(2)} ${y.toFixed(2)}`,
        `Q ${(x + w).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + rr).toFixed(2)}`,
        `L ${(x + w).toFixed(2)} ${(y + h - rr).toFixed(2)}`,
        `Q ${(x + w).toFixed(2)} ${(y + h).toFixed(2)} ${(x + w - rr).toFixed(2)} ${(y + h).toFixed(2)}`,
        `L ${(x + rr).toFixed(2)} ${(y + h).toFixed(2)}`,
        `Q ${x.toFixed(2)} ${(y + h).toFixed(2)} ${x.toFixed(2)} ${(y + h - rr).toFixed(2)}`,
        `L ${x.toFixed(2)} ${(y + rr).toFixed(2)}`,
        `Q ${x.toFixed(2)} ${y.toFixed(2)} ${(x + rr).toFixed(2)} ${y.toFixed(2)}`,
        'Z',
    ].join(' ');
}

// ---------------------------------------------------------------------------
// メインビジュアライゼーション
// ---------------------------------------------------------------------------

function FunnelLeak({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const pal = useMemo(() => palette(mode), [mode]);

    const primary = dataSources?.primary;
    const rawData = primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);

    const built = useMemo(() => buildFunnel(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 760, h: 520 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 760;
        const h = el.clientHeight || 520;
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

    // スクロール領域の実効サイズ。コンテナ padding(16*2) とヘッダー高を差し引く。
    // ここで算出した box 高を computeLayout にそのまま渡し、SVG 高もこれに合わせる
    // ことで「収まるならスクロールなし・収まらない時だけスクロール」を成立させる。
    const svgW = Math.max(80, dims.w - 32);
    const HEADER_H = 30; // ヘッダー行 + marginBottom（CSS の calc(100% - 30px) と一致）
    const boxH = Math.max(120, dims.h - 32 - (opts.showHeader ? HEADER_H : 0));

    const layout = useMemo(() => {
        if (built.error || !built.steps.length) return null;
        return computeLayout(built.steps, opts, svgW, boxH, pal);
    }, [built, opts, svgW, boxH, pal]);

    // 収まるとき（overflow=false）は box 高いっぱいに広げてスクロールを出さない。
    // 収まらないとき（段数過多）は自然な高さにしてスクロールさせる。
    const svgH = layout ? (layout.overflow ? Math.ceil(layout.contentBottom) : boxH) : boxH;

    const optsRef = useRef(opts);
    optsRef.current = opts;
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const hoverRef = useRef(null);
    const [hover, setHover] = useState(null);
    hoverRef.current = hover;

    // 粒子プールを掴む group（useCallback([]) で安定化：detach→attach で孤児化を防ぐ）
    const flowGroupRef = useRef(null);
    const flowGroupCb = useCallback((el) => {
        flowGroupRef.current = el;
        if (el) {
            while (el.firstChild) el.removeChild(el.firstChild);
        }
    }, []);

    const particlesRef = useRef([]); // {el, kind:'down'|'leak', seg, phase, speed, size}

    // レイアウト/オプション変更で粒子集合を作り直す（構造は React 外で管理）
    useEffect(() => {
        const g = flowGroupRef.current;
        if (!g) return undefined;
        while (g.firstChild) g.removeChild(g.firstChild);
        particlesRef.current = [];
        const lay = layout;
        const o = opts;
        if (!lay || o.animationPeriod <= 0 || o.particleDensity <= 0) {
            return undefined;
        }
        const NS = 'http://www.w3.org/2000/svg';
        const rand = mulberry32(0x9e3779b9 ^ (lay.nodes.length * 2654435761));
        const densityScale = o.particleDensity / 50; // 1.0 が既定

        // 通過リボンごとに粒子（レーン u∈[-0.5,0.5] を持たせ、首の幅に追従させる）
        lay.ribbons.forEach((r, ri) => {
            const flowFrac = clamp01(r.widthBot / Math.max(1, lay.maxBarW));
            // 幅が広いほど多く、必ずしっかり流れとして見える下限を確保
            const count = Math.max(10, Math.round((22 + 46 * flowFrac) * densityScale));
            for (let k = 0; k < count; k += 1) {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('class', 'fl-particle');
                c.setAttribute('opacity', '0');
                g.appendChild(c);
                particlesRef.current.push({
                    el: c,
                    kind: 'down',
                    seg: ri,
                    phase: rand(),
                    lane: rand() - 0.5, // 横位置（首の幅に比例して散る）
                    jitter: (rand() - 0.5) * 2, // 微小な横揺れ位相
                    speed: 0.85 + rand() * 0.5,
                    size: 1.0 + rand() * 2.0,
                    baseAlpha: 0.45 + rand() * 0.5,
                    color: r.fill,
                });
            }
        });

        // リーク筋ごとに粒子（離脱量に比例）
        lay.leaks.forEach((lk, li) => {
            const frac = clamp01(lk.drop / Math.max(1, lay.maxCount));
            const count = Math.max(6, Math.round((14 + 26 * frac) * densityScale));
            for (let k = 0; k < count; k += 1) {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('class', 'fl-particle');
                c.setAttribute('opacity', '0');
                g.appendChild(c);
                particlesRef.current.push({
                    el: c,
                    kind: 'leak',
                    seg: li,
                    phase: rand(),
                    lane: rand() - 0.5,
                    jitter: (rand() - 0.5) * 2,
                    speed: 0.9 + rand() * 0.6,
                    size: 1.0 + rand() * 1.8,
                    baseAlpha: 0.5 + rand() * 0.5,
                    color: o.leakColor,
                });
            }
        });
        return undefined;
    }, [layout, opts]);

    // rAF ループ（mount 時に1回。設定・状態は ref 経由で読む）
    useEffect(() => {
        if (typeof requestAnimationFrame === 'undefined') return undefined;
        let rafId = 0;
        let t0 = 0;
        const step = (ts) => {
            if (!t0) t0 = ts;
            const elapsed = (ts - t0) / 1000;
            const lay = layoutRef.current;
            const o = optsRef.current;
            const period = o.animationPeriod;
            const parts = particlesRef.current;
            if (lay && period > 0) {
                const hv = hoverRef.current;
                for (let i = 0; i < parts.length; i += 1) {
                    const p = parts[i];
                    if (p.kind === 'down') {
                        const r = lay.ribbons[p.seg];
                        if (!r) {
                            p.el.setAttribute('opacity', '0');
                            continue;
                        }
                        // 縦方向の進行度 tt（0=上端, 1=下端）でループ
                        const tt = ((elapsed * p.speed) / period + p.phase) % 1;
                        const y = r.y1 + (r.y2 - r.y1) * tt;
                        // 首は上端 widthTop → 下端 widthBot へ絞る。レーンはその幅に追従
                        const w = r.widthTop + (r.widthBot - r.widthTop) * tt;
                        const cx = r.cx; // 中心軸は一定（両端 cx 揃え）
                        const wobble = Math.sin((tt * 6.283 + p.jitter * 3.14) * 1.0) * 1.4;
                        const x = cx + p.lane * w * 0.86 + wobble;
                        // 入口/出口でフェードして粒子の湧き出し・吸い込みを自然に
                        const edge = clamp01(Math.min(tt, 1 - tt) / 0.14);
                        const dim = hv !== null && hv !== r.i && hv !== r.i + 1;
                        p.el.setAttribute('cx', x.toFixed(2));
                        p.el.setAttribute('cy', y.toFixed(2));
                        p.el.setAttribute('r', p.size.toFixed(2));
                        p.el.setAttribute('fill', p.color);
                        p.el.setAttribute('opacity', ((dim ? 0.1 : p.baseAlpha) * edge).toFixed(3));
                    } else {
                        const lk = lay.leaks[p.seg];
                        if (!lk) {
                            p.el.setAttribute('opacity', '0');
                            continue;
                        }
                        const tt = ((elapsed * p.speed) / period + p.phase) % 1;
                        const pt = leakPointAt(lk, tt);
                        const pt2 = leakPointAt(lk, Math.min(1, tt + 0.02));
                        let dx = pt2.x - pt.x;
                        let dy = pt2.y - pt.y;
                        const len = Math.hypot(dx, dy) || 1;
                        const nx = -dy / len;
                        const ny = dx / len;
                        // 根元で太く終端で細るレーン幅。重力でだんだん下に散る
                        const laneW = (lk.lw / 2) * Math.pow(1 - tt, 1.2);
                        const x = pt.x + nx * p.lane * laneW * 1.4;
                        const yg = pt.y + ny * p.lane * laneW * 1.4 + tt * tt * 6;
                        // 湧き出し(0付近)と落下消失(1付近)でフェード
                        const fadeIn = clamp01(tt / 0.12);
                        const fadeOut = clamp01((1 - tt) / 0.4);
                        const dim = hv !== null && hv !== lk.i && hv !== lk.i + 1;
                        p.el.setAttribute('cx', x.toFixed(2));
                        p.el.setAttribute('cy', yg.toFixed(2));
                        p.el.setAttribute('r', (p.size * (1 - tt * 0.45)).toFixed(2));
                        p.el.setAttribute('fill', p.color);
                        p.el.setAttribute('opacity', ((dim ? 0.08 : p.baseAlpha) * fadeIn * fadeOut).toFixed(3));
                    }
                }
            } else {
                for (let i = 0; i < parts.length; i += 1) parts[i].el.setAttribute('opacity', '0');
            }
            rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
        return () => {
            if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
        };
    }, []);

    // ---- 表示分岐 ---------------------------------------------------------
    if (loading) {
        return (
            <div ref={setContainer} className="viz-container viz-container--empty">
                <div className="viz-message">
                    <WaitSpinner size="medium" />
                    <Paragraph>読み込み中…</Paragraph>
                </div>
            </div>
        );
    }

    if (!primary || rows.length === 0) {
        return (
            <div ref={setContainer} className="viz-container viz-container--empty">
                <div className="viz-message">
                    <Paragraph>データがありません。1行=1ステップ、行順が上→下の段順になるサーチ結果を指定してください。</Paragraph>
                </div>
            </div>
        );
    }

    if (built.error === 'columns') {
        return (
            <div ref={setContainer} className="viz-container viz-container--empty">
                <div className="viz-message">
                    <Paragraph>列が不足しています。段階名の列と件数の列（2列以上）が必要です。</Paragraph>
                </div>
            </div>
        );
    }

    if (built.error || !layout) {
        return (
            <div ref={setContainer} className="viz-container viz-container--empty">
                <div className="viz-message">
                    <Paragraph>有効なステップがありません。件数が数値の行があるか確認してください。</Paragraph>
                </div>
            </div>
        );
    }

    const { nodes } = layout;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const overall = first.count > 0 ? last.count / first.count : 0;
    const font = layout.baseFont;
    const smallFont = Math.max(9, font - 3);

    return (
        <div ref={setContainer} className="viz-container" style={{ padding: 16, boxSizing: 'border-box' }}>
            {opts.showHeader && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 16,
                        marginBottom: 6,
                        color: pal.text,
                        fontFamily: 'Splunk Platform Sans, -apple-system, sans-serif',
                    }}
                >
                    <span style={{ fontSize: font + 1, fontWeight: 600 }}>
                        {fmtInt(first.count)} → {fmtInt(last.count)}
                    </span>
                    {opts.showOverallRate && (
                        <span style={{ fontSize: font, color: pal.subText }}>
                            総合通過率{' '}
                            <b style={{ color: overall >= 0.5 ? opts.highColor : opts.leakColor }}>{fmtPct(overall)}</b>
                            {'　'}離脱 {fmtInt(first.count - last.count)}
                        </span>
                    )}
                    <span style={{ fontSize: smallFont, color: pal.subText, marginLeft: 'auto' }}>{nodes.length} 段</span>
                </div>
            )}

            <div className="viz-scroll" style={{ height: opts.showHeader ? 'calc(100% - 30px)' : '100%' }}>
                <svg
                    width={svgW}
                    height={svgH}
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    style={{ display: 'block', fontFamily: 'Splunk Platform Sans, -apple-system, sans-serif' }}
                >
                    <defs>
                        {/* 通過リボン（縦グラデ：上=濃、下=淡）。帯表示ONのときだけ定義 */}
                        {opts.showFlowBands &&
                            layout.ribbons.map((r) => (
                                <linearGradient
                                    key={`rg-${r.i}`}
                                    id={`fl-ribbon-${r.i}`}
                                    x1="0"
                                    y1={r.y1}
                                    x2="0"
                                    y2={r.y2}
                                    gradientUnits="userSpaceOnUse"
                                >
                                    <stop offset="0%" stopColor={withAlpha(r.fill, 0.5)} />
                                    <stop offset="100%" stopColor={withAlpha(r.fill, 0.14)} />
                                </linearGradient>
                            ))}
                        {/* 各段バーの縦グラデ（上に明るいハイライト、下に沈む陰影） */}
                        {nodes.map((nd) => {
                            const base = nd.fill;
                            return (
                                <linearGradient
                                    key={`bg-${nd.i}`}
                                    id={`fl-bar-${nd.i}`}
                                    x1="0"
                                    y1={nd.y}
                                    x2="0"
                                    y2={nd.bottom}
                                    gradientUnits="userSpaceOnUse"
                                >
                                    <stop offset="0%" stopColor={mixColor(base, '#ffffff', 0.28)} />
                                    <stop offset="46%" stopColor={base} />
                                    <stop offset="100%" stopColor={mixColor(base, '#000000', 0.24)} />
                                </linearGradient>
                            );
                        })}
                        {/* リーク筋のグラデ（根元＝鮮やかな離脱色、終端＝透明へ）。帯表示ONのときだけ */}
                        {opts.showFlowBands &&
                            opts.showLeak &&
                            layout.leaks.map((lk) => (
                                <linearGradient
                                    key={`lg-${lk.i}`}
                                    id={`fl-leak-${lk.i}`}
                                    x1={lk.x1}
                                    y1={lk.y1}
                                    x2={lk.x2}
                                    y2={lk.y2}
                                    gradientUnits="userSpaceOnUse"
                                >
                                    <stop
                                        offset="0%"
                                        stopColor={withAlpha(mixColor(opts.leakColor, '#ffffff', 0.15), 0.85)}
                                    />
                                    <stop offset="55%" stopColor={withAlpha(opts.leakColor, 0.45)} />
                                    <stop offset="100%" stopColor={withAlpha(opts.leakColor, 0)} />
                                </linearGradient>
                            ))}
                        <filter id="fl-glow" x="-60%" y="-60%" width="220%" height="220%">
                            <feGaussianBlur stdDeviation="1.6" result="b" />
                            <feMerge>
                                <feMergeNode in="b" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* 通過リボン帯（漏斗の首）。既定は非表示、帯表示ONのときだけ薄く敷く */}
                    {opts.showFlowBands &&
                        layout.ribbons.map((r) => {
                            const dim = hover !== null && hover !== r.i && hover !== r.i + 1;
                            return (
                                <path
                                    key={`rb-${r.i}`}
                                    d={ribbonPath(r)}
                                    fill={`url(#fl-ribbon-${r.i})`}
                                    opacity={dim ? 0.25 : 1}
                                    stroke="none"
                                />
                            );
                        })}

                    {/* リーク筋帯（こぼれ落ち）。帯表示ON かつ 離脱表示ON のとき */}
                    {opts.showFlowBands &&
                        opts.showLeak &&
                        layout.leaks.map((lk) => {
                            const dim = hover !== null && hover !== lk.i && hover !== lk.i + 1;
                            return (
                                <path
                                    key={`lk-${lk.i}`}
                                    d={leakBandPath(lk)}
                                    fill={`url(#fl-leak-${lk.i})`}
                                    opacity={dim ? 0.2 : 1}
                                    stroke="none"
                                />
                            );
                        })}

                    {/* 流れる粒子（rAF が cx/cy/opacity を直更新） */}
                    <g ref={flowGroupCb} filter="url(#fl-glow)" />

                    {/* 段のバー */}
                    {nodes.map((nd) => {
                        const dim = hover !== null && hover !== nd.i;
                        return (
                            <g
                                key={`nd-${nd.i}`}
                                opacity={dim ? 0.45 : 1}
                                onMouseEnter={() => opts.highlightOnHover && setHover(nd.i)}
                                onMouseLeave={() => opts.highlightOnHover && setHover(null)}
                                style={{ cursor: 'default' }}
                            >
                                {/* トラック（最大幅の淡い下地。丸みを合わせる） */}
                                <rect
                                    x={nd.cx - layout.maxBarW / 2}
                                    y={nd.y}
                                    width={layout.maxBarW}
                                    height={nd.h}
                                    rx={Math.min(opts.cornerRadius + 2, nd.h / 2)}
                                    fill={pal.barBg}
                                    stroke={pal.grid}
                                    strokeWidth="1"
                                />
                                {/* バー本体（縦グラデで立体感） */}
                                <path
                                    d={roundedRectPath(nd.x, nd.y, nd.w, nd.h, opts.cornerRadius)}
                                    fill={`url(#fl-bar-${nd.i})`}
                                />
                                {/* 上辺の明るいリム */}
                                <path
                                    d={roundedRectPath(nd.x, nd.y, nd.w, Math.max(2, nd.h * 0.22), opts.cornerRadius)}
                                    fill={withAlpha('#ffffff', 0.22)}
                                />
                                {/* 縁取り（締まり） */}
                                <path
                                    d={roundedRectPath(nd.x, nd.y, nd.w, nd.h, opts.cornerRadius)}
                                    fill="none"
                                    stroke={withAlpha('#000000', 0.18)}
                                    strokeWidth="1"
                                />

                                {/* 段階名：全段そろえて左の枠外（ラベル帯）に左寄せ配置。
                                    離脱数を下に添える段では段階名を少し上へずらして2段組みにする */}
                                {opts.showStepLabels &&
                                    (() => {
                                        const hasDrop = opts.showLeak && nd.i > 0 && nd.drop > 0;
                                        return (
                                            <text
                                                x={2}
                                                y={nd.y + nd.h / 2 - (hasDrop ? 8 : 0)}
                                                fontSize={font}
                                                fontWeight="600"
                                                fill={pal.text}
                                                textAnchor="start"
                                                dominantBaseline="central"
                                                style={{ pointerEvents: 'none' }}
                                            >
                                                {truncateLabel(nd.name, layout.labelPad - 6, font)}
                                            </text>
                                        );
                                    })()}

                                {/* 右側の注記（件数・通過率） */}
                                <g style={{ pointerEvents: 'none' }}>
                                    {opts.showCounts && (
                                        <text
                                            x={nd.cx + layout.maxBarW / 2 + 12}
                                            y={nd.y + nd.h / 2 - (opts.showRate && nd.i > 0 ? 7 : 0)}
                                            fontSize={font}
                                            fontWeight="600"
                                            fill={pal.text}
                                            dominantBaseline="central"
                                        >
                                            {fmtInt(nd.count)}
                                        </text>
                                    )}
                                    {opts.showRate && nd.i > 0 && (
                                        <text
                                            x={nd.cx + layout.maxBarW / 2 + 12}
                                            y={nd.y + nd.h / 2 + (opts.showCounts ? 9 : 0)}
                                            fontSize={smallFont}
                                            fill={nd.passRate >= 0.5 ? opts.highColor : opts.leakColor}
                                            dominantBaseline="central"
                                        >
                                            通過 {fmtPct(nd.passRate)}
                                        </text>
                                    )}
                                </g>

                                {/* 離脱数：段階名と同じ左の枠外に、段階名の下へ添えて配置（左に情報を統一） */}
                                {opts.showLeak &&
                                    nd.i > 0 &&
                                    nd.drop > 0 &&
                                    (() => {
                                        return (
                                            <text
                                                x={2}
                                                y={nd.y + nd.h / 2 + (opts.showStepLabels ? 10 : 0)}
                                                fontSize={smallFont}
                                                fill={opts.leakColor}
                                                textAnchor="start"
                                                dominantBaseline="central"
                                                style={{ pointerEvents: 'none' }}
                                            >
                                                −{fmtInt(nd.drop)}
                                            </text>
                                        );
                                    })()}
                            </g>
                        );
                    })}
                </svg>
            </div>

            {opts.debug && (
                <pre
                    style={{
                        position: 'absolute',
                        right: 8,
                        bottom: 8,
                        maxWidth: '52%',
                        maxHeight: '46%',
                        overflow: 'auto',
                        margin: 0,
                        padding: 8,
                        fontSize: 10,
                        lineHeight: 1.3,
                        background: pal.panel,
                        color: pal.text,
                        border: `1px solid ${pal.grid}`,
                        borderRadius: 6,
                        zIndex: 5,
                    }}
                >
                    {JSON.stringify(
                        {
                            fields: fieldNames,
                            stepIdx: built.stepIdx,
                            valIdx: built.vIdx,
                            steps: built.steps.length,
                            options: options,
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

// バー内に収まるようラベルを … で切り詰め
function truncateLabel(text, maxW, font) {
    const s = String(text);
    if (estimateTextWidth(s, font) <= maxW) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTextWidth(s.slice(0, mid) + '…', font) <= maxW) lo = mid;
        else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo) + '…' : '…';
}

// ---------------------------------------------------------------------------
// ルート（テーマガード必須）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;
    if (!colorScheme) return null; // テーマ未取得の間はレンダリングしない
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <FunnelLeak mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
