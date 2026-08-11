// 入力の並べ替え E2E: インスペクタで2番目の入力を上へ移動→保存→REST 検証
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view] = process.argv;
assertConfig();
const restGet = (url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false,
        headers: { Authorization: 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64') } },
        (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }).on('error', reject);
});
const readInputs = async () => {
    const body = await restGet(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
    const eai = JSON.parse(body).entry[0].content['eai:data'];
    return JSON.parse(eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/)[1]).inputs ?? [];
};
const before = await readInputs();
console.log('before:', before.map((x) => x.token).join(' , '));

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}).catch(()=>{}), page.locator('input[name="password"]').first().press('Enter')]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/${app}/${view}?mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);

// 「入力（トークン）」セクションを開く
// ⚠ セクションは開いていることがある。クリックでトグルすると閉じてしまうので、
//    「並べ替えボタンが見えているか」で判定してから必要な時だけ開く。
const upSel = 'button[title="左（上）へ"]';
if ((await page.locator(upSel).count()) === 0) {
    await page.locator('button', { hasText: '入力（トークン）' }).first().click();
    await page.waitForTimeout(700);
}
// 2番目の入力カードの「↑」を押す（title="左（上）へ"）
const upBtns = page.locator('button[title="左（上）へ"]');
console.log('並べ替えボタン数:', await upBtns.count());
await upBtns.nth(1).click();
await page.waitForTimeout(600);

const saveBtn = page.getByRole('button', { name: '保存' });
if (!(await saveBtn.isEnabled())) { console.error('NG: 保存が活性にならない'); process.exit(1); }
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15000 });
await browser.close();

const after = await readInputs();
console.log('after :', after.map((x) => x.token).join(' , '));
const swapped = before.length >= 2 && after[0].token === before[1].token && after[1].token === before[0].token;
console.log(swapped ? '✓ 入力の並べ替えが永続化' : '✗ 並べ替えが反映されていない');
if (!swapped) process.exit(1);
