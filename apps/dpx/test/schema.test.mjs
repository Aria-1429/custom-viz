// ── Dashboard Schema v2 のテスト ────────────────────────────────
//
// 検証したいのは主に「**既定値が 1 か所から来ること**」と
// 「**壊れた定義で落ちないこと**」の 2 点。
// どちらも実機で実害が出た性質（§8.dd の既定値ズレ、開けないボード）。
//
// 実行: node test/schema.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    DEFAULTS,
    PANEL_VARIANT_VALUES,
    SCHEMA_VERSION,
    categoryRank,
    defaultVariantForCategory,
} from '../src/main/webapp/components/schema/vocab.js';
import {
    emptyDashboard,
    DashboardSchema,
} from '../src/main/webapp/components/schema/dashboard.js';
import {
    parseDefinition,
    parseDefinitionText,
    serializeDefinition,
} from '../src/main/webapp/components/schema/parse.js';

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

const minimal = () => ({
    schemaVersion: SCHEMA_VERSION,
    panels: [{ id: 'p1', viz: 'dpx.line' }],
});

// ── 既定値 ─────────────────────────────────────────────────────

test('空のダッシュボードに既定値が埋まる', () => {
    const d = emptyDashboard('テスト');
    assert.equal(d.schemaVersion, SCHEMA_VERSION);
    assert.equal(d.title, 'テスト');
    assert.equal(d.layout.type, 'grid');
    assert.equal(d.layout.grid.columns, DEFAULTS.grid.columns);
    assert.equal(d.layout.grid.rowHeight, DEFAULTS.grid.rowHeight);
    assert.equal(d.style.preset, DEFAULTS.style.preset);
    assert.equal(d.chrome, DEFAULTS.chrome);
    assert.deepEqual(d.panels, []);
});

test('パネルの既定値（w/h/x/y）が埋まる', () => {
    const r = parseDefinition(minimal());
    assert.ok(r.ok, r.error);
    const p = r.definition.panels[0];
    assert.equal(p.w, DEFAULTS.panel.w);
    assert.equal(p.h, DEFAULTS.panel.h);
    assert.equal(p.x, 0);
    assert.equal(p.y, 0);
    assert.deepEqual(p.options, {});
});

test('既定値は vocab の DEFAULTS と一致する（二重定義の検出）', () => {
    // ⚠ このテストの目的は「スキーマとコードの既定値がズレていないこと」。
    //   ズレは実機で「UI と実物の食い違い」として現れ、目視では気づけない。
    const d = emptyDashboard();
    assert.equal(d.layout.grid.gap, DEFAULTS.grid.gap);
    assert.equal(d.style.radius, DEFAULTS.style.radius);
    assert.equal(d.style.entrance, DEFAULTS.style.entrance);
});

// ── 未知の値のフォールバック ────────────────────────────────────

