// パネルグループの矩形計算テスト。
// 実行: node test/groups.test.mjs
//
// ⚠ 枠の矩形は「見た目で合っているか」が判定しづらい（1マスずれても
//    それらしく見える）。メンバーの座標から正しく外接矩形が出ることを
//    数値で押さえる。
import {
    applyLayoutPreview,
    assignPanelToGroup,
    getGroups,
    groupOfPanel,
    groupRect,
    groupInset,
    groupTab,
    movePanelsBy,
    nextGroupId,
    removeGroup,
    reserveHeaderRows,
} from '../src/main/webapp/components/engine/groups.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const panels = [
    { id: 'p1', x: 0, y: 0, w: 4, h: 2, tab: 'ov' },
    { id: 'p2', x: 4, y: 0, w: 4, h: 2, tab: 'ov' },
    { id: 'p3', x: 0, y: 2, w: 8, h: 3, tab: 'ov' },
    { id: 'p4', x: 8, y: 0, w: 4, h: 5, tab: 'other' },
];

console.log('--- 外接矩形 ---');
const r = groupRect({ panels: ['p1', 'p2'] }, panels);
ok(r.x === 0 && r.y === 0 && r.w === 8 && r.h === 2, `横に並ぶ2枚 → x0 y0 w8 h2 (${JSON.stringify(r)})`);

const r2 = groupRect({ panels: ['p1', 'p2', 'p3'] }, panels);
ok(r2.x === 0 && r2.y === 0 && r2.w === 8 && r2.h === 5, `3枚（縦にも広がる）→ w8 h5 (${JSON.stringify(r2)})`);

const r3 = groupRect({ panels: ['p2'] }, panels);
ok(r3.x === 4 && r3.y === 0 && r3.w === 4 && r3.h === 2, '1枚だけでも矩形になる');

// 離れたパネルを囲うと、間の空白も含む大きな矩形になる（仕様）
const r4 = groupRect({ panels: ['p1', 'p4'] }, panels);
ok(r4.x === 0 && r4.w === 12, `離れた2枚は間を含めて囲う (w=${r4.w})`);

console.log('--- 異常系 ---');
ok(groupRect({ panels: [] }, panels) === null, 'メンバー0枚は null');
ok(groupRect({ panels: ['nope'] }, panels) === null, '存在しない ID だけなら null');
ok(groupRect({ panels: ['p1', 'nope'] }, panels).w === 4, '存在しない ID は無視して計算する');
ok(groupRect(null, panels) === null, 'group が null でも落ちない');
ok(groupRect({ panels: ['p1'] }, null) === null, 'panels が null でも落ちない');
// 壊れた座標（w/h が無い・文字列）でも矩形を作れること
ok(groupRect({ panels: ['x'] }, [{ id: 'x' }]) !== null, '座標が無いパネルでも既定値で矩形になる');
ok(groupRect({ panels: ['x'] }, [{ id: 'x', x: '2', y: '1', w: '3', h: '2' }]).w === 3, '文字列の座標も数値として扱う');

console.log('--- タブの決定 ---');
ok(groupTab({ panels: ['p1'] }, panels) === 'ov', '未指定ならメンバーのタブに従う');
ok(groupTab({ panels: ['p1'], tab: 'zzz' }, panels) === 'zzz', '明示指定が優先される');
ok(groupTab({ panels: ['nope'] }, panels) === undefined, 'メンバーが居なければ undefined');

console.log('--- 所属の逆引き・採番 ---');
const def = { groups: [{ id: 'g1', panels: ['p1', 'p2'] }, { id: 'g2', panels: ['p3'] }] };
ok(groupOfPanel(def, 'p2')?.id === 'g1', 'パネルから所属グループを引ける');
ok(groupOfPanel(def, 'p3')?.id === 'g2', '2つ目のグループも引ける');
ok(groupOfPanel(def, 'p4') === null, 'どこにも属していなければ null');
ok(groupOfPanel({}, 'p1') === null, 'groups が無くても落ちない');
ok(nextGroupId(def) === 'g3', '次の ID は g3');
ok(nextGroupId({}) === 'g1', 'groups が無ければ g1');
ok(getGroups({ groups: 'bad' }).length === 0, '配列でなければ空配列');

console.log('--- グループへの割り当て（インスペクタの操作）---');
const d2 = { groups: [{ id: 'g1', panels: ['p1', 'p2'] }, { id: 'g2', panels: ['p3'] }] };

// 別のグループへ移す＝元から外れて先に入る（1回の更新で両方）
const moved = assignPanelToGroup(d2, 'p1', 'g2');
ok(!moved[0].panels.includes('p1'), '移動元から外れる');
ok(moved[1].panels.includes('p1'), '移動先に入る');
// ⚠ 1枚が2つのグループに属すると枠が重なって読めなくなる
ok(moved.filter((g) => g.panels.includes('p1')).length === 1, '属するグループは常に1つだけ');

