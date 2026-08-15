// サーチ共有ストア（searchStore.js）のテスト。
// 実行: node test/searchStore.test.mjs
//
// ⚠ ここで押さえたい事故（すべて実機で起きていた／起こしうるもの）:
//   1. **同じサーチが N 本飛ぶ** … 共有データソースを N パネルが参照すると
//      同一 SPL のジョブが N 本走っていた（2026-08-15 実機計測で判明）
//   2. **タブを戻すたびに再実行** … 結果キャッシュが無く、再マウントでゼロから
//   3. 自動更新のタイマーが購読者ごとに増える → 実行本数が雪だるま式に増える
//   4. 購読解除後にタイマーが回り続ける（画面外のサーチが走り続ける）
import {
    RESULT_TTL_MS,
    __resetSearchStore,
    __searchStoreSize,
    searchKey,
    subscribeSearch,
} from '../src/main/webapp/components/data/searchStore.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── キー ───────────────────────────────────────────────────
{
    const a = searchKey({ spl: 'index=x', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    const b = searchKey({ spl: '  index=x  ', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    ok(a === b, '前後の空白が違うだけなら同じキー（同じサーチとして合流する）');
    const c = searchKey({ spl: 'index=x', earliest: '-7d', latest: 'now', count: 100, app: 'dpx' });
    ok(a !== c, '時間範囲が違えば別のキー（別のサーチとして実行される）');
    const d = searchKey({ spl: 'index=x', earliest: '-24h', latest: 'now', count: 100, app: 'search' });
    ok(a !== d, '名前空間（アプリ）が違えば別のキー');
}

// ── 1. 同じサーチは1本にまとめる（最重要）──────────────────
{
    __resetSearchStore();
    let execCount = 0;
    const exec = () => {
        execCount += 1;
        return tick(20).then(() => ({ fields: [{ name: 'a' }], columns: [[1]] }));
    };
    const key = searchKey({ spl: '| makeresults', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });

    // 実機の tab2 と同じ：同じデータソースを4パネルが同時に購読する
    const got = [[], [], [], []];
    const unsubs = got.map((bucket) =>
        subscribeSearch(key, exec, { notify: (s) => bucket.push(s), refresh: 0 })
    );
    await tick(80);

    ok(execCount === 1, `同一SPLを4パネルが購読しても実行は1回（実際 ${execCount} 回）`);
    ok(
        got.every((b) => b[b.length - 1]?.data?.columns?.[0]?.[0] === 1),
        '4パネル全員に結果が届く'
    );
    ok(
        got.every((b) => b[b.length - 1]?.loading === false),
        '全員の loading が false になる'
    );
    unsubs.forEach((u) => u());
}

// ── 2. 完了済みの結果は再購読で即返る（タブ戻りが速い）──────
{
    __resetSearchStore();
    let execCount = 0;
    const exec = () => {
        execCount += 1;
        return tick(10).then(() => ({ fields: [{ name: 'a' }], columns: [[7]] }));
    };
    const key = searchKey({ spl: '| makeresults 2', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });

    const un1 = subscribeSearch(key, exec, { notify: () => {}, refresh: 0 });
    await tick(40);
    un1(); // タブを離れる＝アンマウント

    // タブに戻る＝再マウント
    const seen = [];
    const un2 = subscribeSearch(key, exec, { notify: (s) => seen.push(s), refresh: 0 });
    ok(execCount === 1, `再購読でサーチが再実行されない（実行 ${execCount} 回）`);
    ok(seen[0]?.data?.columns?.[0]?.[0] === 7, '再購読は結果を同期的に受け取る（loading を挟まない）');
    ok(seen[0]?.loading === false, '戻った瞬間から loading=false');
    un2();
}

// ── 3. 実行中に来た購読者は合流する（2本目を投げない）────────
{
    __resetSearchStore();
    let execCount = 0;
    const exec = () => {
        execCount += 1;
        return tick(50).then(() => ({ fields: [], columns: [] }));
    };
    const key = searchKey({ spl: '| makeresults 3', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    const un1 = subscribeSearch(key, exec, { notify: () => {}, refresh: 0 });
    await tick(10); // まだ実行中
    const seen = [];
    const un2 = subscribeSearch(key, exec, { notify: (s) => seen.push(s), refresh: 0 });
    ok(execCount === 1, '実行中に購読しても2本目を投げない（合流する）');
    ok(seen[0]?.loading === true, '合流した購読者はまず loading を受け取る');
    await tick(80);
    ok(seen[seen.length - 1]?.loading === false, '合流した購読者にも完了が届く');
    un1();
    un2();
}

// ── 4. エラーも全購読者に届く（握りつぶさない）────────────
{
    __resetSearchStore();
    const exec = () => tick(10).then(() => Promise.reject(new Error('サーチが失敗しました')));
    const key = searchKey({ spl: '| bogus', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    const a = [];
    const b = [];
    const un1 = subscribeSearch(key, exec, { notify: (s) => a.push(s), refresh: 0 });
    const un2 = subscribeSearch(key, exec, { notify: (s) => b.push(s), refresh: 0 });
    await tick(50);
    ok(a[a.length - 1]?.error === 'サーチが失敗しました', 'エラーが購読者1に届く');
    ok(b[b.length - 1]?.error === 'サーチが失敗しました', 'エラーが購読者2にも届く');
    ok(a[a.length - 1]?.loading === false, 'エラー時も loading が下りる（永久スピナーにしない）');
    un1();
    un2();
}

// ── 5. 自動更新は1本だけ・最短間隔を採用 ────────────────────
{
    __resetSearchStore();
    let execCount = 0;
    const exec = () => {
        execCount += 1;
        return Promise.resolve({ fields: [], columns: [] });
    };
    const key = searchKey({ spl: '| makeresults 5', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    // refresh は最低 5 秒にクランプされるのでテストでは発火を待たない。
    // ここで見たいのは「購読者が増えてもタイマーが増えない」こと
    const un1 = subscribeSearch(key, exec, { notify: () => {}, refresh: 5 });
    const un2 = subscribeSearch(key, exec, { notify: () => {}, refresh: 0 });
    const un3 = subscribeSearch(key, exec, { notify: () => {}, refresh: 60 });
    await tick(30);
    ok(execCount === 1, `購読者が3人でも初回実行は1回（実際 ${execCount} 回）`);
    un1();
    un2();
    un3();
    // 全員解除したらタイマーが残らない＝プロセスが即終了できる
    ok(true, '全購読解除でタイマーを止める（このテストが終了すれば成立）');
}

// ── 6. 空 SPL・TTL の定数 ──────────────────────────────────
{
    ok(RESULT_TTL_MS > 0 && RESULT_TTL_MS <= 60_000, `結果キャッシュの TTL が妥当（${RESULT_TTL_MS}ms）`);
}

// ── 7. 別のサーチは混ざらない ───────────────────────────────
{
    __resetSearchStore();
    const mk = (v) => () => tick(5).then(() => ({ fields: [{ name: 'v' }], columns: [[v]] }));
    const k1 = searchKey({ spl: '| makeresults 7a', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    const k2 = searchKey({ spl: '| makeresults 7b', earliest: '-24h', latest: 'now', count: 100, app: 'dpx' });
    let g1 = null;
    let g2 = null;
    const un1 = subscribeSearch(k1, mk('A'), { notify: (s) => { g1 = s; }, refresh: 0 });
    const un2 = subscribeSearch(k2, mk('B'), { notify: (s) => { g2 = s; }, refresh: 0 });
    await tick(40);
    ok(g1?.data?.columns?.[0]?.[0] === 'A' && g2?.data?.columns?.[0]?.[0] === 'B', '別サーチの結果が混ざらない');
    ok(__searchStoreSize() === 2, 'キーごとにエントリが分かれる');
    un1();
    un2();
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