test('未知の質感は既定へ落ちる（保存できなくならない）', () => {
    const r = parseDefinition({
        ...minimal(),
        panels: [{ id: 'p1', viz: 'dpx.line', style: { variant: 'no_such_variant' } }],
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.definition.panels[0].style.variant, 'noc');
});

test('未知のプリセットは midnight へ落ちる', () => {
    const r = parseDefinition({ ...minimal(), style: { preset: 'gone' } });
    assert.ok(r.ok, r.error);
    assert.equal(r.definition.style.preset, 'midnight');
});

test('全ての質感が受け付けられる', () => {
    for (const v of PANEL_VARIANT_VALUES) {
        const r = parseDefinition({
            ...minimal(),
            panels: [{ id: 'p1', viz: 'dpx.line', style: { variant: v } }],
        });
        assert.ok(r.ok, `${v}: ${r.error}`);
        assert.equal(r.definition.panels[0].style.variant, v);
    }
});

// ── 未指定は触らない（パネル個別の上書き）──────────────────────

test('パネル個別の上書きは未指定なら生えない', () => {
    // ⚠ ここが default() になっていると質感プリセットを常に上書きして壊れる
    const r = parseDefinition(minimal());
    assert.ok(r.ok, r.error);
    const style = r.definition.panels[0].style;
    assert.equal(style.bg, undefined);
    assert.equal(style.borderColor, undefined);
    assert.equal(style.rotate, undefined);
    assert.equal(style.variant, undefined, 'variant も未指定なら未設定のまま（カテゴリで決める）');
});

// ── 不正な定義 ─────────────────────────────────────────────────

test('トップレベルが配列なら理由を返す', () => {
    const r = parseDefinition([]);
    assert.equal(r.ok, false);
    assert.match(r.error, /オブジェクトではありません/);
});

test('null でも落ちない', () => {
    const r = parseDefinition(null);
    assert.equal(r.ok, false);
});

test('viz が無いパネルは場所つきで拒否される', () => {
    const r = parseDefinition({ schemaVersion: SCHEMA_VERSION, panels: [{ id: 'p1' }] });
    assert.equal(r.ok, false);
    assert.ok(r.issues.length > 0, '理由が空');
    assert.ok(
        r.issues.some((s) => s.includes('panels.0.viz')),
        `パスが出ていない: ${JSON.stringify(r.issues)}`
    );
});

test('id が空文字のパネルは拒否される', () => {
    const r = parseDefinition({
        schemaVersion: SCHEMA_VERSION,
        panels: [{ id: '', viz: 'dpx.line' }],
    });
    assert.equal(r.ok, false);
});

// ── 他形式の検出（黙って弾かない）───────────────────────────────

test('DPX v1 は「v1 である」と言って断る', () => {
    const r = parseDefinition({ version: 1, panels: [], title: '旧' });
    assert.equal(r.ok, false);
    assert.match(r.error, /v1/);
});

test('Studio の定義は「Studio である」と言って断る', () => {
    const r = parseDefinition({ version: '1.1', visualizations: {}, layout: {}, dataSources: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /Studio/);
});

// ── データソース ───────────────────────────────────────────────

test('データソースの既定の時間範囲が埋まる', () => {
    const r = parseDefinition({
        ...minimal(),
        dataSources: { ds1: { spl: 'index=web | stats count' } },
    });
    assert.ok(r.ok, r.error);
    const ds = r.definition.dataSources.ds1;
    assert.equal(ds.earliest, DEFAULTS.search.earliest);
    assert.equal(ds.latest, DEFAULTS.search.latest);
    assert.equal(ds.refresh, 0);
});

test('パネルの時間範囲は未指定なら生えない（データソース側を使うため）', () => {
    const r = parseDefinition({
        ...minimal(),
        panels: [{ id: 'p1', viz: 'dpx.line', search: { ref: 'ds1' } }],
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.definition.panels[0].search.earliest, undefined);
    assert.equal(r.definition.panels[0].search.ref, 'ds1');
});

// ── viz オプションは素通し ──────────────────────────────────────

test('viz の未知オプションは保存される（canvasEdit の点列など）', () => {
    // ⚠ ここを縛ると canvasEdit 系 viz（link-line の点列・ラベル位置）が壊れる
    const r = parseDefinition({
        ...minimal(),
        panels: [
            { id: 'p1', viz: 'dpx.linkLine', options: { points: [[0, 0], [1, 1]], labelPos: 0.5 } },
        ],
    });
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.definition.panels[0].options.points, [[0, 0], [1, 1]]);
    assert.equal(r.definition.panels[0].options.labelPos, 0.5);
});

// ── 直列化の往復 ───────────────────────────────────────────────

test('直列化 → 読み戻しで同じ定義になる', () => {
    const d = emptyDashboard('往復');
    const s = serializeDefinition(d);
    assert.ok(s.ok, s.error);
    const back = parseDefinitionText(s.text);
    assert.ok(back.ok, back.error);
    assert.deepEqual(back.definition, d);
});

test('壊れた定義は保存前に止まる', () => {
    const s = serializeDefinition({ schemaVersion: SCHEMA_VERSION, panels: [{ id: 'p1' }] });
    assert.equal(s.ok, false);
});

test('JSON として読めない文字列は理由を返す', () => {
    const r = parseDefinitionText('{ not json');
    assert.equal(r.ok, false);
    assert.match(r.error, /JSON として読めません/);
});

// ── vocab のヘルパ ─────────────────────────────────────────────

test('図形・装飾の既定質感は枠なし（枠の二重を防ぐ）', () => {
    assert.equal(defaultVariantForCategory('shape'), 'frameless');
    assert.equal(defaultVariantForCategory('deco'), 'frameless');
    assert.equal(defaultVariantForCategory('chart'), 'noc');
    assert.equal(defaultVariantForCategory(undefined), 'noc');
});

test('未知カテゴリは末尾に送られる（indexOf の -1 罠）', () => {
    // ⚠ indexOf の結果をそのまま比較キーにすると未知の値が先頭に来る
    assert.ok(categoryRank('unknown') > categoryRank('shape'));
    assert.ok(categoryRank('chart') < categoryRank('deco'));
});

// ── 区画 ───────────────────────────────────────────────────────

test('区画に polaroid / punchCard は指定できない（既定へ落ちる）', () => {
    // 中身がある前提の質感なので、中身を持たない区画では破綻する
    for (const bad of ['polaroid', 'punchCard']) {
        const r = parseDefinition({
            ...minimal(),
            groups: [{ id: 'g1', panels: ['p1'], variant: bad }],
        });
        assert.ok(r.ok, r.error);
        assert.equal(r.definition.groups[0].variant, 'rule', `${bad} が通ってしまった`);
    }
});

// ── スキーマバージョン ──────────────────────────────────────────

test('schemaVersion が違う定義は拒否される', () => {
    const r = parseDefinition({ schemaVersion: 99, panels: [] });
    assert.equal(r.ok, false);
});

test('schemaVersion 省略時は現行版が入る', () => {
    const r = parseDefinition({ panels: [] });
    assert.ok(r.ok, r.error);
    assert.equal(r.definition.schemaVersion, SCHEMA_VERSION);
});

console.log(`schema: ${pass} tests passed`);