// どこにも入れない（グループから外す）
const removed = assignPanelToGroup(d2, 'p1', '');
ok(removed.every((g) => !g.panels.includes('p1')), '空 ID ならどこにも属さない');
ok(removed[0].panels.includes('p2'), '同じグループの他メンバーは残る');

// 既に入っているグループへ入れ直しても重複しない
const again = assignPanelToGroup(d2, 'p2', 'g1');
ok(again[0].panels.filter((x) => x === 'p2').length === 1, '同じ先へ入れ直しても重複しない');

// 未所属のパネルを入れる
const added = assignPanelToGroup(d2, 'p9', 'g1');
ok(added[0].panels.includes('p9'), '未所属のパネルを追加できる');
ok(assignPanelToGroup({}, 'p1', 'g1').length === 0, 'groups が無くても落ちない');

console.log('--- グループの削除 ---');
const del = removeGroup(d2, 'g1');
ok(del.length === 1 && del[0].id === 'g2', 'グループが1つ消える');
ok(removeGroup(d2, 'nope').length === 2, '存在しない ID なら何も消えない');
ok(removeGroup({}, 'g1').length === 0, 'groups が無くても落ちない');

console.log('--- グループごと移動（相対位置を保つ）---');
const at = (ps, id) => ps.find((p) => p.id === id);

// p1(0,0) p2(4,0) を右へ2・下へ1
const m1 = movePanelsBy(panels, ['p1', 'p2'], 2, 1, 12);
ok(at(m1, 'p1').x === 2 && at(m1, 'p1').y === 1, 'メンバーが平行移動する');
ok(at(m1, 'p2').x === 6 && at(m1, 'p2').y === 1, '2枚目も同じ量だけ動く');
ok(at(m1, 'p1').x - at(m1, 'p2').x === -4, '相対位置が保たれる');
ok(at(m1, 'p3').x === 0 && at(m1, 'p3').y === 2, 'メンバー以外は動かない');

// ⚠ 右端でのクランプ。p2 は右端(8)にいるので、右へ 10 動かそうとしても
//    グループ全体で 4 しか動けない（12 - 8）。**個別にクランプすると形が崩れる**
const m2 = movePanelsBy(panels, ['p1', 'p2'], 10, 0, 12);
ok(at(m2, 'p2').x === 8, `右端で止まる (p2.x=${at(m2, 'p2').x})`);
ok(at(m2, 'p1').x === 4, `一緒に止まって相対位置が保たれる (p1.x=${at(m2, 'p1').x})`);
ok(at(m2, 'p2').x - at(m2, 'p1').x === 4, '右端でも間隔が変わらない');

// 左端
const m3 = movePanelsBy(panels, ['p1', 'p2'], -5, 0, 12);
ok(at(m3, 'p1').x === 0 && at(m3, 'p2').x === 4, '左端で止まり相対位置が保たれる');
// 上端
const m4 = movePanelsBy(panels, ['p3'], 0, -5, 12);
ok(at(m4, 'p3').y === 0, '上端で止まる');
// 下は無制限（行は増やせる）
const m5 = movePanelsBy(panels, ['p1'], 0, 20, 12);
ok(at(m5, 'p1').y === 20, '下方向は制限しない');

console.log('--- 移動の異常系 ---');
ok(movePanelsBy(panels, [], 2, 2, 12) === panels, 'メンバー0なら同じ参照を返す');
ok(movePanelsBy(panels, ['p1'], 0, 0, 12) === panels, '移動量0なら同じ参照を返す');
ok(movePanelsBy(panels, ['nope'], 2, 2, 12) === panels, '存在しない ID なら何もしない');
ok(movePanelsBy(null, ['p1'], 1, 1, 12) === null, 'panels が null でも落ちない');
ok(movePanelsBy(panels, ['p1'], NaN, 1, 12) !== panels, 'NaN は 0 として扱い y だけ動く');
ok(at(movePanelsBy(panels, ['p1'], NaN, 1, 12), 'p1').y === 1, 'NaN の軸は動かさない');

console.log('--- 外へ広げる量（区画外のパネルに食い込まないこと）---');
// ⚠ **gap の内側を超えてはいけない**。パネルは元のサイズのまま動かないので、
//   区画が gap を超えて広がると隣・下の（区画外の）パネルに食い込む。
//   実測で下端の余白が 4px しか残らず、下のパネルのカギ括弧と重なっていた。
ok(groupInset(8, 12) === 5, `gap=12 なら上限5px（希望8でも丸める） (${groupInset(8, 12)})`);
ok(groupInset(2, 12) === 2, '希望値が上限より小さければそのまま');
ok(groupInset(24, 12) === 5, '大きな希望値でも gap の内側に収まる');
ok(groupInset(8, 40) === 8, 'gap が広ければ希望値が通る');
ok(groupInset(8, 2) === 0, 'gap が極小なら 0（広げない）');
ok(groupInset(8, 0) === 0, 'gap=0 なら広げない');
// 4辺すべて同じ規則＝構造的に重ならないことの担保
ok(groupInset(8, 12) * 2 < 12, '左右に広げても gap を食い尽くさない');
console.log('--- 外へ広げる量（異常系）---');
ok(groupInset(undefined, 12) === 5, '未指定は既定8として丸める');
ok(groupInset(NaN, 12) === 5, 'NaN でも落ちない');
ok(groupInset(-5, 12) === 0, '負の希望値は 0 にする');
ok(groupInset(8, undefined) === 5, 'gap 未指定は 12 とみなす');

