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
// Waterfall Chart（ウォーターフォール／滝グラフ）
//
// 「開始値からの増減の積み上げが最終的な合計にどう届くか」を階段状のバーで
// 可視化する。売上→費用→利益のブリッジ、エラー件数の要因分解、在庫の入出庫、
// ライセンス数の増減など、増減の内訳を見せる用途全般に使える。
// Splunk 標準ビジュアライゼーション（column/bar/line/pie 等）には存在しない。
//
// データモデル（1行 = 1ステップ、行順に左から描画）:
//   ラベル列 = ステップ名（既定は第1列）
//   値列     = 増減値（既定は最終列。正=増加、負=減少）
//   種別列   = 任意。'total'/'合計' → その時点の累計を 0 からの絶対バーで描画
//              'start'/'開始' → 値を 0 からの絶対バーとして描画し累計をリセット
//              （種別列が未指定でも、セルが種別トークンだけの列は自動検出する）
//
//   オプション「値を累計値として解釈」ON のときは、各行の値を累計スナップショット
//   とみなし、増減 = 前行との差分を自動計算する（第1行は開始バー）。
//
// 表示: 増=緑/減=赤/合計・開始=青（色は編集パネルで変更・増減反転可）、
// 破線コネクタ、値ラベル、Y軸目盛、末尾「合計」バーの自動追加、
// バー伸長アニメーション。コンテナ実寸へ自動フィットし、小さいパネルでは
// 値ラベル → X軸ラベル → Y軸目盛の順に段階的に退避する。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    labelField: '', // ラベル（項目）フィールド（'' = 第1列）
    valueField: '', // 値（増減）フィールド（'' = 最終列）
    typeField: '', // 種別フィールド（'' = 自動検出）

    cumulativeInput: false, // 値を累計値として解釈（増減を自動計算）
    showTotal: true, // 末尾に合計バーを自動追加
    totalLabel: '合計', // 自動追加する合計バーのラベル（ソースJSONで変更可）

    increaseColor: '#3fb950', // 増加の色
    decreaseColor: '#f85149', // 減少の色
    totalColor: '#4f8ff7', // 合計・開始の色
    invertColors: false, // 増減の色を入れ替え（増=赤/減=緑。コスト系向け）
    showGlow: false, // 発光（グロー）

    showValues: true, // 値ラベルを表示
    showConnectors: true, // コネクタ（点線）を表示
    showAxis: true, // Y軸目盛を表示
    showXLabels: true, // 項目名（X軸ラベル）を表示
    animate: true, // バーの伸長アニメーション

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: false, // 1.5M などの省略表記

    debug: false, // options デバッグ表示
};

// 種別トークン
const TOTAL_RE = /^(total|subtotal|sum|合計|小計|総計)$/i;
const START_RE = /^(start|begin|base|initial|開始|期首|初期)$/i;
const DELTA_RE = /^(delta|relative|change|増減|変化)?$/i;

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

