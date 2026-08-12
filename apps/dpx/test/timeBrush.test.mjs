// 時間ブラシ（クロスパネル）の単体テスト。
// 実行: node test/timeBrush.test.mjs
//
// ⚠ ブラシは「選んだ区間 → earliest/latest 文字列」への変換なので、
//    **1バケットずれても画面上は同じに見える**。目視で検証できないため、
//    境界（右端バケット・タイムゾーン・時刻軸でない列）を数値で押さえる。
import {
    axisTimes,
    formatSpan,
    parseAxisTime,
    rangeFromIndices,
    resolveBrushToken,
    toSplunkTime,
} from '../src/main/webapp/components/engine/timeBrush.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

console.log('--- 時刻として読めるか（誤検出しないこと）---');
ok(parseAxisTime('2026-08-12T15:00:00') instanceof Date, 'ISO 文字列は読める');
ok(parseAxisTime('2026-08-12 15:00:00') instanceof Date, '空白区切りも読める');
ok(parseAxisTime('1754985600') instanceof Date, 'epoch 秒は読める');
ok(parseAxisTime('1754985600000') instanceof Date, 'epoch ミリ秒は読める');
// ⚠ ここが最重要。new Date('srv-web-01') は 2001年として通ってしまう
ok(parseAxisTime('srv-web-01') === null, 'ホスト名は時刻として読まない');
ok(parseAxisTime('web') === null, '任意の文字列は読まない');
ok(parseAxisTime('') === null, '空文字は読まない');
ok(parseAxisTime(null) === null, 'null は読まない');

console.log('--- 軸全体の判定 ---');
ok(axisTimes(['2026-08-12T00:00:00', '2026-08-12T01:00:00']) !== null, '全部時刻なら時刻軸');
ok(axisTimes(['2026-08-12T00:00:00', 'srv-01']) === null, '1つでも読めなければ時刻軸ではない');
ok(axisTimes(['srv-01', 'srv-02', 'srv-03']) === null, 'ホスト名の軸は時刻軸ではない');
ok(axisTimes(['2026-08-12T00:00:00']) === null, '1点だけでは範囲を作れない');
ok(axisTimes([]) === null, '空配列は時刻軸ではない');

console.log('--- Splunk 時刻文字列（タイムゾーンを動かさないこと）---');
// ⚠ toISOString() を使うと UTC になり JST では9時間ずれる。
//    ローカルの年月日時分秒がそのまま出ることを確認する。
const d = new Date(2026, 7, 12, 15, 4, 5); // 2026-08-12 15:04:05 ローカル
ok(toSplunkTime(d) === '2026-08-12T15:04:05', `ローカル時刻がそのまま出る (${toSplunkTime(d)})`);
ok(toSplunkTime(new Date(2026, 0, 1, 0, 0, 0)) === '2026-01-01T00:00:00', '月日は 0 埋めされる');
ok(toSplunkTime(new Date('bad')) === null, '不正な Date は null');
ok(toSplunkTime('2026-08-12') === null, 'Date 以外は null');

console.log('--- 選択範囲（右端バケットを落とさないこと）---');
const hourly = [
    '2026-08-12T00:00:00',
    '2026-08-12T01:00:00',
    '2026-08-12T02:00:00',
    '2026-08-12T03:00:00',
];
const times = axisTimes(hourly);
const r1 = rangeFromIndices(times, 1, 2);
ok(r1.earliest === '2026-08-12T01:00:00', `始点はそのバケットの開始 (${r1.earliest})`);
// ⚠ ここを times[hi] にすると 02:00 になり、選んだ 02:00 台のバケットが丸ごと漏れる
ok(r1.latest === '2026-08-12T03:00:00', `終点は次バケットの開始まで含む (${r1.latest})`);

const r2 = rangeFromIndices(times, 0, 3);
ok(r2.earliest === '2026-08-12T00:00:00', '全選択の始点');
// 最終バケットには「次」が無いので、直前の間隔（1時間）を足して補う
ok(r2.latest === '2026-08-12T04:00:00', `最終バケットは間隔ぶん延長する (${r2.latest})`);

const r3 = rangeFromIndices(times, 2, 1);
ok(r3.earliest === r1.earliest && r3.latest === r1.latest, '始点と終点が逆でも同じ範囲');

const r4 = rangeFromIndices(times, 1, 1);
ok(r4.earliest === '2026-08-12T01:00:00' && r4.latest === '2026-08-12T02:00:00', '1バケットだけの選択も範囲になる');

console.log('--- 選択範囲（異常系）---');
ok(rangeFromIndices(times, -5, 99) !== null, '範囲外のインデックスは丸める');
ok(rangeFromIndices(times, -5, 99).earliest === '2026-08-12T00:00:00', '丸めた結果が全範囲');
ok(rangeFromIndices(null, 0, 1) === null, 'times が無ければ null');
ok(rangeFromIndices([], 0, 1) === null, '空配列は null');
ok(rangeFromIndices(times, NaN, 2) !== null, 'NaN は丸められて範囲になる');

console.log('--- 期間の表示 ---');
ok(formatSpan(new Date(2026, 7, 12, 0, 0, 0), new Date(2026, 7, 12, 0, 0, 30)) === '30秒', '秒');
ok(formatSpan(new Date(2026, 7, 12, 0, 0, 0), new Date(2026, 7, 12, 0, 12, 0)) === '12分', '分');
ok(formatSpan(new Date(2026, 7, 12, 0, 0, 0), new Date(2026, 7, 12, 3, 30, 0)) === '3.5時間', '時間（小数1桁）');
ok(formatSpan(new Date(2026, 7, 12), new Date(2026, 7, 14)) === '2.0日', '日');
ok(formatSpan(null, null) === '', '不正な入力は空文字');

console.log('--- 書き込み先トークンの決定 ---');
const inputs = [
    { type: 'dropdown', token: 'host' },
    { type: 'timerange', token: 'time' },
    { type: 'timerange', token: 'time2' },
];
ok(resolveBrushToken(inputs) === 'time', '未指定なら最初の時間範囲入力');
ok(resolveBrushToken(inputs, 'time2') === 'time2', '指定があればそれを使う');
// ⚠ 指定が見つからないときに先頭へ落とすと、別の入力を黙って書き換える事故になる
ok(resolveBrushToken(inputs, 'nope') === null, '指定が見つからなければ null（勝手に別の入力を書かない）');
ok(resolveBrushToken([{ type: 'dropdown', token: 'host' }]) === null, '時間範囲入力が無ければ null');
ok(resolveBrushToken([]) === null, '入力が無ければ null');
ok(resolveBrushToken(null) === null, 'null でも落ちない');

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
