import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
    useDimensions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// メトリック・テレイン（等角投影の疑似3D地形サーフェス）
//
// データモデル（2形式を自動判別）:
//   A. tidy/long 形式: [x, y, value] … 第1列=X軸カテゴリ, 第2列=Y軸カテゴリ, 最終列=値(高さ)。
//      同じ (x, y) セルは合算。X×Y のグリッドに敷き詰め、欠損セルは 0。
//   B. matrix 形式: [rowLabel, n1, n2, ...] … 第1列=行ラベル, 残りの数値列がそのまま格子の一行。
//      列名が X 軸、行ラベルが Y 軸になる。標準の chart / timechart 出力をそのまま食える。
//   yField が明示され「かつ」それが有効なら常に tidy 形式として扱う。
//
// デフォルト viz では到底不可能な領域:
//   - 値の大きさが「起伏の高さ」になる 3D 地形。yaw/pitch の回転行列で各セル四隅を
//     2D 投影し、ペインターズアルゴリズム（奥→手前）でSVGポリゴンとして塗る
//   - 面法線 × 光源方向のランバート反射で各面に陰影を付け、標高カラースケールと合成
//   - 地面に落ちる影、土台（側面の押し出し）、ワイヤーフレーム、頂点の発光マーカー
//   - autoRotate で地形が回転。回転中は毎フレーム全ジオメトリを再投影し、pooled な
//     polygon 要素へ points / fill / opacity を setAttribute で直接書く（React 再レンダー無し）
//
// 幾何（points/fill/opacity/表示順）は rAF ループが命令的に書く。React(JSX) は
// polygon プール本数と静的属性のみを宣言的に持つ。両者が同じ属性を触らないのが規約。
// ---------------------------------------------------------------------------

const DEFAULTS = {
    height: 100, // 起伏の高さ（%）
    yaw: 35, // 水平回転（度）
    pitch: 55, // 俯角（度、大きいほど真上から。90 で真上）
    autoRotate: true,
    rotateSpeed: 100, // 回転速度（%、0 で停止）

    lowColor: '#1b3a6b',
    midColor: '#00cdaf',
    highColor: '#ffd166',
    useMidColor: true,
    peakColor: '#ff5470',
    usePeakColor: true,
    reverse: false,

    shading: 70, // 陰影の強さ（%）
    lightAngle: 135, // 光源方位（度）
    wireframe: true,
    wireOpacity: 22, // ワイヤー不透明度（%）
    showShadow: true,
    showBase: true,
    glow: true,

    showHeader: true,
    showAxes: true,
    showLegend: true,
    showPeakMarker: true,
    debug: false,
};

const MAX_GRID = 80; // X/Y の各軸のセル数上限（大きすぎると 6400 面を超えて破綻する）
const MAX_CELLS = 3600; // 総セル上限（60x60 相当）。超えたら粗くリサンプル

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        // 想定外の形式でも落とさない
    }
    return [];
}

function parseNum(v) {
    if (v === null || v === undefined) return NaN;
    return Number(String(v).replace(/,/g, '').trim());
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isHexColor(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
}

function hexToRgb(hex) {
    let h = hex.trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const int = parseInt(h, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = clamp01(t);
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return { r, g, b: bl };
}

function rgbStr({ r, g, b }) {
    return `rgb(${r},${g},${b})`;
}

// 標高 t(0..1) → カラースケール RGB。low →(mid)→ high →(peak) を補間。
function scaleColorFor(t, opts) {
    let u = clamp01(t);
    if (opts.reverse) u = 1 - u;
    // peak を使う場合は上位 ~15% を peakColor へ寄せる
    if (opts.usePeakColor && u > 0.85) {
        const base = opts.useMidColor ? opts.highColor : opts.highColor;
        return lerpColor(base, opts.peakColor, (u - 0.85) / 0.15);
    }
    if (opts.useMidColor) {
        return u <= 0.5
            ? lerpColor(opts.lowColor, opts.midColor, u / 0.5)
            : lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

function shadeRgb(rgb, factor) {
    // factor 0..1（1 = そのまま、<1 で暗く、>1 で明るく上限クランプ）
    return {
        r: clamp(Math.round(rgb.r * factor), 0, 255),
        g: clamp(Math.round(rgb.g * factor), 0, 255),
        b: clamp(Math.round(rgb.b * factor), 0, 255),
    };
}

function isReadyTheme(cs) {
    return cs === 'light' || cs === 'dark';
}

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const bool = (key) => (o[key] === undefined ? DEFAULTS[key] : !!o[key]);
    const num = (key, lo, hi) => {
        const n = parseNum(o[key]);
        if (!Number.isFinite(n)) return DEFAULTS[key];
        return clamp(n, lo, hi);
    };
    const numOpt = (key) => {
        const n = parseNum(o[key]);
        return Number.isFinite(n) ? n : undefined;
    };
    const color = (key) => (isHexColor(o[key]) ? o[key].trim() : DEFAULTS[key]);
    return {
        height: num('height', 0, 400),
        yaw: num('yaw', -360, 360),
        pitch: num('pitch', 15, 89),
        autoRotate: bool('autoRotate'),
        rotateSpeed: num('rotateSpeed', 0, 500),

        lowColor: color('lowColor'),
        midColor: color('midColor'),
        highColor: color('highColor'),
        useMidColor: bool('useMidColor'),
        peakColor: color('peakColor'),
        usePeakColor: bool('usePeakColor'),
        reverse: bool('reverse'),
        scaleMin: numOpt('scaleMin'),
        scaleMax: numOpt('scaleMax'),

        shading: num('shading', 0, 100),
        lightAngle: num('lightAngle', 0, 360),
        wireframe: bool('wireframe'),
        wireOpacity: num('wireOpacity', 0, 100),
        showShadow: bool('showShadow'),
        showBase: bool('showBase'),
        glow: bool('glow'),

        showHeader: bool('showHeader'),
        showAxes: bool('showAxes'),
        showLegend: bool('showLegend'),
        showPeakMarker: bool('showPeakMarker'),
        debug: bool('debug'),
        // 生フィールド指定（DOS 文字列 or 名前）はそのまま持ち回る
        _xField: o.xField,
        _yField: o.yField,
        _valueField: o.valueField,
    };
}

// ---------------------------------------------------------------------------
// フィールド解決（editor.columnSelector は DOS 文字列で届く）
// ---------------------------------------------------------------------------

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

// マルチバリューセル救済用トークン化
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
            out.push(row);
            continue;
        }
        // 全カラムのトークン数が一致する行だけ平行展開して救済
        const allMatch = tokens.every((t) => t.length === 1 || t.length === L);
        if (!allMatch) {
            out.push(null); // 不一致は落とす（壊れた文字列がエンティティ名に化けるのを防ぐ）
            continue;
        }
        for (let k = 0; k < L; k += 1) {
            out.push(row.map((_, ci) => (tokens[ci].length === L ? tokens[ci][k] : tokens[ci][0])));
        }
    }
    return out.filter((r) => r !== null);
}

