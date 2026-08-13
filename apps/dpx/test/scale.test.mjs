// 目盛り計算の単体テスト。
// 実行: node test/scale.test.mjs
// ⚠ 「軸が読みやすいか」は目視では判定しづらいので、刻みが
//    1/2/2.5/5×10^n に丸まっていることを数値で押さえる。
//    また **0 件・全部 0・NaN で無限ループしないこと**を必ず見る
//    （for ループで step を足していく実装なので、step=0 だと固まる）。
import { formatAxisLabels, niceScale, niceTicks } from '../src/main/webapp/components/viz/scale.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

console.log('--- 異常系（固まらないこと）---');
ok(JSON.stringify(niceTicks(0)) === '[0]', 'max=0 は [0]');
ok(JSON.stringify(niceTicks(-5)) === '[0]', '負数は [0]');
ok(JSON.stringify(niceTicks(NaN)) === '[0]', 'NaN は [0]');
ok(JSON.stringify(niceTicks(Infinity)) === '[0]', 'Infinity は [0]');
ok(niceTicks(100, 0).length > 1, 'count=0 でも既定に落ちて目盛りが出る');

console.log('--- 刻みが切りのいい数か ---');
const stepOf = (t) => t[1] - t[0];
ok(stepOf(niceTicks(1000, 4)) === 250, 'max=1000 → 250 刻み');
ok(stepOf(niceTicks(100, 4)) === 25, 'max=100 → 25 刻み');
ok(stepOf(niceTicks(1, 4)) === 0.25, 'max=1 → 0.25 刻み');
// 173.4 のような半端な刻みにならないこと
const t = niceTicks(867, 5);
ok(Number.isInteger(stepOf(t)), 'max=867 の刻みは整数（173.4 のような値にしない）');
ok(t[0] === 0, '先頭は必ず 0');

console.log('--- 最大値を覆っているか ---');
for (const m of [3, 7, 42, 99, 1234, 98765, 0.03]) {
    const ticks = niceTicks(m, 4);
    // 最後の目盛りが max を下回ると、バーが軸をはみ出して見える
    ok(ticks[ticks.length - 1] >= m * 0.999, `max=${m} を目盛りが覆う（最終=${ticks[ticks.length - 1]}）`);
    ok(ticks.length <= 12, `max=${m} の目盛りが多すぎない（${ticks.length}本）`);
}

console.log('--- niceScale（min〜max。折れ線用）---');
{
    const s = niceScale(0, 100, 4);
    ok(s.min === 0 && s.max === 100, '0〜100 → 0〜100');
    const neg = niceScale(-30, 70, 4);
    ok(neg.min <= -30 && neg.max >= 70, '負を含む範囲を覆う');
    ok(neg.ticks.includes(0), '負を含むと 0 が目盛りに入る');
    // 0 から遠い範囲（niceTicks では潰れてしまうケース）
    const far = niceScale(980, 1020, 4);
    ok(far.min >= 900 && far.max <= 1100, '980〜1020 は 0 まで戻らない（' + far.min + '〜' + far.max + '）');
    // 全点同値（ゼロ幅）
    const flat = niceScale(50, 50, 4);
    ok(flat.max > flat.min, '全点同値でも軸の幅が 0 にならない');
    ok(niceScale(NaN, NaN).ticks.length === 2, 'NaN でも落ちない');
    ok(niceScale(100, 0).min === 0, 'min>max を入れ替えて扱う');
    for (const [a, b] of [[0, 1e6], [-1e6, 1e6], [0.001, 0.009], [-5, -1]]) {
        const r = niceScale(a, b, 4);
        ok(r.ticks.length >= 2 && r.ticks.length <= 20, `範囲 ${a}〜${b} の目盛り数が妥当（${r.ticks.length}本）`);
        ok(r.min <= a && r.max >= b, `範囲 ${a}〜${b} を覆う`);
    }
}

console.log('--- formatAxisLabels（X軸ラベル）---');
{
    // ⚠ これが実機で起きた不具合：ISO を切り詰めて全部同じ文字列になった
    // ⚠ タイムゾーン非依存にするため、日付境界のテストは**ローカル時刻表記**で書く
    //    （`+09:00` 付きで書くと実行環境の TZ 次第で日付がずれ、テストが嘘をつく）
    const iso = ['2026-08-11T15:00:00', '2026-08-11T18:00:00', '2026-08-12T03:00:00'];
    const f = formatAxisLabels(iso);
    ok(new Set(f.map((x) => x.main)).size === 3, '時刻が違えばラベルも全部違う（切り詰め問題の再発防止）');
    ok(!f.some((x) => x.main.includes('…')), '時刻軸では「…」で切り詰めない');
    ok(f[2].sub !== '', '日付が変わる位置には日付が入る');
    ok(f[1].sub === '', '同じ日なら日付は入らない');
    // epoch 秒
    const ep = formatAxisLabels(['1786000000', '1786003600']);
    ok(new Set(ep.map((x) => x.main)).size === 2, 'epoch 秒も時刻として扱える');
    // 文字列軸（ホスト名など）は先頭を残す
    const hosts = formatAxisLabels(['srv-web-01', 'srv-web-02']);
    ok(hosts[0].main.startsWith('srv'), '文字列軸は先頭を残す');
    ok(formatAxisLabels([]).length === 0, '空配列で落ちない');
    ok(formatAxisLabels(null).length === 0, 'null で落ちない');
    // 長い期間は日付主体
    const months = formatAxisLabels(['2026-01-01T00:00:00', '2026-06-01T00:00:00']);
    ok(months.every((x) => /\d+\/\d+/.test(x.main)), '長期間は月日で出す');
}

console.log(ng === 0 ? '\n✓ 全て成功' : `\n✗ ${ng} 件失敗`);
process.exit(ng ? 1 : 0);
