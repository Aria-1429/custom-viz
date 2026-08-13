import React, { useEffect, useRef } from 'react';

import { rng as hdRng, roughCanvas } from './handDrawn';

// ── DPX 背景レイヤ ───────────────────────────────────────────────
// definition.style.background で選ぶ装飾背景。パネルの後ろ（z:0）に敷く。
// canvas 系はタブ非表示中に描画を止める。
// パフォーマンス指針: 面積比例の半透明塗り（blur/SMIL）は使わない
// （viz-performance.md の実測知見に従う）。
// ────────────────────────────────────────────────────────────────

// ⚠ ラベルは短い名前だけにする（説明を括弧で足さない）。
//   グループ見出し（アニメーション／パターン／…）が既に性質を語っているので、
//   括弧書きは一覧を長くするだけだった。
export const BACKGROUND_OPTIONS = [
    { value: 'none', label: 'なし' },
    // 動くもの
    { value: 'particles', label: 'パーティクル', group: 'アニメーション' },
    { value: 'constellation', label: 'コンステレーション', group: 'アニメーション' },
    { value: 'starfield', label: '星空', group: 'アニメーション' },
    { value: 'rain', label: 'データレイン', group: 'アニメーション' },
    { value: 'meteor', label: '流星', group: 'アニメーション' },
    { value: 'ripple', label: 'リップル', group: 'アニメーション' },
    { value: 'wave', label: 'ウェーブ', group: 'アニメーション' },
    { value: 'radar', label: 'レーダー', group: 'アニメーション' },
    { value: 'bubbles', label: 'バブル', group: 'アニメーション' },
    { value: 'snow', label: 'スノー', group: 'アニメーション' },
    { value: 'fireflies', label: 'ホタル', group: 'アニメーション' },
    // 幾何パターン
    { value: 'grid', label: 'グリッド', group: 'パターン' },
    { value: 'graphPaper', label: '方眼', group: 'パターン' },
    { value: 'isometric', label: 'アイソメ', group: 'パターン' },
    { value: 'dots', label: 'ドット', group: 'パターン' },
    { value: 'halftone', label: 'ハーフトーン', group: 'パターン' },
    { value: 'diagonal', label: 'ストライプ', group: 'パターン' },
    { value: 'chevron', label: 'シェブロン', group: 'パターン' },
    { value: 'scanlines', label: 'スキャンライン', group: 'パターン' },
    { value: 'hex', label: 'ヘックス', group: 'パターン' },
    { value: 'circuit', label: '回路基板', group: 'パターン' },
    { value: 'topo', label: '等高線', group: 'パターン' },
    { value: 'weave', label: 'クロスハッチ', group: 'パターン' },
    { value: 'laid', label: 'レイド紙', group: 'パターン' },
    { value: 'blueprintFrame', label: '図面枠', group: 'パターン' },
    { value: 'carbonFiber', label: 'カーボン繊維', group: 'パターン' },
    // 手描き（canvas で実描画。CSS では作れない「紙と画材」の質感）
    { value: 'paperTooth', label: '紙の目', group: '手描き' },
    { value: 'sketchGrid', label: '手描きの方眼', group: '手描き' },
    { value: 'crayonScribble', label: 'クレヨンの塗り', group: '手描き' },
    { value: 'pencilHatch', label: '鉛筆のハッチング', group: '手描き' },
    { value: 'inkSplatter', label: 'インクの飛沫', group: '手描き' },
    // 光・にじみ
    { value: 'glow', label: 'グロー', group: 'グラデーション' },
    { value: 'aurora', label: 'オーロラ', group: 'グラデーション' },
    { value: 'spotlight', label: 'スポットライト', group: 'グラデーション' },
    { value: 'vignette', label: 'ビネット', group: 'グラデーション' },
    { value: 'cornerGlow', label: 'コーナーグロー', group: 'グラデーション' },
    { value: 'thermalScan', label: 'サーマル', group: 'グラデーション' },
    { value: 'washBlooms', label: '水彩のにじみ', group: 'グラデーション' },
    { value: 'sunbeam', label: '斜光', group: 'グラデーション' },
];

