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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Liquid Tube — 試験管型の液体ゲージ（WebGL フラグメントシェーダ）
//
// サーチ結果の1行 = 試験管1本。値に応じて液面の高さが変わる。
// ガラス・液体・気泡はすべて1枚のフラグメントシェーダで描く:
//   - 形状は SDF（符号付き距離関数）
//   - ガラス/液体の透過は Beer-Lambert（背景に透過率を掛ける）
//   - 縁の輝きはフレネル項
//   - 気泡は個体差＋時間変化で形が揺らぐ
//
// 【WebGL の実機確認済み事項】（2026-08-02 検証。詳細は
//  .claude/skills/splunk-viz/references/webgl-in-custom-viz.md）
//   - Splunk のカスタム viz iframe 内で **webgl2 が使える**
//   - GLSL ES 3.00 がそのままコンパイル・リンクできる
//   - 62fps 出る（RTX 5080 / ANGLE D3D11 環境）
// ---------------------------------------------------------------------------

const VIZ_VERSION = 'liquid-tube 1.0.0';

// --- シェーダ ---------------------------------------------------------------
const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// 試験管を1本だけ描く。
//
// 【設計】1 viz = 1 本。ダッシュボードに置くのはせいぜい数個で、
// 1 viz に複数本を詰めると管が細くなり質感（屈折・肉厚）が潰れるため。
// 複数並べたい場合はパネルを複数置く。
//
// 【透過】uBgAlpha=0 のとき、管の外側は alpha=0 で出力してダッシュボードの
// 背景を透かす。premultiplied alpha で出すため色にも alpha を掛ける。
// 気泡ループの上限（GLSL のループは定数上限が要る）。
// オプションの「気泡の数」はこの範囲内で可変にする。
const MAX_BUBBLES = 40;
const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  uRes;
uniform float uTime;
uniform float uLevel;              // 液面 0..1
uniform vec3  uColor;              // 液体色
uniform float uOpacity;            // 液体の濃さ
uniform float uBubbles;            // 気泡の数
uniform vec3  uBgColor;            // 背景色（不透過時）
uniform float uBgAlpha;            // 0=透過 / 1=背景色で塗る
uniform float uGlow;               // 管の外側のグロー強度（0で消える）
uniform float uTubeW;              // 管の太さ（画面高さに対する比）
// 【単位に注意】uTop/uBottom は **uv 空間**（縦が -0.5..0.5）で渡す。
// クリップ座標(-1..1)を渡すと管が 2 倍の高さになり画面に収まらない。
uniform float uTop;                // 管の上端（uv 空間 -0.5..0.5）
uniform float uBottom;             // 管の下端（同上）

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// 滑らかな1次元ノイズ（気泡の形をゆっくり変える。乱数のままだとチラつく）
float vnoise(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), f);
}

// 丸底のカプセル
float sdCapsule(vec2 p, float h, float r) {
    p.y -= clamp(p.y, -h, h);
    return length(p) - r;
}
// 上端を平らに切った試験管（真横から見た形）
float sdTube(vec2 p, float h, float r) {
    return max(sdCapsule(p, h, r), p.y - h);
}

