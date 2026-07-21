import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// ---------------------------------------------------------------------------
// レーダー（スパイダー）チャート
//
// データモデル:
//   軸フィールド（既定=第1列）  = レーダーの各頂点になるメトリック名。
//   系列フィールド（既定=第2列以降）= 系列（エンティティ）。数値列 1 つにつき
//                                       ポリゴンを 1 枚重ねて描く（最大 6 系列）。
//
// 例）各行が 1 つのメトリック、各列が 1 つのエンティティ（host など）の値になっていれば、
//     エンティティごとに 1 枚のポリゴンが重なり、複数エンティティを一目で比較できる。
//
// 編集画面「データ設定」で軸・系列の列を任意に選べる（editor.columnSelector）。
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
// 編集画面のサイドパネル（editorConfig）で設定した値を useOptions() で受け取る。
// 未設定・型不一致でも normalizeOptions で安全側に補正する。
const DEFAULT_SERIES_COLORS = [
    '#5b8def', // 青
    '#2dd4bf', // ティール
    '#f0912e', // オレンジ
    '#ef4d6a', // レッド/ピンク
    '#a78bfa', // 紫
    '#f5c518', // 黄
];

const DEFAULTS = {
    fillOpacity: 22, // ポリゴン塗りの不透明度（％）
    strokeWidth: 2, // 輪郭線の太さ（px）
    rings: 4, // グリッドのリング（同心多角形）本数
    showDots: true, // 各頂点にドットマーカーを表示
    showAxisLabels: true, // 軸ラベル（メトリック名）を表示
    showValueLabels: true, // ホバー中の系列に各頂点の値を表示
    showLegend: true, // 系列の凡例を表示
    sharedScale: false, // true=全軸共通スケール, false=軸ごとに個別スケール（既定）
    glow: true, // ネオン風の発光エフェクト
    startAngle: -90, // 最初の軸の角度（-90=真上）
    debug: false, // オプション/データのデバッグダンプを表示
};

const MAX_SERIES = DEFAULT_SERIES_COLORS.length;

