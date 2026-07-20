import {
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { Component, useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// -----------------------------------------------------------------------------
// 重要度(severity)の定義
//   - severity 系フィールドの値をキーに色分けする
//   - 数値(1..5 や CVSS 等)も閾値でレベルへマッピングする
//   - 未定義の値は通常のテキストとして表示される(安全側にフォールバック)
// -----------------------------------------------------------------------------
// レベルは表示順(重大→情報)。summary の並び・ソート優先度もこの順に従う。
const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

// レベル -> ソート優先度(小さいほど上位)
const SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
    informational: 4,
};

// 文字列値 -> 正規レベル(エイリアス吸収)
const SEVERITY_ALIASES = {
    critical: 'critical',
    crit: 'critical',
    fatal: 'critical',
    emergency: 'critical',
    severe: 'critical',
    high: 'high',
    error: 'high',
    major: 'high',
    warning: 'medium',
    warn: 'medium',
    medium: 'medium',
    moderate: 'medium',
    low: 'low',
    minor: 'low',
    notice: 'low',
    info: 'info',
    informational: 'info',
    information: 'info',
    debug: 'info',
    ok: 'info',
    normal: 'info',
};

// severity列とみなすフィールド名(小文字比較・自動判定用)
const SEVERITY_FIELD_NAMES = ['severity', 'sev', 'priority', 'urgency', 'level', 'risk'];

// 等幅数字にする列(時刻・時間系・数値系)
const TIME_FIELD_PATTERN = /(^_?time$|time|date|count|total|score|_num$)/i;

// -----------------------------------------------------------------------------
// オプション既定値と正規化(未設定・型不一致に耐える)
// -----------------------------------------------------------------------------
const DEFAULT_OPTIONS = {
    severityField: '', // columnSelector(未指定なら自動判定)
    sortBySeverity: true, // 重大度でソート
    maxRows: 200, // 最大表示行(0=無制限)
    // 5レベルの色(重大→情報)
    criticalColor: '#ff5c3d',
    highColor: '#ffab2e',
    mediumColor: '#f2c14b',
    lowColor: '#4dcf6e',
    infoColor: '#4fa8f0',
    // 数値 severity を使うか / その閾値(値 >= threshold で該当レベル)
    numericSeverity: false,
    criticalThreshold: 4,
    highThreshold: 3,
    mediumThreshold: 2,
    lowThreshold: 1,
    // 表示スタイル
    cellStyle: 'pill', // pill | dot | text | bar
    rowBar: true, // 行頭に重大度カラーバー
    zebra: true, // 交互の縞
    compact: false, // 行高を詰める
    showSummary: true, // 上部の件数サマリ
    showTitle: true, // タイトル表示
    title: '', // 空ならデフォルト文言
    debug: false,
};

function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function asBool(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return fallback;
}

function asColor(v, fallback) {
    if (typeof v !== 'string') return fallback;
    const s = v.trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
}

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const d = DEFAULT_OPTIONS;
    const cellStyle = ['pill', 'dot', 'text', 'bar'].includes(o.cellStyle)
        ? o.cellStyle
        : d.cellStyle;
    return {
        severityField: typeof o.severityField === 'string' ? o.severityField : d.severityField,
        sortBySeverity: asBool(o.sortBySeverity, d.sortBySeverity),
        maxRows: clampInt(o.maxRows, 0, 100000, d.maxRows),
        criticalColor: asColor(o.criticalColor, d.criticalColor),
        highColor: asColor(o.highColor, d.highColor),
        mediumColor: asColor(o.mediumColor, d.mediumColor),
        lowColor: asColor(o.lowColor, d.lowColor),
        infoColor: asColor(o.infoColor, d.infoColor),
        numericSeverity: asBool(o.numericSeverity, d.numericSeverity),
        criticalThreshold: Number.isFinite(Number(o.criticalThreshold))
            ? Number(o.criticalThreshold)
            : d.criticalThreshold,
        highThreshold: Number.isFinite(Number(o.highThreshold))
            ? Number(o.highThreshold)
            : d.highThreshold,
        mediumThreshold: Number.isFinite(Number(o.mediumThreshold))
            ? Number(o.mediumThreshold)
            : d.mediumThreshold,
        lowThreshold: Number.isFinite(Number(o.lowThreshold))
            ? Number(o.lowThreshold)
            : d.lowThreshold,
        cellStyle,
        rowBar: asBool(o.rowBar, d.rowBar),
        zebra: asBool(o.zebra, d.zebra),
        compact: asBool(o.compact, d.compact),
        showSummary: asBool(o.showSummary, d.showSummary),
        showTitle: asBool(o.showTitle, d.showTitle),
        title: typeof o.title === 'string' ? o.title : d.title,
        debug: asBool(o.debug, d.debug),
    };
}

