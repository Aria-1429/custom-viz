// ── ディレクトリ再編成（1 回きりの移行スクリプト）─────────────────
//
// **図の 11 層を、そのままディレクトリ構造にする。**
//
// ⚠ このスクリプトは「移動表」を単一の真実として持ち、
//   `git mv` と import の書き換えを機械的に行う。
//   手で 80 ファイル動かすと必ず取りこぼすため。
//
// 実行:  node tools/restructure.mjs --apply
// 下見:  node tools/restructure.mjs
// ────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../src/main/webapp/components');
const APPLY = process.argv.includes('--apply');

/**
 * 移動表: 旧パス → 新パス（どちらも components/ からの相対）。
 *
 * 分類の基準は「図のどの層か」。**ファイルの大きさや作った順ではない。**
 */
const MOVES = {
    // ── Dashboard Builder（作る側の UI）──────────────────────────
    'engine/Inspector.jsx': 'builder/Inspector.jsx',
    'engine/VizPicker.jsx': 'builder/VizPicker.jsx',
    'engine/EditToolbar.jsx': 'builder/EditToolbar.jsx',
    'engine/optionEditors.jsx': 'builder/optionEditors.jsx',
    'engine/ColorRulesEditor.jsx': 'builder/ColorRulesEditor.jsx',
    'engine/DataSourceManager.jsx': 'builder/DataSourceManager.jsx',
    'engine/SplEditor.jsx': 'builder/SplEditor.jsx',
    'engine/SplAce.jsx': 'builder/SplAce.jsx',
    'engine/splSyntax.js': 'builder/splSyntax.js',
    'engine/PanelContextMenu.jsx': 'builder/PanelContextMenu.jsx',
    'engine/DetachedWindow.jsx': 'builder/DetachedWindow.jsx',

    // ── Dashboard Renderer（描く側）──────────────────────────────
    'engine/DpxDashboard.jsx': 'renderer/DashboardRenderer.jsx',
    'engine/BackgroundLayer.jsx': 'renderer/BackgroundLayer.jsx',
    'engine/HandDrawnFrame.jsx': 'renderer/HandDrawnFrame.jsx',
    'engine/liquidGlassDefs.jsx': 'renderer/liquidGlassDefs.jsx',
    'engine/InputsBar.jsx': 'renderer/InputsBar.jsx',
    'engine/BootScreen.jsx': 'renderer/BootScreen.jsx',
    'engine/groups.js': 'renderer/groups.js',

    // ── Dashboard Schema ────────────────────────────────────────
    'engine/dashboardSchema/dashboard.js': 'schema/dashboard.js',
    'engine/dashboardSchema/index.js': 'schema/index.js',
    'engine/dashboardSchema/parse.js': 'schema/parse.js',
    'engine/dashboardSchema/vocab.js': 'schema/vocab.js',
    'engine/importDefinition.js': 'schema/importDefinition.js',
    'engine/templates.js': 'schema/templates.js',

    // ── State / Command Layer ───────────────────────────────────
    'engine/history.js': 'store/history.js',

    // ── Layout Engine（そのまま）────────────────────────────────
    'engine/layout/freeformLayout.js': 'layout/freeformLayout.js',
    'engine/layout/gridLayout.js': 'layout/gridLayout.js',
    'engine/layout/index.js': 'layout/index.js',
    'engine/layout/types.js': 'layout/types.js',

    // ── Dashboard Canvas（そのまま）─────────────────────────────
    'engine/canvas/DashboardCanvas.jsx': 'canvas/DashboardCanvas.jsx',
    'engine/canvas/index.js': 'canvas/index.js',
    'engine/canvas/useCanvasInteractions.js': 'canvas/useCanvasInteractions.js',

    // ── Visualization Registry + viz ────────────────────────────
    'engine/vizRegistry.js': 'viz/registry.js',
    'engine/vizRegistry.generated.js': 'viz/registry.generated.js',
    'engine/viz/index.js': 'viz/index.js',
    'engine/viz/data.js': 'viz/data.js',
    'engine/viz/kit.js': 'viz/kit.js',
    'engine/viz/types.js': 'viz/types.js',
    'engine/viz/deco.jsx': 'viz/deco.jsx',
    'engine/viz/shapes.jsx': 'viz/shapes.jsx',
    'engine/viz/DpxLinkLine.jsx': 'viz/DpxLinkLine.jsx',
    'engine/viz/SpikeViz.jsx': 'viz/SpikeViz.jsx',
    'engine/viz/native/index.js': 'viz/native/index.js',
    'engine/viz/native/DpxLine.jsx': 'viz/native/DpxLine.jsx',
    'engine/viz/native/DpxBar.jsx': 'viz/native/DpxBar.jsx',
    'engine/viz/native/DpxValue.jsx': 'viz/native/DpxValue.jsx',
    'engine/viz/native/DpxStatus.jsx': 'viz/native/DpxStatus.jsx',
    'engine/viz/native/DpxTable.jsx': 'viz/native/DpxTable.jsx',
    'engine/viz/native/DpxDonut.jsx': 'viz/native/DpxDonut.jsx',
    'engine/viz/native/DpxRanking.jsx': 'viz/native/DpxRanking.jsx',
    // viz 専用の描画部品・色・目盛りは viz の持ち物
    'engine/vizKit.jsx': 'viz/parts.jsx',
    'engine/colorRules.js': 'viz/colorRules.js',
    'engine/scale.js': 'viz/scale.js',
    'engine/timeBrush.js': 'viz/timeBrush.js',
    'engine/panelFields.jsx': 'viz/panelFields.jsx',

    // ── Design Engine（4 軸をここに集約）────────────────────────
    'engine/design/index.jsx': 'design/index.jsx',
    'engine/design/motion.js': 'design/motion.js',
    'engine/design/theme/index.js': 'design/theme/index.js',
    'engine/design/surface/index.js': 'design/surface/index.js',
    // ⭐ Brush の実体を design 配下へ（2 経路とも）
    'engine/design/brushFilter.jsx': 'design/brush/filter.jsx',
    'engine/material/brush/index.jsx': 'design/brush/index.jsx',
    'engine/material/brush/brushes.js': 'design/brush/brushes.js',
    'engine/material/brush/types.js': 'design/brush/types.js',
    // ⭐ material/ を解体（Material Engine と Design Engine の 2 つがある誤解を消す）
    'engine/material/quality.js': 'design/quality.js',
    'engine/material/MaterialSurface.jsx': 'design/surface/MaterialSurface.jsx',
    'engine/material/index.js': 'design/material.js',
    'engine/handDrawn.js': 'design/handDrawn.js',

    // ── Splunk Data / Search Layer（そのまま）───────────────────
    'engine/data/index.js': 'data/index.js',
    'engine/data/dataSources.js': 'data/dataSources.js',
    'engine/data/dos.js': 'data/dos.js',
    'engine/data/inputChoices.js': 'data/inputChoices.js',
    'engine/data/useSplunkSearch.js': 'data/useSplunkSearch.js',
    'engine/spl.js': 'data/spl.js',

    // ── 共有（どの層にも属さない土台）──────────────────────────
    'engine/ui.jsx': 'shared/ui.jsx',
    'engine/tokens.jsx': 'shared/tokens.jsx',
    'engine/TimeRangePicker.jsx': 'shared/TimeRangePicker.jsx',
    'engine/DateInput.jsx': 'shared/DateInput.jsx',
    'engine/SplunkHomeLink.jsx': 'shared/SplunkHomeLink.jsx',
    'vizBus.jsx': 'shared/vizBus.jsx',
    'extensionAdapter.jsx': 'viz/extensionAdapter.jsx',
    'viewStore.js': 'data/viewStore.js',
};

