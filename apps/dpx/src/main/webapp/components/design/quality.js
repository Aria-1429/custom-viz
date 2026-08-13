// ── Material の品質レベル（性能の逃がし弁）────────────────────────
//
// **目的**: 見た目のための重い処理を、**パネル数や環境に応じて自動で簡略化する**。
//
// ⚠ **これは「見た目を諦める機能」ではない。**
//   実測（viz-performance.md）で分かっているのは:
//     - **面積に比例する半透明の塗り**（`backdrop-filter` / SVG フィルタ / 大きな
//       radialGradient）が支配的なコストで、**パネル数に比例して効く**
//     - `transform` / `opacity` の animate は合成に載るので**ほぼ無料**
//   つまり**削るべきものは決まっている**。全部を薄くする必要はない。
//
// ## 3 段階
//
// | level | 何が変わるか | いつ |
// |---|---|---|
// | `full` | 全部そのまま | 既定（パネルが少ない） |
// | `reduced` | `backdrop-filter` を落とす／canvas 背景を静止画に | パネルが多い |
// | `minimal` | ＋発光・影も落とす | `prefers-reduced-motion` / 極端に多い |
//
// ⚠ **`backdrop-filter` を最初に落とす**のは、これが
//   「下が動くたび再ブラー」＋「文字のサブピクセル AA を無効化」という
//   二重の害を持つため（実測で確定している唯一の明確な犯人）。
//
// ⚠ **色や配置は絶対に変えない。** 品質レベルで変わるのは
//   **エフェクトの有無だけ**。地の色が変わると「テーマが切り替わった」ように見える。
// ────────────────────────────────────────────────────────────────

/** 品質レベル。 */
export const QUALITY = { FULL: 'full', REDUCED: 'reduced', MINIMAL: 'minimal' };

/**
 * パネル数から既定の品質を決める。
 *
 * ⚠ **閾値は「実測の目安」であって物理法則ではない。**
 *   viz-performance.md の計測（1080p・半透明の塗りが支配的な構成で
 *   4 面から劣化が見え始めた）に合わせてある。
 *   明示指定（`style.quality`）があればそちらが優先。
 */
export function autoQuality(panelCount) {
    const n = Number(panelCount) || 0;
    if (n >= 24) return QUALITY.MINIMAL;
    if (n >= 10) return QUALITY.REDUCED;
    return QUALITY.FULL;
}

/**
 * 実際に使う品質を決める。
 *
 * 優先順位: 明示指定 > reduced-motion > パネル数からの自動判定
 *
 * ⚠ **`prefers-reduced-motion` を尊重する**（アクセシビリティ）。
 *   「動きで酔う」利用者がいる。演出より優先する。
 */
export function resolveQuality({ explicit, panelCount, prefersReducedMotion } = {}) {
    // ⚠ `'auto'` は「未指定」を意味する（スキーマの既定値）。明示指定として扱わない
    if (explicit && explicit !== 'auto' && Object.values(QUALITY).includes(explicit)) {
        return explicit;
    }
    if (prefersReducedMotion) return QUALITY.MINIMAL;
    return autoQuality(panelCount);
}

/** その品質で `backdrop-filter` を使ってよいか。 */
export function allowsBackdropFilter(quality) {
    return quality === QUALITY.FULL;
}

/** その品質でアニメーション（出現・常時）を出してよいか。 */
export function allowsAnimation(quality) {
    return quality !== QUALITY.MINIMAL;
}

/** その品質で発光・影を出してよいか。 */
export function allowsGlow(quality) {
    return quality !== QUALITY.MINIMAL;
}

/** その品質で canvas 背景を動かしてよいか（false なら静止画）。 */
export function allowsAnimatedBackground(quality) {
    return quality === QUALITY.FULL;
}

/**
 * 質感（surface）の CSS から、品質に応じて重い指定を落とす。
 *
 * ⚠ **`backdropFilter` を消すときは不透明度を上げる。**
 *   すりガラスは「半透明＋ぼかし」で成立しているので、ぼかしだけ消すと
 *   **ただの薄い板**になって下の背景が透けて読めなくなる（実機で確認済みの原則）。
 *
 * @param css     panelSurface() 等が返した CSS
 * @param quality 品質レベル
 * @param theme   解決済みテーマ（不透明化に地の色が要る）
 */
export function applyQuality(css, quality, theme) {
    if (!css || quality === QUALITY.FULL) return css;
    const out = { ...css };

    // 1) backdrop-filter は最優先で落とす（面積比例＋文字がぼやける）
    if (out.backdropFilter || out.WebkitBackdropFilter) {
        delete out.backdropFilter;
        delete out.WebkitBackdropFilter;
        // ぼかしを失うぶん、地を不透明側へ寄せて可読性を保つ
        if (theme?.panelBg) out.backgroundColor = theme.panelBg;
    }

    if (quality === QUALITY.MINIMAL) {
        // 2) 発光・影（面積比例の塗り）を落とす。
        //    ⚠ **枠線は残す**。影を消すと境界が消えてパネルが判別できなくなる
        if (out.boxShadow) delete out.boxShadow;
        if (out.filter) delete out.filter;
    }
    return out;
}
