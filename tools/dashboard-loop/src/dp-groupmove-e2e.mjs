// ⭐ **区画ごと移動**の E2E（グループが「飾り」でなく機能単位であることの検証）。
//   node src/dp-groupmove-e2e.mjs <app> <view> <groupId>
//
// 区画名をドラッグして、**メンバーのパネル全員が相対位置を保ったまま動く**ことを
// 定義（REST）で確かめる。枠の見た目だけを見ても分からないので、
// **パネルの座標そのもの**を前後で比較する。
//
// ⚠ 「枠が動いた」は検証にならない。枠はメンバーの外接矩形なので、
//   パネルが動かなければ枠も動かない＝**パネルの座標を見るのが本質**。
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view, groupId = 'g1'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-groupmove-e2e.mjs <app> <view> [groupId]');
    process.exit(1);
}
assertConfig();

const OUT = process.env.DPX_SHOT_DIR || '/tmp';
let ng = 0;
const ok = (c, m) => {
    console.log(c ? `✓ ${m}` : `✗ ${m}`);
    if (!c) ng++;
};

function restGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https
            .get(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname + u.search,
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: `Basic ${Buffer.from(`${config.user}:${config.pass}`).toString('base64')}`,
                    },
                },
                (r) => {
                    let b = '';
                    r.on('data', (c) => (b += c));
                    r.on('end', () => resolve({ status: r.statusCode, body: b }));
                }
            )
            .on('error', reject);
    });
}

async function readDef() {
    const res = await restGet(
        `${mgmtBase()}/servicesNS/-/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(view)}?output_mode=json`
    );
    const eai = JSON.parse(res.body).entry[0].content['eai:data'];
    const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
    return m ? JSON.parse(m[1]) : null;
}

/** 区画のメンバーの座標を {id: "x,y"} で返す。 */
function memberPos(def, gid) {
    const g = (def.groups ?? []).find((x) => x.id === gid);
    const ids = new Set((g?.panels ?? []).map(String));
    const out = {};
    for (const p of def.panels ?? []) {
        if (ids.has(String(p.id))) out[p.id] = `${p.x},${p.y}`;
    }
    return out;
}

const before = await readDef();
const posBefore = memberPos(before, groupId);
console.log('移動前のメンバー座標:', JSON.stringify(posBefore));
if (Object.keys(posBefore).length === 0) {
    console.error(`NG: 区画 ${groupId} にメンバーが居ません`);
    process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
const pass = page.locator('input[name="password"]').first();
await pass.fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    pass.press('Enter'),
]);

await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);

// 区画の見出し（ヘッダ帯）を掴む
const frame = page.locator(`[data-group-id="${groupId}"]`).first();
ok((await frame.count()) > 0, `区画 ${groupId} の枠がある`);
const handle = frame.locator('div').first();
const hb = await handle.boundingBox();
if (!hb) {
    console.error('NG: 区画の見出しの矩形が取れません');
    await browser.close();
    process.exit(1);
}

await page.screenshot({ path: `${OUT}/dp-groupmove-1-before.png` });

// 下へ1行ドラッグ（rowHeight 72 + gap 12 = 84px）
const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
const to = { x: from.x, y: from.y + 84 };
console.log(`ドラッグ: (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)})`);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x, from.y + 40, { steps: 6 });
await page.mouse.move(to.x, to.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/dp-groupmove-2-after.png` });

// 保存
const saveBtn = page.getByRole('button', { name: '保存' }).first();
const enabled = await saveBtn.isEnabled().catch(() => false);
ok(enabled, 'ドラッグで定義が変わった（保存ボタンが活性）');
if (enabled) {
    await saveBtn.click();
    await page.getByText('保存しました').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
}
await browser.close();

const after = await readDef();
const posAfter = memberPos(after, groupId);
console.log('移動後のメンバー座標:', JSON.stringify(posAfter));

// ★ 全メンバーが同じ量だけ動いたか（＝相対位置が保たれたか）
const deltas = Object.keys(posBefore).map((id) => {
    const [bx, by] = posBefore[id].split(',').map(Number);
    const [ax, ay] = (posAfter[id] ?? '').split(',').map(Number);
    return `${ax - bx},${ay - by}`;
});
console.log('各メンバーの移動量:', JSON.stringify(deltas));
ok(deltas.length > 1, 'メンバーが2枚以上ある（相対位置の検証になる）');
ok(deltas.every((d) => d === deltas[0]), '★ 全メンバーが同じ量だけ動いた（相対位置が保たれた）');
ok(deltas[0] !== '0,0', '★ 実際に移動した');

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
