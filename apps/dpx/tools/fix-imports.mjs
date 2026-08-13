// ── 再編成後の import パスを直す ────────────────────────────────
//
// ディレクトリを動かしたあと、**相対 import を機械的に貼り直す**。
//
// ## 考え方（ここを間違えると直らない）
//
// 相対 import は「**書いた側の元の場所**」から解決しないと意味が取れない。
//   例: `viz/index.js` にある `'../themes'` は、
//       このファイルが元 `engine/viz/index.js` だったので `engine/themes` を指す。
//       今の場所（`viz/`）から `../themes` と読むと `themes` になり、**別物**。
//
// → 各ファイルの**旧パス**を持っておき、
//    「旧位置 + 相対指定」で旧ターゲットを求め、移動表で新ターゲットへ引き直し、
//    「**新位置**から見た相対パス」を書き戻す。
//
// 実行: node tools/fix-imports.mjs [--apply]
// ────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../src/main/webapp/components');
const APPLY = process.argv.includes('--apply');

/** 旧パス（components 相対・拡張子つき）→ 新パス。restructure.mjs と同じ表。 */
const MOVES = {
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
    'engine/DpxDashboard.jsx': 'renderer/DashboardRenderer.jsx',
    'engine/BackgroundLayer.jsx': 'renderer/BackgroundLayer.jsx',
    'engine/HandDrawnFrame.jsx': 'renderer/HandDrawnFrame.jsx',
    'engine/liquidGlassDefs.jsx': 'renderer/liquidGlassDefs.jsx',
    'engine/InputsBar.jsx': 'renderer/InputsBar.jsx',
    'engine/BootScreen.jsx': 'renderer/BootScreen.jsx',
    'engine/groups.js': 'renderer/groups.js',
    'engine/dashboardSchema/dashboard.js': 'schema/dashboard.js',
    'engine/dashboardSchema/index.js': 'schema/index.js',
    'engine/dashboardSchema/parse.js': 'schema/parse.js',
    'engine/dashboardSchema/vocab.js': 'schema/vocab.js',
    'engine/importDefinition.js': 'schema/importDefinition.js',
    'engine/templates.js': 'schema/templates.js',
    'engine/history.js': 'store/history.js',
    'engine/layout/freeformLayout.js': 'layout/freeformLayout.js',
    'engine/layout/gridLayout.js': 'layout/gridLayout.js',
    'engine/layout/index.js': 'layout/index.js',
    'engine/layout/types.js': 'layout/types.js',
    'engine/canvas/DashboardCanvas.jsx': 'canvas/DashboardCanvas.jsx',
    'engine/canvas/index.js': 'canvas/index.js',
    'engine/canvas/useCanvasInteractions.js': 'canvas/useCanvasInteractions.js',
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
    'engine/vizKit.jsx': 'viz/parts.jsx',
    'engine/colorRules.js': 'viz/colorRules.js',
    'engine/scale.js': 'viz/scale.js',
    'engine/timeBrush.js': 'viz/timeBrush.js',
    'engine/panelFields.jsx': 'viz/panelFields.jsx',
    'engine/design/index.jsx': 'design/index.jsx',
    'engine/design/motion.js': 'design/motion.js',
    'engine/design/theme/index.js': 'design/theme/index.js',
    'engine/design/surface/index.js': 'design/surface/index.js',
    'engine/design/brushFilter.jsx': 'design/brush/filter.jsx',
    'engine/material/brush/index.jsx': 'design/brush/index.jsx',
    'engine/material/brush/brushes.js': 'design/brush/brushes.js',
    'engine/material/brush/types.js': 'design/brush/types.js',
    'engine/material/quality.js': 'design/quality.js',
    'engine/material/MaterialSurface.jsx': 'design/surface/MaterialSurface.jsx',
    'engine/material/index.js': 'design/material.js',
    'engine/handDrawn.js': 'design/handDrawn.js',
    'engine/data/index.js': 'data/index.js',
    'engine/data/dataSources.js': 'data/dataSources.js',
    'engine/data/dos.js': 'data/dos.js',
    'engine/data/inputChoices.js': 'data/inputChoices.js',
    'engine/data/useSplunkSearch.js': 'data/useSplunkSearch.js',
    'engine/spl.js': 'data/spl.js',
    'engine/ui.jsx': 'shared/ui.jsx',
    'engine/tokens.jsx': 'shared/tokens.jsx',
    'engine/TimeRangePicker.jsx': 'shared/TimeRangePicker.jsx',
    'engine/DateInput.jsx': 'shared/DateInput.jsx',
    'engine/SplunkHomeLink.jsx': 'shared/SplunkHomeLink.jsx',
    'vizBus.jsx': 'shared/vizBus.jsx',
    'extensionAdapter.jsx': 'viz/extensionAdapter.jsx',
    'viewStore.js': 'data/viewStore.js',
};