function parseRgb(color) {
    const m = String(color).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

// color を toward（白/黒など）へ ratio だけ寄せる。'rgb(...)' を返す
function mixColor(color, toward, ratio) {
    const a = hexToRgb(color) || parseRgb(color);
    const b = hexToRgb(toward) || parseRgb(toward);
    if (!a || !b) return color;
    const u = clamp01(ratio);
    return `rgb(${Math.round(a.r + (b.r - a.r) * u)},${Math.round(a.g + (b.g - a.g) * u)},${Math.round(
        a.b + (b.b - a.b) * u
    )})`;
}

// rgba 化（不透明度付き）。hex/rgb どちらでも受ける
function withAlpha(color, alpha) {
    const rgb = hexToRgb(color) || parseRgb(color);
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    return color;
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

// 符号付きフォーマット（増減用）
function fmtSigned(n, decimals, abbreviate) {
    if (!Number.isFinite(n)) return '-';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '±';
    return sign + fmtValue(Math.abs(n), decimals, abbreviate);
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

// きれいな目盛（lo..hi を等間隔で分割）
function niceTicks(lo, hi, target = 5) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / Math.max(2, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    const start = Math.ceil(lo / step) * step;
    for (let v = start; v <= hi + step * 1e-6; v += step) {
        ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    return ticks.length >= 2 ? ticks : [lo, hi];
}

function tickDecimals(ticks) {
    const step = ticks.length >= 2 ? Math.abs(ticks[1] - ticks[0]) : 1;
    if (step >= 1) return 0;
    if (step >= 0.1) return 1;
    return 2;
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
    const strOr = (v, d) => (typeof v === 'string' ? v : d);
    const fieldOr = (v) => (typeof v === 'string' || Array.isArray(v) ? v : '');

    return {
        labelField: fieldOr(o.labelField),
        valueField: fieldOr(o.valueField),
        typeField: fieldOr(o.typeField),

        cumulativeInput: bool(o.cumulativeInput, DEFAULTS.cumulativeInput),
        showTotal: bool(o.showTotal, DEFAULTS.showTotal),
        totalLabel: strOr(o.totalLabel, DEFAULTS.totalLabel) || DEFAULTS.totalLabel,

        increaseColor: colorOr(o.increaseColor, DEFAULTS.increaseColor),
        decreaseColor: colorOr(o.decreaseColor, DEFAULTS.decreaseColor),
        totalColor: colorOr(o.totalColor, DEFAULTS.totalColor),
        invertColors: bool(o.invertColors, DEFAULTS.invertColors),
        showGlow: bool(o.showGlow, DEFAULTS.showGlow),

        showValues: bool(o.showValues, DEFAULTS.showValues),
        showConnectors: bool(o.showConnectors, DEFAULTS.showConnectors),
        showAxis: bool(o.showAxis, DEFAULTS.showAxis),
        showXLabels: bool(o.showXLabels, DEFAULTS.showXLabels),
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

// 値列のフォールバック（後ろから探して、数値セルを1つでも含む列。種別列を掴まないため）
function pickValueIdx(rows, colCount, labelIdx) {
    for (let i = colCount - 1; i >= 0; i -= 1) {
        if (i === labelIdx) continue;
        for (const row of rows) {
            if (!Array.isArray(row)) continue;
            if (Number.isFinite(parseNum(row[i]))) return i;
        }
    }
    return colCount - 1;
}

// 種別列の自動検出（全ての非空セルが種別トークンで、total/start を1つ以上含む列）
function autoDetectTypeIdx(rows, colCount, excludeA, excludeB) {
    for (let i = 0; i < colCount; i += 1) {
        if (i === excludeA || i === excludeB) continue;
        let hasKeyword = false;
        let allTokens = true;
        for (const row of rows) {
            if (!Array.isArray(row)) continue;
            const cell = row[i];
            const s = cell === null || cell === undefined ? '' : String(cell).trim();
            if (TOTAL_RE.test(s) || START_RE.test(s)) {
                hasKeyword = true;
            } else if (!DELTA_RE.test(s)) {
                allTokens = false;
                break;
            }
        }
        if (hasKeyword && allTokens) return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// バー構築（行 → {label, type, delta, from, to, cum}）
// ---------------------------------------------------------------------------

function buildBars(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { error: 'empty', bars: [] };

    let labelIdx;
    let valIdx;
    if (colCount === 1) {
        labelIdx = -1;
        valIdx = 0;
    } else {
        labelIdx = resolveFieldIndex(opts.labelField, fieldNames, rows, 0);
        valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, pickValueIdx(rows, colCount, labelIdx));
        if (valIdx === labelIdx) valIdx = labelIdx === colCount - 1 ? 0 : colCount - 1;
    }
    let typeIdx = resolveFieldIndex(opts.typeField, fieldNames, rows, -1);
    if (typeIdx === labelIdx || typeIdx === valIdx) typeIdx = -1;
    if (typeIdx < 0 && colCount >= 3 && !opts.cumulativeInput) {
        typeIdx = autoDetectTypeIdx(rows, colCount, labelIdx, valIdx);
    }

    const bars = [];
    let running = 0;
    let started = false;
    let prevCum = null; // cumulativeInput 用

    rows.forEach((row, i) => {
        if (!Array.isArray(row)) return;
        const rawLabel = labelIdx >= 0 ? row[labelIdx] : null;
        const label = rawLabel === null || rawLabel === undefined ? `#${i + 1}` : String(rawLabel);
        const v = parseNum(row[valIdx]);
        const typeCell = typeIdx >= 0 ? String(row[typeIdx] ?? '').trim() : '';

        if (opts.cumulativeInput) {
            // 累計スナップショット列 → 差分に変換（第1有効行は開始バー）
            if (!Number.isFinite(v)) return;
            if (prevCum === null) {
                bars.push({ label, type: 'start', delta: v, from: 0, to: v, cum: v });
            } else {
                const d = v - prevCum;
                bars.push({ label, type: 'delta', delta: d, from: prevCum, to: v, cum: v });
            }
            prevCum = v;
            running = v;
            started = true;
            return;
        }

        if (TOTAL_RE.test(typeCell)) {
            // 合計・小計: その時点の累計を 0 からの絶対バーで描画（セルの値は使わない）
            bars.push({ label, type: 'total', delta: running, from: 0, to: running, cum: running });
            started = true;
            return;
        }
        if (START_RE.test(typeCell)) {
            if (!Number.isFinite(v)) return;
            running = v;
            bars.push({ label, type: 'start', delta: v, from: 0, to: v, cum: v });
            started = true;
            return;
        }
        if (!Number.isFinite(v)) return;
        const from = running;
        running += v;
        bars.push({ label, type: 'delta', delta: v, from, to: running, cum: running });
        started = true;
    });

    if (!started || bars.length === 0) return { error: 'novalue', bars: [] };

    // 末尾に合計バーを自動追加（既に total で終わっている場合は追加しない）
    if (opts.showTotal && bars[bars.length - 1].type !== 'total') {
        bars.push({ label: opts.totalLabel, type: 'total', delta: running, from: 0, to: running, cum: running });
    }

    return { bars, labelIdx, valIdx, typeIdx };
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#c9d1d9',
            subText: '#8b98a5',
            grid: 'rgba(139,152,165,0.16)',
            zero: 'rgba(201,209,217,0.55)',
            connector: 'rgba(139,152,165,0.65)',
            neutral: '#6e7681',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
        };
    }
    return {
        text: '#2b3033',
        subText: '#5c6773',
        grid: 'rgba(92,103,115,0.16)',
        zero: 'rgba(43,48,51,0.55)',
        connector: 'rgba(92,103,115,0.7)',
        neutral: '#9aa4ad',
        panelBg: 'rgba(255,255,255,0.98)',
        panelBorder: 'rgba(92,103,115,0.4)',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// バー伸長アニメーション（データ変更で 0→1 を再生。無効時は常に 1）
// ---------------------------------------------------------------------------

function useGrowProgress(signature, enabled) {
    const [progress, setProgress] = useState(enabled ? 0 : 1);

    useEffect(() => {
        if (!enabled || typeof requestAnimationFrame === 'undefined') {
            setProgress(1);
            return undefined;
        }
        setProgress(0);
        const dur = 800;
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

function WaterfallChart({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const model = useMemo(() => buildBars(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 560, h: 340 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 560;
        const h = el.clientHeight || 340;
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
        () => (model.bars || []).map((b) => `${b.label}:${b.to}`).join('|'),
        [model]
    );
    const progress = useGrowProgress(signature, opts.animate);

    // --- ガード（フックはすべて呼び終えてから return する） ---
    if (loading) {
        return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WaitSpinner size="medium" />
            </div>
        );
    }
    if (!rawData || rows.length === 0) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }
    if (model.error === 'novalue') {
        return <CenterMessage>数値データが見つかりません。値フィールドの選択を確認してください。</CenterMessage>;
    }
    if (model.error) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    const pal = chartColors(mode);
    const bars = model.bars;
    const n = bars.length;

    // --- サイズ計算（スケール clamp + 段階退避） ---
    const s = clamp(Math.min(w / 420, h / 260), 0.6, 1.6);
    const tickFont = Math.round(clamp(10.5 * s, 8, 16));
    const xFont = Math.round(clamp(11 * s, 8, 17));
    const valueFont = Math.round(clamp(11.5 * s, 8, 18));

    // --- Y ドメイン（0 を必ず含める） ---
    let lo = 0;
    let hi = 0;
    for (const b of bars) {
        lo = Math.min(lo, b.from, b.to);
        hi = Math.max(hi, b.from, b.to);
    }
    if (hi - lo <= 0) {
        hi = lo + 1;
    }
    const padV = (hi - lo) * 0.04;
    const dLo = lo < 0 ? lo - padV : lo;
    const dHi = hi + padV;

    const axisVisible = opts.showAxis && w >= 170 && h >= 120;
    const ticks = axisVisible ? niceTicks(dLo, dHi, clamp(Math.round(h / 70), 3, 7)) : [];
    const tDec = ticks.length ? Math.max(opts.valueDecimals, tickDecimals(ticks)) : 0;
    const tickLabels = ticks.map((t) => fmtValue(t, Number.isInteger(t) ? 0 : tDec, opts.abbreviateValue));
    const maxTickW = tickLabels.reduce((m, t) => Math.max(m, estimateTextWidth(t, tickFont)), 0);

    // --- マージン ---
    const valueLabelsWanted = opts.showValues && h >= 100;
    const marginTop = valueLabelsWanted ? valueFont + 10 : 8;
    const marginRight = 10;
    const marginLeft = axisVisible ? Math.ceil(maxTickW) + 14 : 10;

    // X ラベル: 収まれば水平、無理なら回転、それでも無理なら非表示
    const xLabelsWanted = opts.showXLabels && h >= 110;
    const pitchGuess = Math.max(1, (w - marginLeft - marginRight) / n);
    const maxXLabelW = bars.reduce((m, b) => Math.max(m, estimateTextWidth(b.label, xFont)), 0);
    const xHorizontal = maxXLabelW <= pitchGuess - 6;
    let xRotated = false;
    let xLabelBudget = 0;
    let marginBottom = valueLabelsWanted ? valueFont + 8 : 8;
    if (xLabelsWanted && pitchGuess >= 12) {
        if (xHorizontal) {
            marginBottom += xFont + 8;
        } else {
            xRotated = true;
            xLabelBudget = clamp(h * 0.26, 30, 96);
            marginBottom += Math.ceil(xLabelBudget * 0.66) + 6;
        }
    }

    const plotW = Math.max(20, w - marginLeft - marginRight);
    const plotH = Math.max(20, h - marginTop - marginBottom);
    const pitch = plotW / n;
    const barW = clamp(pitch * 0.62, 1.5, 90);

    const yOf = (v) => marginTop + ((dHi - v) / (dHi - dLo)) * plotH;
    const xOf = (i) => marginLeft + i * pitch + (pitch - barW) / 2;

    // 値ラベル: 最も広い推定ラベルがピッチに収まらなければ全て非表示（個別非表示は不揃いに見える）
    const valueStrs = bars.map((b) =>
        b.type === 'delta' ? fmtSigned(b.delta, opts.valueDecimals, opts.abbreviateValue)
            : fmtValue(b.to, opts.valueDecimals, opts.abbreviateValue)
    );
    const maxValueW = valueStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, valueFont)), 0);
    const valuesVisible = valueLabelsWanted && maxValueW <= pitch * 1.04;

    const incColor = opts.invertColors ? opts.decreaseColor : opts.increaseColor;
    const decColor = opts.invertColors ? opts.increaseColor : opts.decreaseColor;
    const barColor = (b) => {
        if (b.type === 'total' || b.type === 'start') return opts.totalColor;
        if (b.delta > 0) return incColor;
        if (b.delta < 0) return decColor;
        return pal.neutral;
    };

    // バーごとのアニメーション進捗（左から順に伸びる）
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const barT = (i) => {
        if (progress >= 1) return 1;
        const delay = n > 0 ? i / (2 * n) : 0;
        return ease(clamp01((progress - delay) / 0.5));
    };

    const zeroY = yOf(0);

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
                fontFamily: FONT_STACK,
            }}
        >
            <svg width={w} height={h} style={{ display: 'block' }}>
                {/* グリッド + Y軸目盛 */}
                {axisVisible &&
                    ticks.map((t, i) => (
                        <g key={`t${i}`}>
                            <line
                                x1={marginLeft}
                                x2={w - marginRight}
                                y1={yOf(t)}
                                y2={yOf(t)}
                                stroke={t === 0 ? 'none' : pal.grid}
                                strokeWidth={1}
                            />
                            <text
                                data-role="wf-tick"
                                x={marginLeft - 6}
                                y={yOf(t) + tickFont * 0.35}
                                textAnchor="end"
                                fontSize={tickFont}
                                fill={pal.subText}
                            >
                                {tickLabels[i]}
                            </text>
                        </g>
                    ))}

                {/* ゼロ基準線 */}
                <line
                    data-role="wf-zero"
                    x1={marginLeft}
                    x2={w - marginRight}
                    y1={zeroY}
                    y2={zeroY}
                    stroke={pal.zero}
                    strokeWidth={1.2}
                />

                {/* コネクタ（点線）: バー i の到達レベルを次のバーまで延長 */}
                {opts.showConnectors &&
                    bars.slice(0, -1).map((b, i) => {
                        const y = yOf(b.to);
                        const t = Math.min(barT(i), barT(i + 1));
                        return (
                            <line
                                key={`c${i}`}
                                data-role="wf-conn"
                                x1={xOf(i) + barW}
                                x2={xOf(i + 1)}
                                y1={y}
                                y2={y}
                                stroke={pal.connector}
                                strokeWidth={1}
                                strokeDasharray="3,3"
                                opacity={t}
                            />
                        );
                    })}

                {/* バー本体 */}
                {bars.map((b, i) => {
                    const t = barT(i);
                    const yTopFull = yOf(Math.max(b.from, b.to));
                    const yBotFull = yOf(Math.min(b.from, b.to));
                    const fullH = Math.max(yBotFull - yTopFull, 1.5);
                    const grownH = Math.max(fullH * t, t > 0 ? 1 : 0);
                    // from 側を支点に to 側へ伸ばす
                    const fromY = yOf(b.from);
                    const growUp = b.to >= b.from;
                    const y = growUp ? fromY - grownH : fromY;
                    const color = barColor(b);
                    const tip =
                        b.type === 'delta'
                            ? `${b.label}: ${fmtSigned(b.delta, opts.valueDecimals, false)}（累計 ${fmtValue(b.cum, opts.valueDecimals, false)}）`
                            : `${b.label}: ${fmtValue(b.to, opts.valueDecimals, false)}`;
                    return (
                        <rect
                            key={`b${i}`}
                            data-role="wf-bar"
                            data-type={b.type}
                            x={xOf(i)}
                            y={y}
                            width={barW}
                            height={Math.max(grownH, 1)}
                            rx={Math.min(2.5, barW / 3)}
                            fill={color}
                            opacity={b.type === 'delta' && b.delta === 0 ? 0.6 : 0.92}
                            style={opts.showGlow ? { filter: `drop-shadow(0 0 ${Math.round(6 * s)}px ${withAlpha(color, 0.55)})` } : undefined}
                        >
                            <title>{tip}</title>
                        </rect>
                    );
                })}

                {/* 値ラベル */}
                {valuesVisible &&
                    bars.map((b, i) => {
                        const t = barT(i);
                        const growUp = b.to >= b.from;
                        const yEdge = yOf(growUp ? Math.max(b.from, b.to) : Math.min(b.from, b.to));
                        const y = growUp ? yEdge - 5 : yEdge + valueFont + 3;
                        return (
                            <text
                                key={`v${i}`}
                                data-role="wf-val"
                                x={xOf(i) + barW / 2}
                                y={clamp(y, valueFont, h - 3)}
                                textAnchor="middle"
                                fontSize={valueFont}
                                fontWeight={b.type === 'total' ? 700 : 600}
                                fill={b.type === 'delta' && b.delta === 0 ? pal.subText : barColor(b)}
                                opacity={t}
                            >
                                {valueStrs[i]}
                            </text>
                        );
                    })}

                {/* X軸ラベル */}
                {xLabelsWanted &&
                    pitchGuess >= 12 &&
                    bars.map((b, i) => {
                        const cx = marginLeft + i * pitch + pitch / 2;
                        const yBase = h - marginBottom + xFont + 4;
                        if (!xRotated) {
                            return (
                                <text
                                    key={`x${i}`}
                                    data-role="wf-xlabel"
                                    x={cx}
                                    y={yBase}
                                    textAnchor="middle"
                                    fontSize={xFont}
                                    fill={b.type === 'total' ? pal.text : pal.subText}
                                    fontWeight={b.type === 'total' ? 700 : 400}
                                >
                                    {b.label}
                                </text>
                            );
                        }
                        const shown = truncateToWidth(b.label, xFont, xLabelBudget);
                        return (
                            <text
                                key={`x${i}`}
                                data-role="wf-xlabel"
                                x={cx}
                                y={yBase}
                                textAnchor="end"
                                fontSize={xFont}
                                fill={b.type === 'total' ? pal.text : pal.subText}
                                fontWeight={b.type === 'total' ? 700 : 400}
                                transform={`rotate(-40 ${cx} ${yBase})`}
                            >
                                <title>{b.label}</title>
                                {shown}
                            </text>
                        );
                    })}
            </svg>

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
                            labelIdx: model.labelIdx,
                            valIdx: model.valIdx,
                            typeIdx: model.typeIdx,
                            bars,
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
    const colorScheme = themeApi?.theme;
    if (!colorScheme) return null; // テーマ未取得の間はレンダリングしない
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <WaterfallChart mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
