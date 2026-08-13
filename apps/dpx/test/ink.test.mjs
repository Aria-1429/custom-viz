// ── Ink Layer のテスト ──────────────────────────────────────────
//
// **画材を「どこに」掛けるかの判定**を固定する。
//
// ⚠ ここが崩れると**文字が歪む**（2026-08-13 に実際に起きた）。
//   パネル全体に filter を掛けていたため、ラベルまで波打っていた。
//
// 実行: node test/ink.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    INK_MARK,
    INK_NONE,
    INK_ONLY,
    decideInkScope,
    isInkShape,
    brushFilterIdForSize,
    isDeclarativeOnly,
    readInkDeclaration,
    sizeTierFor,
} from '../src/main/webapp/components/design/brush/ink.js';

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

// ── ⭐ 文字を絶対に歪ませない（この層の存在理由）───────────────

test('⭐ text / tspan は印にしない（文字が歪む）', () => {
    assert.equal(isInkShape('text'), false);
    assert.equal(isInkShape('tspan'), false);
    assert.equal(isInkShape('textPath'), false);
});

test('⭐ foreignObject は印にしない（中は HTML の文字）', () => {
    assert.equal(isInkShape('foreignObject'), false);
});

test('⭐ text の中の形状も印にしない', () => {
    // 装飾のために <text> の中に <path> を置く viz がありうる。
    // 親が文字なら、子を歪ませると結局文字が歪む。
    assert.equal(isInkShape('path', true), false);
    assert.equal(isInkShape('rect', true), false);
});

test('image は印にしない（写真や地図タイルが汚れる）', () => {
    assert.equal(isInkShape('image'), false);
});

// ── 印として拾うもの ───────────────────────────────────────────

test('SVG の形状要素は印になる', () => {
    for (const tag of ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']) {
        assert.equal(isInkShape(tag), true, `${tag} が印にならない`);
    }
});

test('未知のタグは印にしない（安全側に倒す）', () => {
    assert.equal(isInkShape('div'), false);
    assert.equal(isInkShape('marker'), false);
    assert.equal(isInkShape('clipPath'), false);
});

// ── 宣言の解釈 ─────────────────────────────────────────────────

test('data-dpx-ink の宣言を読む', () => {
    assert.equal(readInkDeclaration('mark'), INK_MARK);
    assert.equal(readInkDeclaration(''), INK_MARK); // 属性だけ書いた場合
    assert.equal(readInkDeclaration('true'), INK_MARK);
    assert.equal(readInkDeclaration('none'), INK_NONE);
    assert.equal(readInkDeclaration('false'), INK_NONE);
});

test('宣言が無ければ null（自動検出に回す）', () => {
    assert.equal(readInkDeclaration(null), null);
    assert.equal(readInkDeclaration(undefined), null);
    assert.equal(readInkDeclaration('なにか'), null);
});

// ── ⭐ Canvas / WebGL の扱い ────────────────────────────────────

test('⭐ canvas を含む viz は既定で掛けない（文字が焼き込まれている）', () => {
    const r = decideInkScope({ hasCanvas: true });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'canvas');
});

test('明示的に許可すれば canvas でも掛ける', () => {
    assert.equal(decideInkScope({ hasCanvas: true, allowCanvas: true }).apply, true);
});

test('⭐ viz が印を宣言していれば canvas があっても掛ける', () => {
    // 宣言できている＝viz が「ここは歪ませてよい」と分かっている
    const r = decideInkScope({ hasCanvas: true, declared: true });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'declared');
});

test('普通の SVG viz は自動検出で掛ける', () => {
    const r = decideInkScope({ hasCanvas: false });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'auto');
});

test('引数なしでも落ちない', () => {
    assert.equal(decideInkScope().apply, true);
});


// ── ⭐ 図形の大きさに応じた強さ（2026-08-13 に追加）──────────────
//
// ⚠ `scale` は **px の固定値**なので、同じ値でも
//   小さい図形では強く・大きい図形では**ほぼ効かない**。
//   実際「カスタム viz に質感が乗らない」と報告された原因がこれ。

test('⭐ 大きい図形ほど強くする（そうしないと効きが見えない）', () => {
    // ゲージの弧 270px は棒 60px より強く掛けないと同じ印象にならない
    assert.ok(sizeTierFor(270) > sizeTierFor(60), '大きい図形が弱いまま');
});

test('小さい印は弱める（効きすぎて壊れて見える）', () => {
    assert.ok(sizeTierFor(20) < sizeTierFor(60), '小さい印が強すぎる');
});

test('⭐ 倍率に上限がある（青天井だと輪郭が溶ける）', () => {
    assert.ok(sizeTierFor(10000) <= 2.5, '特大で強くなりすぎる');
    assert.equal(sizeTierFor(10000), sizeTierFor(100000), '上限で頭打ちになっていない');
});

test('不正な大きさでも落ちない（1 倍に落とす）', () => {
    assert.equal(sizeTierFor(0), 1);
    assert.equal(sizeTierFor(-5), 1);
    assert.equal(sizeTierFor(NaN), 1);
    assert.equal(sizeTierFor(undefined), 1);
});

test('⭐ 大きさごとに別の filter id を指す（共有すると同じ強さになる）', () => {
    assert.notEqual(brushFilterIdForSize('crayon', 60), brushFilterIdForSize('crayon', 270));
});

test('⚠ 段を付けない素の id は使わない（存在せず無言で効かなくなる）', () => {
    // `dpx-brush-crayon` という filter は実体が無い
    assert.match(brushFilterIdForSize('crayon', 100), /-t\d+$/);
});


// ── ⭐ 例外は 1 行で書ける（全か無かにしない）─────────────────────
//
// ⚠ 以前は「`mark` が 1 つでもあれば宣言だけを見る」全か無かの仕様だった。
//   これだと**例外を 1 つ書くために全部書く**羽目になる
//   （gauge-arc なら 16 箇所）。ユーザー指摘で 2026-08-13 に修正。

test('⭐ mark を書いても自動検出は止まらない（例外 1 行のため）', () => {
    assert.equal(isDeclarativeOnly(['mark']), false);
    assert.equal(isDeclarativeOnly(['mark', 'none']), false);
});

test('only を書いたときだけ宣言モードになる', () => {
    assert.equal(isDeclarativeOnly(['only']), true);
    assert.equal(isDeclarativeOnly(['none', 'only']), true);
});

test('宣言が無ければ自動検出のまま', () => {
    assert.equal(isDeclarativeOnly([]), false);
    assert.equal(isDeclarativeOnly(undefined), false);
});

test('only の宣言を読める', () => {
    assert.equal(readInkDeclaration('only'), INK_ONLY);
});

console.log(`ink: ${pass} tests passed`);
