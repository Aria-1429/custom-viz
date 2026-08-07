// ダッシュボードの描画結果をスクリーンショットで取得する。
//
// これが「Claude が画面を見る」ための経路。撮った PNG は Read ツールで実際に画像として見える。
// 併せてブラウザのコンソールエラー・失敗リクエストも拾う（カスタム viz の不具合はここに出る）。
//
// 使い方:
//   node src/shot.mjs <dashboard-name> [--out <dir>] [--width 1920] [--height 1080]
//                                      [--wait 45] [--settle 2] [--theme dark] [--panels] [--probe]
//                                      [--tab <ラベル or 0始まりの番号>]
//
// タブ付きダッシュボードは既定で先頭タブしか撮れない。`--tab` で切り替えてから撮る
// （タブは [data-test="tab"]。2026-08-07 実機の probe で確認）。
// 出力ファイル名には `__tab-<指定値>` が付くので、タブごとに上書きされない。

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) flags[key] = true;
            else {
                flags[key] = next;
                i++;
            }
        } else positional.push(a);
    }
    return { positional, flags };
}

/**
 * Splunk Web にログインする。
 *
 * セレクタは実機で確かめたものではないため、候補を順に試して最初に見つかったものを使う。
 * 全滅したときは「推測が外れた」ことが分かるように、そのページの入力欄を列挙して落とす。
 */
async function login(page) {
    const url = `${webBase()}/en-US/account/login`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const userSel = ['input[name="username"]', 'input#username', 'input[data-test="username"]'];
    const passSel = ['input[name="password"]', 'input#password', 'input[data-test="password"]'];

    const findFirst = async (selectors) => {
        for (const s of selectors) {
            const el = page.locator(s).first();
            if ((await el.count()) > 0) return el;
        }
        return null;
    };

    const userEl = await findFirst(userSel);
    const passEl = await findFirst(passSel);

    if (!userEl || !passEl) {
        const inputs = await page.locator('input').evaluateAll((els) =>
            els.map((e) => ({ name: e.name, id: e.id, type: e.type }))
        );
        throw new Error(
            `ログインフォームの入力欄が見つかりません。ページ上の input:\n${JSON.stringify(inputs, null, 2)}`
        );
    }

    await userEl.fill(config.user);
    await passEl.fill(config.pass);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
        passEl.press('Enter'),
    ]);

    // ログイン後もログイン URL に留まっている＝失敗
    await page.waitForTimeout(1500);
    if (page.url().includes('/account/login')) {
        const msg = await page
            .locator('[role="alert"], .error, [data-test="error"]')
            .first()
            .textContent()
            .catch(() => null);
        throw new Error(`ログインに失敗しました${msg ? `: ${msg.trim()}` : '（認証情報を確認してください）'}`);
    }
}

/**
 * 描画が落ち着くまで待つ。
 *
 * DOM のロード完了 ≠ パネル描画完了（サーチの実行が挟まる）ので、
 * 「スクリーンショットが2回連続で同一になったら完了」とみなす。
 * アニメーションする viz（Attack Globe 等）は永久に安定しないため、maxWait で打ち切る。
 */
async function waitForRender(page, { maxWaitMs, settleMs }) {
    const deadline = Date.now() + maxWaitMs;
    let prev = null;
    let stableSince = null;

    while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
        const same = prev && buf.equals(prev);
        prev = buf;

        if (same) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= settleMs) {
                return { settled: true, waitedMs: maxWaitMs - (deadline - Date.now()) };
            }
        } else {
            stableSince = null;
        }
    }
    // 安定しなかった＝アニメーションしている可能性が高い。異常ではない。
    return { settled: false, waitedMs: maxWaitMs };
}

