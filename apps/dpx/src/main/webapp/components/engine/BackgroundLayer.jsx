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
    { value: 'circuit', label: '回路基板', group: 'パターン' },
    { value: 'topo', label: '等高線', group: 'パターン' },
    { value: 'weave', label: 'クロスハッチ（布目）', group: 'パターン' },
    { value: 'laid', label: 'レイド紙（簀の目）', group: 'パターン' },
    { value: 'graphPaper', label: '方眼（図面の升目）', group: 'パターン' },
    { value: 'halftone', label: 'ハーフトーン（網点）', group: 'パターン' },
    { value: 'thermalScan', label: 'サーマル（走査線と熱溜まり）', group: 'グラデーション' },
    { value: 'washBlooms', label: '水彩のにじみ（乾いた縁）', group: 'グラデーション' },
    { value: 'starfield', label: '星空（流れる）', group: 'キャンバス' },
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

export default function BackgroundLayer({ kind, accent }) {
    const scene = React.useMemo(() => {
        if (kind === 'particles') return makeParticles(accent, false);
        if (kind === 'constellation') return makeParticles(accent, true);
        if (kind === 'rain') return makeRain(accent);
        if (kind === 'ripple') return makeRipple(accent);
        if (kind === 'wave') return makeWave(accent);
        if (kind === 'starfield') return makeStarfield(accent);
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