function useCanvasScene(draw) {
    const canvasRef = useRef(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const ctx = canvas.getContext('2d');
        let raf = 0;
        let state = null;
        let frame = 0;

        const resize = () => {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            state = draw.init(canvas);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        const tick = () => {
            raf = requestAnimationFrame(tick);
            if (document.hidden || !state) return;
            frame += 1;
            draw.frame(ctx, canvas, state, frame);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [draw]);
    return canvasRef;
}

function Canvas({ scene }) {
    const ref = useCanvasScene(scene);
    return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

const makeParticles = (accent, connect) => ({
    init: (canvas) => {
        const count = Math.min(connect ? 70 : 90, Math.round((canvas.width * canvas.height) / (connect ? 26000 : 22000)));
        return Array.from({ length: count }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.8 + 0.6,
            vx: (Math.random() - 0.5) * 0.25,
            vy: (Math.random() - 0.5) * 0.2,
            a: Math.random() * 0.5 + 0.15,
        }));
    },
    frame: (ctx, canvas, dots) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const d of dots) {
            d.x += d.vx;
            d.y += d.vy;
            if (d.x < 0) d.x = canvas.width;
            if (d.x > canvas.width) d.x = 0;
            if (d.y < 0) d.y = canvas.height;
            if (d.y > canvas.height) d.y = 0;
        }
        if (connect) {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 0.6;
            for (let i = 0; i < dots.length; i++) {
                for (let j = i + 1; j < dots.length; j++) {
                    const dx = dots[i].x - dots[j].x;
                    const dy = dots[i].y - dots[j].y;
                    const dist2 = dx * dx + dy * dy;
                    if (dist2 < 16000) {
                        ctx.globalAlpha = (1 - dist2 / 16000) * 0.22;
                        ctx.beginPath();
                        ctx.moveTo(dots[i].x, dots[i].y);
                        ctx.lineTo(dots[j].x, dots[j].y);
                        ctx.stroke();
                    }
                }
            }
        }
        ctx.fillStyle = accent;
        for (const d of dots) {
            ctx.globalAlpha = d.a;
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },
});

const makeRain = (accent) => ({
    init: (canvas) => {
        const count = Math.min(120, Math.round(canvas.width / 14));
        return Array.from({ length: count }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            len: Math.random() * 18 + 6,
            v: Math.random() * 2.2 + 0.8,
            a: Math.random() * 0.35 + 0.1,
        }));
    },
    frame: (ctx, canvas, drops) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        for (const d of drops) {
            d.y += d.v;
            if (d.y > canvas.height + d.len) {
                d.y = -d.len;
                d.x = Math.random() * canvas.width;
            }
            ctx.globalAlpha = d.a;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x, d.y + d.len);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

