import {
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import * as Flags from 'country-flag-icons/react/3x2';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

/* テーマ取得を待つ最大時間（ms）。超えたらフォールバック判定で描画する */
const THEME_WAIT_TIMEOUT_MS = 1500;

/* =========================================================================
 * 国名 → ISO 3166-1 alpha-2 コード解決
 *  - サーチ結果の値が "US" のような2文字コードでもそのまま使える
 *  - 代表的な国名（英語表記・別名）をマッピング
 *  - 解決できない場合はフォールバック表示（🌐）
 * ========================================================================= */
const COUNTRY_NAME_TO_ISO = {
    'united states': 'US',
    'united states of america': 'US',
    usa: 'US',
    china: 'CN',
    "people's republic of china": 'CN',
    germany: 'DE',
    netherlands: 'NL',
    russia: 'RU',
    'russian federation': 'RU',
    japan: 'JP',
    'south korea': 'KR',
    'korea, republic of': 'KR',
    'republic of korea': 'KR',
    'north korea': 'KP',
    'united kingdom': 'GB',
    uk: 'GB',
    'great britain': 'GB',
    france: 'FR',
    brazil: 'BR',
    india: 'IN',
    vietnam: 'VN',
    'viet nam': 'VN',
    iran: 'IR',
    'iran, islamic republic of': 'IR',
    taiwan: 'TW',
    'hong kong': 'HK',
    canada: 'CA',
    australia: 'AU',
    italy: 'IT',
    spain: 'ES',
    poland: 'PL',
    ukraine: 'UA',
    turkey: 'TR',
    turkiye: 'TR',
    'türkiye': 'TR',
    indonesia: 'ID',
    thailand: 'TH',
    singapore: 'SG',
    mexico: 'MX',
    argentina: 'AR',
    sweden: 'SE',
    norway: 'NO',
    finland: 'FI',
    denmark: 'DK',
    switzerland: 'CH',
    austria: 'AT',
    belgium: 'BE',
    'czech republic': 'CZ',
    czechia: 'CZ',
    romania: 'RO',
    bulgaria: 'BG',
    hungary: 'HU',
    portugal: 'PT',
    greece: 'GR',
    ireland: 'IE',
    israel: 'IL',
    'saudi arabia': 'SA',
    'united arab emirates': 'AE',
    uae: 'AE',
    egypt: 'EG',
    'south africa': 'ZA',
    nigeria: 'NG',
    kenya: 'KE',
    morocco: 'MA',
    pakistan: 'PK',
    bangladesh: 'BD',
    philippines: 'PH',
    malaysia: 'MY',
    kazakhstan: 'KZ',
    belarus: 'BY',
    lithuania: 'LT',
    latvia: 'LV',
    estonia: 'EE',
    moldova: 'MD',
    'moldova, republic of': 'MD',
    slovakia: 'SK',
    slovenia: 'SI',
    croatia: 'HR',
    serbia: 'RS',
    colombia: 'CO',
    chile: 'CL',
    peru: 'PE',
    venezuela: 'VE',
    ecuador: 'EC',
    'new zealand': 'NZ',
    iceland: 'IS',
    luxembourg: 'LU',
};

function resolveCountryCode(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;

    // 既に "US" / "us" のような ISO2 コードの場合
    if (/^[A-Za-z]{2}$/.test(raw)) {
        const upper = raw.toUpperCase();
        if (Flags[upper]) return upper;
    }
    const mapped = COUNTRY_NAME_TO_ISO[raw.toLowerCase()];
    if (mapped && Flags[mapped]) return mapped;
    return null;
}

/* =========================================================================
 * データ正規化（rows / columns 両形式に対応）
 * ========================================================================= */
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const numRows = data.columns[0].length;
            return Array.from({ length: numRows }, (_, i) =>
                data.columns.map((col) => col[i]),
            );
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || value === undefined) return null;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

/* 数値として解釈できる最初の列（ラベル列以外）を値列とする */
function detectColumns(fieldNames, rows) {
    const labelIndex = 0;
    let valueIndex = -1;
    const probe = rows[0] || [];
    for (let i = 0; i < probe.length; i += 1) {
        if (i === labelIndex) continue;
        if (toNumber(probe[i]) !== null) {
            valueIndex = i;
            break;
        }
    }
    if (valueIndex === -1) valueIndex = Math.min(1, probe.length - 1);
    return { labelIndex, valueIndex };
}

