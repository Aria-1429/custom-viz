// DPX のダッシュボード定義（JSON）を実機のビューへ push する。
//   node src/dp-push.mjs <definition.json> <app> <view> [表示ラベル]
//
// ⚠ POST にも ?output_mode=json を付ける（付けないと XML が返って解析に失敗する。§8.5）。
// ⚠ 既存ビューがあれば更新、無ければ作成。owner は [username, 'nobody'] の順に試す
//    （アプリ共有オブジェクトの更新先 owner は状況で変わる。§8.5）。
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { assertConfig, config, mgmtBase } from './config.mjs';

const [, , file, app, view, labelArg] = process.argv;
if (!file || !app || !view) {
    console.error('usage: dp-push.mjs <definition.json> <app> <view> [label]');
    process.exit(1);
}
assertConfig();

const definition = JSON.parse(readFileSync(file, 'utf8'));
const label = labelArg || definition.title || view;

const eaiData = `<view template="pages/splunk_ui_app.html" type="html" isVisible="False">
  <label>${label.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</label>
  <definition><![CDATA[${JSON.stringify(definition)}]]></definition>
</view>`;

function rest(method, url, form) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const body = form ? new URLSearchParams(form).toString() : null;
        const req = https.request(
            {
                method,
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                rejectUnauthorized: false,
                headers: {
                    Authorization: `Basic ${Buffer.from(`${config.user}:${config.pass}`).toString('base64')}`,
                    ...(body
                        ? {
                              'Content-Type': 'application/x-www-form-urlencoded',
                              'Content-Length': Buffer.byteLength(body),
                          }
                        : {}),
                },
            },
            (r) => {
                let b = '';
                r.on('data', (c) => (b += c));
                r.on('end', () => resolve({ status: r.statusCode, body: b }));
            }
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const ns = (owner) =>
    `${mgmtBase()}/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views`;

let done = false;
for (const owner of [config.user, 'nobody']) {
    // 既存なら更新
    const exists = await rest('GET', `${ns(owner)}/${encodeURIComponent(view)}?output_mode=json`);
    if (exists.status === 200) {
        const r = await rest('POST', `${ns(owner)}/${encodeURIComponent(view)}?output_mode=json`, {
            'eai:data': eaiData,
        });
        if (r.status < 300) {
            console.log(`✓ 更新: ${app}/${view} (owner=${owner})`);
            done = true;
            break;
        }
        console.log(`  更新失敗 owner=${owner}: HTTP ${r.status}`);
    }
}

if (!done) {
    const r = await rest('POST', `${ns(config.user)}?output_mode=json`, {
        name: view,
        'eai:data': eaiData,
    });
    if (r.status < 300) {
        console.log(`✓ 作成: ${app}/${view}`);
    } else {
        console.error(`✗ 作成失敗: HTTP ${r.status}\n${r.body.slice(0, 600)}`);
        process.exit(1);
    }
}

console.log(`URL: /en-US/app/dpx/dpx?id=${app}/${view}`);