// ---------------------------------------------------------------------------
// グリッド構築（行 → X×Y のセル値グリッド）
// ---------------------------------------------------------------------------

function buildGrid(rows, fieldNames, opts) {
    const xi = resolveFieldIndex(opts._xField, fieldNames, rows, 0);
    const explicitY =
        opts._yField !== undefined && opts._yField !== null && opts._yField !== '';
    const yi = resolveFieldIndex(opts._yField, fieldNames, rows, 1);

    // matrix 形式の判定: yField 未指定で、列が3以上あり、第2列以降が数値中心なら matrix。
    const numericCols = fieldNames.length - 1;
    let isMatrix = false;
    if (!explicitY && numericCols >= 2) {
        // 第2列以降が数値なら matrix とみなす
        let numeric = 0;
        let total = 0;
        const sample = rows.slice(0, Math.min(rows.length, 8));
        for (const r of sample) {
            for (let c = 1; c < fieldNames.length; c += 1) {
                total += 1;
                if (Number.isFinite(parseNum(r[c]))) numeric += 1;
            }
        }
        isMatrix = total > 0 && numeric / total >= 0.6;
    }

    if (isMatrix) {
        return buildGridFromMatrix(rows, fieldNames);
    }
    return buildGridFromTidy(rows, fieldNames, xi, yi, opts);
}

// matrix 形式: 第1列=行(Y)ラベル、残り列=X（列名）、セル=値
function buildGridFromMatrix(rows, fieldNames) {
    const xLabels = fieldNames.slice(1);
    const yLabels = [];
    const values = []; // values[y][x]
    for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const yl = String(r[0] ?? '');
        yLabels.push(yl);
        const rowVals = [];
        for (let c = 1; c < fieldNames.length; c += 1) {
            const n = parseNum(r[c]);
            rowVals.push(Number.isFinite(n) ? n : 0);
        }
        values.push(rowVals);
    }
    return finalizeGrid(xLabels, yLabels, values);
}

// tidy 形式: (x, y, value) の3つ組。同じセルは合算。
function buildGridFromTidy(rows, fieldNames, xi, yi, opts) {
    // 値列: 明示指定 → それ、なければ「x,y 以外の最終列」
    let vi = resolveFieldIndex(opts._valueField, fieldNames, rows, -1);
    if (vi < 0 || vi === xi || vi === yi) {
        vi = fieldNames.length - 1;
        if (vi === xi || vi === yi) {
            // フォールバック: x,y 以外の最初の列
            for (let c = 0; c < fieldNames.length; c += 1) {
                if (c !== xi && c !== yi) {
                    vi = c;
                    break;
                }
            }
        }
    }
    const xOrder = [];
    const yOrder = [];
    const xIndex = new Map();
    const yIndex = new Map();
    const cellMap = new Map(); // "xi yi" -> value

    for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const xl = String(r[xi] ?? '');
        const yl = String(r[yi] ?? '');
        const v = parseNum(r[vi]);
        if (!Number.isFinite(v)) continue;
        if (!xIndex.has(xl)) {
            xIndex.set(xl, xOrder.length);
            xOrder.push(xl);
        }
        if (!yIndex.has(yl)) {
            yIndex.set(yl, yOrder.length);
            yOrder.push(yl);
        }
        const key = xIndex.get(xl) + ' ' + yIndex.get(yl);
        cellMap.set(key, (cellMap.get(key) || 0) + v);
    }

    const values = yOrder.map((_, y) =>
        xOrder.map((__, x) => cellMap.get(x + ' ' + y) || 0)
    );
    return finalizeGrid(xOrder, yOrder, values);
}

