// ── DPX Design Engine ───────────────────────────────────────────
//
// **見た目に関するすべてを 4 つの独立した軸にまとめた層。**
// 他の層（Renderer / viz / Layout）は**このファイルだけを import する**。
//
// ```
// DPX Design Engine
// ├── Theme          … 配色（dark / light / custom）        実体: design/theme/
// ├── Surface Engine … 面の質感（flat / glass / …）          実体: design/surface/
// ├── Brush Engine   … 線と塗りの質感（flat / crayon / …）    実体: design/brush/
// └── Motion Engine  … 動きの性格（none / subtle / …）        実体: design/motion.js
//
// ⚠ **4 軸すべてが design/ 配下に実体を持つ**（2026-08-13）。
//   以前は Brush だけ material/ に居て「Material Engine と Design Engine の
//   2 つがある」ように見えていた。material/ は解体済み。
// ```
//
// ## 4 軸は互いに独立している（直交する）
//
// **どの組み合わせも成立する**のが設計の要点:
//   「ダークテーマ × Liquid Glass × 水彩 × スプリング」も
//   「ライト × 紙 × なし × なし」も、同じように選べる。
//   軸をまたいだ暗黙の依存を作らないこと。
//
// ## Brush が疎結合である理由（最重要）
//
// **Brush には 2 つの適用経路があり、既定は「viz を知らない側」**:
//
// | 経路 | viz 側の変更 | 依存の向き | 対象 |
// |---|---|---|---|
// | **① フィルタ**（既定） | **ゼロ** | **なし**（CSS が外から掛かる） | **SVG / Canvas / WebGL すべて** |
// | ② 描画 API | あり | viz → Brush | 自前で作り込む viz だけ |
//
// ①だけで **31 個のカスタム viz が無改変で質感を纏う**。
// ②は「もっと作り込みたい viz」のための任意の口で、**使わなくてよい**。
//
// ⚠ **①は文字も歪ませる**（実測）。強度の既定は「文字が耐えられる上限」に置いてある。
// ────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useMemo } from 'react';

import { BrushProvider } from './brush';
import { QUALITY, resolveQuality } from './quality';
import { resolveTheme } from './theme';
import BrushFilterDefs, { brushFilterCss, hasBrushFilter } from './brush/filter';
import { entranceDelay, resolveMotion } from './motion';

// ── 語彙（スキーマと共有）──────────────────────────────────────
export { MOTION_OPTIONS, MOTION_VALUES, entranceDelay, hasAmbient, resolveMotion } from './motion';
export { BRUSH_FILTERS, BrushFilterDefs, brushFilterCss, brushFilterId, hasBrushFilter } from './brush/filter';

// ── 各エンジンの実体を再輸出（他層はここだけを見る）──────────────
// ⭐ **Theme と Surface はそれぞれ実体を持つ**（2026-08-13 に分離）。
//   以前は 1,514 行の `themes.js` に同居していたため、4 軸のうち 2 つが
//   「図の上だけの区別」だった。今は import 元がそのまま層を表している。
export {
    DPX_PRESETS,
    DpxThemeContext,
    PRESET_ORDER,
    orderedPresets,
    resolveTheme,
    useDpxTheme,
} from './theme';

export {
    PANEL_VARIANTS,
    GROUP_INCOMPATIBLE_VARIANTS,
    bracketArmLength,
    cornerBrackets,
    effectivePanelColor,
    groupSurface,
    groupTitleStyle,
    groupVariants,
    panelStyleOverrides,
    panelSurface,
    panelTitleSkin,
} from './surface';

// ⚠ 以前はここに `./material` という**もう 1 枚の barrel**を挟んでいたが、
//   中身がこのファイルの再輸出そのもの（循環）だったため廃止した。
//   実体から直接輸出する。
export { default as MaterialSurface, useMaterial, useMaterialQuality } from './surface/MaterialSurface';

export {
    QUALITY,
    allowsAnimatedBackground,
    allowsAnimation,
    allowsBackdropFilter,
    allowsGlow,
    applyQuality,
    autoQuality,
    resolveQuality,
} from './quality';

export {
    BRUSH_OPTIONS,
    BRUSH_VALUES,
    INK_ATTR,
    INK_MARK,
    INK_NONE,
    INK_ONLY,
    useInkFilter,
    BrushOverlay,
    BrushProvider,
    BrushStrokes,
    seedFor,
    useBrush,
} from './brush';

// ── Design Engine の文脈 ────────────────────────────────────────

const DesignContext = createContext(null);

/** 解決済みのデザイン設定を読む。 */
export function useDesign() {
    return useContext(DesignContext);
}

/**
 * 定義（`style`）から 4 軸をまとめて解決する。
 *
 * ⚠ **ここが「デザインの単一の入口」**。描画側が個別に
 *   `resolveTheme` / `resolveQuality` / `resolveMotion` を呼ばないこと
 *   （呼ぶと解決規則が散らばり、片方だけ直す事故が起きる）。
 */
export function resolveDesign(definition, { prefersReducedMotion = false } = {}) {
    const style = definition?.style ?? {};
    const quality = resolveQuality({
        explicit: style.quality,
        panelCount: (definition?.panels ?? []).length,
        prefersReducedMotion,
    });
    return {
        theme: resolveTheme(definition ?? {}),
        surface: style.variant ?? null, // パネルごとに決まるので既定は持たない
        brush: style.brush ?? 'flat',
        brushIntensity: Number.isFinite(style.brushIntensity) ? style.brushIntensity : 1,
        motion: resolveMotion({
            motion: style.motion,
            entrance: style.entrance,
            prefersReducedMotion,
            quality,
        }),
        quality,
    };
}

/**
 * Design Engine の Provider。
 *
 * ⭐ **Brush フィルタの定義をここで常設する**。
 *   これにより**カスタム viz は無改変のまま質感を纏える**（疎結合の要）。
 */
export function DesignProvider({ design, children }) {
    const value = useMemo(() => design, [design]);
    return (
        <DesignContext.Provider value={value}>
            {/* 画材が選ばれているときだけ SVG フィルタを document に置く。
                ⚠ 常設しないと `url(#…)` が解決できず**フィルタが無言で無効**になる */}
            {hasBrushFilter(design?.brush) ? (
                <BrushFilterDefs intensity={design.brushIntensity} />
            ) : null}
            {/* 描画 API 経路（②）の文脈も同時に配る。
                ⚠ ①と②は排他ではない。①で全体を歪ませ、②で作り込む viz もありうる */}
            <BrushProvider brushId={design?.brush ?? 'flat'} quality={design?.quality ?? QUALITY.FULL}>
                {children}
            </BrushProvider>
        </DesignContext.Provider>
    );
}

/**
 * **viz を無改変で「塗り替える」ための CSS**（経路①）。
 *
 * パネルの中身を包む要素に当てる。viz は自分が歪まされることを知らない。
 *
 * ⚠ **パネル全体ではなく「viz の中身」に当てる**。
 *   パネル全体に当てるとタイトル・枠まで歪む（枠は Surface の担当なので侵さない）。
 *
 * @returns {{filter?: string}} 画材が無ければ空オブジェクト（プロパティを生成しない）
 */
export function vizBrushStyle(design) {
    const css = brushFilterCss(design?.brush, design?.brushIntensity ?? 1);
    return css ? { filter: css } : {};
}

export { entranceDelay as designEntranceDelay };
export default useDesign;
