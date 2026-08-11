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

/**
 * パネル内に絶対配置するツールチップ。カーソル位置に追従し、端で折り返す。
 *
 * ⚠ **行数が多いとパネルからはみ出す。** 10 系列を並べたら高さ 218px になり、
 *   パネル下端を **20px 超過**して隣のパネルに重なった（実機で計測）。
 *   `rows.length * 17` で上位置を調整するだけでは足りない
 *   （そもそも入らない高さのときは調整のしようがない）。
 *   → **入る行数を高さから逆算して打ち切り**、残りは「ほか N 件」と出す。
 *   値の大きい順に並べ替えるので、**切られるのは常に小さい系列**。
 */
export function VizTooltip({ t, x, y, width, height, title, rows, accent }) {
    if (x == null) return null;
    const W = 168;
    const ROW_H = 19; // 行の実測高（fontSize 11 + marginTop 2 + 行間）
    // ⚠ 枠の固定高は**多めに見積もる**。padding(7*2) + border(1*2) +
    //    タイトル行(≈15+marginBottom 4) + 「ほか N 件」の marginTop(3)。
    //    ここを小さく見積もると `boxH` が実際より小さくなり、
    //    下端クランプをすり抜けてパネルからはみ出す（実機で 10〜12px 超過して発覚）。
    const CHROME = 16 + (title ? 19 : 0);
    const MARGIN = 8; // パネル内側に残す余白
    const flipX = x + W + 18 > width;

    // 収まる行数。⚠ 「ほか N 件」の1行ぶんも先に確保しておかないと、
    //    切り詰めた結果その1行が入らずに再びはみ出す
    const avail = height - CHROME - MARGIN * 2;
    let maxRows = Math.floor(avail / ROW_H);
    const willOverflow = rows.length > maxRows;
    if (willOverflow) maxRows -= 1; // 「ほか N 件」の行を確保
    maxRows = Math.max(1, maxRows);

    const overflow = Math.max(0, rows.length - maxRows);
    const shown = overflow > 0 ? rows.slice(0, maxRows) : rows;

    const boxH = CHROME + shown.length * ROW_H + (overflow ? ROW_H : 0);
    // 上端・下端の両方でクランプする（下だけ見ていると上にはみ出す）
    const top = Math.max(MARGIN, Math.min(y - 10, height - boxH - MARGIN));
    return (
        <div
            style={{
                position: 'absolute',
                left: flipX ? x - W - 14 : x + 14,
                top,
                width: W,
                // ⚠ 行数計算がズレても**絶対にパネルから出さない**ための保険。
                //    見積もりだけに頼ると、フォントや行間が変わった瞬間に再発する
                maxHeight: Math.max(40, height - MARGIN * 2),
                overflow: 'hidden',
                boxSizing: 'border-box',
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
            {shown.map((r) => (
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
            {/* 打ち切ったことを黙って隠さない（「これで全部」と誤解させない） */}
            {overflow > 0 ? (
                <div style={{ fontSize: 10, color: t.subColor, marginTop: 3 }}>ほか {overflow} 件</div>
            ) : null}
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