// レベル -> 色(オプションから引く)
function levelColor(level, opts) {
    switch (level) {
        case 'critical':
            return opts.criticalColor;
        case 'high':
            return opts.highColor;
        case 'medium':
            return opts.mediumColor;
        case 'low':
            return opts.lowColor;
        case 'info':
            return opts.infoColor;
        default:
            return null;
    }
}

// 表示ラベル(日本語)
const LEVEL_LABEL = {
    critical: '重大',
    high: '高',
    medium: '中',
    low: '低',
    info: '情報',
};

// -----------------------------------------------------------------------------
// テーマ別パレット
// -----------------------------------------------------------------------------
function getPalette(colorScheme) {
    const isDark = colorScheme !== 'light';
    return isDark
        ? {
              isDark: true,
              text: '#e8eef7',
              mutedText: '#8b9bb4',
              headerBg: 'rgba(255, 255, 255, 0.04)',
              cardBg: 'rgba(255, 255, 255, 0.02)',
              zebraBg: 'rgba(255, 255, 255, 0.022)',
              border: 'rgba(255, 255, 255, 0.08)',
              rowBorder: 'rgba(255, 255, 255, 0.06)',
              rowHover: 'rgba(79, 168, 240, 0.09)',
              accent: '#ff5c3d',
          }
        : {
              isDark: false,
              text: '#1a2733',
              mutedText: '#5c6f8a',
              headerBg: 'rgba(0, 0, 0, 0.03)',
              cardBg: '#ffffff',
              zebraBg: 'rgba(0, 0, 0, 0.022)',
              border: 'rgba(0, 0, 0, 0.10)',
              rowBorder: 'rgba(0, 0, 0, 0.06)',
              rowHover: 'rgba(0, 105, 194, 0.06)',
              accent: '#d43f21',
          };
}

// -----------------------------------------------------------------------------
// コンテナ実寸の計測フック(ResizeObserver)
//   - パネルを小さくした際に密度・列数を段階的に落とすため実寸が必要
//   - ★等値ガード:スクロールバー出現などで 1px 未満の揺れが起きても
//     setState を呼ばない(呼ぶと再描画→バー再判定→…の振動ループになる)
//   - 計測対象は外側ラッパ(パネルと同寸)。横スクロールは内側で起きるので、
//     外側は overflow:hidden にしてサイズが変動しない要素を測る
// -----------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const measure = useCallback((node) => {
        if (!node) return;
        const w = node.clientWidth;
        const h = node.clientHeight;
        setSize((prev) => {
            // 1px 未満の差は無視(振動ループ防止の等値ガード)
            if (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1) {
                return prev;
            }
            return { width: w, height: h };
        });
    }, []);

    const attach = useCallback(
        (node) => {
            // 直前の監視を解除
            if (ref.current && ref.current.__ro) {
                ref.current.__ro.disconnect();
                ref.current.__ro = null;
            }
            ref.current = node;
            if (!node) return;
            measure(node);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => measure(node));
                ro.observe(node);
                node.__ro = ro;
            }
        },
        [measure]
    );

    return [attach, size];
}