/* =========================================================================
 * オプション正規化
 *  - useOptions() は未設定/型不一致を返しうるので安全側に補正する
 *  - 列挙値（配色モード・並び順）は editor.color/checkbox/number しか確実に
 *    使えないため、UI 上は checkbox（__colorModeIsValue / __sortDesc）で受け、
 *    ここで文字列オプションへ落とし込む
 * ========================================================================= */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeColor(value, fallback) {
    if (typeof value === 'string' && HEX_RE.test(value.trim())) return value.trim();
    return fallback;
}

function safeBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

function safeNumberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};

    // 配色モード：boolean colorByValue（オフ＝palette / オン＝value）
    const colorMode = safeBool(o.colorByValue, false) ? 'value' : 'palette';

    // 並び順：boolean sortDescending（オン＝降順 / オフ＝昇順）
    const sortOrder = safeBool(o.sortDescending, true) ? 'desc' : 'asc';

    let topN = safeNumberOrNull(o.topN);
    if (topN === null || topN < 0) topN = 0;
    topN = Math.floor(topN);

    return {
        colorMode,
        paletteStartColor: safeColor(o.paletteStartColor, '#39d7ff'),
        paletteEndColor: safeColor(o.paletteEndColor, '#9b6bff'),
        lowColor: safeColor(o.lowColor, '#3fb950'),
        highColor: safeColor(o.highColor, '#ef4d4d'),
        useMidColor: safeBool(o.useMidColor, true),
        midColor: safeColor(o.midColor, '#f5c518'),
        reverseScale: safeBool(o.reverseScale, false),
        scaleMin: safeNumberOrNull(o.scaleMin),
        scaleMax: safeNumberOrNull(o.scaleMax),
        sortOrder,
        topN,
        showRank: safeBool(o.showRank, true),
        showFlag: safeBool(o.showFlag, true),
        showBar: safeBool(o.showBar, true),
        showValue: safeBool(o.showValue, true),
        showShare: safeBool(o.showShare, true),
        showHeader: safeBool(o.showHeader, true),
        compact: safeBool(o.compact, false),
        glow: safeBool(o.glow, true),
        animate: safeBool(o.animate, true),
        debug: safeBool(o.debug, false),
    };
}

/* =========================================================================
 * カラーユーティリティ（値ベース配色）
 * ========================================================================= */
function clamp01(t) {
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
}

function hexToRgb(hex) {
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const num = parseInt(h, 16);
    if (!Number.isFinite(num)) return { r: 128, g: 128, b: 128 };
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = clamp01(t);
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `rgb(${r}, ${g}, ${bl})`;
}

