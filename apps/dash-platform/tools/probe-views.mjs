#!/usr/bin/env node
// 動的ビュー作成のプローブ。
//   node tools/probe-views.mjs create <viewName> <app> [template|--eai <xmlファイル>]
//   node tools/probe-views.mjs get <viewName> <app>
//   node tools/probe-views.mjs delete <viewName> <app>
// 認証設定は ~/.splunk-dev.env（tools/dashboard-loop/src/config.mjs を流用）。

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { config, mgmtBase } from '../../../tools/dashboard-loop/src/config.mjs';

function request(method, url, form) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const payload = form ? new URLSearchParams(form).toString() : null;
        const auth = Buffer.from(`${config.user}:${config.pass}`).toString('base64');
        const req = https.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                rejectUnauthorized: false,
                headers: {
                    Authorization: `Basic ${auth}`,
                    ...(payload
                        ? {
                              'Content-Type': 'application/x-www-form-urlencoded',
                              'Content-Length': Buffer.byteLength(payload),
                          }
                        : {}),
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const [, , cmd, name, app, ...rest] = process.argv;
if (!cmd || !name || !app) {
    console.error('usage: probe-views.mjs <create|get|delete> <viewName> <app> [template|--eai <file>]');
    process.exit(1);
}

const base = (owner) =>
    `${mgmtBase()}/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views`;

if (cmd === 'create') {
    let eaiData;
    if (rest[0] === '--eai') {
        eaiData = readFileSync(rest[1], 'utf8');
    } else {
        const template = rest[0] ?? 'pages/splunk_ui_app.html';
        eaiData = `<view template="${template}" type="html">\n    <label>${name}</label>\n</view>`;
    }
    // 既存なら更新、無ければ新規。共有済みだと owner が nobody に移るので
    // 実体の acl.owner を見てから POST する。
    const exists = await request(
        'GET',
        `${base('-')}/${encodeURIComponent(name)}?output_mode=json`
    );
    let res;
    if (exists.status === 200) {
        for (const owner of [config.user, 'nobody']) {
            res = await request('POST', `${base(owner)}/${encodeURIComponent(name)}`, { 'eai:data': eaiData });
            if (res.status === 200) break;
        }
    } else {
        res = await request('POST', base(config.user), { name, 'eai:data': eaiData });
    }
    console.log(`create ${name} in ${app}: HTTP ${res.status}`);
    if (res.status >= 400) {
        console.log(res.body.slice(0, 500));
        process.exit(1);
    }
    // アプリ共有にする（UI から誰でも開ける状態に）
    const acl = await request('POST', `${base(config.user)}/${encodeURIComponent(name)}/acl`, {
        sharing: 'app',
        owner: config.user,
        'perms.read': '*',
        'perms.write': '*',
    });
    console.log(`acl → app sharing: HTTP ${acl.status}`);
} else if (cmd === 'get') {
    for (const owner of [config.user, 'nobody']) {
        const res = await request('GET', `${base(owner)}/${encodeURIComponent(name)}?output_mode=json`, null);
        if (res.status === 200) {
            const entry = JSON.parse(res.body).entry[0];
            console.log(JSON.stringify({ owner, data: entry.content['eai:data'] }, null, 2));
            process.exit(0);
        }
    }
    console.log('not found');
    process.exit(1);
} else if (cmd === 'delete') {
    for (const owner of [config.user, 'nobody']) {
        const res = await request('DELETE', `${base(owner)}/${encodeURIComponent(name)}`, null);
        if (res.status === 200) {
            console.log(`deleted (${owner})`);
            process.exit(0);
        }
    }
    console.log('not found');
}
