// ── Material Engine（品質レベル）のテスト ───────────────────────
//
// 押さえたいのは「**性能のために何を落とすか**」が意図どおりであること。
//
// ⚠ **色や配置を変えてはいけない**（変えると「テーマが切り替わった」ように見える）。
//   落としてよいのは**重ねている効果**（backdrop-filter / 影 / 発光）だけ。
//
// 実行: node test/material.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    QUALITY,
    allowsAnimatedBackground,
    allowsAnimation,
    allowsBackdropFilter,
    allowsGlow,
    applyQuality,
    autoQuality,
    resolveQuality,
} from '../src/main/webapp/components/design/quality.js';

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

const theme = { panelBg: '#0c1424', titleColor: '#fff' };

// ── 自動判定 ───────────────────────────────────────────────────

test('パネルが少なければ full', () => {
    assert.equal(autoQuality(1), QUALITY.FULL);
    assert.equal(autoQuality(9), QUALITY.FULL);
});

test('パネルが増えると reduced', () => {
    assert.equal(autoQuality(10), QUALITY.REDUCED);
    assert.equal(autoQuality(23), QUALITY.REDUCED);
});

test('極端に多いと minimal', () => {
    assert.equal(autoQuality(24), QUALITY.MINIMAL);
    assert.equal(autoQuality(100), QUALITY.MINIMAL);
});

test('数値でなくても落ちない', () => {
    assert.equal(autoQuality(undefined), QUALITY.FULL);
    assert.equal(autoQuality(NaN), QUALITY.FULL);
});

// ── 優先順位 ───────────────────────────────────────────────────

test('明示指定が自動判定より優先される', () => {
    // 壁面表示で「パネルが多くても full で出したい」ケース
    assert.equal(resolveQuality({ explicit: 'full', panelCount: 40 }), QUALITY.FULL);
    assert.equal(resolveQuality({ explicit: 'minimal', panelCount: 1 }), QUALITY.MINIMAL);
});

test("⭐ 'auto' は「未指定」として扱う（スキーマの既定値）", () => {
    // ここを明示指定として扱うと、自動判定が永久に効かなくなる
    assert.equal(resolveQuality({ explicit: 'auto', panelCount: 40 }), QUALITY.MINIMAL);
    assert.equal(resolveQuality({ explicit: 'auto', panelCount: 1 }), QUALITY.FULL);
});

test('未知の値は無視して自動判定に落ちる', () => {
    assert.equal(resolveQuality({ explicit: 'turbo', panelCount: 1 }), QUALITY.FULL);
});

test('⭐ prefers-reduced-motion は自動判定より優先される（配慮）', () => {
    assert.equal(resolveQuality({ panelCount: 1, prefersReducedMotion: true }), QUALITY.MINIMAL);
});

test('ただし明示指定は reduced-motion より強い（利用者の意思）', () => {
    assert.equal(
        resolveQuality({ explicit: 'full', panelCount: 1, prefersReducedMotion: true }),
        QUALITY.FULL
    );
});

// ── 可否の判定 ─────────────────────────────────────────────────

test('backdrop-filter は full のときだけ', () => {
    assert.equal(allowsBackdropFilter(QUALITY.FULL), true);
    assert.equal(allowsBackdropFilter(QUALITY.REDUCED), false);
    assert.equal(allowsBackdropFilter(QUALITY.MINIMAL), false);
});

test('アニメは minimal でのみ止まる', () => {
    assert.equal(allowsAnimation(QUALITY.FULL), true);
    assert.equal(allowsAnimation(QUALITY.REDUCED), true, 'reduced でアニメまで止めない');
    assert.equal(allowsAnimation(QUALITY.MINIMAL), false);
});

test('発光は minimal でのみ止まる', () => {
    assert.equal(allowsGlow(QUALITY.REDUCED), true);
    assert.equal(allowsGlow(QUALITY.MINIMAL), false);
});

test('canvas 背景のアニメは full のときだけ', () => {
    assert.equal(allowsAnimatedBackground(QUALITY.FULL), true);
    assert.equal(allowsAnimatedBackground(QUALITY.REDUCED), false);
});

// ── CSS の簡略化 ───────────────────────────────────────────────

const glass = () => ({
    background: 'rgba(20,30,50,0.55)',
    backdropFilter: 'blur(6px)',
    border: '1px solid rgba(120,160,220,0.3)',
    borderRadius: 2,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
});

test('full では何も落とさない（同じ参照を返す）', () => {
    const css = glass();
    assert.equal(applyQuality(css, QUALITY.FULL, theme), css);
});

test('⭐ reduced で backdrop-filter が落ちる', () => {
    const out = applyQuality(glass(), QUALITY.REDUCED, theme);
    assert.equal(out.backdropFilter, undefined);
    assert.equal(out.WebkitBackdropFilter, undefined);
});

test('⭐ ぼかしを落としたら地を不透明にする（読めなくならないように）', () => {
    // すりガラスは「半透明＋ぼかし」で成立している。ぼかしだけ消すと
    // ただの薄い板になって下の背景が透ける
    const out = applyQuality(glass(), QUALITY.REDUCED, theme);
    assert.equal(out.backgroundColor, theme.panelBg);
});

test('reduced では影を残す（境界が消えないように）', () => {
    const out = applyQuality(glass(), QUALITY.REDUCED, theme);
    assert.ok(out.boxShadow, 'reduced で影まで消している');
});

test('minimal では影も落とす', () => {
    const out = applyQuality(glass(), QUALITY.MINIMAL, theme);
    assert.equal(out.boxShadow, undefined);
});

test('⭐ 枠線は品質に関係なく残る（パネルが判別できなくなる）', () => {
    for (const q of [QUALITY.REDUCED, QUALITY.MINIMAL]) {
        const out = applyQuality(glass(), q, theme);
        assert.ok(out.border, `${q} で枠線が消えた`);
    }
});

test('⭐ 色（前景・角丸）は品質で変わらない', () => {
    // 変えると「テーマが切り替わった」ように見える
    const out = applyQuality(glass(), QUALITY.MINIMAL, theme);
    assert.equal(out.borderRadius, 2);
    assert.equal(out.border, glass().border);
});

test('⭐ backgroundImage（コーナーフレームの 8 層）を消さない', () => {
    // カギ括弧は linear-gradient 8 枚で描いている。ここを消すと枠が丸ごと消える
    const css = { backgroundImage: 'linear-gradient(a), linear-gradient(b)', boxShadow: 'x' };
    const out = applyQuality(css, QUALITY.MINIMAL, theme);
    assert.equal(out.backgroundImage, css.backgroundImage);
});

test('theme が無くても落ちない', () => {
    const out = applyQuality(glass(), QUALITY.REDUCED, null);
    assert.equal(out.backdropFilter, undefined);
});

test('css が null でも落ちない', () => {
    assert.equal(applyQuality(null, QUALITY.MINIMAL, theme), null);
});

test('元のオブジェクトを破壊しない', () => {
    const css = glass();
    applyQuality(css, QUALITY.MINIMAL, theme);
    assert.ok(css.backdropFilter, '入力を書き換えている');
    assert.ok(css.boxShadow);
});

console.log(`material: ${pass} tests passed`);
