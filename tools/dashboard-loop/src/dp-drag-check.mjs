// DPX ドラッグ移動→保存→永続化の E2E 検証。
// パネルのタイトルバーを右へ2セル分ドラッグし、保存して REST で x の変化を確認する。
// 使い方: node src/dp-drag-check.mjs <app> <view> <パネルタイトル> <パネルid>
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view, panelTitle, panelId] = process.argv;
assertConfig();

const restGet = (url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false,
        headers: { Authorization: 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64') } },
        (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }).on('error', reject);
});

const getPanel = async () => {
    const body = await restGet(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
    const eai = JSON.parse(body).entry[0].content['eai:data'];
    const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
    const def = JSON.parse(m[1]);
    return def.panels.find((p) => p.id === panelId);
};

const before = await getPanel();
console.log(`before: x=${before.x} y=${before.y}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/${app}/${view}?mode=edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

const header = page.getByText(panelTitle, { exact: true }).first();
const box = await header.boundingBox();
if (!box) { console.error('NG: パネルが見つかりません'); process.exit(1); }
// キャンバス幅からセル幅を概算して 2 セル分右へドラッグ
const cell = (1600 - 1280 - 48) > 0 ? 104 : Math.round((1250 - 11 * 12) / 12);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + cell * 2 + 24, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);

const saveBtn = page.getByRole('button', { name: '保存' });
if (!(await saveBtn.isEnabled())) { console.error('NG: 保存が活性化しません'); await page.screenshot({path:'/tmp/dp-drag-fail.png'}); process.exit(1); }
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15000 });
console.log('UI: 保存しました');
await browser.close();

const after = await getPanel();
console.log(`after: x=${after.x} y=${after.y}`);
if (after.x !== before.x) console.log(`OK: ドラッグ移動が永続化された (x: ${before.x} → ${after.x})`);
else { console.error('NG: x が変化していない'); process.exit(1); }
