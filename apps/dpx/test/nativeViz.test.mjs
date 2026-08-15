// ── ネイティブ viz の純粋関数テスト ─────────────────────────────
//
// **描画は目視（スクリーンショット）で見るが、計算は数値で固定する。**
// 特に「0 除算」「全部同じ値」「範囲外」は実データで普通に起きるのに
// 目視では気づきにくい（境界のセルが 1 つ欠けても分からない）。
//
// 実行: node test/nativeViz.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    buildBins,
    buildMatrix,
    heatRatio,
    sturgesBins,
} from '../src/main/webapp/components/viz/aggregate.js';
import { EMPTY_VIZ_DATA } from '../src/main/webapp/components/viz/data.js';
import { applyFieldValues, optionalExcept } from '../src/main/webapp/components/viz/interpolate.js';
import {
    NODE_SEP,
    buildFlowGraph,
    colorIndexByName,
    forceLayout,
    lossByStage,
    parseFlowNum,
    reaches,
} from '../src/main/webapp/components/viz/graph.js';

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

// ── ヒストグラム ───────────────────────────────────────────────

test('階級数は件数に応じて増える（固定値にしない）', () => {
    assert.ok(sturgesBins(1000) > sturgesBins(10));
});

test('⚠ 件数 0・不正でも 1 以上を返す（0 だと階級が作れない）', () => {
    assert.equal(sturgesBins(0), 1);
    assert.equal(sturgesBins(-5), 1);
    assert.equal(sturgesBins(NaN), 1);
});

test('階級数に上限がある（櫛状になるのを防ぐ）', () => {
    assert.ok(sturgesBins(10 ** 9) <= 50);
});

test('⭐ 最大値が最後の階級に入る（範囲外を指して落ちない）', () => {
    const bins = buildBins([0, 5, 10], 2);
    assert.equal(bins.length, 2);
    // 合計が件数と一致＝取りこぼしゼロ
    assert.equal(bins.reduce((s, b) => s + b.count, 0), 3);
});

test('⚠ 全部同じ値でも落ちない（幅 0 での除算）', () => {
    const bins = buildBins([7, 7, 7], 5);
    assert.equal(bins.length, 1);
    assert.equal(bins[0].count, 3);
});

test('数値でない値は数えない', () => {
    const bins = buildBins([1, NaN, 3, undefined, 5], 2);
    assert.equal(bins.reduce((s, b) => s + b.count, 0), 3);
});

test('空データは空配列（呼び出し側が early return できる）', () => {
    assert.deepEqual(buildBins([], 4), []);
    assert.deepEqual(buildBins([1, 2], 0), []);
});

// ── ヒートマップ ───────────────────────────────────────────────

test('⭐ ラベルの出現順を保つ（SPL の sort を壊さない）', () => {
    const m = buildMatrix(['金', '月', '水'], ['a', 'a', 'a'], [1, 2, 3]);
    assert.deepEqual(m.rows, ['金', '月', '水']); // アルファベット順にしない
});

test('行 × 列で値が引ける', () => {
    const m = buildMatrix(['r1', 'r1', 'r2'], ['c1', 'c2', 'c1'], [10, 20, 30]);
    assert.equal(m.rows.length, 2);
    assert.equal(m.cols.length, 2);
    assert.equal(m.min, 10);
    assert.equal(m.max, 30);
});

test('⚠ 欠測（r2×c2）はキーが無い＝ゼロと区別できる', () => {
    const m = buildMatrix(['r1', 'r1', 'r2'], ['c1', 'c2', 'c1'], [10, 20, 30]);
    assert.equal(m.map.size, 3); // 4 セル中 3 つだけ
});

test('⚠ ラベルに空白が入っても混ざらない（区切りの衝突）', () => {
    // 「"a b" × "c"」と「"a" × "b c"」が同じキーにならないこと
    const m = buildMatrix(['a b', 'a'], ['c', 'b c'], [1, 2]);
    assert.equal(m.map.size, 2);
    assert.notEqual(m.min, m.max);
});

test('数値でない値は入れない', () => {
    const m = buildMatrix(['r1', 'r2'], ['c1', 'c1'], ['x', 5]);
    assert.equal(m.map.size, 1);
});

test('⚠ 値が全部非数値でも min/max が壊れない（Infinity を残さない）', () => {
    const m = buildMatrix(['r1'], ['c1'], ['x']);
    assert.equal(m.min, 0);
    assert.equal(m.max, 0);
});