/**
 * ⚠ `engine/themes.js` は**削除した**（実体が theme と surface の 2 つに割れたため）。
 *   これを指していた import は Design Engine の barrel（`design/index.jsx`）へ寄せる。
 */
const DELETED_TO = { 'engine/themes': 'design/index.jsx' };

// 新パス → 旧パス（逆引き）
const NEW_TO_OLD = Object.fromEntries(Object.entries(MOVES).map(([o, n]) => [n, o]));
// 旧パス（拡張子なし）→ 新パス
const OLD_KEY_TO_NEW = {};
for (const [o, n] of Object.entries(MOVES)) {
    OLD_KEY_TO_NEW[o.replace(/\.(jsx?|mjs)$/, '')] = n;
}

function filesUnder(dir) {
    const out = [];
    const walk = (d) => {
        for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(jsx?|mjs)$/.test(n)) out.push(p);
        }
    };
    walk(dir);
    return out;
}

/** 旧ターゲット（拡張子なし・ディレクトリ可）→ 新パス。 */
function resolveOldTarget(oldKey) {
    if (OLD_KEY_TO_NEW[oldKey]) return OLD_KEY_TO_NEW[oldKey];
    if (OLD_KEY_TO_NEW[`${oldKey}/index`]) return OLD_KEY_TO_NEW[`${oldKey}/index`];
    if (DELETED_TO[oldKey]) return DELETED_TO[oldKey];
    return null;
}

let changed = 0;
const unresolved = [];

for (const file of filesUnder(ROOT)) {
    const relNew = relative(ROOT, file).replace(/\\/g, '/');
    // このファイルの「旧パス」（動いていないなら今と同じ）
    const relOld = NEW_TO_OLD[relNew] ?? relNew;
    const oldDir = dirname(relOld);
    const newDir = dirname(relNew);
    const src = readFileSync(file, 'utf8');

    const out = src.replace(/(from\s+|import\s*\()(['"])(\.[^'"]*)\2/g, (all, kw, q, spec) => {
        // 旧位置から見た解決（これが本来の意図）
        const oldTargetKey = join(oldDir, spec).replace(/\\/g, '/').replace(/\.(jsx?|mjs)$/, '');
        const newTarget = resolveOldTarget(oldTargetKey);
        if (!newTarget) {
            // 移動表に無い＝そのファイルは動いていない。今の位置で解決できるか確認
            const abs = resolve(ROOT, newDir, spec);
            const ok = ['', '.js', '.jsx', '/index.js', '/index.jsx'].some((e) => existsSync(abs + e));
            if (!ok) unresolved.push(`${relNew}: ${spec}`);
            return all;
        }
        // ⚠ 拡張子つきで書かれていたら維持する（Node ESM のテストが読む経路）
        const keepExt = /\.(jsx?|mjs)$/.test(spec);
        let target = keepExt ? newTarget : newTarget.replace(/\.(jsx?|mjs)$/, '');
        // index を指していたならディレクトリ指定に戻す（webpack 用。ただし拡張子つきは維持）
        if (!keepExt && /\/index$/.test(target)) target = target.replace(/\/index$/, '');
        let rel = relative(newDir, target).replace(/\\/g, '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return `${kw}${q}${rel}${q}`;
    });

    if (out !== src) {
        changed += 1;
        if (APPLY) writeFileSync(file, out);
    }
}

if (unresolved.length) {
    console.error('解決できなかった import:');
    unresolved.forEach((u) => console.error(`  ${u}`));
}
console.log(`${APPLY ? '書き換え' : '書き換え予定'}: ${changed} ファイル`);
if (!APPLY) console.log('（--apply で実行）');
