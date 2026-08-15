// タブの生存管理（tabLifecycle.js）のテスト。
// 実行: node test/tabLifecycle.test.mjs
//
// ⚠ ここで押さえたい事故:
//   1. **表示中のタブが落ちる** … 画面が真っ白になる（最悪）
//   2. **全タブを最初から生かす** … 初回表示で全タブぶんのサーチが走り、
//      「開いてもいない画面のために初回が重い」＝改善の意図が逆転する
//   3. **上限が無い** … タブが多いボードで DOM とサーチが積み上がる
//   4. **消したタブが残る** … 隠れた DOM でサーチが回り続ける
//   5. **描画順が LRU 順になる** … 切替のたびに DOM の並びが変わる
import {
    MAX_ALIVE_TABS,
    pruneTabs,
    tabsToRender,
    touchTab,
} from '../src/main/webapp/components/renderer/tabLifecycle.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（実際: ${JSON.stringify(a)}）`);

// ── touchTab：開いたタブを覚える ─────────────────────────────
{
    eq(touchTab([], 'a'), ['a'], '最初のタブが生存リストに入る');
    eq(touchTab(['a'], 'b'), ['b', 'a'], '新しいタブは先頭（最近使った順）');
    eq(touchTab(['b', 'a'], 'a'), ['a', 'b'], '既存タブを再訪すると先頭へ上がる（LRU 更新）');
    eq(touchTab(['a'], 'a'), ['a'], '同じタブを開いても重複しない');
    eq(touchTab(['a', 'b'], null), ['a', 'b'], 'タブ無し（単一画面）なら現状維持');
}

// ── 上限（LRU で打ち切る）───────────────────────────────────
{
    const many = ['t1', 't2', 't3'];
    eq(touchTab(many, 't4', 3), ['t4', 't1', 't2'], '上限を超えたら一番古いタブを落とす');
    ok(touchTab(['a', 'b', 'c'], 'd', 3).includes('d'), '上限に達しても表示中のタブは必ず入る');
    // ⚠ 0 や負を渡されても表示中のタブだけは残す（画面が消えないこと）
    eq(touchTab(['a', 'b'], 'c', 0), ['c'], '上限 0 でも表示中のタブは残る（画面が消えない）');
    ok(MAX_ALIVE_TABS >= 4 && MAX_ALIVE_TABS <= 16, `上限が実用的な範囲（${MAX_ALIVE_TABS}）`);

    // 実運用の想定：5 タブを順に開いて全部生きる
    let alive = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) alive = touchTab(alive, id);
    ok(alive.length === 5, '一般的なボード（5 タブ）は全部生き残る');
}

// ── pruneTabs：消えたタブを捨てる ───────────────────────────
{
    eq(pruneTabs(['a', 'b', 'c'], ['a', 'c']), ['a', 'c'], '定義から消えたタブは生存リストから外れる');
    eq(pruneTabs(['a', 'b'], []), [], '全タブが消えたら空になる');
    eq(pruneTabs([], ['a']), [], '生存リストが空なら空のまま');
    eq(pruneTabs(['a', 'b'], ['b', 'a']), ['a', 'b'], '存在すれば LRU の順序は保たれる');
}

// ── tabsToRender：実際に描くタブ ────────────────────────────
{
    const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    eq(tabsToRender(tabs, [], 'b').map((t) => t.id), ['b'],
        '⭐ 生存リストが空でも表示中のタブは描く（初回の1フレームで空にしない）');
    eq(tabsToRender(tabs, ['a'], 'b').map((t) => t.id), ['a', 'b'],
        '生きているタブ＋表示中のタブを描く');
    eq(tabsToRender(tabs, ['c', 'b', 'a'], 'a').map((t) => t.id), ['a', 'b', 'c'],
        '⭐ 並びは LRU 順ではなく定義の順（DOM の順序が切替で変わらない）');
    eq(tabsToRender([], ['a'], 'a'), [], 'タブが無い定義では空');
    eq(tabsToRender(tabs, ['a', 'b', 'c'], null).map((t) => t.id), ['a', 'b', 'c'],
        '表示中が未定でも生きているタブは描く');
    // 定義に無い ID が生存リストに残っていても描かない（prune 漏れの保険）
    eq(tabsToRender(tabs, ['zzz'], 'a').map((t) => t.id), ['a'],
        '定義に無いタブ ID は描かない');
}

// ── 通しシナリオ（実機の操作を再現）─────────────────────────
{
    const tabs = [{ id: 'tab1' }, { id: 'tab2' }, { id: 'tab3' }];
    let alive = [];
    // 初回表示：tab1
    alive = touchTab(alive, 'tab1');
    eq(tabsToRender(tabs, alive, 'tab1').map((t) => t.id), ['tab1'],
        '初回は tab1 だけ（tab2/tab3 のサーチは走らない）');
    // tab2 へ
    alive = touchTab(alive, 'tab2');
    eq(tabsToRender(tabs, alive, 'tab2').map((t) => t.id), ['tab1', 'tab2'],
        'tab2 を開くと tab1 は残したまま 2 枚になる');
    // tab1 へ戻る（ここが速くなる）
    alive = touchTab(alive, 'tab1');
    eq(tabsToRender(tabs, alive, 'tab1').map((t) => t.id), ['tab1', 'tab2'],
        '戻っても作り直さない（両方 DOM に在る）');
    // 編集で tab2 を削除
    alive = pruneTabs(alive, ['tab1', 'tab3']);
    eq(tabsToRender(tabs, alive, 'tab1').map((t) => t.id), ['tab1'],
        'タブを削除すると隠れた DOM も消える（サーチが回り続けない）');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
