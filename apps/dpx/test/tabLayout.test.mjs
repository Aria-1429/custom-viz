// タブ 1 枚ぶんのレイアウト解決（tabLayout.js）のテスト。
// 実行: node test/tabLayout.test.mjs
//
// ⚠ ここで押さえたい事故（どれも実機で起きた／起こしうる見た目の崩れ）:
//   1. **タブ未指定のパネルが消える** … タブを後から足した既存ボードで起きる
//   2. **他タブの区画が残る** … 切り替えても前のタブの枠が描かれる
//   3. **区画の罫がダッシュボードの見出しに重なる** … 最上段の区画で余白を空け忘れる
//   4. **見出し行の挿し込みで行番号がずれる** … 罫とパネルの位置が食い違う
//   5. **定義（panel.y）を書き換える** … 保存されて次回さらにずれる（二重適用）
import {
    GROUP_HEADER_H,
    panelsOfTab,
    resolveTabLayout,
} from '../src/main/webapp/components/renderer/tabLayout.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const TABS = [{ id: 't1' }, { id: 't2' }];
const mk = (id, tab, y = 0, h = 2) => ({ id, tab, x: 0, y, w: 6, h });

// ── panelsOfTab ─────────────────────────────────────────────
{
    const panels = [mk('a', 't1'), mk('b', 't2'), { id: 'c', x: 0, y: 0, w: 6, h: 2 }];
    ok(
        panelsOfTab(panels, TABS, 't1').map((p) => p.id).join(',') === 'a,c',
        '⭐ タブ未指定のパネルは先頭タブに属する（既存ボードで消えない）'
    );
    ok(panelsOfTab(panels, TABS, 't2').map((p) => p.id).join(',') === 'b', '指定タブのパネルだけ返す');
    ok(panelsOfTab(panels, null, null).length === 3, 'タブが無い定義では全パネルを返す');
    ok(panelsOfTab(panels, [], null).length === 3, 'タブが空配列でも全パネル');
    ok(panelsOfTab(null, TABS, 't1').length === 0, 'パネルが null でも落ちない');
}

// ── 区画のタブ絞り込み ──────────────────────────────────────
{
    const allPanels = [mk('a', 't1'), mk('b', 't2')];
    const definition = {
        groups: [
            { id: 'g1', label: '区画1', panels: ['a'] },
            { id: 'g2', label: '区画2', panels: ['b'] },
        ],
    };
    const r = resolveTabLayout({
        definition,
        allPanels,
        tabPanels: panelsOfTab(allPanels, TABS, 't1'),
        tabs: TABS,
        tabId: 't1',
        rowHeight: 72,
    });
    ok(r.groups.length === 1 && r.groups[0].id === 'g1', '⭐ そのタブの区画だけ（他タブの枠が残らない）');
}

// ── 最上段の区画は上部に余白を要求する ──────────────────────
{
    const allPanels = [mk('a', 't1', 0)];
    const definition = { groups: [{ id: 'g1', label: '認証系', panels: ['a'] }] };
    const r = resolveTabLayout({
        definition, allPanels, tabPanels: allPanels, tabs: TABS, tabId: 't1', rowHeight: 72,
    });
    ok(r.labeled === true, '⭐ 最上段(y=0)の区画があれば余白を要求する（見出しに罫が重ならない）');

    // 下段だけの区画では余白を空けない（既存ボードが間延びしないこと）
    const lower = [mk('a', 't1', 3)];
    const r2 = resolveTabLayout({
        definition, allPanels: lower, tabPanels: lower, tabs: TABS, tabId: 't1', rowHeight: 72,
    });
    ok(r2.labeled === false, '下段だけの区画では上部の余白を空けない（間延びさせない）');
}

// ── ラベルの有無で判定しない ────────────────────────────────
{
    const allPanels = [mk('a', 't1', 0)];
    // 名前が無い区画でもヘッダ帯のぶん上へ伸びる
    const definition = { groups: [{ id: 'g1', label: '', panels: ['a'] }] };
    const r = resolveTabLayout({
        definition, allPanels, tabPanels: allPanels, tabs: TABS, tabId: 't1', rowHeight: 72,
    });
    ok(r.labeled === true, '⭐ 名前が無い区画でも最上段なら余白を空ける（ラベルで判定しない）');
}

// ── 見出し行の挿し込みと行番号 ──────────────────────────────
{
    // 下段(y=2)に区画がある → その手前に見出し行が挿し込まれる
    const allPanels = [mk('top', 't1', 0), mk('inner', 't1', 2)];
    const definition = { groups: [{ id: 'g1', label: '下の区画', panels: ['inner'] }] };
    const r = resolveTabLayout({
        definition, allPanels, tabPanels: allPanels, tabs: TABS, tabId: 't1', rowHeight: 72,
    });
    ok(r.headerRows.has(2), '区画が始まる行(y=2)の手前に見出し行を確保する');
    ok(typeof r.rowOf === 'function', 'rowOf（描画時の行番号）が返る');
    // 見出し行より下のパネルは 1 行ぶん後ろへずれる
    ok(r.rowOf(0) < r.rowOf(2), '見出し行より下のパネルは後ろの行になる');
    ok(typeof r.rowTemplate === 'string' && r.rowTemplate.includes(`${GROUP_HEADER_H}px`),
        '行テンプレートに見出し行の高さが入る');
    ok(r.rowTemplate.includes('72px'), '通常行は rowHeight で組まれる');

    // ⚠ 定義を書き換えていないこと（二重適用の防止）
    ok(allPanels[1].y === 2, '⭐ 定義（panel.y）を書き換えない（保存されて二重にずれない）');
}

// ── 区画が無いときは行を明示しない ──────────────────────────
{
    const allPanels = [mk('a', 't1', 0)];
    const r = resolveTabLayout({
        definition: {}, allPanels, tabPanels: allPanels, tabs: TABS, tabId: 't1', rowHeight: 72,
    });
    ok(r.headerRows.size === 0, '区画が無ければ見出し行は挿し込まない');
    ok(r.rowTemplate === undefined,
        '⭐ 挿し込みが無いときは行テンプレートを出さない（gridAutoRows に任せる）');
    ok(r.groups.length === 0 && r.labeled === false, '区画ゼロでも落ちない');
}

// ── 空・異常入力でも落ちない ────────────────────────────────
{
    const r = resolveTabLayout({
        definition: {}, allPanels: [], tabPanels: [], tabs: null, tabId: null, rowHeight: 72,
    });
    ok(r.groups.length === 0 && r.headerRows.size === 0, 'パネルゼロでも落ちない');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
