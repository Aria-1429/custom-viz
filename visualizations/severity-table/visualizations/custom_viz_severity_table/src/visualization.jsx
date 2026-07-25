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
//   - 数値(1..5 や CVSS 等)もバンド(editor.threshold)で色分けする
//   - 未定義の値は通常のテキストとして表示される(安全側にフォールバック)
//
// ★色は「値の範囲と色」(severityBands) ただ一つが決める。
//   固定 5 レベルの色オプション(criticalColor 等)は廃止した。
//   critical/high/... という名前の知識は「並び順(ソート・色の割り当て順)」と
//   「日本語ラベル」にのみ使う。データ側の深刻度が 5 種でなくても、
//   P1/P2/P3 や 緊急/注意 のような独自の値でも、そのまま扱える。
// -----------------------------------------------------------------------------
// 既知レベル -> ソート優先度(小さいほど上位)。表示順・色の割り当て順もこれに従う。
const SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
    informational: 4,
};

// 未知(エイリアス表に無い)の深刻度に与える基準ランク。
// 既知レベルより後ろ(＝低い深刻度側)に並べるが、値の無い行(=99)より前に置く。
const UNKNOWN_RANK_BASE = 50;

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

// 既定バンドを組み立てるための基準色(重大→情報)。既定値の見た目を従来と揃えるためだけに使う。
const DEFAULT_LEVEL_COLORS = {
    critical: '#ff5c3d',
    high: '#ffab2e',
    medium: '#f2c14b',
    low: '#4dcf6e',
    info: '#4fa8f0',
};

// -----------------------------------------------------------------------------
// 数値深刻度のバンド(editor.threshold)
//   editor.threshold は [{from, to, value}] を生で届ける(value は色文字列)。
//   既定値は旧実装の閾値(>=4 重大 / >=3 高 / >=2 中 / >=1 低 / それ未満 情報)を
//   そのまま再現する。並びは昇順(低い値→高い値)。
// -----------------------------------------------------------------------------
const DEFAULT_SEVERITY_BANDS = [
    { from: 0, to: 1, value: DEFAULT_LEVEL_COLORS.info },
    { from: 1, to: 2, value: DEFAULT_LEVEL_COLORS.low },
    { from: 2, to: 3, value: DEFAULT_LEVEL_COLORS.medium },
    { from: 3, to: 4, value: DEFAULT_LEVEL_COLORS.high },
    { from: 4, to: 5, value: DEFAULT_LEVEL_COLORS.critical },
];

// 数値らしきものを取り出す(null/undefined は開区間を意味するのでそのまま返す)
function bandBound(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// -----------------------------------------------------------------------------
// バンド配列の正規化(防御的)
//   - 配列でない / 空 / 全滅 → 既定バンドへフォールバック
//   - from/to は null(開区間)を許容し、-Infinity / +Infinity に展開する
//   - from > to は入れ替える。色が不正な行は捨てる
//   - 最後に from 昇順へソートする(未ソートで届いても正しく判定できるように)
// -----------------------------------------------------------------------------
function normalizeBands(raw) {
    if (!Array.isArray(raw)) return DEFAULT_SEVERITY_BANDS;
    const out = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const color = asColor(b.value, null);
        if (!color) return;
        let lo = bandBound(b.from);
        let hi = bandBound(b.to);
        // 開区間(openRanges)は ±Infinity として扱う
        if (lo === null) lo = -Infinity;
        if (hi === null) hi = Infinity;
        if (lo > hi) {
            const t = lo;
            lo = hi;
            hi = t;
        }
        out.push({ from: lo, to: hi, value: color });
    });
    if (out.length === 0) return DEFAULT_SEVERITY_BANDS;
    // from 昇順(同値なら to 昇順)。重複・重なりがあっても後段で決定的に選べる
    out.sort((a, b) => (a.from !== b.from ? a.from - b.from : a.to - b.to));
    return out;
}

// -----------------------------------------------------------------------------
// 文字列の深刻度 -> 色の割り当て(データ駆動)
//
//   固定 5 色を廃止したため、文字列の深刻度もユーザー設定の severityBands から
//   色を取る。方式は「ランク順のサンプリング」:
//     ① データに実際に出てくる深刻度(正規化済みキー)を重複なく集める
//     ② 深刻度の高い順に並べる
//        - 既知エイリアス(critical/warn/error/…)は SEVERITY_RANK 順
//        - 未知の値(P1 / 緊急 / …)は既知より後ろに置き、初出順で安定させる
//     ③ バンド色を「高い範囲 → 低い範囲」の順に並べ、②の並びへ順に割り当てる
//        深刻度の種類数とバンド数が食い違っても比例配分で必ず色が付く
//
//   これにより「色の設定は severityBands 一つだけ」に統一され、
//   深刻度の段階数が 5 でなくても、値が未知の文字列でも破綻しない。
// -----------------------------------------------------------------------------

