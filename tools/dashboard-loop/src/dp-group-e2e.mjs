// 区画（グループ）の編集 UI の E2E。
//   node src/dp-group-e2e.mjs <app> <view>
//
// **区画はパネル・入力と並ぶ第3の選択対象**（2026-08-12 ユーザー指定）。
// 「ツールバーで追加 → キャンバスで選択 → 右ペインで設定 → 保存」までを実機で通す。
//
// ⚠ 検証の観点:
//   - 追加した区画が**キャンバスに枠として出る**（選択中パネルを種にする）
//   - **見出しをクリックすると右ペインが区画の設定に変わる**
//   - パネル側の「所属する区画」で入れ替えができる
//   - 保存後、REST で読んだ定義に groups が入っている
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view] = process.argv;
if (!app || !view) {
    console.error('usage: dp-group-e2e.mjs <app> <view>');
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

async function readGroups() {
    const res = await restGet(
        `${mgmtBase()}/servicesNS/-/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(view)}?output_mode=json`
    );
    const eai = JSON.parse(res.body).entry[0].content['eai:data'];
    const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
    return m ? (JSON.parse(m[1]).groups ?? []) : [];
}

const before = await readGroups();
console.log(`編集前の区画数: ${before.length}`);

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

// 編集モードで開く
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);

// ── 1. 既存の区画の見出しをクリックして選択できるか ─────────────
const firstGroup = page.locator('[data-group-id]').first();
ok((await firstGroup.count()) > 0, 'キャンバスに区画の枠がある');

const label = firstGroup.locator('div').first();
await label.click({ force: true });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/dp-group-1-selected.png` });

const paneText = (await page.locator('body').innerText().catch(() => '')) ?? '';
ok(/区画：/.test(paneText), '見出しクリックで右ペインが「区画：…」に変わる');
ok(/枠の質感/.test(paneText), '区画の設定（枠の質感）が出ている');

// ── 2. 区画名を変えられるか ───────────────────────────────────
// ⚠ **DPX の TextInput は `type` 属性を持たない**（`.dpx-input` クラス）。
//    `input[type="text"]` では1件も当たらない（実機で確認）。
//    さらに「最初の .dpx-input」は別のコントロールを掴むので、
//    現在値（元の区画名）で特定する
// ⚠ **位置（first / last）で選ばない。** キャンバスに入力があると
//   そちらが先に来て、**ドラッグ用オーバーレイがクリックを遮る**。
//   → **現在の区画名を値に持つ欄**で特定する。
const beforeName = before[0]?.label ?? "区画";
const nameBox = page.locator(`input.dpx-input[value="${beforeName}"]`).first();
// ⚠ `fill('')` は**クリアボタンを押してしまう**ので Control+a で上書きする
await nameBox.click();
await page.keyboard.press('Control+a');
await nameBox.type('検証区画');
// ⚠ **DPX の TextInput は blur で確定する**（打鍵では反映されない）
await page.keyboard.press('Tab');
await page.waitForTimeout(800);
const afterRename = (await page.locator('body').innerText().catch(() => '')) ?? '';
ok(/検証区画/.test(afterRename), '区画名を変更できる');

// ── 3. ツールバーから区画を追加できるか ────────────────────────
const addBtn = page.locator('button[title*="区画を追加"]');
ok((await addBtn.count()) > 0, 'ツールバーに「区画を追加」がある');
if ((await addBtn.count()) > 0) {
    await addBtn.first().click();
    await page.waitForTimeout(1200);
    const t2 = (await page.locator('body').innerText().catch(() => '')) ?? '';
    // 追加直後は新しい区画が選択される
    ok(/区画：/.test(t2), '追加した区画が選択された状態になる');
    await page.screenshot({ path: `${OUT}/dp-group-2-added.png` });
}

// ── 4. パネル側から「所属する区画」を選べるか ──────────────────
// ⚠ **パネル ID を決め打ちしない**（旧実装は `h1` 固定で、
//   そのボードが無いと 30 秒タイムアウトしていた）。実在する先頭パネルを掴む。
// ⚠ パネルは**中央をクリックしない**（隣の子 div が pointer を奪う）。
//   タイトルバー（上端 +10px）を狙う。
const anyPanel = page.locator('[data-panel-id]').first();
await anyPanel.scrollIntoViewIfNeeded();
await anyPanel.click({ position: { x: 60, y: 10 } });
await page.waitForTimeout(1000);
const panelPane = (await page.locator('body').innerText().catch(() => '')) ?? '';
ok(/所属する区画/.test(panelPane), 'パネルの設定に「所属する区画」がある');
await page.screenshot({ path: `${OUT}/dp-group-3-panel.png` });

// ── 5. 保存して永続化を確認 ───────────────────────────────────
const saveBtn = page.getByRole('button', { name: '保存' }).first();
if (await saveBtn.isEnabled().catch(() => false)) {
    await saveBtn.click();
    await page.getByText('保存しました').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
}

await browser.close();

const after = await readGroups();
console.log(`編集後の区画数: ${after.length}`);
ok(after.length > before.length, '追加した区画が定義に保存された');
ok(after.some((g) => g.label === '検証区画'), '変更した区画名が保存された');

console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
