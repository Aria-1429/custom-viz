// ── Layout Engine レジストリ ────────────────────────────────────
//
// **他の層はこのファイルだけを import する。**
// `layout.type` から実装を引き、以降は同じ契約で呼ぶ。
//
// 新しいレイアウト方式（例: フロー / 自動整列）を足すときは
// **ここに 1 行足すだけ**で、Dashboard Renderer 側は変更不要。
// ────────────────────────────────────────────────────────────────

import { freeformLayout, convertFromGrid, convertToGrid } from './freeformLayout.js';
import { gridLayout } from './gridLayout.js';
import { makeLayoutContext } from './types.js';

export { makeLayoutContext, clamp, toNum } from './types.js';
export { convertFromGrid, convertToGrid } from './freeformLayout.js';
export { cellWidth, rowsToPx } from './gridLayout.js';

const ENGINES = {
    grid: gridLayout,
    freeform: freeformLayout,
};

/**
 * レイアウト実装を引く。
 *
 * ⚠ **未知の type は grid に落とす**（描画を必ず成立させる）。
 *   スキーマ側も `catch` で grid に倒すので二重の保険。
 */
export function resolveLayout(type) {
    return ENGINES[type] ?? gridLayout;
}

/** 定義からレイアウト実装を引く。 */
export function layoutFor(definition) {
    return resolveLayout(definition?.layout?.type);
}

/** UI の選択肢（インスペクタのドロップダウン）。 */
export function listLayouts() {
    return Object.values(ENGINES).map((e) => ({ value: e.id, label: e.name }));
}

/**
 * レイアウト方式を切り替える（座標も変換する）。
 *
 * ⚠ **座標変換を伴わない切替を作らない。** 単位が変わるので、
 *   変換しないと全パネルが画面の隅に固まる（セル 6 → 6px）。
 *
 * @returns 新しい definition（変換不要なら同じ参照）
 */
export function switchLayoutType(definition, nextType, ctx) {
    const current = definition?.layout?.type ?? 'grid';
    if (current === nextType) return definition;

    const panels = definition?.panels ?? [];
    const c = ctx ?? makeLayoutContext({ layout: definition?.layout });
    let nextPanels = panels;
    if (current === 'grid' && nextType === 'freeform') {
        nextPanels = convertFromGrid(panels, c);
    } else if (current === 'freeform' && nextType === 'grid') {
        nextPanels = convertToGrid(panels, c);
    }
    return {
        ...definition,
        layout: { ...(definition.layout ?? {}), type: nextType },
        panels: nextPanels,
    };
}