const makeRipple = (accent) => ({
    init: (canvas) => ({
        w: canvas.width,
        h: canvas.height,
        rings: Array.from({ length: 5 }, (_, i) => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: (i / 5) * 300,
            max: Math.random() * 200 + 200,
        })),
    }),
    frame: (ctx, canvas, s) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2;
        for (const ring of s.rings) {
            ring.r += 0.7;
            if (ring.r > ring.max) {
                ring.r = 0;
                ring.x = Math.random() * canvas.width;
                ring.y = Math.random() * canvas.height;
                ring.max = Math.random() * 200 + 200;
            }
            ctx.globalAlpha = Math.max(0, 0.28 * (1 - ring.r / ring.max));
            ctx.beginPath();
            ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

const makeWave = (accent) => ({
    init: (canvas) => ({ w: canvas.width, h: canvas.height }),
    frame: (ctx, canvas, s, frame) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2;
        const lines = 4;
        for (let l = 0; l < lines; l++) {
            ctx.globalAlpha = 0.1 + l * 0.03;
            ctx.beginPath();
            const baseY = canvas.height * (0.35 + l * 0.14);
            const amp = 24 + l * 10;
            const speed = frame * (0.006 + l * 0.001);
            for (let x = 0; x <= canvas.width; x += 8) {
                const y = baseY + Math.sin(x * 0.006 + speed) * amp + Math.sin(x * 0.013 - speed * 1.4) * (amp * 0.4);
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

// 星空：奥行きの違う3層を別々の速さで流す（視差）。
// ⚠ シーンの契約は `init(canvas) -> state` と `frame(ctx, canvas, state)`。
//    他のシーン（makeRain 等）と同じ形にすること（別の形で書いて動かなかった）。
// ⚠ 「面積に比例する塗り」を作らない。点は 0.5〜1.4px なので
//    パネル数が増えても raster コストがほぼ増えない（viz-performance.md §2）
const makeStarfield = (accent) => ({
    init: (canvas) => {
        const count = Math.min(150, Math.round(canvas.width / 11));
        return Array.from({ length: count }, () => {
            const layer = Math.floor(Math.random() * 3); // 0=遠い 〜 2=近い
            return {
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: 0.5 + layer * 0.45,
                v: 0.08 + layer * 0.16,
                a: 0.22 + layer * 0.2,
            };
        });
    },
    frame: (ctx, canvas, stars) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = accent;
        for (const s of stars) {
            s.x -= s.v;
            // 左端を越えたら右へ戻す（縦位置も振り直して同じ軌跡の反復に見せない）
            if (s.x < -2) {
                s.x = canvas.width + 2;
                s.y = Math.random() * canvas.height;
            }
            ctx.globalAlpha = s.a;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },
});

// 流星：斜めに走る短い光跡。まばらに出しては消える。
// ⚠ 常時全部が走っていると「雨」になる。**待ち時間（wait）を挟んで疎らにする**のが肝。
const makeMeteor = (accent) => ({
    init: (canvas) => {
        const spawn = (immediate) => ({
            x: Math.random() * canvas.width * 1.3 - canvas.width * 0.15,
            y: Math.random() * canvas.height * 0.7,
            len: Math.random() * 70 + 40,
            v: Math.random() * 5 + 4,
            a: Math.random() * 0.35 + 0.25,
            // 出るまでの待ち。これがないと全部が同時に走って雨に見える
            wait: immediate ? Math.random() * 120 : Math.random() * 320 + 60,
        });
        return {
            list: Array.from({ length: 6 }, () => spawn(true)),
            spawn,
        };
    },
    frame: (ctx, canvas, s) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineCap = 'round';
        for (let i = 0; i < s.list.length; i++) {
            const m = s.list[i];
            if (m.wait > 0) {
                m.wait -= 1;
                continue;
            }
            m.x += m.v;
            m.y += m.v * 0.55; // 斜め下へ
            // 尾はグラデーションで先端だけ明るくする（塗り面積は線1本ぶん）
            const g = ctx.createLinearGradient(m.x, m.y, m.x - m.len, m.y - m.len * 0.55);
            g.addColorStop(0, accent);
            g.addColorStop(1, 'transparent');
            ctx.strokeStyle = g;
            ctx.globalAlpha = m.a;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.lineTo(m.x - m.len, m.y - m.len * 0.55);
            ctx.stroke();
            if (m.x - m.len > canvas.width || m.y - m.len * 0.55 > canvas.height) {
                s.list[i] = s.spawn(false);
            }
        }
        ctx.globalAlpha = 1;
    },
});

// レーダー：掃引する線と同心円。管制画面の定番。
// ⚠ 扇形の塗り（面積比例）は使わない。**線だけ**で掃引を表す
const makeRadar = (accent) => ({
    init: (canvas) => ({ angle: 0, blips: [] }),
    frame: (ctx, canvas, s) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const R = Math.min(canvas.width, canvas.height) * 0.46;
        ctx.strokeStyle = accent;
        // 同心円＋十字（静的な目盛り）
        ctx.globalAlpha = 0.12;
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(cx - R, cy);
        ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.stroke();
        // 掃引線。残像は「少し角度をずらした線」を数本引いて表す
        s.angle += 0.012;
        for (let i = 0; i < 14; i++) {
            const a = s.angle - i * 0.035;
            ctx.globalAlpha = 0.3 * (1 - i / 14);
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

// バブル：ゆっくり昇る泡。輪郭だけ描いて塗らない（raster を軽く保つ）
const makeBubbles = (accent) => ({
    init: (canvas) => {
        const count = Math.min(40, Math.round((canvas.width * canvas.height) / 46000));
        return Array.from({ length: Math.max(12, count) }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 14 + 4,
            v: Math.random() * 0.5 + 0.15,
            drift: (Math.random() - 0.5) * 0.25,
            a: Math.random() * 0.18 + 0.08,
        }));
    },
    frame: (ctx, canvas, list, frame) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.1;
        for (const b of list) {
            b.y -= b.v;
            b.x += Math.sin((frame + b.r * 10) * 0.01) * b.drift;
            if (b.y < -b.r) {
                b.y = canvas.height + b.r;
                b.x = Math.random() * canvas.width;
            }
            ctx.globalAlpha = b.a;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

// スノー：ゆらぎながら降る粒。雨と違って横に揺れ、速度が遅い
const makeSnow = (accent) => ({
    init: (canvas) => {
        const count = Math.min(140, Math.round(canvas.width / 12));
        return Array.from({ length: count }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.8 + 0.7,
            v: Math.random() * 0.6 + 0.25,
            sway: Math.random() * 0.6 + 0.2,
            phase: Math.random() * Math.PI * 2,
            a: Math.random() * 0.4 + 0.25,
        }));
    },
    frame: (ctx, canvas, list, frame) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = accent;
        for (const f of list) {
            f.y += f.v;
            f.x += Math.sin(frame * 0.02 + f.phase) * f.sway * 0.5;
            if (f.y > canvas.height + 2) {
                f.y = -2;
                f.x = Math.random() * canvas.width;
            }
            ctx.globalAlpha = f.a;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },
});

// ホタル：明滅しながら漂う光点。パーティクルとの違いは
// **個体ごとに明滅の位相と周期が違う**こと（呼吸しているように見える）
const makeFireflies = (accent) => ({
    init: (canvas) => {
        const count = Math.min(45, Math.round((canvas.width * canvas.height) / 42000));
        return Array.from({ length: Math.max(14, count) }, () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.6 + 1,
            vx: (Math.random() - 0.5) * 0.32,
            vy: (Math.random() - 0.5) * 0.28,
            phase: Math.random() * Math.PI * 2,
            speed: Math.random() * 0.02 + 0.012,
            peak: Math.random() * 0.4 + 0.35,
        }));
    },
    frame: (ctx, canvas, list, frame) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = accent;
        for (const f of list) {
            f.x += f.vx;
            f.y += f.vy;
            if (f.x < 0) f.x = canvas.width;
            if (f.x > canvas.width) f.x = 0;
            if (f.y < 0) f.y = canvas.height;
            if (f.y > canvas.height) f.y = 0;
            // 0..1 の明滅。sin をそのまま使うと常に光っているので下半分を捨てる
            const pulse = Math.max(0, Math.sin(frame * f.speed + f.phase));
            ctx.globalAlpha = pulse * f.peak;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },
});

// ── 手描きの背景（静止画。1回だけ描く）─────────────────────────
//
// ⚠ **アニメーションさせない。** 紙と画材は動かないし、全面 canvas を
//   毎フレーム描くと面積比例の raster コストが乗る（viz-performance.md §2）。
//   `StaticCanvas` はサイズが変わったときだけ描き直す。
//
// ⚠ **決定的に描く**（seed 固定）。乱数のままだと再描画のたびに絵が変わり、
//   タブ切替やリサイズのたびに背景が別物になる（handDrawn.js と同じ理由）。

/** クレヨンの塗り：太いストロークを画面いっぱいに走らせる。 */
function drawCrayonScribble(g, w, h, accent) {
    const r = hdRng(1337);
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    g.strokeStyle = accent;
    // 斜めに往復させる。1本ずつは薄く、重なりで濃さを作る
    const diag = Math.hypot(w, h);
    const rad = (-22 * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    for (let d = -diag / 2; d < diag / 2; d += 26 * (0.6 + r() * 0.9)) {
        g.lineWidth = 14 * (0.5 + r() * 0.9);
        g.globalAlpha = 0.05 * (0.4 + r() * 1.2);
        const phase = r() * 6.28;
        g.beginPath();
        for (let k = 0; k <= 24; k++) {
            const t = k / 24;
            const along = -diag / 2 + t * diag;
            const off = d + Math.sin(t * 4 + phase) * 16 + Math.sin(t * 11 + phase * 2) * 5;
            const px = cx + Math.cos(rad) * along - Math.sin(rad) * off;
            const py = cy + Math.sin(rad) * along + Math.cos(rad) * off;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
        }
        g.stroke();
    }
    g.globalAlpha = 1;
}

/** 鉛筆のハッチング：細い線を2方向に。製図の下描き。 */
function drawPencilHatch(g, w, h, accent) {
    const r = hdRng(2024);
    g.lineCap = 'butt';
    g.strokeStyle = accent;
    const diag = Math.hypot(w, h);
    const cx = w / 2;
    const cy = h / 2;
    for (const [angle, gap, alpha] of [
        [-38, 13, 0.05],
        [26, 21, 0.032],
    ]) {
        const rad = (angle * Math.PI) / 180;
        for (let d = -diag / 2; d < diag / 2; d += gap * (0.6 + r() * 0.8)) {
            g.lineWidth = 1 * (0.6 + r() * 0.9);
            g.globalAlpha = alpha * (0.4 + r() * 1.3);
            const phase = r() * 6.28;
            g.beginPath();
            for (let k = 0; k <= 18; k++) {
                const t = k / 18;
                const along = -diag / 2 + t * diag;
                const off = d + Math.sin(t * 3.5 + phase) * 7;
                const px = cx + Math.cos(rad) * along - Math.sin(rad) * off;
                const py = cy + Math.sin(rad) * along + Math.cos(rad) * off;
                if (k === 0) g.moveTo(px, py);
                else g.lineTo(px, py);
            }
            g.stroke();
        }
    }
    g.globalAlpha = 1;
}

/** 手描きの方眼：定規を使わずに引いた升目（線がふらつき、間隔も揃わない）。 */
function drawSketchGrid(g, w, h, accent, rc) {
    const r = hdRng(4242);
    const step = 78;
    g.strokeStyle = accent;
    // 縦線・横線を rough.js で引く。1本ずつ seed を変えてふらつかせる
    let i = 0;
    for (let x = step; x < w; x += step * (0.85 + r() * 0.3)) {
        g.globalAlpha = 0.09 + r() * 0.05;
        rc.line(x, -4, x + (r() - 0.5) * 10, h + 4, {
            stroke: accent,
            strokeWidth: 1.1,
            roughness: 1.6,
            bowing: 0.8,
            seed: 900 + i++,
        });
    }
    for (let y = step; y < h; y += step * (0.85 + r() * 0.3)) {
        g.globalAlpha = 0.09 + r() * 0.05;
        rc.line(-4, y, w + 4, y + (r() - 0.5) * 10, {
            stroke: accent,
            strokeWidth: 1.1,
            roughness: 1.6,
            bowing: 0.8,
            seed: 1900 + i++,
        });
    }
    g.globalAlpha = 1;
}

/** インクの飛沫：ペンを弾いたときの飛び散り。大小の点をまばらに。 */
function drawInkSplatter(g, w, h, accent) {
    const r = hdRng(777);
    g.fillStyle = accent;
    // 大きな染み（数個）＋細かい飛沫（多数）
    const blobs = Math.max(3, Math.round((w * h) / 420000));
    for (let i = 0; i < blobs; i++) {
        const bx = r() * w;
        const by = r() * h;
        g.globalAlpha = 0.05 + r() * 0.05;
        // 真円にしない（インクの染みは歪む）
        g.beginPath();
        const rad = 8 + r() * 16;
        for (let k = 0; k <= 14; k++) {
            const a = (k / 14) * Math.PI * 2;
            const rr = rad * (0.7 + r() * 0.6);
            const px = bx + Math.cos(a) * rr;
            const py = by + Math.sin(a) * rr * 0.8;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
        // その周りに飛沫
        const n = 6 + Math.round(r() * 10);
        for (let k = 0; k < n; k++) {
            g.globalAlpha = 0.05 + r() * 0.08;
            g.beginPath();
            g.arc(bx + (r() - 0.5) * 150, by + (r() - 0.5) * 150, 0.6 + r() * 2.2, 0, Math.PI * 2);
            g.fill();
        }
    }
    g.globalAlpha = 1;
}

/** 紙の目だけ：画材を乗せず、紙そのものの繊維感を出す。 */
function drawPaperTooth(g, w, h, accent) {
    const r = hdRng(5150);
    // 繊維（短い線）と粒（点）を混ぜる。どちらも極薄
    g.strokeStyle = accent;
    g.lineCap = 'round';
    const fibers = Math.round((w * h) / 5200);
    for (let i = 0; i < fibers; i++) {
        const x = r() * w;
        const y = r() * h;
        const len = 2 + r() * 7;
        const a = r() * Math.PI;
        g.globalAlpha = 0.03 + r() * 0.05;
        g.lineWidth = 0.6 + r() * 0.7;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
    }
    g.fillStyle = accent;
    const grains = Math.round((w * h) / 9000);
    for (let i = 0; i < grains; i++) {
        g.globalAlpha = 0.03 + r() * 0.05;
        g.beginPath();
        g.arc(r() * w, r() * h, 0.5 + r() * 1.1, 0, Math.PI * 2);
        g.fill();
    }
    g.globalAlpha = 1;
}

const HAND_DRAWN_BG = {
    paperTooth: drawPaperTooth,
    sketchGrid: drawSketchGrid,
    crayonScribble: drawCrayonScribble,
    pencilHatch: drawPencilHatch,
    inkSplatter: drawInkSplatter,
};

/** 静止画の canvas（サイズが変わったときだけ描き直す）。 */
function StaticCanvas({ draw, accent }) {
    const canvasRef = useRef(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const render = () => {
            const w = Math.max(1, canvas.offsetWidth);
            const h = Math.max(1, canvas.offsetHeight);
            // ⚠ 背景は面積が大きいので DPR は 1 で十分（2 にすると塗りが4倍）。
            //   紙の粒は等倍でも見える
            canvas.width = w;
            canvas.height = h;
            const g = canvas.getContext('2d');
            g.clearRect(0, 0, w, h);
            draw(g, w, h, accent, roughCanvas(canvas));
        };
        render();
        const ro = new ResizeObserver(render);
        ro.observe(canvas);
        return () => ro.disconnect();
    }, [draw, accent]);
    return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

export default function BackgroundLayer({ kind, accent }) {
    const scene = React.useMemo(() => {
        if (kind === 'particles') return makeParticles(accent, false);
        if (kind === 'constellation') return makeParticles(accent, true);
        if (kind === 'rain') return makeRain(accent);
        if (kind === 'ripple') return makeRipple(accent);
        if (kind === 'wave') return makeWave(accent);
        if (kind === 'starfield') return makeStarfield(accent);
        if (kind === 'meteor') return makeMeteor(accent);
        if (kind === 'radar') return makeRadar(accent);
        if (kind === 'bubbles') return makeBubbles(accent);
        if (kind === 'snow') return makeSnow(accent);
        if (kind === 'fireflies') return makeFireflies(accent);
        return null;
    }, [kind, accent]);

    if (!kind || kind === 'none') return null;
    const common = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' };

    // 手描きの背景は静止画（アニメーションしない）
    const handDrawn = HAND_DRAWN_BG[kind];
    if (handDrawn) {
        return (
            <div style={common}>
                <StaticCanvas draw={handDrawn} accent={accent} />
            </div>
        );
    }

    if (scene) {
        return (
            <div style={common}>
                <Canvas scene={scene} />
            </div>
        );
    }

    const cssBackgrounds = {
        grid: {
            backgroundImage: `linear-gradient(${accent}14 1px, transparent 1px), linear-gradient(90deg, ${accent}14 1px, transparent 1px)`,
            backgroundSize: '48px 48px',
            // ⚠ **`background-position` を animate してはいけない。**
            //    合成でなく毎フレーム「全面の再描画（RasterTask）」になる。
            //    実測（1920x1080）: この1要素だけで **22fps**、
            //    止めると **60fps**（他の 37 個のアニメを全部止めても効果ゼロ、
            //    この1個で決まっていた）。
            //    → transform で動かす（下の `pan` を参照）。
            //    viz-performance.md §2「面積に比例する塗り」の典型例
            __pan: true,
        },
        hex: {
            // 六角形風の斜めグリッド（3方向の線を重ねる）
            backgroundImage: `linear-gradient(60deg, ${accent}10 1px, transparent 1px), linear-gradient(-60deg, ${accent}10 1px, transparent 1px), linear-gradient(0deg, ${accent}10 1px, transparent 1px)`,
            backgroundSize: '56px 96px',
        },
        dots: {
            backgroundImage: `radial-gradient(${accent}22 1.2px, transparent 1.2px)`,
            backgroundSize: '28px 28px',
        },
        diagonal: {
            backgroundImage: `repeating-linear-gradient(45deg, ${accent}0a 0px, ${accent}0a 2px, transparent 2px, transparent 14px)`,
        },
        scanlines: {
            backgroundImage: `repeating-linear-gradient(0deg, transparent 0px, transparent 3px, ${accent}0a 3px, ${accent}0a 4px)`,
        },
        glow: {
            backgroundImage: `radial-gradient(ellipse 70% 50% at 10% 0%, ${accent}22, transparent 60%), radial-gradient(ellipse 60% 50% at 95% 100%, ${accent}18, transparent 60%)`,
        },
        aurora: {
            backgroundImage: `radial-gradient(ellipse 60% 40% at 20% 20%, ${accent}26, transparent 60%), radial-gradient(ellipse 50% 40% at 80% 30%, ${accent}1a, transparent 60%), radial-gradient(ellipse 70% 50% at 50% 90%, ${accent}20, transparent 60%)`,
            animation: 'dpxAurora 24s ease-in-out infinite alternate',
        },
        circuit: {
            // 回路基板：直交の線＋ノードの点。線の交点に点を置くと基板らしくなる
            backgroundImage:
                `linear-gradient(${accent}12 1px, transparent 1px), linear-gradient(90deg, ${accent}12 1px, transparent 1px),` +
                `radial-gradient(${accent}30 1.6px, transparent 1.8px)`,
            backgroundSize: '64px 64px, 64px 64px, 64px 64px',
            backgroundPosition: '0 0, 0 0, 32px 32px',
        },
        topo: {
            // 等高線：同心の楕円を数枚ずらして重ねる。地形図の意匠
            backgroundImage:
                `repeating-radial-gradient(ellipse 46% 34% at 22% 28%, transparent 0px, transparent 26px, ${accent}14 26px, ${accent}14 27px),` +
                `repeating-radial-gradient(ellipse 40% 30% at 78% 72%, transparent 0px, transparent 30px, ${accent}10 30px, ${accent}10 31px)`,
        },
        weave: {
            // 布目：45度の交差ハッチ。紙や装丁クロスの地。
            //
            // ⚠ **アクセント色を使わない。** 布目は「紙そのものの地」なので、
            //   差し色で染めると素材ではなく模様に見える。中性のインク色を薄く敷く。
            // ⚠ 静的（animate しない）＝合成は一度きりで毎フレームの塗りが無い。
            //   background-position を動かすと全面再描画になる（下の grid の注記）
            backgroundImage:
                `repeating-linear-gradient(45deg, rgba(90,80,60,0.055) 0px, rgba(90,80,60,0.055) 1px, transparent 1px, transparent 5px),` +
                `repeating-linear-gradient(-45deg, rgba(90,80,60,0.055) 0px, rgba(90,80,60,0.055) 1px, transparent 1px, transparent 5px)`,
        },
        laid: {
            // 簀の目（レイド紙）：手漉き紙の細い横線と、25mm ごとの太い鎖線。
            // 布目より穏やかで、文字の下に敷いても可読性を落としにくい
            backgroundImage:
                `repeating-linear-gradient(0deg, rgba(90,80,60,0.05) 0px, rgba(90,80,60,0.05) 1px, transparent 1px, transparent 4px),` +
                `repeating-linear-gradient(90deg, rgba(90,80,60,0.07) 0px, rgba(90,80,60,0.07) 1px, transparent 1px, transparent 26px)`,
        },
        graphPaper: {
            // 方眼：細い升目＋5マスごとの太線。図面の下敷き。
            // 既存の `grid` と違い**流れない**（青焼きは静止した紙なので動かさない）
            backgroundImage:
                `linear-gradient(${accent}14 1px, transparent 1px), linear-gradient(90deg, ${accent}14 1px, transparent 1px),` +
                `linear-gradient(${accent}26 1px, transparent 1px), linear-gradient(90deg, ${accent}26 1px, transparent 1px)`,
            backgroundSize: '13px 13px, 13px 13px, 65px 65px, 65px 65px',
        },
        halftone: {
            // 網点：印刷の階調表現。ドットより粒が大きく、斜めに並べて紙らしくする
            backgroundImage: `radial-gradient(${accent}1f 1.6px, transparent 1.7px)`,
            backgroundSize: '10px 10px',
            backgroundPosition: '0 0',
        },
        thermalScan: {
            // 熱画像：下方に溜まる熱＋細い走査線。
            // ⚠ 走査線は 1px 幅の繰り返しなので塗り面積が小さい（raster が軽い）
            backgroundImage:
                `repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.16) 2px, rgba(0,0,0,0.16) 3px),` +
                `radial-gradient(ellipse 70% 45% at 30% 105%, ${accent}30, transparent 60%),` +
                `radial-gradient(ellipse 55% 40% at 80% 100%, ${accent}22, transparent 60%)`,
        },
        washBlooms: {
            // 水彩のにじみ：乾くとき顔料が縁に寄る「エッジの濃まり」＝**輪の染み**。
            // ⚠ 中を薄膜で塗らない。当初は内側にも 5% の薄膜を敷いたら、
            //   生成りの紙地の上で青が濁って**灰色の卵形の染み**に見えた（実機で確認）。
            //   染みは「縁の輪だけ」にし、輪の立ち上がりもなだらかにする。
            // 大中小の3滴。静的＝合成は一度きりで raster が軽い
            backgroundImage:
                `radial-gradient(ellipse 34% 26% at 22% 24%, transparent 0%, transparent 58%, ${accent}08 70%, ${accent}24 80%, transparent 88%),` +
                `radial-gradient(ellipse 28% 22% at 76% 62%, transparent 0%, transparent 56%, ${accent}07 70%, ${accent}1f 80%, transparent 88%),` +
                `radial-gradient(ellipse 18% 15% at 46% 88%, transparent 0%, transparent 54%, ${accent}06 68%, ${accent}1b 79%, transparent 88%)`,
        },
        vignette: {
            backgroundImage: 'radial-gradient(ellipse 80% 70% at 50% 45%, transparent 40%, rgba(0,0,0,0.55) 100%)',
        },
        // ── v1.9.0 追加（すべて静的＝合成は一度きり）──────────────
        isometric: {
            // アイソメ方眼：60度・120度・垂直の3方向。立体グリッド用紙の意匠
            backgroundImage:
                `repeating-linear-gradient(60deg, ${accent}12 0px, ${accent}12 1px, transparent 1px, transparent 34px),` +
                `repeating-linear-gradient(-60deg, ${accent}12 0px, ${accent}12 1px, transparent 1px, transparent 34px),` +
                `repeating-linear-gradient(0deg, ${accent}0c 0px, ${accent}0c 1px, transparent 1px, transparent 34px)`,
        },
        chevron: {
            // シェブロン：山形の連続。方向感が出るので「流れ」を示したい盤面向け。
            // ⚠ conic ではなく linear の三角波で作る（conic は塗り面積が大きい）
            backgroundImage:
                `repeating-linear-gradient(45deg, ${accent}0e 0px, ${accent}0e 1px, transparent 1px, transparent 12px),` +
                `repeating-linear-gradient(-45deg, ${accent}0e 0px, ${accent}0e 1px, transparent 1px, transparent 12px)`,
            backgroundSize: '24px 24px',
        },
        carbonFiber: {
            // カーボン繊維：綾織りの艶。2方向の細ハッチを半周期ずらして市松に組む
            backgroundImage:
                `repeating-linear-gradient(45deg, rgba(255,255,255,0.045) 0px, rgba(255,255,255,0.045) 1px, transparent 1px, transparent 4px),` +
                `repeating-linear-gradient(-45deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 1px, transparent 1px, transparent 4px)`,
            backgroundSize: '8px 8px',
        },
        blueprintFrame: {
            // 図面枠：外周の二重罫。**中央は塗らない**ので情報の邪魔をしない。
            //
            // ⚠ **inset box-shadow を重ねて二重罫は作れない。**
            //   後の inset が先の inset を塗り潰すので、間の「透明な隙間」が出ない
            //   （最初そう書いて1本の帯になった）。**辺ごとの線**を
            //   `linear-gradient` + `background-position` で置く方が確実。
            //   線は 1px なので塗り面積は四辺ぶんだけ＝ raster は軽い
            backgroundImage:
                // 外罫（上下左右）
                `linear-gradient(${accent}26, ${accent}26), linear-gradient(${accent}26, ${accent}26),` +
                `linear-gradient(${accent}26, ${accent}26), linear-gradient(${accent}26, ${accent}26),` +
                // 内罫（上下左右）
                `linear-gradient(${accent}14, ${accent}14), linear-gradient(${accent}14, ${accent}14),` +
                `linear-gradient(${accent}14, ${accent}14), linear-gradient(${accent}14, ${accent}14)`,
            backgroundRepeat: 'no-repeat',
            backgroundSize:
                'calc(100% - 28px) 1px, calc(100% - 28px) 1px, 1px calc(100% - 28px), 1px calc(100% - 28px),' +
                'calc(100% - 40px) 1px, calc(100% - 40px) 1px, 1px calc(100% - 40px), 1px calc(100% - 40px)',
            backgroundPosition:
                '14px 14px, 14px calc(100% - 14px), 14px 14px, calc(100% - 14px) 14px,' +
                '20px 20px, 20px calc(100% - 20px), 20px 20px, calc(100% - 20px) 20px',
        },
        spotlight: {
            // スポットライト：中央だけ明るく、周辺を落とす。1枚に注目させたいとき
            backgroundImage:
                `radial-gradient(ellipse 55% 45% at 50% 38%, ${accent}1c, transparent 62%),` +
                'radial-gradient(ellipse 90% 80% at 50% 40%, transparent 45%, rgba(0,0,0,0.42) 100%)',
        },
        cornerGlow: {
            // 四隅からの光。中央を空けるので中身が読みやすい（グローの派生）
            backgroundImage:
                `radial-gradient(ellipse 40% 34% at 0% 0%, ${accent}20, transparent 60%),` +
                `radial-gradient(ellipse 40% 34% at 100% 0%, ${accent}18, transparent 60%),` +
                `radial-gradient(ellipse 40% 34% at 0% 100%, ${accent}18, transparent 60%),` +
                `radial-gradient(ellipse 40% 34% at 100% 100%, ${accent}20, transparent 60%)`,
        },
        sunbeam: {
            // 斜光：窓から差す光。太さの違う帯を斜めに数本
            backgroundImage:
                `repeating-linear-gradient(72deg, transparent 0px, transparent 46px, ${accent}0b 46px, ${accent}0b 92px, transparent 92px, transparent 150px),` +
                `radial-gradient(ellipse 60% 50% at 78% 0%, ${accent}18, transparent 62%)`,
        },
    };

    const css = cssBackgrounds[kind];
    if (!css) return null;

    // transform で流すパターン（grid）。
    // タイル1周期ぶん（48px）だけ動かして戻すと、見た目は無限スクロールになる。
    // 外側で overflow:hidden、内側を1周期ぶん大きく取って transform を掛ける
    // ＝ 合成だけで済むので**塗り直しが起きない**（60fps を実測）。
    if (css.__pan) {
        const { __pan, ...rest } = css;
        return (
            <div style={common}>
                <div
                    style={{
                        position: 'absolute',
                        // 1周期ぶん外へはみ出させ、動いても隙間ができないようにする
                        top: -48,
                        left: -48,
                        right: -48,
                        bottom: -48,
                        ...rest,
                        animation: 'dpxGridPan 6s linear infinite',
                    }}
                />
            </div>
        );
    }
    return <div style={{ ...common, ...css }} />;
}
