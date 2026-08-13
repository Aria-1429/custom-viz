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
// ⚠ **現在値と必ず違うものを選ぶ**（同じものを選ぶと dirty にならず検証にならない）。
//   どのプリセットから始めても成立するよう、現在値を見て切り替え先を決める。
const targetPresetId = before.style?.preset === 'aurora' ? 'neon' : 'aurora';
const targetLabel = targetPresetId === 'neon' ? 'ネオン' : 'オーロラ';
const newTitle = `設定E2E ${new Date().getSeconds()}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}).catch(()=>{}), page.locator('input[name="password"]').first().press('Enter')]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);

// ── 配色プリセットのドロップダウンを変更 ────────────────────────
// ⚠ **現在の表示名を決め打ちしない。** 旧実装は `aurora ? 'オーロラ' : 'ネオン'`
//   と 2 択に決め打ちしていたため、**それ以外のプリセット（midnight 等）の
//   ボードでは要素が見つからず 30 秒タイムアウト**していた（2026-08-13 判明）。
//   「デザイン」セクションの最初のドロップダウンを位置で掴む。
// ⚠ **位置（.first()）で掴まない。** インスペクタには 7 個のドロップダウンがあり、
//   先頭は「見出し行」。**現在のプリセット表示名で引く**のが安定する。
const PRESET_LABELS = { midnight: 'ミッドナイト', neon: 'ネオン', aurora: 'オーロラ',
    carbon: 'カーボン', slate: 'スレート', amber: 'アンバー', matrix: 'マトリックス',
    light: 'ライト', paper: 'ペーパー' };
const beforeLabel = PRESET_LABELS[before.style?.preset] ?? 'ミッドナイト';
const presetBtn = page.locator('button.dpx-btn.dpx-input').filter({ hasText: beforeLabel }).first();
await presetBtn.scrollIntoViewIfNeeded();
await presetBtn.click();
await page.waitForTimeout(400);
// ⚠ ポップアップは createPortal で body 直下に出る（position:fixed）。
//   ⚠ **`hasText` の部分一致だと「オーロラ」が別項目にも当たりうる**ので完全一致で引く。
const opt = page.locator('div[style*="position: fixed"] button')
    .filter({ hasText: new RegExp(`^${targetLabel}$`) })
    .first();
await opt.click();
await page.waitForTimeout(600);
console.log(`プリセット: ${beforeLabel} → ${targetLabel}`);

// ── タイトル変更 ───────────────────────────────────────────────
// ⚠ **DPX の TextInput は blur / Enter で確定する**（打鍵では反映されない）。
//   `fill()` だけだと保存ボタンが活性にならず「実装のバグ」に見える。
//   さらに `fill('')` は**クリアボタンを押してしまう**ので Control+a で上書きする。
// ⚠ **位置で選ばない**（`.first()` も `.last()` も、パネル構成や
//   入力の有無で別の欄を掴む）。**ラベルの隣**という関係で特定する。
// ⚠ **位置（first / last）で選ばない。** キャンバスに入力があると
//   そちらが最初の `.dpx-input` になり、しかも**ドラッグ用オーバーレイが
//   クリックを遮る**（実機で TimeoutError と「別の欄を編集」の両方を踏んだ）。
//   → **現在のタイトル値を持つ欄**で特定する（インスペクタの「タイトル」欄）。
const titleInput = page.locator(`input.dpx-input[value="${before.title}"]`).first();
await titleInput.click();
await page.keyboard.press('Control+a');
await titleInput.type(newTitle);
await page.keyboard.press('Tab');
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
