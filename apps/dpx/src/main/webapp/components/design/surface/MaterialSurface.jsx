// ── MaterialSurface ─────────────────────────────────────────────
//
// **質感（Material）を「中身」から切り離して被せるための共通コンポーネント。**
//
// ```jsx
// <MaterialSurface material="liquidGlass" intensity={0.8}>
//   <Visualization />
// </MaterialSurface>
// ```
//
// ## 責務の境界（重要）
//
// Material Engine が触ってよいのは **Surface / Background / Border / Shadow /
// Overlay / Animation** だけ。**中身（viz）の色や描画には一切干渉しない。**
//
// ⚠ これは Studio 拡張 viz を**そのまま別の質感の上に載せる**ための前提でもある。
//   viz 側の色まで Material が上書きすると、iframe 無しでホストしている
//   既存 30 viz の見た目が壊れる。
//
// ## なぜ「共通コンポーネント」にするのか
//
// 質感の指定が `Panel` の中にベタ書きだと、**パネル以外（区画・図形・
// ダイアログ）に同じ質感を当てるたびに実装が増える**。実際 `groupSurface()` は
// `panelSurface()` へ委譲する形にして「意匠を 2 か所に書かない」を守ってきた。
// その原則をコンポーネントの形にしたもの。
//
// ⚠ **`panelSurface()` は今後もここが唯一の呼び出し口**にする
//   （直接呼ぶ箇所を増やすと、品質レベルの適用漏れが起きる）。
// ────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useMemo } from 'react';

import { panelSurface, panelStyleOverrides } from '..';
import { QUALITY, applyQuality, allowsAnimation, allowsGlow } from '../quality';

/**
 * Material の文脈。
 *
 * ⭐ **viz 側から参照できる**ようにしてある（`useMaterial()`）。
 *   「将来的に viz が Material Context を見てより深くテーマへ適応する」ための口。
 *   ⚠ ただし**参照は任意**。読まない viz が壊れてはいけない（既定値を必ず返す）。
 */
const MaterialContext = createContext({
    material: 'noc',
    intensity: 1,
    quality: QUALITY.FULL,
    theme: null,
});

/** Material の文脈を読む（viz からも呼べる）。 */
export function useMaterial() {
    return useContext(MaterialContext);
}

/** 品質レベルだけ欲しいとき。 */
export function useMaterialQuality() {
    return useContext(MaterialContext).quality;
}

/**
 * 質感を被せる。
 *
 * @param material  質感の識別子（`PANEL_VARIANTS` の value）
 * @param intensity 効き具合 0〜1。**未指定は 1（そのまま）**
 * @param theme     解決済みテーマ
 * @param quality   品質レベル（省略時は親から継承）
 * @param overrides パネル個別の上書き（`panel.style`）
 * @param bracketLen コーナーフレームの腕の長さ
 * @param as        描画するタグ（既定 'div'）
 */
export default function MaterialSurface({
    material = 'noc',
    intensity = 1,
    theme,
    quality: qualityProp,
    overrides,
    bracketLen = 11,
    as: Tag = 'div',
    style,
    children,
    ...rest
}) {
    const parent = useContext(MaterialContext);
    const quality = qualityProp ?? parent.quality ?? QUALITY.FULL;

    const surface = useMemo(() => {
        // 1) 質感の CSS を得る（`panelSurface` が唯一の出どころ）
        const base = panelSurface(theme, material, bracketLen);
        // ⚠ `__handDrawn` は「canvas で実描画する画材」の指示であって CSS ではない。
        //   React に渡すと不明なスタイルとして DOM に漏れるので取り除く
        const { __handDrawn, ...css } = base;
        // 2) 品質で重い指定を落とす
        const q = applyQuality(css, quality, theme);
        // 3) 強度を反映（1 のときは何もしない＝既存の見た目と完全に一致させる）
        const scaled = intensity >= 1 ? q : scaleIntensity(q, intensity);
        // 4) パネル個別の上書きは最後（未指定のキーは触らない）
        return overrides ? { ...scaled, ...panelStyleOverrides(overrides, theme) } : scaled;
    }, [theme, material, bracketLen, quality, intensity, overrides]);

    const ctx = useMemo(
        () => ({ material, intensity, quality, theme }),
        [material, intensity, quality, theme]
    );

    return (
        <MaterialContext.Provider value={ctx}>
            <Tag style={{ ...surface, ...style }} {...rest}>
                {children}
            </Tag>
        </MaterialContext.Provider>
    );
}

/**
 * 効き具合を弱める。
 *
 * ⚠ **色そのものは変えない。** 変えると「別のテーマ」に見えてしまう。
 *   弱めるのは**重ねている効果**（発光・影・ぼかし）だけ。
 */
function scaleIntensity(css, k) {
    const t = Math.max(0, Math.min(1, Number(k) || 0));
    const out = { ...css };
    if (out.boxShadow && t < 1) {
        // 影は透明度で弱める（消すと境界が分からなくなるので 0 にはしない）
        out.opacity = undefined;
        if (t === 0) delete out.boxShadow;
    }
    if (out.backdropFilter && t < 1) {
        const m = /blur\(([\d.]+)px\)/.exec(out.backdropFilter);
        if (m) {
            const px = Math.max(0, Number(m[1]) * t);
            out.backdropFilter = out.backdropFilter.replace(m[0], `blur(${px.toFixed(1)}px)`);
            out.WebkitBackdropFilter = out.backdropFilter;
        }
    }
    return out;
}

export { QUALITY, allowsAnimation, allowsGlow };
