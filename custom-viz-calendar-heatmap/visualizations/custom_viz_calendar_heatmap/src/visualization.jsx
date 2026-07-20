import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// ---------------------------------------------------------------------------
// カレンダーヒートマップ（GitHub の contribution graph 風・オートフィット版）
//
// データモデル:
//   第1列 = 日付（_time / ISO文字列 / epoch秒・ミリ秒 のいずれでも可）
//   第2列 = 数値。1 日 1 セルとして色の濃淡で強度を表す。
//
// 同じ日が複数行ある場合は合算する（例: | timechart span=1d count → そのまま）。
// 週を列、曜日を行（7行）として並べ、月ラベル・曜日ラベルを添える。
//
// セルサイズはコンテナ実寸から自動計算し、余白を残さず領域いっぱいに広げる。
// 「Max cell size」オプションで上限だけ指定できる（0 = 無制限）。
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
// 編集画面のサイドパネル（editorConfig）で設定した値を useOptions() で受け取る。
// 未設定・型不一致でも normalizeOptions で安全側に補正する。
//
// 【色分けの方針】
// 「安全＝緑系、危険＝赤系」を、値の大小に応じた 2色（任意で3色）カラースケールで表現する。
// 値を min〜max で 0..1 に正規化し、lowColor →(midColor)→ highColor を補間してセル色にする。
// 色・しきい値・向きはすべて editor.color / editor.number / editor.checkbox で設定でき、
// これらは useOptions() に確実に届く（editor.dynamicColor は context に保存されるため
// カスタムviz には配列が渡らず使えない、という実機調査結果を踏まえた設計）。
//
// - useValueColors: ON で「値ベースのカラースケール」、OFF で従来の強度グラデーション
// - lowColor / highColor: スケール両端の色（既定 低=緑, 高=赤）
// - useMidColor / midColor: 中間色を挟んで 緑→黄→赤 の3色スケールにする
// - reverse: 低↔高を反転（「高い値＝危険（赤）」にしたい時に使う）
// - scaleMin / scaleMax: 正規化の下限・上限（空欄=データの min/max を自動採用）

const DEFAULTS = {
    dateField: '', // 日付フィールド（空欄=第1列）。editor.columnSelector で選択
    valueField: '', // 値フィールド（空欄=第2列）。editor.columnSelector で選択
    useValueColors: false, // false=強度グラデーション(既定), true=値ベースのカラースケール
    lowColor: '#3fb950', // スケール低値側（安全＝緑）
    highColor: '#ef4d4d', // スケール高値側（危険＝赤）
    useMidColor: true, // 中間色を挟んで 3 色スケールにする
    midColor: '#f5c518', // 中間色（黄）
    reverse: false, // 低↔高を反転（ONで「高い値＝赤」）
    scaleMin: null, // 正規化の下限（null/空欄=データ最小）
    scaleMax: null, // 正規化の上限（null/空欄=データ最大）
    baseColor: '#39d353', // 強度グラデーション時の最大強度色（薄→濃に展開）
    levels: 5, // 強度グラデーション時の強度レベル数
    maxCellSize: 34, // セル一辺の上限（px）。0 で無制限＝常に領域いっぱい
    weekStartMonday: false, // 週の開始曜日。false=日曜始まり, true=月曜始まり
    showHeader: true, // 上部に期間・合計・平均のサマリーを表示
    showMonthLabels: true, // 月ラベルを表示
    showWeekdayLabels: true, // 曜日ラベルを表示
    showLegend: true, // 凡例を表示（グラデーション=Less→More / スケール=low→high）
    glow: false, // 濃いセルに発光エフェクト
    debug: false, // options の生値を画面に出す診断オーバーレイ
};

const WEEKDAY_LABELS_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LABELS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// セルの間隔はサイズに比例させる（モダンな見た目のため約 18%、下限 2px）
const GAP_RATIO = 0.18;
const MIN_GAP = 2;
const MAX_GAP = 6;

// ---------------------------------------------------------------------------
// カラーパレット（ライト / ダーク両モード対応）
// ---------------------------------------------------------------------------
const PALETTES = {
    dark: {
        text: '#f2f3fa',
        subText: '#9297ad',
        cardBg: 'rgba(255, 255, 255, 0.025)',
        cardBorder: 'rgba(255, 255, 255, 0.07)',
        emptyCell: 'rgba(255, 255, 255, 0.055)',
        cellStroke: 'transparent',
        hoverRing: '#f2f3fa',
        tooltipBg: 'rgba(24, 27, 38, 0.98)',
        tooltipText: '#f2f3fa',
        tooltipSub: '#9297ad',
        tooltipBorder: 'rgba(255, 255, 255, 0.12)',
    },
    light: {
        text: '#1f2440',
        subText: '#6b7186',
        cardBg: 'rgba(0, 0, 0, 0.015)',
        cardBorder: 'rgba(0, 0, 0, 0.07)',
        emptyCell: 'rgba(0, 0, 0, 0.055)',
        cellStroke: 'rgba(0, 0, 0, 0.04)',
        hoverRing: '#1f2440',
        tooltipBg: 'rgba(255, 255, 255, 0.99)',
        tooltipText: '#1f2440',
        tooltipSub: '#6b7186',
        tooltipBorder: 'rgba(0, 0, 0, 0.12)',
    },
};