/* 値ベースのカラースケール：t(0..1) → 色。calendar-heatmap と同一ロジック */
function scaleColorFor(t, opts) {
    let u = clamp01(t);
    if (opts.reverseScale) u = 1 - u;
    if (opts.useMidColor) {
        return u <= 0.5
            ? lerpColor(opts.lowColor, opts.midColor, u / 0.5)
            : lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

/* =========================================================================
 * バーの配色を解決
 *  - palette モード: 順位に応じて開始色→終了色を補間（従来のネオン相当）
 *  - value モード:   値を [scaleLo, scaleHi] で 0..1 に正規化して低→(中)→高
 * 返り値は { fillStart, fillEnd, glow, glowSoft }
 * ========================================================================= */
function withAlpha(rgb, alpha) {
    // 'rgb(r, g, b)' → 'rgba(r, g, b, a)'
    return rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
}

function resolveBarColors({ opts, rank, total, value, scaleLo, scaleHi, isDark }) {
    if (opts.colorMode === 'value') {
        const range = scaleHi - scaleLo;
        const t = range > 0 ? (value - scaleLo) / range : 0.5;
        const mid = scaleColorFor(t, opts);
        // 発光感のため終了色を mid ベースに黒側へ 14% 寄せる
        const endColor = lerpColor(rgbStringToHex(mid), '#000000', 0.14);
        return {
            fillStart: mid,
            fillEnd: endColor,
            glow: withAlpha(mid, isDark ? 0.55 : 0.32),
            glowSoft: withAlpha(mid, isDark ? 0.28 : 0.16),
        };
    }

    // palette モード：順位に応じて開始色→終了色を補間
    const t = total <= 1 ? 0 : rank / (total - 1);
    const start = lerpColor(opts.paletteStartColor, opts.paletteEndColor, t);
    // バー内グラデーションの終端は、次段の色寄り（少し進めた位置）
    const end = lerpColor(
        opts.paletteStartColor,
        opts.paletteEndColor,
        clamp01(t + 0.12),
    );
    return {
        fillStart: start,
        fillEnd: end,
        glow: withAlpha(end, isDark ? 0.5 : 0.3),
        glowSoft: withAlpha(start, isDark ? 0.26 : 0.16),
    };
}

function rgbStringToHex(rgb) {
    const m = rgb.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return '#808080';
    const [, r, g, b] = m.map(Number);
    const to2 = (n) => n.toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/* =========================================================================
 * テーマ解決フック（無限スピナー対策）
 * ========================================================================= */
function detectFallbackColorScheme() {
    try {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = (params.get('theme') || '').toLowerCase();
        if (fromQuery === 'dark' || fromQuery === 'light') return fromQuery;

        const bg = window.getComputedStyle(document.body).backgroundColor || '';
        const match = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (match) {
            const [, r, g, b] = match.map(Number);
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            return luminance < 128 ? 'dark' : 'light';
        }
    } catch (e) {
        // 判定に失敗しても描画は続行する
    }
    return 'light';
}

function useResolvedColorScheme() {
    const themeContext = useTheme();
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setTimedOut(true), THEME_WAIT_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, []);

    const theme = themeContext && themeContext.theme;
    if (theme) return theme;
    if (timedOut) return detectFallbackColorScheme();
    return null; // まだ待機中
}

/* =========================================================================
 * 最小限のグローバルCSS（visualization.css は変更しない）
 * ========================================================================= */
const GLOBAL_CSS = `
@keyframes cg-grow {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
}
@keyframes cg-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
}
.cg-anim .cg-bar {
    transform-origin: left center;
    animation: cg-grow 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.cg-anim .cg-row {
    animation: cg-fade-in 0.45s ease both;
}
.cg-row { transition: background-color 0.15s ease; }
.cg-dark .cg-row:hover { background-color: rgba(120, 170, 255, 0.07); }
.cg-light .cg-row:hover { background-color: rgba(60, 100, 180, 0.07); }
@media (prefers-reduced-motion: reduce) {
    .cg-anim .cg-bar, .cg-anim .cg-row { animation: none; }
}
`;

function GlobalStyles() {
    return <style>{GLOBAL_CSS}</style>;
}

/* =========================================================================
 * コンテナ寸法計測フック（ResizeObserver ベース）
 *  - パネルが小さいと各列の最小幅の合計がはみ出して「見切れる」ため、
 *    実サイズを測って列構成・サイズを可変にする土台
 *  - ★重要：スクロールバー出現でサイズが 1px 揺れても再レンダしないよう
 *    等値ガードを入れる（入れないと再描画→スクロールバー消滅→…の
 *    フリッカーループに陥る）
 *  - 計測できない環境（happy-dom 等で clientWidth=0）は 0 のままとし、
 *    呼び出し側で「サイズ未確定＝フル表示」にフォールバックさせる
 * ========================================================================= */
function useElementSize() {
    const ref = useRef(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;

        const measure = () => {
            const w = el.clientWidth || 0;
            const h = el.clientHeight || 0;
            setSize((prev) => {
                // 1px 未満の差は無視（スクロールバー起因の揺れでの再描画を防ぐ）
                if (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1) {
                    return prev; // 同一とみなし setState をスキップ＝フリッカー防止
                }
                return { width: w, height: h };
            });
        };

        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return [ref, size];
}

/* =========================================================================
 * 計測幅からレスポンシブ表示プランを決定
 *  - width===0（未計測）は「フル表示」として扱う（テスト/初期描画の安全側）
 *  - 幅が狭まるほど非必須列を落とす：bar → flag → rank の順
 *  - 国名＋値は常に残す。極小幅ではシェアも省く
 * ========================================================================= */
function computeResponsivePlan(width, opts) {
    const w = width > 0 ? width : Infinity; // 未計測はフル扱い

    // 各表示可否（オプションON かつ 幅が足りる場合のみ）
    const showBar = opts.showBar && w >= 320;
    const showFlag = opts.showFlag && w >= 240;
    const showRank = opts.showRank && w >= 200;
    // 極小幅ではシェアを省いて値のみに
    const showShare = opts.showShare && w >= 260;

    // 段階的なサイズ縮小レベル（0=通常, 1=やや狭い, 2=かなり狭い）
    let tier = 0;
    if (w < 360) tier = 1;
    if (w < 260) tier = 2;

    return { showBar, showFlag, showRank, showShare, tier };
}

/* =========================================================================
 * インラインスタイル定義
 * ========================================================================= */
const MONO_FONT = "'Roboto Mono', 'SF Mono', Consolas, Menlo, monospace";

function buildStyles(colorScheme, opts, plan) {
    const isDark = colorScheme === 'dark';
    // 極小パネルでは compact 相当の詰めを強制（tier 1+ で詰める）
    const compact = opts.compact || plan.tier >= 1;
    const tight = plan.tier >= 2; // かなり狭い
    const textColor = isDark ? '#eef2fb' : '#22303e';
    const mutedColor = isDark ? '#8fa2c0' : '#66788c';
    const faintColor = isDark ? '#5a6b88' : '#93a3b8';
    const accent = isDark ? '#39d7ff' : '#0e93c9';
    const borderStrong = isDark ? 'rgba(120, 160, 220, 0.30)' : 'rgba(60, 80, 110, 0.28)';
    const borderWeak = isDark ? 'rgba(120, 160, 220, 0.12)' : 'rgba(60, 80, 110, 0.12)';
    const trackColor = isDark ? 'rgba(140, 170, 220, 0.10)' : 'rgba(60, 90, 140, 0.10)';

    // 幅に応じた列幅・余白・フォントの調整値
    const gap = tight ? 6 : compact ? 8 : 12;
    const rankW = tight ? '20px' : '26px';
    const flagW = tight ? '26px' : '34px';
    const valueW = compact ? '72px' : '96px';
    // 国名列の最小幅：狭いほど下げて、名前列が実際に縮められるようにする
    const nameMin = tight ? '48px' : compact ? '60px' : '90px';
    const wrapPad = tight ? '4px 6px' : compact ? '6px 10px' : '10px 14px';
    const rowPad = tight ? '5px 6px' : compact ? '6px 8px' : '11px 8px';

    // グリッド列は表示トグル＋レスポンシブ計画（plan）に応じて動的に構成する
    const cols = [];
    if (plan.showRank) cols.push(rankW);
    if (plan.showFlag) cols.push(flagW);
    cols.push(`minmax(${nameMin}, 1.1fr)`); // 国名は常時
    if (plan.showBar) cols.push('2fr');
    if (opts.showValue || plan.showShare) cols.push(valueW);

    return {
        wrapper: {
            boxSizing: 'border-box',
            width: '100%',
            height: '100%',
            padding: wrapPad,
            // 計測は外側要素で行うため、ここは縦スクロールのみ許可し
            // 横方向は列ドロップで収める（万一に備え auto は残す）
            overflowX: 'auto',
            overflowY: 'auto',
            color: textColor,
            fontVariantNumeric: 'tabular-nums',
        },
        headerRow: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 8px 8px',
            borderBottom: `1px solid ${borderStrong}`,
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: mutedColor,
        },
        headerAccent: {
            display: 'inline-block',
            width: '8px',
            height: '8px',
            marginRight: '8px',
            borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 8px ${accent}`,
            verticalAlign: 'middle',
        },
        row: {
            display: 'grid',
            gridTemplateColumns: cols.join(' '),
            alignItems: 'center',
            gap: `${gap}px`,
            padding: rowPad,
            minWidth: 0, // 名前列を実際に縮められるように
            borderBottom: `1px solid ${borderWeak}`,
            borderRadius: '6px',
        },
        rowLast: {
            borderBottom: 'none',
        },
        rank: {
            fontFamily: MONO_FONT,
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.05em',
            color: faintColor,
        },
        flagFrame: {
            display: 'inline-flex',
            width: tight ? '22px' : '30px',
            height: tight ? '15px' : '20px',
            overflow: 'hidden',
            borderRadius: '3px',
            boxShadow: `0 0 0 1px ${borderStrong}`,
        },
        flagSvg: {
            display: 'block',
            width: '100%',
            height: '100%',
        },
        flagFallback: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: tight ? '22px' : '30px',
            height: tight ? '15px' : '20px',
            borderRadius: '3px',
            boxShadow: `0 0 0 1px ${borderStrong}`,
            fontSize: tight ? '10px' : '12px',
        },
        countryName: {
            minWidth: 0, // ellipsis を効かせるため（grid セルの縮小を許可）
            overflow: 'hidden',
            fontSize: tight ? '12px' : compact ? '13px' : '14px',
            fontWeight: 600,
            letterSpacing: '0.01em',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        },
        barTrack: {
            position: 'relative',
            height: compact ? '8px' : '10px',
            borderRadius: '5px',
            background: trackColor,
            overflow: 'visible',
        },
        valueCell: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '1px',
        },
        value: {
            fontSize: tight ? '12px' : compact ? '13px' : '15px',
            fontWeight: 700,
            letterSpacing: '0.02em',
            lineHeight: 1.2,
        },
        share: {
            fontFamily: MONO_FONT,
            fontSize: '10px',
            color: faintColor,
            lineHeight: 1.2,
        },
        debugBox: {
            margin: '8px',
            padding: '8px 10px',
            border: `1px solid ${borderStrong}`,
            borderRadius: '6px',
            fontFamily: MONO_FONT,
            fontSize: '10px',
            lineHeight: 1.5,
            color: mutedColor,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
        },
    };
}

function barFillStyle(percent, colors, index, opts) {
    return {
        position: 'absolute',
        top: 0,
        left: 0,
        height: '100%',
        width: `${percent}%`,
        minWidth: '12px',
        borderRadius: '5px',
        background: `linear-gradient(90deg, ${colors.fillStart}, ${colors.fillEnd})`,
        boxShadow: opts.glow
            ? `0 0 10px ${colors.glow}, 0 0 22px ${colors.glowSoft}`
            : 'none',
        animationDelay: `${index * 70}ms`,
    };
}

/* =========================================================================
 * 表示コンポーネント
 * ========================================================================= */
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function NoDataState() {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <img src={chartIcon} className="viz-message-icon" alt="" />
                <Paragraph>No data available</Paragraph>
            </div>
        </div>
    );
}

function CountryFlag({ country, styles }) {
    const code = resolveCountryCode(country);
    const FlagComponent = code ? Flags[code] : null;
    if (!FlagComponent) {
        return (
            <span style={styles.flagFallback} role="img" aria-label="unknown country">
                🌐
            </span>
        );
    }
    return (
        <span style={styles.flagFrame}>
            <FlagComponent title={String(country)} style={styles.flagSvg} />
        </span>
    );
}

function CountryGraphTable({ fieldNames, rows, colorScheme, opts }) {
    const isDark = colorScheme === 'dark';

    // パネル実サイズを計測し、狭い時は列を落として収める
    const [measureRef, size] = useElementSize();
    const plan = useMemo(
        () => computeResponsivePlan(size.width, opts),
        [size.width, opts],
    );
    const styles = useMemo(
        () => buildStyles(colorScheme, opts, plan),
        [colorScheme, opts, plan],
    );

    const { labelIndex, valueIndex } = useMemo(
        () => detectColumns(fieldNames, rows),
        [fieldNames, rows],
    );

    // 1) 行を { country, value } に変換
    const baseItems = useMemo(
        () =>
            rows
                .map((row) => ({
                    country: row[labelIndex],
                    value: toNumber(row[valueIndex]),
                }))
                .filter((item) => item.country !== null && item.country !== undefined),
        [rows, labelIndex, valueIndex],
    );

    // 2) 並び替え → 上位N件で絞り込み
    const items = useMemo(() => {
        let arr = baseItems.slice();
        if (opts.sortOrder === 'desc') {
            arr.sort((a, b) => (b.value === null ? -Infinity : b.value) - (a.value === null ? -Infinity : a.value));
        } else if (opts.sortOrder === 'asc') {
            arr.sort((a, b) => (a.value === null ? Infinity : a.value) - (b.value === null ? Infinity : b.value));
        }
        if (opts.topN > 0) arr = arr.slice(0, opts.topN);
        return arr;
    }, [baseItems, opts.sortOrder, opts.topN]);

    const maxValue = useMemo(
        () => Math.max(...items.map((item) => (item.value === null ? 0 : item.value)), 1),
        [items],
    );

    const totalValue = useMemo(
        () => items.reduce((sum, item) => sum + (item.value === null ? 0 : item.value), 0),
        [items],
    );

    // 値ベース配色のスケール境界（空欄ならデータ min/max）
    const { scaleLo, scaleHi } = useMemo(() => {
        const vals = items
            .map((it) => it.value)
            .filter((v) => v !== null && Number.isFinite(v));
        const dataMin = vals.length ? Math.min(...vals) : 0;
        const dataMax = vals.length ? Math.max(...vals) : 1;
        const lo = opts.scaleMin !== null ? opts.scaleMin : dataMin;
        const hi = opts.scaleMax !== null ? opts.scaleMax : dataMax;
        return { scaleLo: lo, scaleHi: hi };
    }, [items, opts.scaleMin, opts.scaleMax]);

    if (items.length === 0) return <NoDataState />;

    const labelField = fieldNames[labelIndex] || 'Country';
    const valueField = fieldNames[valueIndex] || 'Value';
    // 値セルは「値」か（幅の残る）「シェア」のどちらかを表示する時のみ出す
    const showValueCell = opts.showValue || plan.showShare;

    const wrapperClass = [
        isDark ? 'cg-dark' : 'cg-light',
        opts.animate ? 'cg-anim' : '',
    ]
        .filter(Boolean)
        .join(' ');

    // 外側＝パネル実寸の計測用（overflow:hidden でスクロールバーの影響を排除）、
    // 内側＝実スクロール領域。計測要素のサイズが揺れないためフリッカーしない。
    return (
        <div
            ref={measureRef}
            style={{
                boxSizing: 'border-box',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
            }}
        >
        <div style={styles.wrapper} className={wrapperClass}>
            <GlobalStyles />
            {opts.debug && (
                <div style={styles.debugBox}>
                    {`options = ${JSON.stringify(opts, null, 2)}\nfields = ${JSON.stringify(
                        fieldNames,
                    )}\nrows = ${rows.length}, shown = ${items.length}\nscale = [${scaleLo}, ${scaleHi}]`}
                </div>
            )}
            {opts.showHeader && (
                <div style={styles.headerRow}>
                    <span>
                        <span style={styles.headerAccent} />
                        {labelField}
                    </span>
                    <span>{valueField}</span>
                </div>
            )}
            {items.map((item, index) => {
                const value = item.value === null ? 0 : item.value;
                const percent = Math.max(0, Math.min(100, (value / maxValue) * 100));
                const share = totalValue > 0 ? (value / totalValue) * 100 : 0;
                const colors = resolveBarColors({
                    opts,
                    rank: index,
                    total: items.length,
                    value,
                    scaleLo,
                    scaleHi,
                    isDark,
                });
                const isLast = index === items.length - 1;
                const rowStyle = {
                    ...(isLast ? { ...styles.row, ...styles.rowLast } : styles.row),
                    animationDelay: `${index * 55}ms`,
                };
                return (
                    <div
                        key={`${String(item.country)}-${index}`}
                        style={rowStyle}
                        className="cg-row"
                    >
                        {plan.showRank && (
                            <span style={styles.rank}>
                                {String(index + 1).padStart(2, '0')}
                            </span>
                        )}
                        {plan.showFlag && (
                            <CountryFlag country={item.country} styles={styles} />
                        )}
                        <span style={styles.countryName} title={String(item.country)}>
                            {String(item.country)}
                        </span>
                        {plan.showBar && (
                            <div style={styles.barTrack}>
                                <div
                                    className="cg-bar"
                                    style={barFillStyle(percent, colors, index, opts)}
                                />
                            </div>
                        )}
                        {showValueCell && (
                            <span style={styles.valueCell}>
                                {opts.showValue && (
                                    <span style={styles.value}>
                                        {value.toLocaleString()}
                                    </span>
                                )}
                                {plan.showShare && (
                                    <span style={styles.share}>{share.toFixed(1)}%</span>
                                )}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
        </div>
    );
}

function CountryGraphVisualization({ colorScheme }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const opts = useMemo(
        () => normalizeOptions(optionsApi && optionsApi.options),
        [optionsApi],
    );

    const data = dataSources?.primary?.data || null;

    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => f.name || f),
        [data],
    );

    // データが既にあれば loading 中（リフレッシュ中）でも表示を継続する
    if (loading && rows.length === 0) return <LoadingState />;
    if (!data || rows.length === 0) return <NoDataState />;

    return (
        <CountryGraphTable
            fieldNames={fieldNames}
            rows={rows}
            colorScheme={colorScheme}
            opts={opts}
        />
    );
}

/* =========================================================================
 * テーマガード付き App
 * ========================================================================= */
function App() {
    const colorScheme = useResolvedColorScheme();

    // テーマ解決前（待機中）のみ短時間スピナーを表示
    if (!colorScheme) {
        return <LoadingState />;
    }

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <CountryGraphVisualization colorScheme={colorScheme} />
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
    createRoot(rootElement).render(<App />);
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
