// ── Brush の実装（描画ライブラリはこのファイルに閉じる）──────────
//
// ⚠⚠ **rough.js を import してよいのはこのファイルだけ。**
//   公開 API（`BrushPath`）には特定ライブラリの語彙を出さない。
//   実装を替えても viz 側が 1 行も変わらないようにするため。
//
// ## 画材ごとの性格（パネル枠の `MEDIUM_PRESETS` と揃えてある）
//
// 同じ「水彩」を選んだのに**枠は水彩・グラフは別物**では意味がないので、
// 線幅・不透明度の関係を枠側の定義と対応させている。
//
// | 画材 | 線 | 塗り | 特徴 |
// |---|---|---|---|
// | crayon | 太い・不透明寄り | 粗いハッチ | かすれ・二度塗り |
// | pencil | 細い・薄い | 細かいハッチ | クロスハッチが見える |
// | watercolor | 細い | 広く薄い | にじみ・縁の溜まり |
// | ink | くっきり 1 本 | 少なめ | 輪郭が強い |
// | marker | 太い・均一 | ベタ寄り | かすれが少ない |
// ────────────────────────────────────────────────────────────────

// ⚠ **`handDrawn.js` と同じ形で import する**（`'roughjs'`）。
//   パスを変えると webpack が別モジュールとして解決し、**rough.js が二重に入る**
import rough from 'roughjs';

import { ROLE } from './types.js';

// generator は DOM を持たない（canvas も svg も要らない）。
// ⚠ モジュールスコープで 1 個だけ作る。呼ぶたびに生成すると無駄
const gen = rough.generator();

/**
 * 画材のパラメータ。
 *
 * ⚠ 値は「枠（`MEDIUM_PRESETS`）との整合」を優先して決めてある。
 *   単独で調整すると同じテーマ内で枠とグラフの質感がずれる。
 */
// ⚠⚠ **値は実測で決めた**（2026-08-13）。控えめだと「ただの線」に見える。
//
// 幅 1500px・14 点の折れ線で「元の座標からの最大ずれ」を測った結果:
//   roughness 2.6 / bowing 2.0 → **5.4px**（実機で見て「効いていない」）
//   roughness 6.0 / bowing 4.0 → 18.4px（手描きと分かる）
//   roughness 8.0 / bowing 6.0 → 29.1px（値が読めなくなる）
//
// **手描きの質感は「露骨に効かせないと普通のグラフに見える」**
// （パネル枠でも同じ結論に達している）。ただし**値の可読性が上限**を決める。
// 目安として最大ずれ 15〜20px 程度に収めてある。
const BRUSH_PARAMS = {
    crayon: {
        line: { width: 4.5, opacity: 0.9, roughness: 4.5, bowing: 3.0, passes: 2 },
        fill: { style: 'hachure', gap: 4, weight: 2.2, opacity: 0.62, roughness: 2.6 },
    },
    pencil: {
        line: { width: 2.0, opacity: 0.85, roughness: 4.0, bowing: 2.6, passes: 2 },
        fill: { style: 'hachure', gap: 2.8, weight: 1.2, opacity: 0.55, roughness: 2.2 },
    },
    watercolor: {
        line: { width: 3.4, opacity: 0.6, roughness: 5.0, bowing: 3.4, passes: 2 },
        fill: { style: 'solid', gap: 6, weight: 1, opacity: 0.55, roughness: 2.4 },
    },
    ink: {
        line: { width: 2.2, opacity: 0.95, roughness: 3.2, bowing: 2.2, passes: 1 },
        fill: { style: 'hachure', gap: 4.0, weight: 1.3, opacity: 0.5, roughness: 1.8 },
    },
    marker: {
        line: { width: 6.0, opacity: 0.7, roughness: 2.6, bowing: 1.8, passes: 1 },
        fill: { style: 'solid', gap: 5, weight: 1, opacity: 0.6, roughness: 1.6 },
    },
};

/** 実装がある画材の一覧（`flat` は含まない＝再生成しないため）。 */
export const BRUSH_IDS = Object.keys(BRUSH_PARAMS);

/** rough.js の drawable → BrushPath[]（ライブラリの語彙をここで捨てる）。
 *
 * ⚠ **塗りと輪郭で不透明度を分ける。** 同じ値を両方に当てると、
 *   塗りに合わせた薄い値が輪郭にも効いて**バーが色を失う**（実機で発生）。
 *   輪郭は「形を決める線」なので濃いままにする。
 */
function toBrushPaths(drawable, { width, opacity, color, strokeOpacity }) {
    return gen.toPaths(drawable).map((p) => {
        // ⚠ rough.js の set 種別（fillSketch / fillPath / path）を**外に出さない**。
        //   「塗りのための線か、輪郭か」だけに畳む
        const isFill = p.fill && p.fill !== 'none';
        const isFillStroke = !isFill && Number(p.strokeWidth) < 1;
        const fillLike = isFill || isFillStroke;
        return {
            d: p.d,
            role: fillLike ? ROLE.FILL : ROLE.STROKE,
            width: isFill ? 0 : Number(p.strokeWidth) || width,
            opacity: fillLike ? opacity : (strokeOpacity ?? opacity),
            color: color ?? undefined,
            // 塗り path は fill、線 path は stroke で描く
            filled: Boolean(isFill),
        };
    });
}

