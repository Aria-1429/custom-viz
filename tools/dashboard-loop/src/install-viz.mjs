// viz の .spl を実機へインストール（アップグレード上書き）し、Web のアセットを bump する。
//
// これまで「.spl のインストールだけはユーザーの手作業」だったが、実機ユーザーに
// `install_apps` を付与したことで自動化できるようになった（2026-08-07 実機確認済み）。
// ブラウザ不要・依存ゼロ（node:https のみ）の HTTP API 呼び出しで完結する。
//
//   node src/install-viz.mjs <viz名|アプリID>      … その viz の最新 .spl を入れる
//   node src/install-viz.mjs <path/to/file.spl>    … .spl を直接指定する
//   node src/install-viz.mjs <viz名> --no-bump     … bump をしない
//
// ── どの API で入れているか（実機で試した順。すべて 2026-08-07 に確認） ──
//   ✗ 管理ポート(8089) `POST /services/apps/local`（multipart）
//   ✗ 管理ポート(8089) `POST /services/apps/appinstall`（multipart）
//   ✗ Web の REST プロキシ `/en-US/splunkd/__raw/services/apps/local`（multipart）
//        → いずれも **`Unparsable URI-encoded request data` (HTTP 400)**。
//          splunkd の `apps/local` は multipart を受け付けない。`name` は
//          「**splunkd から見えるパス / URL**」を渡す前提なので、手元のファイルは送れない
//          （＝管理ポートの REST だけでは .spl のアップロードは完結しない）。
//   ✗ 旧 UI の `/en-US/manager/appinstall/_upload`（Splunk 10.4 では **404**。廃止）
//   ✓ **`POST /en-US/manager/appinstall/upload_app`**（Splunk Web の HTTP API。multipart を受ける）
//        フィールドは `appPackage`（ファイル本体）と `forceOverride`（1 = 上書き）。
//        App Management 画面の JS（`uploadLocalApp`）が実際に呼んでいるものと同じ。
//        成功時 `{"status":"APP_INSTALLED","appId":"..."}` が返る。
//
//   ※ この画面の「Install app from file」ボタン自体は `power` 相当のロールでは表示されないが、
//     **エンドポイントは `install_apps` があれば通る**（実機確認済み）。
//     `edit_local_apps` / `admin_all_objects` は無くてよい。
//
// ⚠ **`config.json` を変えた回は、このインストールでは編集パネルに反映されない**
//    （2026-08-07 実機で確定）。描画（`visualization.js`）は静的アセットなので `_bump` で
//    反映されるが、editorConfig は splunkd の `data/ui/visualizations?includeConfig=true`
//    経由で配信され、**splunkd 内にキャッシュされていて再起動しないと更新されない**。
//    `_bump` / `debug/refresh` / 各種 `_reload` / app の disable→enable はいずれも無効だった。
//    → オプションを増減したら**ユーザーに splunkd の再起動を依頼する**
//      （`restart_splunkd` 権限が要る）。詳細は
//      `.claude/skills/splunk-viz/references/studio-extension-viz.md` の §7.1。
//
// 認証情報は ~/.splunk-dev.env（config.mjs）から読む。チャットやリポジトリに書かない。

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig, config, webBase, mgmtBase } from './config.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 指定 viz の dist から最新（mtime）の .spl を探す。 */
function findLatestSpl(nameOrId) {
    const vizDir = join(repoRoot, 'visualizations');
    const candidates = [];
    for (const folder of readdirSync(vizDir)) {
        const dist = join(vizDir, folder, 'dist');
        if (!existsSync(dist)) continue;
        const appDir = join(vizDir, folder, 'visualizations');
        const appIds = existsSync(appDir) ? readdirSync(appDir) : [];
        if (folder !== nameOrId && !appIds.includes(nameOrId)) continue;
        for (const f of readdirSync(dist)) {
            if (!f.endsWith('.spl')) continue;
            const p = join(dist, f);
            candidates.push({ path: p, mtime: statSync(p).mtimeMs });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].path;
}

// ---- 最小の HTTP クライアント（Cookie を持ち回る） --------------------------
const jar = new Map();

function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res) {
    for (const line of res.headers['set-cookie'] || []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
}

function requestRaw(method, url, body, extraHeaders = {}) {
    return new Promise((res, rej) => {
        const u = new URL(url);
        const headers = { ...extraHeaders };
        const cookies = cookieHeader();
        if (cookies) headers.Cookie = cookies;
        if (body) headers['Content-Length'] = Buffer.byteLength(body);
        const req = https.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                rejectUnauthorized: false, // 開発機の自己署名証明書
                headers,
            },
            (r) => {
                absorbCookies(r);
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', () =>
                    res({
                        status: r.statusCode,
                        headers: r.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    })
                );
            }
        );
        req.on('error', rej);
        if (body) req.write(body);
        req.end();
    });
}