// -----------------------------------------------------------------------------
// レスポンシブ密度:実寸から表示パラメータ(余白・フォント・列数上限)を導出
//   - width<420: compact / width<300: very compact / height<180: short
//   - 列数上限は「severity 列は必ず含めつつ、幅から入る列数を概算」する
//     data 駆動なので任意のフィールド集合で機能する。溢れた列は横スクロールで
//     到達可能(=データ欠落ではなく段階的縮退)
// -----------------------------------------------------------------------------
function getDensity(width, height, opts) {
    // width 0(初回計測前)は通常サイズとして扱い、既存の見た目を壊さない
    const w = width > 0 ? width : 9999;
    const h = height > 0 ? height : 9999;

    const veryCompact = w < 300;
    const compact = w < 420;
    const short = h < 180;

    // 水平パディング(th/td)
    const padH = veryCompact ? 6 : compact ? 8 : 16;
    // 垂直パディング:short や compact でさらに詰める。opts.compact も加味
    const basePadV = opts.compact ? 7 : 11;
    const padV = veryCompact || short ? 5 : compact ? 7 : basePadV;

    return {
        veryCompact,
        compact,
        short,
        padH,
        padV,
        // フォント
        tableFont: veryCompact ? 11 : compact ? 12 : 14,
        thFont: compact ? 10 : 11,
        pillFont: veryCompact ? 10 : 12,
        titleFont: veryCompact ? 11 : compact ? 12 : 13,
        summaryFont: veryCompact ? 10 : compact ? 11 : 12,
        // コンテナ余白
        containerPad: veryCompact ? 4 : compact ? 8 : 16,
        // マージン類
        titleMargin: compact ? 8 : 14,
        summaryGap: compact ? 6 : 8,
        summaryMargin: compact ? 8 : 12,
        // pill パディング
        pillPadH: veryCompact ? 8 : 12,
        pillPadV: veryCompact ? 2 : 3,
    };
}

// 幅から表示可能な列数を概算(severity 列は常に含める)
//   - 1 列あたりの概算実効幅 = 平均文字幅×代表文字数 + 左右パディング
//   - 通常幅では全列を返す(既存挙動を維持)。狭い時のみ列を絞る
function computeVisibleColumns(fieldNames, severityIndex, width, density) {
    const total = fieldNames.length;
    // 通常サイズ(compact でない)は全列表示 = 既存挙動を完全維持
    if (!density.compact || width <= 0 || total <= 1) {
        return null; // null = 全列表示
    }

    const charW = density.tableFont * 0.62; // 概算平均文字幅(px)
    const minCellText = 8; // 1 セルあたり最低でもこの文字数ぶんは確保
    const perColMin = charW * minCellText + density.padH * 2;
    const barW = 6; // 行頭カラーバー列の概算
    const usable = Math.max(0, width - density.containerPad * 2 - barW);

    // severity 列を必ず含めるため、最低 2 列は確保
    let fit = Math.max(2, Math.floor(usable / perColMin));
    if (fit >= total) return null; // 全部入るなら全列表示(既存挙動)

    // 表示する列インデックス集合を決める:
    //   優先度 = 先頭列(時刻等)→ severity 列 → その後は左から詰める。
    //   溢れた列はデータ欠落ではなく横スクロールで到達可能(段階的縮退)。
    const chosen = [];
    const push = (idx) => {
        if (idx >= 0 && idx < total && !chosen.includes(idx)) chosen.push(idx);
    };
    push(0); // 先頭列(時刻/最初の有用列)を優先
    if (severityIndex >= 0) push(severityIndex); // severity 列は必ず
    for (let i = 0; i < total && chosen.length < fit; i += 1) push(i);

    chosen.sort((a, b) => a - b);
    return chosen;
}

// -----------------------------------------------------------------------------
// 最小限のCSS(ホバー効果のみ。インラインスタイルでは :hover が書けないため)
// -----------------------------------------------------------------------------
function HoverStyle({ palette }) {
    const css = `
        .sviz-row { transition: background-color 0.12s ease; }
        .sviz-row:hover { background-color: ${palette.rowHover} !important; }
    `;
    return <style>{css}</style>;
}

// Critical用のアイコン(インラインSVG・外部通信なし)
function CriticalIcon({ color }) {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="2" />
            <rect x="7.1" y="4" width="1.8" height="5" rx="0.9" fill={color} />
            <circle cx="8" cy="11.2" r="1" fill={color} />
        </svg>
    );
}

// -----------------------------------------------------------------------------
// データ整形(rows / columns 両形式・マルチバリューセルに耐える)
// -----------------------------------------------------------------------------
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const numRows = data.columns[0].length;
            return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

// セルが配列(マルチバリュー)で届いた場合は先頭要素を代表値にする
function cellToText(cell) {
    if (cell === null || cell === undefined) return '';
    if (Array.isArray(cell)) return cell.length > 0 ? String(cell[0]) : '';
    return String(cell);
}

function toFieldLabel(field) {
    return String(field).replace(/^_+/, '').replace(/[_-]+/g, ' ');
}

