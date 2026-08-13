// ── Brush Engine のテスト ───────────────────────────────────────
//
// 押さえたいのはユーザー指定の 4 原則:
//   1. 中間表現（単一 d に固定しない／ライブラリの語彙を漏らさない）
//   2. **決定論的 seed**（再描画・再サーチで形が変わらない）
//   3. Visual と Interaction の分離（当たり判定は元 geometry）
//   4. **flat は再生成しない**（完全な後方互換）
//
// ⚠ 2 と 4 は**実機で症状が出ても原因特定が難しい**種類のバグ
//   （「画面がなんとなく落ち着かない」「flat のはずが微妙に違う」）。
//   ここで機械的に固定する。
//
// 実行: node test/brush.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    brushArea,
    brushLine,
    brushRect,
    hasBrush,
    BRUSH_IDS,
} from '../src/main/webapp/components/design/brush/brushes.js';
import {
    ROLE,
    prunePaths,
    seedFor,
} from '../src/main/webapp/components/design/brush/types.js';

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

const PTS = [
    [0, 50],
    [40, 12],
    [80, 44],
    [120, 8],
    [160, 30],
];

// ── 原則 2: 決定論的 seed ───────────────────────────────────────

test('⭐ 同じ seed なら完全に同じ形になる（再描画でチラつかない）', () => {
    const a = brushLine(PTS, 12345, 'pencil');
    const b = brushLine(PTS, 12345, 'pencil');
    assert.deepEqual(a, b, '同じ seed で形が変わっている＝再描画のたびにチラつく');
});

test('seed が違えば別の形になる（画一的でない）', () => {
    const a = brushLine(PTS, 1, 'pencil');
    const b = brushLine(PTS, 2, 'pencil');
    assert.notDeepEqual(a, b);
});

test('seedFor は決定論的', () => {
    assert.equal(seedFor('p1', 'cpu', 5), seedFor('p1', 'cpu', 5));
});

test('seedFor は引数が違えば別の値', () => {
    assert.notEqual(seedFor('p1', 'cpu', 5), seedFor('p1', 'mem', 5));
    assert.notEqual(seedFor('p1', 'cpu', 5), seedFor('p2', 'cpu', 5));
    assert.notEqual(seedFor('p1', 'cpu', 5), seedFor('p1', 'cpu', 6), '点数が変われば形も変わる');
});

test('seedFor は必ず正の整数（rough.js の seed 要件）', () => {
    for (const s of ['', 'a', 'パネル', 'p1|cpu|999', '~!@#$%^&*()']) {
        const v = seedFor(s);
        assert.ok(Number.isInteger(v) && v > 0, `${JSON.stringify(s)} → ${v}`);
    }
});

test('seedFor は null/undefined を無視する（落ちない）', () => {
    assert.ok(seedFor('p1', null, undefined, 3) > 0);
});

// ── 原則 1: 中間表現 ────────────────────────────────────────────

test('⭐ 塗りは複数 path になる（単一 d では表現できない）', () => {
    const paths = brushRect(0, 0, 60, 100, 7, 'pencil', '#4ea1ff');
    assert.ok(paths.length >= 2, `塗り＋輪郭で 2 本以上要る（実際 ${paths.length}）`);
});

test('⭐ ライブラリ固有の語彙が BrushPath に漏れていない', () => {
    // rough.js の set 種別（fillSketch 等）や roughness/bowing を公開しない
    const paths = [
        ...brushLine(PTS, 1, 'crayon'),
        ...brushRect(0, 0, 40, 60, 1, 'crayon', '#f00'),
        ...brushArea(PTS.concat([[160, 60], [0, 60]]), 1, 'watercolor', '#f00'),
    ];
    const allowed = new Set(['d', 'role', 'width', 'opacity', 'color', 'filled']);
    for (const p of paths) {
        for (const k of Object.keys(p)) {
            assert.ok(allowed.has(k), `未許可のキーが漏れている: ${k}`);
        }
        assert.ok(['fill', 'stroke', 'accent'].includes(p.role), `未知の role: ${p.role}`);
    }
});

