import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
    useMode,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// KPI Tile（アイコン付き KPI 統計タイル）
//
// SOC ダッシュボードでよく見る「タイトル＋大きな数値＋前回比＋ミニ棒グラフ＋
// アイコンバッジ」を 1 枚のタイルで表示する。標準の Single Value と違い、
// アクセントカラーで統一されたネオン調のカード（グラデ背景・発光縁・スパーク
// ライン・アイコン）としてまとまり、複数枚並べて KPI 列を構成できる。
//
// データモデル（1行 = 時系列の1ポイント、行順が古→新）:
//   ラベル列 = 時刻など（既定は第1列。スパークラインのツールチップに使用）
//   値列     = 数値（既定は最終列）
//   ・大きな数値 = 最終行の値
//   ・増減（前日比）= 最終行 − 直前行
//   ・スパークライン = 全行の値を棒で表示
//   1列だけのデータは「値のみの系列」として扱う。
//
// アイコンは編集モード中にタイル上のアイコンバッジをクリック → ピッカーで選択
// （setOptions で保存）。編集パネルの「アイコン番号」でも指定できる。
//
// 表示はコンテナ実寸に自動フィット（ResizeObserver、無い環境は初回計測）。
// 小さいパネルではスパークライン → 増減 → タイトルの順に段階的に退避する。
// ---------------------------------------------------------------------------

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    labelField: '', // ラベル（時刻）フィールド（'' = 第1列）
    valueField: '', // 値フィールド（'' = 最終列）

    titleText: '', // タイトル（'' = 値フィールド名。ソースJSONで変更可）
    deltaLabel: '前日比', // 増減の注記（ソースJSONで変更可）

    accentColor: '#22d3ee', // アクセントカラー（タイル全体の基調色）
    showGlow: true, // 発光（グロー）
    bgOpacity: 100, // カード背景の不透明度（%、0で完全透過）

    iconIndex: 1, // アイコン番号（1〜ICONS.length）
    showIcon: true, // アイコンバッジを表示

    showTitle: true, // タイトルを表示
    showDelta: true, // 増減（前日比）を表示
    deltaAsPercent: false, // 増減を％で表示
    semanticDeltaColor: false, // 増減で色分け（増=緑/減=赤）
    invertDeltaColor: false, // 色分けを反転（増=赤/減=緑。アラート系向け）

    showSparkline: true, // スパークラインを表示
    sparkAsLine: false, // スパークラインを線グラフで表示（false = 棒）
    sparkBars: 0, // 表示する棒の本数（0 = 全ポイント）

    valueDecimals: 0, // 小数点以下の桁数
    abbreviateValue: false, // 1.5M などの省略表記
    animate: true, // カウントアップアニメーション

    debug: false, // options デバッグ表示
};

