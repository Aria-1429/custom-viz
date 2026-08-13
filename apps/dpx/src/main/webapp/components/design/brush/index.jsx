// ── Brush Engine の公開 API ─────────────────────────────────────
//
// **グラフの線と塗りに画材の質感を与える。** パネルの質感（Surface）とは別軸。
//
// ## 設計の 4 原則（ユーザー指定・2026-08-13）
//
// 1. **中間表現 `BrushPath[]`** … 単一 `d` に固定しない。
//    描画ライブラリの型を公開 API に漏らさない（`brushes.js` に閉じる）
// 2. **決定論的 seed** … 再描画・再サーチで形が変わらない（`seedFor`）
// 3. **Visual と Interaction の分離** … 当たり判定は**元の geometry** を使う
// 4. **`flat` は再生成しない** … 既存の SVG 描画経路をそのまま通す
//
// ## 使い方（viz 側）
//
// ```jsx
// const brush = useBrush();                       // flat なら null
// const paths = brush?.line(pts, seedFor(panelId, name, pts.length));
//
// {paths
//   ? <BrushStrokes paths={paths} color={color} />   // 画材
//   : <path d={line} stroke={color} … />}            // ← flat は完全に元のまま
// ```
//
// ⚠⚠ **`flat` 用の Brush 実装を作らないこと。**
//   「flat のはずなのに微妙に違う」が必ず起きる。
//   分岐は `brush === null` の 1 か所だけにする（原則 4）。
//
// ## 当たり判定について（原則 3）
//
// **Brush が返すのは「見た目」だけ。** ホバー・ツールチップ・時間ブラシ・
// ドリルダウンの当たり判定は**元の座標**を使い続ける。
// 実際 `dpx.line` は既にこの形になっている（ポインタは背面の `<rect>` が拾い、
// 線の `<path>` は `pointerEvents:'none'`）ので、Brush を被せても影響しない。
//
// ⚠ **Brush で描いた path には必ず `pointerEvents:'none'` を付ける**
//   （`BrushStrokes` が自動で付ける）。付けないと、ふらついた線が
//   当たり判定を持ってしまい「線の上だけ反応が違う」ことになる。
// ────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useMemo } from 'react';

import { BRUSH_VALUES } from '../../schema/vocab.js';
import { QUALITY } from '../quality';
import { brushArc, brushArea, brushLine, brushRect, hasBrush } from './brushes.js';
import { ROLE, prunePaths, seedFor } from './types.js';

export { ROLE, seedFor, prunePaths } from './types.js';
// ⭐ Ink Layer（画材を**どこに**掛けるか）。
//   ⚠ ここを間違えると文字まで歪む。詳細は ink.js の冒頭。
export { INK_ATTR, INK_MARK, INK_NONE, INK_ONLY, decideInkScope, isDeclarativeOnly, isInkShape } from './ink.js';
export { useInkFilter } from './useInkFilter.js';
export { BRUSH_IDS } from './brushes.js';

/** 画材の選択肢（UI 用）。`flat` は「画材を使わない」。
 *  ⚠ **値の一覧は `dashboardSchema/vocab.js` が正**（スキーマと二重定義にしない）。
 *    ここは表示名だけを持つ。 */
const BRUSH_LABELS = {
    flat: 'なし（通常）',
    pencil: '色鉛筆',
    crayon: 'クレヨン',
    watercolor: '水彩',
    ink: 'インク',
    marker: 'マーカー',
};

export const BRUSH_OPTIONS = BRUSH_VALUES.map((value) => ({
    value,
    label: BRUSH_LABELS[value] ?? value,
}));

export { BRUSH_VALUES };

const BrushContext = createContext({ brushId: 'flat', quality: QUALITY.FULL });

/** Brush の文脈を配る（DpxDashboard が張る）。 */
export function BrushProvider({ brushId = 'flat', quality = QUALITY.FULL, children }) {
    const value = useMemo(() => ({ brushId, quality }), [brushId, quality]);
    return <BrushContext.Provider value={value}>{children}</BrushContext.Provider>;
}

/**
 * 画材を取り出す。
 *
 * ⭐ **`flat`（既定）では `null` を返す。**
 *   viz 側は `if (!brush)` で**従来の描画経路にそのまま落ちる**＝完全な後方互換。
 *
 * @returns {{line, area, rect, quality}|null}
 */