test('⚠ 全セル同値なら濃さは最大（0 除算にしない）', () => {
    assert.equal(heatRatio(5, 5, 5), 1);
});

test('濃さは 0〜1 に収まる', () => {
    assert.equal(heatRatio(0, 0, 10), 0);
    assert.equal(heatRatio(10, 0, 10), 1);
    assert.equal(heatRatio(5, 0, 10), 0.5);
    // 範囲外が来ても飛び出さない
    assert.equal(heatRatio(-5, 0, 10), 0);
    assert.equal(heatRatio(50, 0, 10), 1);
});

test('数値でなければ 0（描かない側に倒す）', () => {
    assert.equal(heatRatio(NaN, 0, 10), 0);
    assert.equal(heatRatio(undefined, 0, 10), 0);
});

// ── 空データの形（⚠ 実機で落ちた）─────────────────────────────
//
// viz は**フックのルール**により early return より前に useMemo を置く。
// つまり**空データでも列アクセスが走るのが正常**。空のときだけ
// メソッドが無いと `column is not a function` で落ちる（2026-08-15 実機）。

test('⭐ 空データでも column() が呼べる（early return 前に走るため）', () => {
    assert.equal(typeof EMPTY_VIZ_DATA.column, 'function');
    assert.deepEqual(EMPTY_VIZ_DATA.column(0), []);
    assert.deepEqual(EMPTY_VIZ_DATA.column(99), []);
});

test('空データの columnByName / rows も落ちない', () => {
    assert.equal(EMPTY_VIZ_DATA.columnByName('x'), null);
    assert.deepEqual(EMPTY_VIZ_DATA.rows(), []);
});

// ── 本文への差し込み（⚠ 実機で不具合が出た箇所）───────────────
//
// **`$...$` はトークンと列名の 2 種類が同じ構文を共有している。**
// トークン展開を先にやるので、そこで列名まで消すと**列の差し込みが常に空**になる。
// 画面上はただ空になるだけでエラーも出ないため、**目視では発見できない**。
// （2026-08-15 実機で発生。`has: () => true` が原因）

/**
 * `shared/tokens.jsx` の `applyTokens` と**同じ規約**の縮小版。
 *
 * ⚠ 本体は .jsx なので素の Node から import できない。ここで確かめたいのは
 *   「`optionalExcept` が渡す判定器が正しく働くか」なので、
 *   **`optional?.has?.()` の呼び方だけを忠実に写す**。
 */
const applyTokensLike = (text, tokens, optional) =>
    text.replace(/\$([A-Za-z0-9_.]+)\$/g, (whole, name) => {
        const v = tokens?.[name];
        if (v === undefined || v === null || v === '') {
            return optional?.has?.(name) ? '' : whole;
        }
        return String(v);
    });

test('⭐ 列名はトークン展開で消えない（消えると差し込みが常に空になる）', () => {
    const optional = optionalExcept(['host', 'count'], {});
    // トークンとしては未設定だが、列名なので**残らなければならない**
    assert.equal(applyTokensLike('h=$host$', {}, optional), 'h=$host$');
});

test('宣言済みで空のトークンは空文字に落ちる（未選択＝絞り込みなし）', () => {
    const optional = optionalExcept(['host'], { svc: '' });
    assert.equal(applyTokensLike('x=$svc$', { svc: '' }, optional), 'x=');
});

test('⭐ 知らない名前は $...$ のまま残す（綴り間違いを画面で見せる）', () => {
    // 列でもトークンでもない ＝ ただの書き間違い。消すと直せない
    const optional = optionalExcept(['host'], { svc: '' });
    assert.equal(applyTokensLike('x=$typo$', { svc: '' }, optional), 'x=$typo$');
});

test('トークンが設定されていれば列名より先に効く', () => {
    const optional = optionalExcept(['host'], { host: 'from-token' });
    assert.equal(applyTokensLike('h=$host$', { host: 'from-token' }, optional), 'h=from-token');
});

test('列名リストが空でも落ちない', () => {
    assert.equal(typeof optionalExcept(undefined, undefined).has, 'function');
    // 何も分からないなら「残す」側に倒す（消すと気づけないため）
    assert.equal(optionalExcept(undefined, undefined).has('a'), false);
});