// 文字列 -> 正規キー。既知ならエイリアス解決した正規レベル名、未知なら小文字の生値。
function severityKeyOf(text) {
    const key = String(text).trim().toLowerCase();
    if (key === '') return null;
    return SEVERITY_ALIASES[key] || key;
}

// 正規キーのソート優先度(小さいほど重大)。未知は既知の後ろ。
function severityKeyRank(key) {
    const known = SEVERITY_RANK[key];
    return known === undefined ? UNKNOWN_RANK_BASE : known;
}

// バンド色を「高い範囲 → 低い範囲」の順に取り出す(重複色は保持する)。
// bands は from 昇順に正規化済みなので、逆順にすれば重大側が先頭になる。
function bandColorsHighToLow(bands) {
    const colors = bands.map((b) => b.value).reverse();
    return colors.length > 0 ? colors : DEFAULT_SEVERITY_BANDS.map((b) => b.value).reverse();
}

// 出現した深刻度キー -> 色 の対応表を作る
//   keysInOrder: 深刻度の高い順に並んだ正規キーの配列
//   colors:      高い順に並んだバンド色
function buildStringColorMap(keysInOrder, colors) {
    const map = new Map();
    const n = keysInOrder.length;
    const m = colors.length;
    if (n === 0 || m === 0) return map;
    keysInOrder.forEach((key, i) => {
        // 比例配分。n<=m なら色の上位から順に、n>m なら色を引き伸ばして割り当てる。
        const idx = n === 1 ? 0 : Math.min(m - 1, Math.round((i * (m - 1)) / (n - 1)));
        map.set(key, colors[idx]);
    });
    return map;
}

// 行データから「出現した深刻度キーの高い順の配列」を作る
function collectSeverityKeys(rows, severityIndex) {
    if (severityIndex < 0) return [];
    const seen = new Map(); // key -> 初出インデックス
    rows.forEach((row, i) => {
        const key = severityKeyOf(cellToText(Array.isArray(row) ? row[severityIndex] : undefined));
        if (key && !seen.has(key)) seen.set(key, i);
    });
    return [...seen.keys()].sort((a, b) => {
        const ra = severityKeyRank(a);
        const rb = severityKeyRank(b);
        if (ra !== rb) return ra - rb;
        // 同ランク(未知同士など)は初出順 → 決定的な色割り当てになる
        return seen.get(a) - seen.get(b);
    });
}

// 数値をバンドに当てる。返り値は bands のインデックス(該当なしは -1)
//   - 区間は [from, to) 半開。ただし最大バンドの上端のみ閉区間として扱う
//     (旧実装で 5 が「重大」になったのと同じにするため)
//   - 重なりがある場合は「最も高い範囲」を優先(降順に見て最初に当たったもの)
function matchBandIndex(num, bands) {
    let best = -1;
    for (let i = bands.length - 1; i >= 0; i -= 1) {
        const b = bands[i];
        const isTopBand = i === bands.length - 1;
        const inRange = num >= b.from && (isTopBand ? num <= b.to : num < b.to);
        if (inRange) {
            best = i;
            break;
        }
    }
    if (best >= 0) return best;
    // どのバンドにも当たらない: 範囲外は最も近い端のバンドへ丸める
    const first = bands[0];
    const last = bands[bands.length - 1];
    if (num < first.from) return 0;
    if (num > last.to) return bands.length - 1;
    return -1;
}