export function useBrush() {
    const { brushId, quality } = useContext(BrushContext);
    return useMemo(() => {
        // 原則 4: flat は再生成しない（実装を持たせない）
        if (!brushId || brushId === 'flat' || !hasBrush(brushId)) return null;
        const prune = (paths) => prunePaths(paths, quality);
        return {
            id: brushId,
            quality,
            /** 折れ線 → BrushPath[] */
            line: (points, seed) => prune(brushLine(points, seed, brushId)),
            /** 閉じた面 → BrushPath[] */
            area: (points, seed, color) => prune(brushArea(points, seed, brushId, color)),
            /** 矩形（棒 1 本）→ BrushPath[] */
            rect: (x, y, w, h, seed, color) => prune(brushRect(x, y, w, h, seed, brushId, color)),
            /** 円弧（ドーナツの扇形）→ BrushPath[] */
            arc: (cx, cy, rOuter, rInner, a0, a1, seed, color) =>
                prune(brushArc(cx, cy, rOuter, rInner, a0, a1, seed, brushId, color)),
        };
    }, [brushId, quality]);
}

/**
 * BrushPath[] を SVG として描く。
 *
 * ⚠ **`pointerEvents: 'none'` を必ず付ける**（原則 3）。
 *   ふらついた線が当たり判定を持つと、ホバーの反応が線の形に依存してしまう。
 */
export function BrushStrokes({ paths, color, opacity = 1 }) {
    if (!Array.isArray(paths) || paths.length === 0) return null;
    return (
        <g pointerEvents="none">
            {paths.map((p, i) => (
                <path
                    // ⚠ seed が同じなら d も同じなので key に使える（決定論的）
                    key={`${p.role}-${i}`}
                    d={p.d}
                    fill={p.filled ? (p.color ?? color) : 'none'}
                    stroke={p.filled ? 'none' : (p.color ?? color)}
                    strokeWidth={p.width || undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={p.opacity * opacity}
                />
            ))}
        </g>
    );
}

/**
 * **CSS の div で描く viz（棒・ランキング）に画材を被せるためのオーバーレイ。**
 *
 * ⚠ `dpx.bar` / `dpx.ranking` は SVG ではなく **div の高さ・幅**で棒を描いている。
 *   構造を SVG に書き換えると**ホバー・クリック・アニメを全部作り直す**ことになるので、
 *   **元の div はそのまま残し、上に SVG を重ねて画材だけを描く**。
 *
 * 使い方（棒 1 本を包む要素に `position:relative` があること）:
 * ```jsx
 * <div style={{ position:'relative', height:'40%' }}>
 *   {paint ? <BrushOverlay paint={paint} seed={seed} color={color} /> : null}
 * </div>
 * ```
 *
 * ⚠ **要素の実寸が要る**ので `ResizeObserver` で測る。
 *   0 幅・0 高のときは何も描かない（`brushRect` が空を返す）。
 * ⚠ 当たり判定は元の div が持つ（この SVG は `pointerEvents:'none'`）。
 */
export function BrushOverlay({ paint, seed, color, opacity = 1, inset = 0 }) {
    const ref = React.useRef(null);
    const [size, setSize] = React.useState({ w: 0, h: 0 });

    // ⚠ **callback ref ではなく effect + ref で測る**と、データ到着前に
    //   early return する経路で観測が始まらないことがある（§8.3）。
    //   ここは常に描画されるので effect でよいが、要素が無い間は無視する。
    React.useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => {
            const w = Math.round(e?.contentRect?.width ?? 0);
            const h = Math.round(e?.contentRect?.height ?? 0);
            setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const paths = React.useMemo(() => {
        if (!paint || size.w <= 0 || size.h <= 0) return [];
        return paint.rect(inset, inset, size.w - inset * 2, size.h - inset * 2, seed, color);
    }, [paint, size.w, size.h, seed, color, inset]);

    return (
        <div
            ref={ref}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            aria-hidden="true"
        >
            {size.w > 0 && paths.length > 0 ? (
                <svg width={size.w} height={size.h} style={{ display: 'block' }}>
                    <BrushStrokes paths={paths} color={color} opacity={opacity} />
                </svg>
            ) : null}
        </div>
    );
}

export default useBrush;