float surfaceAt(float x, float baseY, float t) {
    return baseY
        + sin(x * 16.0 + t * 1.6) * 0.0055
        + sin(x * 27.0 - t * 2.2) * 0.0026
        + sin(x * 41.0 + t * 3.1) * 0.0012;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

    // --- 試験管の配置（1本） ---------------------------------------------
    // uTop / uBottom は「管の外形（グローを除く）が収まるべき範囲」。
    //
    // 【重要】試験管は **上下非対称** な形をしている:
    //   ・上端（口）は平ら          → ローカル座標で +H
    //   ・下端（丸底）は R だけ出る → ローカル座標で -(H + R)
    // さらに外壁は肉厚 WALL のぶん外側に描かれる。
    //
    // midY=(uTop+uBottom)/2 を中心に「上下対称」として逆算すると、
    // 実際には上下に (H+R+WALL) ずつ広がって **span の 1.21 倍**に膨らみ、
    // 下へはみ出す（開発中に実際に踏んだ。パネルが大きいほど悪化する）。
    //
    // ここでは「外壁を含めた実際の上端・下端」が uTop/uBottom に一致するよう
    // 正しく逆算する:
    //   実上端 = cy + H + WALL          = uTop
    //   実下端 = cy - (H + R + WALL)    = uBottom
    //   辺々引いて  span = 2H + R + 2*WALL  →  H = (span - R - 2*WALL) / 2
    //   中心      cy = uTop - H - WALL
    float halfW = (uRes.x / uRes.y) * 0.5;
    float R = min(uTubeW, halfW * 0.82);
    float span = max(uTop - uBottom, 0.05);
    // 肉厚は太さから決まる（下の WALL と同じ式。H の逆算に必要なので先に出す）
    float WALL = max(R * 0.09, 0.004);
    // 直管部の半分の高さ。span から丸底(R)と肉厚(2*WALL)を差し引く
    float H = max((span - R - 2.0 * WALL) * 0.5, 0.02);
    // 管の中心（ローカル原点）。外壁の上端が uTop に一致する位置に置く
    float cy = uTop - H - WALL;
    vec2 p = vec2(uv.x, uv.y - cy);

    float RIM_H = R * 0.19;

    float level = uLevel;
    vec3 liquidCol = uColor;

    // --- 背景 -------------------------------------------------------------
    // 透過時は「色は黒・不透明度0」から始め、描いた部分だけ alpha を立てる
    vec3 col = uBgColor * uBgAlpha;
    float alpha = uBgAlpha;

    float dIn  = sdTube(p, H, R);
    float dOut = sdTube(p, H, R + WALL);

    float baseY = mix(-H - R, H - 0.02, clamp(level, 0.0, 1.0));
    float surfaceY = surfaceAt(p.x, baseY, uTime);

    // 縁への近さ（SDF ベース。丸底でも正しく効く）
    float rOuter = R + WALL;
    float curve = clamp(-dOut / max(rOuter, 1e-4), 0.0, 1.0);
    curve = sqrt(clamp(curve * (2.0 - curve), 0.0, 1.0));
    float nx = clamp(p.x / rOuter, -1.0, 1.0);
    vec3 N = normalize(vec3(nx, 0.20, max(curve, 0.001)));
    float fres = pow(1.0 - max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0), 4.0);

    float edgeAA = fwidth(dOut) * 1.2 + 1e-5;

    // --- 管の外側: 液体のにじみ（外部グロー） ---
    if (dOut > edgeAA) {
        // uGlow=0 で外部グローを完全に消せる。
        // 透過モードでは alpha も 0 になるので、管の外は完全な素通しになる。
        float g = exp(-dOut * 20.0);
        float nearLiquid = smoothstep(surfaceY + 0.10, surfaceY - 0.30, p.y);
        float glowA = g * (0.10 + 0.32 * nearLiquid) * uGlow;
        col += liquidCol * glowA;
        alpha = max(alpha, glowA);
        outColor = vec4(col, clamp(alpha, 0.0, 1.0));
        return;
    }

    // --- 管の内部 ---------------------------------------------------------
    float refr = nx * nx * nx * 0.055;
    float uvyR = p.y + refr * 0.35;
    float surfaceR = surfaceAt(p.x, baseY, uTime);

    bool inGlassWall = dIn > 0.0;
    bool inLiquid = uvyR < surfaceR;

    // 【重要】管の内側を「不透明な黒」で埋めてはいけない。
    //
    // ガラスも液体も**透明体**なので、alpha=1.0 で塗りつぶして透かす先を
    // 暗色で近似するのは物理的に誤り。実測: 赤い液体は R が 70% 透過するのに、
    // 透かす先が真っ黒だとその寄与が 0.014（ほぼ 0）に潰れ、全体が暗く沈む。
    //
    // 正しくは **canvas の alpha をそのまま使う**。alpha を下げれば
    // ブラウザが合成してくれるので、**本物のダッシュボード背景が透ける**
    // （iframe から背景を読む必要がない。合成はブラウザの仕事）。
    //
    // behind は「不透過モードのときの背景色」としてのみ使う。
    // 透過モードでは黒(=寄与ゼロ)にし、代わりに alpha を下げて素通しにする。
    vec3 behind = uBgColor * uBgAlpha;

    if (inLiquid) {
        // Beer-Lambert による透過 ＋ 液体自身の散乱光。
        //
        // 【重要】散乱項を liquidCol * (1.0 - T) にしてはいけない（色相が反転する）:
        //   吸収係数 sigma は「液体色の補色ほど大きい」ので、
        //   指定色の主要チャンネル（赤い液体なら R）は sigma が最小 → T が最大。
        //   そこへ (1-T) を掛けると **主要チャンネルが最も小さくなる**。
        //   実測: #ff5a2e（赤）が #50592e（オリーブ）になる。
        //   背景がほぼ黒だと透過光はほぼ 0 で、この散乱項が見た目の全てを決める。
        //
        // 正しくは散乱光を「液体色そのもの」に比例させる。
        // 濃さ（uOpacity）と光路長で **強度** は変えるが、**色相は保つ**。
        float depth = clamp((surfaceR - uvyR) / (2.0 * H + R), 0.0, 1.0);
        float thickness = curve;
        float pathLen = (depth * 1.6 + thickness * 0.9) * mix(0.35, 3.2, uOpacity);
        vec3 sigma = (vec3(1.0) - liquidCol) * 2.6 + 0.15;
        vec3 T = exp(-sigma * pathLen);

        // 液体がどれだけ「詰まっているか」（スカラー。色相を歪めない）。
        // uOpacity は密度へ直接 0.25〜1.0 で効かせる（pathLen 経由だけだと
        // 実測で最小 0.55／最大 0.98 とほぼ変化せず、スライダーが効かない）。
        float density = (1.0 - exp(-pathLen * 0.85)) * mix(0.25, 1.0, uOpacity);
        // 奥ほど濃く見える（深さで少し暗く落とす）
        float shade = mix(1.15, 0.78, depth);
        vec3 scattered = liquidCol * density * shade * (0.60 + 0.40 * thickness);
        col = behind * T + scattered;

        // 液体の不透明度は「散乱でどれだけ光を遮ったか」で決まる。
        // density が低い（＝薄い液体）ほど背景が透ける。
        // 不透過モード（uBgAlpha=1）では常に 1.0。
        alpha = mix(clamp(density * 0.92 + 0.08, 0.0, 1.0), 1.0, uBgAlpha);

        // 底に光が溜まる
        float glow = exp(-abs(p.y - (-H - R * 0.75)) * 8.0);
        col += liquidCol * glow * 0.80;
        col += vec3(1.0) * pow(glow, 3.0) * 0.10;

        // 気泡（個体差＋時間変化で形が揺らぐ）
        int nb = int(uBubbles);
        for (int i = 0; i < ${MAX_BUBBLES}; i++) {
            if (i >= nb) break;
            float fi = float(i);
            float sizeRand = pow(hash(fi * 7.9), 1.8);
            float br = (0.0022 + sizeRand * 0.0072) * (R / 0.155);
            float speed = 0.035 + sizeRand * 0.13 + hash(fi * 3.1) * 0.02;
            float ph = fract(hash(fi * 5.3) + uTime * speed);
            float bx = (hash(fi * 1.7) - 0.5) * 2.0 * R * 0.80;
            bx += sin(ph * 9.0 + fi * 2.3) * (0.004 + sizeRand * 0.010);
            float byPos = mix(-H - R * 0.88, surfaceR - 0.004, ph);

            vec2 bp = p - vec2(bx, byPos);
            float t1 = uTime * (0.35 + hash(fi * 11.3) * 0.5) + fi * 3.7;
            float t2 = uTime * (0.28 + hash(fi * 13.7) * 0.4) + fi * 6.1;
            float squash = 1.0 + sizeRand * 0.40 + (vnoise(t1) - 0.5) * 0.55;
            float ang = (hash(fi * 17.1) - 0.5) * 2.0 + (vnoise(t2) - 0.5) * 1.2;
            float ca = cos(ang), sa = sin(ang);
            bp = mat2(ca, -sa, sa, ca) * bp;
            bp.y *= squash;
            float bd = length(bp);
            float theta = atan(bp.y, bp.x);
            float wob = sin(theta * 3.0 + t1 * 2.0) * 0.055
                      + sin(theta * 5.0 - t2 * 1.6) * 0.030;
            bd *= 1.0 - wob * (0.4 + sizeRand * 0.9);

            if (bd < br * 2.4) {
                vec2 bn = bp / max(br, 1e-5);
                float r01 = clamp(bd / br, 0.0, 1.0);
                float z = sqrt(max(0.0, 1.0 - r01 * r01));
                float fresB = pow(1.0 - z, 3.0);
                float inside = smoothstep(br, br * 0.92, bd);
                col = mix(col, mix(col * 1.6 + vec3(0.04), col, 0.35), inside * 0.55);
                float rimBias = 0.55 + 0.45 * clamp(-bn.y, -1.0, 1.0);
                col += vec3(0.80, 0.95, 0.88) * smoothstep(0.55, 1.0, fresB) * inside * rimBias * 1.15;
                col *= mix(1.0, 0.72, smoothstep(0.5, 1.0, fresB) * smoothstep(0.0, 0.7, bn.y) * inside);
                col += vec3(1.0) * smoothstep(0.30, 0.0, length(bn - vec2(-0.34, -0.40))) * inside * 0.85;
                col += liquidCol * smoothstep(0.26, 0.0, length(bn - vec2(0.20, 0.46))) * inside * 0.55;
            }
        }

        // メニスカス（液面の盛り上がり）
        float dSurf = surfaceR - uvyR;
        col += liquidCol * smoothstep(0.016, 0.0, abs(dSurf)) * 0.55;
        col += vec3(0.85, 1.0, 0.92) * smoothstep(0.0038, 0.0, abs(dSurf)) * (0.55 + 0.45 * curve) * 0.85;
    } else {
        // 液面より上の空洞＝「空気 + ガラス2枚」。ほぼ素通しにする。
        // ここは何も入っていないので、背景がはっきり見えるのが正しい。
        col = behind * vec3(0.88, 0.92, 0.96);
        col *= mix(0.55, 1.0, curve);
        float above = smoothstep(0.16, 0.0, uvyR - surfaceR);
        // 液面からの照り返し（ここは実際に光っているので不透明度を上げる）
        float bounce = above * above * 0.30
                     + smoothstep(0.045, 0.0, uvyR - surfaceR) * 0.22;
        col += liquidCol * bounce;
        // 空気部分の不透明度: 素通し。ただし
        //   - 縁に近いほどガラスを斜めに通るので少し曇る
        //   - 液面直上の照り返しぶんは見えている
        float glassHaze = (1.0 - curve) * 0.30;
        alpha = mix(clamp(glassHaze + bounce * 1.6, 0.0, 1.0), 1.0, uBgAlpha);
    }

    // --- 側壁のガラス ---
    if (inGlassWall) {
        float t = clamp(dIn / WALL, 0.0, 1.0);
        col *= exp(-vec3(0.55, 0.42, 0.38) * (t * 1.4 + (1.0 - curve) * 1.1));
        col += vec3(0.5, 0.7, 1.0) * fres * 0.35;
        // 側壁のガラスも透明体。厚みと反射のぶんだけ不透明になる。
        // 縁ほど視線がガラスを長く通るので濃く見える（＝alpha が上がる）。
        float wallA = 0.35 + (1.0 - curve) * 0.45 + fres * 0.5;
        alpha = mix(clamp(max(alpha, wallA), 0.0, 1.0), 1.0, uBgAlpha);
    }

    // --- 口のふち（リム）＝ ガラスの帯 ---
    float rimTop = H;
    float rimBot = H - RIM_H;
    float inRimY = smoothstep(rimBot - 0.004, rimBot + 0.002, p.y)
                 * smoothstep(rimTop + 0.002, rimTop - 0.002, p.y);
    float inRimX = smoothstep(R + WALL + 0.002, R + WALL - 0.002, abs(p.x));
    float rimBand = inRimY * inRimX;
    if (rimBand > 0.001) {
        float acrossY = clamp((p.y - rimBot) / max(RIM_H, 1e-4), 0.0, 1.0);
        float roll = sin(acrossY * 3.14159);
        vec3 rimT = exp(-vec3(0.55, 0.42, 0.38) * ((1.0 - curve) * 1.9 + roll * 0.7));
        col = behind * rimT;
        col += vec3(0.55, 0.68, 0.85) * pow(1.0 - curve, 2.6) * 0.55;
        col += vec3(0.60, 0.72, 0.90) * roll * curve * 0.42;
        float lip = smoothstep(0.0045, 0.0, abs(p.y - rimTop)) * inRimX;
        col += vec3(0.95, 0.98, 1.0) * lip * (0.30 + 0.60 * curve);
        col *= mix(1.0, 0.70, smoothstep(0.0035, 0.0, abs(p.y - rimBot)) * inRimX);
        // ふちも厚いガラス。素通しではないが完全不透明でもない。
        // 肉厚が最も厚い帯の中央と、切り口のハイライトで濃くなる。
        float rimA = 0.55 + roll * 0.30 + (1.0 - curve) * 0.25 + lip * 0.6;
        alpha = mix(clamp(max(alpha, rimA * rimBand), 0.0, 1.0), 1.0, uBgAlpha);
    }

    // --- ガラス表面のスペキュラ ---
    // 反射光は「そこで実際に光っている」ので、透過モードでも
    // その分だけ alpha を上げないと見えなくなる（ハイライトが消える）。
    float subSurf = inLiquid ? 0.45 : 1.0;
    float sp1 = smoothstep(R * 0.19, 0.0, abs(p.x + R * 0.52))
              * smoothstep(H, -H * 0.9, p.y) * 0.40 * subSurf;
    float sp2 = smoothstep(R * 0.08, 0.0, abs(p.x - R * 0.62))
              * smoothstep(H, -H * 0.5, p.y) * 0.20 * subSurf;
    float rim = fres * 0.55;
    col += vec3(1.0) * sp1;
    col += vec3(0.9, 0.95, 1.0) * sp2;
    col += vec3(0.55, 0.75, 1.0) * rim;
    alpha = mix(clamp(alpha + sp1 + sp2 + rim, 0.0, 1.0), 1.0, uBgAlpha);

    // --- 外形のアンチエイリアス（背景へ滑らかに溶かす） ---
    float cover = smoothstep(edgeAA, -edgeAA, dOut);
    vec3 outsideCol = uBgColor * uBgAlpha;
    float outsideA = uBgAlpha;
    {
        float g = exp(-max(dOut, 0.0) * 20.0);
        float nearLiquid = smoothstep(surfaceY + 0.10, surfaceY - 0.30, p.y);
        float glowA = g * (0.10 + 0.32 * nearLiquid) * uGlow;
        outsideCol += liquidCol * glowA;
        outsideA = max(outsideA, glowA);
    }
    col = mix(outsideCol, col, cover);
    alpha = mix(outsideA, alpha, cover);

    alpha = clamp(alpha, 0.0, 1.0);
    // premultiplied alpha で出力（canvas は premultipliedAlpha: true）
    outColor = vec4(col * alpha, alpha);
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

