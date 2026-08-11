import React, { useEffect, useRef, useState } from 'react';

import { useDpxTheme } from './themes';

// ── 図形（装飾用）─────────────────────────────────────────────────
// パネルの「裏」に敷いて構図を整えるための要素。
// 見出しの下線、グループを囲む枠、視線を誘導する矢印、面の塗り分け——
// ダッシュボードを「映える」ものにするには、データを持たない要素が要る。
//
// Studio には図形が無く、テキストパネルや空パネルで代用するしかなかった。
// DPX は viz を Map に足すだけで増やせるので、素直に図形として用意する。
//
// 使い方（パネルとして置く）:
//   - パネルの質感は「枠なし（frameless）」にして、style.z を小さくすると背面に回る
//   - サーチは不要（データを読まない）
// ────────────────────────────────────────────────────────────────

/** 図形パネルの共通ラッパ。SVG を親いっぱいに伸ばす。
 *  ⚠ overflow は visible にしない。矢印マーカーの先端だけは外に出したいが、
 *    グロー（面）まではみ出すと**パネルの外まで光が漏れて構図が崩れる**
 *    （実機で確認）。はみ出しが要る図形は個別に許可する。 */
function ShapeSvg({ children, overflow = 'hidden' }) {
    return (
        <svg width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', overflow }}>
            {children}
        </svg>
    );
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 塗り・線の共通オプションを解決する。色未指定ならテーマのアクセント。 */
function useShapeStyle(options) {
    const t = useDpxTheme();
    const fill = options.fill || 'none';
    const stroke = options.stroke || t.accent;
    return {
        t,
        fill: fill === 'none' ? 'none' : fill,
        fillOpacity: num(options.fillOpacity, 0.14),
        stroke: options.showStroke === false ? 'none' : stroke,
        strokeWidth: num(options.strokeWidth, 1.5),
        strokeOpacity: num(options.strokeOpacity, 0.9),
        dash: options.dashed ? '6 5' : undefined,
    };
}

const COMMON_EDITOR = [
    [{ label: '塗りの色', option: 'fill', editor: 'editor.color' }],
    [{ label: '塗りの濃さ', option: 'fillOpacity', editor: 'editor.slider', editorProps: { min: 0, max: 1, step: 0.02 } }],
    [{ label: '線を表示', option: 'showStroke', editor: 'editor.checkbox' }],
    [{ label: '線の色', option: 'stroke', editor: 'editor.color' }],
    [{ label: '線の太さ', option: 'strokeWidth', editor: 'editor.slider', editorProps: { min: 0.5, max: 8, step: 0.5 } }],
    [{ label: '破線にする', option: 'dashed', editor: 'editor.checkbox' }],
];

const COMMON_SCHEMA = {
    fill: { type: 'string', default: '' },
    fillOpacity: { type: 'number', default: 0.14 },
    showStroke: { type: 'boolean', default: true },
    stroke: { type: 'string', default: '' },
    strokeWidth: { type: 'number', default: 1.5 },
    strokeOpacity: { type: 'number', default: 0.9 },
    dashed: { type: 'boolean', default: false },
};

// ── 矩形（角丸可）───────────────────────────────────────────────
export function ShapeRect({ options = {} }) {
    const s = useShapeStyle(options);
    const r = num(options.radius, 10);
    const inset = s.strokeWidth / 2;
    return (
        <ShapeSvg>
            <rect
                x={inset}
                y={inset}
                width={`calc(100% - ${s.strokeWidth}px)`}
                height={`calc(100% - ${s.strokeWidth}px)`}
                rx={r}
                fill={s.fill}
                fillOpacity={s.fill === 'none' ? 0 : s.fillOpacity}
                stroke={s.stroke}
                strokeWidth={s.strokeWidth}
                strokeOpacity={s.strokeOpacity}
                strokeDasharray={s.dash}
            />
        </ShapeSvg>
    );
}
ShapeRect.config = {
    key: 'shape.rect',
    name: '長方形',
    category: 'shape',
    optionsSchema: { ...COMMON_SCHEMA, radius: { type: 'number', default: 10 } },
    editorConfig: [
        {
            label: '図形',
            layout: [[{ label: '角の丸み', option: 'radius', editor: 'editor.slider', editorProps: { min: 0, max: 40, step: 1 } }], ...COMMON_EDITOR],
        },
    ],
};

// ── 楕円 ────────────────────────────────────────────────────────
export function ShapeEllipse({ options = {} }) {
    const s = useShapeStyle(options);
    return (
        <ShapeSvg>
            <ellipse
                cx="50%"
                cy="50%"
                rx={`calc(50% - ${s.strokeWidth}px)`}
                ry={`calc(50% - ${s.strokeWidth}px)`}
                fill={s.fill}
                fillOpacity={s.fill === 'none' ? 0 : s.fillOpacity}
                stroke={s.stroke}
                strokeWidth={s.strokeWidth}
                strokeOpacity={s.strokeOpacity}
                strokeDasharray={s.dash}
            />
        </ShapeSvg>
    );
}
ShapeEllipse.config = {
    key: 'shape.ellipse',
    name: '楕円',
    category: 'shape',
    optionsSchema: COMMON_SCHEMA,
    editorConfig: [{ label: '図形', layout: COMMON_EDITOR }],
};

// ── 直線 / 矢印 ─────────────────────────────────────────────────
export function ShapeLine({ options = {} }) {
    const s = useShapeStyle(options);
    const vertical = options.orientation === 'vertical';
    const arrow = options.arrow ?? 'none';
    const id = `dpx-arrow-${Math.abs(String(s.stroke).split('').reduce((a, c) => a + c.charCodeAt(0), 0))}`;
    const marker = (
        <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill={s.stroke} />
        </marker>
    );
    const p = vertical
        ? { x1: '50%', y1: '4%', x2: '50%', y2: '96%' }
        : { x1: '2%', y1: '50%', x2: '98%', y2: '50%' };
    return (
        <ShapeSvg overflow="visible">
            <defs>{marker}</defs>
            <line
                {...p}
                stroke={s.stroke}
                strokeWidth={s.strokeWidth}
                strokeOpacity={s.strokeOpacity}
                strokeDasharray={s.dash}
                strokeLinecap="round"
                markerEnd={arrow === 'end' || arrow === 'both' ? `url(#${id})` : undefined}
                markerStart={arrow === 'start' || arrow === 'both' ? `url(#${id})` : undefined}
            />
        </ShapeSvg>
    );
}
ShapeLine.config = {
    key: 'shape.line',
    name: '直線・矢印',
    category: 'shape',
    optionsSchema: {
        ...COMMON_SCHEMA,
        orientation: { type: 'string', default: 'horizontal' },
        arrow: { type: 'string', default: 'none' },
    },
    editorConfig: [
        {
            label: '図形',
            layout: [
                [
                    {
                        label: '向き',
                        option: 'orientation',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { label: '横', value: 'horizontal' },
                                { label: '縦', value: 'vertical' },
                            ],
                        },
                    },
                ],
                [
                    {
                        label: '矢印',
                        option: 'arrow',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { label: 'なし', value: 'none' },
                                { label: '終点', value: 'end' },
                                { label: '始点', value: 'start' },
                                { label: '両端', value: 'both' },
                            ],
                        },
                    },
                ],
                [{ label: '線の色', option: 'stroke', editor: 'editor.color' }],
                [{ label: '線の太さ', option: 'strokeWidth', editor: 'editor.slider', editorProps: { min: 0.5, max: 8, step: 0.5 } }],
                [{ label: '破線にする', option: 'dashed', editor: 'editor.checkbox' }],
            ],
        },
    ],
};