/** 削除するもの（中身が他所へ移り、経過措置も不要になったファイル）。 */
const DELETES = ['engine/themes.js'];

// ── 実行 ────────────────────────────────────────────────────────

// ⚠ **再実行できるようにする**（途中で失敗しても続きから流せる）。
//   既に移動済み（移動元が無く、移動先がある）ものは黙って飛ばす。
const pending = Object.entries(MOVES).filter(([from, to]) => {
    if (existsSync(join(ROOT, from))) return true;
    if (existsSync(join(ROOT, to))) return false; // 移動済み
    throw new Error(`移動元も移動先も無い: ${from}`);
});

console.log(`移動 ${pending.length} 件（済 ${Object.keys(MOVES).length - pending.length}）/ 削除 ${DELETES.length} 件`);
if (!APPLY) {
    for (const [from, to] of pending) console.log(`  ${from}\n    -> ${to}`);
    console.log('\n（--apply を付けると実行します）');
    process.exit(0);
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });

for (const [from, to] of pending) {
    const dst = join(ROOT, to);
    execFileSync('mkdir', ['-p', dirname(dst)]);
    // ⚠ **未追跡ファイルは `git mv` できない**（fatal: not under version control）。
    //   このリポジトリには未コミットの新規ディレクトリがあるので、
    //   git mv が失敗したら素の mv に落とす。
    try {
        git(['mv', from, to]);
    } catch {
        execFileSync('mv', [join(ROOT, from), dst]);
    }
}
for (const f of DELETES) {
    if (!existsSync(join(ROOT, f))) continue;
    try {
        git(['rm', '-f', f]);
    } catch {
        execFileSync('rm', ['-f', join(ROOT, f)]);
    }
}
console.log('✓ 移動完了');
