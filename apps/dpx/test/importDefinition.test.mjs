// JSON 取り込みの検証ロジックのテスト。
// 実行: node test/importDefinition.test.mjs
//
// ⚠ ここで押さえたい事故:
//   1. 壊れた JSON / 別プラットフォームの定義を取り込んで、
//      作成後に白紙のボードができる（エラーは作成前に出したい）
//   2. Dashboard Studio の定義は **同じ入れ物（<definition>）を使う**ので、
//      素通しすると「読めるが描けない」ボードが増える
//   3. 「取り込めません」だけ出して理由を言わない（手で直せない）
//
// 【2026-08-13】スキーマ v2 化。検証本体は dashboardSchema に移ったので、
// ここは **取り込み UI 向けの戻り値の形**（{definition} / {error}）を押さえる。
import { parseImportedDefinition } from '../src/main/webapp/components/schema/importDefinition.js';
import { SCHEMA_VERSION } from '../src/main/webapp/components/schema/vocab.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const VALID = {
    schemaVersion: SCHEMA_VERSION,
    title: 'テスト',
    panels: [{ id: 'p1', viz: 'dpx.line' }],
};

// ── 通るもの ────────────────────────────────────────────────
{
    const r = parseImportedDefinition(JSON.stringify(VALID));
    ok(!r.error, '正しい定義は通る');
    ok(r.definition?.title === 'テスト', '定義がそのまま返る');
    ok(r.definition?.panels.length === 1, 'パネルが保持される');
    // ⭐ v2 では取り込み時点で既定値が埋まる（コンポーネント側の ?? を不要にする）
    ok(r.definition?.layout?.grid?.columns === 12, '既定値（列数）が埋まる');
    ok(r.definition?.panels[0].w === 6, '既定値（パネル幅）が埋まる');
}
{
    // パネル0枚は「空のボード」であって不正ではない
    const r = parseImportedDefinition(JSON.stringify({ schemaVersion: SCHEMA_VERSION, panels: [] }));
    ok(!r.error, 'パネル0枚の定義も通る');
}
{
    // schemaVersion の省略は許す（現行版として扱う）
    const r = parseImportedDefinition(JSON.stringify({ panels: [] }));
    ok(!r.error, 'schemaVersion 省略は現行版として通る');
    ok(r.definition?.schemaVersion === SCHEMA_VERSION, '現行版が埋まる');
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
    // DPX v1 は**意図的に**受け付けない（2026-08-13「これは移行ではない」）。
    // ⚠ ただし「v1 である」と名指しで伝える（黙って「形式違い」にしない）
    const r = parseImportedDefinition(JSON.stringify({ version: 1, panels: [], title: '旧' }));
    ok(Boolean(r.error), 'DPX v1 の定義は落ちる');
    ok(/v1/.test(r.error), 'v1 だと名指しで伝える');
}
{
    const r = parseImportedDefinition(
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, panels: [{ id: 'p1' }] })
    );
    ok(Boolean(r.error), 'viz が無いパネルは落ちる');
    ok(/panels\.0\.viz/.test(r.error ?? ''), 'どのパネルの何が悪いか場所つきで言う');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