// ---------------------------------------------------------------------------
// データ整形ユーティリティ
// ---------------------------------------------------------------------------
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const numRows = data.columns[0].length;
            return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
        }
    } catch (e) {
        // 想定外のデータ形式でも落とさない
    }
    return [];
}

// ---------------------------------------------------------------------------
// フィールド選択の解決（editor.columnSelector）
//
// 標準 viz の「データ設定」ドロップダウン（editor.columnSelector）は、選択結果を
// DOS 文字列（例: "> primary | seriesByName('count')"）でオプションに書く。
// カスタム viz には DOS が未解決のまま届く（dynamicColor / chord-flow で実測）ので、
// 文字列から seriesByName / seriesByIndex を正規表現でパースして列を自前解決する。
// 生フィールド名・ホスト解決済み列データ配列・未設定（既定列へ）も全て受ける。
// ---------------------------------------------------------------------------
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    // ホスト解決済みの列データ（配列）: 先頭数行を各列と照合してインデックスを特定
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
            return fallbackIdx; // 解釈できない DOS はデフォルト列へ退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// ---------------------------------------------------------------------------
// マルチバリューセルの救済（chord-flow v0.2 の定番防御）
//
// Splunk の mv フィールドは1行のセルに配列（環境により改行区切り文字列）で届くことがある
// （mvexpand し忘れ・stats values() など）。放置すると String(配列)="A,B" や、値の
// カンマ除去で "10,20"→1020 のような桁連結が起き、日付・値が壊れる。全カラムのトークン数が
// 一致する行に限り平行展開して救済し、不一致の行は null 行にして確実に落とす。
// ---------------------------------------------------------------------------
const MAX_MV_EXPAND = 20000;

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
            const n = Math.min(L, MAX_MV_EXPAND);
            for (let k = 0; k < n; k += 1) out.push(tokens.map((t) => t[k]));
        } else {
            // トークン数不一致はゴミデータ。null 行にして落とす
            out.push(new Array(row.length).fill(null));
        }
    }
    return out;
}

