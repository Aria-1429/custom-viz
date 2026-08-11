import React, { useEffect, useRef } from 'react';

// ── DPX 背景レイヤ ───────────────────────────────────────────────
// definition.style.background で選ぶ装飾背景。パネルの後ろ（z:0）に敷く。
// canvas 系はタブ非表示中に描画を止める。
// パフォーマンス指針: 面積比例の半透明塗り（blur/SMIL）は使わない
// （viz-performance.md の実測知見に従う）。
// ────────────────────────────────────────────────────────────────

export const BACKGROUND_OPTIONS = [
    { value: 'none', label: 'なし' },
    { value: 'particles', label: 'パーティクル（漂う光点）', group: 'アニメーション' },
    { value: 'constellation', label: 'コンステレーション（線で結ぶ）', group: 'アニメーション' },
    { value: 'rain', label: 'データレイン（降る粒）', group: 'アニメーション' },
    { value: 'ripple', label: 'リップル（広がる波紋）', group: 'アニメーション' },
    { value: 'wave', label: 'ウェーブ（うねる線）', group: 'アニメーション' },
    { value: 'grid', label: 'グリッド（流れる格子）', group: 'パターン' },
    { value: 'hex', label: 'ヘックス（六角形）', group: 'パターン' },
    { value: 'dots', label: 'ドット（点描）', group: 'パターン' },
    { value: 'diagonal', label: 'ストライプ（斜線）', group: 'パターン' },
    { value: 'scanlines', label: 'スキャンライン', group: 'パターン' },
    { value: 'glow', label: 'グロー（隅の光）', group: 'グラデーション' },
    { value: 'aurora', label: 'オーロラ（ゆらぐ光幕）', group: 'グラデーション' },
    { value: 'vignette', label: 'ビネット（周辺減光）', group: 'グラデーション' },
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

export default function BackgroundLayer({ kind, accent }) {
    const scene = React.useMemo(() => {
        if (kind === 'particles') return makeParticles(accent, false);
        if (kind === 'constellation') return makeParticles(accent, true);
        if (kind === 'rain') return makeRain(accent);
        if (kind === 'ripple') return makeRipple(accent);
        if (kind === 'wave') return makeWave(accent);
        return null;
    }, [kind, accent]);

    if (!kind || kind === 'none') return null;
    const common = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' };

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
            animation: 'dpxGridPan 60s linear infinite',
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
        vignette: {
            backgroundImage: 'radial-gradient(ellipse 80% 70% at 50% 45%, transparent 40%, rgba(0,0,0,0.55) 100%)',
        },
    };

    const css = cssBackgrounds[kind];
    return css ? <div style={{ ...common, ...css }} /> : null;
}
