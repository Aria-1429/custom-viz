// DPX のビューを削除する。
//   node src/dp-delete-view.mjs <app> <view>
//
// ⚠ **owner のネームスペースを指定しないと 500 になる**（実機で確定）。
//   `servicesNS/-/...`（ワイルドカード）は読み取りには使えるが、
//   DELETE は通らない。所有者を調べてから消す。
import https from 'node:https';

import { assertConfig, config, mgmtBase } from './config.mjs';

const [, , app, view] = process.argv;
if (!app || !view) {
    console.error('usage: dp-delete-view.mjs <app> <view>');
    process.exit(1);
}
assertConfig();

const auth = 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64');

const req = (method, url) =>
    new Promise((resolve, reject) => {
        const u = new URL(url);
        const r = https.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                rejectUnauthorized: false,
                headers: { Authorization: auth },
            },
            (res) => {
                let b = '';
                res.on('data', (c) => (b += c));
                res.on('end', () => resolve({ status: res.statusCode, body: b }));
            }
        );
        r.on('error', reject);
        r.end();
    });

// 1) 所有者を調べる
const found = await req(
    'GET',
    `${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`
);
if (found.status === 404) {
    console.log(`（存在しません: ${app}/${view}）`);
    process.exit(0);
}
if (found.status >= 300) {
    console.error(`取得に失敗: HTTP ${found.status}`);
    process.exit(1);
}
const owner = JSON.parse(found.body).entry[0].acl.owner;

// 2) owner のネームスペースで消す
const del = await req(
    'DELETE',
    `${mgmtBase()}/servicesNS/${owner}/${app}/data/ui/views/${view}?output_mode=json`
);
if (del.status >= 300) {
    console.error(`削除に失敗: HTTP ${del.status}\n${del.body.slice(0, 300)}`);
    process.exit(1);
}
console.log(`✓ 削除: ${app}/${view}（owner=${owner}）`);
