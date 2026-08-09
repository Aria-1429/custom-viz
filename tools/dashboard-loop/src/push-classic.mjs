// クラシック（Simple XML）ダッシュボードを実機へ push する。
//
// push.mjs / sync.mjs は Studio 専用（<dashboard version="2"> + <definition> の CDATA JSON）。
// こちらは **Simple XML の生 XML をそのまま** data/ui/views に入れる。
//
// 使い方:
//   node src/push-classic.mjs <file.xml> --name <dashboard-name> [--app <app>]
//
// 撮影は Studio と同じ shot.mjs が使える（URL の形が同じため）。

import { readFileSync } from 'node:fs';
import { assertConfig, config, mgmtBase } from './config.mjs';
import https from 'node:https';

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
                res.on('end', () =>
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
                );
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const msg = (b) => {
    const m = b.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
    return m ? m[1].trim() : b.slice(0, 400);
};

async function requestEntity(method, { name, app, query = '' }, form) {
    let last;
    for (const owner of [config.user, 'nobody']) {
        const url = `${mgmtBase()}/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}${query}`;
        last = await request(method, url, form);
        if (last.status === 200) return last;
    }
    return last;
}

export async function pushClassic({ name, xml, app = config.app }) {
    const exists = await requestEntity('GET', { name, app });
    const isUpdate = exists.status === 200;

    const res = isUpdate
        ? await requestEntity('POST', { name, app }, { 'eai:data': xml })
        : await request(
              'POST',
              `${mgmtBase()}/servicesNS/${encodeURIComponent(config.user)}/${encodeURIComponent(app)}/data/ui/views`,
              { name, 'eai:data': xml }
          );

    if (res.status !== 200 && res.status !== 201) {
        throw new Error(`${isUpdate ? '更新' : '作成'}失敗 (HTTP ${res.status}): ${msg(res.body)}`);
    }

    // 共有をアプリレベルに（人が UI から探せるように）
    await request(
        'POST',
        `${mgmtBase()}/servicesNS/${encodeURIComponent(config.user)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}/acl`,
        { sharing: 'app', owner: config.user, 'perms.read': '*', 'perms.write': '*' }
    );

    return { updated: isUpdate, name, app };
}

/** 実機に入っている XML をそのまま取り出す（Splunk が書き換えたかの確認用）。 */
export async function getClassic({ name, app = config.app }) {
    const res = await requestEntity('GET', { name, app, query: '?output_mode=json' });
    if (res.status !== 200) throw new Error(`取得失敗 (HTTP ${res.status}): ${msg(res.body)}`);
    return JSON.parse(res.body).entry?.[0]?.content?.['eai:data'] ?? '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const k = argv[i].slice(2);
            const n = argv[i + 1];
            if (n === undefined || n.startsWith('--')) flags[k] = true;
            else { flags[k] = n; i++; }
        } else positional.push(argv[i]);
    }
    assertConfig();
    const file = positional[0];
    if (!file) {
        console.error('使い方: node src/push-classic.mjs <file.xml> --name <dashboard-name>');
        process.exit(1);
    }
    const name = flags.name || file.replace(/.*\//, '').replace(/\.xml$/, '');
    const xml = readFileSync(file, 'utf8');
    const r = await pushClassic({ name, xml, app: flags.app || config.app });
    console.log(`${r.updated ? '更新' : '作成'}: ${r.name} (app=${r.app})`);
    console.log(`URL: ${config.host}:${config.webPort || 8000}/en-US/app/${r.app}/${r.name}`);
}
