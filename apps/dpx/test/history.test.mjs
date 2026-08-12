// 編集履歴（Ctrl+Z）のテスト。
// 実行: node test/history.test.mjs
//
// ⚠ ここで押さえたい事故は3つ。どれも実装で実際に踏んだ／踏みかけたもの:
//   1. 古い定義が積まれる（クロージャの罠）→ 「1手前」ではなく「2手前」に飛ぶ
//   2. ドラッグの中間状態が積まれる → Ctrl+Z が1セルずつしか戻らない
//   3. dirty をカウンタで持つ → 「変えて元に戻した」のに保存ボタンが押せる
import {
    coalesceKeyFor,
    HISTORY_LIMIT,
    canRedo,
    canUndo,
    initHistory,
    isDirty,
    markSaved,
    pushHistory,
    redoHistory,
    stableStringify,
    undoHistory,
} from '../src/main/webapp/components/engine/history.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const D = (n) => ({ title: `t${n}`, panels: [{ id: 'p1', x: n }] });

console.log('--- 基本 ---');
{
    const h0 = initHistory(D(0));
    ok(!canUndo(h0), '初期状態では戻せない');
    ok(!canRedo(h0), '初期状態では進めない');
    ok(!isDirty(h0, D(0)), '初期状態は未保存ではない');

    const h1 = pushHistory(h0, D(0), null);
    ok(canUndo(h1), '1手積んだら戻せる');
    ok(isDirty(h1, D(1)), '編集後は未保存になる');
}

console.log('--- ⭐ 戻しきったら保存できない（ユーザー指定の中核）---');
{
    // 0 → 1 → 2 と編集して、2回戻す
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), 'a');
    h = pushHistory(h, D(1), 'b');
    ok(isDirty(h, D(2)), '2手編集した状態は未保存');

    const u1 = undoHistory(h, D(2));
    ok(stableStringify(u1.definition) === stableStringify(D(1)), '1回目の undo で 1 手前に戻る');
    ok(isDirty(u1.history, u1.definition), 'まだ元に戻りきっていないので未保存のまま');

    const u2 = undoHistory(u1.history, u1.definition);
    ok(stableStringify(u2.definition) === stableStringify(D(0)), '2回目の undo で最初に戻る');
    ok(!isDirty(u2.history, u2.definition), '⭐ 戻しきったら「未保存」が消える＝保存ボタンを押せない');
    ok(!canUndo(u2.history), '最初まで戻ったらもう戻せない');
}

console.log('--- ⚠ 中身が同じなら参照が違っても「保存済み」---');
{
    // undo は past の別オブジェクトを復元するので、参照比較だと必ず dirty になる
    const h = initHistory(D(0));
    ok(!isDirty(h, D(0)), '別インスタンスでも中身が同じなら未保存ではない');
    // キー順が違うだけの JSON（ソース編集タブで打ち直した場合）
    const reordered = { panels: [{ x: 0, id: 'p1' }], title: 't0' };
    ok(!isDirty(h, reordered), 'キーの順序が違うだけなら「変更なし」と見なす');
    // 配列の順序は意味を持つので、入れ替わったら別物
    const swapped = { title: 't0', panels: [{ id: 'p2', x: 0 }] };
    ok(isDirty(h, swapped), '配列の中身が違えば変更ありと見なす');
}

console.log('--- 「変えて元に戻した」も保存できない ---');
{
    // Ctrl+Z ではなく、手で元の値に戻した場合
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), null); // 0 -> 5 に変更
    ok(isDirty(h, D(5)), '変更した直後は未保存');
    h = pushHistory(h, D(5), null); // 5 -> 0 に戻した
    ok(!isDirty(h, D(0)), '手で元の値に戻しても「変更なし」になる（カウンタ方式なら失敗する）');
    ok(canUndo(h), 'ただし履歴としては戻せる（操作自体は起きたので）');
}

console.log('--- ⚠ ドラッグは1手にまとめる ---');
{
    // ドラッグ中に8回 onPanelLayout が飛ぶ状況
    let h = initHistory(D(0));
    for (let i = 0; i < 8; i++) h = pushHistory(h, D(i), 'move:p1');
    ok(h.past.length === 1, `ドラッグ8フレームでも履歴は1手（実際: ${h.past.length}）`);
    ok(stableStringify(h.past[0]) === stableStringify(D(0)), 'まとめた1手は「ドラッグ開始前」の姿');

    const u = undoHistory(h, D(8));
    ok(stableStringify(u.definition) === stableStringify(D(0)), 'Ctrl+Z 一発でドラッグ前に戻る');
}

console.log('--- ⚠ 別の操作が挟まったら区切る ---');
{
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), 'move:p1'); // 動かす
    h = pushHistory(h, D(1), 'color:p1'); // 色を変える（別操作）
    h = pushHistory(h, D(2), 'move:p1'); // また動かす
    ok(h.past.length === 3, `間に別操作が挟まれば別々の手になる（実際: ${h.past.length}）`);
}

console.log('--- キー無しは毎回1手 ---');
{
    let h = initHistory(D(0));
    h = pushHistory(h, D(0));
    h = pushHistory(h, D(1));
    ok(h.past.length === 2, 'キー無し（削除・追加など）は毎回積む');
}