async function main() {
    assertConfig();
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const name = positional[0];
    if (!name && !flags.probe) {
        console.error('使い方: node src/shot.mjs <dashboard-name> [--out <dir>] [--panels]');
        process.exit(2);
    }

    const outDir = String(flags.out || join(process.cwd(), 'shots'));
    mkdirSync(outDir, { recursive: true });

    const width = Number(flags.width || 1920);
    const height = Number(flags.height || 1080);
    // 既定 75 秒。サーチが終わらないうちに撮ると正常なパネルが空表示になるため、
    // 「短くして速く回す」より「長めに待って誤診しない」を優先する。
    const maxWaitMs = Number(flags.wait || 75) * 1000;
    const settleMs = Number(flags.settle || 2) * 1000;

    const browser = await chromium.launch({
        args: [
            // WebGL を使う viz（Attack Globe / Liquid Tube 等）をヘッドレスで描くための指定。
            // ソフトウェアラスタライザ(SwiftShader)を明示的に有効にする。
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
        ],
    });

    const ctxOpts = {
        ignoreHTTPSErrors: true, // 開発機の自己署名証明書
        viewport: { width, height },
        // 細部を読み取れるように既定は 2x。ただし**縦長のダッシュボードでは画像が巨大になり、
        // page.screenshot が 30 秒でタイムアウトする**（2026-08-07 に 1920x2200 で発生）。
        // その場合は `--scale 1` で撮る。
        deviceScaleFactor: Math.max(1, Math.min(3, Number(flags.scale) || 2)),
    };
    if (existsSync(STATE_FILE)) ctxOpts.storageState = STATE_FILE;

    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();

    // 診断情報の収集
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') {
            consoleErrors.push({ type: m.type(), text: m.text() });
        }
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('requestfailed', (r) =>
        failedRequests.push({ url: r.url(), reason: r.failure()?.errorText })
    );
    page.on('response', (r) => {
        if (r.status() >= 400) failedRequests.push({ url: r.url(), status: r.status() });
    });

    try {
        // セッションが生きているか確かめ、切れていればログインし直す
        const dashUrl = `${webBase()}/en-US/app/${encodeURIComponent(config.app)}/${encodeURIComponent(name || '')}`;
        await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (page.url().includes('/account/login')) {
            await login(page);
            await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
        await context.storageState({ path: STATE_FILE });

        // タブの切り替え（タブ付きダッシュボードのみ）
        let activeTab = null;
        if (flags.tab !== undefined && flags.tab !== true) {
            const tabs = page.locator('[data-test="tab"]');
            await tabs.first().waitFor({ timeout: 30_000 }).catch(() => {});
            const labels = await tabs.allTextContents();
            if (labels.length === 0) throw new Error('タブが見つかりません（タブ付きダッシュボードではない可能性）');
            const spec = String(flags.tab);
            let idx = labels.findIndex((t) => t.trim() === spec);
            if (idx < 0 && /^\d+$/.test(spec)) idx = Number(spec);
            if (idx < 0 || idx >= labels.length) {
                throw new Error(`タブ "${spec}" が見つかりません。存在するタブ: ${JSON.stringify(labels)}`);
            }
            await tabs.nth(idx).click();
            await page.waitForTimeout(2000); // 切り替え後の再レイアウト待ち
            activeTab = { index: idx, label: labels[idx].trim(), all: labels.map((t) => t.trim()) };
        }
        const fileTag = activeTab ? `${name}__tab-${activeTab.index}` : name;

        // ダッシュボードの実寸に合わせてビューポートを広げる。
        //
        // これをやらないと折り返しより下のパネルが「描画されないまま」撮れる（2026-08-07 実機で遭遇。
        // レイアウト 1920x1680 のダッシュボードを 1920x1080 で撮ったら下段4パネルが空白になった）。
        // パネル個別撮影は Playwright が要素を可視域へスクロールするため影響を受けず、
        // 「個別は撮れているのに全体だと空白」という紛らわしい出方をする。
        let fitted = null;
        if (!flags.nofit) {
            const box = await page
                .locator('[data-test="canvas"]')
                .first()
                .boundingBox()
                .catch(() => null);
            if (box && box.height > height - 40) {
                const target = Math.min(Math.ceil(box.height) + 160, Number(flags.maxheight || 3000));
                await page.setViewportSize({ width, height: target });
                fitted = { from: height, to: target };
                await page.waitForTimeout(2000); // 再レイアウト待ち
            }
        }

        const render = await waitForRender(page, { maxWaitMs, settleMs });

        // 既定はダッシュボード本体だけを切り出す（Splunk のヘッダ・ナビ・ツールバーを除く）。
        // --full を付けるとブラウザ画面全体。セレクタは実機確認済み（2026-08-07）。
        const shotPath = join(outDir, `${fileTag}.png`);
        const canvas = page.locator('[data-test="canvas"]').first();
        const useCanvas = !flags.full && (await canvas.count()) > 0;
        if (useCanvas) await canvas.screenshot({ path: shotPath });
        else await page.screenshot({ path: shotPath, fullPage: false });

        const result = {
            capture: useCanvas ? 'canvas（ダッシュボード本体のみ）' : 'ブラウザ画面全体',
            fitted,
            dashboard: name,
            activeTab,
            url: dashUrl,
            viewport: { width, height },
            settled: render.settled,
            screenshot: shotPath,
            panels: [],
            consoleErrors,
            pageErrors,
            failedRequests,
        };

        // パネル個別の撮影（--panels）。
        // セレクタは実機確認済み（2026-08-07 / Splunk 10.4.2）:
        //   [data-test="viz-item"] が各パネル。data-id が JSON の visualizations キー、
        //   data-viz-type が viz の型（カスタム viz なら <appId>.<appId>）。
        if (flags.panels) {
            const items = page.locator('[data-test="viz-item"]');
            const count = await items.count();
            for (let i = 0; i < count; i++) {
                const el = items.nth(i);
                const id = (await el.getAttribute('data-id')) || `panel${i}`;
                const vizType = await el.getAttribute('data-viz-type');
                const p = join(outDir, `${fileTag}__${id}.png`);
                await el.screenshot({ path: p }).catch(() => {});
                result.panels.push({ id, vizType, path: p });
            }
            if (count === 0) {
                result.panelSelectorNote =
                    '[data-test="viz-item"] が見つかりませんでした。DOM が変わった可能性があります（probe-dom.mjs で確認）。';
            }
        }

        // DOM 構造の調査モード（セレクタの推測が外れたときに事実を得る）
        if (flags.probe) {
            result.probe = await page.evaluate(() => {
                const attrs = new Set();
                for (const el of document.querySelectorAll('[data-test]')) {
                    attrs.add(el.getAttribute('data-test'));
                }
                return {
                    title: document.title,
                    dataTestValues: [...attrs].slice(0, 120),
                    iframeCount: document.querySelectorAll('iframe').length,
                    canvasCount: document.querySelectorAll('canvas').length,
                };
            });
        }

        // 「データがありません」を出しているパネルを拾う。
        //
        // サーチが待ち時間内に終わらないと、正常なパネルでも空表示になる（2026-08-07 に遭遇。
        // 同じ JSON でも実行のたびに空になるパネルが変わった）。
        // これを検出せずにスクショだけ見ると「ダッシュボードの不具合」と誤診する。
        //
        // ⚠ カスタム viz は iframe 内で描画されるため、ホスト側の textContent だけでは
        //   拾えない（最初にこの実装で書いて検出漏れを起こした）。iframe の中も見ること。
        const EMPTY_RE = /データがありません|No results found|No data|結果がありません/i;
        result.emptyPanels = [];
        result.iframePanels = 0;
        for (const h of await page.locator('[data-test="viz-item"]').elementHandles()) {
            const id = (await h.getAttribute('data-id')) || '(不明)';
            let text = await h.innerText().catch(() => '');
            for (const f of await h.$$('iframe')) {
                const frame = await f.contentFrame().catch(() => null);
                if (!frame) continue;
                result.iframePanels++;
                text += ' ' + (await frame.locator('body').innerText().catch(() => ''));
            }
            if (EMPTY_RE.test(text)) result.emptyPanels.push(id);
        }

        const reportPath = join(outDir, `${fileTag}.report.json`);
        writeFileSync(reportPath, JSON.stringify(result, null, 2));

        console.log(`✓ スクリーンショット: ${shotPath}（${result.capture}）`);
        if (result.panels.length) console.log(`  パネル個別: ${result.panels.length} 枚`);
        console.log(`  描画: ${render.settled ? '安定した' : `${maxWaitMs / 1000}秒で打ち切り（アニメーション中の可能性）`}`);
        if (result.emptyPanels.length) {
            console.log(
                `  ⚠ 空表示 ${result.emptyPanels.length} パネル: ${result.emptyPanels.join(', ')}`
            );
            console.log(
                `    → サーチ未完了の可能性。--wait を伸ばして撮り直し、それでも空ならデータ側の問題`
            );
        }
        if (pageErrors.length) console.log(`  ⚠ ページエラー ${pageErrors.length} 件`);
        if (consoleErrors.length) console.log(`  ⚠ コンソール ${consoleErrors.length} 件`);
        if (failedRequests.length) console.log(`  ⚠ 失敗リクエスト ${failedRequests.length} 件`);
        console.log(`  詳細: ${reportPath}`);
        if (flags.probe) console.log(JSON.stringify(result.probe, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
});
