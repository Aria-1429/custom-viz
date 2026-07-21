import {
    VisualizationExtensionProvider,
    useDataSources,
    useOptions,
    useTheme,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import Select from '@splunk/react-ui/Select';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { feature } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import './visualization.css';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
// よく使われるSeverity名 → オプションキーとデフォルト色の対応
// （それ以外のSeverityは登場順に extraColor1..4 が割り当てられる）
const KNOWN_COLOR_KEYS = {
    high: ['highColor', '#ff5a2e'],
    medium: ['mediumColor', '#e6b93c'],
    low: ['lowColor', '#38a6ff'],
};
// High/Medium/Low 以外のSeverityに登場順で割り当てる色（オプションで変更可能）
const EXTRA_COLOR_DEFAULTS = ['#b17aff', '#2dd4bf', '#ff7ab8', '#9aa7b8'];
// 凡例・フィルタ・ホットスポット優先度の並び順（既知のものを先頭に、他は登場順）
const KNOWN_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

// 弧を流れる光の筋（パス長を1に正規化した値）
const STREAK_LEN = 0.3; // 筋の長さ（パス全体の30%）

// ライト/ダークモード別の地図配色
const MAP_PALETTES = {
    dark: {
        containerBg: '#03080f',
        bgStops: [
            { offset: '0%', color: '#0a1a33' },
            { offset: '60%', color: '#061224' },
            { offset: '100%', color: '#03080f' },
        ],
        landGlow: '#1d5aa8',
        landGlowOpacity: 0.4,
        landFill: '#0d2b52',
        landStroke: '#3d84d6',
        landStrokeOpacity: 0.35,
        titleColor: '#f2f6fb',
        titleShadow: '0 0 14px rgba(60, 140, 255, 0.6)',
        panelBg: 'rgba(10, 24, 46, 0.85)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendBg: 'rgba(10, 24, 46, 0.75)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.25)',
        legendText: '#e8eef6',
    },
    light: {
        containerBg: '#dde7f2',
        bgStops: [
            { offset: '0%', color: '#f6fafe' },
            { offset: '60%', color: '#e9f0f8' },
            { offset: '100%', color: '#dde7f2' },
        ],
        landGlow: '#9db8d8',
        landGlowOpacity: 0.35,
        landFill: '#c3d4e6',
        landStroke: '#6f96c2',
        landStrokeOpacity: 0.6,
        titleColor: '#16283e',
        titleShadow: '0 0 10px rgba(255, 255, 255, 0.8)',
        panelBg: 'rgba(255, 255, 255, 0.88)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.45)',
        legendBg: 'rgba(255, 255, 255, 0.82)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendText: '#24354a',
    },
};

// ---------------------------------------------------------------------------
// 色ユーティリティ
// （ユーザーが設定した線の色から、ホットスポットのグローと中心点の色を導出する）
// Splunkのカラーピッカーは "transparent" やアルファ付きhex（#RRGGBBAA）を
// 返すことがあるため、{r, g, b, a} に正規化して扱う
// ---------------------------------------------------------------------------
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// 色文字列を {r, g, b, a} へ変換。解釈できない値は null
function parseColor(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (!HEX_RE.test(v)) return null;
    let h = v.slice(1);
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
}

