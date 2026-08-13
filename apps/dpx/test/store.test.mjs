// ── Store（State / Command 層）のテスト ─────────────────────────
//
// 検証の主眼は**過去に実機で壊れた性質**:
//   - undo で戻しきったら保存ボタンが押せなくなる（dirty の導出）
//   - 「変えて元に戻す」でも dirty が false になる
//   - 1 レンダーに 2 回編集しても Ctrl+Z が 1 手ずつ戻る
//   - 選択の 3 種（パネル / 入力 / 区画）が排他になる
//
// ⚠ zustand は React 非依存で動くので、素の Node からストアを直接叩ける。
//   （`create` は React 外でも `getState` / `setState` が使える）
//
// 実行: node test/store.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import { useDashboardStore, selectDirty, selectCanUndo, selectCanRedo, patchPanel, patchDefinition, removePanel }
    from '../src/main/webapp/components/store/dashboardStore.js';
import { useEditorStore, SEL, selectSelectedPanelId, selectSelectedGroupId }
    from '../src/main/webapp/components/store/editorStore.js';
import { SCHEMA_VERSION } from '../src/main/webapp/components/schema/vocab.js';

let pass = 0;
const test = (name, fn) => {
    try {
        fn();
        pass += 1;
    } catch (err) {
        console.error(`✗ ${name}\n  ${err.message}`);
        process.exitCode = 1;
    }
};

const raw = () => ({
    schemaVersion: SCHEMA_VERSION,
    title: 'テスト',
    panels: [
        { id: 'p1', viz: 'dpx.line', title: 'A' },
        { id: 'p2', viz: 'dpx.bar', title: 'B' },
    ],
});

const ds = () => useDashboardStore.getState();
const fresh = () => {
    ds().load(raw());
    return ds();
};

// ── 読み込み ───────────────────────────────────────────────────

test('load で既定値が埋まった定義になる', () => {
    const r = fresh().load(raw());
    assert.ok(r.ok, r.error);
    const d = ds().definition;
    assert.equal(d.layout.grid.columns, 12);
    assert.equal(d.panels[0].w, 6);
    assert.equal(ds().phase, 'ready');
});

test('壊れた定義は phase=error になり定義を汚さない', () => {
    fresh();
    const r = ds().load({ schemaVersion: SCHEMA_VERSION, panels: [{ id: 'x' }] });
    assert.equal(r.ok, false);
    assert.equal(ds().phase, 'error');
    assert.equal(ds().definition, null);
});

test('読み込み直後は dirty ではない', () => {
    fresh();
    assert.equal(selectDirty(ds()), false);
});

// ── dirty の導出（実機で壊れた性質）─────────────────────────────

test('編集すると dirty になる', () => {
    fresh();
    patchPanel('p1', { title: '変更' });
    assert.equal(selectDirty(ds()), true);
});

test('⭐ undo で戻しきったら dirty ではなくなる', () => {
    // 「戻しきったら保存ボタンを押せなくする」の中核。
    // カウンタ方式・別 state 方式はどちらもここで壊れた。
    fresh();
    patchPanel('p1', { title: '変更' });
    ds().undo();
    assert.equal(selectDirty(ds()), false, 'undo 後も dirty のまま');
});

test('⭐ 手で元の値に戻しても dirty ではなくなる（内容比較）', () => {
    fresh();
    patchPanel('p1', { title: '変更' });
    patchPanel('p1', { title: 'A' }); // 元の値へ
    assert.equal(selectDirty(ds()), false, '内容が同じなのに dirty');
});

test('キーの順序が違うだけなら dirty にならない', () => {
    fresh();
    const d = ds().definition;
    // 同じ内容でキー順だけ違うオブジェクトを流し込む
    ds().dispatch(() => ({ ...d, panels: [...d.panels] }));
    assert.equal(selectDirty(ds()), false);
});

test('markSaved で基準が更新される', () => {
    fresh();
    patchPanel('p1', { title: '変更' });
    assert.equal(selectDirty(ds()), true);
    ds().markSaved();
    assert.equal(selectDirty(ds()), false);
});

// ── undo / redo ────────────────────────────────────────────────

test('⭐ 連続した 2 回の編集が 1 手ずつ戻る', () => {
    // 旧実装は「変更前」を外側のクロージャで掴んでいたため、
    // 1 レンダーに 2 回編集すると 2 手前へ飛んだ。
    fresh();
    patchPanel('p1', { title: 'X' }, null); // key=null で必ず独立した手
    patchPanel('p1', { title: 'Y' }, null);
    assert.equal(ds().definition.panels[0].title, 'Y');
    ds().undo();
    assert.equal(ds().definition.panels[0].title, 'X', '2 手前に飛んだ');
    ds().undo();
    assert.equal(ds().definition.panels[0].title, 'A');
});

test('redo で進める', () => {
    fresh();
    patchPanel('p1', { title: 'X' }, null);
    ds().undo();
    assert.equal(selectCanRedo(ds()), true);
    ds().redo();
    assert.equal(ds().definition.panels[0].title, 'X');
});