// 選択できるアイコン（24x24 stroke パス。編集モードのピッカーに一覧表示）
const ICONS = [
    { name: 'shield', label: 'シールド', paths: ['M12 3l7 3v5.2c0 4.8-3.4 7.9-7 9.3-3.6-1.4-7-4.5-7-9.3V6z'] },
    { name: 'home', label: '家', paths: ['M4 11l8-7 8 7', 'M6.5 9.5V20h11V9.5', 'M10 20v-5h4v5'] },
    { name: 'alert', label: '警告', paths: ['M12 4L21.5 20h-19z', 'M12 10v4.2', 'M12 16.6v0.2'] },
    { name: 'bolt', label: '稲妻', paths: ['M13 3L5.5 13.5H11L10 21l7.5-10.5H12z'] },
    {
        name: 'users',
        label: 'ユーザー',
        paths: ['M3.5 19c0-3 2.3-4.7 5-4.7s5 1.7 5 4.7', 'M14.5 18.5c0.3-2.4 1.9-3.7 3.9-3.7 1.7 0 3 0.9 3.6 2.7'],
        circles: [{ cx: 8.5, cy: 9.5, r: 3 }, { cx: 17.5, cy: 10.3, r: 2.4 }],
    },
    {
        name: 'eye',
        label: '監視',
        paths: ['M2.5 12C5 7.4 8.4 5.2 12 5.2S19 7.4 21.5 12C19 16.6 15.6 18.8 12 18.8S5 16.6 2.5 12z'],
        circles: [{ cx: 12, cy: 12, r: 3 }],
    },
    {
        name: 'globe',
        label: '地球',
        paths: ['M3.5 12h17', 'M12 3.5c3.2 2.6 3.2 14.4 0 17M12 3.5c-3.2 2.6-3.2 14.4 0 17'],
        circles: [{ cx: 12, cy: 12, r: 8.5 }],
    },
    { name: 'lock', label: '錠前', paths: ['M6.5 11h11v9h-11z', 'M8.5 11V8a3.5 3.5 0 017 0v3', 'M12 14.5V17'] },
    {
        name: 'bug',
        label: 'バグ',
        paths: [
            'M12 20c-2.8 0-4.8-2-4.8-4.8v-3.4a4.8 4.8 0 019.6 0v3.4C16.8 18 14.8 20 12 20z',
            'M12 11v9',
            'M7.2 14H4',
            'M20 14h-3.2',
            'M8 8.5L5.8 6.2',
            'M16 8.5l2.2-2.3',
        ],
    },
    {
        name: 'server',
        label: 'サーバー',
        paths: ['M4 5h16v6H4z', 'M4 13h16v6H4z'],
        circles: [{ cx: 7.2, cy: 8, r: 0.5 }, { cx: 7.2, cy: 16, r: 0.5 }],
    },
    {
        name: 'bell',
        label: 'ベル',
        paths: ['M12 4a5.5 5.5 0 015.5 5.5c0 3.9 1.3 5.3 2 6.3H4.5c0.7-1 2-2.4 2-6.3A5.5 5.5 0 0112 4z', 'M10 19.5a2 2 0 004 0'],
    },
    { name: 'pulse', label: '波形', paths: ['M3 12h4l2.5-5.5 4 10.5 2.5-5h5'] },
];

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
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.round(alpha * 1000) / 1000})`;
    return color;
}

// 大きな数値のフォーマット（カンマ区切り / 省略表記）
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

function fmtPct(p) {
    if (!Number.isFinite(p)) return '-';
    const a = Math.abs(p);
    const str = a >= 100 ? a.toFixed(0) : a.toFixed(1).replace(/\.0$/, '');
    return `${str}%`;
}

// CJK を含むかで文字幅を推定（数値フォントの収まり判定用の近似）
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.62;
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
    const strOr = (v, d) => (typeof v === 'string' ? v : d);

    return {
        labelField: typeof o.labelField === 'string' || Array.isArray(o.labelField) ? o.labelField : '',
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',

        titleText: strOr(o.titleText, ''),
        deltaLabel: strOr(o.deltaLabel, DEFAULTS.deltaLabel),

        accentColor: colorOr(o.accentColor, DEFAULTS.accentColor),
        showGlow: bool(o.showGlow, DEFAULTS.showGlow),
        bgOpacity: clamp(Math.round(numOr(o.bgOpacity, DEFAULTS.bgOpacity)), 0, 100),

        iconIndex: clamp(Math.round(numOr(o.iconIndex, DEFAULTS.iconIndex)), 1, ICONS.length),
        showIcon: bool(o.showIcon, DEFAULTS.showIcon),

        showTitle: bool(o.showTitle, DEFAULTS.showTitle),
        showDelta: bool(o.showDelta, DEFAULTS.showDelta),
        deltaAsPercent: bool(o.deltaAsPercent, DEFAULTS.deltaAsPercent),
        semanticDeltaColor: bool(o.semanticDeltaColor, DEFAULTS.semanticDeltaColor),
        invertDeltaColor: bool(o.invertDeltaColor, DEFAULTS.invertDeltaColor),

        showSparkline: bool(o.showSparkline, DEFAULTS.showSparkline),
        sparkAsLine: bool(o.sparkAsLine, DEFAULTS.sparkAsLine),
        sparkBars: clamp(Math.round(numOr(o.sparkBars, DEFAULTS.sparkBars)), 0, 500),

        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),
        abbreviateValue: bool(o.abbreviateValue, DEFAULTS.abbreviateValue),
        animate: bool(o.animate, DEFAULTS.animate),

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
// 系列構築（行 → {points, value, prev}）
// ---------------------------------------------------------------------------

function buildSeries(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { error: 'empty', points: [] };

    let labelIdx;
    let valIdx;
    if (colCount === 1) {
        labelIdx = -1;
        valIdx = 0;
    } else {
        labelIdx = resolveFieldIndex(opts.labelField, fieldNames, rows, 0);
        valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, colCount - 1);
        if (valIdx === labelIdx) valIdx = labelIdx === colCount - 1 ? 0 : colCount - 1;
    }

    const points = [];
    rows.forEach((row, i) => {
        if (!Array.isArray(row)) return;
        const v = parseNum(row[valIdx]);
        if (!Number.isFinite(v)) return;
        const rawLabel = labelIdx >= 0 ? row[labelIdx] : null;
        const label = rawLabel === null || rawLabel === undefined ? `#${i + 1}` : String(rawLabel);
        points.push({ label, value: v });
    });
    if (points.length === 0) return { error: 'novalue', points: [] };

    const value = points[points.length - 1].value;
    const prev = points.length >= 2 ? points[points.length - 2].value : null;
    return { points, value, prev, labelIdx, valIdx };
}