// -----------------------------------------------------------------------------
// オプション既定値と正規化(未設定・型不一致に耐える)
// -----------------------------------------------------------------------------
const DEFAULT_OPTIONS = {
    severityField: '', // columnSelector(未指定なら自動判定)
    sortBySeverity: true, // 重大度でソート
    maxRows: 200, // 最大表示行(0=無制限)
    // 数値 severity を使うか / 色を決める唯一の設定(editor.threshold)
    numericSeverity: false,
    severityBands: DEFAULT_SEVERITY_BANDS,
    // 表示スタイル
    cellStyle: 'pill', // pill | dot | text | bar
    rowBar: true, // 行頭に重大度カラーバー
    zebra: true, // 交互の縞
    compact: false, // 行高を詰める
    showSummary: true, // 上部の件数サマリ
    showTitle: true, // タイトル表示
    title: '', // 空ならデフォルト文言
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
        numericSeverity: asBool(o.numericSeverity, d.numericSeverity),
        // ★旧キー(criticalThreshold / criticalColor 等)は一切読まない。
        //   既定値と同じ値が options に載らない仕様のため、旧キーへフォールバックすると
        //   「既定値を選んだときだけ直らない」不具合になる。
        //   旧ダッシュボードの色・しきい値は既定バンドに戻る(README 参照)。
        severityBands: normalizeBands(o.severityBands),
        cellStyle,
        rowBar: asBool(o.rowBar, d.rowBar),
        zebra: asBool(o.zebra, d.zebra),
        compact: asBool(o.compact, d.compact),
        showSummary: asBool(o.showSummary, d.showSummary),
        showTitle: asBool(o.showTitle, d.showTitle),
        title: typeof o.title === 'string' ? o.title : d.title,
    };
}

// 表示ラベル(日本語)。既知の 5 レベルのみ。未知の値は生の文字列をそのまま出す。
const LEVEL_LABEL = {
    critical: '重大',
    high: '高',
    medium: '中',
    low: '低',
    info: '情報',
};

// 正規キー -> サマリ等の表示ラベル。未知キーは生値(元の表記)を使う
function severityLabel(key, rawSample) {
    if (LEVEL_LABEL[key]) return LEVEL_LABEL[key];
    return rawSample || String(key);
}

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

// 値 -> { key, label, color }
//   - numericSeverity ON かつ数値 → バンド(editor.threshold)に当てて、
//     ★そのバンドの色をそのまま使う(固定レベル名を経由しない)
//   - それ以外は文字列 → 出現順で作った色マップ(stringColors)から引く。
//     未知の文字列(P1 / 緊急 等)も色マップに載っているので必ず色が付く
//   - 判定不能なら null(プレーンテキスト表示)
//
//   key   … 集計・ソートに使う正規キー(数値パスはバンド番号 'band:N')
//   label … サマリ表示用のラベル
//   color … 実際に塗る色
function valueToSeverity(raw, opts, stringColors) {
    const text = cellToText(raw).trim();
    if (text === '') return null;

    const num = Number(text.replace(/,/g, ''));

    if (opts.numericSeverity && Number.isFinite(num)) {
        const bands = opts.severityBands;
        const idx = matchBandIndex(num, bands);
        if (idx < 0) return null;
        const b = bands[idx];
        return {
            key: `band:${idx}`,
            label: bandRangeLabel(b),
            color: b.value,
            rank: bands.length - 1 - idx, // 高い範囲ほど上位(0が最重大)
        };
    }

    const key = severityKeyOf(text);
    if (!key) return null;
    const color = stringColors.get(key);
    if (!color) return null;
    return {
        key,
        label: severityLabel(key, text),
        color,
        rank: severityKeyRank(key),
    };
}

// バンドの範囲を人が読めるラベルにする(開区間は ≦ / ≧ で表す)
function bandRangeLabel(b) {
    const lo = Number.isFinite(b.from) ? b.from : null;
    const hi = Number.isFinite(b.to) ? b.to : null;
    if (lo === null && hi === null) return 'すべて';
    if (lo === null) return `< ${hi}`;
    if (hi === null) return `≧ ${lo}`;
    return `${lo}–${hi}`;
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
                <Paragraph>データがありません。サーチ結果を確認してください。</Paragraph>
            </div>
        </div>
    );
}

// severity セルの描画(スタイルはオプションで切替)
//   color は severityBands 由来(数値パス=当たったバンドの色 / 文字列パス=色マップの色)
//   isTop は「そのデータ内で最も重大」なときだけ true(アイコン表示用)
function SeverityCell({ rawValue, color, isTop, opts, density }) {
    const text = cellToText(rawValue);
    if (!color) return <>{text}</>;

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
            {isTop ? <CriticalIcon color={color} /> : null}
            {text}
        </span>
    );
}