function toCss({ r, g, b, a }) {
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

// 白と混ぜて明るいトーンを作る（amount: 0=元の色, 1=白）。アルファは維持
function tint(c, amount) {
    const mix = (v) => Math.round(v + (255 - v) * amount);
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// 黒と混ぜて暗いトーンを作る（amount: 0=元の色, 1=黒）。アルファは維持
function shade(c, amount) {
    const mix = (v) => Math.round(v * (1 - amount));
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// ---------------------------------------------------------------------------
// 世界地図（ビルド時にバンドルされるため実行時のインターネット通信は不要）
// ---------------------------------------------------------------------------
const WORLD = (() => {
    try {
        const geo = feature(worldTopo, worldTopo.objects.countries);
        geo.features = geo.features.filter((f) => f?.properties?.name !== 'Antarctica');
        return geo;
    } catch (e) {
        return null;
    }
})();

// ---------------------------------------------------------------------------
// オプション正規化（未設定・型不一致でも安全側に倒す）
// ---------------------------------------------------------------------------
function normalizeOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    return {
        showTitle: bool(o.showTitle, true),
        titleText:
            typeof o.titleText === 'string' && o.titleText.trim() !== ''
                ? o.titleText
                : 'GLOBAL THREAT MAP',
        showLegend: bool(o.showLegend, true),
        showFilter: bool(o.showFilter, true),
        // 光の筋がパスを走り切る秒数。0 でアニメーション停止（静的表示）
        animDuration: Math.min(Math.max(num(o.animDuration, 2.8), 0), 60),
        // フィールド選択（editor.columnSelector）。未設定は名前ベースの自動判定
        srcLatField: o.srcLatField,
        srcLonField: o.srcLonField,
        dstLatField: o.dstLatField,
        dstLonField: o.dstLonField,
        severityField: o.severityField,
        countField: o.countField,
        srcNameField: o.srcNameField,
        dstNameField: o.dstNameField,
    };
}

// ---------------------------------------------------------------------------
// データ処理ユーティリティ
// ---------------------------------------------------------------------------
function normalizeData(data) {
    if (data.rows && data.rows.length > 0) return data.rows;
    if (data.columns && data.columns.length > 0) {
        const numRows = data.columns[0].length;
        return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
    }
    return [];
}

function findFieldIndex(fieldNames, candidates) {
    return fieldNames.findIndex((name) => candidates.includes(String(name).toLowerCase()));
}

/**
 * editor.columnSelector の選択値を列インデックスへ解決する。
 * カスタムvizには DOS 文字列（"> primary | seriesByName('x')"）が未解決のまま
 * 届くため自前でパースする。以下すべてを受けて壊れない:
 * - 未設定/空文字 → fallbackIdx（名前ベースの自動判定結果）
 * - DOS 文字列 → seriesByName / seriesByIndex を正規表現で解決
 * - 生フィールド名 → そのまま照合
 * - ホスト解決済みの列データ（配列）→ 先頭数行を各列と照合して特定
 */
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
            return fallbackIdx; // 解釈できない DOS はデフォルト列に退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

/**
 * サーチ結果を脅威レコードの配列へ変換する。
 * 列の決定: editor.columnSelector の選択が最優先。未設定の列は
 * フィールド名の候補リスト（src_lat 等）で自動判定する。
 * 必須: 起点/終点の緯度経度4列。任意: severity, count, 表示名2列。
 * Severityはサーチ結果の値をそのまま使う（大文字小文字は同一視し、
 * 最初に登場した表記を代表とする）。値が無い行は "Low" 扱い。
 */
function parseThreats(fieldNames, rows, opts) {
    const lower = fieldNames.map((f) => String(f).toLowerCase());
    const auto = {
        srcLat: findFieldIndex(lower, ['src_lat', 'source_lat', 'slat']),
        srcLon: findFieldIndex(lower, ['src_lon', 'src_lng', 'source_lon', 'slon']),
        dstLat: findFieldIndex(lower, ['dst_lat', 'dest_lat', 'target_lat', 'dlat']),
        dstLon: findFieldIndex(lower, ['dst_lon', 'dst_lng', 'dest_lon', 'target_lon', 'dlon']),
        sev: findFieldIndex(lower, ['severity', 'threat_level', 'level']),
        count: findFieldIndex(lower, ['count', 'events', 'total']),
        srcName: findFieldIndex(lower, ['src_name', 'src', 'source']),
        dstName: findFieldIndex(lower, ['dst_name', 'dst', 'dest', 'target']),
    };
    const iSrcLat = resolveFieldIndex(opts.srcLatField, fieldNames, rows, auto.srcLat);
    const iSrcLon = resolveFieldIndex(opts.srcLonField, fieldNames, rows, auto.srcLon);
    const iDstLat = resolveFieldIndex(opts.dstLatField, fieldNames, rows, auto.dstLat);
    const iDstLon = resolveFieldIndex(opts.dstLonField, fieldNames, rows, auto.dstLon);
    const iSev = resolveFieldIndex(opts.severityField, fieldNames, rows, auto.sev);
    const iCount = resolveFieldIndex(opts.countField, fieldNames, rows, auto.count);
    const iSrcName = resolveFieldIndex(opts.srcNameField, fieldNames, rows, auto.srcName);
    const iDstName = resolveFieldIndex(opts.dstNameField, fieldNames, rows, auto.dstName);

    if (iSrcLat < 0 || iSrcLon < 0 || iDstLat < 0 || iDstLon < 0) {
        return { threats: [], missingFields: true };
    }

    // 大文字小文字違い（high / High / HIGH）を同一Severityに束ねる
    const sevCanon = new Map();
    const toSeverity = (raw) => {
        const s = String(raw ?? '').trim() || 'Low';
        const key = s.toLowerCase();
        if (!sevCanon.has(key)) sevCanon.set(key, s);
        return sevCanon.get(key);
    };

    const threats = [];
    rows.forEach((row, i) => {
        const srcLat = parseFloat(row[iSrcLat]);
        const srcLon = parseFloat(row[iSrcLon]);
        const dstLat = parseFloat(row[iDstLat]);
        const dstLon = parseFloat(row[iDstLon]);
        if (![srcLat, srcLon, dstLat, dstLon].every(Number.isFinite)) return;
        if (Math.abs(srcLat) > 90 || Math.abs(dstLat) > 90) return;
        threats.push({
            id: i,
            srcLat,
            srcLon,
            dstLat,
            dstLon,
            severity: toSeverity(iSev >= 0 ? row[iSev] : 'Low'),
            count: iCount >= 0 ? parseFloat(row[iCount]) || 1 : 1,
            srcName: iSrcName >= 0 ? String(row[iSrcName] ?? '') : '',
            dstName: iDstName >= 0 ? String(row[iDstName] ?? '') : '',
        });
    });
    return { threats, missingFields: false };
}

/**
 * サーチ結果に登場したSeverityの一覧（表示順）と色の割り当てを作る。
 * - 並び順: Critical, High, Medium, Low（存在するもののみ）→ その他は登場順
 * - 色: High/Medium/Low は専用オプション、その他は extraColor1..4 を登場順に
 *   割り当て（5種類以上は循環）
 */
function buildSeverityModel(threats, options) {
    const seen = [];
    threats.forEach((t) => {
        if (!seen.includes(t.severity)) seen.push(t.severity);
    });
    const known = KNOWN_SEVERITY_ORDER
        .map((k) => seen.find((s) => s.toLowerCase() === k))
        .filter((s) => s !== undefined);
    const others = seen.filter((s) => !known.includes(s));
    const severityList = [...known, ...others];

    const severityColors = {};
    let extraIdx = 0;
    severityList.forEach((sev) => {
        const knownEntry = KNOWN_COLOR_KEYS[sev.toLowerCase()];
        if (knownEntry) {
            severityColors[sev] =
                parseColor(options?.[knownEntry[0]]) || parseColor(knownEntry[1]);
        } else {
            const slot = extraIdx % EXTRA_COLOR_DEFAULTS.length;
            severityColors[sev] =
                parseColor(options?.[`extraColor${slot + 1}`]) ||
                parseColor(EXTRA_COLOR_DEFAULTS[slot]);
            extraIdx += 1;
        }
    });
    return { severityList, severityColors };
}

// 弧（ベジェ曲線）のパスを生成
function arcPath(sx, sy, tx, ty) {
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    const nx = -dy / dist;
    const ny = dx / dist;
    const bend = dist * 0.22;
    const dir = ny < 0 ? 1 : -1;
    const cx = mx + nx * bend * dir;
    const cy = my + ny * bend * dir - dist * 0.12;
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

// ツールチップ用の地点表記（名前が無ければ緯度経度で代替）
function pointLabel(name, lat, lon) {
    return name || `${lat.toFixed(1)}, ${lon.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// コンテナの実サイズを監視するフック
// （地図をパネル全体にフィットさせるため）
// ---------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w > 0 && h > 0) {
                setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
            }
        };
        update();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return [ref, size];
}

// ---------------------------------------------------------------------------
// 表示ステート
// ---------------------------------------------------------------------------
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function MessageState({ message }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <Paragraph>{message}</Paragraph>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// マップ本体
// ---------------------------------------------------------------------------
function ThreatMap({ threats, mode, severityList, severityColors, customBg, customLand, opts }) {
    const [severityFilter, setSeverityFilter] = useState('all');
    const [containerRef, size] = useContainerSize();
    const palette = MAP_PALETTES[mode] || MAP_PALETTES.dark;

    // アニメーション: animDuration=0 で停止（静的表示）
    const animOn = opts.animDuration > 0;
    const streakDur = `${opts.animDuration}s`;

    // サーチ結果が変わってフィルタ中のSeverityが消えた場合は全件表示に戻す
    const effectiveFilter =
        severityFilter === 'all' || severityList.includes(severityFilter)
            ? severityFilter
            : 'all';

    // Severity → 表示順index（グラデーションIDとホットスポットの優先度に使う）
    const sevIndex = useMemo(
        () => Object.fromEntries(severityList.map((s, i) => [s, i])),
        [severityList]
    );

    // 背景: カスタム背景色が有効なら、その色からグラデーションを生成して
    // テーマ配色を上書きする（中心をやや明るく・外周をやや暗く）
    // 完全透過（transparent / アルファ0）の場合はグラデーションを描かず、
    // ダッシュボードのパネル背景をそのまま透かす
    const background = useMemo(() => {
        if (!customBg) {
            return { containerBg: palette.containerBg, bgStops: palette.bgStops };
        }
        if (customBg.a === 0) {
            return { containerBg: 'transparent', bgStops: null };
        }
        return {
            containerBg: toCss(shade(customBg, 0.4)),
            bgStops: [
                { offset: '0%', color: toCss(tint(customBg, 0.12)) },
                { offset: '60%', color: toCss(customBg) },
                { offset: '100%', color: toCss(shade(customBg, 0.4)) },
            ],
        };
    }, [customBg, palette]);

    // 陸地: カスタム陸地色が有効なら、縁取りとグローもその色から導出する。
    // 完全透過の場合は陸地を描画しない
    const land = useMemo(() => {
        if (!customLand) {
            return {
                visible: true,
                glow: palette.landGlow,
                glowOpacity: palette.landGlowOpacity,
                fill: palette.landFill,
                stroke: palette.landStroke,
                strokeOpacity: palette.landStrokeOpacity,
            };
        }
        if (customLand.a === 0) {
            return { visible: false };
        }
        return {
            visible: true,
            glow: toCss(tint(customLand, 0.25)),
            glowOpacity: palette.landGlowOpacity,
            fill: toCss(customLand),
            stroke: toCss(tint(customLand, 0.4)),
            strokeOpacity: 0.5,
        };
    }, [customLand, palette]);

    // 線の色から導出する派生色（ホットスポットの中心点・グロー）
    const derived = useMemo(() => {
        const out = {};
        severityList.forEach((sev) => {
            const base = severityColors[sev];
            out[sev] = {
                css: toCss(base),
                core: toCss(tint(base, 0.72)),
                glowInner: toCss(tint(base, 0.55)),
                glowMid: toCss(tint(base, 0.2)),
            };
        });
        return out;
    }, [severityList, severityColors]);

    // パネルの実サイズに合わせて投影を計算（全面に描画）
    const geo = useMemo(() => {
        if (!WORLD || !size) return null;
        try {
            const projection = geoNaturalEarth1().fitExtent(
                [[8, 8], [size.w - 8, size.h - 8]],
                WORLD
            );
            const path = geoPath(projection);
            return {
                projection,
                landPath: WORLD.features.map((f) => path(f)).join(' '),
            };
        } catch (e) {
            return null;
        }
    }, [size]);

    // 座標を投影し、フィルタを適用
    const projected = useMemo(() => {
        if (!geo) return [];
        return threats
            .map((t) => {
                const s = geo.projection([t.srcLon, t.srcLat]);
                const d = geo.projection([t.dstLon, t.dstLat]);
                if (!s || !d || ![...s, ...d].every(Number.isFinite)) return null;
                return { ...t, sx: s[0], sy: s[1], tx: d[0], ty: d[1] };
            })
            .filter(Boolean);
    }, [geo, threats]);

    const visible = useMemo(
        () =>
            effectiveFilter === 'all'
                ? projected
                : projected.filter((t) => t.severity === effectiveFilter),
        [projected, effectiveFilter]
    );

    // 攻撃元・攻撃先のホットスポット
    // 重複除去 + 同一地点に複数Severityの線がある場合は最も緊急度の高い
    // （表示順が先の）色を採用。表示名は最初に見つかった非空のものを使う
    const { sources, targets } = useMemo(() => {
        const srcMap = new Map();
        const dstMap = new Map();
        const merge = (map, key, x, y, count, severity, name) => {
            if (!map.has(key)) map.set(key, { x, y, count: 0, severity, name: '' });
            const entry = map.get(key);
            entry.count += count;
            if (!entry.name && name) entry.name = name;
            if ((sevIndex[severity] ?? 0) < (sevIndex[entry.severity] ?? 0)) {
                entry.severity = severity;
            }
        };
        visible.forEach((t) => {
            merge(srcMap, `${t.sx.toFixed(1)},${t.sy.toFixed(1)}`, t.sx, t.sy, t.count, t.severity, t.srcName);
            merge(dstMap, `${t.tx.toFixed(1)},${t.ty.toFixed(1)}`, t.tx, t.ty, t.count, t.severity, t.dstName);
        });
        return { sources: [...srcMap.values()], targets: [...dstMap.values()] };
    }, [visible, sevIndex]);

    // パネル実サイズに応じたオーバーレイのレイアウト計算
    // （小パネルで文字がはみ出したり要素同士が重ならないよう、
    //   サイズに合わせて縮小・非表示・コンパクト化する）
    const overlay = useMemo(() => {
        // size 未計測時は通常サイズ相当のフォールバックを使う
        const w = size ? size.w : 900;
        const h = size ? size.h : 500;

        // フィルタは右上に出るので、狭幅では非表示にしてタイトルと衝突させない
        const showFilter = opts.showFilter && w >= 220;
        // タイトルは幅が狭い / フィルタと重なる恐れがある場合に隠す
        //  - w<260 では横幅不足で隠す
        //  - フィルタ表示中かつ w<420 では上部バンドで重なるため隠す
        const showTitle =
            opts.showTitle && w >= 260 && !(showFilter && w < 420);
        // 凡例は極端に小さいパネルでは隠す。中間サイズでは横並びのコンパクト表示
        const showLegend = opts.showLegend && w >= 200 && h >= 140;
        const legendCompact = w < 360 || h < 240;

        // タイトルのフォントは幅に応じて 22px→12px にクランプ
        const titleFont = Math.max(12, Math.min(22, Math.round(w * 0.028)));
        // タイトルの最大横幅（パネル幅から左右余白と右側フィルタ分を差し引く）
        const titleMaxW = Math.max(60, w - 40 - (showFilter ? 120 : 0));

        // 凡例のスケール（コンパクト時は詰める）
        const legPad = legendCompact ? '5px 8px' : '10px 16px';
        const legGap = legendCompact ? 6 : 8;
        const legRowGap = legendCompact ? 4 : 8;
        const legFont = legendCompact ? 11 : 14;
        const legSwatchW = legendCompact ? 14 : 22;
        const legSwatchH = legendCompact ? 4 : 5;
        // 幅が狭いときは凡例内の各行も横並びに（縦積みだと縦に長くなり地図に被る）
        const legDir = w < 300 ? 'row' : 'column';

        return {
            showFilter,
            showTitle,
            showLegend,
            titleFont,
            titleMaxW,
            legPad,
            legGap,
            legRowGap,
            legFont,
            legSwatchW,
            legSwatchH,
            legDir,
        };
    }, [size, opts.showTitle, opts.showFilter, opts.showLegend]);

    return (
        <div
            ref={containerRef}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                minHeight: 200,
                background: background.containerBg,
                overflow: 'hidden',
                fontFamily:
                    'Splunk Platform Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
            }}
        >
            {geo && size && (
                <svg
                    viewBox={`0 0 ${size.w} ${size.h}`}
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                >
                    <defs>
                        {background.bgStops && (
                            <radialGradient id="gtm-bg" cx="50%" cy="42%" r="75%">
                                {background.bgStops.map((s) => (
                                    <stop key={s.offset} offset={s.offset} stopColor={s.color} />
                                ))}
                            </radialGradient>
                        )}
                        {/* Severity別のホットスポットグロー（線の色から導出・動的） */}
                        {severityList.map((sev, i) => (
                            <radialGradient key={sev} id={`gtm-hot-${i}`}>
                                <stop
                                    offset="0%"
                                    stopColor={derived[sev].glowInner}
                                    stopOpacity="0.95"
                                />
                                <stop
                                    offset="30%"
                                    stopColor={derived[sev].glowMid}
                                    stopOpacity="0.5"
                                />
                                <stop
                                    offset="70%"
                                    stopColor={derived[sev].css}
                                    stopOpacity="0.17"
                                />
                                <stop offset="100%" stopColor={derived[sev].css} stopOpacity="0" />
                            </radialGradient>
                        ))}
                        <filter id="gtm-land-blur" x="-10%" y="-10%" width="120%" height="120%">
                            <feGaussianBlur stdDeviation="7" />
                        </filter>
                        <filter id="gtm-soft-blur" x="-20%" y="-20%" width="140%" height="140%">
                            <feGaussianBlur stdDeviation="2.5" />
                        </filter>
                    </defs>

                    {/* 背景（完全透過時は描画しない） */}
                    {background.bgStops && (
                        <rect width={size.w} height={size.h} fill="url(#gtm-bg)" />
                    )}

                    {/* 大陸（グロー層 + 本体。完全透過時は描画しない） */}
                    {land.visible && (
                        <>
                            <path
                                d={geo.landPath}
                                fill={land.glow}
                                opacity={land.glowOpacity}
                                filter="url(#gtm-land-blur)"
                            />
                            <path
                                d={geo.landPath}
                                fill={land.fill}
                                stroke={land.stroke}
                                strokeWidth="0.5"
                                strokeOpacity={land.strokeOpacity}
                            />
                        </>
                    )}

                    {/* 攻撃元ホットスポット（脈動アニメーション付き・線の色に対応） */}
                    {sources.map((s, i) => {
                        const base = Math.min(26 + Math.sqrt(s.count) * 1.5, 44);
                        return (
                            <g key={`src-${i}`}>
                                <title>
                                    {`Source: ${s.name || 'unknown'} (${s.severity}, count ${s.count})`}
                                </title>
                                <circle
                                    cx={s.x}
                                    cy={s.y}
                                    r={base}
                                    fill={`url(#gtm-hot-${sevIndex[s.severity] ?? 0})`}
                                >
                                    {animOn && (
                                        <animate
                                            attributeName="r"
                                            values={`${base};${base * 1.3};${base}`}
                                            dur="3s"
                                            begin={`${(i % 5) * 0.5}s`}
                                            repeatCount="indefinite"
                                        />
                                    )}
                                    {animOn && (
                                        <animate
                                            attributeName="opacity"
                                            values="1;0.6;1"
                                            dur="3s"
                                            begin={`${(i % 5) * 0.5}s`}
                                            repeatCount="indefinite"
                                        />
                                    )}
                                </circle>
                                <circle
                                    cx={s.x}
                                    cy={s.y}
                                    r="3"
                                    fill={derived[s.severity]?.core}
                                />
                            </g>
                        );
                    })}

                    {/* 攻撃先（線の色に対応） */}
                    {targets.map((t, i) => (
                        <g key={`dst-${i}`}>
                            <title>
                                {`Target: ${t.name || 'unknown'} (${t.severity}, count ${t.count})`}
                            </title>
                            <circle
                                cx={t.x}
                                cy={t.y}
                                r="20"
                                fill={`url(#gtm-hot-${sevIndex[t.severity] ?? 0})`}
                                opacity="0.85"
                            />
                            <circle
                                cx={t.x}
                                cy={t.y}
                                r="2.5"
                                fill={derived[t.severity]?.core}
                            />
                        </g>
                    ))}

                    {/* 攻撃の弧: 透過したベース線の上を、Severity色の線が飛んでいく */}
                    {visible.map((t) => {
                        const color = derived[t.severity]?.css || 'rgb(56, 166, 255)';
                        const d = arcPath(t.sx, t.sy, t.tx, t.ty);
                        const width = Math.min(1 + Math.sqrt(t.count) * 0.12, 2.2);
                        const tip = `${pointLabel(t.srcName, t.srcLat, t.srcLon)} → ${pointLabel(t.dstName, t.dstLat, t.dstLon)} (${t.severity}, count ${t.count})`;
                        return (
                            <g key={`arc-${t.id}`}>
                                <title>{tip}</title>
                                {/* ベース: 透過した線（うっすらとした軌道） */}
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 3}
                                    opacity="0.1"
                                    filter="url(#gtm-soft-blur)"
                                />
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width}
                                    opacity={animOn ? '0.25' : '0.7'}
                                />
                                {/*
                                  飛んでいく線（Severity色・明るい）:
                                  dasharrayの合計(1.6)をパス長(1)+筋の長さ(0.3)より大きくし、
                                  dashoffsetを 0.3 -> -1 へ線形に動かすことで、
                                  始点から現れて終点へ抜ける動きが途切れなくループする。
                                  dur/beginを全弧で共通にして、同時に出発し同時に到達させる。
                                  animDuration=0 のときは筋を描かず静的表示。
                                */}
                                {animOn && (
                                    <path
                                        d={d}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={width * 1.4}
                                        strokeLinecap="butt"
                                        pathLength="1"
                                        strokeDasharray={`${STREAK_LEN} 1.3`}
                                        opacity="1"
                                    >
                                        <animate
                                            attributeName="stroke-dashoffset"
                                            values={`${STREAK_LEN};-1`}
                                            dur={streakDur}
                                            begin="0s"
                                            calcMode="linear"
                                            repeatCount="indefinite"
                                        />
                                    </path>
                                )}
                            </g>
                        );
                    })}
                </svg>
            )}

            {/* タイトル（左上・地図の内側）
                幅に応じてフォントを縮小し、はみ出す場合は省略記号で切り詰め */}
            {overlay.showTitle && (
                <div
                    style={{
                        position: 'absolute',
                        top: 16,
                        left: 20,
                        maxWidth: overlay.titleMaxW,
                        color: palette.titleColor,
                        fontSize: overlay.titleFont,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        textShadow: palette.titleShadow,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        pointerEvents: 'none',
                        zIndex: 2,
                    }}
                >
                    {opts.titleText}
                </div>
            )}

            {/* Severityフィルタ（右上・地図の内側。サーチ結果から動的生成）
                狭幅パネルではタイトルとの衝突を避けるため非表示 */}
            {overlay.showFilter && (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 16,
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: 8,
                        padding: 4,
                        zIndex: 2,
                    }}
                >
                    <Select
                        value={effectiveFilter}
                        onChange={(e, { value }) => setSeverityFilter(value)}
                        appearance="subtle"
                    >
                        <Select.Option label="All Threats" value="all" />
                        {severityList.map((sev) => (
                            <Select.Option key={sev} label={sev} value={sev} />
                        ))}
                    </Select>
                </div>
            )}

            {/* 凡例（左下・地図の内側。サーチ結果から動的生成）
                小パネルではフォント / 余白 / スウォッチを縮小し、
                さらに狭い場合は各行も横並びにして縦方向のかさばりを抑える */}
            {overlay.showLegend && (
                <div
                    style={{
                        position: 'absolute',
                        left: 16,
                        bottom: 14,
                        maxWidth: '80%',
                        background: palette.legendBg,
                        border: palette.legendBorder,
                        borderRadius: 10,
                        padding: overlay.legPad,
                        display: 'flex',
                        flexDirection: overlay.legDir,
                        flexWrap: overlay.legDir === 'row' ? 'wrap' : 'nowrap',
                        gap: overlay.legRowGap,
                        columnGap: overlay.legDir === 'row' ? overlay.legGap + 2 : overlay.legRowGap,
                        zIndex: 2,
                    }}
                >
                    {severityList.map((sev) => (
                        <div
                            key={sev}
                            style={{ display: 'flex', alignItems: 'center', gap: overlay.legGap }}
                        >
                            <span
                                style={{
                                    width: overlay.legSwatchW,
                                    height: overlay.legSwatchH,
                                    borderRadius: 3,
                                    flexShrink: 0,
                                    background: derived[sev].css,
                                    boxShadow: `0 0 8px ${derived[sev].css}`,
                                }}
                            />
                            <span
                                style={{
                                    color: palette.legendText,
                                    fontSize: overlay.legFont,
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {sev}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function ThreatMapVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f.name || f), [data]);
    const { threats, missingFields } = useMemo(
        () => parseThreats(fieldNames, rows, opts),
        [fieldNames, rows, opts]
    );

    // サーチ結果に登場したSeverity一覧と、オプションで設定された色の割り当て
    const { severityList, severityColors } = useMemo(
        () => buildSeverityModel(threats, options),
        [threats, options]
    );

    // カスタム背景色・陸地色（各チェックボックスON時のみ有効。OFFならテーマ配色）
    const customBg = useMemo(
        () => (options?.useBgColor ? parseColor(options?.bgColor) : null),
        [options]
    );
    const customLand = useMemo(
        () => (options?.useLandColor ? parseColor(options?.landColor) : null),
        [options]
    );

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <MessageState message="No data available" />;
    if (missingFields) {
        return (
            <MessageState message="Required fields not found: src_lat, src_lon, dst_lat, dst_lon (or select fields in the editor; optional: severity, count, src_name, dst_name)" />
        );
    }
    if (threats.length === 0) {
        return <MessageState message="No valid coordinates in the search results" />;
    }

    return (
        <ThreatMap
            threats={threats}
            mode={mode}
            severityList={severityList}
            severityColors={severityColors}
            customBg={customBg}
            customLand={customLand}
            opts={opts}
        />
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きApp
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// ---------------------------------------------------------------------------
function App() {
    const themeContext = useTheme();
    const theme = themeContext?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    const colorScheme = theme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <ThreatMapVisualization mode={colorScheme} />
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