// ---------------------------------------------------------------------------
// カラーパレット（ライト / ダーク両モード対応）
// ---------------------------------------------------------------------------
const PALETTES = {
    dark: {
        axisLabel: '#c9cde0',
        valueLabel: '#f2f3fa',
        valueHalo: 'rgba(15, 17, 26, 0.85)',
        grid: 'rgba(255, 255, 255, 0.10)',
        gridStrong: 'rgba(255, 255, 255, 0.18)',
        spoke: 'rgba(255, 255, 255, 0.08)',
        legendLabel: '#d6d8e6',
        debugText: '#8b90a6',
    },
    light: {
        axisLabel: '#4a5068',
        valueLabel: '#1f2440',
        valueHalo: 'rgba(255, 255, 255, 0.9)',
        grid: 'rgba(0, 0, 0, 0.10)',
        gridStrong: 'rgba(0, 0, 0, 0.20)',
        spoke: 'rgba(0, 0, 0, 0.06)',
        legendLabel: '#3c4258',
        debugText: '#6a7089',
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

// Splunk のマルチバリューフィールドは1行のセルに配列（環境によっては改行区切り文字列）で
// 届くことがある（mvexpand し忘れ・stats の values() など）。全カラムのトークン数が一致する
// 場合に限り平行に行へ展開して救済する。String(配列) のカンマ連結や数値の桁連結
// （"5200"+"3100"+… → 5.2e30）といった壊れた表示を防ぐ。
const MAX_MV_EXPAND = 10000;

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
            // トークン数不一致はゴミデータ。そのまま流すと String(配列)="A,B" が軸名に、
            // parseNum("10,20")=1020 が桁連結の巨大値に化けるため null 行にして落とす
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

function clampNum(value, min, max, fallback) {
    const n = toNumber(value);
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

// フィールド指定（editor.columnSelector）の解決。
// editor.columnSelector は選択結果を DOS 文字列（例: "> primary | seriesByName('cpu')"）
// としてオプションに書く。カスタム viz には DOS が未解決のまま届くため、文字列から
// フィールド名/インデックスを自前でパースする。将来ホストが列データ配列を渡すように
// なっても動くよう、配列は列内容の照合で解決する。
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
            return fallbackIdx; // 解釈できない DOS はデフォルト列に退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// options（useOptions の戻り値）を安全な形に補正する
function normalizeOptions(options) {
    const o = options || {};
    const colors = [];
    for (let i = 0; i < MAX_SERIES; i += 1) {
        const c = o[`seriesColor${i + 1}`];
        colors.push(isHexColor(c) ? c.trim() : DEFAULT_SERIES_COLORS[i]);
    }
    // 生の列指定文字列（DOS 文字列）はそのまま保持し、buildRadarData でフィールド名/行が
    // 揃った時点で resolveFieldIndex にかける。
    const seriesFields = [];
    for (let i = 0; i < MAX_SERIES; i += 1) {
        seriesFields.push(o[`seriesField${i + 1}`] ?? '');
    }
    return {
        colors,
        axisField: o.axisField ?? '',
        seriesFields,
        fillOpacity: clampNum(o.fillOpacity, 0, 100, DEFAULTS.fillOpacity),
        strokeWidth: clampNum(o.strokeWidth, 0.5, 8, DEFAULTS.strokeWidth),
        rings: clampInt(o.rings, 1, 8, DEFAULTS.rings),
        showDots: asBool(o.showDots, DEFAULTS.showDots),
        showAxisLabels: asBool(o.showAxisLabels, DEFAULTS.showAxisLabels),
        showValueLabels: asBool(o.showValueLabels, DEFAULTS.showValueLabels),
        showLegend: asBool(o.showLegend, DEFAULTS.showLegend),
        sharedScale: asBool(o.sharedScale, DEFAULTS.sharedScale),
        glow: asBool(o.glow, DEFAULTS.glow),
        startAngle: clampNum(o.startAngle, -360, 360, DEFAULTS.startAngle),
        debug: asBool(o.debug, DEFAULTS.debug),
    };
}

// 軸=指定列（既定=第1列）、系列=指定列（既定=軸列以外の全数値列）として
// レーダー用のモデルを組み立てる。
function buildRadarData(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = Math.max(
        fieldNames?.length || 0,
        rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    );

    // 軸フィールド（メトリック名の列）。既定は第1列。
    const axisIdx = resolveFieldIndex(opts.axisField, fieldNames, rows, 0);

    // 系列列の決定。
    //  - seriesField* が 1 つでも明示されていれば、その順序・その列だけを系列にする。
    //  - どれも未指定なら「軸列以外の全列」を左から順に系列とする（従来動作）。
    const explicit = [];
    for (let i = 0; i < MAX_SERIES; i += 1) {
        const spec = opts.seriesFields[i];
        if (spec !== '' && spec !== null && spec !== undefined) {
            const idx = resolveFieldIndex(spec, fieldNames, rows, -1);
            if (idx >= 0 && idx !== axisIdx) explicit.push(idx);
        }
    }
    let seriesCols;
    if (explicit.length > 0) {
        // 重複を除いた順序保持
        seriesCols = explicit.filter((v, i) => explicit.indexOf(v) === i);
    } else {
        seriesCols = [];
        for (let c = 0; c < colCount && seriesCols.length < MAX_SERIES; c += 1) {
            if (c !== axisIdx) seriesCols.push(c);
        }
    }

    // 軸行: 軸セルが空でない行のみ採用（空ラベルの頂点は作らない）
    const axisRows = rows.filter((row) => {
        if (!Array.isArray(row)) return false;
        const a = row[axisIdx];
        return a !== null && a !== undefined && String(a).trim() !== '';
    });
    const axisLabels = axisRows.map((row) => String(row[axisIdx]).trim());

    const series = seriesCols.map((colIndex) => {
        const values = axisRows.map((row) => {
            const v = toNumber(row?.[colIndex]);
            return Number.isFinite(v) ? v : 0;
        });
        return {
            name: fieldNames?.[colIndex] ? String(fieldNames[colIndex]) : `series ${colIndex + 1}`,
            values,
        };
    });

    // 各軸ごとの最大値（個別スケール用）と全体最大（共通スケール用）
    const perAxisMax = axisLabels.map((_, axisIndex) => {
        let m = 0;
        for (const ser of series) m = Math.max(m, ser.values[axisIndex] ?? 0);
        return m;
    });
    const globalMax = perAxisMax.reduce((max, v) => Math.max(max, v), 0);

    return { axisLabels, series, perAxisMax, globalMax, axisIdx, seriesCols };
}

function trimZero(n) {
    return Number(n.toFixed(1)).toString();
}

function formatValue(value) {
    if (!Number.isFinite(value)) return '';
    if (Math.abs(value) >= 1e9) return `${trimZero(value / 1e9)}G`;
    if (Math.abs(value) >= 1e6) return `${trimZero(value / 1e6)}M`;
    if (Math.abs(value) >= 1e3) return `${trimZero(value / 1e3)}K`;
    return trimZero(value);
}

function hexToRgba(hex, alpha) {
    let h = hex.replace('#', '');
    if (h.length === 3) {
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    }
    const num = parseInt(h, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

// ラベルの推定描画幅（SVG に measureText が無いので概算）。
// CJK ≈ 1.0×fontSize、その他 ≈ 0.6×fontSize。見切れ防止の余白計算に使う。
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0) || 0;
        w += cp > 0x2e7f ? fontSize : fontSize * 0.6;
    }
    return w;
}

// 推定幅が maxPx に収まるよう末尾を … で切り詰める（chord-flow の fitText と同型）
function fitText(text, fontSize, maxPx) {
    const str = String(text);
    if (estimateTextWidth(str, fontSize) <= maxPx) return str;
    let out = '';
    for (const ch of str) {
        if (estimateTextWidth(`${out}${ch}…`, fontSize) > maxPx) break;
        out += ch;
    }
    return out === '' ? '…' : `${out}…`;
}

// 極座標 → 直交座標（cx, cy 中心、半径 r、角度 deg）
function polar(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
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
// レーダー本体（SVG）。hovered / setHovered は親から受け取り凡例と連動する。
// ---------------------------------------------------------------------------
function RadarSvg({ model, opts, palette, width, height, hovered, setHovered }) {
    const { axisLabels, series, perAxisMax, globalMax } = model;
    const axisCount = axisLabels.length;

    // マウント後にポリゴンを中心 → 外側へ広げるアニメーション
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const angles = useMemo(
        () => axisLabels.map((_, i) => opts.startAngle + (360 / Math.max(axisCount, 1)) * i),
        [axisLabels, axisCount, opts.startAngle]
    );

    // 小パネル対応レイアウト（chord-flow の段階的退避パターンを踏襲）:
    //   フォントは min(width,height) 基準でスケール（読める下限で頭打ち）。
    //   ラベル余白は「実ラベルの推定幅」から決め、収まらないときは
    //     値注釈オフ → ラベル切り詰め → ラベル自体を非表示（ツールチップ/titleで代替）
    //   の順に退避してリング半径を優先する。それでも小さすぎれば tooSmall。
    const size = Math.max(80, Math.min(width, height));

    // サイズ基準のフォントスケール。通常/大サイズでは従来どおり 12px、
    // 小パネルでは 8px まで段階的に縮小する（大サイズの見た目は変えない）。
    const fontScale = Math.min(1, size / 340);
    const labelFontSize = Math.round(Math.max(8, Math.min(12, 12 * fontScale)));
    const valueFontSize = Math.round(Math.max(8, Math.min(11, 11 * fontScale)));

    // ラベル余白・表示可否・切り詰めを一括で決める。
    // 端に来るラベルほど水平方向に張り出すので、cos の絶対値で重み付けした最大張り出しを取る。
    const layout = useMemo(() => {
        // 値注釈は極小パネルでは自動オフ（ホバー時のみだが小さいと潰れるため）
        const showValueLabels = opts.showValueLabels && size >= 200;

        if (!opts.showAxisLabels) {
            return { showAxisLabels: false, showValueLabels, labelPad: 14, fitLabels: axisLabels };
        }

        // 各軸ラベルの水平張り出し（推定幅 × |cos|）の最大値を必要余白とする
        let maxOut = 0;
        angles.forEach((a, i) => {
            const cos = Math.abs(Math.cos((a * Math.PI) / 180));
            maxOut = Math.max(maxOut, estimateTextWidth(axisLabels[i], labelFontSize) * cos);
        });
        // 必要幅ぶん確保しつつ、リングが痩せすぎないよう面積の 30% で頭打ち。
        // 下限は文字1つ分程度（極小でも 12px は確保）まで下げ、28px 固定床はやめる。
        let labelPad = Math.min(Math.max(size * 0.16, labelFontSize + 4, maxOut + 10), size * 0.3);
        let radius = size / 2 - labelPad;
        let showAxisLabels = true;

        // ラベルを確保するとリングが小さくなりすぎる → ラベルを諦めてリング優先
        // （軸名は title 属性のツールチップで確認できる）
        if (radius < size * 0.28) {
            showAxisLabels = false;
            labelPad = 12;
            radius = size / 2 - labelPad;
        }

        // 端ラベルが SVG 端で見切れないよう、確保した余白に収まる幅へ切り詰める。
        // labelPos は radius + labelPad*0.42 に置くので、端側で使える幅は labelPad の残り。
        const availPx = Math.max(labelPad * 0.9, labelFontSize * 1.5);
        const fitLabels = showAxisLabels
            ? axisLabels.map((t, i) => {
                  const cos = Math.abs(Math.cos((angles[i] * Math.PI) / 180));
                  // 上下（cos≈0）は張り出さないので切り詰め不要、端ほど厳しく
                  return cos > 0.25 ? fitText(t, labelFontSize, availPx) : t;
              })
            : axisLabels;

        return { showAxisLabels, showValueLabels, labelPad, fitLabels };
    }, [opts.showAxisLabels, opts.showValueLabels, angles, axisLabels, size, labelFontSize]);

    const { showAxisLabels, showValueLabels, labelPad, fitLabels } = layout;

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(10, size / 2 - labelPad);

    // 値 → 半径比（0..1）。共通スケール or 軸ごと個別スケール。
    const ratioFor = (axisIndex, value) => {
        const denom = opts.sharedScale ? globalMax : perAxisMax[axisIndex];
        if (!Number.isFinite(denom) || denom <= 0) return 0;
        return Math.max(0, Math.min(1, value / denom));
    };

    if (axisCount < 3) {
        // レーダーは 3 軸以上（3 行以上）ないと形にならない
        return null;
    }

    // 最終退避: ラベルを消してもリングがまともに描けない極小サイズは
    // 壊れたチャートより「too small」メッセージを出す（chord-flow と同じ最後の砦）。
    if (radius < 24) {
        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
                <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={Math.max(9, Math.min(12, size / 12))}
                    fill={palette.axisLabel}
                >
                    パネルが小さすぎます
                </text>
            </svg>
        );
    }

    // グリッド（同心多角形のリング）
    const ringPolygons = [];
    for (let ring = 1; ring <= opts.rings; ring += 1) {
        const rr = radius * (ring / opts.rings);
        const pts = angles.map((a) => polar(cx, cy, rr, a));
        ringPolygons.push({
            key: ring,
            points: pts.map((p) => `${p.x},${p.y}`).join(' '),
            strong: ring === opts.rings,
        });
    }

    // 各軸のスポーク（中心 → 頂点）とラベル位置・アンカー
    // 端ラベルは切り詰め済みだが、念のため位置を SVG 内側 [pad, width-pad] にクランプして
    // 左右端での見切れを防ぐ（title に完全名を持たせるのでツールチップで全文確認できる）。
    const edgePad = 2;
    const spokes = angles.map((a, i) => {
        const outer = polar(cx, cy, radius, a);
        const raw = polar(cx, cy, radius + labelPad * 0.42, a);
        const cos = Math.cos((a * Math.PI) / 180);
        let anchor = 'middle';
        if (cos > 0.25) anchor = 'start';
        else if (cos < -0.25) anchor = 'end';
        const labelPos = {
            x: Math.max(edgePad, Math.min(width - edgePad, raw.x)),
            y: Math.max(edgePad, Math.min(height - edgePad, raw.y)),
        };
        return { outer, labelPos, anchor, label: fitLabels[i], fullLabel: axisLabels[i] };
    });

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ display: 'block' }}
            role="img"
        >
            {opts.glow && (
                <defs>
                    <filter id="radar-glow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>
            )}

            {/* グリッド（リング） */}
            {ringPolygons.map((ring) => (
                <polygon
                    key={`ring-${ring.key}`}
                    points={ring.points}
                    fill="none"
                    stroke={ring.strong ? palette.gridStrong : palette.grid}
                    strokeWidth={1}
                />
            ))}

            {/* スポーク */}
            {spokes.map((sp, i) => (
                <line
                    key={`spoke-${i}`}
                    x1={cx}
                    y1={cy}
                    x2={sp.outer.x}
                    y2={sp.outer.y}
                    stroke={palette.spoke}
                    strokeWidth={1}
                />
            ))}

            {/* 系列ポリゴン */}
            {series.map((ser, sIndex) => {
                const color = opts.colors[sIndex] || DEFAULT_SERIES_COLORS[sIndex % MAX_SERIES];
                const isHover = hovered === sIndex;
                const dimmed = hovered !== null && !isHover;

                const points = ser.values.map((v, axisIndex) => {
                    const r = mounted ? radius * ratioFor(axisIndex, v) : 0;
                    return polar(cx, cy, r, angles[axisIndex]);
                });
                const pointsStr = points.map((p) => `${p.x},${p.y}`).join(' ');

                return (
                    <g
                        key={`series-${sIndex}`}
                        style={{
                            opacity: dimmed ? 0.22 : 1,
                            transition: 'opacity 200ms ease',
                            cursor: 'pointer',
                        }}
                        filter={opts.glow ? 'url(#radar-glow)' : undefined}
                        onMouseEnter={() => setHovered(sIndex)}
                        onMouseLeave={() => setHovered(null)}
                    >
                        <polygon
                            points={pointsStr}
                            fill={hexToRgba(
                                color,
                                (opts.fillOpacity / 100) * (isHover ? 1.5 : 1)
                            )}
                            stroke={color}
                            strokeWidth={isHover ? opts.strokeWidth + 1 : opts.strokeWidth}
                            strokeLinejoin="round"
                            style={{
                                transition:
                                    'fill 200ms ease, stroke-width 150ms ease, points 700ms cubic-bezier(0.22, 1, 0.36, 1)',
                            }}
                        />
                        {opts.showDots &&
                            points.map((p, axisIndex) => (
                                <circle
                                    key={`dot-${sIndex}-${axisIndex}`}
                                    cx={p.x}
                                    cy={p.y}
                                    r={isHover ? opts.strokeWidth + 2 : opts.strokeWidth + 1}
                                    fill={color}
                                    style={{
                                        transition: 'cx 700ms cubic-bezier(0.22, 1, 0.36, 1), cy 700ms cubic-bezier(0.22, 1, 0.36, 1)',
                                    }}
                                />
                            ))}
                        {showValueLabels &&
                            isHover &&
                            points.map((p, axisIndex) => (
                                <text
                                    key={`val-${sIndex}-${axisIndex}`}
                                    x={p.x}
                                    // 上端で見切れないよう y を最小 valueFontSize にクランプ
                                    y={Math.max(valueFontSize, p.y - 9)}
                                    textAnchor="middle"
                                    fontSize={valueFontSize}
                                    fontWeight={700}
                                    fill={palette.valueLabel}
                                    stroke={palette.valueHalo}
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                    style={{ pointerEvents: 'none' }}
                                >
                                    {formatValue(ser.values[axisIndex])}
                                </text>
                            ))}
                    </g>
                );
            })}

            {/* 軸ラベル（小パネルでは非表示に退避済み。切り詰め時は title で全文を出す） */}
            {showAxisLabels &&
                spokes.map((sp, i) => (
                    <text
                        key={`label-${i}`}
                        x={sp.labelPos.x}
                        y={sp.labelPos.y}
                        textAnchor={sp.anchor}
                        dominantBaseline="middle"
                        fontSize={labelFontSize}
                        fill={palette.axisLabel}
                        style={{ pointerEvents: 'none' }}
                    >
                        {/* 切り詰めたときだけ title で全文を出す（未切り詰めでは title 不要） */}
                        {sp.label !== sp.fullLabel && <title>{sp.fullLabel}</title>}
                        {sp.label}
                    </text>
                ))}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// 凡例
// ---------------------------------------------------------------------------
// small=小パネル。フォント・スウォッチ・余白を縮め、最大高さを制限して
// （溢れたらスクロール）プロット領域を食い潰さないようにする。
function Legend({ series, opts, palette, hovered, setHovered, small }) {
    const fontSize = small ? 10 : 12;
    const dot = small ? 9 : 11;
    const maxLabel = small ? 88 : 160;
    return (
        <div
            style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: small ? '3px 10px' : '6px 16px',
                justifyContent: 'center',
                padding: small ? '3px 6px 1px' : '6px 12px 2px',
                maxHeight: small ? 40 : 88,
                overflowY: 'auto',
            }}
        >
            {series.map((ser, i) => {
                const color = opts.colors[i] || DEFAULT_SERIES_COLORS[i % MAX_SERIES];
                const dimmed = hovered !== null && hovered !== i;
                return (
                    <div
                        key={`legend-${i}`}
                        onMouseEnter={() => setHovered(i)}
                        onMouseLeave={() => setHovered(null)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: small ? 5 : 7,
                            cursor: 'pointer',
                            opacity: dimmed ? 0.4 : 1,
                            transition: 'opacity 200ms ease',
                        }}
                    >
                        <span
                            style={{
                                width: dot,
                                height: dot,
                                borderRadius: 3,
                                background: color,
                                flexShrink: 0,
                                boxShadow: opts.glow ? `0 0 6px ${hexToRgba(color, 0.6)}` : 'none',
                            }}
                        />
                        <span
                            style={{
                                fontSize,
                                color: palette.legendLabel,
                                whiteSpace: 'nowrap',
                                maxWidth: maxLabel,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                            title={ser.name}
                        >
                            {ser.name}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// デバッグダンプ（options / データ形状を確認する。dynamicColor/columnSelector が
// 実際に何を渡してくるかの切り分けに使う）
// ---------------------------------------------------------------------------
function DebugPanel({ options, model, fieldNames, palette }) {
    const info = {
        fields: fieldNames,
        axisIdx: model.axisIdx,
        seriesCols: model.seriesCols,
        axisCount: model.axisLabels.length,
        seriesCount: model.series.length,
        rawOptions: options,
    };
    return (
        <pre
            style={{
                margin: 0,
                padding: '6px 12px',
                fontSize: 10,
                lineHeight: 1.35,
                color: palette.debugText,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 120,
                overflow: 'auto',
                flex: '0 0 auto',
            }}
        >
            {JSON.stringify(info, null, 1)}
        </pre>
    );
}

// ---------------------------------------------------------------------------
// レイアウト（チャート + 凡例）。コンテナ実寸を測って SVG を描く。
// ---------------------------------------------------------------------------
function RadarChartLayout({ model, opts, mode, options, fieldNames }) {
    const palette = PALETTES[mode] || PALETTES.dark;
    const [hovered, setHovered] = useState(null);
    const [box, setBox] = useState({ width: 0, height: 0 });

    // ResizeObserver でコンテナサイズを購読（無い環境でも初回計測でフォールバック）
    const [node, setNode] = useState(null);
    useEffect(() => {
        if (!node) return undefined;
        const measure = () => setBox({ width: node.clientWidth, height: node.clientHeight });
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(node);
        return () => ro.disconnect();
    }, [node]);

    if (model.axisLabels.length === 0 || model.series.length === 0) {
        return <MessageState text="No data available" />;
    }
    if (model.axisLabels.length < 3) {
        return <MessageState text="Radar chart needs at least 3 axes (rows)." />;
    }

    // 小パネル判定（測ったプロット領域の短辺基準）。小さいときは
    // コンテナ余白を詰め、凡例を縮小、極端に低い panel では凡例を隠して
    // プロットに高さを譲る（凡例は最後に犠牲にする）。
    const small = box.width > 0 && Math.min(box.width, box.height) < 220;
    const legendFits = box.height >= 120; // これ未満は凡例を出すとプロットが潰れる

    return (
        <div
            className="viz-container"
            style={{ padding: small ? 4 : 12, display: 'flex', flexDirection: 'column' }}
        >
            <div
                ref={setNode}
                style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative' }}
            >
                {box.width > 0 && box.height > 0 && (
                    <RadarSvg
                        model={model}
                        opts={opts}
                        palette={palette}
                        width={box.width}
                        height={box.height}
                        hovered={hovered}
                        setHovered={setHovered}
                    />
                )}
            </div>
            {opts.showLegend && legendFits && (
                <div style={{ flex: '0 0 auto' }}>
                    <Legend
                        series={model.series}
                        opts={opts}
                        palette={palette}
                        hovered={hovered}
                        setHovered={setHovered}
                        small={small}
                    />
                </div>
            )}
            {opts.debug && (
                <DebugPanel
                    options={options}
                    model={model}
                    fieldNames={fieldNames}
                    palette={palette}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース + オプション接続
// ---------------------------------------------------------------------------
function RadarChartVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();

    const data = dataSources?.primary?.data || null;
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const model = useMemo(() => buildRadarData(rows, fieldNames, opts), [rows, fieldNames, opts]);

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <MessageState text="No data available" />;

    return (
        <RadarChartLayout
            model={model}
            opts={opts}
            mode={mode}
            options={options}
            fieldNames={fieldNames}
        />
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きルート
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// ---------------------------------------------------------------------------
function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    const mode = colorScheme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <RadarChartVisualization mode={mode} />
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
