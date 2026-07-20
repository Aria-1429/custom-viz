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
// Bullet Graph（ブレットグラフ・リスト）
//
// Stephen Few がゲージの代替として設計した高密度 KPI 表現。1 行 = 1 指標で、
// 「実績バー」「目標ティック」「良/可/不可の質的バンド」を 1 本に重ねて表示する。
// 多数の KPI を省スペースで一覧でき、目標比のステータスが一目で分かる。
// Splunk 標準ビジュアライゼーション（bar/gauge/single value 等）では
// 目標ティックと質的バンドの重畳を再現できない。
//
// データモデル（1行 = 1 KPI）:
//   ラベル列 = 指標名（既定は第1列。数値でない最初の列を優先）
//   実績列   = 実績値（既定は最初の数値列）
//   目標列   = 任意。フィールド名 target/goal/plan/目標/計画/予算 等は自動検出。
//              無ければ 2 番目の数値列を目標とみなす
//   比較列   = 任意（前回値など）。prev/previous/前回/前期 等の名前で自動検出
//   range1..range3 / band1..band3 列 = 任意。バンド境界の絶対値指定
//
// バンド境界は既定で「目標 × band1Pct% / band2Pct%」（range 列があれば絶対値）。
// 実績バーは達成度に応じて 不可=赤 / 可=黄 / 良=緑 に色分け（OFF で単色）。
// コンテナ実寸へ自動フィットし、行数が多いときは縦スクロール。小さいパネルでは
// 達成率 → 値 → ラベルの順に段階的に退避する。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    labelField: '', // ラベル（指標名）フィールド（'' = 自動）
    valueField: '', // 実績フィールド（'' = 最初の数値列）
    targetField: '', // 目標フィールド（'' = 名前 or 2番目の数値列で自動検出）
    compareField: '', // 比較（前回値）フィールド（'' = 名前で自動検出）

    showBands: true, // 質的バンドを表示
    band1Pct: 60, // バンド境界1（目標比% ここ未満=不可）
    band2Pct: 85, // バンド境界2（目標比% ここ未満=可）

    showTarget: true, // 目標ティックを表示
    showCompare: true, // 比較マーカーを表示
    showValues: true, // 実績値を表示
    showPercent: true, // 達成率(%)を表示
    sharedScale: false, // 全行で同一スケール
    sortByAchievement: false, // 達成率が低い順に並べ替え
    animate: true, // バーの伸長アニメーション

    useValueColors: true, // 達成度で実績バーを色分け
    goodColor: '#3fb950', // 良（目標圏内）の色
    warnColor: '#d29922', // 可の色
    badColor: '#f85149', // 不可の色
    barColor: '#4f8ff7', // 実績バーの色（色分けOFF時）

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: false, // 1.5M などの省略表記

    debug: false, // options デバッグ表示
};

// フィールド名による自動検出
const TARGET_RE = /^(target|goal|plan|budget|quota|目標|計画|予算|ノルマ)$/i;
const COMPARE_RE = /^(prev|previous|last|prior|compare|baseline|前回|前期|前年|昨年)$/i;
const RANGE_RE = /^(range|band)_?([123])$/i;

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