/**
 * Splunk Web(:8000) にログインしてセッション Cookie と CSRF トークンを得る。
 *
 * ⚠ CSRF トークンの Cookie 名が**ログインの前後で変わる**（実機で確認）:
 *   ログイン前 … `cval`（これを POST の `cval` と `X-Splunk-Form-Key` に使う）
 *   ログイン後 … `splunkweb_csrf_token_<webポート>`（以降の API 呼び出しはこちら）
 * ログイン前に後者を探すと空文字を送ることになり、**HTTP 400 で落ちる**。
 * ログインフォームは React 描画のため HTML に input が無く、値は Cookie から取る。
 */
async function webLogin() {
    const loginUrl = `${webBase()}/en-US/account/login`;
    await requestRaw('GET', loginUrl); // cval Cookie を受け取る
    const cval = jar.get('cval') || '';
    const form = new URLSearchParams({
        username: config.user,
        password: config.pass,
        cval,
        return_to: '/en-US/',
    }).toString();
    const res = await requestRaw('POST', loginUrl, form, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Splunk-Form-Key': cval,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: loginUrl,
    });
    const key = [...jar.keys()].find((k) => k.startsWith('splunkweb_csrf_token_'));
    if (!jar.has('splunkd_8000') || !key) {
        throw new Error(`Splunk Web へのログインに失敗しました (HTTP ${res.status})`);
    }
    return jar.get(key);
}

/** multipart/form-data のボディを組み立てる。 */
function multipart(fields, file) {
    const boundary = '----splunkviz' + Date.now().toString(36);
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
            )
        );
    }
    parts.push(
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
                'Content-Type: application/octet-stream\r\n\r\n'
        ),
        file.data,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    return { boundary, body: Buffer.concat(parts) };
}

/**
 * 実機の splunkd が配信している editorConfig が、いま入れた config.json と一致するか調べる。
 *
 * 一致しなければ「描画は新しいが編集パネルは古い」状態（§7.1）。`_bump` では直らないので、
 * 黙って通さずに再起動が要ることを警告する。判定は optionsSchema のキー集合で行う。
 */