test('⭐ 2 段構えで列の値が入る（トークン → 列名）', () => {
    const fields = ['host', 'count'];
    const step1 = applyTokensLike('$host$ は $count$ 件', {}, optionalExcept(fields, {}));
    assert.equal(applyFieldValues(step1, fields, ['srv-01', 1234]), 'srv-01 は 1234 件');
});

test('⭐ 知らない列名は $...$ のまま残す（綴り間違いに気づけるように）', () => {
    assert.equal(applyFieldValues('$nosuch$', ['host'], ['srv-01']), '$nosuch$');
});

test('値が null の列は空文字（"null" と描かない）', () => {
    assert.equal(applyFieldValues('[$host$]', ['host'], [null]), '[]');
});

test('日本語の列名も差し込める（Splunk では普通にある）', () => {
    assert.equal(applyFieldValues('$ホスト$', ['ホスト'], ['srv-01']), 'srv-01');
});

// ── グラフ（サンキー / 関係図）─────────────────────────────────
//
// **絵を見ても正しさが分からない領域。** リンクが 1 本多重計上されても、
// 段が 1 つ消えても、絵は「それらしく」見えてしまう。数値で固定する。

test('⚠ 区切り文字に生の NUL を使っていない（ファイルがバイナリ化する）', () => {
    assert.equal(NODE_SEP.includes('\x00'), false);
});

test('3列は src,dst,value として読む', () => {
    const g = buildFlowGraph([['a', 'b', 5]]);
    assert.equal(g.staged, false);
    assert.equal(g.links.length, 1);
    assert.equal(g.links[0].value, 5);
});

test('⭐ 4列以上は多段フローとして全段を保持する（標準は3列目以降を捨てる）', () => {
    const g = buildFlowGraph([['a', 'b', 'c', 10]]);
    assert.equal(g.staged, true);
    // a→b と b→c の 2 本。捨てていれば 1 本になる
    assert.equal(g.links.length, 2);
    assert.deepEqual(
        g.links.map((l) => l.value),
        [10, 10]
    );
});

test('⭐ 同名でも段が違えば別ノード（往復を循環にしない）', () => {
    const g = buildFlowGraph([['x', 'y', 'x', 3]]);
    // 段0のx と 段2のx は別。ノードは 3 つになる
    assert.equal(g.nodes.length, 3);
    assert.equal(g.links.length, 2);
});

test('同じ経路の行は足し合わせる（多重に描かない）', () => {
    const g = buildFlowGraph([
        ['a', 'b', 2],
        ['a', 'b', 3],
    ]);
    assert.equal(g.links.length, 1);
    assert.equal(g.links[0].value, 5);
});

test('⚠ 値が 0・負・非数の行は落とす（幅0のリボンは描けない）', () => {
    const g = buildFlowGraph([
        ['a', 'b', 0],
        ['a', 'b', -1],
        ['a', 'b', 'xx'],
        ['a', 'b', 4],
    ]);
    assert.equal(g.links[0].value, 4);
    assert.equal(g.droppedInvalid, 3);
});

test('カンマ区切りの数値を読める（Splunk の表示形式）', () => {
    assert.equal(parseFlowNum('1,234'), 1234);
    assert.equal(Number.isNaN(parseFlowNum('abc')), true);
});

test('出発点しか無い行は落とす（リンクが引けない）', () => {
    const g = buildFlowGraph([
        ['a', '', 5],
        ['a', 'b', 5],
    ]);
    assert.equal(g.nodes.length, 2);
    assert.equal(g.droppedInvalid, 1);
});

test('⭐⭐ 途中で終わる経路は打ち切って残す（離脱ぶんを消さない）', () => {
    // 3段目が空 ＝ そこで離脱した。行ごと捨てると 180 が消えてしまう
    const g = buildFlowGraph([
        ['in', 'waf', 'app', 'db', 520],
        ['in', 'waf', 'timeout', '', 180],
    ]);
    assert.equal(g.droppedInvalid, 0); // ← 捨てていない
    const total = g.links.filter((l) => l.source.startsWith('0')).reduce((a, l) => a + l.value, 0);
    assert.equal(total, 700); // 520 + 180 が入口に残っている
    // timeout は段2で終わり、段3へのリンクを持たない
    assert.equal(g.links.some((l) => l.source.includes('timeout')), false);
});

