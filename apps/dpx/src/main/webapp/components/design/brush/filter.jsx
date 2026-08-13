// ── Brush Filter（viz を無改変で「塗り替える」層）─────────────────
//
// ⭐⭐ **これが Brush Engine の疎結合を成立させている仕組み。**
//
// ## なぜこれが要るのか
//
// `useBrush()` を viz が呼ぶ方式は、**viz が Brush を知っている**という依存を生む:
//
//     カスタム viz ──依存──> Brush Engine     ✗ 31 viz すべてに対応コードが要る
//
// SVG フィルタなら **panel 側から掛けるだけ**なので、依存の矢印が消える:
//
//     Surface（パネル） ──filter──> [ viz は無改変 ]     ✓
//
// viz は自分が歪まされることを知らない。**WebGL / Canvas / SVG のどれで
// 描いていても効く**（ラスタライズ後に掛かるため）。
//
// ## ⚠ 実測で分かった制約（2026-08-13・オフラインで検証）
//
// **フィルタは文字も歪ませる。** ラベル・凡例・数値が読みにくくなる:
//
// | | flat | watercolor(scale 6) |
// |---|---|---|
// | 線・塗り | — | ✅ 手描きらしくなる |
// | **文字** | — | ⚠ **輪郭が波打つ** |
//
// → **`scale` を抑える**（既定 3〜5）ことと、**強度を選べる**ようにするのが必須。
//   「露骨に効かせる」のは線には正しいが、**文字がある viz では上限がある**。
//
// ## 責務の境界
//
// この層が触るのは**ラスタ後の見た目だけ**。viz のデータ・色・レイアウト・
// 当たり判定には一切干渉しない（フィルタは描画結果に掛かるだけで、
// **ヒットテストは元の DOM の形状で行われる**＝ホバーもクリックも無傷）。
// ────────────────────────────────────────────────────────────────

import React from 'react';

// ⚠ **大きさの判定は `ink.js`（依存ゼロ）に置く。**
//   ここは JSX なので Node の ESM から直接 import できず、テストが書けない。
import { SIZE_TIERS, brushFilterIdForSize } from './ink.js';

/**
 * 画材ごとのフィルタ定義。
 *
 * - `baseFrequency` … 小さいほど大きなうねり（水彩）、大きいほど細かいざらつき（鉛筆）
 * - `numOctaves`    … 重ねるノイズの段数。多いほど複雑（＝重い）
 * - `scale`         … 変位量(px)。**見た目の強さを決める主役**
 *
 * ## ⚠⚠ `scale` は「px の固定値」なので、図形の大きさで効き方が変わる
 *
 * **同じ scale でも、小さい図形では強く・大きい図形では弱く見える。**
 * 変位量が図形サイズに対して何%かで印象が決まるため。
 *
 * | 図形 | 大きさ | scale 4 の相対量 | 見え方 |
 * |---|---|---|---|
 * | 棒（dpx.bar） | 約 60px | 約 7% | しっかり手描き |
 * | ゲージの弧 | 約 270px | 約 1.5% | **ほぼ効いていない** |
 *
 * ⚠ **実際にこれで「カスタム viz に質感が乗らない」と報告された**（2026-08-13）。
 *   フィルタは当たっていたが、弧が大きすぎて変位が見えなかった。
 *
 * → `SIZE_TIERS` で**図形の大きさに応じた倍率**を掛ける（`sizeTierFor`）。
 */
export const BRUSH_FILTERS = {
    watercolor: { type: 'fractalNoise', baseFrequency: 0.018, numOctaves: 3, scale: 5, seed: 7 },
    crayon: { type: 'fractalNoise', baseFrequency: 0.035, numOctaves: 2, scale: 4, seed: 11 },
    pencil: { type: 'turbulence', baseFrequency: 0.055, numOctaves: 2, scale: 2.5, seed: 3 },
    ink: { type: 'turbulence', baseFrequency: 0.03, numOctaves: 1, scale: 2, seed: 5 },
    marker: { type: 'fractalNoise', baseFrequency: 0.012, numOctaves: 1, scale: 3, seed: 13 },
};