test('BrushPath は必ず d を持つ', () => {
    for (const id of BRUSH_IDS) {
        for (const p of brushLine(PTS, 3, id)) {
            assert.ok(typeof p.d === 'string' && p.d.length > 0, `${id} の d が空`);
        }
    }
});

test('全画材で線が引ける', () => {
    for (const id of BRUSH_IDS) {
        assert.ok(brushLine(PTS, 5, id).length > 0, `${id} が線を返さない`);
    }
});

test('⭐ 線には必ず stroke role が含まれる（グラフが読めなくならない）', () => {
    for (const id of BRUSH_IDS) {
        const paths = brushLine(PTS, 5, id);
        assert.ok(paths.some((p) => p.role === ROLE.STROKE), `${id} に主線が無い`);
    }
});

// ── 原則 4: flat は再生成しない ─────────────────────────────────

test('⭐ flat は画材として実装されていない', () => {
    // 実装を持たせると「flat のはずなのに微妙に違う」が起きる
    assert.equal(hasBrush('flat'), false);
    assert.ok(!BRUSH_IDS.includes('flat'));
});

test('未知の画材でも落ちない（空を返す）', () => {
    assert.deepEqual(brushLine(PTS, 1, 'no_such_brush'), []);
    assert.deepEqual(brushRect(0, 0, 10, 10, 1, 'no_such_brush', '#fff'), []);
});

// ── 品質レベルでの間引き ────────────────────────────────────────

test('minimal では stroke だけが残る（読めることを優先）', () => {
    const paths = brushLine(PTS, 9, 'crayon');
    const pruned = prunePaths(paths, 'minimal');
    assert.ok(pruned.length > 0, '全部消えている');
    assert.ok(pruned.every((p) => p.role === ROLE.STROKE));
});

test('reduced では accent（重ね描き）だけ落ちる', () => {
    const paths = brushLine(PTS, 9, 'crayon');
    const pruned = prunePaths(paths, 'reduced');
    assert.ok(pruned.every((p) => p.role !== ROLE.ACCENT));
    assert.ok(pruned.some((p) => p.role === ROLE.STROKE), '主線まで消している');
});

test('full では何も落とさない', () => {
    const paths = brushLine(PTS, 9, 'crayon');
    assert.equal(prunePaths(paths, 'full').length, paths.length);
});

test('prunePaths は不正入力で落ちない', () => {
    assert.deepEqual(prunePaths(null, 'full'), []);
    assert.deepEqual(prunePaths(undefined, 'minimal'), []);
});

// ── 不正入力 ───────────────────────────────────────────────────

test('点が 2 未満なら線は描かない', () => {
    assert.deepEqual(brushLine([[0, 0]], 1, 'pencil'), []);
    assert.deepEqual(brushLine([], 1, 'pencil'), []);
    assert.deepEqual(brushLine(null, 1, 'pencil'), []);
});

test('面は 3 点未満なら描かない', () => {
    assert.deepEqual(brushArea([[0, 0], [1, 1]], 1, 'watercolor', '#fff'), []);
});

test('幅・高さが 0 以下の矩形は描かない', () => {
    assert.deepEqual(brushRect(0, 0, 0, 50, 1, 'pencil', '#fff'), []);
    assert.deepEqual(brushRect(0, 0, 50, -1, 1, 'pencil', '#fff'), []);
});

// ── 重ね描き ───────────────────────────────────────────────────

test('重ね描きする画材は accent を持つ（品質で落とせる）', () => {
    // crayon / pencil は passes=2（二度塗りが画材の特徴）
    const paths = brushLine(PTS, 11, 'crayon');
    assert.ok(paths.some((p) => p.role === ROLE.ACCENT), '重ね描きが accent になっていない');
});

test('重ね描きは同じ形の完全な重複ではない（1 本に見えてしまう）', () => {
    const paths = brushLine(PTS, 11, 'crayon');
    const strokes = paths.filter((p) => p.role !== ROLE.FILL);
    const ds = new Set(strokes.map((p) => p.d));
    assert.equal(ds.size, strokes.length, '重ね描きの d が同一＝seed をずらせていない');
});

console.log(`brush: ${pass} tests passed`);