function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(toNumber(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function asBool(value, fallback) {
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

function isHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

// 数値 or 空欄。空欄/未設定/数値化不可なら null（＝自動）を返す。
function toNumberOrNull(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

// options（useOptions の戻り値）を安全な形に補正する。
// 色・数値・真偽はすべて editor.color / editor.number / editor.checkbox 由来で、
// useOptions に確実に届く（DOS/context に依存しない）。
// フィールド指定は「生フィールド名」「DOS 文字列（> primary | seriesByName('x')）」
// 「ホストが DOS を解決した列データ配列」のどれで届いても後段の resolveFieldIndex で
// 解決するため、ここでは型を保ったまま素通しする（trim だけ行う）。
function fieldSpec(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value;
    return '';
}

function normalizeOptions(options) {
    const o = options || {};
    return {
        dateField: fieldSpec(o.dateField),
        valueField: fieldSpec(o.valueField),
        useValueColors: asBool(o.useValueColors, DEFAULTS.useValueColors),
        lowColor: isHexColor(o.lowColor) ? o.lowColor.trim() : DEFAULTS.lowColor,
        highColor: isHexColor(o.highColor) ? o.highColor.trim() : DEFAULTS.highColor,
        useMidColor: asBool(o.useMidColor, DEFAULTS.useMidColor),
        midColor: isHexColor(o.midColor) ? o.midColor.trim() : DEFAULTS.midColor,
        reverse: asBool(o.reverse, DEFAULTS.reverse),
        scaleMin: toNumberOrNull(o.scaleMin),
        scaleMax: toNumberOrNull(o.scaleMax),
        baseColor: isHexColor(o.baseColor) ? o.baseColor.trim() : DEFAULTS.baseColor,
        levels: clampInt(o.levels, 2, 9, DEFAULTS.levels),
        maxCellSize: clampInt(o.maxCellSize, 0, 80, DEFAULTS.maxCellSize),
        weekStartMonday: asBool(o.weekStartMonday, DEFAULTS.weekStartMonday),
        showHeader: asBool(o.showHeader, DEFAULTS.showHeader),
        showMonthLabels: asBool(o.showMonthLabels, DEFAULTS.showMonthLabels),
        showWeekdayLabels: asBool(o.showWeekdayLabels, DEFAULTS.showWeekdayLabels),
        showLegend: asBool(o.showLegend, DEFAULTS.showLegend),
        glow: asBool(o.glow, DEFAULTS.glow),
    };
}

// 2 色を t(0..1) で線形補間して 'rgb(...)' を返す。
function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = Math.max(0, Math.min(1, t));
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `rgb(${r}, ${g}, ${bl})`;
}

// 正規化値 t(0..1) をカラースケール（low →[mid]→ high）にマップする。
// reverse=true なら t を反転（高い値ほど low 側の色になる＝「高い値＝赤」用途）。
function scaleColorFor(t, opts) {
    let u = Math.max(0, Math.min(1, t));
    if (opts.reverse) u = 1 - u;
    if (opts.useMidColor) {
        if (u <= 0.5) return lerpColor(opts.lowColor, opts.midColor, u / 0.5);
        return lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

// 各種フォーマットの日付を Date（ローカル 0:00）に正規化する
function parseDate(value) {
    if (value === null || value === undefined) return null;

    const raw = String(value).trim();
    // epoch 秒 / ミリ秒（数値 or 数字だけの文字列）
    if (/^\d+(\.\d+)?$/.test(raw)) {
        const num = Number(raw);
        const ms = num < 1e12 ? num * 1000 : num; // 10桁台=秒, 13桁台=ミリ秒
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return atMidnight(d);
    }

    // ISO / 一般的な日付文字列
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return atMidnight(parsed);

    return null;
}

function atMidnight(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    r.setDate(r.getDate() + n);
    return r;
}

function diffDays(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// 曜日インデックス（週開始に応じて 0..6）
function weekdayIndex(d, weekStartMonday) {
    const dow = d.getDay(); // 0=Sun..6=Sat
    return weekStartMonday ? (dow + 6) % 7 : dow;
}

function trimZero(n) {
    return Number(n.toFixed(1)).toString();
}

function formatValue(value) {
    if (!Number.isFinite(value)) return '';
    if (Math.abs(value) >= 1e9) return `${trimZero(value / 1e9)}G`;
    if (Math.abs(value) >= 1e6) return `${trimZero(value / 1e6)}M`;
    if (Math.abs(value) >= 1e3) return `${trimZero(value / 1e3)}K`;
    return value.toLocaleString('en-US');
}

function formatDateLabel(d) {
    const wd = WEEKDAY_LABELS_SUN[d.getDay()];
    return `${wd}, ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// hex → {r,g,b}
function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) {
        h = h.split('').map((c) => c + c).join('');
    }
    const num = parseInt(h, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

// 強度レベル（1..levels）を baseColor の薄→濃グラデーションに割り当てる。
// レベル 0（値なし/0）は emptyCell を使う。
// mode で薄い側の混ぜ先（dark=暗い地, light=白地）を変え、両テーマで視認性を確保。
function levelColor(level, levels, baseColor, mode) {
    if (level <= 0) return null;
    const { r, g, b } = hexToRgb(baseColor);
    const t = levels <= 1 ? 1 : 0.32 + 0.68 * ((level - 1) / (levels - 1));
    const mix = 1 - t;
    // dark: 暗いスレート地に向けて減光 / light: 白に向けて減光
    const base = mode === 'light' ? 255 : 34;
    const rr = Math.round(r * t + base * mix);
    const gg = Math.round(g * t + base * mix);
    const bb = Math.round(b * t + base * mix);
    return `rgb(${rr}, ${gg}, ${bb})`;
}

// セルの塗り色を決める（値レンジ/一致 or グラデーション）。
// null を返した場合は呼び出し側で emptyCell 色にフォールバックする。
// - 値カラースケール: 値を [scaleLo, scaleHi] で 0..1 に正規化し low→[mid]→high を補間
// - グラデーション: 相対強度レベルを baseColor 薄→濃に割り当てる
// scaleLo/scaleHi は呼び出し側で「opts.scaleMin/Max（空欄ならデータの min/max）」から解決済み。
function cellFill(cell, opts, mode, scaleLo, scaleHi) {
    if (cell.value === null) return null; // 範囲外
    if (opts.useValueColors) {
        const span = scaleHi - scaleLo;
        const t = span > 0 ? (cell.value - scaleLo) / span : 0.5; // 全同値なら中央色
        return scaleColorFor(t, opts);
    }
    return levelColor(cell.level, opts.levels, opts.baseColor, mode);
}

// ---------------------------------------------------------------------------
// データ → カレンダーモデル
// ---------------------------------------------------------------------------
function buildCalendar(rows, weekStartMonday, levels, dateIdx, valueIdx) {
    const byDay = new Map();
    let minDate = null;
    let maxDate = null;
    let total = 0;

    for (const row of rows) {
        const d = parseDate(row?.[dateIdx]);
        if (!d) continue;
        const v = toNumber(row?.[valueIdx]);
        const val = Number.isFinite(v) ? v : 0;
        const key = dayKey(d);
        const prev = byDay.get(key);
        if (prev) {
            prev.value += val;
        } else {
            byDay.set(key, { date: d, value: val });
        }
        total += val;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
    }

    if (!minDate || !maxDate) {
        return { valid: false };
    }

    const entries = Array.from(byDay.values());
    const maxValue = entries.reduce((m, e) => Math.max(m, e.value), 0);
    // 実データが入っている日の最小値（カラースケール正規化の下限に使う）
    const minValue = entries.length
        ? entries.reduce((m, e) => Math.min(m, e.value), Infinity)
        : 0;
    const activeDays = entries.filter((e) => e.value > 0).length;

    // グリッドの開始は minDate を含む週の先頭、終了は maxDate を含む週の末尾
    const startPad = weekdayIndex(minDate, weekStartMonday);
    const gridStart = addDays(minDate, -startPad);
    const endPad = 6 - weekdayIndex(maxDate, weekStartMonday);
    const gridEnd = addDays(maxDate, endPad);

    const totalDays = diffDays(gridStart, gridEnd) + 1;
    const weekCount = Math.ceil(totalDays / 7);

    const cells = [];
    for (let i = 0; i < totalDays; i += 1) {
        const date = addDays(gridStart, i);
        const inRange = date >= minDate && date <= maxDate;
        const entry = byDay.get(dayKey(date));
        const value = entry ? entry.value : inRange ? 0 : null; // 範囲外は null
        let level = 0;
        if (value !== null && value > 0 && maxValue > 0) {
            level = Math.min(levels, Math.max(1, Math.ceil((value / maxValue) * levels)));
        }
        cells.push({ date, value, level, week: Math.floor(i / 7), day: i % 7, inRange });
    }

    // 月ラベル: 各週の先頭セルの月が前週と変わったら、その週位置に月名を置く
    const monthMarks = [];
    let lastMonth = -1;
    for (let w = 0; w < weekCount; w += 1) {
        const firstCell = cells[w * 7];
        if (!firstCell) continue;
        const m = firstCell.date.getMonth();
        if (m !== lastMonth) {
            monthMarks.push({ week: w, label: MONTH_LABELS[m] });
            lastMonth = m;
        }
    }

    return {
        valid: true,
        cells,
        weekCount,
        maxValue,
        minValue,
        minDate,
        maxDate,
        monthMarks,
        dayCount: byDay.size,
        activeDays,
        total,
    };
}

// ---------------------------------------------------------------------------
// コンテナ実寸を購読するフック（ResizeObserver、無い環境では初回計測フォールバック）
// ---------------------------------------------------------------------------
function useMeasure() {
    const ref = useRef(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        // 1px 未満の変化は無視して再レンダーの振動（点滅）を防ぐ。
        // スクロールバーの出入りで clientWidth/Height が微小に揺れると
        // レイアウト再計算 → スクロールバー切替 → … の無限ループになりうるため、
        // 前回値と実質同じなら state を更新しない。
        const measure = () => {
            const width = node.clientWidth;
            const height = node.clientHeight;
            setBox((prev) =>
                Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
                    ? prev
                    : { width, height }
            );
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(node);
        return () => ro.disconnect();
    }, []);
    return [ref, box];
}

// ---------------------------------------------------------------------------
// 状態表示コンポーネント
// ---------------------------------------------------------------------------
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function MessageState({ text }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <img src={chartIcon} className="viz-message-icon" alt="" />
                <Paragraph>{text}</Paragraph>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// ヘッダー（期間・合計・アクティブ日数のサマリー）
// ---------------------------------------------------------------------------
// compact=true のときはフォントを一段小さくし、統計ブロックの折り返しを禁止して
// 1〜2行に収める（狭いパネルでヘッダーがグリッドの高さを奪わないように）。
function Header({ calendar, palette, compact }) {
    const { minDate, maxDate, total, activeDays, maxValue } = calendar;
    const range = `${MONTH_LABELS[minDate.getMonth()]} ${minDate.getDate()} – ${
        MONTH_LABELS[maxDate.getMonth()]
    } ${maxDate.getDate()}, ${maxDate.getFullYear()}`;

    const stats = [
        { label: 'Total', value: formatValue(total) },
        { label: 'Active days', value: formatValue(activeDays) },
        { label: 'Peak / day', value: formatValue(maxValue) },
    ];

    // コンパクト時のフォント/余白スケール
    const rangeFont = compact ? 10 : 12;
    const valFont = compact ? 12 : 15;
    const labFont = compact ? 9 : 11;
    const statGap = compact ? 10 : 18;

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: compact ? 8 : 16,
                flexWrap: compact ? 'nowrap' : 'wrap',
                marginBottom: compact ? 6 : 12,
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    color: palette.subText,
                    fontSize: rangeFont,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}
            >
                {range}
            </div>
            <div style={{ display: 'flex', gap: statGap, flexShrink: 0 }}>
                {stats.map((s) => (
                    <div key={s.label} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span
                            style={{
                                color: palette.text,
                                fontSize: valFont,
                                fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            {s.value}
                        </span>
                        <span
                            style={{ color: palette.subText, fontSize: labFont, marginLeft: 5 }}
                        >
                            {s.label}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// ヒートマップ本体（SVG・オートフィット）
// ---------------------------------------------------------------------------
function HeatmapSvg({ calendar, opts, palette, mode, availWidth, availHeight }) {
    const { cells, weekCount, monthMarks } = calendar;
    const [hover, setHover] = useState(null);

    // カラースケールの下限・上限（オプション空欄ならデータの min/max を採用）
    const scaleLo = opts.scaleMin !== null ? opts.scaleMin : calendar.minValue;
    const scaleHi = opts.scaleMax !== null ? opts.scaleMax : calendar.maxValue;

    const weekdayLabels = opts.weekStartMonday ? WEEKDAY_LABELS_MON : WEEKDAY_LABELS_SUN;

    // 最小セルサイズ（これ未満には縮めない。以下ならスクロールに切り替える）
    const MIN_CELL = 6;

    // ラベル領域のフォント目安から余白を先に見積もる。
    // ただしセルが小さい（＝パネルが小さい）ときはラベルを畳んで領域をグリッドに回す。
    // まず「ラベル込みで幅・高さ両方に収まる最大セル」を仮計算し、そのセルが
    // しきい値を下回るならラベルを抑制して再計算する（下の resolveLayout で反復）。
    const gridCols = Math.max(weekCount, 1);

    // ラベル余白の有無を受けてセルサイズと SVG 実寸を求めるヘルパ。
    // returns: { cell, step, gap, radius, monthH, weekdayW, gridWidth, gridHeight,
    //            svgWidth, svgHeight }
    const layoutFor = (showMonth, showWeekday) => {
        const monthH = showMonth ? 18 : 0;
        const weekdayW = showWeekday ? 34 : 0;
        const usableW = Math.max(10, availWidth - weekdayW);
        const usableH = Math.max(10, availHeight - monthH);
        const stepByW = usableW / gridCols;
        const stepByH = usableH / 7;
        // 最小 MIN_CELL 相当を保証しつつ、収まるなら大きく
        let step = Math.max(MIN_CELL * (1 + GAP_RATIO), Math.min(stepByW, stepByH));
        let cell = step / (1 + GAP_RATIO);
        // 上限キャップ（0 = 無制限）
        if (opts.maxCellSize > 0 && cell > opts.maxCellSize) {
            cell = opts.maxCellSize;
        }
        cell = Math.max(MIN_CELL, cell);
        const gap = Math.max(MIN_GAP, Math.min(MAX_GAP, cell * GAP_RATIO));
        step = cell + gap;
        const radius = Math.max(2, Math.min(cell * 0.28, 8));
        const gridWidth = gridCols * step - gap;
        const gridHeight = 7 * step - gap;
        return {
            cell,
            step,
            gap,
            radius,
            monthH,
            weekdayW,
            gridWidth,
            gridHeight,
            svgWidth: weekdayW + gridWidth,
            svgHeight: monthH + gridHeight,
        };
    };

    // ラベルを抑制すべきか判定するしきい値（セル一辺）
    const LABEL_MIN_CELL = 10;
    // まずオプション通りのラベルで仮レイアウト
    let L = layoutFor(opts.showMonthLabels, opts.showWeekdayLabels);
    // セルがこのしきい値未満なら、ラベルを畳んで領域をグリッドへ回す
    const showMonthLabels = opts.showMonthLabels && L.cell >= LABEL_MIN_CELL;
    const showWeekdayLabels = opts.showWeekdayLabels && L.cell >= LABEL_MIN_CELL;
    if (showMonthLabels !== opts.showMonthLabels || showWeekdayLabels !== opts.showWeekdayLabels) {
        L = layoutFor(showMonthLabels, showWeekdayLabels);
    }

    const { cell, step, gap, radius, monthH, weekdayW, gridWidth, gridHeight } = L;

    // SVG は「実コンテンツ寸法」と「利用領域」の大きい方でサイズする。
    // 収まる場合は availWidth/Height（＝中央寄せの余白込み）、はみ出す場合は
    // コンテンツ実寸にして、親ラッパの overflow:auto でスクロール表示させる
    // （右側の週を見切らせない）。
    const contentW = weekdayW + gridWidth;
    const contentH = monthH + gridHeight;
    const svgW = Math.max(availWidth, contentW);
    const svgH = Math.max(availHeight, contentH);

    // 収まる範囲でのみ中央寄せ（はみ出す軸は 0＝左/上詰めにしてスクロール起点を揃える）
    const offsetX = Math.max(0, (svgW - contentW) / 2);
    const offsetY = Math.max(0, (svgH - contentH) / 2);
    const gridLeft = offsetX + weekdayW;
    const gridTop = offsetY + monthH;

    // マウント後にフェードイン
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const wdFont = Math.max(8, Math.min(cell * 0.62, 12));
    const monthFont = Math.max(9, Math.min(cell * 0.7, 13));

    return (
        <div style={{ position: 'relative', width: svgW, height: svgH }}>
            <svg
                width={svgW}
                height={svgH}
                viewBox={`0 0 ${svgW} ${svgH}`}
                style={{ display: 'block' }}
                role="img"
            >
                {opts.glow && (
                    <defs>
                        <filter id="cell-glow" x="-40%" y="-40%" width="180%" height="180%">
                            <feGaussianBlur stdDeviation={Math.max(1, cell * 0.12)} result="b" />
                            <feMerge>
                                <feMergeNode in="b" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>
                )}

                {/* 月ラベル（小さいパネルでは自動抑制済み） */}
                {showMonthLabels &&
                    monthMarks.map((mm, i) => (
                        <text
                            key={`month-${i}`}
                            x={gridLeft + mm.week * step}
                            y={gridTop - 6}
                            fontSize={monthFont}
                            fontWeight={600}
                            fill={palette.subText}
                        >
                            {mm.label}
                        </text>
                    ))}

                {/* 曜日ラベル（Mon / Wed / Fri のみ・小さいパネルでは自動抑制済み） */}
                {showWeekdayLabels &&
                    weekdayLabels.map((wl, i) =>
                        i % 2 === 1 ? (
                            <text
                                key={`wd-${i}`}
                                x={gridLeft - 8}
                                y={gridTop + i * step + cell / 2}
                                fontSize={wdFont}
                                textAnchor="end"
                                dominantBaseline="middle"
                                fill={palette.subText}
                            >
                                {wl}
                            </text>
                        ) : null
                    )}

                {/* セル */}
                {cells.map((c, i) => {
                    if (!c.inRange) return null;
                    const x = gridLeft + c.week * step;
                    const y = gridTop + c.day * step;
                    const fill = cellFill(c, opts, mode, scaleLo, scaleHi) || palette.emptyCell;
                    // グロー対象: グラデーションは最上位レベル / スケールは高値側 80% 以上のセル
                    let hot;
                    if (opts.useValueColors) {
                        const span = scaleHi - scaleLo;
                        const t = c.value !== null && span > 0 ? (c.value - scaleLo) / span : 0;
                        const tt = opts.reverse ? 1 - t : t;
                        hot = c.value !== null && tt >= 0.8;
                    } else {
                        hot = c.level >= opts.levels - 1;
                    }
                    const isHover = hover && hover.week === c.week && hover.day === c.day;
                    return (
                        <rect
                            key={`cell-${i}`}
                            x={x}
                            y={y}
                            width={cell}
                            height={cell}
                            rx={radius}
                            ry={radius}
                            fill={fill}
                            stroke={isHover ? palette.hoverRing : palette.cellStroke}
                            strokeWidth={isHover ? Math.max(1.5, cell * 0.08) : 1}
                            filter={opts.glow && hot ? 'url(#cell-glow)' : undefined}
                            style={{
                                opacity: mounted ? 1 : 0,
                                transition: `opacity 300ms ease ${Math.min(c.week * 6, 350)}ms`,
                                cursor: 'pointer',
                            }}
                            onMouseEnter={() =>
                                setHover({
                                    week: c.week,
                                    day: c.day,
                                    x: x + cell / 2,
                                    y,
                                    date: c.date,
                                    value: c.value,
                                })
                            }
                            onMouseLeave={() => setHover(null)}
                        />
                    );
                })}
            </svg>

            {/* ツールチップ（HTML オーバーレイ） */}
            {hover && (
                <div
                    style={{
                        position: 'absolute',
                        left: hover.x,
                        top: hover.y - 8,
                        transform: 'translate(-50%, -100%)',
                        background: palette.tooltipBg,
                        border: `1px solid ${palette.tooltipBorder}`,
                        borderRadius: 8,
                        padding: '6px 10px',
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
                        zIndex: 3,
                        backdropFilter: 'blur(4px)',
                    }}
                >
                    <div
                        style={{
                            fontWeight: 700,
                            fontSize: 13,
                            color: palette.tooltipText,
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {hover.value === null ? 'No data' : `${formatValue(hover.value)}`}
                    </div>
                    <div style={{ fontSize: 11, color: palette.tooltipSub, marginTop: 1 }}>
                        {formatDateLabel(hover.date)}
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 凡例。グラデーション時は Less→More、閾値時は値レンジ別のスウォッチを表示。
// ---------------------------------------------------------------------------
// maxWidth: 凡例が使える横幅（コンテナ幅 - padding）。0/未指定なら従来の固定幅。
function Legend({ opts, palette, mode, calendar, maxWidth }) {
    // 値カラースケール: low →[mid]→ high の連続グラデーションバー ＋ 最小/最大ラベル
    if (opts.useValueColors) {
        const lo = opts.scaleMin !== null ? opts.scaleMin : calendar.minValue;
        const hi = opts.scaleMax !== null ? opts.scaleMax : calendar.maxValue;
        // reverse を考慮してバー左端=低値側の色になるよう並べる
        const stops = opts.useMidColor
            ? [opts.lowColor, opts.midColor, opts.highColor]
            : [opts.lowColor, opts.highColor];
        const ordered = opts.reverse ? [...stops].reverse() : stops;
        const gradient = `linear-gradient(90deg, ${ordered.join(', ')})`;
        // グラデーションバー幅: 使える横幅から min/max ラベル分（約 110px）を引いた残りに収める
        const barW =
            maxWidth > 0 ? Math.max(40, Math.min(120, maxWidth - 110)) : 120;
        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 8,
                    marginTop: 8,
                    color: palette.subText,
                    fontSize: 11,
                    overflow: 'hidden',
                }}
            >
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatValue(lo)}</span>
                <span
                    style={{
                        width: barW,
                        height: 12,
                        borderRadius: 3,
                        background: gradient,
                        display: 'inline-block',
                        flexShrink: 0,
                    }}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatValue(hi)}</span>
            </div>
        );
    }

    // グラデーションモード: Less → More
    const swatches = [{ key: 'empty', fill: palette.emptyCell }];
    for (let lvl = 1; lvl <= opts.levels; lvl += 1) {
        swatches.push({ key: `l${lvl}`, fill: levelColor(lvl, opts.levels, opts.baseColor, mode) });
    }
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 5,
                marginTop: 8,
                color: palette.subText,
                fontSize: 11,
                flexWrap: 'nowrap',
                overflow: 'hidden',
            }}
        >
            <span style={{ marginRight: 2, flexShrink: 0 }}>Less</span>
            {swatches.map((sw) => (
                <span
                    key={sw.key}
                    style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: sw.fill,
                        display: 'inline-block',
                        flexShrink: 0,
                    }}
                />
            ))}
            <span style={{ marginLeft: 2, flexShrink: 0 }}>More</span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// レイアウト（ヘッダー + オートフィットのグリッド + 凡例）
//
// 小さいパネル（例 200x150px）では各パーツが領域を奪い合い、右側の週が
// 見切れる。そこでコンテナ実寸に応じて段階的に「間引き」する:
//   - パディングを縮小（16→8→4）して描画領域を確保
//   - ヘッダーを縮小 → さらに狭ければ非表示
//   - 凡例を非表示（幅・高さがしきい値未満のとき）
//   - グリッドはラッパを overflow:auto（.viz-scroll と同パターン）にして、
//     最小セルでも収まらない分は見切らずスクロールで全データを見せる
// ---------------------------------------------------------------------------
// レイアウト判定のしきい値（px）
const COMPACT_W = 360; // これ未満でヘッダーをコンパクト表示
const COMPACT_H = 220; // これ未満でヘッダーをコンパクト表示
const HIDE_HEADER_W = 240; // これ未満ならヘッダーを丸ごと隠す
const HIDE_HEADER_H = 130; // これ未満ならヘッダーを丸ごと隠す
const HIDE_LEGEND_W = 260; // これ未満なら凡例を隠す
const HIDE_LEGEND_H = 140; // これ未満なら凡例を隠す

function CalendarHeatmapLayout({ calendar, opts, mode }) {
    const palette = PALETTES[mode] || PALETTES.dark;
    // コンテナ全体を計測してレイアウトの間引き段階を決める（padding 決定にも使う）
    const [rootRef, rootBox] = useMeasure();
    const [gridRef, gridBox] = useMeasure();

    const w = rootBox.width;
    const h = rootBox.height;
    const measured = w > 0 && h > 0;

    // 小さいほどパディングを詰めて描画領域を稼ぐ
    let pad = 16;
    if (measured && (w < 240 || h < 160)) pad = 4;
    else if (measured && (w < 360 || h < 220)) pad = 8;

    // ヘッダー: 未計測時は既定表示。狭い/低いと丸ごと隠す。中間はコンパクト。
    const showHeader =
        opts.showHeader && (!measured || (w >= HIDE_HEADER_W && h >= HIDE_HEADER_H));
    const compactHeader = measured && (w < COMPACT_W || h < COMPACT_H);

    // 凡例: 狭い/低いと隠す（残りの高さをグリッドに回す）
    const showLegend =
        opts.showLegend && (!measured || (w >= HIDE_LEGEND_W && h >= HIDE_LEGEND_H));

    return (
        <div
            ref={rootRef}
            className="viz-container"
            style={{
                padding: pad,
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
            }}
        >
            {showHeader && (
                <Header calendar={calendar} palette={palette} compact={compactHeader} />
            )}

            {/* グリッド領域。
                計測用の外側ラッパ（gridRef, overflow:hidden・非スクロール）と、
                実スクロールを担う内側ラッパ（overflow:auto）を分離する。
                こうしないと「スクロールバー出現 → clientWidth/Height が縮む →
                再計算でスクロールバー消滅 → …」の振動でビジュアライゼーション全体が
                点滅する。計測は常にスクロールバーの影響を受けない外側で行う。 */}
            <div
                ref={gridRef}
                style={{
                    flex: '1 1 auto',
                    minHeight: 0,
                    width: '100%',
                    position: 'relative',
                    overflow: 'hidden',
                }}
            >
                {gridBox.width > 0 && gridBox.height > 0 && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            overflow: 'auto',
                        }}
                    >
                        <HeatmapSvg
                            calendar={calendar}
                            opts={opts}
                            palette={palette}
                            mode={mode}
                            availWidth={gridBox.width}
                            availHeight={gridBox.height}
                        />
                    </div>
                )}
            </div>

            {showLegend && (
                <Legend
                    opts={opts}
                    palette={palette}
                    mode={mode}
                    calendar={calendar}
                    maxWidth={measured ? Math.max(60, w - pad * 2) : 0}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース + オプション接続
// ---------------------------------------------------------------------------
function CalendarHeatmapVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();

    const data = dataSources?.primary?.data || null;
    const rawRows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    // mv セルを平行展開して救済してから使う（桁連結・カンマ連結事故の防御）
    const rows = useMemo(() => expandMultivalueRows(rawRows), [rawRows]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && f.name != null ? f.name : f)),
        [data]
    );
    const opts = useMemo(() => normalizeOptions(options), [options]);

    // フィールド選択の解決（未設定なら 日付=第1列 / 値=第2列 にフォールバック）
    const dateIdx = useMemo(
        () => resolveFieldIndex(opts.dateField, fieldNames, rows, 0),
        [opts.dateField, fieldNames, rows]
    );
    const valueIdx = useMemo(
        () => resolveFieldIndex(opts.valueField, fieldNames, rows, 1),
        [opts.valueField, fieldNames, rows]
    );

    const calendar = useMemo(
        () => buildCalendar(rows, opts.weekStartMonday, opts.levels, dateIdx, valueIdx),
        [rows, opts.weekStartMonday, opts.levels, dateIdx, valueIdx]
    );

    // デバッグ: options の生の中身を画面に出す（config の debug=true で有効）。
    // 動的色設定を編集したとき options のどのキーに何が入るかを実機で確認するため。
    const debug = asBool(options?.debug, false);

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <MessageState text="No data available" />;
    if (!calendar.valid) {
        return <MessageState text="No valid dates found. First column must be a date/_time." />;
    }

    return (
        <>
            {debug && (
                <DebugOverlay
                    options={options}
                    opts={opts}
                    fieldNames={fieldNames}
                    dateIdx={dateIdx}
                    valueIdx={valueIdx}
                />
            )}
            <CalendarHeatmapLayout calendar={calendar} opts={opts} mode={mode} />
        </>
    );
}

// options の生値と解決後ルールを画面隅にダンプする診断用オーバーレイ
function DebugOverlay({ options, opts, fieldNames, dateIdx, valueIdx }) {
    let raw;
    try {
        raw = JSON.stringify(options, null, 1);
    } catch (e) {
        raw = String(options);
    }
    const keys = options && typeof options === 'object' ? Object.keys(options) : [];
    return (
        <div
            style={{
                position: 'fixed',
                top: 4,
                left: 4,
                right: 4,
                maxHeight: '46%',
                overflow: 'auto',
                zIndex: 9999,
                background: 'rgba(0,0,0,0.9)',
                color: '#7CFC7C',
                font: '11px/1.4 monospace',
                border: '1px solid #3fb950',
                borderRadius: 6,
                padding: 8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
            }}
        >
            <div style={{ color: '#fff', fontWeight: 700 }}>DEBUG options keys: {keys.join(', ')}</div>
            <div style={{ color: '#79d0ff' }}>
                fields=[{(fieldNames || []).join(', ')}] → dateIdx={String(dateIdx)} valueIdx=
                {String(valueIdx)}
            </div>
            <div style={{ color: '#ffd479' }}>
                resolved: useValueColors={String(opts.useValueColors)} low={opts.lowColor} mid=
                {opts.useMidColor ? opts.midColor : '-'} high={opts.highColor} reverse=
                {String(opts.reverse)}
            </div>
            <div style={{ marginTop: 4 }}>{raw}</div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きルート
// useTheme() が undefined（テーマ未取得）の間は App をレンダリングしない
// ---------------------------------------------------------------------------
function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;

    if (!colorScheme) {
        return null;
    }

    const mode = colorScheme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <CalendarHeatmapVisualization mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