export const BRUSH_FILTER_IDS = Object.keys(BRUSH_FILTERS);

export { SIZE_TIERS, brushFilterIdForSize, sizeTierFor } from './ink.js';


/** その画材にフィルタ定義があるか。 */
export function hasBrushFilter(brushId) {
    return Object.prototype.hasOwnProperty.call(BRUSH_FILTERS, brushId);
}

/** フィルタの DOM id（ドキュメント内で一意）。 */
export const brushFilterId = (brushId) => `dpx-brush-${brushId}`;

/**
 * パネルに掛ける CSS の `filter` 値。**画材が無ければ undefined**（何もしない）。
 *
 * ⚠ **`undefined` を返すことが重要**。空文字や `'none'` を返すと
 *   `filter` プロパティ自体が生成され、**合成レイヤが増えて無駄に重くなる**。
 *
 * @param brushId  画材
 * @param intensity 0〜1。0 で無効
 */
export function brushFilterCss(brushId, intensity = 1) {
    if (!hasBrushFilter(brushId) || !(intensity > 0)) return undefined;
    // ⚠ **段（-t1..-t4）を付けた実体を指す。** 素の `dpx-brush-<id>` という
    //   filter は**存在しない**（大きさごとに実体を分けたため）。
    //   存在しない id を指すと **CSS は無言で無視する**＝「効かない」になる。
    //   ここでは既定として標準の段を返し、実際の段は `useInkFilter` が
    //   図形の大きさを測って選び直す。
    return `url(#${brushFilterIdForSize(brushId, 100)})`;
}

/**
 * フィルタの定義を document に常設する。
 *
 * ⚠ **同一ドキュメント内でしか参照できない**（`url(#id)`）。
 *   DPX は全パネルが同じ DOM ツリーにいるので成立するが、
 *   **iframe に隔離される Studio では使えない**（liquidGlass の変位マップと同じ制約）。
 *
 * ⚠ **`filter` は `x/y/width/height` を広げないと端が切れる**。
 *   変位で外へはみ出すぶんの余白を取る（既定の -10%/120%）。
 */
export function BrushFilterDefs({ intensity = 1 }) {
    return (
        <svg
            width="0"
            height="0"
            aria-hidden="true"
            style={{ position: 'absolute', pointerEvents: 'none' }}
        >
            <defs>
                {/* ⚠ **大きさの段ごとに実体を作る**。`scale` は属性なので、
                    1 つの filter を共有すると全部同じ強さになってしまう。 */}
                {BRUSH_FILTER_IDS.flatMap((id) =>
                    SIZE_TIERS.map((tier, ti) => {
                    const f = BRUSH_FILTERS[id];
                    const scale = f.scale * tier.mul * Math.max(0, Math.min(1, intensity));
                    return (
                        <filter
                            key={`${id}-${ti}`}
                            id={`dpx-brush-${id}-t${ti + 1}`}
                            // ⚠ 変位ではみ出す端が切れないよう領域を広げる
                            x="-10%"
                            y="-10%"
                            width="120%"
                            height="120%"
                            // ⚠ **色空間を sRGB に固定する。** 既定の linearRGB だと
                            //   フィルタを通しただけで**色が明るく転ぶ**（見た目が変わる）
                            colorInterpolationFilters="sRGB"
                        >
                            <feTurbulence
                                type={f.type}
                                baseFrequency={f.baseFrequency}
                                numOctaves={f.numOctaves}
                                seed={f.seed}
                                result="dpxNoise"
                            />
                            <feDisplacementMap
                                in="SourceGraphic"
                                in2="dpxNoise"
                                scale={scale}
                                xChannelSelector="R"
                                yChannelSelector="G"
                            />
                        </filter>
                    );
                    })
                )}
            </defs>
        </svg>
    );
}

export default BrushFilterDefs;