// editor.threshold から届く [{from,to,value}] を正規化。
// openRanges:true なので from/to は null（開いた範囲）でありうる → ±Infinity へ。
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

// ホストは既定値と同じ値を options に載せないため、未設定時は schema の
// default と同じ内容をここで再現する
const DEFAULT_BANDS = [
    { from: -Infinity, to: 60, value: '#3ddc84' },
    { from: 60, to: 85, value: '#e6b93c' },
    { from: 85, to: Infinity, value: '#ff5a2e' },
];
const DEFAULT_SERIES = ['#3ddc84', '#38a6ff', '#a06cff', '#e6b93c', '#ff5a2e'];

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

const toNumber = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
};

// 複数行を1つの値に畳む集計。gauge-arc / icon-status と同じ語彙を使う。
const AGGREGATIONS = ['last', 'first', 'sum', 'avg', 'max', 'min', 'count'];

function aggregate(values, how) {
    if (values.length === 0) return null;
    switch (how) {
        case 'first': return values[0];
        case 'sum': return values.reduce((a, b) => a + b, 0);
        case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
        case 'max': return Math.max(...values);
        case 'min': return Math.min(...values);
        case 'count': return values.length;
        case 'last':
        default: return values[values.length - 1];
    }
}

/**
 * サーチ結果を **試験管1本ぶんの値** に変換する。
 * 列の決定: columnSelector の選択が最優先。未設定なら
 * 「最初の文字列列＝ラベル / 最初の数値列＝値」で自動判定する。
 *
 * 1 viz = 1 本なので、複数行は集計して1値に畳む
 * （集計方法は「集計」オプション。既定は最終行）。
 */