// グリッドをリサンプル（上限超過時）し、min/max を算出
function finalizeGrid(xLabels, yLabels, values) {
    let X = xLabels.length;
    let Y = yLabels.length;
    if (X === 0 || Y === 0) {
        return { X: 0, Y: 0, xLabels: [], yLabels: [], values: [], min: 0, max: 0, count: 0 };
    }

    // 軸あたりの上限
    let sx = 1;
    let sy = 1;
    if (X > MAX_GRID) sx = Math.ceil(X / MAX_GRID);
    if (Y > MAX_GRID) sy = Math.ceil(Y / MAX_GRID);
    // 総数上限
    while (Math.ceil(X / sx) * Math.ceil(Y / sy) > MAX_CELLS) {
        if (Math.ceil(X / sx) >= Math.ceil(Y / sy)) sx += 1;
        else sy += 1;
    }

    let outX = xLabels;
    let outY = yLabels;
    let outV = values;
    if (sx > 1 || sy > 1) {
        const nX = Math.ceil(X / sx);
        const nY = Math.ceil(Y / sy);
        outX = Array.from({ length: nX }, (_, i) => xLabels[Math.min(i * sx, X - 1)]);
        outY = Array.from({ length: nY }, (_, i) => yLabels[Math.min(i * sy, Y - 1)]);
        outV = Array.from({ length: nY }, (_, yy) =>
            Array.from({ length: nX }, (_, xx) => {
                // ブロック平均
                let sum = 0;
                let cnt = 0;
                for (let dy = 0; dy < sy; dy += 1) {
                    for (let dx = 0; dx < sx; dx += 1) {
                        const ry = yy * sy + dy;
                        const rx = xx * sx + dx;
                        if (ry < Y && rx < X) {
                            sum += values[ry][rx];
                            cnt += 1;
                        }
                    }
                }
                return cnt > 0 ? sum / cnt : 0;
            })
        );
        X = nX;
        Y = nY;
    }

    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let y = 0; y < Y; y += 1) {
        for (let x = 0; x < X; x += 1) {
            const v = outV[y][x];
            if (v < min) min = v;
            if (v > max) max = v;
            count += 1;
        }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    return { X, Y, xLabels: outX, yLabels: outY, values: outV, min, max, count, resampled: sx > 1 || sy > 1 };
}

// ---------------------------------------------------------------------------
// フォーマッタ
// ---------------------------------------------------------------------------

function fmtNum(n) {
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
}

function truncLabel(s, max) {
    if (typeof s !== 'string') s = String(s);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + '…';
}

// ---------------------------------------------------------------------------
// 3D 投影
//   セル座標系: x ∈ [-0.5, 0.5], y ∈ [-0.5, 0.5], z = 標高(0..1)*heightScale
//   yaw で xy 平面を回転 → pitch で見下ろす（z を画面 y に投影）→ 画面座標へ
// ---------------------------------------------------------------------------

function makeProjector(yawDeg, pitchDeg, scale, zLift, cx, cy) {
    const yaw = (yawDeg * Math.PI) / 180;
    const pitch = (pitchDeg * Math.PI) / 180;
    const cyaw = Math.cos(yaw);
    const syaw = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    // 戻り値: (x,y,z) → { sx, sy, depth }
    return function project(x, y, z) {
        // yaw 回転（水平面）
        const rx = x * cyaw - y * syaw;
        const ry = x * syaw + y * cyaw;
        // pitch: 上から見下ろすと ry は縦方向に潰れ（cos）、z は縦方向へ持ち上がる（sin）
        const sx = cx + rx * scale;
        const sy = cy + ry * scale * cp - z * zLift * sp;
        // depth: 手前ほど大きい。ry が大きい（手前）＋ z が高いほど手前に見える
        const depth = ry * cp + z * zLift * sp * 0.15;
        return { sx, sy, depth };
    };
}

