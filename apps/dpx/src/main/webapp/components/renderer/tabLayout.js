// ── タブ 1 枚ぶんのレイアウト解決 ─────────────────────────────────
//
// 「そのタブに属するパネル・区画」と「区画の見出し行を挿し込んだ行番号」を求める。
//
// ## なぜ切り出すのか（2026-08-15）
//
// タブを隠して残す方式にしたことで、**表示中でないタブについても同じ計算が要る**
// ようになった。以前は `DpxDashboard` の本体に「現在のタブ」決め打ちで直書き
// されていたため、そのままでは他タブぶんを求められなかった。
//
// 切り出しの利点はもう 1 つある。**この計算は React を必要としない**——
// 定義とパネル配列から決まる純粋な関数なので、**素の Node でテストできる**。
// 区画の見出し行は「ずれると罫が見出しに重なる」という見た目の事故に直結する
// のに、これまで機械的な検査が無かった。
//
// ⚠ **定義（panel.y）は書き換えない。** ずらすのは**描画時の行番号だけ**。
//   定義を書き換えると、保存されて次回さらにずれる（二重適用）。
// ────────────────────────────────────────────────────────────────

// ⚠ **拡張子を明示する**（素の Node でテストするため。webpack は省略でも解決するが、
//   Node の ESM は解決できず `ERR_MODULE_NOT_FOUND` になる）
import { getGroups, groupRect, groupTab, reserveHeaderRows } from './groups.js';

/**
 * 区画（グループ）のヘッダ帯の高さ(px)。罫と区画名がここに入る。
 *
 * ⚠ **区画は自分の見出しの場所を自分で持つ。** 帯を持たずに見出しを枠の外へ
 *   逃がすと、上にあるもの（パネルの上端・ダッシュボードの見出し）と
 *   **必ず重なる**（実機で発生）。最上段の区画のためにグリッド側にも
 *   同じ高さの余白を空ける（`paddingTop`）。
 *
 * ⚠ **定義はここ 1 か所**（行テンプレートを組む側と余白を空ける側で共有する）。
 *   両方に数値を書くと、片方だけ直して罫がずれる。
 */
export const GROUP_HEADER_H = 18;

/**
 * タブに属するパネルを取り出す。
 *
 * ⚠ **タブ未指定のパネルは先頭タブに属する**（既存ボードとの互換）。
 *   ここを落とすと、タブを後から足したボードでパネルが消える。
 */
export function panelsOfTab(panels, tabs, tabId) {
    if (!Array.isArray(panels)) return [];
    if (!tabs || tabs.length === 0) return panels;
    const first = tabs[0].id;
    return panels.filter((p) => (p.tab ?? first) === tabId);
}

/**
 * タブ 1 枚ぶんのレイアウトを解決する（純粋関数）。
 *
 * @param {object} params
 * @param {object} params.definition ダッシュボード定義
 * @param {Array}  params.allPanels  全パネル（区画のタブ判定に使う）
 * @param {Array}  params.tabPanels  そのタブのパネル
 * @param {Array|null} params.tabs   定義上のタブ（null = 単一画面）
 * @param {string|null} params.tabId 対象タブ ID
 * @param {number} params.rowHeight  1 行の高さ(px)
 * @returns {{groups:Array, labeled:boolean, headerRows:Set<number>,
 *            rowOf:Function, rowTemplate:(string|undefined)}}
 */
export function resolveTabLayout({ definition, allPanels, tabPanels, tabs, tabId, rowHeight }) {
    // そのタブに属する区画だけ（切り替えても前のタブの枠が残らないように）
    const groups = getGroups(definition).filter(
        (g) => !tabs || (groupTab(g, allPanels) ?? tabs[0].id) === tabId
    );

    // 見出し付きの区画が**最上段（y=0）**にあるか。ある時だけ上部に隙間を作る。
    // ⚠ 「区画がある」ではなく「最上段にある」で判定する。下段だけの区画で
    //   隙間を作ると、既存ボードが理由もなく間延びする。
    // ⚠ **ラベルの有無で判定しない。** 名前が無い区画もヘッダ帯のぶん上へ伸びる
    //   ので、空けないと罫がダッシュボードの見出しに重なる（実機で発生）。
    const labeled = groups.some((g) => {
        const r = groupRect(g, tabPanels);
        return r != null && r.y === 0;
    });

    // ⭐ 区画の見出し用の行を確保する（最上段以外でも領域を取る）
    const maxRow = tabPanels.reduce(
        (m, p) => Math.max(m, (Number(p.y) || 0) + (Number(p.h) || 1)),
        0
    );
    const { headerRows, rowOf } = reserveHeaderRows(groups, tabPanels, maxRow);

    // 見出し行だけ低く、他は rowHeight。
    // ⚠ `gridAutoRows` では「見出し行だけ低く」ができない（全行同じ高さになる）
    //   ので、挿し込みがあるときは `gridTemplateRows` を明示する。
    let rowTemplate;
    if (headerRows.size > 0) {
        const rows = [];
        for (let y = 0; y < maxRow; y += 1) {
            if (headerRows.has(y)) rows.push(`${GROUP_HEADER_H}px`);
            rows.push(`${rowHeight}px`);
        }
        rowTemplate = rows.join(' ');
    }

    return { groups, labeled, headerRows, rowOf, rowTemplate };
}