function parseTube(fieldNames, rows, opts) {
    if (rows.length === 0) return { tube: null, missing: false };

    // 自動判定: 数値に見える列を値、それ以外の最初の列をラベルに使う
    const first = rows[0] || [];
    let autoValue = -1;
    let autoLabel = -1;
    for (let i = 0; i < fieldNames.length; i += 1) {
        const isNum = toNumber(first[i]) !== null;
        if (isNum && autoValue < 0) autoValue = i;
        if (!isNum && autoLabel < 0) autoLabel = i;
    }
    if (autoValue < 0) return { tube: null, missing: true };
    if (autoLabel < 0) autoLabel = -1; // ラベル列が無くても値だけで描ける

    const iLabel = resolveFieldIndex(opts.labelField, fieldNames, rows, autoLabel);
    const iValue = resolveFieldIndex(opts.valueField, fieldNames, rows, autoValue);
    if (iValue < 0) return { tube: null, missing: true };

    // 数値として解釈できた行だけを集める（不正値は捨てる）
    const values = [];
    let lastLabelRow = -1;
    rows.forEach((row, i) => {
        const v = toNumber(row[iValue]);
        if (v === null) return;
        values.push(v);
        lastLabelRow = i;
    });
    if (values.length === 0) return { tube: null, missing: false };

    const value = aggregate(values, opts.aggregation);
    // ラベルは「集計したのに特定行の名前を出す」と誤解を招くので、
    // 集計が last/first 以外なら列名（またはユーザー指定のタイトル）を優先する。
    let label = '';
    if (iLabel >= 0) {
        if (opts.aggregation === 'first') label = String(rows[0]?.[iLabel] ?? '');
        else if (opts.aggregation === 'last') label = String(rows[lastLabelRow]?.[iLabel] ?? '');
        else label = String(fieldNames[iValue] ?? '');
    } else {
        label = String(fieldNames[iValue] ?? '');
    }
    return { tube: { id: 0, label, value }, missing: false };
}

