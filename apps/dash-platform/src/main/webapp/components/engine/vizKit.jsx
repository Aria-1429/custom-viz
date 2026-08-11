import React, { useEffect, useRef, useState } from 'react';

// ── ネイティブ viz 共通キット ────────────────────────────────────
// 「映え」と「インタラクション」の土台。
// ⚠ 性能方針（viz-performance.md の実測知見）:
//   - SVG フィルタ（feGaussianBlur）と SMIL は使わない
//   - 面積に比例する半透明の大きな塗りを毎フレーム描かない
//   - 動かすのは CSS の transform / opacity（コンポジタ処理）に寄せる
//   ここで使うグロー表現は「太さ・不透明度の違う実線の重ね」で代替する
// ────────────────────────────────────────────────────────────────

/** 一度だけ注入する viz 用アニメーション CSS。 */
export function useVizKitStyles() {
    useEffect(() => {
        if (document.getElementById('dpx-vizkit-css')) return;
        const style = document.createElement('style');
        style.id = 'dpx-vizkit-css';
        style.textContent = `
            @keyframes dpxDraw { from { stroke-dashoffset: var(--dpx-len); } to { stroke-dashoffset: 0; } }
            @keyframes dpxPulse { 0%,100% { opacity: .35; transform: scale(1); } 50% { opacity: .9; transform: scale(1.35); } }
            @keyframes dpxGrow { from { transform: scaleY(0.001); } to { transform: scaleY(1); } }
            .dpx-bar-rect { transform-origin: bottom center; }
            .dpx-hit { cursor: crosshair; }
        `;
        document.head.appendChild(style);
    }, []);
}

/** パネル内に絶対配置するツールチップ。カーソル位置に追従し、端で折り返す。 */
export function VizTooltip({ t, x, y, width, height, title, rows, accent }) {
    if (x == null) return null;
    const W = 168;
    const flipX = x + W + 18 > width;
    const top = Math.max(6, Math.min(y - 10, height - 20 - rows.length * 17));
    return (
        <div
            style={{
                position: 'absolute',
                left: flipX ? x - W - 14 : x + 14,
                top,
                width: W,
                pointerEvents: 'none',
                background: 'rgba(10,16,30,0.94)',
                border: `1px solid ${accent ?? t.accent}66`,
                borderRadius: 8,
                padding: '7px 9px',
                boxShadow: '0 8px 22px rgba(0,0,0,0.5)',
                zIndex: 20,
            }}
        >
            {title ? (
                <div style={{ fontSize: 10, color: t.subColor, marginBottom: 4, letterSpacing: '0.04em' }}>{title}</div>
            ) : null}
            {rows.map((r) => (
                <div
                    key={r.label}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 2 }}
                >
                    {r.color ? (
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: r.color, flex: 'none' }} />
                    ) : null}
                    <span
                        style={{
                            flex: 1,
                            minWidth: 0,
                            color: r.dim ? t.subColor : t.titleColor,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {r.label}
                    </span>
                    <span style={{ color: t.titleColor, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {r.value}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** 数値のカウントアップ。値が変わるたびに現在値から滑らかに寄せる。
 *  ⚠ rAF は遷移中だけ回す（常時回さない）。 */
export function useCountUp(target, { duration = 700, enabled = true } = {}) {
    const [display, setDisplay] = useState(target);
    const fromRef = useRef(null); // 「まだ一度も数値を表示していない」= null
    const rafRef = useRef(0);

    useEffect(() => {
        // ⚠ データ到着前は target が null。ここで display を固定してしまうと
        //    到着後もアニメが走らず値が出ない（実機で数字が消えた）。
        //    数値でない間は素通しし、初回の数値は 0 から立ち上げる。
        if (!Number.isFinite(target)) {
            setDisplay(target);
            fromRef.current = null;
            return undefined;
        }
        if (!enabled) {
            setDisplay(target);
            fromRef.current = target;
            return undefined;
        }
        const from = Number.isFinite(fromRef.current) ? fromRef.current : 0;
        if (from === target) {
            setDisplay(target);
            return undefined;
        }
        const start = performance.now();
        const tick = (now) => {
            const p = Math.min((now - start) / duration, 1);
            const eased = 1 - (1 - p) ** 3; // easeOutCubic
            setDisplay(from + (target - from) * eased);
            if (p < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                fromRef.current = target;
                setDisplay(target);
            }
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [target, duration, enabled]);

    return enabled ? display : target;
}

/** SVG の線を「描かれていく」ように見せる。ref に渡して使う。
 *  stroke-dasharray/offset のアニメはジオメトリを動かさないので軽い。
 *
 *  ⚠ 描き終わったら dasharray を必ず捨てること。残すと、後からパネル幅が
 *    変わった（ResizeObserver）ときに「古い長さの破線」が線を途中で切る。
 *    塗りは dasharray の影響を受けないので、線だけ途中で消えて見える
 *    （2026-08-10 に dpx.line で実機再現・修正）。
 */
export function applyDrawIn(pathEl, enabled, delaySec = 0) {
    if (!enabled || !pathEl || pathEl.dataset.drawn) return;
    const len = pathEl.getTotalLength?.() ?? 0;
    if (!len) return;
    pathEl.dataset.drawn = '1';
    pathEl.style.setProperty('--dpx-len', len);
    pathEl.style.strokeDasharray = len;
    pathEl.style.animation = `dpxDraw 0.9s ease-out ${delaySec}s both`;
    const clear = () => {
        pathEl.style.animation = '';
        pathEl.style.strokeDasharray = '';
        pathEl.style.strokeDashoffset = '';
    };
    pathEl.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 1200 + delaySec * 1000);
}

/** マウス位置を要素内座標で購読する（tooltip・クロスヘア用）。 */
export function usePointer() {
    const [pt, setPt] = useState({ x: null, y: null });
    const onMove = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPt({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onLeave = () => setPt({ x: null, y: null });
    return [pt, { onMouseMove: onMove, onMouseLeave: onLeave }];
}