test('⭐ 打ち切った経路が「段ごとの損失」として現れる', () => {
    // 段1(waf) に 700 入り、段2 へ 700 出る。段2 は 520 だけが段3 へ
    const g = buildFlowGraph([
        ['in', 'waf', 'app', 'db', 520],
        ['in', 'waf', 'timeout', '', 180],
    ]);
    // 段2 のノードのうち timeout は出口が無い ＝ 180 が離脱
    const stage2Out = g.links.filter((l) => l.source.startsWith('2')).reduce((a, l) => a + l.value, 0);
    const stage2In = g.links.filter((l) => l.target.startsWith('2')).reduce((a, l) => a + l.value, 0);
    assert.equal(stage2In - stage2Out, 180);
});

test('自己ループは落とす（描けない）', () => {
    const g = buildFlowGraph([['a', 'a', 5]]);
    assert.equal(g.error, 'nolinks');
});

test('列が2つ以下ならエラー（推測で補わない）', () => {
    assert.equal(buildFlowGraph([['a', 'b']]).error, 'columns');
    assert.equal(buildFlowGraph([]).error, 'columns');
});

test('⭐ 循環は検出して除去する（無限ループにしない）', () => {
    const g = buildFlowGraph([
        ['a', 'b', 1],
        ['b', 'c', 1],
        ['c', 'a', 1], // ← 循環
    ]);
    assert.equal(g.droppedCyclic, 1);
    assert.equal(g.links.length, 2);
});

test('reaches は循環グラフでも停止する（seen が効いている）', () => {
    const adj = new Map([
        ['a', ['b']],
        ['b', ['a']], // 相互参照
    ]);
    assert.equal(reaches(adj, 'a', 'z'), false); // 例外も無限ループも起こさない
});

test('⭐ topN は捨てずに「その他」へ畳む（合計が保たれる）', () => {
    const rows = [
        ['s', 'a', 100],
        ['s', 'b', 50],
        ['s', 'c', 5],
        ['s', 'd', 3],
    ];
    const all = buildFlowGraph(rows);
    const cut = buildFlowGraph(rows, { topN: 2 });
    const sum = (g) => g.links.reduce((a, l) => a + l.value, 0);
    assert.equal(sum(all), 158);
    assert.equal(sum(cut), 158); // ← 切り捨てなら 150 になる
    assert.equal(cut.links.length, 3); // a, b, その他
});

test('段をまたいで同名なら同じ色になる（流れを目で追えるように）', () => {
    const g = buildFlowGraph([['web', 'db', 'web', 1]]);
    const idx = colorIndexByName(g.nodes);
    // "web" は段0と段2にあるが、色の索引は1つ
    assert.equal(idx.get('web'), idx.get('web'));
    assert.equal(new Set(idx.values()).size, 2); // web と db の 2 色
});

test('⭐ 段ごとの損失を計算する（最終段は損失に数えない）', () => {
    // 段0: 100 入って 80 出る（20 が離脱）／段1 は最終段
    const nodes = [
        { depth: 0, value: 100, sourceLinks: [{ value: 80 }] },
        { depth: 1, value: 80, sourceLinks: [] },
    ];
    const loss = lossByStage(nodes);
    assert.equal(loss.length, 1); // 最終段は含まれない
    assert.equal(loss[0].loss, 20);
});

// ── 力学配置 ──────────────────────────────────────────────────

test('⭐ 同じデータなら毎回同じ配置（乱数を使っていない）', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const links = [{ source: 'a', target: 'b', value: 1 }];
    const p1 = forceLayout(nodes, links, 60);
    const p2 = forceLayout(nodes, links, 60);
    assert.equal(p1.get('a').x, p2.get('a').x);
    assert.equal(p1.get('c').y, p2.get('c').y);
});

test('⭐ 座標は必ず 0〜1 に収まる（画面外へ出さない）', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const links = nodes.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id, value: 1 }));
    for (const p of forceLayout(nodes, links, 120).values()) {
        assert.ok(p.x >= 0 && p.x <= 1, `x が範囲外: ${p.x}`);
        assert.ok(p.y >= 0 && p.y <= 1, `y が範囲外: ${p.y}`);
    }
});

test('⚠ 座標が NaN にならない（NaN だと全ノードが消える）', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    for (const p of forceLayout(nodes, [], 80).values()) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
});

test('ノードが 0/1 個でも落ちない', () => {
    assert.equal(forceLayout([], [], 20).size, 0);
    const one = forceLayout([{ id: 'solo' }], [], 20);
    assert.equal(one.get('solo').x, 0.5);
});

console.log(`nativeViz: ${pass} tests passed`);