// ---------------------------------------------------------------------------
// オプション正規化
// ---------------------------------------------------------------------------
const COLOR_MODES = ['threshold', 'series'];

function normalizeOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const bands = normalizeBands(o.colorBands);
    const series = Array.isArray(o.seriesColors)
        ? o.seriesColors.filter((c) => parseColor(c) !== null)
        : [];
    return {
        labelField: o.labelField,
        valueField: o.valueField,
        aggregation: AGGREGATIONS.includes(o.aggregation) ? o.aggregation : 'last',
        minValue: num(o.minValue, 0),
        maxValue: num(o.maxValue, 100),
        colorMode: COLOR_MODES.includes(o.colorMode) ? o.colorMode : 'threshold',
        colorBands: bands.length > 0 ? bands : DEFAULT_BANDS,
        seriesColors: series.length > 0 ? series : DEFAULT_SERIES,
        transparentBg: bool(o.transparentBg, true),
        // 未設定のときは空文字にして「テーマ既定」を示す。
        // ホストは既定値と同じ値を options に載せないため、ここで色を
        // 決め打ちするとライトテーマでも黒い背景になってしまう。
        bgColor: parseColor(o.bgColor) !== null ? o.bgColor : '',
        liquidOpacity: clamp(num(o.liquidOpacity, 0.45), 0, 1),
        bubbleCount: Math.round(clamp(num(o.bubbleCount, 18), 0, 40)),
        animSpeed: clamp(num(o.animSpeed, 1), 0, 3),
        showLabel: bool(o.showLabel, true),
        showValue: bool(o.showValue, true),
        valueUnit: typeof o.valueUnit === 'string' ? o.valueUnit : '%',
        valueDecimals: Math.round(clamp(num(o.valueDecimals, 0), 0, 4)),
        labelSize: clamp(num(o.labelSize, 14), 8, 32),
        // 管の外側のグロー。0 で完全に消える
        glow: clamp(num(o.glow, 1), 0, 2),
        // 管の太さ（画面高さに対する比）
        tubeWidth: clamp(num(o.tubeWidth, 0.155), 0.05, 0.35),
    };
}

