// ── 手描き画材の実描画（クレヨン／色鉛筆／水彩／インク）─────────
//
// **なぜ CSS をやめたか**（2026-08-13）:
// v1.6.0 の手描き4テーマは `repeating-linear-gradient` と `box-shadow` で
// 質感を「それっぽく」見せていたが、CSS が作れるのは**直線・等間隔・均一な太さ**
// だけで、実際の画材の本質——
//   - 中心線がふらつく（手の震え）
//   - 筆圧で濃さと太さが変わる
//   - 紙の目に顔料が乗り切らずかすれる
//   - 縁を二度なぞるので線が重なる
// ——を一つも表現できない。ユーザーから「小手先の CSS で、理想とは遠い」と
// 指摘されたのはこの構造的な限界そのもの。
//
// **方針**: 形の「ゆらぎ」は rough.js（MIT）に任せ、
// 画材固有の「乗り方」（重ね塗り・かすれ・紙の目）は自前で描く。
//
// ⚠ **すべて決定的（seed 固定）にする。** 乱数をそのまま使うと
//   React の再描画のたびに絵が変わり、画面がチラつく。
//   seed はパネル ID から作る（同じパネルは常に同じ絵）。
//
// ── 試作で分かった「効かなかった方法」（再発防止）──────────────
//  1. **紙の目を `destination-in` で抜く** … 下地が暗い盤面では
//     「黒い裂け目」に見える。**紙の色で上から散らす**のが正しい
//  2. **四角いセルのノイズを敷き詰める** … デジタルなノイズ／QR コード状に
//     見える。**丸い凹みをまばらに・薄く**（density 0.08 前後）
//  3. **短い区間を `lineCap:'round'` で並べてかすれを作る** … 区間ごとに
//     丸い錠剤が並ぶ。**パスは切らず `lineCap:'butt'` で連続**させ、
//     かすれは「細く薄い線を多数重ねる」ことで出す
//  4. **rough.js の hachure で面を塗る** … 直線なので落書きに見える。
//     面塗りは自前のうねるストロークで作る
//  5. **同じ点列に太さ違いを3本重ねて線を作る** … 節のある「竹」に見える。
//     **パスごとに点を少しずらす**と1本の太い線に溶ける

import rough from 'roughjs';

/** 決定的な擬似乱数（xorshift32）。同じ seed なら必ず同じ列を返す。 */
export function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
}

/** 文字列（パネル ID 等）から安定した seed を作る。 */
export function seedFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
        h ^= String(str).charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * 紙の目（tooth）。**顔料が乗らなかった凹み**を紙の色で散らす。
 *
 * ⚠ 透明に抜かない（`destination-in`）。暗い盤面で黒い裂け目になる。
 * ⚠ 濃くしない。density 0.25 を超えるとデジタルなノイズに見える。
 */
export function applyTooth(g, w, h, { density = 0.08, seed = 1, paper = '#1a1a1a' } = {}) {
    const r = rng(seed);
    const n = Math.round((w * h * density) / 10);
    g.save();
    g.fillStyle = paper;
    for (let i = 0; i < n; i++) {
        g.globalAlpha = 0.08 + r() * 0.22;
        g.beginPath();
        g.arc(r() * w, r() * h, 0.6 + r() * 1.4, 0, Math.PI * 2);
        g.fill();
    }
    g.restore();
}

/**
 * 画材で「面を塗る」。細く薄いストロークを多数重ねる。
 *
 * ⚠ `lineCap` は **butt**（round にすると錠剤が並んで見える）。
 * ⚠ パスを途中で切らない（切れ目に丸が付く）。かすれは本数と濃度で作る。
 */
export function fillStrokes(g, x, y, w, h, color, seed, opts = {}) {
    const { angle = -18, gap = 3.2, width = 5, alpha = 0.14, jitter = 7 } = opts;
    if (w <= 0 || h <= 0) return;
    const r = rng(seed);
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.strokeStyle = color;
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    const rad = (angle * Math.PI) / 180;
    const diag = Math.hypot(w, h);
    const cx = x + w / 2;
    const cy = y + h / 2;
    for (let d = -diag / 2; d < diag / 2; d += gap * (0.6 + r() * 0.9)) {
        g.lineWidth = width * (0.6 + r() * 0.9);
        g.globalAlpha = alpha * (0.4 + r() * 1.3);
        const phase = r() * 6.28;
        const steps = 26;
        g.beginPath();
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const along = -diag / 2 + t * diag;
            // 大きなうねり（手の動き）＋細かい震え
            const off =
                d + Math.sin(t * 4.5 + phase) * jitter * 0.5 + Math.sin(t * 13 + phase * 2) * jitter * 0.14;
            const px = cx + Math.cos(rad) * along - Math.sin(rad) * off;
            const py = cy + Math.sin(rad) * along + Math.cos(rad) * off;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
        }
        g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
}

