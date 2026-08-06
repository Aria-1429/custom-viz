import {
    VisualizationExtensionProvider,
    useDataSources,
    useOptions,
    useTheme,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン API は /react ではなくコア側にある（公式 docs の記載は誤り）
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { feature, mesh } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import './visualization.css';

// ---------------------------------------------------------------------------
// Attack Globe — レイトレースした3D地球儀のアタックマップ
//
// 描画は2層のハイブリッド:
//   - WebGL フラグメントシェーダ … 球体（レイ・球交差の解析解）、陸地テクスチャ、
//     経緯線グリッド、フレネルによる大気の縁光、昼夜ターミネーター
//   - SVG オーバーレイ … 大円アークと着弾点。シェーダと同じ回転・正射影の式を
//     JS 側でも計算し、球の裏側に回った区間を消す（オクルージョン判定）
//
// 【WebGL の実機確認済み事項】（2026-08-02 検証。詳細は
//  .claude/skills/splunk-viz/references/webgl-in-custom-viz.md）
//   - Splunk のカスタム viz iframe 内で **webgl2 が使える**
//   - GLSL ES 3.00 がそのままコンパイル・リンクできる
//
// 陸地テクスチャは Natural Earth（world-atlas 110m・パブリックドメイン）の
// ポリゴンを初期化時に 2D canvas へラスタライズして生成する（R=陸地, G=国境）。
// 画像アセットは同梱しない。
// ---------------------------------------------------------------------------

const VIZ_VERSION = 'attack-globe 1.1.0';

const DEG = Math.PI / 180;

// --- シェーダ ---------------------------------------------------------------
const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// 正射影（平行光線）で球をレイトレースする。
// 球面上の点 p=(x,y,z)（z が視線方向・手前が正）を、ビュー回転の逆で
// 地球固定座標へ戻して緯度経度を得る:
//   w = Ry(λc) · Rx(-φc) · v
//   λ = atan(w.x, w.z), φ = asin(w.y)
// この式は JS 側（SVG オーバーレイの射影）と完全に一致させること。
const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  uRes;
uniform float uRadius;          // 球の半径（px）
uniform float uLambda;          // 中心の経度（rad）
uniform float uPhi;             // 中心の緯度（rad）
uniform sampler2D uTex;         // R=陸地マスク, G=国境
uniform vec3  uLandColor;
uniform vec3  uOceanColor;
uniform vec3  uBorderColor;
uniform float uBorders;         // 国境の濃さ 0..1
uniform float uGraticule;       // 経緯線の濃さ 0..1
uniform float uAtmosphere;      // 大気の光 0..2
uniform vec3  uAtmColor;
uniform float uShadeMode;       // 0=flat 1=soft 2=daynight
uniform float uSunLon;          // 昼夜モードの太陽経度（rad）
uniform vec3  uBgColor;
uniform float uBgAlpha;         // 0=透過 / 1=背景色で塗る

void main() {
    vec2 c = 0.5 * uRes;
    vec2 p = (gl_FragCoord.xy - c) / uRadius;   // 球の中心が原点、半径1
    float r = length(p);

    vec3 bg = uBgColor * uBgAlpha;
    float edgeAA = fwidth(r) * 1.5 + 1e-5;

    // --- 球の外側: 大気ハロー -------------------------------------------
    if (r >= 1.0) {
        float halo = exp(-(r - 1.0) * 9.0) * 0.55 * uAtmosphere;
        vec3 col = bg + uAtmColor * halo;
        float alpha = clamp(max(uBgAlpha, halo), 0.0, 1.0);
        outColor = vec4(col * alpha, alpha);
        return;
    }

    // --- 球面上の点 -------------------------------------------------------
    float z = sqrt(max(1.0 - r * r, 0.0));
    vec3 v = vec3(p, z);

    // ビュー回転の逆: w = Ry(λc) · Rx(-φc) · v
    float cp = cos(uPhi), sp = sin(uPhi);
    vec3 t = vec3(v.x, v.y * cp + v.z * sp, -v.y * sp + v.z * cp);
    float cl = cos(uLambda), sl = sin(uLambda);
    vec3 w = vec3(t.x * cl + t.z * sl, t.y, -t.x * sl + t.z * cl);

    float lon = atan(w.x, w.z);                       // -π..π
    float lat = asin(clamp(w.y, -1.0, 1.0));          // -π/2..π/2

    // テクスチャは等距円筒（上端が北緯90度）
    vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265);
    vec4 tex = texture(uTex, uv);

    vec3 col = mix(uOceanColor, uLandColor, tex.r);
    col = mix(col, uBorderColor, tex.g * uBorders);

    // --- 経緯線グリッド（15度間隔） --------------------------------------
    if (uGraticule > 0.001) {
        float lonDeg = lon / 0.017453293;
        float latDeg = lat / 0.017453293;
        float fx = abs(fract(lonDeg / 15.0 + 0.5) - 0.5) * 15.0;
        float fy = abs(fract(latDeg / 15.0 + 0.5) - 0.5) * 15.0;
        // 日付変更線では lon の微分が飛ぶ（π→-π）ため fwidth を clamp する。
        // clamp しないと ±180 度に太い帯が出る
        float ax = min(fwidth(lonDeg), 2.0) * 0.8 + 1e-4;
        float ay = min(fwidth(latDeg), 2.0) * 0.8 + 1e-4;
        float line = max(1.0 - smoothstep(0.0, ax, fx), 1.0 - smoothstep(0.0, ay, fy));
        // 極付近は経線が密集して潰れるので緯度で減衰させる
        col = mix(col, col + uAtmColor * 0.5, line * 0.30 * uGraticule * cos(lat));
    }

    // --- 陰影 -------------------------------------------------------------
    if (uShadeMode > 1.5) {
        // 昼夜: 太陽は地球固定座標で経度 uSunLon・赤緯10度に置く
        float decl = 0.1745;
        vec3 sun = vec3(cos(decl) * sin(uSunLon), sin(decl), cos(decl) * cos(uSunLon));
        float day = smoothstep(-0.12, 0.15, dot(normalize(w), sun));
        col *= mix(0.22, 1.0, day);
    } else if (uShadeMode > 0.5) {
        // 柔らかい陰影: 視点の左上からのライト
        vec3 L = normalize(vec3(-0.38, 0.45, 0.80));
        float diff = 0.68 + 0.38 * max(dot(v, L), 0.0);
        col *= diff;
    }

    // --- フレネルによる大気の縁光 ----------------------------------------
    float fres = pow(1.0 - z, 2.6);
    col += uAtmColor * fres * 0.85 * uAtmosphere;

    // --- 縁のアンチエイリアス（ハローへ滑らかに溶かす） -------------------
    float cover = smoothstep(1.0, 1.0 - edgeAA * 2.0, r);
    float haloA = exp(0.0) * 0.55 * uAtmosphere;   // r=1 でのハロー強度
    vec3 outside = bg + uAtmColor * haloA;
    float outsideAlpha = clamp(max(uBgAlpha, haloA), 0.0, 1.0);

    vec3 fin = mix(outside, col, cover);
    float alpha = mix(outsideAlpha, 1.0, cover);
    outColor = vec4(fin * alpha, alpha);
}
`;

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) || '(ログなし)';
        gl.deleteShader(sh);
        throw new Error(log.trim().slice(0, 300));
    }
    return sh;
}

function buildProgram(gl) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error((gl.getProgramInfoLog(prog) || '(ログなし)').trim().slice(0, 300));
    }
    return prog;
}

// ---------------------------------------------------------------------------
// 陸地テクスチャ（Natural Earth を等距円筒へラスタライズ。R=陸地, G=国境）
// ---------------------------------------------------------------------------
const textureCanvasCache = new Map();

function buildLandCanvas(texW) {
    if (textureCanvasCache.has(texW)) return textureCanvasCache.get(texW);
    let canvas = null;
    try {
        const w = texW;
        const h = texW / 2;
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // 等距円筒: 全幅 = 2π * scale
        const projection = geoEquirectangular()
            .translate([w / 2, h / 2])
            .scale(w / (2 * Math.PI));
        const path = geoPath(projection, ctx);

        const land = feature(worldTopo, worldTopo.objects.countries);
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        path(land);
        ctx.fillStyle = 'rgb(255,0,0)';           // R = 陸地マスク
        ctx.fill();

        // 国境は加算合成で G に描く（source-over だと境界画素の R が消え、
        // 国境線が「陸地の切れ目」に見えてしまう）
        const borders = mesh(worldTopo, worldTopo.objects.countries, (a, b) => a !== b);
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath();
        path(borders);
        ctx.strokeStyle = 'rgb(0,255,0)';         // G = 国境
        ctx.lineWidth = Math.max(1, w / 2048);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
    } catch (e) {
        canvas = null; // ラスタライズ不能な環境（検証環境など）では海だけの球になる
    }
    textureCanvasCache.set(texW, canvas);
    return canvas;
}

// ---------------------------------------------------------------------------
// 射影の数学（シェーダと同じ式。SVG オーバーレイと可視判定で使う）
// ---------------------------------------------------------------------------

// 緯度経度（度）→ 地球固定座標の単位ベクトル
function lonLatToVec(lonDeg, latDeg) {
    const lon = lonDeg * DEG;
    const lat = latDeg * DEG;
    const cl = Math.cos(lat);
    return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}

// 地球固定座標 → ビュー座標（v = Rx(φc) · Ry(-λc) · w）
function worldToView(w, lambdaRad, phiRad) {
    const cl = Math.cos(lambdaRad);
    const sl = Math.sin(lambdaRad);
    // Ry(-λc)
    const x1 = w[0] * cl - w[2] * sl;
    const z1 = w[0] * sl + w[2] * cl;
    const y1 = w[1];
    // Rx(φc): (y,z) → (y cosφ - z sinφ, y sinφ + z cosφ) の逆向きで
    // 「緯度 φc の点が正面 (0,0,1) に来る」回転
    const cp = Math.cos(phiRad);
    const sp = Math.sin(phiRad);
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;
    return [x1, y2, z2];
}

// ビュー座標 → 画面座標。visible は球によるオクルージョン込み
// （半径 rho の点は、z<0 かつ画面上で球の円盤の内側にあるとき隠れる）
function viewToScreen(v, cx, cy, radiusPx) {
    const sx = cx + v[0] * radiusPx;
    const sy = cy - v[1] * radiusPx;
    const visible = v[2] >= 0 || (v[0] * v[0] + v[1] * v[1]) >= 1;
    return { x: sx, y: sy, visible };
}

// 大円の球面線形補間（slerp）
function slerp(a, b, t) {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    dot = Math.min(Math.max(dot, -1), 1);
    const omega = Math.acos(dot);
    if (omega < 1e-6) return a.slice();
    const so = Math.sin(omega);
    const ka = Math.sin((1 - t) * omega) / so;
    const kb = Math.sin(t * omega) / so;
    return [
        a[0] * ka + b[0] * kb,
        a[1] * ka + b[1] * kb,
        a[2] * ka + b[2] * kb,
    ];
}

const ARC_SEGMENTS = 48;

// アークの3D頂点列（単位球からの高さ付き）を作る
function buildArcPoints(srcVec, dstVec) {
    let dot = srcVec[0] * dstVec[0] + srcVec[1] * dstVec[1] + srcVec[2] * dstVec[2];
    dot = Math.min(Math.max(dot, -1), 1);
    const omega = Math.acos(dot);
    const hMax = 0.05 + 0.22 * (omega / Math.PI);
    const pts = [];
    for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
        const t = i / ARC_SEGMENTS;
        const u = slerp(srcVec, dstVec, t);
        const rho = 1 + hMax * Math.sin(Math.PI * t);
        pts.push([u[0] * rho, u[1] * rho, u[2] * rho]);
    }
    return pts;
}

// 3D頂点列 → 画面座標の折れ線（可視フラグ付き）。SVG パスと彗星の両方が使う
function projectArcPoints(points3d, lambdaRad, phiRad, cx, cy, radiusPx) {
    const pts = new Array(points3d.length);
    for (let i = 0; i < points3d.length; i += 1) {
        const v = worldToView(points3d[i], lambdaRad, phiRad);
        pts[i] = viewToScreen(v, cx, cy, radiusPx);
    }
    return pts;
}

// 折れ線 → 可視区間ごとの SVG パス（d 属性）
function ptsToPath(pts) {
    let d = '';
    let penDown = false;
    for (let i = 0; i < pts.length; i += 1) {
        const s = pts[i];
        if (!s.visible) { penDown = false; continue; }
        if (!penDown) {
            d += `M${s.x.toFixed(1)},${s.y.toFixed(1)}`;
            penDown = true;
        } else {
            d += `L${s.x.toFixed(1)},${s.y.toFixed(1)}`;
        }
    }
    return d;
}

// 折れ線上の位置 p (0..1) を補間して座標＋法線を返す。
// 前後どちらかのサンプルが球の裏側なら null（彗星はその区間を描かない）
function pointOnPts(pts, p) {
    if (p < 0 || p > 1) return null;
    const f = p * (pts.length - 1);
    const i0 = Math.min(Math.floor(f), pts.length - 2);
    const i1 = i0 + 1;
    const a = pts[i0];
    const b = pts[i1];
    if (!a.visible || !b.visible) return null;
    const u = f - i0;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
        x: a.x + dx * u,
        y: a.y + dy * u,
        nx: -dy / len,
        ny: dx / len,
    };
}

// ---------------------------------------------------------------------------
// 色ユーティリティ
// ---------------------------------------------------------------------------
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseColor(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (!HEX_RE.test(v)) return null;
    let h = v.slice(1);
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
}

// 色を白方向へ寄せる（ホットスポットのコア・グローの派生色。world-map と同じ手法）
function tint(hex, k) {
    const c = parseColor(hex) || { r: 0.22, g: 0.65, b: 1 };
    const m = (v) => Math.round((v + (1 - v) * k) * 255);
    return `rgb(${m(c.r)}, ${m(c.g)}, ${m(c.b)})`;
}

// editor.threshold から届く [{from,to,value}] を正規化（openRanges の null → ±Infinity）
function normalizeBands(raw) {
    if (!Array.isArray(raw)) return [];
    const bands = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const from = b.from === null || b.from === undefined ? -Infinity : Number(b.from);
        const to = b.to === null || b.to === undefined ? Infinity : Number(b.to);
        if (Number.isNaN(from) || Number.isNaN(to) || from > to) return;
        if (parseColor(b.value) === null) return;
        bands.push({ from, to, value: b.value });
    });
    bands.sort((a, b) => a.from - b.from || a.to - b.to);
    return bands;
}

// ホストは既定値と同じ値を options に載せないため、schema の default をここで再現
const DEFAULT_COUNT_BANDS = [
    { from: -Infinity, to: 10, value: '#3ddc84' },
    { from: 10, to: 100, value: '#e6b93c' },
    { from: 100, to: Infinity, value: '#ff5a2e' },
];

// 「カテゴリ名|色」の行を {name(lower) → color} へ
function parseCategoryColors(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    raw.forEach((line) => {
        if (typeof line !== 'string') return;
        const idx = line.indexOf('|');
        if (idx <= 0) return;
        const name = line.slice(0, idx).trim().toLowerCase();
        const color = line.slice(idx + 1).trim();
        if (name === '' || parseColor(color) === null) return;
        map.set(name, color);
    });
    return map;
}

function hash01(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------------------
// データ処理
// ---------------------------------------------------------------------------
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) { /* 想定外形式でも落とさない */ }
    return [];
}

/**
 * editor.columnSelector の選択値を列インデックスへ解決する。
 * DOS 文字列（"> primary | seriesByName('x')"）が未解決で届くため自前でパースする。
 */
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    if (Array.isArray(spec)) {
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) { ok = false; break; }
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

function findFieldIndex(lowerNames, candidates) {
    return lowerNames.findIndex((name) => candidates.includes(name));
}

const toNumber = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
};

const normLon = (lon) => ((lon + 540) % 360) - 180;

/**
 * サーチ結果をアークの配列へ変換する（world-map と同じデータ仕様）。
 * 必須: src_lat/src_lon/dst_lat/dst_lon（フィールド選択が最優先、無ければ候補名で自動判定）
 */
function parseArcs(fieldNames, rows, opts) {
    if (rows.length === 0) return { arcs: [], missingFields: [] };
    const lower = fieldNames.map((n) => String(n).toLowerCase());

    const auto = {
        srcLat: findFieldIndex(lower, ['src_lat', 'source_lat', 'slat']),
        srcLon: findFieldIndex(lower, ['src_lon', 'src_lng', 'source_lon', 'slon']),
        dstLat: findFieldIndex(lower, ['dst_lat', 'dest_lat', 'target_lat', 'dlat']),
        dstLon: findFieldIndex(lower, ['dst_lon', 'dst_lng', 'dest_lon', 'target_lon', 'dlon']),
        category: findFieldIndex(lower, [
            'category', 'type', 'log_type', 'event_type', 'status',
            'protocol', 'severity', 'threat_level', 'level',
        ]),
        count: findFieldIndex(lower, ['count', 'events', 'total']),
        srcName: findFieldIndex(lower, ['src_name', 'src', 'source']),
        dstName: findFieldIndex(lower, ['dst_name', 'dst', 'dest', 'target']),
    };

    const idx = {
        srcLat: resolveFieldIndex(opts.srcLatField, fieldNames, rows, auto.srcLat),
        srcLon: resolveFieldIndex(opts.srcLonField, fieldNames, rows, auto.srcLon),
        dstLat: resolveFieldIndex(opts.dstLatField, fieldNames, rows, auto.dstLat),
        dstLon: resolveFieldIndex(opts.dstLonField, fieldNames, rows, auto.dstLon),
        category: resolveFieldIndex(opts.categoryField, fieldNames, rows, auto.category),
        count: resolveFieldIndex(opts.countField, fieldNames, rows, auto.count),
        srcName: resolveFieldIndex(opts.srcNameField, fieldNames, rows, auto.srcName),
        dstName: resolveFieldIndex(opts.dstNameField, fieldNames, rows, auto.dstName),
    };

    const missingFields = [];
    if (idx.srcLat < 0) missingFields.push('src_lat');
    if (idx.srcLon < 0) missingFields.push('src_lon');
    if (idx.dstLat < 0) missingFields.push('dst_lat');
    if (idx.dstLon < 0) missingFields.push('dst_lon');
    if (missingFields.length > 0) return { arcs: null, missingFields };

    const arcs = [];
    rows.forEach((row, i) => {
        if (!Array.isArray(row)) return;
        const sLat = toNumber(row[idx.srcLat]);
        const sLon = toNumber(row[idx.srcLon]);
        const dLat = toNumber(row[idx.dstLat]);
        const dLon = toNumber(row[idx.dstLon]);
        if (sLat === null || sLon === null || dLat === null || dLon === null) return;
        if (Math.abs(sLat) > 90 || Math.abs(dLat) > 90) return;
        const count = idx.count >= 0 ? (toNumber(row[idx.count]) ?? 1) : 1;
        arcs.push({
            id: `a${i}`,
            srcLat: sLat,
            srcLon: normLon(sLon),
            dstLat: dLat,
            dstLon: normLon(dLon),
            category: idx.category >= 0 ? String(row[idx.category] ?? '') : '',
            count: Math.max(count, 0),
            srcName: idx.srcName >= 0 ? String(row[idx.srcName] ?? '') : '',
            dstName: idx.dstName >= 0 ? String(row[idx.dstName] ?? '') : '',
        });
    });
    return { arcs, missingFields: [] };
}

// ---------------------------------------------------------------------------
// オプション正規化
// ---------------------------------------------------------------------------
const COLOR_MODES = ['category', 'count'];
const SHADE_MODES = ['flat', 'soft', 'daynight'];
const TEXTURE_SIZES = ['1024', '2048', '4096'];

function normalizeOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const bands = normalizeBands(o.countThresholds);
    return {
        srcLatField: o.srcLatField,
        srcLonField: o.srcLonField,
        dstLatField: o.dstLatField,
        dstLonField: o.dstLonField,
        categoryField: o.categoryField,
        countField: o.countField,
        srcNameField: o.srcNameField,
        dstNameField: o.dstNameField,
        titleText: typeof o.titleText === 'string' ? o.titleText : 'GLOBAL ATTACK GLOBE',
        showLegend: bool(o.showLegend, true),
        showPointNames: bool(o.showPointNames, false),
        flowPeriod: clamp(num(o.flowPeriod, 3), 0, 30),
        rotatePeriod: clamp(num(o.rotatePeriod, 60), 0, 600),
        widthScale: clamp(num(o.widthScale, 1), 0, 5),
        maxArcs: Math.round(clamp(num(o.maxArcs, 0), 0, 5000)),
        shadeMode: SHADE_MODES.includes(o.shadeMode) ? o.shadeMode : 'soft',
        showGraticule: bool(o.showGraticule, true),
        showBorders: bool(o.showBorders, true),
        atmosphere: clamp(num(o.atmosphere, 1), 0, 2),
        textureSize: TEXTURE_SIZES.includes(String(o.textureSize)) ? Number(o.textureSize) : 2048,
        landColor: parseColor(o.landColor) !== null ? o.landColor : '',
        oceanColor: parseColor(o.oceanColor) !== null ? o.oceanColor : '',
        centerLon: clamp(num(o.centerLon, 0), -180, 180),
        centerLat: clamp(num(o.centerLat, 12), -85, 85),
        initialZoom: clamp(num(o.initialZoom, 1), 1, 12),
        interactive: bool(o.interactive, true),
        colorMode: COLOR_MODES.includes(o.colorMode) ? o.colorMode : 'category',
        countThresholds: bands.length > 0 ? bands : DEFAULT_COUNT_BANDS,
        categoryColors: parseCategoryColors(o.categoryColors),
        fallbackColor: parseColor(o.fallbackColor) !== null ? o.fallbackColor : '#ff5a2e',
        transparentBg: bool(o.transparentBg, false),
        bgColor: parseColor(o.bgColor) !== null ? o.bgColor : '',
    };
}

// アークの色。カテゴリ or 件数しきい値（下限以上・上限未満）
function colorForArc(arc, opts) {
    if (opts.colorMode === 'count') {
        const band = opts.countThresholds.find((b) => arc.count >= b.from && arc.count < b.to);
        return band ? band.value : opts.fallbackColor;
    }
    const key = arc.category.trim().toLowerCase();
    if (key !== '' && opts.categoryColors.has(key)) return opts.categoryColors.get(key);
    return opts.fallbackColor;
}

// テーマ既定の配色
function themeColors(mode) {
    if (mode === 'dark') {
        return {
            land: '#233247', ocean: '#0a1220', border: '#3d5573',
            atm: '#38a6ff', bg: '#03070d', fg: '#e8eef6',
        };
    }
    return {
        land: '#c3d0dd', ocean: '#eef4fa', border: '#8fa6bd',
        atm: '#2a7fd4', bg: '#f5f8fb', fg: '#1a2634',
    };
}

// ---------------------------------------------------------------------------
// コンテナ実寸の監視
// ---------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState(null);
    const attach = useCallback((el) => { ref.current = el; }, []);

    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w > 0 && h > 0) {
                setSize((p) => (p && p.w === w && p.h === h ? p : { w, h }));
            }
        };
        update();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return [attach, ref, size];
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

function MessageState({ message, sub }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <Paragraph>{message}</Paragraph>
                {sub ? (
                    <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>{sub}</div>
                ) : null}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
// 彗星（光の帯）のパラメータ。world-map の ArcFlowCanvas と同じ値
const FLOW_LEN = 0.22;      // パス全体に対する帯の弧長比
const FLOW_SAMPLES = 16;    // 帯を構成するサンプル点の数

function AttackGlobe({ arcs, opts, mode }) {
    const canvasRef = useRef(null);
    const flowCanvasRef = useRef(null);     // 光の帯（彗星）用の 2D canvas
    const [attachHost, hostRef, size] = useContainerSize();
    const [glError, setGlError] = useState(null);
    const [tooltip, setTooltip] = useState(null);
    const rafRef = useRef(0);

    // rAF が位置を書き込む要素のプール（React とは属性で分業する）
    const arcElsRef = useRef(new Map());     // id → {halo, core, hit}
    const spotElsRef = useRef(new Map());    // id → {glow, core, hit, srcDot}
    const labelElsRef = useRef(new Map());   // id → {srcText, dstText}

    // 視点（rAF ループが直接読む・書く）。
    // lambda/phi は「画面中央に来る経度・緯度」そのもの（シェーダの uLambda/uPhi と同一）
    const viewRef = useRef({
        lambda: opts.centerLon * DEG,
        phi: opts.centerLat * DEG,
        zoom: opts.initialZoom,
        vx: 0,
        vy: 0,
        dragging: false,
        lastInteract: 0,
    });

    // 中心・ズームのオプションが変わったら視点を初期化し直す
    useEffect(() => {
        viewRef.current.lambda = opts.centerLon * DEG;
        viewRef.current.phi = opts.centerLat * DEG;
        viewRef.current.zoom = opts.initialZoom;
        viewRef.current.vx = 0;
        viewRef.current.vy = 0;
    }, [opts.centerLon, opts.centerLat, opts.initialZoom]);

    // 表示するアーク（count 降順、上限で切る）＋事前計算した3D頂点列
    const shownArcs = useMemo(() => {
        const sorted = [...arcs].sort((a, b) => b.count - a.count);
        const capped = opts.maxArcs > 0 ? sorted.slice(0, opts.maxArcs) : sorted;
        return capped.map((a) => ({
            ...a,
            color: colorForArc(a, opts),
            points3d: buildArcPoints(
                lonLatToVec(a.srcLon, a.srcLat),
                lonLatToVec(a.dstLon, a.dstLat)
            ),
            srcVec: lonLatToVec(a.srcLon, a.srcLat),
            dstVec: lonLatToVec(a.dstLon, a.dstLat),
            phase: hash01(a.id),
        }));
    }, [arcs, opts]);

    // 線幅の正規化レンジ（sqrt 圧縮で外れ値に引っ張られにくくする。world-map と同式）
    const countRange = useMemo(() => {
        let lo = Infinity;
        let hi = -Infinity;
        shownArcs.forEach((a) => {
            lo = Math.min(lo, a.count);
            hi = Math.max(hi, a.count);
        });
        if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
        return { lo, hi };
    }, [shownArcs]);

    // 線の色から導出する派生色（ホットスポットのコア・グロー。world-map と同じ手法）
    const uniqueColors = useMemo(
        () => [...new Set(shownArcs.map((a) => a.color))],
        [shownArcs]
    );
    const derived = useMemo(() => {
        const out = new Map();
        uniqueColors.forEach((c, i) => {
            out.set(c, {
                index: i,
                core: tint(c, 0.72),
                glowInner: tint(c, 0.55),
                glowMid: tint(c, 0.2),
            });
        });
        return out;
    }, [uniqueColors]);

    // 凡例（カテゴリ or しきい値バンド）。件数は常に全アークで数える
    const legendItems = useMemo(() => {
        if (opts.colorMode === 'count') {
            return opts.countThresholds.map((b) => {
                const fromText = b.from === -Infinity ? '' : String(b.from);
                const toText = b.to === Infinity ? '' : String(b.to);
                const label = fromText === '' ? `〜${toText}` : toText === '' ? `${fromText}〜` : `${fromText}〜${toText}`;
                return { key: label, label, color: b.value };
            });
        }
        const seen = new Map();
        arcs.forEach((a) => {
            const name = a.category.trim() === '' ? '(未分類)' : a.category;
            const entry = seen.get(name) || { count: 0, color: colorForArc(a, opts) };
            entry.count += a.count > 0 ? a.count : 1;
            seen.set(name, entry);
        });
        return Array.from(seen.entries()).map(([name, e]) => ({
            key: name, label: name, color: e.color, count: e.count,
        }));
    }, [arcs, opts]);

    const totalCount = useMemo(
        () => arcs.reduce((s, a) => s + (a.count > 0 ? a.count : 1), 0),
        [arcs]
    );
    const shownCount = useMemo(
        () => shownArcs.reduce((s, a) => s + (a.count > 0 ? a.count : 1), 0),
        [shownArcs]
    );

    // 弧の線幅。world-map の arcWidth と同式（BASE + sqrt 正規化 × 3.2 × 強調度）
    const arcWidth = useCallback((count) => {
        const BASE = 0.9;
        if (opts.widthScale <= 0) return BASE;
        const { lo, hi } = countRange;
        const norm = hi > lo
            ? (Math.sqrt(Math.max(count, 0)) - Math.sqrt(Math.max(lo, 0)))
              / (Math.sqrt(Math.max(hi, 0)) - Math.sqrt(Math.max(lo, 0)))
            : 0.5;
        return BASE + Math.min(Math.max(norm, 0), 1) * 3.2 * opts.widthScale;
    }, [countRange, opts.widthScale]);

    // rAF ループから最新値を読むための ref（ループを張り直さない）
    const stateRef = useRef({ shownArcs, opts, mode, size, arcWidth });
    stateRef.current = { shownArcs, opts, mode, size, arcWidth };

    // --- WebGL: 球の描画 ---------------------------------------------------
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !size) return undefined;

        let gl = null;
        try {
            // 【透過3点セット】alpha:true + premultipliedAlpha:true。
            // シェーダは premultiplied で出力し、コンテナ CSS も transparent にする
            const attrs = { antialias: true, alpha: true, premultipliedAlpha: true };
            gl = canvas.getContext('webgl2', attrs);
        } catch (e) { /* 下で null 判定 */ }
        if (!gl) {
            setGlError('WebGL2 を利用できません（このブラウザ／環境では表示できません）');
            return undefined;
        }

        let prog;
        try {
            prog = buildProgram(gl);
        } catch (e) {
            setGlError(`シェーダの初期化に失敗しました: ${String(e.message || e).slice(0, 160)}`);
            return undefined;
        }
        setGlError(null);

        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.round(size.w * dpr));
        canvas.height = Math.max(1, Math.round(size.h * dpr));

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.useProgram(prog);
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        // 陸地テクスチャ（等距円筒。R=陸地, G=国境）
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const landCanvas = buildLandCanvas(stateRef.current.opts.textureSize);
        try {
            if (landCanvas) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, landCanvas);
                // ミップマップは使わない：日付変更線で uv.x の微分が飛び、
                // 縦一列だけ低解像度ミップが選ばれて「ぼやけた継ぎ目」が出るため
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            } else {
                // ラスタライズできない環境では 1x1 の海のみテクスチャで続行
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                    new Uint8Array([0, 0, 0, 255]));
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }
        } catch (e) { /* テクスチャ不能でも球自体は描く */ }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);         // 経度方向は周回
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const U = (n) => gl.getUniformLocation(prog, n);
        const uRes = U('uRes');
        const uRadius = U('uRadius');
        const uLambda = U('uLambda');
        const uPhi = U('uPhi');
        const uTexLoc = U('uTex');
        const uLandColor = U('uLandColor');
        const uOceanColor = U('uOceanColor');
        const uBorderColor = U('uBorderColor');
        const uBorders = U('uBorders');
        const uGraticule = U('uGraticule');
        const uAtmosphere = U('uAtmosphere');
        const uAtmColor = U('uAtmColor');
        const uShadeMode = U('uShadeMode');
        const uSunLon = U('uSunLon');
        const uBgColor = U('uBgColor');
        const uBgAlpha = U('uBgAlpha');
        gl.uniform1i(uTexLoc, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let prevNow = start;

        const frame = (now) => {
            if (gl.isContextLost && gl.isContextLost()) return;
            const st = stateRef.current;
            const o = st.opts;
            const view = viewRef.current;
            const dt = Math.min(((now || 0) - prevNow) / 1000, 0.1);
            prevNow = now || 0;
            const t = ((now || 0) - start) / 1000;

            // --- 視点の更新（慣性・自転） ---
            if (!view.dragging) {
                view.lambda += view.vx * dt;
                view.phi += view.vy * dt;
                view.vx *= Math.exp(-dt * 3.2);
                view.vy *= Math.exp(-dt * 3.2);
                const idleFor = (now || 0) - view.lastInteract;
                if (o.rotatePeriod > 0 && idleFor > 2500) {
                    view.lambda += (2 * Math.PI / o.rotatePeriod) * dt;
                }
            }
            view.phi = Math.min(Math.max(view.phi, -85 * DEG), 85 * DEG);

            const th = themeColors(st.mode);
            const land = parseColor(o.landColor || th.land) || parseColor(th.land);
            const ocean = parseColor(o.oceanColor || th.ocean) || parseColor(th.ocean);
            const border = parseColor(th.border);
            const atm = parseColor(th.atm);
            const bg = parseColor(o.bgColor || th.bg) || parseColor(th.bg);

            const radiusCss = 0.42 * Math.min(st.size.w, st.size.h) * view.zoom;
            const shadeVal = o.shadeMode === 'daynight' ? 2 : o.shadeMode === 'soft' ? 1 : 0;

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform2f(uRes, canvas.width, canvas.height);
            gl.uniform1f(uRadius, radiusCss * dpr);
            gl.uniform1f(uLambda, view.lambda);
            gl.uniform1f(uPhi, view.phi);
            gl.uniform3f(uLandColor, land.r, land.g, land.b);
            gl.uniform3f(uOceanColor, ocean.r, ocean.g, ocean.b);
            gl.uniform3f(uBorderColor, border.r, border.g, border.b);
            gl.uniform1f(uBorders, o.showBorders ? 0.9 : 0.0);
            gl.uniform1f(uGraticule, o.showGraticule ? 1.0 : 0.0);
            gl.uniform1f(uAtmosphere, o.atmosphere);
            gl.uniform3f(uAtmColor, atm.r, atm.g, atm.b);
            gl.uniform1f(uShadeMode, shadeVal);
            gl.uniform1f(uSunLon, (t / 120) * 2 * Math.PI);
            gl.uniform3f(uBgColor, bg.r, bg.g, bg.b);
            gl.uniform1f(uBgAlpha, o.transparentBg ? 0.0 : 1.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // --- SVG オーバーレイ（アーク・着弾点）の位置更新 ---
            updateOverlay(t);
            rafRef.current = requestAnimationFrame(frame);
        };

        // 光の帯（彗星）を 2D canvas に描く。world-map の ArcFlowCanvas と同じ
        // テーパーポリゴン方式：中心線サンプルの左右へ法線方向に張り出した
        // 多角形を 1 回で塗る（重ね塗りしないのでアルファが累積せず白飛びしない）
        const flowCanvas = flowCanvasRef.current;
        const flowCtx = flowCanvas ? flowCanvas.getContext('2d') : null;
        if (flowCanvas) {
            flowCanvas.width = Math.max(1, Math.round(size.w * dpr));
            flowCanvas.height = Math.max(1, Math.round(size.h * dpr));
        }

        const drawFlow = (ctx, pts, color, w, head) => {
            const band = [];
            for (let s = 0; s <= FLOW_SAMPLES; s += 1) {
                const u = s / FLOW_SAMPLES;     // 0=帯の先頭, 1=帯の末尾
                const p = pointOnPts(pts, head - u * FLOW_LEN);
                if (!p) continue;               // パス外・球の裏側は描かない
                band.push({ ...p, env: Math.sin(Math.PI * u) });
            }
            if (band.length < 2) return;
            const fillBand = (scale, alpha) => {
                ctx.beginPath();
                band.forEach((p, i) => {
                    const hw = w * scale * p.env;
                    if (i === 0) ctx.moveTo(p.x + p.nx * hw, p.y + p.ny * hw);
                    else ctx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
                });
                for (let i = band.length - 1; i >= 0; i -= 1) {
                    const p = band[i];
                    const hw = w * scale * p.env;
                    ctx.lineTo(p.x - p.nx * hw, p.y - p.ny * hw);
                }
                ctx.closePath();
                ctx.globalAlpha = alpha;
                ctx.fill();
            };
            ctx.save();
            ctx.fillStyle = color;
            fillBand(2.4, 0.18);   // 太く淡い同色グロー（柔らかい輪郭）
            fillBand(1.0, 0.9);    // 締まった芯
            ctx.restore();
        };

        // 到達リップル: 帯の先頭が終点を通過した直後、終点から細い輪を広げて消す
        const drawRipple = (ctx, end, color, w, head) => {
            if (head <= 1 || !end || !end.visible) return;
            const rt = Math.min((head - 1) / FLOW_LEN, 1);
            ctx.save();
            ctx.beginPath();
            ctx.arc(end.x, end.y, 2.5 + rt * (10 + w * 4), 0, Math.PI * 2);
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.5 + 1.4 * (1 - rt);
            ctx.globalAlpha = 0.5 * (1 - rt);
            ctx.stroke();
            ctx.restore();
        };

        // アーク・着弾点の位置をシェーダと同じ射影で更新する
        const updateOverlay = (t) => {
            const st = stateRef.current;
            const o = st.opts;
            const view = viewRef.current;
            const cx = st.size.w / 2;
            const cy = st.size.h / 2;
            const R = 0.42 * Math.min(st.size.w, st.size.h) * view.zoom;

            if (flowCtx) {
                flowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                flowCtx.clearRect(0, 0, st.size.w, st.size.h);
            }

            st.shownArcs.forEach((arc) => {
                const els = arcElsRef.current.get(arc.id);
                if (!els) return;
                const pts = projectArcPoints(arc.points3d, view.lambda, view.phi, cx, cy, R);
                const d = ptsToPath(pts);
                if (els.halo) els.halo.setAttribute('d', d);
                if (els.core) els.core.setAttribute('d', d);
                if (els.hit) els.hit.setAttribute('d', d);

                // 彗星。帯の末尾が終点を過ぎてから次周が始点に入るよう 1+FLOW_LEN 周期
                if (flowCtx && o.flowPeriod > 0) {
                    const w = st.arcWidth(arc.count);
                    const head = ((t / o.flowPeriod + arc.phase) % 1) * (1 + FLOW_LEN);
                    drawFlow(flowCtx, pts, arc.color, w, head);
                    drawRipple(flowCtx, pts[pts.length - 1], arc.color, w, head);
                }

                const spots = spotElsRef.current.get(arc.id);
                if (spots) {
                    const dv = worldToView(arc.dstVec, view.lambda, view.phi);
                    const ds = viewToScreen(dv, cx, cy, R);
                    const sv = worldToView(arc.srcVec, view.lambda, view.phi);
                    const ss = viewToScreen(sv, cx, cy, R);
                    const setSpot = (el, s, visOpacity) => {
                        if (!el) return;
                        el.setAttribute('cx', s.x);
                        el.setAttribute('cy', s.y);
                        el.setAttribute('opacity', s.visible ? visOpacity : '0');
                    };
                    setSpot(spots.glow, ds, '0.85');
                    setSpot(spots.core, ds, '1');
                    setSpot(spots.hit, ds, '1');
                    setSpot(spots.srcDot, ss, '0.9');
                    const labels = labelElsRef.current.get(arc.id);
                    if (labels) {
                        if (labels.srcText) {
                            labels.srcText.setAttribute('x', ss.x + 6);
                            labels.srcText.setAttribute('y', ss.y - 6);
                            labels.srcText.setAttribute('opacity', ss.visible ? '0.9' : '0');
                        }
                        if (labels.dstText) {
                            labels.dstText.setAttribute('x', ds.x + 6);
                            labels.dstText.setAttribute('y', ds.y - 6);
                            labels.dstText.setAttribute('opacity', ds.visible ? '0.9' : '0');
                        }
                    }
                }
            });
        };

        rafRef.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafRef.current);
    }, [size, opts.textureSize]);

    // --- 操作（ドラッグ回転・ホイールズーム・ダブルクリック復帰） ----------
    useEffect(() => {
        const el = hostRef.current;
        if (!el || !size || glError) return undefined;
        if (!opts.interactive) return undefined;

        let lastX = 0;
        let lastY = 0;
        let lastMoveT = 0;

        const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

        const onPointerDown = (e) => {
            const view = viewRef.current;
            view.dragging = true;
            view.vx = 0;
            view.vy = 0;
            view.lastInteract = nowMs();
            lastX = e.clientX;
            lastY = e.clientY;
            lastMoveT = nowMs();
            if (el.setPointerCapture && e.pointerId !== undefined) {
                try { el.setPointerCapture(e.pointerId); } catch (err) { /* 非対応環境 */ }
            }
        };
        const onPointerMove = (e) => {
            const view = viewRef.current;
            if (!view.dragging) return;
            const R = 0.42 * Math.min(size.w, size.h) * view.zoom;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            const dLambda = -(dx / R);
            const dPhi = dy / R;
            view.lambda += dLambda;
            view.phi = Math.min(Math.max(view.phi + dPhi, -85 * DEG), 85 * DEG);
            const t = nowMs();
            const dt = Math.max((t - lastMoveT) / 1000, 1 / 240);
            view.vx = dLambda / dt;
            view.vy = dPhi / dt;
            lastX = e.clientX;
            lastY = e.clientY;
            lastMoveT = t;
            view.lastInteract = t;
        };
        const onPointerUp = () => {
            const view = viewRef.current;
            view.dragging = false;
            view.lastInteract = nowMs();
        };
        const onWheel = (e) => {
            e.preventDefault();
            const view = viewRef.current;
            view.zoom = Math.min(Math.max(view.zoom * Math.exp(-e.deltaY * 0.0012), 1), 12);
            view.lastInteract = nowMs();
        };
        const onDblClick = () => {
            const view = viewRef.current;
            view.lambda = opts.centerLon * DEG;
            view.phi = opts.centerLat * DEG;
            view.zoom = opts.initialZoom;
            view.vx = 0;
            view.vy = 0;
            view.lastInteract = nowMs();
        };

        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerUp);
        el.addEventListener('pointerleave', onPointerUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        el.addEventListener('dblclick', onDblClick);
        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            el.removeEventListener('pointermove', onPointerMove);
            el.removeEventListener('pointerup', onPointerUp);
            el.removeEventListener('pointerleave', onPointerUp);
            el.removeEventListener('wheel', onWheel);
            el.removeEventListener('dblclick', onDblClick);
        };
    }, [size, glError, opts.interactive, opts.centerLon, opts.centerLat, opts.initialZoom]);

    // --- ドリルダウン（弧と着弾点をホストへ登録） --------------------------
    // 同じノードへの二重登録を防ぐ（オプション変更のたびに effect が走るため）。
    // payload は登録時のクロージャに固定せず、id で最新のアークを引く。
    // React はデータ更新後も同じ key の DOM ノードを再利用するため、
    // クロージャ固定だと「更新前の古い値」が飛ぶ（検証で実際に踏んだ）。
    const registeredNodesRef = useRef(new WeakSet());
    const arcsByIdRef = useRef(new Map());
    arcsByIdRef.current = new Map(shownArcs.map((a) => [a.id, a]));
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        const registered = registeredNodesRef.current;
        shownArcs.forEach((arcAtRegister) => {
            const els = arcElsRef.current.get(arcAtRegister.id);
            const spots = spotElsRef.current.get(arcAtRegister.id);
            const payload = () => {
                const arc = arcsByIdRef.current.get(arcAtRegister.id) || arcAtRegister;
                return {
                    'row.src_lat.value': arc.srcLat,
                    'row.src_lon.value': arc.srcLon,
                    'row.dst_lat.value': arc.dstLat,
                    'row.dst_lon.value': arc.dstLon,
                    'row.category.value': arc.category,
                    'row.count.value': arc.count,
                    'row.src_name.value': arc.srcName,
                    'row.dst_name.value': arc.dstName,
                    name: 'category',
                    value: arc.category || arc.dstName || String(arc.count),
                };
            };
            try {
                if (els && els.hit && !registered.has(els.hit)) {
                    addDrilldownListener({ node: els.hit, action: 'link.click', payloadCallback: payload });
                    registered.add(els.hit);
                }
                if (spots && spots.hit && !registered.has(spots.hit)) {
                    addDrilldownListener({ node: spots.hit, action: 'point.click', payloadCallback: payload });
                    registered.add(spots.hit);
                }
            } catch (e) { /* 未対応環境でも描画は続ける */ }
        });
    }, [shownArcs]);

    // rAF が管理する要素グループの callback ref は必ず安定化する
    const attachArcEls = useCallback((id, kind) => (el) => {
        if (!el) return;
        const entry = arcElsRef.current.get(id) || {};
        entry[kind] = el;
        arcElsRef.current.set(id, entry);
    }, []);
    const attachSpotEls = useCallback((id, kind) => (el) => {
        if (!el) return;
        const entry = spotElsRef.current.get(id) || {};
        entry[kind] = el;
        spotElsRef.current.set(id, entry);
    }, []);
    const attachLabelEls = useCallback((id, kind) => (el) => {
        if (!el) return;
        const entry = labelElsRef.current.get(id) || {};
        entry[kind] = el;
        labelElsRef.current.set(id, entry);
    }, []);

    // データが変わったら古い要素プールを掃除する（孤児参照を残さない）
    useEffect(() => {
        const ids = new Set(shownArcs.map((a) => a.id));
        [arcElsRef, spotElsRef, labelElsRef].forEach((ref) => {
            Array.from(ref.current.keys()).forEach((k) => {
                if (!ids.has(k)) ref.current.delete(k);
            });
        });
    }, [shownArcs]);

    const th = themeColors(mode);
    const fg = th.fg;
    const showTip = (arc) => (e) => {
        setTooltip({
            x: e.clientX,
            y: e.clientY,
            arc,
        });
    };
    const moveTip = (e) => {
        setTooltip((tip) => (tip ? { ...tip, x: e.clientX, y: e.clientY } : tip));
    };
    const hideTip = () => setTooltip(null);

    const animOn = opts.flowPeriod > 0;

    return (
        <div
            ref={attachHost}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                minHeight: 160,
                overflow: 'hidden',
                background: opts.transparentBg ? 'transparent' : (opts.bgColor || th.bg),
                fontFamily: 'Splunk Platform Sans, -apple-system, Segoe UI, Roboto, sans-serif',
                cursor: opts.interactive ? 'grab' : 'default',
                touchAction: 'none',
            }}
        >
            <canvas
                ref={canvasRef}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
            {glError && (
                <div style={{
                    position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    color: fg, fontSize: 13, textAlign: 'center', padding: 16,
                }}>
                    {glError}
                </div>
            )}
            {!glError && size && (
                <svg
                    width={size.w}
                    height={size.h}
                    viewBox={`0 0 ${size.w} ${size.h}`}
                    style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
                >
                    <defs>
                        {/* 弧の発光: ベース軌道をにじませてネオンの熱量を出す（world-map と同じ） */}
                        <filter id="agl-arc-glow" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="3.2" />
                        </filter>
                        {/* 色ごとのホットスポットグロー（線の色から導出・動的） */}
                        {uniqueColors.map((c) => {
                            const dv = derived.get(c);
                            return (
                                <radialGradient key={c} id={`agl-hot-${dv.index}`}>
                                    <stop offset="0%" stopColor={dv.glowInner} stopOpacity="0.95" />
                                    <stop offset="30%" stopColor={dv.glowMid} stopOpacity="0.55" />
                                    <stop offset="62%" stopColor={c} stopOpacity="0.22" />
                                    <stop offset="100%" stopColor={c} stopOpacity="0" />
                                </radialGradient>
                            );
                        })}
                    </defs>
                    {shownArcs.map((arc) => {
                        const w = arcWidth(arc.count);
                        const dv = derived.get(arc.color);
                        return (
                        <g key={arc.id}>
                            {/* ベース軌道。流れる彗星は上に重ねた canvas が担当。
                                軌道1: 太く柔らかい発光ハロー（熱をにじませる）
                                軌道2: 細い芯線（弧の存在を常に示す薄い実線）
                                アニメ時は軌道を控えめにして彗星を主役に、静的時は芯線を濃くする */}
                            <path
                                ref={attachArcEls(arc.id, 'halo')}
                                data-agl="halo"
                                fill="none"
                                stroke={arc.color}
                                strokeWidth={w * 2.4}
                                strokeLinecap="round"
                                opacity={animOn ? 0.14 : 0.28}
                                filter="url(#agl-arc-glow)"
                            />
                            <path
                                ref={attachArcEls(arc.id, 'core')}
                                data-agl="core"
                                fill="none"
                                stroke={arc.color}
                                strokeWidth={w * 0.7}
                                strokeLinecap="round"
                                opacity={animOn ? 0.3 : 0.75}
                            />
                            <circle
                                ref={attachSpotEls(arc.id, 'srcDot')}
                                data-agl="src-core"
                                r="2"
                                fill={dv.core}
                                pointerEvents="none"
                            />
                            {/* 着弾点: 放射グラデーションのグロー＋白寄りのコアドット */}
                            <circle
                                ref={attachSpotEls(arc.id, 'glow')}
                                data-agl="dst-glow"
                                r={14 + w * 2}
                                fill={`url(#agl-hot-${dv.index})`}
                                pointerEvents="none"
                            />
                            <circle
                                ref={attachSpotEls(arc.id, 'core')}
                                data-agl="dst-core"
                                r="2.5"
                                fill={dv.core}
                                pointerEvents="none"
                            />
                            {/* 透明な当たり判定。ツールチップとドリルダウンの受け口 */}
                            <circle
                                ref={attachSpotEls(arc.id, 'hit')}
                                data-agl="dst-hit"
                                r="12"
                                fill="transparent"
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={showTip(arc)}
                                onMouseMove={moveTip}
                                onMouseLeave={hideTip}
                            />
                            {opts.showPointNames && arc.srcName !== '' && (
                                <text
                                    ref={attachLabelEls(arc.id, 'srcText')}
                                    fill={fg}
                                    fontSize="10"
                                    pointerEvents="none"
                                    style={{ paintOrder: 'stroke', stroke: opts.transparentBg ? 'none' : (opts.bgColor || th.bg), strokeWidth: 2.4 }}
                                >
                                    {arc.srcName}
                                </text>
                            )}
                            {opts.showPointNames && arc.dstName !== '' && (
                                <text
                                    ref={attachLabelEls(arc.id, 'dstText')}
                                    fill={fg}
                                    fontSize="10"
                                    pointerEvents="none"
                                    style={{ paintOrder: 'stroke', stroke: opts.transparentBg ? 'none' : (opts.bgColor || th.bg), strokeWidth: 2.4 }}
                                >
                                    {arc.dstName}
                                </text>
                            )}
                            {/* 当たり判定（太い透明ストローク）。ドリルダウンはこのパスに登録する */}
                            <path
                                ref={attachArcEls(arc.id, 'hit')}
                                data-agl="arc-hit"
                                fill="none"
                                stroke="transparent"
                                strokeWidth={Math.max(w * 3, 10)}
                                strokeLinecap="round"
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={showTip(arc)}
                                onMouseMove={moveTip}
                                onMouseLeave={hideTip}
                            />
                        </g>
                        );
                    })}
                </svg>
            )}
            {/* 流れる光の帯（彗星）。SVG の上・オーバーレイ UI の下。
                pointer-events: none なのでホバー/クリックは下の SVG に届く */}
            {!glError && size && (
                <canvas
                    ref={flowCanvasRef}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                    }}
                />
            )}
            {!glError && opts.titleText.trim() !== '' && (
                <div style={{
                    position: 'absolute', top: 10, left: 14,
                    color: fg, fontSize: 13, fontWeight: 700,
                    letterSpacing: '0.22em', opacity: 0.9,
                    pointerEvents: 'none', textTransform: 'uppercase',
                }}>
                    {opts.titleText}
                </div>
            )}
            {!glError && opts.showLegend && legendItems.length > 0 && (
                <div style={{
                    position: 'absolute', left: 14, bottom: 12,
                    display: 'flex', flexDirection: 'column', gap: 4,
                    color: fg, fontSize: 11, pointerEvents: 'none',
                    background: mode === 'dark' ? 'rgba(3,7,13,0.55)' : 'rgba(245,248,251,0.7)',
                    borderRadius: 6, padding: '8px 10px', maxWidth: '46%',
                }}>
                    <div style={{ opacity: 0.75, marginBottom: 2 }}>
                        {shownCount < totalCount
                            ? `表示 ${shownCount.toLocaleString()} / 全 ${totalCount.toLocaleString()} 件`
                            : `全 ${totalCount.toLocaleString()} 件`}
                    </div>
                    {legendItems.map((item) => (
                        <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                                width: 10, height: 10, borderRadius: '50%',
                                background: item.color, flex: 'none',
                            }} />
                            <span style={{
                                overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}>
                                {item.label}
                            </span>
                            {item.count !== undefined && (
                                <span style={{ marginLeft: 'auto', opacity: 0.7, paddingLeft: 10 }}>
                                    {item.count.toLocaleString()}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {!glError && tooltip && (
                <div style={{
                    position: 'fixed',
                    left: tooltip.x + 12,
                    top: tooltip.y + 12,
                    background: mode === 'dark' ? 'rgba(6,12,20,0.92)' : 'rgba(255,255,255,0.95)',
                    color: fg,
                    border: `1px solid ${mode === 'dark' ? '#2c3e55' : '#c5d2df'}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 11,
                    pointerEvents: 'none',
                    zIndex: 10,
                    maxWidth: 260,
                }}>
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>
                        {(tooltip.arc.srcName || `${tooltip.arc.srcLat.toFixed(1)}, ${tooltip.arc.srcLon.toFixed(1)}`)}
                        {' → '}
                        {(tooltip.arc.dstName || `${tooltip.arc.dstLat.toFixed(1)}, ${tooltip.arc.dstLon.toFixed(1)}`)}
                    </div>
                    {tooltip.arc.category !== '' && <div>{tooltip.arc.category}</div>}
                    <div style={{ opacity: 0.75 }}>{tooltip.arc.count.toLocaleString()} 件</div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function AttackGlobeVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const { arcs, missingFields } = useMemo(
        () => parseArcs(fieldNames, rows, opts),
        [fieldNames, rows, opts]
    );

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) {
        return <MessageState message="データがありません。サーチ結果を確認してください。" />;
    }
    if (arcs === null) {
        return (
            <MessageState
                message="データがありません。サーチ結果を確認してください。"
                sub={`必須フィールドが見つかりません: ${missingFields.join(', ')}（編集画面の「データフィールド」で列を指定できます）`}
            />
        );
    }
    if (arcs.length === 0) {
        return (
            <MessageState
                message="データがありません。サーチ結果を確認してください。"
                sub="緯度・経度として解釈できる行がありません。"
            />
        );
    }

    return <AttackGlobe arcs={arcs} opts={opts} mode={mode} />;
}

function App() {
    const themeContext = useTheme();
    const theme = themeContext?.theme || 'light';
    const colorScheme = theme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <AttackGlobeVisualization mode={colorScheme} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了を待ってからマウントする（マウントゲート）
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