// 件数サマリ(深刻度ごとの件数を上部に表示・完全にデータ駆動)
//   items: [{ key, label, color, count }] を重大度の高い順に受け取る。
//   5 レベル固定ではないので、P1/P2/P3 でも 緊急/注意 でも、数値バンドでもそのまま出る。
function SeveritySummary({ items, palette, density }) {
    if (!items || items.length === 0) return null;
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
            {items.map((item) => {
                const { color } = item;
                return (
                    <span
                        key={item.key}
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
                        <span
                            style={{
                                color,
                                fontWeight: 700,
                                maxWidth: '160px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                            title={item.label}
                        >
                            {item.label}
                        </span>
                        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                            {item.count.toLocaleString()}
                        </span>
                    </span>
                );
            })}
        </div>
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

    // 文字列の深刻度 -> 色。データに出てくる値をランク順に並べ、バンド色を割り当てる。
    // numericSeverity ON のときは数値パスが色を直接持つので作らなくてよいが、
    // 数値に見えない値が混ざったときのために常に用意しておく。
    const stringColors = useMemo(() => {
        const keys = collectSeverityKeys(rows, severityIndex);
        return buildStringColorMap(keys, bandColorsHighToLow(opts.severityBands));
    }, [rows, severityIndex, opts.severityBands]);

    // 行ごとに深刻度を算出 → サマリ集計・ソート・表示制限
    const prepared = useMemo(() => {
        const withSev = rows.map((row, i) => {
            const sev =
                severityIndex >= 0
                    ? valueToSeverity(row[severityIndex], opts, stringColors)
                    : null;
            return { row, sev, origIndex: i };
        });

        // サマリ:出現した深刻度をランク順に集計(5 レベル固定ではない)
        const byKey = new Map();
        withSev.forEach((r) => {
            if (!r.sev) return;
            const cur = byKey.get(r.sev.key);
            if (cur) {
                cur.count += 1;
            } else {
                byKey.set(r.sev.key, {
                    key: r.sev.key,
                    label: r.sev.label,
                    color: r.sev.color,
                    rank: r.sev.rank,
                    count: 1,
                    firstIndex: r.origIndex,
                });
            }
        });
        const summaryItems = [...byKey.values()].sort((a, b) =>
            a.rank !== b.rank ? a.rank - b.rank : a.firstIndex - b.firstIndex
        );
        // 最重大キー(pill のアイコン表示に使う)
        const topKey = summaryItems.length > 0 ? summaryItems[0].key : null;

        let ordered = withSev;
        if (opts.sortBySeverity && severityIndex >= 0) {
            ordered = [...withSev].sort((a, b) => {
                const ra = a.sev ? a.sev.rank : 99;
                const rb = b.sev ? b.sev.rank : 99;
                if (ra !== rb) return ra - rb;
                return a.origIndex - b.origIndex; // 安定ソート(元の順序維持)
            });
        }

        const total = ordered.length;
        const limited = opts.maxRows > 0 ? ordered.slice(0, opts.maxRows) : ordered;
        return { rows: limited, summaryItems, topKey, total, shown: limited.length };
    }, [rows, severityIndex, opts, stringColors]);

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
                    items={prepared.summaryItems}
                    palette={palette}
                    density={density}
                />
            ) : null}

            <div style={cardStyle}>
                <table style={tableStyle}>
                    {/* tableLayout:fixed は列幅を colgroup（無ければ先頭行）から決める。
                        行頭カラーバー列に明示幅を与えないと、その列が等分の 1 枠を
                        丸取りして左に巨大な余白ができ、右側の列が見切れる。
                        colgroup で「バー列=4px 固定・データ列=均等」を宣言して解消する。 */}
                    <colgroup>
                        {hasRowBar ? <col style={{ width: '4px' }} /> : null}
                        {shownCols.map((cellIndex) => (
                            <col key={`col-${fieldNames[cellIndex]}`} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {hasRowBar ? (
                                <th
                                    style={{
                                        ...thStyle,
                                        padding: `${density.padV}px 0`,
                                        width: '4px',
                                    }}
                                />
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
                            const { row, sev } = item;
                            const rowColor = sev ? sev.color : null;
                            const isLast = rowIndex === prepared.rows.length - 1;
                            const barColor = hasRowBar && rowColor ? rowColor : 'transparent';
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
                                                        color={rowColor}
                                                        isTop={
                                                            !!sev &&
                                                            !!prepared.topKey &&
                                                            sev.key === prepared.topKey
                                                        }
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
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// -----------------------------------------------------------------------------
function Root() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    if (!colorScheme) {
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

function mount() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(<Root />);
}

function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mount();
    } else {
        setTimeout(mountWhenReady, 50);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWhenReady, { once: true });
} else {
    mountWhenReady();
}