// ── NOC 枠（四隅のカギ括弧）───────────────────────────────────────
// パネルの質感 `noc` と同じ意匠を**図形として**置けるようにしたもの。
//
// なぜ図形版が要るか:
//   カスタム viz（world-map 等）は自前の背景・角丸を持っていることがあり、
//   パネル側の質感を noc にしても**枠だけ浮いて見える**。
//   そういうときは viz のパネルを「枠なし（frameless）」にして、
//   **この図形を裏に敷いて枠だけ描く**と全体の意匠が揃う。
//
// 使い方:
//   1. この図形のパネルを対象 viz と同じ位置・サイズに置く
//   2. 質感＝枠なし（frameless）、`style.z` を viz より小さくする
//   3. 見出しが要るならラベルを入れる（左上に小さく出る）
// ────────────────────────────────────────────────────────────────
export function ShapeNocFrame({ options = {} }) {
    const t = useDpxTheme();
    const color = options.stroke || t.bracketColor || `${t.accent}66`;
    const w = num(options.strokeWidth, 1);
    const len = num(options.cornerLength, 16);
    const pad = num(options.inset, 0);
    const label = String(options.label ?? '');
    const fill = options.fill || 'none';

    // 4隅 × 2辺 の L 字。
    // ⚠ SVG の x1/y1 に calc() は使えない（HTML/CSS 専用）。
    //    % と px を混ぜられないので、実寸を測って px で引く。
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(([e]) => {
            const r = e.contentRect;
            setSize({ w: r.width, h: r.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const { w: W, h: H } = size;
    // ⚠ 線は座標の**中心**に引かれるので、端ちょうど（x=0 / x=W）に置くと
    //   太さの半分が SVG の外にはみ出し、`overflow:hidden` で削られる。
    //   1px 線だと残り 0.5px を `crispEdges` が丸めて**消える**（実機で
    //   右辺・下辺の腕4本が完全に消えていた）。左辺・上辺だけ生き残るのは
    //   内側の半分が残るため。→ 半分ぶん内側に寄せて全体を箱の中に収める。
    const half = w / 2;
    const x0 = pad + half;
    const y0 = pad + half;
    const x1 = W - pad - half;
    const y1 = H - pad - half;
    const arms =
        W > 0 && H > 0
            ? [
                  [x0, y0, x0 + len, y0], [x0, y0, x0, y0 + len],           // 左上
                  [x1 - len, y0, x1, y0], [x1, y0, x1, y0 + len],           // 右上
                  [x0, y1, x0 + len, y1], [x0, y1 - len, x0, y1],           // 左下
                  [x1 - len, y1, x1, y1], [x1, y1 - len, x1, y1],           // 右下
              ]
            : [];

    return (
        <div ref={ref} style={{ width: '100%', height: '100%' }}>
        <ShapeSvg>
            {fill !== 'none' && W > 0 ? (
                <rect
                    x={pad}
                    y={pad}
                    width={Math.max(W - pad * 2, 0)}
                    height={Math.max(H - pad * 2, 0)}
                    fill={fill}
                    fillOpacity={num(options.fillOpacity, 0.18)}
                />
            ) : null}
            {arms.map((a, i) => (
                <line
                    key={i}
                    x1={a[0]}
                    y1={a[1]}
                    x2={a[2]}
                    y2={a[3]}
                    stroke={color}
                    strokeWidth={w}
                    // ⚠ `crispEdges` は座標をピクセル境界に丸めるので、上の
                    //    半ピクセル内寄せを打ち消して端に戻し、また削られる。
                    //    内寄せで箱に収まっている以上、丸めは不要。
                    strokeLinecap="butt"
                />
            ))}
            {label ? (
                <text
                    x={pad + 13}
                    y={pad + 15}
                    fill={t.subColor}
                    fontSize="11"
                    letterSpacing="2"
                    fontFamily="inherit"
                >
                    {label.toUpperCase()}
                </text>
            ) : null}
        </ShapeSvg>
        </div>
    );
}
ShapeNocFrame.config = {
    key: 'shape.nocFrame',
    name: 'コーナーフレーム',
    category: 'shape',
    optionsSchema: {
        label: { type: 'string', default: '' },
        stroke: { type: 'string', default: '' },
        strokeWidth: { type: 'number', default: 1 },
        cornerLength: { type: 'number', default: 16 },
        inset: { type: 'number', default: 0 },
        fill: { type: 'string', default: '' },
        fillOpacity: { type: 'number', default: 0.18 },
    },
    editorConfig: [
        {
            label: '図形',
            layout: [
                [{ label: '見出し', option: 'label', editor: 'editor.text' }],
                [{ label: '線の色', option: 'stroke', editor: 'editor.color' }],
                [
                    {
                        label: '線の太さ',
                        option: 'strokeWidth',
                        editor: 'editor.slider',
                        editorProps: { min: 0.5, max: 4, step: 0.5 },
                    },
                ],
                [
                    {
                        label: 'カギ括弧の長さ',
                        option: 'cornerLength',
                        editor: 'editor.slider',
                        editorProps: { min: 6, max: 60, step: 1 },
                    },
                ],
                [
                    {
                        label: '内側の余白',
                        option: 'inset',
                        editor: 'editor.slider',
                        editorProps: { min: 0, max: 24, step: 1 },
                    },
                ],
                [{ label: '塗りの色', option: 'fill', editor: 'editor.color' }],
                [
                    {
                        label: '塗りの濃さ',
                        option: 'fillOpacity',
                        editor: 'editor.slider',
                        editorProps: { min: 0, max: 1, step: 0.02 },
                    },
                ],
            ],
        },
    ],
};

// ── グラデーションの面（背景の見栄え用）───────────────────────────
export function ShapeGlow({ options = {} }) {
    const t = useDpxTheme();
    const color = options.fill || t.accent;
    const opacity = num(options.fillOpacity, 0.3);
    const id = `dpx-glow-${String(color).replace(/[^a-z0-9]/gi, '')}`;
    const shape = options.shape ?? 'radial';
    return (
        <ShapeSvg>
            <defs>
                {shape === 'radial' ? (
                    <radialGradient id={id}>
                        <stop offset="0%" stopColor={color} stopOpacity={opacity} />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </radialGradient>
                ) : (
                    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={opacity} />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                )}
            </defs>
            <rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
        </ShapeSvg>
    );
}
ShapeGlow.config = {
    key: 'shape.glow',
    name: 'グラデーション面',
    category: 'shape',
    optionsSchema: {
        fill: { type: 'string', default: '' },
        fillOpacity: { type: 'number', default: 0.3 },
        shape: { type: 'string', default: 'radial' },
    },
    editorConfig: [
        {
            label: '図形',
            layout: [
                [
                    {
                        label: '形',
                        option: 'shape',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { label: '放射', value: 'radial' },
                                { label: '縦', value: 'linear' },
                            ],
                        },
                    },
                ],
                [{ label: '色', option: 'fill', editor: 'editor.color' }],
                [{ label: '濃さ', option: 'fillOpacity', editor: 'editor.slider', editorProps: { min: 0, max: 1, step: 0.02 } }],
            ],
        },
    ],
};
