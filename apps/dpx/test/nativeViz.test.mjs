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

console.log(`nativeViz: ${pass} tests passed`);
