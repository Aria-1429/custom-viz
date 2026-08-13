// ── Layout Engine のテスト ──────────────────────────────────────
//
// **座標計算は必ずテストで押さえる。**
// 枠やパネルのズレは**目視で気づけない**（1 マスずれてもそれらしく見える）。
//
// 特に押さえたいのは、実機で踏んだ規則:
//   - 区画のクランプは**全体で**判定する（メンバーごとだと形が崩れる）
//   - ドラッグは**掴んだ時点からの絶対量**で計算する（差分の足し込みはズレる）
//   - レイアウト切替は**座標変換を伴う**（単位が変わるため）
//
// 実行: node test/layout.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
    convertFromGrid,
    convertToGrid,
    layoutFor,
    listLayouts,
    makeLayoutContext,
    resolveLayout,
    switchLayoutType,
} from '../src/main/webapp/components/layout/index.js';

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

// 幅 1200px / 12 列 / gap 12 → セル幅 = (1200 - 132) / 12 = 89
const gridCtx = makeLayoutContext({
    layout: { type: 'grid', grid: { columns: 12, rowHeight: 72, gap: 12 } },
    containerWidth: 1200,
});
const freeCtx = makeLayoutContext({
    layout: { type: 'freeform', freeform: { snap: 8 } },
    containerWidth: 1200,
});

const grid = resolveLayout('grid');
const free = resolveLayout('freeform');

// ── レジストリ ─────────────────────────────────────────────────

test('type からエンジンを引ける', () => {
    assert.equal(grid.id, 'grid');
    assert.equal(free.id, 'freeform');
});

test('未知の type は grid に落ちる（描画を必ず成立させる）', () => {
    assert.equal(resolveLayout('no_such_layout').id, 'grid');
    assert.equal(resolveLayout(undefined).id, 'grid');
});

test('definition からエンジンを引ける', () => {
    assert.equal(layoutFor({ layout: { type: 'freeform' } }).id, 'freeform');
    assert.equal(layoutFor({}).id, 'grid');
});

test('選択肢を列挙できる', () => {
    const list = listLayouts();
    assert.equal(list.length, 2);
    assert.ok(list.every((l) => l.value && l.label));
});

// ── Grid: 配置 ─────────────────────────────────────────────────

test('grid: パネルの配置 CSS が 1 始まりの行列になる', () => {
    const s = grid.styleFor({ x: 0, y: 0, w: 6, h: 3 }, gridCtx);
    assert.equal(s.gridColumn, '1 / span 6');
    assert.equal(s.gridRow, '1 / span 3');
});

test('grid: 区画の見出し行があると行番号がずれる（定義は書き換えない）', () => {
    const ctx = makeLayoutContext({
        layout: { grid: { columns: 12, rowHeight: 72, gap: 12 } },
        containerWidth: 1200,
        rowOf: (y) => y + 2, // 見出し行を 1 行挿し込んだ状態
    });
    const s = grid.styleFor({ x: 0, y: 0, w: 6, h: 3 }, ctx);
    assert.equal(s.gridRow, '2 / span 3');
});

test('grid: 高さは行数 × rowHeight ＋ 間の gap', () => {
    // 3 行 = 72*3 + 12*2 = 240
    assert.equal(grid.pixelSize({ h: 3 }, gridCtx).height, 240);
    assert.equal(grid.pixelSize({ h: 1 }, gridCtx).height, 72);
});

// ── Grid: ドラッグ ─────────────────────────────────────────────

test('grid: 1 セルぶん右へドラッグすると x が 1 増える', () => {
    // セル幅 89 + gap 12 = 101px でちょうど 1 セル
    const r = grid.applyDrag({ x: 0, y: 0, w: 4, h: 2 }, { dx: 101, dy: 0 }, gridCtx);
    assert.deepEqual(r, { x: 1, y: 0 });
});

test('grid: 動いていないときは null（保存対象にしない）', () => {
    assert.equal(grid.applyDrag({ x: 0, y: 0, w: 4, h: 2 }, { dx: 3, dy: 2 }, gridCtx), null);
});