// -----------------------------------------------------------------------------
// フィールドインデックス解決(columnSelector の DOS 文字列 / 生名 / 配列に対応)
//   参照実装: chord-flow resolveFieldIndex()
// -----------------------------------------------------------------------------
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

// severity列の自動判定(名前一致・複数候補は最優先の名前を採用)
function autoSeverityIndex(fieldNames) {
    let best = -1;
    let bestRank = Infinity;
    fieldNames.forEach((f, i) => {
        const rank = SEVERITY_FIELD_NAMES.indexOf(String(f).trim().toLowerCase());
        if (rank >= 0 && rank < bestRank) {
            bestRank = rank;
            best = i;
        }
    });
    return best;
}

// 値 -> 正規レベル(文字列エイリアス or 数値閾値)
function valueToLevel(raw, opts) {
    const text = cellToText(raw).trim();
    if (text === '') return null;

    if (opts.numericSeverity) {
        const num = Number(text.replace(/,/g, ''));
        if (Number.isFinite(num)) {
            if (num >= opts.criticalThreshold) return 'critical';
            if (num >= opts.highThreshold) return 'high';
            if (num >= opts.mediumThreshold) return 'medium';
            if (num >= opts.lowThreshold) return 'low';
            return 'info';
        }
    }
    const key = text.toLowerCase();
    if (SEVERITY_ALIASES[key]) return SEVERITY_ALIASES[key];
    // 数値が混ざっている場合のフォールバック(numericSeverity off でも 1..5 を拾う)
    const num = Number(text.replace(/,/g, ''));
    if (Number.isFinite(num)) {
        if (num >= 4) return 'critical';
        if (num >= 3) return 'high';
        if (num >= 2) return 'medium';
        if (num >= 1) return 'low';
        return 'info';
    }
    return null;
}

// -----------------------------------------------------------------------------
// 表示用コンポーネント
// -----------------------------------------------------------------------------
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

// severity セルの描画(スタイルはオプションで切替)
function SeverityCell({ rawValue, level, opts, density }) {
    const text = cellToText(rawValue);
    const color = levelColor(level, opts);
    if (!level || !color) return <>{text}</>;

    // density 未指定(通常サイズ)は従来の pill 値にフォールバック
    const pillFont = density ? density.pillFont : 12;
    const pillPadH = density ? density.pillPadH : 12;
    const pillPadV = density ? density.pillPadV : 3;

    if (opts.cellStyle === 'text') {
        return <span style={{ color, fontWeight: 700 }}>{text}</span>;
    }
    if (opts.cellStyle === 'dot') {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span
                    style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: color,
                        boxShadow: `0 0 0 3px ${color}22`,
                        flexShrink: 0,
                    }}
                />
                <span style={{ color, fontWeight: 700 }}>{text}</span>
            </span>
        );
    }
    if (opts.cellStyle === 'bar') {
        return (
            <span
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderLeft: `4px solid ${color}`,
                    paddingLeft: '9px',
                    color,
                    fontWeight: 700,
                }}
            >
                {text}
            </span>
        );
    }
    // pill(既定)
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: `${pillPadV}px ${pillPadH}px`,
                borderRadius: '999px',
                backgroundColor: `${color}24`,
                border: `1px solid ${color}44`,
                color,
                fontSize: `${pillFont}px`,
                fontWeight: 700,
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
            }}
        >
            {level === 'critical' ? <CriticalIcon color={color} /> : null}
            {text}
        </span>
    );
}

// 件数サマリ(重大度ごとの件数を上部に表示・データ駆動)
function SeveritySummary({ counts, opts, palette, density }) {
    const items = SEVERITY_LEVELS.filter((lv) => counts[lv] > 0);
    if (items.length === 0) return null;
    // density 未指定(通常サイズ)は従来値にフォールバック
    const font = density ? density.summaryFont : 12;
    const gap = density ? density.summaryGap : 8;
    const marginBottom = density ? density.summaryMargin : 12;
    const compact = density ? density.compact : false;
    const chipPad = compact ? '3px 8px 3px 7px' : '5px 12px 5px 10px';
    return (
        <div
            style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: `${gap}px`,
                marginBottom: `${marginBottom}px`,
                minWidth: 0,
            }}
        >
            {items.map((lv) => {
                const color = levelColor(lv, opts);
                return (
                    <span
                        key={lv}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: compact ? '5px' : '7px',
                            padding: chipPad,
                            borderRadius: '8px',
                            backgroundColor: `${color}1c`,
                            border: `1px solid ${color}3a`,
                            fontSize: `${font}px`,
                            color: palette.text,
                        }}
                    >
                        <span
                            style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                backgroundColor: color,
                                flexShrink: 0,
                            }}
                        />
                        <span style={{ color, fontWeight: 700 }}>{LEVEL_LABEL[lv]}</span>
                        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                            {counts[lv].toLocaleString()}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