/**
 * 折れ線を画材で描く。
 *
 * @param points  [[x,y], …]（元の座標。**変換しない**）
 * @param seed    決定論的 seed（`seedFor` で作る）
 * @param brushId 画材の識別子
 * @returns BrushPath[]
 */
export function brushLine(points, seed, brushId) {
    const cfg = BRUSH_PARAMS[brushId];
    if (!cfg || !Array.isArray(points) || points.length < 2) return [];
    const { width, opacity, roughness, bowing, passes } = cfg.line;
    const out = [];
    for (let i = 0; i < passes; i += 1) {
        // ⚠ **重ね描きは seed をずらす**（同じ seed だと完全に重なって 1 本に見える）。
        //   ずらし方も決定的にする（乱数を使わない）
        // ⚠ **重ね描きで seed を大きくずらさない**（実機で確認）。
        //   ずらしすぎると 2 本が別の線に見え、**系列同士が混ざって値が読めない**。
        //   実際の画材の二度塗りも「ほぼ同じ線を薄くなぞる」動き。
        //   → seed は同じにし、**roughness を落として細く薄く**重ねる。
        const d = gen.curve(points, {
            seed,
            roughness: roughness * (i === 0 ? 1 : 0.35),
            bowing: bowing * (i === 0 ? 1 : 0.5),
            strokeWidth: width * (i === 0 ? 1 : 0.45),
        });
        for (const p of toBrushPaths(d, {
            width: width * (i === 0 ? 1 : 0.45),
            opacity: opacity * (i === 0 ? 1 : 0.45),
        })) {
            // 2 本目以降は「重ね描き」＝品質で落としてよい
            out.push(i === 0 ? p : { ...p, role: ROLE.ACCENT });
        }
    }
    return out;
}

/**
 * 閉じた面（エリア・棒）を画材で塗る。
 *
 * @param points [[x,y], …] 閉じた輪郭
 */
export function brushArea(points, seed, brushId, color) {
    const cfg = BRUSH_PARAMS[brushId];
    if (!cfg || !Array.isArray(points) || points.length < 3) return [];
    const f = cfg.fill;
    // ⚠ **面の roughness は線より弱くする。** 面の輪郭が大きくふらつくと
    //   「にじみ」ではなく**ギザギザの多角形**に見える（ドーナツで実機確認）。
    const d = gen.polygon(points, {
        seed,
        fill: color,
        fillStyle: f.style,
        fillWeight: f.weight,
        hachureGap: f.gap,
        roughness: f.roughness * 0.55,
        // ⚠ 輪郭は線の側で描くので、面では**輪郭を出さない**
        //   （二重に出ると太く見え、塗りの縁が濁る）
        stroke: 'none',
    });
    return toBrushPaths(d, { width: 0, opacity: f.opacity, strokeOpacity: f.opacity, color });
}

/** 矩形（棒グラフ 1 本）を画材で塗る。 */
export function brushRect(x, y, w, h, seed, brushId, color) {
    const cfg = BRUSH_PARAMS[brushId];
    if (!cfg || !(w > 0) || !(h > 0)) return [];
    const f = cfg.fill;
    const d = gen.rectangle(x, y, w, h, {
        seed,
        fill: color,
        fillStyle: f.style,
        fillWeight: f.weight,
        hachureGap: f.gap,
        roughness: f.roughness,
        stroke: color,
        strokeWidth: cfg.line.width * 0.6,
    });
    // 輪郭は線の不透明度を使う（塗りの薄さを輪郭に持ち込まない）
    return toBrushPaths(d, {
        width: cfg.line.width * 0.6,
        opacity: f.opacity,
        strokeOpacity: cfg.line.opacity,
        color,
    });
}

/**
 * 円弧（ドーナツの扇形）を画材で塗る。
 *
 * ⚠ **SVG の `A`（円弧）コマンドは rough.js に渡せない**ので、
 *   **点列に標本化してから多角形として塗る**。分割数は弧長で決める
 *   （固定分割だと小さい扇形が粗くなり、大きい扇形がカクつく）。
 *
 * @param cx,cy   中心
 * @param rOuter  外半径 / rInner 内半径（0 なら円グラフ）
 * @param a0,a1   開始角・終了角（ラジアン。12 時方向が 0、時計回り）
 */
export function brushArc(cx, cy, rOuter, rInner, a0, a1, seed, brushId, color) {
    const cfg = BRUSH_PARAMS[brushId];
    if (!cfg || !(rOuter > 0) || !(a1 > a0)) return [];
    // 弧長 ≒ r * 角度。おおむね 12px ごとに 1 点（最小 4・最大 48）
    const steps = Math.max(4, Math.min(48, Math.round(((a1 - a0) * rOuter) / 12)));
    const pts = [];
    const at = (a, rad) => [cx + Math.sin(a) * rad, cy - Math.cos(a) * rad];
    for (let i = 0; i <= steps; i += 1) pts.push(at(a0 + ((a1 - a0) * i) / steps, rOuter));
    if (rInner > 0) {
        for (let i = steps; i >= 0; i -= 1) pts.push(at(a0 + ((a1 - a0) * i) / steps, rInner));
    } else {
        pts.push([cx, cy]);
    }
    return brushArea(pts, seed, brushId, color);
}

/** その画材が実装されているか。 */
export function hasBrush(brushId) {
    return Object.prototype.hasOwnProperty.call(BRUSH_PARAMS, brushId);
}