async function warnIfEditorConfigStale(appId, splPath) {
    let localKeys;
    try {
        const raw = execFileSync('tar', ['-xzOf', splPath, `${appId}/appserver/static/visualizations/${appId}/config.json`]);
        localKeys = Object.keys(JSON.parse(raw.toString('utf8')).config.optionsSchema || {});
    } catch (e) {
        return; // config.json を読めないなら黙って諦める（インストール自体は成功している）
    }
    const served = await new Promise((res) => {
        const u = new URL(
            `${mgmtBase()}/services/data/ui/visualizations?output_mode=json&count=0&includeConfig=true`
        );
        const r = https.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                headers: {
                    Authorization:
                        'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64'),
                },
            },
            (x) => {
                const c = [];
                x.on('data', (d) => c.push(d));
                x.on('end', () => {
                    try {
                        const entry = JSON.parse(Buffer.concat(c).toString()).entry.find(
                            (e) => e.name === appId
                        );
                        const cfg = entry && entry.content.config;
                        const obj = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
                        res(Object.keys((obj.config || obj).optionsSchema || {}));
                    } catch (err) {
                        res(null);
                    }
                });
            }
        );
        r.on('error', () => res(null));
        r.end();
    });
    if (!served) return;
    const missing = localKeys.filter((k) => !served.includes(k));
    const extra = served.filter((k) => !localKeys.includes(k));
    if (missing.length === 0 && extra.length === 0) {
        console.log('✓ 編集パネルの定義も最新（splunkd が新しい config.json を配信している）');
        return;
    }
    console.log('');
    console.log('⚠ 編集パネル（editorConfig）は古いままです。**splunkd の再起動が必要**');
    console.log(`   実機が配信中の optionsSchema: ${served.length} 個 / いま入れた .spl: ${localKeys.length} 個`);
    if (missing.length) console.log(`   まだ出ないオプション: ${missing.join(', ')}`);
    if (extra.length) console.log(`   まだ残っている旧オプション: ${extra.join(', ')}`);
    console.log('   描画（visualization.js）は反映済み。config.json だけ splunkd にキャッシュされています。');
    console.log('   `_bump` / `debug/refresh` / `_reload` / app の disable→enable では直りません。');
    console.log('   → ユーザーに splunkd の再起動を依頼してください（`restart_splunkd` 権限が必要）。');
}

// ---- main -------------------------------------------------------------------
assertConfig();

const args = process.argv.slice(2);
const noBump = args.includes('--no-bump');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
    console.error('使い方: node src/install-viz.mjs <viz名|アプリID|path/to/file.spl> [--no-bump]');
    process.exit(2);
}

const splPath = target.endsWith('.spl') ? resolve(target) : findLatestSpl(target);
if (!splPath || !existsSync(splPath)) {
    console.error(`✗ .spl が見つかりません: ${target}`);
    console.error('  先に `yarn build:prod && yarn package` してください。');
    process.exit(1);
}

console.log(`→ ${basename(splPath)} (${(statSync(splPath).size / 1024).toFixed(0)} KB) を実機へ`);

try {
    const formKey = await webLogin();

    const { boundary, body } = multipart(
        { forceOverride: '1' }, // = Splunk Web の "Upgrade app" チェック
        { name: 'appPackage', filename: basename(splPath), data: readFileSync(splPath) }
    );
    const res = await requestRaw(
        'POST',
        `${webBase()}/en-US/manager/appinstall/upload_app`,
        body,
        {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'X-Splunk-Form-Key': formKey,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${webBase()}/en-US/manager/search/apps/local`,
        }
    );

    let payload = {};
    try {
        payload = JSON.parse(res.body);
    } catch (e) {
        /* JSON でなければ生の本文を見せる */
    }
    if (res.status !== 200 || payload.status !== 'APP_INSTALLED') {
        throw new Error(`HTTP ${res.status} ${payload.message || res.body.slice(0, 300)}`);
    }
    console.log(`✓ インストール完了（上書き）: ${payload.appId}`);

    // splunkd が配信する editorConfig が古いままでないか確かめる（§7.1 のキャッシュ）
    await warnIfEditorConfigStale(payload.appId, splPath);

    if (!noBump) {
        // _bump は「アセットのバージョン番号を上げる」だけの単純なフォーム POST。
        const bumpUrl = `${webBase()}/en-US/_bump`;
        await requestRaw('GET', bumpUrl);
        const key = [...jar.keys()].find((k) => k.startsWith('splunkweb_csrf_token_'));
        const form = new URLSearchParams({ splunk_form_key: key ? jar.get(key) : formKey }).toString();
        const b = await requestRaw('POST', bumpUrl, form, {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Splunk-Form-Key': key ? jar.get(key) : formKey,
            Referer: bumpUrl,
        });
        console.log(
            b.status < 400
                ? '✓ _bump 実行（Web アセットを更新）'
                : `⚠ _bump 失敗 (HTTP ${b.status})。/en-US/_bump を手動で実行してください`
        );
    }
} catch (err) {
    console.error(`✗ インストール失敗: ${err.message}`);
    process.exit(1);
}
