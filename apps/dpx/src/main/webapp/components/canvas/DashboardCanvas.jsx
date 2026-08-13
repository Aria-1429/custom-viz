// ── Dashboard Canvas（ストアに繋がった編集の器）───────────────────
//
// **Renderer を「ストアに繋がった状態」で使うための薄い層。**
//
// ```
// DashboardPage（画面）
//    └─ DashboardCanvas   … ストアから定義を取り、編集コマンドを配る（このファイル）
//         └─ DpxDashboard … Renderer。props で受けたものを描くだけ
// ```
//
// ## なぜこの層が要るのか（疎結合のため）
//
// **Renderer にストアを直接読ませない。** 読ませると:
//   - 表示専用の用途（壁掛け・埋め込み・印刷・別ウィンドウ）で
//     **ストアごと持ち込む羽目になる**
//   - Renderer のテストにストアの初期化が要る
//
// → **Renderer は props だけで動く純粋な層**に保ち、
//   「どこから定義を取るか」はこの層が決める。
//   定義が手元にある場面（プレビュー・印刷）では `DpxDashboard` を直接使えばよい。
//
// ⚠ **編集は必ず Command（`patch*` / `dispatch`）を通す。**
//   ストアの `setState` を直接叩かないこと（履歴に載らない操作が生まれる）。
// ────────────────────────────────────────────────────────────────

import React from 'react';

import DpxDashboard from '../renderer/DashboardRenderer';
import {
    patchPanel,
    removePanel,
    selectDefinition,
    useDashboardStore,
} from '../store/dashboardStore';

/**
 * ストアの定義で Renderer を描く。
 *
 * 定義以外（選択状態・モード・各種ハンドラ）は呼び出し側から受け取る。
 * ⚠ **`definition` を props で渡さない**（渡せる形にすると
 *   「ストアと props のどちらが正か」が曖昧になる）。
 *   定義を手で渡したい場面では `DpxDashboard` を直接使う。
 */
export default function DashboardCanvas(props) {
    const definition = useDashboardStore(selectDefinition);
    if (!definition) return null;
    return (
        <DpxDashboard
            {...props}
            definition={definition}
            // ⭐ 配置の確定とパネル削除は Command 経由（履歴に必ず載る）
            onPanelLayout={props.onPanelLayout ?? patchPanel}
            onPatchPanel={props.onPatchPanel ?? patchPanel}
            onRemovePanel={props.onRemovePanel ?? removePanel}
        />
    );
}