// ---------------------------------------------------------------------------
// テーマ×アクセントの配色
// ---------------------------------------------------------------------------

// bgAlpha(0〜1) はカード背景（ベース色とグラデ）だけに乗算する。枠線・文字・バッジ・
// スパークラインは可読性維持のため透過しない。
function tileColors(mode, accent, bgAlpha = 1) {
    const a = clamp01(bgAlpha);
    if (mode === 'dark') {
        return {
            cardBase: withAlpha('#0d1020', a),
            cardGrad: `linear-gradient(150deg, ${withAlpha(accent, 0.2 * a)} 0%, ${withAlpha(accent, 0.05 * a)} 42%, rgba(10,12,24,0) 72%)`,
            border: withAlpha(accent, 0.45),
            title: accent,
            value: mixColor(accent, '#ffffff', 0.38),
            deltaNeutral: mixColor(accent, '#ffffff', 0.22),
            subText: '#8b98a5',
            badgeBg: withAlpha(accent, 0.16),
            badgeBorder: withAlpha(accent, 0.55),
            icon: mixColor(accent, '#ffffff', 0.25),
            bar: accent,
            panelBg: 'rgba(13,16,32,0.97)',
            panelBorder: withAlpha(accent, 0.4),
            up: '#3fb950',
            down: '#f85149',
        };
    }
    return {
        cardBase: withAlpha('#ffffff', a),
        cardGrad: `linear-gradient(150deg, ${withAlpha(accent, 0.12 * a)} 0%, ${withAlpha(accent, 0.03 * a)} 42%, rgba(255,255,255,0) 72%)`,
        border: withAlpha(accent, 0.4),
        title: mixColor(accent, '#000000', 0.25),
        value: mixColor(accent, '#000000', 0.35),
        deltaNeutral: mixColor(accent, '#000000', 0.3),
        subText: '#5c6773',
        badgeBg: withAlpha(accent, 0.1),
        badgeBorder: withAlpha(accent, 0.45),
        icon: mixColor(accent, '#000000', 0.2),
        bar: accent,
        panelBg: 'rgba(255,255,255,0.98)',
        panelBorder: withAlpha(accent, 0.4),
        up: '#1a7f37',
        down: '#cf222e',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// アイコン描画
// ---------------------------------------------------------------------------

function IconGlyph({ icon, size, color, strokeWidth = 1.7 }) {
    if (!icon) return null;
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            {(icon.paths || []).map((d, i) => (
                <path
                    key={`p${i}`}
                    d={d}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                />
            ))}
            {(icon.circles || []).map((c, i) => (
                <circle
                    key={`c${i}`}
                    cx={c.cx}
                    cy={c.cy}
                    r={c.r}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    fill={c.r < 1 ? color : 'none'}
                />
            ))}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// カウントアップ（値変更時に easeOutCubic で追従）
// ---------------------------------------------------------------------------

function useCountUp(target, enabled) {
    const [disp, setDisp] = useState(enabled ? 0 : target);
    const dispRef = useRef(enabled ? 0 : target);

    useEffect(() => {
        if (!Number.isFinite(target)) return undefined;
        if (!enabled || typeof requestAnimationFrame === 'undefined') {
            dispRef.current = target;
            setDisp(target);
            return undefined;
        }
        const from = Number.isFinite(dispRef.current) ? dispRef.current : 0;
        if (from === target) {
            setDisp(target);
            return undefined;
        }
        const dur = 700;
        let rafId = 0;
        let t0 = 0;
        const step = (ts) => {
            if (!t0) t0 = ts;
            const t = clamp01((ts - t0) / dur);
            const e = 1 - Math.pow(1 - t, 3);
            const v = from + (target - from) * e;
            dispRef.current = v;
            setDisp(v);
            if (t < 1) rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
        return () => cancelAnimationFrame(rafId);
    }, [target, enabled]);

    return Number.isFinite(target) ? (enabled ? disp : target) : NaN;
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

function KpiTile({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;
    const setOptions = optionsApi?.setOptions;
    const modeApi = useMode();
    const isEdit = modeApi?.mode === 'edit';

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const series = useMemo(() => buildSeries(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 320, h: 210 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 320;
        const h = el.clientHeight || 210;
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

    const [pickerOpen, setPickerOpen] = useState(false);
    useEffect(() => {
        if (!isEdit) setPickerOpen(false);
    }, [isEdit]);

    const value = series.error ? NaN : series.value;
    const dispValue = useCountUp(value, opts.animate);

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
    if (series.error === 'novalue') {
        return <CenterMessage>数値データが見つかりません。値フィールドの選択を確認してください。</CenterMessage>;
    }
    if (series.error) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    const pal = tileColors(mode, opts.accentColor, opts.bgOpacity / 100);
    const accent = opts.accentColor;

    // --- サイズ計算（スケール clamp + 段階退避） ---
    const s = clamp(Math.min(w / 230, h / 175), 0.55, 2.4);
    const pad = Math.round(clamp(16 * s, 8, 36));
    const titleFont = Math.round(clamp(13.5 * s, 10, 27));
    const deltaFont = Math.round(clamp(11.5 * s, 9, 23));
    const badge = Math.round(clamp(34 * s, 22, 60));

    const titleVisible = opts.showTitle && h >= 64;
    const iconVisible = opts.showIcon && h >= 64 && w >= 120;
    const deltaVisible = opts.showDelta && series.prev !== null && h >= 96;
    const sparkVisible = opts.showSparkline && series.points.length >= 2 && h >= 140;
    const sparkH = Math.round(clamp(h * 0.28, 22, 96));

    // 大数値：まず基準サイズ、収まらなければ幅に合わせて縮小
    const valueStr = fmtValue(dispValue, opts.valueDecimals, opts.abbreviateValue);
    let valueFont = Math.round(clamp(34 * s, 16, 76));
    {
        const avail = Math.max(40, w - pad * 2 - (iconVisible && !titleVisible ? badge + 8 : 0));
        const est = estimateTextWidth(valueStr, valueFont);
        if (est > avail) valueFont = Math.max(12, Math.floor((valueFont * avail) / est));
    }

    // --- 増減（前日比） ---
    const delta = series.prev !== null ? series.value - series.prev : null;
    let deltaText = '';
    let deltaColor = pal.deltaNeutral;
    if (delta !== null) {
        const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
        let mag;
        if (opts.deltaAsPercent && series.prev !== 0) {
            mag = fmtPct((delta / Math.abs(series.prev)) * 100);
        } else {
            mag = fmtValue(Math.abs(delta), opts.valueDecimals, opts.abbreviateValue);
        }
        const suffix = opts.deltaLabel ? ` (${opts.deltaLabel})` : '';
        deltaText = `${arrow} ${mag}${suffix}`;
        if (opts.semanticDeltaColor && delta !== 0) {
            const upIsGood = !opts.invertDeltaColor;
            const good = delta > 0 ? upIsGood : !upIsGood;
            deltaColor = good ? pal.up : pal.down;
        } else if (delta === 0) {
            deltaColor = pal.subText;
        }
    }

    // --- スパークライン（棒） ---
    const sparkW = Math.max(20, w - pad * 2);
    let barPoints = series.points;
    const maxBars = Math.max(4, Math.floor(sparkW / 3)); // 1本あたり最低3px
    const wanted = opts.sparkBars > 0 ? opts.sparkBars : barPoints.length;
    const nBars = Math.min(wanted, maxBars, barPoints.length);
    barPoints = barPoints.slice(barPoints.length - nBars);
    const vals = barPoints.map((p) => p.value);
    const vMax = Math.max(...vals, 0);
    const vMin = Math.min(...vals, 0);
    const range = vMax - vMin || 1;

    const iconIdx = opts.iconIndex - 1;
    const icon = ICONS[clamp(iconIdx, 0, ICONS.length - 1)];

    const pickIcon = (idx) => {
        if (typeof setOptions === 'function') {
            setOptions({ ...(options && typeof options === 'object' ? options : {}), iconIndex: idx + 1 });
        }
        setPickerOpen(false);
    };

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: Math.round(clamp(13 * s, 8, 22)),
                border: `1px solid ${pal.border}`,
                background: `${pal.cardGrad}, ${pal.cardBase}`,
                boxShadow: opts.showGlow
                    ? mode === 'dark'
                        ? `0 0 ${Math.round(20 * s)}px ${withAlpha(accent, 0.16)}, inset 0 0 ${Math.round(30 * s)}px ${withAlpha(accent, 0.07)}`
                        : `0 2px ${Math.round(14 * s)}px ${withAlpha(accent, 0.18)}`
                    : 'none',
                padding: pad,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                fontFamily: FONT_STACK,
            }}
        >
            {/* タイトル行（左：タイトル、右：アイコンバッジ） */}
            {(titleVisible || iconVisible) && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: titleVisible ? 'space-between' : 'flex-end',
                        gap: 8,
                        minHeight: iconVisible ? badge : undefined,
                    }}
                >
                    {titleVisible && (
                        <div
                            style={{
                                color: pal.title,
                                fontSize: titleFont,
                                fontWeight: 700,
                                letterSpacing: 0.3,
                                lineHeight: 1.25,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                paddingTop: iconVisible ? Math.round(badge * 0.12) : 0,
                            }}
                            title={opts.titleText || fieldNames[series.valIdx] || ''}
                        >
                            {opts.titleText || fieldNames[series.valIdx] || 'KPI'}
                        </div>
                    )}
                    {iconVisible && (
                        <div
                            data-role="icon-badge"
                            onClick={isEdit ? () => setPickerOpen((v) => !v) : undefined}
                            title={isEdit ? 'クリックしてアイコンを選択' : undefined}
                            style={{
                                flex: 'none',
                                width: badge,
                                height: badge,
                                borderRadius: '50%',
                                background: pal.badgeBg,
                                border: `1px ${isEdit ? 'dashed' : 'solid'} ${pal.badgeBorder}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: isEdit ? 'pointer' : 'default',
                            }}
                        >
                            <IconGlyph icon={icon} size={Math.round(badge * 0.58)} color={pal.icon} />
                        </div>
                    )}
                </div>
            )}

            {/* 大数値 */}
            <div
                style={{
                    color: pal.value,
                    fontSize: valueFont,
                    fontWeight: 800,
                    lineHeight: 1.08,
                    letterSpacing: 0.5,
                    fontVariantNumeric: 'tabular-nums',
                    marginTop: titleVisible || iconVisible ? Math.round(2 * s) : 0,
                    textShadow: opts.showGlow && mode === 'dark' ? `0 0 ${Math.round(14 * s)}px ${withAlpha(accent, 0.45)}` : 'none',
                }}
            >
                {valueStr}
            </div>

            {/* 増減（前日比） */}
            {deltaVisible && (
                <div
                    style={{
                        color: deltaColor,
                        fontSize: deltaFont,
                        fontWeight: 600,
                        marginTop: Math.round(3 * s),
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {deltaText}
                </div>
            )}

            {/* スペーサ */}
            <div style={{ flex: 1, minHeight: 0 }} />

            {/* スパークライン（ミニ棒グラフ／折れ線グラフ） */}
            {sparkVisible && (
                <svg
                    data-role="spark"
                    data-spark-style={opts.sparkAsLine ? 'line' : 'bars'}
                    width={sparkW}
                    height={sparkH}
                    style={{ display: 'block', flex: 'none' }}
                >
                    {opts.sparkAsLine
                        ? (() => {
                              const n = barPoints.length;
                              const pitch = sparkW / n;
                              const dotR = clamp(2.6 * s, 2, 5);
                              const topPad = dotR + 1;
                              const lineW = clamp(1.7 * s, 1.2, 3);
                              const pts = barPoints.map((p, i) => {
                                  const frac = clamp01((p.value - Math.min(0, vMin)) / range);
                                  return {
                                      x: i * pitch + pitch / 2,
                                      y: topPad + (1 - frac) * (sparkH - topPad - 1),
                                  };
                              });
                              const lineD = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ');
                              const areaD = `M${pts[0].x},${sparkH} ${pts
                                  .map((pt) => `L${pt.x},${pt.y}`)
                                  .join(' ')} L${pts[n - 1].x},${sparkH} Z`;
                              const last = pts[n - 1];
                              return (
                                  <>
                                      <defs>
                                          {/* 線の下は下方向へ薄くなるアクセント色グラデーション */}
                                          <linearGradient id="spark-line-grad" x1="0" y1="0" x2="0" y2="1">
                                              <stop offset="0%" stopColor={withAlpha(accent, 0.45)} />
                                              <stop offset="100%" stopColor={withAlpha(accent, 0)} />
                                          </linearGradient>
                                      </defs>
                                      <path d={areaD} fill="url(#spark-line-grad)" stroke="none" />
                                      <path
                                          d={lineD}
                                          fill="none"
                                          stroke={pal.bar}
                                          strokeWidth={lineW}
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                      />
                                      <circle cx={last.x} cy={last.y} r={dotR} fill={pal.bar} />
                                      {barPoints.map((p, i) => (
                                          <rect
                                              key={`h${i}`}
                                              data-role="spark-hit"
                                              x={i * pitch}
                                              y={0}
                                              width={pitch}
                                              height={sparkH}
                                              fill="transparent"
                                          >
                                              <title>{`${p.label}: ${fmtValue(p.value, opts.valueDecimals, false)}`}</title>
                                          </rect>
                                      ))}
                                  </>
                              );
                          })()
                        : barPoints.map((p, i) => {
                              const n = barPoints.length;
                              const pitch = sparkW / n;
                              const bw = clamp(pitch * 0.62, 2, 14);
                              const x = i * pitch + (pitch - bw) / 2;
                              const frac = clamp01((p.value - Math.min(0, vMin)) / range);
                              const bh = Math.max(2, frac * (sparkH - 2));
                              const y = sparkH - bh;
                              const opacity = n > 1 ? 0.4 + 0.6 * (i / (n - 1)) : 1;
                              return (
                                  <rect
                                      key={`b${i}`}
                                      x={x}
                                      y={y}
                                      width={bw}
                                      height={bh}
                                      rx={Math.min(2, bw / 2)}
                                      fill={pal.bar}
                                      opacity={opacity}
                                  >
                                      <title>{`${p.label}: ${fmtValue(p.value, opts.valueDecimals, false)}`}</title>
                                  </rect>
                              );
                          })}
                </svg>
            )}

            {/* アイコンピッカー（編集モードのみ。バッジクリックで開閉） */}
            {isEdit && pickerOpen && (
                <>
                    <div
                        data-role="icon-picker-backdrop"
                        onClick={() => setPickerOpen(false)}
                        style={{ position: 'absolute', inset: 0, zIndex: 9, background: 'transparent' }}
                    />
                    <div
                        data-role="icon-picker"
                        style={{
                            position: 'absolute',
                            top: pad + badge + 6,
                            right: pad,
                            zIndex: 10,
                            background: pal.panelBg,
                            border: `1px solid ${pal.panelBorder}`,
                            borderRadius: 10,
                            padding: 8,
                            display: 'grid',
                            gridTemplateColumns: 'repeat(4, auto)',
                            gap: 6,
                            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                        }}
                    >
                        {ICONS.map((ic, i) => {
                            const selected = i === iconIdx;
                            return (
                                <button
                                    key={ic.name}
                                    type="button"
                                    data-role="icon-choice"
                                    title={ic.label}
                                    onClick={() => pickIcon(i)}
                                    style={{
                                        width: 36,
                                        height: 36,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        borderRadius: 8,
                                        border: `1px solid ${selected ? pal.badgeBorder : 'transparent'}`,
                                        background: selected ? pal.badgeBg : 'transparent',
                                        cursor: 'pointer',
                                        padding: 0,
                                    }}
                                >
                                    <IconGlyph icon={ic} size={20} color={pal.icon} />
                                </button>
                            );
                        })}
                    </div>
                </>
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
                            labelIdx: series.labelIdx,
                            valIdx: series.valIdx,
                            points: series.points.length,
                            value: series.value,
                            prev: series.prev,
                            mode: modeApi?.mode,
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
            <KpiTile mode={mode} />
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