console.log('--- 見出し行の確保（最上段以外でも領域を取る）---');
// ⚠ 最上段（y=0）はグリッド上部の余白を使うので行は要らない。
//   途中の行だけ、区画が始まる手前に1行挿し込む。
const gsTop = [{ id: 'g1', label: 'A', panels: ['p1'] }];       // p1 は y=0
const rTop = reserveHeaderRows(gsTop, panels);
ok(rTop.headerRows.size === 0, '最上段の区画は行を挿し込まない');
ok(rTop.rowOf(0) === 1, '最上段：行はずれない（grid は1始まり）');

const gsMid = [{ id: 'g2', label: 'B', panels: ['p3'] }];        // p3 は y=2
const rMid = reserveHeaderRows(gsMid, panels);
ok(rMid.headerRows.has(2), '途中の区画は開始行に見出し行を確保する');
ok(rMid.rowOf(0) === 1, '見出し行より上は 影響を受けない');
ok(rMid.rowOf(1) === 2, '見出し行の直前も 影響なし');
ok(rMid.rowOf(2) === 4, `区画の開始行は1つ下へずれる (${rMid.rowOf(2)})`);
ok(rMid.rowOf(3) === 5, '区画より下も同じだけずれる');

// 見出しが無い区画は行を取らない（枠だけ）
const gsNoLabel = [{ id: 'g3', label: '', panels: ['p3'] }];
ok(reserveHeaderRows(gsNoLabel, panels).headerRows.size === 0, '名前なしの区画は行を取らない');

// 複数の区画があるときは累積してずれる
const gsMulti = [
    { id: 'ga', label: 'A', panels: ['p3'] },   // y=2
    { id: 'gb', label: 'B', panels: ['p4'] },   // y=0 → 最上段なので対象外
];
const rMulti = reserveHeaderRows(gsMulti, panels);
ok(rMulti.headerRows.size === 1, '最上段のものは数に入らない');

console.log('--- 見出し行の確保（異常系）---');
ok(reserveHeaderRows(null, panels).headerRows.size === 0, 'groups が null でも落ちない');
ok(reserveHeaderRows([], null).headerRows.size === 0, 'panels が null でも落ちない');
ok(reserveHeaderRows([{ id: 'x', label: 'X', panels: ['nope'] }], panels).headerRows.size === 0,
   'メンバーが居ない区画は行を取らない');

console.log('--- ⭐ ドラッグ中のプレビュー（定義は書き換えない）---');
// ⚠ ドラッグ中の座標は「一時的な表示状態」。定義に書くと履歴が中間状態で埋まる。
//   ここで見た目だけ差し替え、離した時に1回だけ定義へ書く。
{
    const src = [
        { id: 'p1', x: 0, y: 0, w: 4, h: 3 },
        { id: 'p2', x: 4, y: 0, w: 4, h: 3 },
    ];
    // 1枚だけ差し替える形（パネルの移動・リサイズ）
    const one = applyLayoutPreview(src, { id: 'p1', patch: { x: 6, y: 2 } });
    ok(one[0].x === 6 && one[0].y === 2, 'パネル1枚の位置が差し替わる');
    ok(one[0].w === 4 && one[0].h === 3, '指定していない値はそのまま残る');
    ok(one[1].x === 4, '対象外のパネルは動かない');
    ok(src[0].x === 0, '⭐ 元の定義は書き換わらない（プレビューは非破壊）');

    // 複数をそれぞれ違う値で差し替える形（区画ごと移動）
    const many = applyLayoutPreview(src, {
        byId: { p1: { x: 1, y: 1 }, p2: { x: 5, y: 1 } },
    });
    ok(many[0].x === 1 && many[1].x === 5, '区画のメンバーがそれぞれの値で差し替わる');
    ok(many[0].y === 1 && many[1].y === 1, '相対位置が保たれる');

    // プレビューが無いときは**同じ参照**を返す（無駄な再描画を避ける）
    ok(applyLayoutPreview(src, null) === src, 'プレビュー無しなら同じ参照を返す');
    ok(applyLayoutPreview(src, {}) === src, '空のプレビューでも同じ参照');
    ok(applyLayoutPreview(src, { byId: {} }) === src, '空の byId でも同じ参照');
    ok(applyLayoutPreview(null, { id: 'p1', patch: { x: 1 } }).length === 0, 'panels が null でも落ちない');
    // 存在しない ID を指しても壊れない
    const miss = applyLayoutPreview(src, { id: 'nope', patch: { x: 9 } });
    ok(miss[0].x === 0 && miss[1].x === 4, '知らない ID なら何も変えない');
}

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