// ---------------------------------------------------------------------------
// App ルート（テーマガード）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;
    if (!isReadyTheme(colorScheme)) return null;
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <MetricTerrain mode={mode} />
        </SplunkThemeProvider>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function MetricTerrain({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const dims = useDimensions();

    const opts = useMemo(() => normalizeOptions(options), [options]);

    // ---- データ → グリッド ---------------------------------------------------
    const primary = dataSources?.primary;
    const rawData = primary?.data;

    const grid = useMemo(() => {
        if (!rawData) return null;
        const rowsRaw = normalizeData(rawData);
        if (!rowsRaw || rowsRaw.length === 0) return null;
        const rows = expandMultivalueRows(rowsRaw);
        const fieldNames = (rawData.fields || []).map((f) => (f && f.name ? f.name : f));
        if (fieldNames.length === 0) return null;
        return buildGrid(rows, fieldNames, opts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rawData, opts._xField, opts._yField, opts._valueField]);

    // ---- コンテナ実寸（オートフィット） --------------------------------------
    const containerRef = useRef(null);
    const [box, setBox] = useState({ w: 720, h: 520 });
    const measure = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const w = el.clientWidth || 720;
        const h = el.clientHeight || 520;
        setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    }, []);
    const attachContainer = useCallback(
        (el) => {
            containerRef.current = el;
            if (el) {
                // 初回計測
                requestAnimationFrame(measure);
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(measure);
                    ro.observe(el);
                    el.__ro = ro;
                }
            }
        },
        [measure]
    );
    useEffect(() => {
        return () => {
            const el = containerRef.current;
            if (el && el.__ro) el.__ro.disconnect();
        };
    }, []);
    // dims の変化でも測り直す
    useEffect(() => {
        measure();
    }, [dims?.width, dims?.height, measure]);

    // ---- レイアウト定数（クローム適応: 小パネルでヘッダ/凡例を縮小・非表示） ----
    // 短い/狭いパネルではクロームを削って地形へ面積を回す。閾値でモードを切替。
    const isShort = box.h < 220; // 縦が短い
    const isTiny = box.h < 150; // さらに短い（凡例を落とす）
    const isNarrow = box.w < 320; // 横が狭い（Stat タイルを間引く）

    // フォント倍率（小パネルで文字を縮めてはみ出しを防ぐ）
    const uiScale = box.w < 260 || box.h < 170 ? 0.82 : 1;

    // パディングも短パネルで詰める
    const padX = isNarrow ? 10 : 18;
    const padTop = isShort ? 4 : 10;
    const padBottom = isShort ? 4 : 10;

    // ヘッダ: 短ければ低くし、極小では 1 行コンパクト表示に。表示自体は維持。
    const showHeader = opts.showHeader;
    const compactHeader = isShort; // Stat を間引き＋低背にする合図
    const headerH = showHeader ? (isTiny ? 22 : isShort ? 30 : 44) : 0;
    // 凡例: 極小パネルでは丸ごと隠して地形を確保（機能は通常サイズで維持）
    const showLegend = opts.showLegend && !isTiny;
    const legendH = showLegend ? (isShort ? 26 : 40) : 0;

    // ステージ実寸: 「実測高さ − 実際に使うクローム」から算出。
    // 過去の Math.max(80,…) の高い床が overflow の主因だったので床を大幅に下げ、
    // 短パネルでは地形が縮んで収まるようにする（クリップさせない）。
    const stageW = Math.max(60, box.w - padX * 2);
    const stageH = Math.max(40, box.h - headerH - legendH - padTop - padBottom);

    // ---- polygon プール（rAF が触る） ----------------------------------------
    // グリッドが変わったら rAF 側でプール本数を作り直す。React は <g> 群を並べるだけ。
    // rAF が読む最新状態は ref 経由（stale closure 回避）
    const stateRef = useRef({});
    stateRef.current = {
        grid,
        opts,
        mode,
        stageW,
        stageH,
        headerH,
        padTop,
    };

    // 要素プールを掴む callback ref（useCallback([]) で安定化）
    const faceGroupRef = useRef(null);
    const wireGroupRef = useRef(null);
    const baseGroupRef = useRef(null);
    const shadowGroupRef = useRef(null);
    const peakRef = useRef(null);
    const svgRef = useRef(null);

    const setFaceGroup = useCallback((el) => {
        faceGroupRef.current = el;
    }, []);
    const setWireGroup = useCallback((el) => {
        wireGroupRef.current = el;
    }, []);
    const setBaseGroup = useCallback((el) => {
        baseGroupRef.current = el;
    }, []);
    const setShadowGroup = useCallback((el) => {
        shadowGroupRef.current = el;
    }, []);
    const setPeak = useCallback((el) => {
        peakRef.current = el;
    }, []);

    // yaw アニメーション用（回転角の連続値）。opts.yaw を基準に加算していく。
    const spinRef = useRef(0);
    const rafRef = useRef(0);
    const lastTsRef = useRef(0);

    // ---- rAF ループ（マウント時に1回だけ） -----------------------------------
    useEffect(() => {
        const SVGNS = 'http://www.w3.org/2000/svg';

        function ensurePool(group, count, tag, cls) {
            if (!group) return [];
            // 既存本数を合わせる
            let els = group.__pool;
            if (!els || els.length !== count) {
                while (group.firstChild) group.removeChild(group.firstChild);
                els = [];
                for (let i = 0; i < count; i += 1) {
                    const e = document.createElementNS(SVGNS, tag);
                    if (cls) e.setAttribute('class', cls);
                    group.appendChild(e);
                    els.push(e);
                }
                group.__pool = els;
            }
            return els;
        }

        function frame(ts) {
            rafRef.current = requestAnimationFrame(frame);
            const st = stateRef.current;
            const g = st.grid;
            const o = st.opts;
            if (!g || g.count === 0) {
                // プールを空にする
                [faceGroupRef.current, wireGroupRef.current, baseGroupRef.current, shadowGroupRef.current].forEach(
                    (grp) => {
                        if (grp && grp.__pool && grp.__pool.length) {
                            while (grp.firstChild) grp.removeChild(grp.firstChild);
                            grp.__pool = [];
                        }
                    }
                );
                if (peakRef.current) peakRef.current.setAttribute('opacity', '0');
                lastTsRef.current = ts;
                return;
            }

            // 経過時間から回転を進める
            const last = lastTsRef.current || ts;
            const dt = Math.min(64, ts - last); // ms（タブ復帰の巨大 dt をクランプ）
            lastTsRef.current = ts;
            if (o.autoRotate && o.rotateSpeed > 0) {
                // 100% = 12度/秒
                spinRef.current += (o.rotateSpeed / 100) * 12 * (dt / 1000);
            }
            const yawDeg = o.yaw + spinRef.current;

            renderTerrain(g, o, st, yawDeg, ensurePool);
        }

        rafRef.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- 地形の投影＆描画（rAF から毎フレーム呼ばれる） ----------------------
    function renderTerrain(g, o, st, yawDeg, ensurePool) {
        const { X, Y, values } = g;
        const W = st.stageW;
        const H = st.stageH;

        // スケール解決
        const dmin = o.scaleMin !== undefined ? o.scaleMin : g.min;
        const dmax = o.scaleMax !== undefined ? o.scaleMax : g.max;
        const span = dmax - dmin;
        const norm = (v) => (span > 0 ? clamp01((v - dmin) / span) : 0.5);

        // グリッド → 正規化座標（-0.5..0.5）。セル中心ではなく格子頂点を使う（滑らかな面）。
        // 頂点の高さは周囲セルの平均で補間（Gouraud 風の連続サーフェス）。
        const nvx = X; // 頂点列数 = セル数（各セルを1点として扱い、四隅は隣接頂点）
        const nvy = Y;

        // 投影パラメータ: 地形が W×H に収まる scale を決める。
        // 平面対角 = √2、pitch 投影後の縦につぶれを考慮して余裕を持たせる。
        const pitch = o.pitch;
        const cp = Math.cos((pitch * Math.PI) / 180);
        const sp = Math.sin((pitch * Math.PI) / 180);
        const heightScale = o.height / 100;
        // zLift は地形の高さの画面上の伸び。scale に対する比。
        // まず scale を仮決め → zの張り出しぶんヘッドルームを引く
        const planSpan = 1.0; // -0.5..0.5
        const diag = Math.SQRT2 * planSpan;
        const zTop = heightScale; // 最大 z（正規化1）
        const cx = W / 2;
        // scale: 横は diag*scale <= W, 縦は diag*scale*cp + zTop*zLift*sp <= H
        // zLift を scale の 0.62 倍と定義（見栄えの良い起伏比）
        const zLiftRatio = 0.62;
        // ヘッドルーム: 接地影のオフセット＋blur(6px) と発光 blur が下/左右へはみ出す。
        // これを viewBox 内に収めるため、フィット時に上下左右へ余白(marginPx)を確保する。
        // 小パネルほど相対的に効くので固定 px で引く。
        const shadowBlur = o.showShadow && st.mode === 'dark' ? 6 : 0;
        const glowBlur = o.glow && st.mode === 'dark' ? 3 : 0;
        const marginPx = 4 + Math.max(shadowBlur, glowBlur); // 影/発光ぶんの余白
        const availW = Math.max(20, W - marginPx * 2);
        const availH = Math.max(20, H - marginPx * 2);
        const horizFit = availW / (diag + 0.001);
        const vertFit = availH / (diag * cp + zTop * zLiftRatio * sp + 0.001);
        let scale = Math.min(horizFit, vertFit) * 0.92;
        const zLift = scale * zLiftRatio;
        // 地形の縦中心を安定させるため、z の平均張り出しぶんだけ cy を下げる。
        // さらに影は右下へ off だけずれるので、その半分を上へ寄せて上下対称に収める。
        const shadowOff = shadowBlur ? scale * 0.02 : 0;
        const cy = st.padTop + H * 0.5 + (zTop * zLift * sp) * 0.28 - shadowOff * 0.5;

        const project = makeProjector(yawDeg, pitch, scale, zLift, cx, cy);

        // 頂点座標（グリッド頂点 = (X+1)×(Y+1)）とその高さ z を作る。
        // セル (x,y) の値を頂点へ寄せるため、頂点(vx,vy) は周囲最大4セルの平均。
        const VX = X + 1;
        const VY = Y + 1;
        function cellVal(x, y) {
            if (x < 0 || y < 0 || x >= X || y >= Y) return null;
            return values[y][x];
        }
        function vertexZ(vx, vy) {
            let sum = 0;
            let cnt = 0;
            for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
                const c = cellVal(vx + dx, vy + dy);
                if (c !== null) {
                    sum += c;
                    cnt += 1;
                }
            }
            return cnt > 0 ? norm(sum / cnt) : 0;
        }

        // 頂点投影キャッシュ
        const projPts = new Array(VY);
        const vzCache = new Array(VY);
        for (let vy = 0; vy < VY; vy += 1) {
            projPts[vy] = new Array(VX);
            vzCache[vy] = new Array(VX);
            const py = vy / Y - 0.5;
            for (let vx = 0; vx < VX; vx += 1) {
                const px = vx / X - 0.5;
                const z = vertexZ(vx, vy);
                vzCache[vy][vx] = z;
                projPts[vy][vx] = project(px, py, z);
            }
        }

        // 光源方向（画面平面上の単位ベクトル）
        const la = (o.lightAngle * Math.PI) / 180;
        const lightDir = { x: Math.cos(la), y: Math.sin(la), z: 0.75 };
        const llen = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
        lightDir.x /= llen;
        lightDir.y /= llen;
        lightDir.z /= llen;
        const shadeAmt = o.shading / 100;

        // 各セル = 四隅の quad。深度・色・法線を計算して面リストへ。
        const faces = [];
        let peak = { z: -1, sx: 0, sy: 0 };
        for (let y = 0; y < Y; y += 1) {
            for (let x = 0; x < X; x += 1) {
                const p00 = projPts[y][x];
                const p10 = projPts[y][x + 1];
                const p11 = projPts[y + 1][x + 1];
                const p01 = projPts[y + 1][x];
                const z00 = vzCache[y][x];
                const z10 = vzCache[y][x + 1];
                const z11 = vzCache[y + 1][x + 1];
                const z01 = vzCache[y + 1][x];
                const zc = (z00 + z10 + z11 + z01) / 4; // 幾何用（頂点平均で滑らか）
                // 色は「そのセルの真の値」を正規化して使う。頂点平均だと単独ピークが
                // 均されて高標高色に到達しない（3x3 で peak が緑止まりになる不具合の修正）。
                const cellT = norm(values[y][x]);

                // 3D 法線（セル座標系で）。2つの対角ベクトルの外積。
                // 実座標: dx=1/X, dy=1/Y, dz=z*zLift 相当。傾きから法線を求める。
                const dzdx = (z10 + z11 - z00 - z01) / 2; // x方向の平均勾配（正規化z）
                const dzdy = (z01 + z11 - z00 - z10) / 2; // y方向
                // 法線 ∝ (-dzdx*k, -dzdy*k, 1)。k は起伏を法線に効かせる係数。
                const k = heightScale * 3.0;
                let nx = -dzdx * k;
                let ny = -dzdy * k;
                let nz = 1;
                const nl = Math.hypot(nx, ny, nz);
                nx /= nl;
                ny /= nl;
                nz /= nl;
                // ランバート（負をクランプ）。yaw と無関係にワールド固定光でもよいが、
                // 回転で陰影が動く方が立体的に見えるので画面固定光にする。
                const dot = nx * lightDir.x + ny * lightDir.y + nz * lightDir.z;
                const lambert = clamp(0.5 + 0.5 * dot, 0, 1);
                const shadeFactor = 1 - shadeAmt + shadeAmt * (0.45 + 0.9 * lambert);

                const baseRgb = scaleColorFor(cellT, o);
                const rgb = shadeRgb(baseRgb, shadeFactor);

                const depth = (p00.depth + p10.depth + p11.depth + p01.depth) / 4;
                faces.push({
                    pts: `${p00.sx.toFixed(1)},${p00.sy.toFixed(1)} ${p10.sx.toFixed(1)},${p10.sy.toFixed(
                        1
                    )} ${p11.sx.toFixed(1)},${p11.sy.toFixed(1)} ${p01.sx.toFixed(1)},${p01.sy.toFixed(1)}`,
                    fill: rgbStr(rgb),
                    depth,
                    zc: cellT, // 発光しきい値の判定は真の標高で
                });

                if (cellT > peak.z) {
                    // 最高セルの中心を、その高さで投影してマーカー位置に
                    const px = (x + 0.5) / X - 0.5;
                    const py = (y + 0.5) / Y - 0.5;
                    const pp = project(px, py, norm(values[y][x]));
                    peak = { z: cellT, sx: pp.sx, sy: pp.sy };
                }
            }
        }

        // ペインターズアルゴリズム: 奥（depth 小）→ 手前（depth 大）
        faces.sort((a, b) => a.depth - b.depth);

        // ---- 影（地面 z=0 への投影、真下方向にオフセット） --------------------
        const shadowGroup = shadowGroupRef.current;
        if (o.showShadow && st.mode === 'dark') {
            // 地形の外周を z=0 で投影した多角形を1枚敷く（簡易接地影）
            const ring = [];
            for (let vx = 0; vx < VX; vx += 1) ring.push(project(vx / X - 0.5, -0.5, 0));
            for (let vy = 0; vy < VY; vy += 1) ring.push(project(0.5, vy / Y - 0.5, 0));
            for (let vx = VX - 1; vx >= 0; vx -= 1) ring.push(project(vx / X - 0.5, 0.5, 0));
            for (let vy = VY - 1; vy >= 0; vy -= 1) ring.push(project(-0.5, vy / Y - 0.5, 0));
            const els = ensurePool(shadowGroup, 1, 'polygon', 'mt-shadow');
            const off = scale * 0.02;
            els[0].setAttribute(
                'points',
                ring.map((p) => `${(p.sx + off).toFixed(1)},${(p.sy + off).toFixed(1)}`).join(' ')
            );
            els[0].setAttribute('fill', 'rgba(0,0,0,0.28)');
            els[0].setAttribute('filter', 'blur(6px)');
        } else if (shadowGroup && shadowGroup.__pool && shadowGroup.__pool.length) {
            while (shadowGroup.firstChild) shadowGroup.removeChild(shadowGroup.firstChild);
            shadowGroup.__pool = [];
        }

        // ---- 土台（外周の側面押し出し）---------------------------------------
        const baseGroup = baseGroupRef.current;
        if (o.showBase) {
            // 4辺の側面を quad で。外周頂点の (上=z, 下=0) を結ぶ。
            const sideFaces = [];
            const edges = [];
            // 下辺 (vy=0) と上辺 (vy=Y) の x 走査、左右辺の y 走査
            for (let vx = 0; vx < X; vx += 1) {
                edges.push([[vx, 0], [vx + 1, 0]]); // front(y=-0.5)
                edges.push([[vx + 1, VY - 1], [vx, VY - 1]]); // back
            }
            for (let vy = 0; vy < Y; vy += 1) {
                edges.push([[0, vy + 1], [0, vy]]); // left
                edges.push([[VX - 1, vy], [VX - 1, vy + 1]]); // right
            }
            const baseRgb = hexToRgb(o.lowColor);
            const sideRgb = shadeRgb(baseRgb, 0.55);
            const sideFill = rgbStr(sideRgb);
            for (const [[ax, ay], [bx, by]] of edges) {
                const zTopA = vzCache[ay][ax];
                const zTopB = vzCache[by][bx];
                const tA = project(ax / X - 0.5, ay / Y - 0.5, zTopA);
                const tB = project(bx / X - 0.5, by / Y - 0.5, zTopB);
                const bA = project(ax / X - 0.5, ay / Y - 0.5, 0);
                const bB = project(bx / X - 0.5, by / Y - 0.5, 0);
                const depth = (tA.depth + tB.depth + bA.depth + bB.depth) / 4;
                sideFaces.push({
                    pts: `${tA.sx.toFixed(1)},${tA.sy.toFixed(1)} ${tB.sx.toFixed(1)},${tB.sy.toFixed(
                        1
                    )} ${bB.sx.toFixed(1)},${bB.sy.toFixed(1)} ${bA.sx.toFixed(1)},${bA.sy.toFixed(1)}`,
                    depth,
                });
            }
            sideFaces.sort((a, b) => a.depth - b.depth);
            const els = ensurePool(baseGroup, sideFaces.length, 'polygon', 'mt-side');
            for (let i = 0; i < sideFaces.length; i += 1) {
                els[i].setAttribute('points', sideFaces[i].pts);
                els[i].setAttribute('fill', sideFill);
            }
        } else if (baseGroup && baseGroup.__pool && baseGroup.__pool.length) {
            while (baseGroup.firstChild) baseGroup.removeChild(baseGroup.firstChild);
            baseGroup.__pool = [];
        }

        // ---- 面（サーフェス） -------------------------------------------------
        const faceGroup = faceGroupRef.current;
        const faceEls = ensurePool(faceGroup, faces.length, 'polygon', 'mt-face');
        for (let i = 0; i < faces.length; i += 1) {
            const f = faces[i];
            const el = faceEls[i];
            el.setAttribute('points', f.pts);
            el.setAttribute('fill', f.fill);
            // 高標高部の発光（dark のみ）
            if (o.glow && st.mode === 'dark' && f.zc > 0.82) {
                el.setAttribute('filter', 'url(#mt-glow)');
            } else {
                el.removeAttribute('filter');
            }
        }

        // ---- ワイヤーフレーム（面の輪郭を薄い線で。同順で重ねる） -------------
        const wireGroup = wireGroupRef.current;
        if (o.wireframe && o.wireOpacity > 0) {
            const wireEls = ensurePool(wireGroup, faces.length, 'polygon', 'mt-wire');
            const wireCol = st.mode === 'dark' ? 'rgba(255,255,255,%O)' : 'rgba(20,30,50,%O)';
            const op = (o.wireOpacity / 100).toFixed(3);
            for (let i = 0; i < faces.length; i += 1) {
                const el = wireEls[i];
                el.setAttribute('points', faces[i].pts);
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', wireCol.replace('%O', op));
                el.setAttribute('stroke-width', '0.6');
            }
        } else if (wireGroup && wireGroup.__pool && wireGroup.__pool.length) {
            while (wireGroup.firstChild) wireGroup.removeChild(wireGroup.firstChild);
            wireGroup.__pool = [];
        }

        // ---- 頂点マーカー ----------------------------------------------------
        const peakEl = peakRef.current;
        if (peakEl) {
            if (o.showPeakMarker && peak.z >= 0) {
                peakEl.setAttribute('transform', `translate(${peak.sx.toFixed(1)},${peak.sy.toFixed(1)})`);
                peakEl.setAttribute('opacity', '1');
            } else {
                peakEl.setAttribute('opacity', '0');
            }
        }
    }

    // ---- 表示ガード ----------------------------------------------------------
    const isDark = mode === 'dark';
    const fg = isDark ? '#e6edf3' : '#1f2933';
    const subFg = isDark ? '#8b98a5' : '#5b6770';

    if (loading) {
        return (
            <div className="viz-container viz-container--empty" ref={attachContainer}>
                <div className="viz-message">
                    <WaitSpinner size="medium" />
                    <Paragraph style={{ marginTop: 12 }}>読み込み中…</Paragraph>
                </div>
            </div>
        );
    }

    if (!grid || grid.count === 0) {
        return (
            <div className="viz-container viz-container--empty" ref={attachContainer}>
                <div className="viz-message">
                    <Paragraph>
                        表示できるデータがありません。<br />
                        <span style={{ opacity: 0.7, fontSize: 12 }}>
                            tidy 形式 [X, Y, 値] または 行列形式 [行, 数値列…] を返してください。
                        </span>
                    </Paragraph>
                </div>
                {opts.debug && <DebugOverlay options={options} opts={opts} grid={grid} />}
            </div>
        );
    }

    // ---- 凡例レンジ ----------------------------------------------------------
    const dmin = opts.scaleMin !== undefined ? opts.scaleMin : grid.min;
    const dmax = opts.scaleMax !== undefined ? opts.scaleMax : grid.max;
    const legendStops = [];
    for (let i = 0; i <= 6; i += 1) {
        const t = i / 6;
        legendStops.push(rgbStr(scaleColorFor(t, opts)));
    }
    const legendGradient = `linear-gradient(90deg, ${legendStops.join(',')})`;

    return (
        <div className="viz-container" ref={attachContainer} style={{ padding: 0 }}>
            {showHeader && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: compactHeader ? 10 : 18,
                        padding: compactHeader ? '3px 10px 2px' : '8px 18px 6px',
                        height: headerH,
                        boxSizing: 'border-box',
                        color: fg,
                        // コンパクト時は 1 行固定で折り返さない（折返し→クリップを回避）
                        flexWrap: compactHeader ? 'nowrap' : 'wrap',
                        overflow: 'hidden',
                    }}
                >
                    {/* 狭い時は Stat を間引く（最大/最小を優先）。折返しでクリップさせない。 */}
                    {!isNarrow && (
                        <Stat label="セル" value={String(grid.count)} fg={fg} sub={subFg} scale={uiScale} />
                    )}
                    <Stat label="グリッド" value={`${grid.X}×${grid.Y}`} fg={fg} sub={subFg} scale={uiScale} />
                    <Stat label="最小" value={fmtNum(grid.min)} fg={fg} sub={subFg} scale={uiScale} />
                    <Stat label="最大" value={fmtNum(grid.max)} fg={fg} sub={subFg} scale={uiScale} />
                    {grid.resampled && !compactHeader && (
                        <span style={{ fontSize: 11 * uiScale, color: subFg }}>（粗くリサンプル済み）</span>
                    )}
                </div>
            )}

            <div style={{ position: 'relative', width: '100%', height: stageH + padTop + padBottom }}>
                <svg
                    ref={svgRef}
                    width="100%"
                    height={stageH + padTop + padBottom}
                    viewBox={`0 0 ${box.w} ${stageH + padTop + padBottom}`}
                    preserveAspectRatio="xMidYMid meet"
                    style={{ display: 'block' }}
                >
                    <defs>
                        <filter id="mt-glow" x="-40%" y="-40%" width="180%" height="180%">
                            <feGaussianBlur stdDeviation="2.4" result="b" />
                            <feMerge>
                                <feMergeNode in="b" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>
                    <g transform={`translate(${padX},0)`}>
                        {/* 描画順: 影 → 土台 → 面 → ワイヤー → 頂点マーカー */}
                        <g ref={setShadowGroup} />
                        <g ref={setBaseGroup} />
                        <g ref={setFaceGroup} />
                        <g ref={setWireGroup} />
                        {opts.showPeakMarker && (
                            <g ref={setPeak} opacity="0">
                                <circle r="5.5" fill="none" stroke={opts.peakColor} strokeWidth="2">
                                    <animate
                                        attributeName="r"
                                        values="4;9;4"
                                        dur="1.8s"
                                        repeatCount="indefinite"
                                    />
                                    <animate
                                        attributeName="opacity"
                                        values="1;0.15;1"
                                        dur="1.8s"
                                        repeatCount="indefinite"
                                    />
                                </circle>
                                <circle r="2.4" fill={opts.peakColor} />
                            </g>
                        )}
                    </g>
                </svg>

                {opts.showAxes && !isTiny && (
                    <>
                        <AxisLabel
                            text={truncLabel(grid.xLabels[0], isNarrow ? 8 : 14)}
                            style={{ left: padX + 4, bottom: 4, fontSize: 11 * uiScale }}
                            fg={subFg}
                        />
                        <AxisLabel
                            text={truncLabel(grid.xLabels[grid.xLabels.length - 1], isNarrow ? 8 : 14)}
                            style={{ right: padX + 4, bottom: 4, fontSize: 11 * uiScale }}
                            fg={subFg}
                        />
                        <AxisLabel
                            text={truncLabel(grid.yLabels[0], isNarrow ? 8 : 14)}
                            style={{ left: padX + 4, top: 4, fontSize: 11 * uiScale }}
                            fg={subFg}
                        />
                        <AxisLabel
                            text={truncLabel(grid.yLabels[grid.yLabels.length - 1], isNarrow ? 8 : 14)}
                            style={{ right: padX + 4, top: 4, fontSize: 11 * uiScale }}
                            fg={subFg}
                        />
                    </>
                )}
            </div>

            {showLegend && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: isNarrow ? 6 : 10,
                        padding: isShort ? '3px 10px 4px' : '6px 18px 10px',
                        height: legendH,
                        boxSizing: 'border-box',
                        color: subFg,
                        fontSize: 11 * uiScale,
                    }}
                >
                    <span style={{ flex: '0 0 auto' }}>{opts.reverse ? '高' : '低'}</span>
                    <div
                        data-legend="scale"
                        data-gradient={legendGradient}
                        style={{
                            // バーは縮んでよい（レンジ文字の右クリップを防ぐため min 0）
                            flex: '1 1 0',
                            minWidth: 0,
                            height: isShort ? 8 : 10,
                            borderRadius: 5,
                            backgroundImage: legendGradient,
                            boxShadow: isDark ? '0 0 6px rgba(0,0,0,0.4) inset' : 'none',
                        }}
                    />
                    <span style={{ flex: '0 0 auto' }}>{opts.reverse ? '低' : '高'}</span>
                    {/* レンジ数値は狭パネルで隠す（右端クリップを回避） */}
                    {!isNarrow && (
                        <span
                            style={{
                                marginLeft: 8,
                                color: fg,
                                whiteSpace: 'nowrap',
                                flex: '0 0 auto',
                            }}
                        >
                            {fmtNum(dmin)} 〜 {fmtNum(dmax)}
                        </span>
                    )}
                </div>
            )}

            {opts.debug && <DebugOverlay options={options} opts={opts} grid={grid} />}
        </div>
    );
}

