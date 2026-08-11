// パネル時間範囲の「入力から受け取る」E2E。
// パネルを選び、決め方を「入力から受け取る」に切り替え、保存して
// earliest が $<token>.earliest$ になっているか REST で確認する。
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
const readPanel = async () => {
    const body = await restGet(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
    const eai = JSON.parse(body).entry[0].content['eai:data'];
    const def = JSON.parse(eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/)[1]);
    return def.panels.find((p) => p.id === panelId);
};
console.log('before earliest:', (await readPanel()).search?.earliest);

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
await page.getByText(panelTitle, { exact: true }).first().click();
await page.waitForTimeout(800);

// 「時間範囲の決め方」のドロップダウン
await page.locator('button.dpx-btn.dpx-input').filter({ hasText: 'このパネルで指定する' }).first().click();
await page.waitForTimeout(400);
await page.locator('div[style*="position: fixed"] button', { hasText: '入力から受け取る' }).first().click();
await page.waitForTimeout(800);

const saveBtn = page.getByRole('button', { name: '保存' });
if (!(await saveBtn.isEnabled())) { console.error('NG: 保存が活性にならない'); process.exit(1); }
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15000 });
await browser.close();

const after = await readPanel();
console.log('after  earliest:', after.search?.earliest, '/ latest:', after.search?.latest);
console.log(/^\$[A-Za-z0-9_.]+\.earliest\$$/.test(after.search?.earliest ?? '') ? '✓ 入力トークンに束縛された' : '✗ 束縛されていない');