test('grid: 右端で止まる（はみ出さない）', () => {
    const r = grid.applyDrag({ x: 8, y: 0, w: 4, h: 2 }, { dx: 9999, dy: 0 }, gridCtx);
    assert.equal(r, null, '既に右端なので動かない');
    const r2 = grid.applyDrag({ x: 0, y: 0, w: 4, h: 2 }, { dx: 9999, dy: 0 }, gridCtx);
    assert.equal(r2.x, 8, '12 列 - 幅 4 = 8 で止まる');
});

test('grid: 上端で止まる（負の座標に出ない）', () => {
    const r = grid.applyDrag({ x: 2, y: 0, w: 4, h: 2 }, { dx: 0, dy: -9999 }, gridCtx);
    assert.equal(r, null);
});

test('grid: リサイズは列上限で止まる', () => {
    const r = grid.applyResize({ x: 8, y: 0, w: 2, h: 2 }, { dx: 9999, dy: 0 }, gridCtx);
    assert.equal(r.w, 4, '12 - x(8) = 4');
});

test('grid: 幅は 1 未満にならない', () => {
    const r = grid.applyResize({ x: 0, y: 0, w: 2, h: 2 }, { dx: -9999, dy: -9999 }, gridCtx);
    assert.equal(r.w, 1);
    assert.equal(r.h, 1);
});

// ── Grid: 矢印キー ─────────────────────────────────────────────

test('grid: 矢印で 1 マス動く', () => {
    assert.deepEqual(grid.nudge({ x: 2, y: 1, w: 4, h: 2 }, [1, 0], false, gridCtx), { x: 3, y: 1 });
    assert.deepEqual(grid.nudge({ x: 2, y: 1, w: 4, h: 2 }, [0, -1], false, gridCtx), { x: 2, y: 0 });
});

test('grid: Shift+矢印でリサイズ', () => {
    assert.deepEqual(grid.nudge({ x: 0, y: 0, w: 4, h: 2 }, [1, 0], true, gridCtx), { w: 5, h: 2 });
});

// ── Grid: 区画のクランプ（最重要）───────────────────────────────

test('⭐ grid: 区画のクランプは全体で判定する（形が崩れない）', () => {
    // p1 は右端に近い。個別に丸めると p1 だけ止まって形が崩れる
    const members = [
        { id: 'a', x: 0, y: 0, w: 4, h: 2 },
        { id: 'b', x: 8, y: 0, w: 4, h: 2 }, // 右端に接している
    ];
    const d = grid.clampGroupDelta(members, { dx: 3, dy: 0 }, gridCtx);
    assert.equal(d.dx, 0, '右端のメンバーがいるので区画全体が動けない');
});

test('grid: 区画は左端でも全体で止まる', () => {
    const members = [
        { id: 'a', x: 0, y: 2, w: 4, h: 2 },
        { id: 'b', x: 4, y: 2, w: 4, h: 2 },
    ];
    const d = grid.clampGroupDelta(members, { dx: -5, dy: -5 }, gridCtx);
    assert.equal(d.dx, 0, '左端のメンバーがいるので動けない');
    assert.equal(d.dy, -2, '上へは 2 行ぶん動ける');
});

test('grid: 区画が動ける範囲なら指定量そのまま', () => {
    const members = [{ id: 'a', x: 2, y: 2, w: 2, h: 2 }];
    assert.deepEqual(grid.clampGroupDelta(members, { dx: 1, dy: 1 }, gridCtx), { dx: 1, dy: 1 });
});

test('grid: メンバーが居ない区画は動かない', () => {
    assert.deepEqual(grid.clampGroupDelta([], { dx: 3, dy: 3 }, gridCtx), { dx: 0, dy: 0 });
});

// ── Freeform ───────────────────────────────────────────────────

test('freeform: 絶対配置の CSS を返す', () => {
    const s = free.styleFor({ x: 100, y: 50, w: 300, h: 200 }, freeCtx);
    assert.equal(s.position, 'absolute');
    assert.equal(s.left, 100);
    assert.equal(s.top, 50);
    assert.equal(s.width, 300);
    assert.equal(s.height, 200);
});

test('freeform: 高さは px がそのまま出る', () => {
    assert.equal(free.pixelSize({ w: 300, h: 200 }).height, 200);
    assert.equal(free.pixelSize({ w: 300, h: 200 }).width, 300);
});

test('freeform: スナップ幅に丸められる', () => {
    // snap=8 なので 100 + 13 = 113 → 112
    const r = free.applyDrag({ x: 100, y: 0, w: 300, h: 200 }, { dx: 13, dy: 0 }, freeCtx);
    assert.equal(r.x, 112);
});