// 値 → 色。threshold は「下限以上・上限未満」
function colorForTube(tube, opts) {
    if (opts.colorMode === 'series') {
        // 1本なのでパレットの先頭を使う（複数色は「しきい値」モードで表現する）
        return parseColor(opts.seriesColors[0]) || parseColor('#3ddc84');
    }
    const band = opts.colorBands.find((b) => tube.value >= b.from && tube.value < b.to);
    return (band ? parseColor(band.value) : null) || parseColor('#3ddc84');
}

// テーマ既定の背景色（bgColor 未設定時）。
// ライトテーマで黒くならないようにテーマごとに変える。
function defaultBgColor(mode) {
    return mode === 'dark' ? '#03070d' : '#eef2f7';
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

function MessageState({ message }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message"><Paragraph>{message}</Paragraph></div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
function LiquidTube({ tube, opts, mode }) {
    const canvasRef = useRef(null);
    const [attachHost, hostRef, size] = useContainerSize();
    const [glError, setGlError] = useState(null);
    const rafRef = useRef(0);
    const hitRef = useRef(null);

    const fmt = (v) => v.toFixed(opts.valueDecimals);
    const valueText = `${fmt(tube.value)}${opts.valueUnit}`;

    // --- ラベル/値の占有量から管の上下端を決める -------------------------
    // 【設計意図】ラベルを上端・値を下端に
    // 貼り付けて（space-between）管との間が空いていたため。
    // ここでラベルの高さぶんだけを避けた「管の縦範囲」を計算し、
    // ラベルはその管のすぐ外側に置く。
    const layout = useMemo(() => {
        const h = size ? size.h : 400;
        // 余白の設計:
        //   - タイトルと管の隙間を詰める（labelGap）
        //   - 値は管の「下」に置く。丸底とグローが下端で切れないよう、
        //     管の下端に余白（bottomClear）を確保する
        const padTop = 2;
        const padBottom = 4;
        const labelGap = 2;          // タイトルと管の隙間（従来は実質 6px 以上空いていた）
        const valueGap = 4;          // 管と値の隙間
        // グロー（exp(-d*20)）と丸底のアンチエイリアスぶんの逃げ
        const glowClear = opts.glow > 0 ? 10 : 4;

        const labelH = opts.showLabel ? Math.round(opts.labelSize * 1.35) : 0;
        const valueFont = opts.labelSize * 1.3;
        const valueH = opts.showValue ? Math.round(valueFont * 1.35) : 0;

        // px → シェーダの uv 空間へ変換する。
        //
        // 【重要】シェーダは uv = (gl_FragCoord - 0.5*res) / res.y なので、
        // **画面の縦は -0.5 .. +0.5（幅 1.0）** しかない。クリップ座標（-1..1）
        // をそのまま渡すと管が 2 倍の高さになり、画面に収まらず
        // 「途中しか見えない」状態になる。
        const toUv = (py) => 0.5 - py / h;
        const topPx = padTop + labelH + (labelH > 0 ? labelGap : 0);
        const botPx = h - padBottom - valueH - (valueH > 0 ? valueGap : 0) - glowClear;
        return {
            labelH,
            valueH,
            valueFont,
            topPx,
            botPx,
            top: toUv(topPx),
            bottom: toUv(botPx),
        };
    }, [size, opts.showLabel, opts.showValue, opts.labelSize, opts.glow]);

    // rAF ループから最新値を読むための ref（ループを張り直さない）
    const stateRef = useRef({ tube, opts, layout, mode });
    stateRef.current = { tube, opts, layout, mode };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !size) return undefined;

        let gl = null;
        try {
            // 【透過】alpha: true ＋ premultipliedAlpha: true。
            // alpha:false だと canvas が不透明になり背景を透かせない。
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

        const U = (n) => gl.getUniformLocation(prog, n);
        const uRes = U('uRes');
        const uTime = U('uTime');
        const uLevel = U('uLevel');
        const uColor = U('uColor');
        const uOpacity = U('uOpacity');
        const uBubbles = U('uBubbles');
        const uBgColor = U('uBgColor');
        const uBgAlpha = U('uBgAlpha');
        const uGlow = U('uGlow');
        const uTubeW = U('uTubeW');
        const uTop = U('uTop');
        const uBottom = U('uBottom');

        // premultiplied alpha に合わせたブレンド
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        const frame = (now) => {
            if (gl.isContextLost && gl.isContextLost()) return;
            const st = stateRef.current;
            const o = st.opts;

            const span = o.maxValue - o.minValue;
            const lv = span === 0 ? 0.5 : (st.tube.value - o.minValue) / span;
            const c = colorForTube(st.tube, o);
            const bgHex = o.bgColor || defaultBgColor(st.mode);
            const bg = parseColor(bgHex) || { r: 0, g: 0, b: 0 };
            const t = ((now || 0) - start) / 1000 * o.animSpeed;

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform2f(uRes, canvas.width, canvas.height);
            gl.uniform1f(uTime, t);
            gl.uniform1f(uLevel, Math.min(Math.max(lv, 0), 1));
            gl.uniform3f(uColor, c.r, c.g, c.b);
            gl.uniform1f(uOpacity, o.liquidOpacity);
            gl.uniform1f(uBubbles, o.bubbleCount);
            gl.uniform3f(uBgColor, bg.r, bg.g, bg.b);
            gl.uniform1f(uBgAlpha, o.transparentBg ? 0.0 : 1.0);
            gl.uniform1f(uGlow, o.glow);
            gl.uniform1f(uTubeW, o.tubeWidth);
            gl.uniform1f(uTop, st.layout.top);
            gl.uniform1f(uBottom, st.layout.bottom);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            rafRef.current = requestAnimationFrame(frame);
        };
        rafRef.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafRef.current);
    }, [size]);

    // --- ドリルダウン ---
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        const node = hitRef.current;
        if (!node) return;
        try {
            addDrilldownListener({
                node,
                action: 'point.click',
                payloadCallback: () => ({
                    'row.label.value': tube.label,
                    'row.value.value': tube.value,
                    name: 'label',
                    value: tube.label,
                }),
            });
        } catch (e) { /* 未対応環境でも描画は続ける */ }
    }, [tube.label, tube.value]);

    const fg = mode === 'dark' ? '#e8eef6' : '#1a2634';
    const shadow = mode === 'dark' ? '0 1px 3px rgba(0,0,0,0.8)' : 'none';

    return (
        <div
            ref={attachHost}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                minHeight: 120,
                overflow: 'hidden',
                // 透過時はコンテナも透明にする（ここを塗ると canvas の透過が無意味になる）
                background: opts.transparentBg ? 'transparent' : (opts.bgColor || defaultBgColor(mode)),
                fontFamily: 'Splunk Platform Sans, -apple-system, Segoe UI, Roboto, sans-serif',
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
            {/* クリック当たり判定（ドリルダウン）。パネル全体を対象にする */}
            {!glError && (
                <div
                    ref={hitRef}
                    style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
                    aria-label={`${tube.label}: ${valueText}`}
                />
            )}
            {/* ラベル（管のすぐ上）と値（管のすぐ下）。
                管の縦範囲は layout で確定しているので、その外側に密着させる。 */}
            {/* タイトル: 管のすぐ上（layout.topPx が管の上端）*/}
            {!glError && opts.showLabel && (
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 2,
                    height: layout.labelH,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: fg,
                    fontSize: opts.labelSize,
                    fontWeight: 600,
                    lineHeight: 1,
                    textShadow: shadow,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    padding: '0 8px',
                    pointerEvents: 'none',
                }}>
                    {tube.label}
                </div>
            )}
            {/* 値: 管の下端（layout.botPx）より下に置く。
                管の丸底やグローと重ならないよう、layout 側で余白を確保している。 */}
            {!glError && opts.showValue && size && (
                <div style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: layout.botPx + 4,
                    height: layout.valueH,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: fg,
                    fontSize: layout.valueFont,
                    fontWeight: 700,
                    lineHeight: 1,
                    textShadow: shadow,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                }}>
                    {valueText}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function LiquidTubeVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const { tube, missing } = useMemo(
        () => parseTube(fieldNames, rows, opts),
        [fieldNames, rows, opts]
    );

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) {
        return <MessageState message="データがありません。サーチ結果を確認してください。" />;
    }
    if (missing) {
        return <MessageState message="数値の列が見つかりません（編集画面の「データフィールド」で値の列を指定することもできます）。" />;
    }
    if (!tube) {
        return <MessageState message="表示できる数値がありません。サーチ結果を確認してください。" />;
    }

    return <LiquidTube tube={tube} opts={opts} mode={mode} />;
}

function App() {
    const themeContext = useTheme();
    const theme = themeContext?.theme || 'light';
    const colorScheme = theme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <LiquidTubeVisualization mode={colorScheme} />
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