test('新しい編集をしたら redo は捨てられる', () => {
    fresh();
    patchPanel('p1', { title: 'X' }, null);
    ds().undo();
    patchPanel('p1', { title: 'Z' }, null);
    assert.equal(selectCanRedo(ds()), false);
});

test('戻せないときは何も起きない', () => {
    fresh();
    assert.equal(selectCanUndo(ds()), false);
    ds().undo(); // 落ちないこと
    assert.equal(ds().definition.panels[0].title, 'A');
});

test('まとめキーが同じ連続編集は 1 手になる', () => {
    fresh();
    // スライダーのような「確定点を決められない入力」を想定
    patchPanel('p1', { title: 'a' }, 'p1/title');
    patchPanel('p1', { title: 'ab' }, 'p1/title');
    patchPanel('p1', { title: 'abc' }, 'p1/title');
    ds().undo();
    assert.equal(ds().definition.panels[0].title, 'A', '1 手にまとまっていない');
});

test('内容が変わらない編集は履歴を汚さない', () => {
    fresh();
    ds().dispatch((d) => d); // 同じ参照を返す＝端に当たったドラッグ相当
    assert.equal(selectCanUndo(ds()), false);
    assert.equal(selectDirty(ds()), false);
});

// ── コマンド ───────────────────────────────────────────────────

test('patchDefinition でトップレベルを変えられる', () => {
    fresh();
    patchDefinition({ title: '新しい題' });
    assert.equal(ds().definition.title, '新しい題');
});

test('removePanel は区画のメンバー一覧からも外す', () => {
    // 外し忘れると、消えたパネルを参照する区画が残り外接矩形が狂う
    ds().load({ ...raw(), groups: [{ id: 'g1', panels: ['p1', 'p2'] }] });
    removePanel('p1');
    const d = ds().definition;
    assert.equal(d.panels.length, 1);
    assert.deepEqual(d.groups[0].panels, ['p2'], '区画にゴーストが残っている');
});

// ── Editor Store：選択の排他 ────────────────────────────────────

const es = () => useEditorStore.getState();

test('⭐ パネルと区画は同時に選択されない', () => {
    es().select(SEL.PANEL, 'p1');
    assert.equal(selectSelectedPanelId(es()), 'p1');
    es().select(SEL.GROUP, 'g1');
    assert.equal(selectSelectedGroupId(es()), 'g1');
    assert.equal(selectSelectedPanelId(es()), null, 'パネルの選択が残っている');
});

test('clearSelection で全種別が外れる', () => {
    es().select(SEL.PANEL, 'p1');
    es().clearSelection();
    assert.equal(selectSelectedPanelId(es()), null);
    assert.equal(es().selection.kind, null);
});

test('選択は常に配列で持つ（Multi Select の受け皿）', () => {
    es().select(SEL.PANEL, 'p1');
    assert.ok(Array.isArray(es().selection.ids));
    assert.deepEqual(es().selection.ids, ['p1']);
});

test('toggleSelect で複数選べる', () => {
    es().select(SEL.PANEL, 'p1');
    es().toggleSelect(SEL.PANEL, 'p2');
    assert.deepEqual(es().selection.ids, ['p1', 'p2']);
    es().toggleSelect(SEL.PANEL, 'p1');
    assert.deepEqual(es().selection.ids, ['p2']);
});

test('種別をまたぐ複数選択は作らない（選び直しになる）', () => {
    es().select(SEL.PANEL, 'p1');
    es().toggleSelect(SEL.GROUP, 'g1');
    assert.equal(es().selection.kind, SEL.GROUP);
    assert.deepEqual(es().selection.ids, ['g1']);
});

test('最後の 1 件を外すと選択なしになる', () => {
    es().select(SEL.PANEL, 'p1');
    es().toggleSelect(SEL.PANEL, 'p1');
    assert.equal(es().selection.kind, null);
});

test('表示モードへ切り替えると選択が外れる', () => {
    es().setMode('edit');
    es().select(SEL.PANEL, 'p1');
    es().setMode('view');
    assert.equal(selectSelectedPanelId(es()), null);
});

// ── Editor Store：ダイアログ ────────────────────────────────────

test('データソース管理は「開いたときに選ぶ ID」を持つ', () => {
    es().openDataSources('ds2');
    assert.equal(es().dataSourceDialog.open, true);
    assert.equal(es().dataSourceDialog.focus, 'ds2');
    es().closeDataSources();
    assert.equal(es().dataSourceDialog.focus, null);
});

// ── 分離の確認（設計上の要件）───────────────────────────────────

test('⭐ 一時状態を触っても定義は dirty にならない', () => {
    // これが Schema と Editor 状態を分けた目的そのもの
    fresh();
    es().select(SEL.PANEL, 'p1');
    es().openDataSources();
    es().setLayoutPreview({ p1: { x: 5, y: 5 } });
    es().setKiosk(true);
    assert.equal(selectDirty(ds()), false, '一時状態が定義を汚している');
});

console.log(`store: ${pass} tests passed`);
