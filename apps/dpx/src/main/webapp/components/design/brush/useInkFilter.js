// ── 印だけに画材を掛ける（Ink Layer の DOM 側）───────────────────
//
// `ink.js` の判定に従って、**viz の中の「印」にだけ** `filter` を当てる。
//
// ## なぜ CSS セレクタ 1 本で済まないのか
//
// 「`svg *` に掛ける」では**入れ子の分だけ多重に掛かる**（親にも子にも
// filter が乗ると歪みが二乗になる）。**最も外側の印にだけ**当てる必要がある。
// これは CSS では表現できないので、DOM を歩いて決める。
//
// ⚠ **viz の DOM を書き換えない**（`style.filter` を足すだけ）。
//   属性やクラスを触ると viz 側の再描画とぶつかる。
//
// ⚠ **viz が再描画すると filter は消える**（React が DOM を作り直すため）。
//   → `MutationObserver` で作り直しを検知して当て直す。
// ────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

import {
    INK_ATTR,
    INK_MARK,
    INK_NONE,
    decideInkScope,
    isDeclarativeOnly,
    isInkShape,
    readInkDeclaration,
} from './ink.js';
import { brushFilterIdForSize } from './filter.jsx';

/**
 * 印だけに filter を当てる。
 *
 * @param filterCss  `url(#…)` または undefined（画材なし）
 * @param allowCanvas canvas を含む viz にも掛けるか（既定 false）
 * @returns ref（viz を包む要素に付ける）
 */
export function useInkFilter(filterCss, allowCanvas = false) {
    const ref = useRef(null);

    useEffect(() => {
        const root = ref.current;
        if (!root) return undefined;

        /** 直前に当てた要素（外すときに使う）。 */
        let applied = [];

        const clear = () => {
            applied.forEach((el) => {
                el.style.filter = '';
            });
            applied = [];
        };

        const apply = () => {
            clear();
            if (!filterCss) return;

            const hasCanvas = root.querySelector('canvas') != null;
            const declaredNodes = [...root.querySelectorAll(`[${INK_ATTR}]`)];
            const values = declaredNodes.map((el) => el.getAttribute(INK_ATTR));
            // ⚠ **`mark` があるだけでは自動検出を止めない。**
            //   止めるのは `only` を明示したときだけ（例外 1 つのために
            //   全部書かせないため）。
            const onlyDeclared = isDeclarativeOnly(values);
            const declared = values.some((v) => readInkDeclaration(v) === INK_MARK) || onlyDeclared;

            const scope = decideInkScope({ hasCanvas, declared, allowCanvas });
            if (!scope.apply) return;

            // Set にするのは、自動検出と宣言で**同じ要素を二重に拾わない**ため
            // （二重に filter を当てると歪みが累積する）
            const targets = new Set();

            // ① 明示的に「印」と書かれたものは必ず入れる
            declaredNodes.forEach((el) => {
                if (readInkDeclaration(el.getAttribute(INK_ATTR)) === INK_MARK) targets.add(el);
            });

            if (!onlyDeclared) {
                // ② 自動検出：SVG の形状要素のうち**最も外側**だけを拾う
                //    ⚠ 入れ子に多重で掛けると歪みが累積する
                const walk = (node, insideText) => {
                    for (const child of node.children) {
                        const tag = child.tagName.toLowerCase();
                        const decl = readInkDeclaration(child.getAttribute?.(INK_ATTR));
                        // ⭐ 明示的に外された部分は**まるごと**飛ばす（子孫も含む）。
                        //   これが「例外を 1 行で書ける」の実体。
                        if (decl === INK_NONE) continue;
                        // 既に印と宣言されているなら、その中は見ない（多重適用を防ぐ）
                        if (decl === INK_MARK) continue;
                        const nowInsideText = insideText || tag === 'text' || tag === 'foreignobject';
                        if (isInkShape(tag, nowInsideText)) {
                            targets.add(child);
                            continue; // ⚠ 子は見ない（多重適用を防ぐ）
                        }
                        walk(child, nowInsideText);
                    }
                };
                walk(root, false);
            }

            // ⭐ **図形の大きさに応じて強さを変える**（2026-08-13 に追加）。
            //   ⚠ `scale` は px の固定値なので、同じ値でも
            //     小さい図形では強く・大きい図形では**ほぼ効かない**。
            //     実際「カスタム viz に質感が乗らない」と報告された原因がこれ。
            const brushId = /#dpx-brush-([\w-]+?)(?:-t\d+)?\)/.exec(filterCss)?.[1];
            [...targets].forEach((el) => {
                if (!brushId) {
                    el.style.filter = filterCss;
                    return;
                }
                let px = 0;
                try {
                    const b = el.getBBox ? el.getBBox() : null;
                    px = b ? Math.max(b.width, b.height) : 0;
                } catch {
                    px = 0; // getBBox は描画前だと落ちることがある
                }
                if (!px) {
                    const r = el.getBoundingClientRect();
                    px = Math.max(r.width, r.height);
                }
                el.style.filter = `url(#${brushFilterIdForSize(brushId, px)})`;
            });
            applied = [...targets];
        };

        apply();

        // ⚠ viz が描き直すと filter が消えるので、作り直しを見て当て直す。
        //    ⚠ **自分の書き換えで無限ループしない**よう、属性変更は監視しない
        //      （`style` だけを触っているため）。
        const mo = new MutationObserver(() => {
            // 連続変更をまとめる（描画中に何度も走らせない）
            if (mo._t) cancelAnimationFrame(mo._t);
            mo._t = requestAnimationFrame(apply);
        });
        mo.observe(root, { childList: true, subtree: true });

        return () => {
            if (mo._t) cancelAnimationFrame(mo._t);
            mo.disconnect();
            clear();
        };
    }, [filterCss, allowCanvas]);

    return ref;
}

export default useInkFilter;
