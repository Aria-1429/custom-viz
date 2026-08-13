import React, { useEffect, useRef } from 'react';

import { MEDIUM_PRESETS, applyTooth, roughCanvas, seedFrom, strokeRect } from './handDrawn';

// ── 手描き画材のパネル枠（実描画）─────────────────────────────
//
// CSS の `border` / `box-shadow` の代わりに、パネルの背面へ canvas を敷いて
// **実際に画材で枠を描く**。CSS では出せない「線のふらつき・二度描き・かすれ」
// を出すのが目的（詳細は handDrawn.js の冒頭）。
//
// ⚠ **seed はパネル ID から作る**（`seedFrom`）。乱数のままだと
//   React の再描画のたびに枠の形が変わってチラつく。
// ⚠ 描き直すのは**サイズ・色・画材が変わったときだけ**。
//   毎フレーム描くと面積比例の raster になる（viz-performance.md §2）。
// ────────────────────────────────────────────────────────────────

export default function HandDrawnFrame({ medium, color, paper, seedKey, radius = 0, inset = 10 }) {
    const canvasRef = useRef(null);
    const boxRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const box = boxRef.current;
        if (!canvas || !box) return undefined;
        const cfg = MEDIUM_PRESETS[medium];
        if (!cfg) return undefined;

        const draw = () => {
            const w = Math.max(1, Math.round(box.offsetWidth));
            const h = Math.max(1, Math.round(box.offsetHeight));
            // ⚠ devicePixelRatio を掛けないと高 DPI で線がぼやける。
            //   ただし上限を付ける（4K で 3倍だと塗り面積が9倍になる）
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            const g = canvas.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);

            const seed = seedFrom(`${seedKey}|${medium}`);
            const rc = roughCanvas(canvas);
            // canvas は padding box いっぱい（＝中身と同じ矩形）。
            // 枠はその**外周ぎりぎり**に引く。パネル側が `HAND_DRAWN_INSET` の
            // 余白を確保しているので、線が多少ふらついても中身には当たらない。
            // ⚠ 大きく取ると枠が中身に食い込む（inset とのバランスで決まる）
            // ⚠ **線のふらつきぶんの逃げを外側にも取る。** ぴったり 0 に寄せると
            //   外へ振れた分が canvas の縁で切れて「直線に見える」区間ができる。
            const pad = Math.max(3, cfg.frame.width);
            strokeRect(g, rc, pad, pad, w - pad * 2, h - pad * 2, color, seed, cfg.frame);
            // 紙の目は枠の上から。paper が無い（透過）ときは敷かない。
            // ⚠ **枠の帯の内側には敷かない。** この canvas は中身より前面にあるので、
            //   全面に紙の目を撒くと**グラフや文字の上に粒が乗って汚れて見える**。
            //   線の周り（外周の帯）だけに限定する
            if (paper) {
                const band = pad * 2 + cfg.frame.width * 2;
                g.save();
                g.beginPath();
                g.rect(0, 0, w, h);
                // 内側を切り抜いて「枠の帯」だけを対象にする（evenodd で穴を開ける）
                g.rect(band, band, Math.max(0, w - band * 2), Math.max(0, h - band * 2));
                g.clip('evenodd');
                applyTooth(g, w, h, { density: cfg.tooth, seed: seed + 7, paper });
                g.restore();
            }
        };

        draw();
        // サイズが変わったときだけ引き直す
        const ro = new ResizeObserver(draw);
        ro.observe(box);
        return () => ro.disconnect();
    }, [medium, color, paper, seedKey, inset]);

    if (!MEDIUM_PRESETS[medium]) return null;

    return (
        <span
            ref={boxRef}
            aria-hidden
            style={{
                // ⚠ **負のオフセットで border box まで広げてはいけない。**
                //   パネルは `overflow: hidden` なので、はみ出した canvas は
                //   **まるごと切り取られて枠が消える**（実機で発生）。
                //   絶対配置の基準は padding box なので `inset: 0` のままにし、
                //   枠は「パネルが確保した padding の内側の縁」に引く。
                //   結果として線は中身と重ならず、かつ切り取られない。
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                overflow: 'visible',
                borderRadius: radius,
                // ⚠ **枠は中身より前面に置く。** 背面に敷くと、
                //   自前の背景を持つ viz（テーブルの見出し帯・行の縞・棒グラフ等）に
                //   **塗り潰されて線が消える**（実機で発生）。
                //   実際の画材でも「紙の上に描いた線」は中身の上に乗るので、
                //   前面に出すほうが物理的にも正しい。
                //   `pointerEvents:'none'` があるのでクリックは透過する
                zIndex: 3,
            }}
        >
            <canvas ref={canvasRef} style={{ display: 'block' }} />
        </span>
    );
}