function Stat({ label, value, fg, sub, scale = 1 }) {
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 5 * scale,
                whiteSpace: 'nowrap',
                minWidth: 0,
            }}
        >
            <span style={{ fontSize: 11 * scale, color: sub }}>{label}</span>
            <span
                style={{
                    fontSize: 16 * scale,
                    fontWeight: 600,
                    color: fg,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {value}
            </span>
        </span>
    );
}

function AxisLabel({ text, style, fg }) {
    return (
        <div
            style={{
                position: 'absolute',
                fontSize: 11,
                color: fg,
                pointerEvents: 'none',
                maxWidth: '38%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...style,
            }}
        >
            {text}
        </div>
    );
}

function DebugOverlay({ options, opts, grid }) {
    return (
        <pre
            style={{
                position: 'absolute',
                top: 6,
                right: 6,
                maxWidth: 360,
                maxHeight: '70%',
                overflow: 'auto',
                margin: 0,
                padding: 8,
                fontSize: 10,
                lineHeight: 1.35,
                background: 'rgba(0,0,0,0.82)',
                color: '#b9f18d',
                border: '1px solid #30363d',
                borderRadius: 6,
                zIndex: 10,
            }}
        >
            {JSON.stringify(
                {
                    rawOptions: options,
                    resolved: {
                        xField: opts._xField,
                        yField: opts._yField,
                        valueField: opts._valueField,
                        height: opts.height,
                        yaw: opts.yaw,
                        pitch: opts.pitch,
                    },
                    grid: grid
                        ? { X: grid.X, Y: grid.Y, count: grid.count, min: grid.min, max: grid.max, resampled: grid.resampled }
                        : null,
                },
                null,
                2
            )}
        </pre>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
