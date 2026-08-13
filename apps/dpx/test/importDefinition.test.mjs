// JSON 取り込みの検証ロジックのテスト。
// 実行: node test/importDefinition.test.mjs
//
// ⚠ ここで押さえたい事故:
//   1. 壊れた JSON / 別プラットフォームの定義を取り込んで、
//      作成後に白紙のボードができる（エラーは作成前に出したい）
//   2. Dashboard Studio の定義は **同じ入れ物（<definition>）を使う**ので、
//      素通しすると「読めるが描けない」ボードが増える
//   3. 「取り込めません」だけ出して理由を言わない（手で直せない）
import { parseImportedDefinition } from '../src/main/webapp/components/engine/importDefinition.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const VALID = { version: 1, title: 'テスト', panels: [{ id: 'p1', viz: 'dpx.line' }] };

// ── 通るもの ────────────────────────────────────────────────
{
    const r = parseImportedDefinition(JSON.stringify(VALID));
    ok(!r.error, '正しい定義は通る');
    ok(r.definition?.title === 'テスト', '定義がそのまま返る');
    ok(r.definition?.panels.length === 1, 'パネルが保持される');
}
{
    // パネル0枚は「空のボード」であって不正ではない
    const r = parseImportedDefinition(JSON.stringify({ version: 1, panels: [] }));
    ok(!r.error, 'パネル0枚の定義も通る');
}

// ── 落とすもの（理由つき）──────────────────────────────────
{
    const r = parseImportedDefinition('{ これは JSON ではない');
    ok(Boolean(r.error), '壊れた JSON は落ちる');
    ok(!r.definition, '落ちたときは definition を返さない');
    ok(/JSON として読めません/.test(r.error), '理由が「JSON として読めない」と分かる');
}
{
    const r = parseImportedDefinition('[]');
    ok(/オブジェクトではありません/.test(r.error ?? ''), '配列は落ちる（理由つき）');
}
{
    const r = parseImportedDefinition('null');
    ok(Boolean(r.error), 'null は落ちる');
}
{
    // version が文字列 "1.1" ＝ Studio の形。素通ししてはいけない
    const studio = JSON.stringify({
        version: '1.1',
        visualizations: { viz_1: { type: 'splunk.line' } },
        layout: { globalInputs: [] },
        dataSources: {},
    });
    const r = parseImportedDefinition(studio);
    ok(Boolean(r.error), 'Dashboard Studio の定義は落ちる');
    ok(/Dashboard Studio/.test(r.error), 'Studio の定義だと名指しで伝える');
}
{
    const r = parseImportedDefinition(JSON.stringify({ version: 1, title: 'x' }));
    ok(/panels/.test(r.error ?? ''), 'panels が無い定義は落ち、何が必要か言う');
}
{
    const r = parseImportedDefinition(JSON.stringify({ panels: [] }));
    ok(Boolean(r.error), 'version が無い定義は落ちる');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
