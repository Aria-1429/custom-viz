// 区画（グループ）の質感テスト。
// 実行: node test/groupSurface.test.mjs
//
// ⚠ 区画の質感は **`panelSurface()` を流用**している（実装を2つ持たないため）。
//   流用では「線を持たない質感に線が生えていないか」が最重要。
//   `panelSurface` は「線なし」を **`border: 'none'`（truthy な文字列）** で表すので、
//   素朴に `if (s.border) s.border = ...` と書くと
//   **コーナーフレームに全周の枠が生え、枠なしにも枠が付く**（実際に発生させた）。
//   見た目では気づきにくいので数値（文字列）で押さえる。
import { PANEL_VARIANTS, groupSurface, panelSurface, resolveTheme } from '../src/main/webapp/components/engine/themes.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const t = resolveTheme({ style: { preset: 'midnight' } });
const light = resolveTheme({ style: { preset: 'paper' } });

console.log('--- パネルの質感をそのまま流用している ---');
// 色指定が無ければ **panelSurface と完全一致**（＝実装が1つであることの担保）
for (const v of ['card', 'glass', 'inset', 'elevated', 'blueprint', 'eink']) {
    const g = JSON.stringify(groupSurface(t, v));
    const p = JSON.stringify(panelSurface(t, v, 22));
    ok(g === p, `${v}: 色未指定ならパネルと同一の質感`);
}
ok(
    PANEL_VARIANTS.length >= 20,
    `質感の一覧が共有されている（${PANEL_VARIANTS.length} 種）`
);
// 一覧の値がすべて何らかの質感を返すこと（UI に出るのに描けない値が無いか）
ok(
    PANEL_VARIANTS.every((v) => groupSurface(t, v.value) && typeof groupSurface(t, v.value) === 'object'),
    '一覧の全質感が区画でも解決できる'
);

console.log('--- 色を指定しても質感の構造を壊さない（最重要）---');
const C = '#ff0000';
// コーナーフレームは「全周の枠なし＋四隅の線」。全周の border を生やしてはいけない
const noc = groupSurface(t, 'noc', C);
ok(noc.border === 'none', 'noc: 全周の枠は付けない（border:none のまま）');
ok(String(noc.backgroundImage).includes(C), 'noc: カギ括弧は指定色で引き直す');

// 枠なしは何を指定しても枠を持たない
const fl = groupSurface(t, 'frameless', C);
ok(fl.border === 'none', 'frameless: 色を指定しても枠は生えない');

// 片側だけの線を持つ質感は、その線だけが色替えされる
const ul = groupSurface(t, 'underline', C);
ok(ul.border === 'none', 'underline: 全周の枠は付かない');
ok(ul.borderTop === `2px solid ${C}`, `underline: 上線だけ色が変わる（幅2pxを維持）(${ul.borderTop})`);

const sa = groupSurface(t, 'sideAccent', C);
ok(sa.borderLeft === `3px solid ${C}`, `sideAccent: 左線の幅3pxを維持したまま色替え (${sa.borderLeft})`);

// 全周の枠を持つ質感は色替えされる
ok(groupSurface(t, 'outline', C).border === `1px solid ${C}`, 'outline: 枠線が色替えされる');
ok(groupSurface(t, 'card', C).border === `1px solid ${C}`, 'card: 枠線が色替えされる');

console.log('--- 区画固有の質感（rule）---');
const rule = groupSurface(t, 'rule');
ok(String(rule.borderTop).startsWith('1px solid'), 'rule: 上辺の罫がある');
ok(String(rule.backgroundImage).includes('linear-gradient'), 'rule: 下辺の返しがある');
ok(groupSurface(t, undefined).borderTop === rule.borderTop, '未指定なら rule（既定）');
ok(groupSurface(t, 'rule', C).borderTop === `1px solid ${C}`, 'rule: 色を指定できる');

console.log('--- テーマ追随（決め打ち色が無いこと）---');
// ライト系で暗色が固定されていないこと（paper で見えなくなる事故の防止）
const cardDark = JSON.stringify(groupSurface(t, 'card'));
const cardLight = JSON.stringify(groupSurface(light, 'card'));
ok(cardDark !== cardLight, 'card: ライト系とダーク系で見た目が変わる（テーマ追随）');

console.log('--- 異常系 ---');
ok(typeof groupSurface(t, 'nope') === 'object', '未知の質感でも落ちない');
ok(typeof groupSurface(t, '') === 'object', '空文字でも落ちない');
ok(typeof groupSurface(t, null) === 'object', 'null でも落ちない');

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