test('freeform: 左端・上端で止まる', () => {
    const r = free.applyDrag({ x: 10, y: 10, w: 300, h: 200 }, { dx: -9999, dy: -9999 }, freeCtx);
    assert.equal(r.x, 0);
    assert.equal(r.y, 0);
});

test('freeform: 右端はコンテナ幅で止まる', () => {
    const r = free.applyDrag({ x: 0, y: 0, w: 300, h: 200 }, { dx: 9999, dy: 0 }, freeCtx);
    assert.equal(r.x, 900, 'コンテナ 1200 - 幅 300');
});

test('freeform: 最小サイズを下回らない', () => {
    const r = free.applyResize({ x: 0, y: 0, w: 100, h: 100 }, { dx: -9999, dy: -9999 }, freeCtx);
    assert.equal(r.w, 40);
    assert.equal(r.h, 32);
});

test('freeform: 矢印は 1 スナップぶん動く', () => {
    assert.deepEqual(free.nudge({ x: 100, y: 100, w: 300, h: 200 }, [1, 0], false, freeCtx), {
        x: 108,
        y: 100,
    });
});

// ── レイアウト切替（座標変換）────────────────────────────────────

test('⭐ グリッド → フリーフォームで座標が px に変換される', () => {
    // セル 6 は 6 * (89 + 12) = 606px であって「6px」ではない
    const def = {
        layout: { type: 'grid', grid: { columns: 12, rowHeight: 72, gap: 12 } },
        panels: [{ id: 'p1', viz: 'dpx.line', x: 6, y: 1, w: 4, h: 2 }],
    };
    const next = switchLayoutType(def, 'freeform', gridCtx);
    const p = next.panels[0];
    assert.equal(next.layout.type, 'freeform');
    assert.equal(p.x, 606, 'セル 6 が 606px になる（6px ではない）');
    assert.equal(p.y, 84, '行 1 が 84px');
    assert.equal(p.h, 156, '2 行 = 72*2 + 12');
});

test('フリーフォーム → グリッドで列 / 行に戻る', () => {
    const def = {
        layout: { type: 'freeform', grid: { columns: 12, rowHeight: 72, gap: 12 } },
        panels: [{ id: 'p1', viz: 'dpx.line', x: 606, y: 84, w: 368, h: 156 }],
    };
    const next = switchLayoutType(def, 'grid', gridCtx);
    const p = next.panels[0];
    assert.equal(next.layout.type, 'grid');
    assert.equal(p.x, 6);
    assert.equal(p.y, 1);
    assert.equal(p.h, 2);
});

test('往復で元の座標に戻る（丸め誤差で崩れない）', () => {
    const panels = [{ id: 'p1', x: 3, y: 2, w: 5, h: 3 }];
    const back = convertToGrid(convertFromGrid(panels, gridCtx), gridCtx);
    assert.deepEqual(
        { x: back[0].x, y: back[0].y, w: back[0].w, h: back[0].h },
        { x: 3, y: 2, w: 5, h: 3 }
    );
});

test('同じ type への切替は同じ参照を返す（無駄な dirty を作らない）', () => {
    const def = { layout: { type: 'grid' }, panels: [] };
    assert.equal(switchLayoutType(def, 'grid', gridCtx), def);
});

test('変換後も列の上限を超えない', () => {
    // 極端に幅の広いパネルを戻しても 12 列に収まる
    const def = {
        layout: { type: 'freeform', grid: { columns: 12, rowHeight: 72, gap: 12 } },
        panels: [{ id: 'p1', x: 5000, y: 0, w: 5000, h: 100 }],
    };
    const p = switchLayoutType(def, 'grid', gridCtx).panels[0];
    assert.ok(p.x + p.w <= 12, `12 列を超えた: x=${p.x} w=${p.w}`);
});

// ── 不正な入力で落ちない ────────────────────────────────────────

test('数値でない座標でも落ちない（NaN を素通しさせない）', () => {
    const s = grid.styleFor({ x: 'abc', y: null, w: undefined, h: NaN }, gridCtx);
    assert.equal(s.gridColumn, '1 / span 1');
    assert.equal(s.gridRow, '1 / span 1');
});

console.log(`layout: ${pass} tests passed`);