function fmtPercent(ratio) {
    if (!Number.isFinite(ratio)) return '-';
    const p = ratio * 100;
    if (Math.abs(p) >= 1e4) return `${Math.round(p).toExponential(1)}%`;
    return `${p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 1 : 0 })}%`;
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

    const band1 = clamp(numOr(o.band1Pct, DEFAULTS.band1Pct), 0, 1000);
    const band2 = clamp(numOr(o.band2Pct, DEFAULTS.band2Pct), 0, 1000);
    return {
        labelField: fieldOr(o.labelField),
        valueField: fieldOr(o.valueField),
        targetField: fieldOr(o.targetField),
        compareField: fieldOr(o.compareField),

        showBands: bool(o.showBands, DEFAULTS.showBands),
        band1Pct: Math.min(band1, band2),
        band2Pct: Math.max(band1, band2),

        showTarget: bool(o.showTarget, DEFAULTS.showTarget),
        showCompare: bool(o.showCompare, DEFAULTS.showCompare),
        showValues: bool(o.showValues, DEFAULTS.showValues),
        showPercent: bool(o.showPercent, DEFAULTS.showPercent),
        sharedScale: bool(o.sharedScale, DEFAULTS.sharedScale),
        sortByAchievement: bool(o.sortByAchievement, DEFAULTS.sortByAchievement),
        animate: bool(o.animate, DEFAULTS.animate),

        useValueColors: bool(o.useValueColors, DEFAULTS.useValueColors),
        goodColor: colorOr(o.goodColor, DEFAULTS.goodColor),
        warnColor: colorOr(o.warnColor, DEFAULTS.warnColor),
        badColor: colorOr(o.badColor, DEFAULTS.badColor),
        barColor: colorOr(o.barColor, DEFAULTS.barColor),

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
// モデル構築（行 → {label, value, target, compare, b1, b2, hi, status, pct}）
// ---------------------------------------------------------------------------

function buildModel(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { error: 'empty', items: [] };

    const isNumericCol = (i) =>
        rows.some((r) => Array.isArray(r) && Number.isFinite(parseNum(r[i])));

    // ラベル列: 選択 > 数値でない最初の列 > 第1列（1列データはラベル無し）
    let labelIdx = -1;
    if (colCount > 1) {
        let firstNonNumeric = -1;
        for (let i = 0; i < colCount; i += 1) {
            if (!isNumericCol(i)) {
                firstNonNumeric = i;
                break;
            }
        }
        labelIdx = resolveFieldIndex(
            opts.labelField, fieldNames, rows, firstNonNumeric >= 0 ? firstNonNumeric : 0
        );
    }

    // ユーザー明示選択（重複は実績 > 目標 > 比較 の優先で無効化）
    let valueIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, -1);
    let targetIdx = resolveFieldIndex(opts.targetField, fieldNames, rows, -1);
    let compareIdx = resolveFieldIndex(opts.compareField, fieldNames, rows, -1);
    if (valueIdx === labelIdx) valueIdx = -1;
    if (targetIdx === labelIdx || targetIdx === valueIdx) targetIdx = -1;
    if (compareIdx === labelIdx || compareIdx === valueIdx || compareIdx === targetIdx) compareIdx = -1;

    // range1..range3 / band1..band3 列（名前で自動検出・絶対値バンド境界）
    const rangeIdxs = [];
    for (let i = 0; i < colCount; i += 1) {
        const m = RANGE_RE.exec(fieldNames[i] || '');
        if (m && i !== labelIdx && i !== valueIdx && i !== targetIdx && i !== compareIdx && isNumericCol(i)) {
            rangeIdxs.push({ order: Number(m[2]), idx: i });
        }
    }
    rangeIdxs.sort((a, b) => a.order - b.order);
    const rangeCols = rangeIdxs.map((r) => r.idx);

    const taken = () => new Set([labelIdx, valueIdx, targetIdx, compareIdx, ...rangeCols]);

    // 目標・比較列の名前による自動検出
    if (targetIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (!taken().has(i) && TARGET_RE.test(fieldNames[i] || '') && isNumericCol(i)) {
                targetIdx = i;
                break;
            }
        }
    }
    if (compareIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (!taken().has(i) && COMPARE_RE.test(fieldNames[i] || '') && isNumericCol(i)) {
                compareIdx = i;
                break;
            }
        }
    }

    // 実績列: 未選択なら残りの最初の数値列
    if (valueIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (!taken().has(i) && isNumericCol(i)) {
                valueIdx = i;
                break;
            }
        }
    }
    if (valueIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (i !== labelIdx && isNumericCol(i)) {
                valueIdx = i;
                break;
            }
        }
    }
    if (valueIdx < 0) return { error: 'novalue', items: [] };

    // 目標列: 名前でも見つからなければ「実績の次の数値列」を目標とみなす
    if (targetIdx < 0) {
        for (let i = 0; i < colCount; i += 1) {
            if (!taken().has(i) && isNumericCol(i)) {
                targetIdx = i;
                break;
            }
        }
    }

    // --- 行 → アイテム ---
    const items = [];
    rows.forEach((row, i) => {
        if (!Array.isArray(row)) return;
        const value = parseNum(row[valueIdx]);
        if (!Number.isFinite(value)) return;
        const rawLabel = labelIdx >= 0 ? row[labelIdx] : null;
        const label = rawLabel === null || rawLabel === undefined ? `#${i + 1}` : String(rawLabel);
        const target = targetIdx >= 0 ? parseNum(row[targetIdx]) : NaN;
        const compare = compareIdx >= 0 ? parseNum(row[compareIdx]) : NaN;
        const ranges = rangeCols
            .map((c) => parseNum(row[c]))
            .filter((v) => Number.isFinite(v) && v >= 0)
            .sort((a, b) => a - b);

        let rawMax = Math.max(
            value,
            Number.isFinite(target) ? target * 1.05 : 0,
            Number.isFinite(compare) ? compare : 0,
            ranges.length > 0 ? ranges[ranges.length - 1] : 0,
            0
        );
        if (!(rawMax > 0)) rawMax = 1;
        items.push({ label, value, target, compare, ranges, rawMax });
    });
    if (items.length === 0) return { error: 'novalue', items: [] };

    // スケールとバンド境界（sharedScale なら全行共通の最大値）
    const globalMax = items.reduce((m, it) => Math.max(m, it.rawMax), 1);
    for (const it of items) {
        const base = opts.sharedScale ? globalMax : it.rawMax;
        it.hi = base * 1.06;
        if (it.ranges.length >= 2) {
            it.b1 = it.ranges[0];
            it.b2 = it.ranges[1];
        } else if (Number.isFinite(it.target) && it.target > 0) {
            it.b1 = (it.target * opts.band1Pct) / 100;
            it.b2 = (it.target * opts.band2Pct) / 100;
        } else {
            it.b1 = (base * opts.band1Pct) / 100;
            it.b2 = (base * opts.band2Pct) / 100;
        }
        it.status = it.value < it.b1 ? 'bad' : it.value < it.b2 ? 'warn' : 'good';
        it.pct = Number.isFinite(it.target) && it.target > 0 ? it.value / it.target : NaN;
    }

    if (opts.sortByAchievement) {
        items.sort((a, b) => {
            const ka = Number.isFinite(a.pct) ? a.pct : a.value / a.hi;
            const kb = Number.isFinite(b.pct) ? b.pct : b.value / b.hi;
            return ka - kb;
        });
    }

    return { items, labelIdx, valueIdx, targetIdx, compareIdx, rangeCols };
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function chartColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#c9d1d9',
            subText: '#8b98a5',
            bands: ['rgba(139,152,165,0.36)', 'rgba(139,152,165,0.22)', 'rgba(139,152,165,0.11)'],
            target: '#e6edf3',
            compare: '#8b98a5',
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: 'rgba(139,152,165,0.4)',
        };
    }
    return {
        text: '#2b3033',
        subText: '#5c6773',
        bands: ['rgba(92,103,115,0.32)', 'rgba(92,103,115,0.19)', 'rgba(92,103,115,0.09)'],
        target: '#2b3033',
        compare: '#5c6773',
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

function BulletGraph({ mode }) {
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
    const [dims, setDims] = useState({ w: 520, h: 320 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 520;
        const h = el.clientHeight || 320;
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
        () => (model.items || []).map((it) => `${it.label}:${it.value}:${it.target}`).join('|'),
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
        return <CenterMessage>数値データが見つかりません。実績フィールドの選択を確認してください。</CenterMessage>;
    }
    if (model.error) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    const pal = chartColors(mode);
    const items = model.items;
    const n = items.length;
    const anyTarget = items.some((it) => Number.isFinite(it.target));

    // --- 行の高さ（収まらなければ縦スクロール） ---
    const rowH = clamp(h / n, 26, 72);
    const contentH = Math.max(rowH * n, h);
    const scrolls = rowH * n > h + 1;

    // --- フォント ---
    const s = clamp(w / 480, 0.72, 1.5);
    const labelFont = Math.min(Math.round(clamp(12.5 * s, 9, 16)), Math.round(rowH * 0.48));
    const valueFont = Math.min(Math.round(clamp(13 * s, 10, 18)), Math.round(rowH * 0.52));
    const pctFont = Math.max(8, Math.round(valueFont * 0.82));

    // --- 表示要素の段階退避（達成率 → 値 → ラベル） ---
    const valueStrs = items.map((it) => fmtValue(it.value, opts.valueDecimals, opts.abbreviateValue));
    const pctStrs = items.map((it) => (Number.isFinite(it.pct) ? fmtPercent(it.pct) : ''));
    const maxLabelW = items.reduce((m, it) => Math.max(m, estimateTextWidth(it.label, labelFont)), 0);
    const valColW = Math.ceil(valueStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, valueFont)), 0));
    const pctColW = Math.ceil(pctStrs.reduce((m, t) => Math.max(m, estimateTextWidth(t, pctFont)), 0));

    let showLabels = w >= 150;
    let valuesVisible = opts.showValues && w >= 170;
    let pctVisible = opts.showPercent && valuesVisible && anyTarget && w >= 230;

    let labelW = showLabels ? Math.ceil(clamp(maxLabelW + 12, 36, w * 0.34)) : 0;
    const calcValueW = () => (valuesVisible ? valColW + (pctVisible ? pctColW + 8 : 0) : 0);
    const calcPlotW = () => w - (labelW + (showLabels ? 10 : 6)) - calcValueW() - 12;
    if (calcPlotW() < 70 && pctVisible) pctVisible = false;
    if (calcPlotW() < 70 && valuesVisible) valuesVisible = false;
    if (calcPlotW() < 70 && showLabels) {
        labelW = Math.ceil(Math.min(labelW, Math.max(36, w * 0.22)));
        if (calcPlotW() < 70) {
            showLabels = false;
            labelW = 0;
        }
    }
    const plotX = labelW + (showLabels ? 10 : 6);
    const plotW = Math.max(calcPlotW(), 24);

    // --- 行内ジオメトリ ---
    const bandH = clamp(rowH * 0.52, 10, 34);
    const barH = clamp(bandH * 0.42, 4, 15);
    const tickH = bandH * 1.2;
    const tickW = Math.max(2, 2.5 * s);

    // バーごとのアニメーション進捗（上から順に伸びる）
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const barT = (i) => {
        if (progress >= 1) return 1;
        const delay = n > 0 ? i / (2.5 * n) : 0;
        return ease(clamp01((progress - delay) / 0.6));
    };

    const statusColor = (st) =>
        st === 'bad' ? opts.badColor : st === 'warn' ? opts.warnColor : opts.goodColor;

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflowX: 'hidden',
                overflowY: scrolls ? 'auto' : 'hidden',
                fontFamily: FONT_STACK,
            }}
        >
            <svg width={w} height={contentH} style={{ display: 'block' }}>
                {items.map((it, i) => {
                    const y0 = i * rowH;
                    const cy = y0 + rowH / 2;
                    const xOf = (v) => plotX + clamp01(v / it.hi) * plotW;
                    const t = barT(i);
                    const barWpx = clamp01(Math.max(it.value, 0) / it.hi) * plotW * t;
                    const color = opts.useValueColors ? statusColor(it.status) : opts.barColor;
                    const tipParts = [`${it.label}: ${fmtValue(it.value, opts.valueDecimals, false)}`];
                    if (Number.isFinite(it.target)) {
                        tipParts.push(`目標 ${fmtValue(it.target, opts.valueDecimals, false)}`);
                        if (Number.isFinite(it.pct)) tipParts.push(`達成率 ${fmtPercent(it.pct)}`);
                    }
                    if (Number.isFinite(it.compare)) {
                        tipParts.push(`前回 ${fmtValue(it.compare, opts.valueDecimals, false)}`);
                    }
                    return (
                        <g key={`r${i}`} data-role="bg-row">
                            <title>{tipParts.join(' / ')}</title>

                            {/* 質的バンド（薄→濃を重ね描きで左角の丸みを保つ） */}
                            {opts.showBands && (
                                <g>
                                    <rect
                                        data-role="bg-band"
                                        data-band="2"
                                        x={plotX}
                                        y={cy - bandH / 2}
                                        width={plotW}
                                        height={bandH}
                                        rx={3}
                                        fill={pal.bands[2]}
                                    />
                                    <rect
                                        data-role="bg-band"
                                        data-band="1"
                                        x={plotX}
                                        y={cy - bandH / 2}
                                        width={Math.max(xOf(it.b2) - plotX, 0)}
                                        height={bandH}
                                        rx={3}
                                        fill={pal.bands[1]}
                                    />
                                    <rect
                                        data-role="bg-band"
                                        data-band="0"
                                        x={plotX}
                                        y={cy - bandH / 2}
                                        width={Math.max(xOf(it.b1) - plotX, 0)}
                                        height={bandH}
                                        rx={3}
                                        fill={pal.bands[0]}
                                    />
                                </g>
                            )}

                            {/* 実績バー */}
                            <rect
                                data-role="bg-bar"
                                data-status={it.status}
                                x={plotX}
                                y={cy - barH / 2}
                                width={Math.max(barWpx, it.value > 0 ? 1 : 0)}
                                height={barH}
                                rx={2}
                                fill={color}
                                opacity={0.95}
                            />

                            {/* 比較マーカー（前回値） */}
                            {opts.showCompare && Number.isFinite(it.compare) && (
                                <rect
                                    data-role="bg-compare"
                                    x={xOf(it.compare) - 1}
                                    y={cy - (bandH * 0.75) / 2}
                                    width={2}
                                    height={bandH * 0.75}
                                    fill={pal.compare}
                                    opacity={t}
                                />
                            )}

                            {/* 目標ティック */}
                            {opts.showTarget && Number.isFinite(it.target) && (
                                <rect
                                    data-role="bg-target"
                                    x={xOf(it.target) - tickW / 2}
                                    y={cy - tickH / 2}
                                    width={tickW}
                                    height={tickH}
                                    rx={1}
                                    fill={pal.target}
                                    opacity={t}
                                />
                            )}

                            {/* ラベル */}
                            {showLabels && (
                                <text
                                    data-role="bg-label"
                                    x={labelW}
                                    y={cy + labelFont * 0.35}
                                    textAnchor="end"
                                    fontSize={labelFont}
                                    fill={pal.text}
                                >
                                    {truncateToWidth(it.label, labelFont, labelW - 2)}
                                </text>
                            )}

                            {/* 実績値・達成率 */}
                            {valuesVisible && (
                                <text
                                    data-role="bg-val"
                                    x={w - 10 - (pctVisible ? pctColW + 8 : 0)}
                                    y={cy + valueFont * 0.35}
                                    textAnchor="end"
                                    fontSize={valueFont}
                                    fontWeight={700}
                                    fill={pal.text}
                                >
                                    {valueStrs[i]}
                                </text>
                            )}
                            {pctVisible && pctStrs[i] !== '' && (
                                <text
                                    data-role="bg-pct"
                                    x={w - 10}
                                    y={cy + pctFont * 0.35}
                                    textAnchor="end"
                                    fontSize={pctFont}
                                    fontWeight={600}
                                    fill={opts.useValueColors ? statusColor(it.status) : pal.subText}
                                >
                                    {pctStrs[i]}
                                </text>
                            )}
                        </g>
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
                            valueIdx: model.valueIdx,
                            targetIdx: model.targetIdx,
                            compareIdx: model.compareIdx,
                            rangeCols: model.rangeCols,
                            items,
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
            <BulletGraph mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
