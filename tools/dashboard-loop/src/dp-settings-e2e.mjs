// 編集 UI の設定変更 → 保存 → 永続化までの E2E。
// 1) ドロップダウン（配色プリセット）を変更  2) テキスト（タイトル）を変更
// 3) 保存  4) REST で定義を読み直して両方が入っているか確認
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
const readDef = async () => {
    const body = await restGet(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
    const eai = JSON.parse(body).entry[0].content['eai:data'];
    return JSON.parse(eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/)[1]);
};

const before = await readDef();
console.log(`before: preset=${before.style?.preset} title=${before.title}`);
const targetPreset = before.style?.preset === 'aurora' ? 'ネオン' : 'オーロラ';
const targetPresetId = targetPreset === 'ネオン' ? 'neon' : 'aurora';
const newTitle = `設定E2E ${new Date().getSeconds()}`;

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

// ドロップダウン変更
const presetLabel = before.style?.preset === 'aurora' ? 'オーロラ' : 'ネオン';
await page.locator('button.dpx-btn.dpx-input').filter({ hasText: presetLabel }).first().click();
await page.waitForTimeout(400);
await page.locator('div[style*="position: fixed"] button', { hasText: targetPreset }).first().click();
await page.waitForTimeout(600);

// テキスト変更（タイトル欄＝最初の input.dpx-input）
const titleInput = page.locator('input.dpx-input').first();
await titleInput.click();
await titleInput.fill(newTitle);
await page.waitForTimeout(400);

// 保存
const saveBtn = page.getByRole('button', { name: '保存' });
if (!(await saveBtn.isEnabled())) { console.error('NG: 保存ボタンが活性にならない'); process.exit(1); }
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15000 });
console.log('UI: 保存しました');
await browser.close();

const after = await readDef();
console.log(`after : preset=${after.style?.preset} title=${after.title}`);
const okPreset = after.style?.preset === targetPresetId;
const okTitle = after.title === newTitle;
console.log(okPreset ? '✓ ドロップダウンの変更が永続化' : `✗ プリセットが変わっていない (期待 ${targetPresetId})`);
console.log(okTitle ? '✓ テキストの変更が永続化' : `✗ タイトルが変わっていない (期待 ${newTitle})`);
if (!okPreset || !okTitle) process.exit(1);