console.log('--- redo ---');
{
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), null);
    const u = undoHistory(h, D(1));
    ok(canRedo(u.history), 'undo したら redo できる');
    const r = redoHistory(u.history, u.definition);
    ok(stableStringify(r.definition) === stableStringify(D(1)), 'redo で戻した編集が復活する');
    ok(isDirty(r.history, r.definition), 'redo したら未保存に戻る');

    // 新しい編集をしたら redo は捨てる
    const u2 = undoHistory(r.history, r.definition);
    const h2 = pushHistory(u2.history, u2.definition, null);
    ok(!canRedo(h2), 'undo 後に別の編集をしたら redo は消える（履歴は分岐しない）');
}

console.log('--- ⚠ undo 直後の同種操作は合体させない ---');
{
    // ドラッグ→Ctrl+Z→またドラッグ、で2回目が積まれないと戻せなくなる
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), 'move:p1');
    const u = undoHistory(h, D(1));
    ok(u.history.lastKey === null, 'undo でまとめキーが解除される');
    const h2 = pushHistory(u.history, u.definition, 'move:p1');
    ok(h2.past.length === 1, 'undo 後の同じ操作はちゃんと新しい1手として積まれる');
}

console.log('--- 保存 ---');
{
    let h = initHistory(D(0));
    h = pushHistory(h, D(0), null);
    ok(isDirty(h, D(1)), '保存前は未保存');
    const saved = markSaved(h, D(1));
    ok(!isDirty(saved, D(1)), '保存したら「未保存」が消える');
    ok(canUndo(saved), '保存しても履歴は残る（保存後も戻せる）');
    // 保存後に戻すと、また未保存になる
    const u = undoHistory(saved, D(1));
    ok(isDirty(u.history, u.definition), '保存後に undo したら未保存に戻る');
}

console.log('--- 上限 ---');
{
    let h = initHistory(D(0));
    for (let i = 0; i < HISTORY_LIMIT + 30; i++) h = pushHistory(h, D(i), null);
    ok(h.past.length === HISTORY_LIMIT, `履歴は ${HISTORY_LIMIT} 手で頭打ち（実際: ${h.past.length}）`);
    ok(stableStringify(h.past[h.past.length - 1]) === stableStringify(D(HISTORY_LIMIT + 29)), '最新の手は残る');
}

console.log('--- まとめキーの自動判定（インスペクタの入力）---');
{
    // 文字入力・数値はまとめる（1打鍵ごとに Ctrl+Z が要るのを防ぐ）
    ok(coalesceKeyFor('p1', { title: 'あ' }) === 'p1/title', '文字列1つの変更はまとめる');
    ok(coalesceKeyFor('p1', { w: 6 }) === 'p1/w', '数値1つの変更はまとめる');
    ok(coalesceKeyFor(null, { title: 'x' }) === 'def/title', 'スコープ省略なら def 扱い');
    // 場所が違えばキーも違う＝別の手になる
    ok(coalesceKeyFor('p1', { title: 'x' }) !== coalesceKeyFor('p2', { title: 'x' }), 'パネルが違えば別の手');
    ok(coalesceKeyFor('p1', { title: 'x' }) !== coalesceKeyFor('p1', { label: 'x' }), '項目が違えば別の手');

    // ⚠ まとめてはいけないもの
    ok(coalesceKeyFor('p1', { visible: true }) === null, '真偽値はまとめない（チェックボックスは1回ずつ戻す）');
    ok(coalesceKeyFor('p1', { x: 1, y: 2 }) === null, '複数キーの同時変更はまとめない');
    ok(coalesceKeyFor('p1', { style: { a: 1 } }) === null, 'オブジェクトを含む変更はまとめない');
    ok(coalesceKeyFor('p1', { choices: [] }) === null, '配列を含む変更はまとめない');
    ok(coalesceKeyFor('p1', null) === null, 'patch が無ければまとめない');
    ok(coalesceKeyFor('p1', {}) === null, '空の patch はまとめない');
}

console.log('--- 文字入力が1手にまとまる（通しの再現）---');
{
    // 「タイトルを5文字打つ」→ Ctrl+Z 一発で打つ前に戻る
    let h = initHistory({ title: '' });
    const steps = ['あ', 'あい', 'あいう', 'あいうえ', 'あいうえお'];
    let prev = { title: '' };
    for (const s of steps) {
        h = pushHistory(h, prev, coalesceKeyFor('def', { title: s }));
        prev = { title: s };
    }
    ok(h.past.length === 1, `5文字打っても履歴は1手（実際: ${h.past.length}）`);
    const u = undoHistory(h, prev);
    ok(u.definition.title === '', 'Ctrl+Z 一発で打つ前に戻る');
    ok(!isDirty(u.history, u.definition), '打つ前に戻ったので保存ボタンは押せない');
}

console.log('--- 異常系 ---');
{
    ok(undoHistory(initHistory(D(0)), D(0)) === null, '戻せないとき undo は null');
    ok(redoHistory(initHistory(D(0)), D(0)) === null, '進めないとき redo は null');
    ok(!isDirty(null, D(0)), '履歴が無くても落ちない');
    ok(!isDirty(initHistory(undefined), undefined), 'undefined でも落ちない');
    ok(stableStringify(null) === 'null', 'null を直列化できる');
}

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