/**
 * 画材で「線を引く」。太さ違いを重ねて1本に見せる。
 *
 * ⚠ **パスごとに点をずらす**。同じ点列に重ねると節のある「竹」になる。
 */
export function strokePath(g, rc, pts, color, seed, opts = {}) {
    const { width = 6, alpha = 0.5, roughness = 2 } = opts;
    if (!Array.isArray(pts) || pts.length < 2) return;
    const r = rng(seed);
    const passes = [
        { w: width, a: alpha * 0.8, ro: roughness * 1.1, s: seed },
        { w: width * 0.6, a: alpha, ro: roughness * 0.9, s: seed + 101 },
        { w: width * 0.3, a: alpha * 0.7, ro: roughness * 0.7, s: seed + 202 },
    ];
    for (const p of passes) {
        const jittered = pts.map(([px, py]) => [px + (r() - 0.5) * 3.5, py + (r() - 0.5) * 3.5]);
        g.globalAlpha = p.a;
        rc.curve(jittered, {
            stroke: color,
            strokeWidth: p.w,
            roughness: p.ro,
            bowing: 1.2,
            seed: p.s,
        });
    }
    g.globalAlpha = 1;
}

/**
 * 画材で「枠を描く」。二度なぞる（クレヨン・鉛筆の癖）。
 */
export function strokeRect(g, rc, x, y, w, h, color, seed, opts = {}) {
    const { width = 4, alpha = 0.5, roughness = 2.8, passes = 2 } = opts;
    if (w <= 0 || h <= 0) return;
    // ⚠ **辺が長いほどゆらぎを弱める。**
    //   rough.js の `bowing` は辺の長さに比例して弓なりになるので、
    //   固定値のままだと横長のパネルで**辺が大きく内側にたわむ**
    //   （実機で確認。幅 780px のパネルで顕著だった）。
    //   実際の手描きも「長い線ほど相対的にはまっすぐ」なので、
    //   基準（240px）より長い辺では roughness/bowing を落とす。
    const scale = Math.min(1, Math.sqrt(240 / Math.max(60, Math.min(w, h) + Math.max(w, h) * 0.35)));
    const ro = roughness * scale;
    const bow = 1.6 * scale;
    for (let i = 0; i < passes; i++) {
        g.globalAlpha = alpha * (1 - i * 0.18);
        rc.rectangle(x, y, w, h, {
            stroke: color,
            strokeWidth: width * (1 - i * 0.35),
            roughness: ro,
            bowing: bow,
            seed: seed + i * 37,
        });
    }
    g.globalAlpha = 1;
}

/** 画材ごとの既定パラメータ。テーマ名（プリセット）から引く。 */
export const MEDIUM_PRESETS = {
    // クレヨン／オイルパステル：太く・不透明寄り・かすれ強め
    crayon: {
        fill: { gap: 3.0, width: 5.5, alpha: 0.16, jitter: 8 },
        frame: { width: 5, alpha: 0.5, roughness: 2.8, passes: 2 },
        line: { width: 8, alpha: 0.55, roughness: 2.2 },
        tooth: 0.09,
    },
    // 色鉛筆：細く・薄く・ハッチングが見える
    pencil: {
        fill: { gap: 2.4, width: 2.6, alpha: 0.12, jitter: 5 },
        frame: { width: 2.4, alpha: 0.55, roughness: 2.2, passes: 2 },
        line: { width: 4, alpha: 0.5, roughness: 1.8 },
        tooth: 0.07,
    },
    // 水彩：うんと薄く・広く・にじむ（線は細い）
    watercolor: {
        fill: { gap: 4.5, width: 12, alpha: 0.07, jitter: 10 },
        frame: { width: 2, alpha: 0.4, roughness: 2.4, passes: 1 },
        line: { width: 5, alpha: 0.4, roughness: 1.6 },
        tooth: 0.05,
    },
    // インク＋水彩：線はくっきり1本、塗りは水彩
    inkwash: {
        fill: { gap: 4.5, width: 11, alpha: 0.07, jitter: 10 },
        frame: { width: 2.2, alpha: 0.7, roughness: 1.8, passes: 1 },
        line: { width: 3.5, alpha: 0.7, roughness: 1.4 },
        tooth: 0.05,
    },
};

/** そのプリセットが手描き画材かどうか。 */
export function isHandDrawn(preset) {
    return Object.prototype.hasOwnProperty.call(MEDIUM_PRESETS, preset);
}

/** rough.js の canvas ラッパを作る（呼び出し側で使い回す）。 */
export function roughCanvas(canvas) {
    return rough.canvas(canvas);
}