function DebugOverlay({ options, meta }) {
    return (
        <pre
            style={{
                position: 'absolute',
                top: 4,
                right: 4,
                maxWidth: '46%',
                maxHeight: '60%',
                overflow: 'auto',
                margin: 0,
                padding: '8px 10px',
                fontSize: '10px',
                lineHeight: 1.35,
                background: 'rgba(0,0,0,0.82)',
                color: '#7CFC98',
                border: '1px solid #2a8',
                borderRadius: '6px',
                zIndex: 20,
                whiteSpace: 'pre-wrap',
            }}
        >
            {JSON.stringify({ meta, options }, null, 1)}
        </pre>
    );
}

function AlertTable({ fieldNames, rows, severityIndex, colorScheme, opts, width, height }) {
    const palette = getPalette(colorScheme);

    // 実寸から密度パラメータを導出(width<=0 は通常サイズ扱い)
    const density = getDensity(width, height, opts);

    // 表示する列インデックス(null=全列)。狭い時のみ列を絞る
    const visibleCols = useMemo(
        () => computeVisibleColumns(fieldNames, severityIndex, width, density),
        // density はプリミティブの集合。width/severityIndex/列数で十分に依存を表現できる
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [fieldNames, severityIndex, width, density.compact, density.veryCompact, density.tableFont]
    );
    const shownCols = visibleCols || fieldNames.map((_f, i) => i);
    const hiddenCount = fieldNames.length - shownCols.length;

    // 行ごとにレベルを算出 → サマリ集計・ソート・表示制限
    const prepared = useMemo(() => {
        const withLevel = rows.map((row, i) => ({
            row,
            level: severityIndex >= 0 ? valueToLevel(row[severityIndex], opts) : null,
            origIndex: i,
        }));

        const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        withLevel.forEach((r) => {
            if (r.level && counts[r.level] !== undefined) counts[r.level] += 1;
        });

        let ordered = withLevel;
        if (opts.sortBySeverity && severityIndex >= 0) {
            ordered = [...withLevel].sort((a, b) => {
                const ra = a.level ? SEVERITY_RANK[a.level] : 99;
                const rb = b.level ? SEVERITY_RANK[b.level] : 99;
                if (ra !== rb) return ra - rb;
                return a.origIndex - b.origIndex; // 安定ソート(元の順序維持)
            });
        }

        const total = ordered.length;
        const limited = opts.maxRows > 0 ? ordered.slice(0, opts.maxRows) : ordered;
        return { rows: limited, counts, total, shown: limited.length };
    }, [rows, severityIndex, opts]);

    const rowPadV = `${density.padV}px`;
    const rowPadH = `${density.padH}px`;
    const defaultTitle = 'Recent High Severity Alerts';
    const title = opts.title.trim() || defaultTitle;

    // コンテナ:実コンテンツ。ここで縦横スクロールを担う(到達性の最終担保)。
    // 計測は上位の overflow:hidden ラッパで行うため、ここでスクロールバーが
    // 出てもラッパ寸法は変わらず、再計測ループにはならない。
    const containerStyle = {
        position: 'relative',
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        padding: `${density.containerPad}px`,
        overflow: 'auto',
        color: palette.text,
        fontFamily:
            '"Splunk Platform Sans", "Proxima Nova", -apple-system, "Segoe UI", Roboto, sans-serif',
    };

    const titleRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: density.compact ? '7px' : '10px',
        marginBottom: `${density.titleMargin}px`,
        fontSize: `${density.titleFont}px`,
        fontWeight: 700,
        letterSpacing: density.veryCompact ? '0.06em' : '0.14em',
        textTransform: 'uppercase',
        color: palette.mutedText,
        minWidth: 0,
    };

    const accentBarStyle = {
        width: '4px',
        height: '16px',
        borderRadius: '2px',
        backgroundColor: palette.accent,
        flexShrink: 0,
    };

    const cardStyle = {
        backgroundColor: palette.cardBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '12px',
        overflow: 'hidden',
    };

    const tableStyle = {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: `${density.tableFont}px`,
        // 固定レイアウト：各列はセル内容ではなくコンテナ幅を分け合う。
        // これで長いセル値（タイムスタンプ/メッセージ等）が列を押し広げて
        // 右端がカードからはみ出す（＝わずかな見切れ）のを防ぐ。
        tableLayout: 'fixed',
    };

    const thStyle = {
        padding: `${density.padV}px ${rowPadH}`,
        textAlign: 'left',
        fontSize: `${density.thFont}px`,
        fontWeight: 700,
        letterSpacing: density.compact ? '0.06em' : '0.12em',
        textTransform: 'uppercase',
        color: palette.mutedText,
        backgroundColor: palette.headerBg,
        borderBottom: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    };

    const baseTdStyle = {
        padding: `${rowPadV} ${rowPadH}`,
        borderBottom: `1px solid ${palette.rowBorder}`,
        verticalAlign: 'middle',
        // 固定レイアウト下でセルをはみ出させない：長い値は … で切り詰める。
        // maxWidth:0 は「列は均等配分・内容は溢れさせない」ための定番指定。
        maxWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    };

    const hasRowBar = opts.rowBar && severityIndex >= 0;

    return (
        <div style={containerStyle}>
            <HoverStyle palette={palette} />
            {opts.debug ? (
                <DebugOverlay
                    options={opts}
                    meta={{
                        severityIndex,
                        severityField: fieldNames[severityIndex] ?? null,
                        total: prepared.total,
                        shown: prepared.shown,
                        counts: prepared.counts,
                    }}
                />
            ) : null}

            {opts.showTitle ? (
                <div style={titleRowStyle}>
                    <span style={accentBarStyle} />
                    <span
                        style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {title}
                    </span>
                    {prepared.total > prepared.shown ? (
                        <span
                            style={{
                                fontSize: `${Math.max(9, density.titleFont - 2)}px`,
                                letterSpacing: '0.04em',
                                textTransform: 'none',
                                fontWeight: 600,
                                color: palette.mutedText,
                                flexShrink: 0,
                            }}
                        >
                            {prepared.shown.toLocaleString()} / {prepared.total.toLocaleString()}
                        </span>
                    ) : null}
                </div>
            ) : null}

            {opts.showSummary ? (
                <SeveritySummary
                    counts={prepared.counts}
                    opts={opts}
                    palette={palette}
                    density={density}
                />
            ) : null}

            <div style={cardStyle}>
                <table style={tableStyle}>
                    <thead>
                        <tr>
                            {hasRowBar ? (
                                <th style={{ ...thStyle, padding: `${density.padV}px 0` }} />
                            ) : null}
                            {shownCols.map((cellIndex) => (
                                <th key={fieldNames[cellIndex]} style={thStyle}>
                                    {toFieldLabel(fieldNames[cellIndex])}
                                    {/* 末尾の見出しに省略列のヒントを添える(狭い時のみ) */}
                                    {hiddenCount > 0 &&
                                    cellIndex === shownCols[shownCols.length - 1] ? (
                                        <span
                                            style={{
                                                marginLeft: '6px',
                                                fontSize: `${Math.max(9, density.thFont - 1)}px`,
                                                fontWeight: 600,
                                                letterSpacing: 'normal',
                                                textTransform: 'none',
                                                opacity: 0.75,
                                            }}
                                            title="横スクロールで残りの列を表示できます"
                                        >
                                            +{hiddenCount}列
                                        </span>
                                    ) : null}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {prepared.rows.map((item, rowIndex) => {
                            const { row, level } = item;
                            const isLast = rowIndex === prepared.rows.length - 1;
                            const barColor =
                                hasRowBar && level ? levelColor(level, opts) : 'transparent';
                            const zebraBg =
                                opts.zebra && rowIndex % 2 === 1 ? palette.zebraBg : 'transparent';
                            return (
                                <tr
                                    key={item.origIndex}
                                    className="sviz-row"
                                    style={{ backgroundColor: zebraBg }}
                                >
                                    {hasRowBar ? (
                                        <td
                                            style={{
                                                ...baseTdStyle,
                                                padding: 0,
                                                width: '4px',
                                                ...(isLast ? { borderBottom: 'none' } : null),
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: '4px',
                                                    minHeight: '18px',
                                                    height: '100%',
                                                    backgroundColor: barColor,
                                                }}
                                            />
                                        </td>
                                    ) : null}
                                    {shownCols.map((cellIndex) => {
                                        const cell = row[cellIndex];
                                        const isTimeField = TIME_FIELD_PATTERN.test(
                                            String(fieldNames[cellIndex] ?? '')
                                        );
                                        const tdStyle = {
                                            ...baseTdStyle,
                                            ...(isLast ? { borderBottom: 'none' } : null),
                                            ...(isTimeField
                                                ? {
                                                      fontVariantNumeric: 'tabular-nums',
                                                      fontWeight: 600,
                                                  }
                                                : null),
                                        };
                                        const cellText = cellToText(cell);
                                        return (
                                            <td
                                                key={cellIndex}
                                                style={tdStyle}
                                                title={
                                                    cellIndex === severityIndex ? undefined : cellText
                                                }
                                            >
                                                {cellIndex === severityIndex ? (
                                                    <SeverityCell
                                                        rawValue={cell}
                                                        level={level}
                                                        opts={opts}
                                                        density={density}
                                                    />
                                                ) : (
                                                    cellText
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function AlertVisualization({ colorScheme }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    // ★パネル実寸を計測(この要素はパネルと同寸・overflow:hidden で不変)
    //   計測結果は AlertTable に width/height として渡す
    const [measureRef, size] = useContainerSize();

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && typeof f === 'object' ? f.name : f)),
        [data]
    );
    const severityIndex = useMemo(() => {
        const resolved = resolveFieldIndex(opts.severityField, fieldNames, rows, -2);
        // -2 = 未指定 → 自動判定にフォールバック
        return resolved === -2 ? autoSeverityIndex(fieldNames) : resolved;
    }, [opts.severityField, fieldNames, rows]);

    // 計測ラッパは常に描画する(loading/nodata でも寸法を得られるように)
    const measuredWrapperStyle = {
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
    };

    let inner;
    if (loading) {
        inner = <LoadingState />;
    } else if (!data || rows.length === 0 || fieldNames.length === 0) {
        inner = <NoDataState />;
    } else {
        inner = (
            <AlertTable
                fieldNames={fieldNames}
                rows={rows}
                severityIndex={severityIndex}
                colorScheme={colorScheme}
                opts={opts}
                width={size.width}
                height={size.height}
            />
        );
    }

    return (
        <div ref={measureRef} style={measuredWrapperStyle}>
            {inner}
        </div>
    );
}

// -----------------------------------------------------------------------------
// エラーバウンダリ(描画エラーで真っ白になるのを防止)
// -----------------------------------------------------------------------------
class VizErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, message: '' };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, message: String(error?.message || error) };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: '100%',
                        minHeight: '80px',
                        fontFamily: 'sans-serif',
                        fontSize: '12px',
                        opacity: 0.6,
                    }}
                >
                    Visualization error: {this.state.message}
                </div>
            );
        }
        return this.props.children;
    }
}

// -----------------------------------------------------------------------------
// App本体(テーマ確定後のみ実行される)
// -----------------------------------------------------------------------------
function App({ colorScheme }) {
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <VizErrorBoundary>
                <AlertVisualization colorScheme={colorScheme} />
            </VizErrorBoundary>
        </SplunkThemeProvider>
    );
}

// -----------------------------------------------------------------------------
// ガード:useTheme() が undefined の間は App を実行せず、
// テーマ取得後にのみ App をレンダリングする
// -----------------------------------------------------------------------------
function Root() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;

    if (!themeApi || colorScheme === undefined || colorScheme === null) {
        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '100%',
                    height: '100%',
                    minHeight: '80px',
                    fontFamily: 'sans-serif',
                    fontSize: '12px',
                    opacity: 0.6,
                }}
            >
                Loading…
            </div>
        );
    }
    return <App colorScheme={colorScheme} />;
}

// -----------------------------------------------------------------------------
// マウント処理(DOM準備前に実行された場合にも対応し、安定して表示させる)
// -----------------------------------------------------------------------------
function mount() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(<Root />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
    mount();
}
