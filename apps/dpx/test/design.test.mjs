// ── Design Engine のテスト ──────────────────────────────────────
//
// 4 軸（Theme / Surface / Brush / Motion）のうち、**新しく足した
// Motion と Brush フィルタ**を押さえる。
//
// 特に守りたい性質:
//   - **Motion は既存の `entrance` 指定を無効にしない**（既存ボードが壊れる）
//   - **`prefers-reduced-motion` が最優先**（アクセシビリティ）
//   - **`flat` はフィルタを生成しない**（プロパティ自体を作らない＝合成レイヤを増やさない）
//
// 実行: node test/design.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    MOTION_VALUES,
    entranceDelay,
    hasAmbient,
    resolveMotion,
} from '../src/main/webapp/components/design/motion.js';

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

// ── Motion: 既存指定を壊さない（最重要）─────────────────────────

test('⭐ entrance の明示指定は Motion より優先される（既存ボードを壊さない）', () => {
    // 置き換えてしまうと、既存の style.entrance 指定が全部無効になる
    const r = resolveMotion({ motion: 'organic', entrance: 'flip' });
    assert.equal(r.entrance, 'flip', 'Motion が明示指定を上書きしている');
});

test('entrance 未指定なら Motion の既定が入る', () => {
    assert.equal(resolveMotion({ motion: 'subtle' }).entrance, 'fade');
    assert.equal(resolveMotion({ motion: 'spring' }).entrance, 'pop');
    assert.equal(resolveMotion({ motion: 'organic' }).entrance, 'rise');
});

test("'auto' は未指定として扱う", () => {
    assert.equal(resolveMotion({ motion: 'spring', entrance: 'auto' }).entrance, 'pop');
});

// ── Motion: 止めるべきときは止める ──────────────────────────────

test('⭐ prefers-reduced-motion が最優先（明示指定より強い）', () => {
    const r = resolveMotion({ motion: 'organic', entrance: 'flip', prefersReducedMotion: true });
    assert.equal(r.entrance, 'none');
    assert.equal(r.ambient, 'none');
    assert.equal(r.enabled, false);
});

test('品質 minimal でも動きを止める', () => {
    const r = resolveMotion({ motion: 'spring', quality: 'minimal' });
    assert.equal(r.enabled, false);
});

test("motion='none' は何も動かさない", () => {
    const r = resolveMotion({ motion: 'none', entrance: 'flip' });
    assert.equal(r.entrance, 'none');
});

test('未知の motion は subtle に落ちる', () => {
    assert.equal(resolveMotion({ motion: 'turbo' }).entrance, 'fade');
});

// ── Motion: 常時アニメ ──────────────────────────────────────────

test('organic だけが常時アニメを持つ', () => {
    assert.equal(hasAmbient('organic'), true);
    assert.equal(hasAmbient('subtle'), false);
    assert.equal(hasAmbient('spring'), false);
    assert.equal(hasAmbient('none'), false);
});

test('ambient の明示指定も尊重される', () => {
    assert.equal(resolveMotion({ motion: 'subtle', ambient: 'breathe' }).ambient, 'breathe');
});

// ── Motion: 出現の遅延 ──────────────────────────────────────────

test('パネルの順番でずれる（波が走って見える）', () => {
    assert.equal(entranceDelay(0, 'subtle'), 0);
    assert.ok(entranceDelay(3, 'subtle') > entranceDelay(1, 'subtle'));
});

test('⭐ 遅延には上限がある（最後のパネルが出てこないように見えない）', () => {
    // 30 枚あると 70ms × 30 = 2.1 秒。上限が無いと「壊れている」ように見える
    assert.ok(entranceDelay(100, 'subtle') <= 700);
    assert.ok(entranceDelay(100, 'organic') <= 700);
});

test("motion='none' は遅延ゼロ", () => {
    assert.equal(entranceDelay(5, 'none'), 0);
});

test('不正な index でも落ちない', () => {
    assert.equal(entranceDelay(NaN, 'subtle'), 0);
    assert.equal(entranceDelay(undefined, 'subtle'), 0);
});

// ── 語彙 ───────────────────────────────────────────────────────

test('Motion は 4 種', () => {
    assert.deepEqual(MOTION_VALUES, ['none', 'subtle', 'spring', 'organic']);
});

console.log(`design: ${pass} tests passed`);
