// Splunk REST API クライアント（管理ポート 8089）。
//
// 依存ゼロ（node:https のみ）。自己署名証明書のため rejectUnauthorized:false を使うが、
// これは開発機（<開発機のIP>）へのローカル接続に限った話で、viz の成果物には一切入らない。
//
// 参照: Create a dashboard using REST API endpoints (Splunk 10.4)
// https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.4/manage-dashboards/create-a-dashboard-using-rest-api-endpoints

import https from 'node:https';
import { config, mgmtBase } from './config.mjs';

/** 生の HTTPS リクエスト。{status, body} を返す（HTTP エラーでも throw しない）。 */
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
                rejectUnauthorized: false, // 開発機の自己署名証明書
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

/** Splunk が返す XML のエラーメッセージを抜き出す（読めるログのため）。 */
function extractMessage(body) {
    const m = body.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
    return m ? m[1].trim() : body.slice(0, 300);
}

const xmlEscape = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 疎通確認。認証が通るかを最初に確かめる。 */
export async function checkAuth() {
    const r = await request('GET', `${mgmtBase()}/services/server/info?output_mode=json`);
    if (r.status !== 200) {
        throw new Error(`認証に失敗しました (HTTP ${r.status}): ${extractMessage(r.body)}`);
    }
    const info = JSON.parse(r.body).entry?.[0]?.content ?? {};
    // product は権限によっては返らない（power ロールで欠けるのを実機で確認）
    return {
        version: info.version,
        serverName: info.serverName,
        product: info.product ?? (info.isFree === '0' ? 'Splunk Enterprise' : 'Splunk'),
    };
}

/** 書き込み先アプリが無ければ作る。既にあれば何もしない。 */
export async function ensureApp(app = config.app) {
    const got = await request('GET', `${mgmtBase()}/services/apps/local/${encodeURIComponent(app)}`);
    if (got.status === 200) return { created: false, app };

    const created = await request('POST', `${mgmtBase()}/services/apps/local`, {
        name: app,
        template: 'barebones',
        label: app,
        visible: '1',
    });

    // アプリ作成には admin_all_objects / edit_local_apps が要る。power ロールでは作れない
    // （2026-08-07 実機確認）。ダッシュボードを書くだけなら既存アプリで足りるので、
    // 「何をすればよいか」を示して止める。
    if (created.status === 403) {
        throw new Error(
            `アプリ "${app}" を作る権限がありません（${config.user} / 要 admin_all_objects か edit_local_apps）。\n` +
                `  対処のどちらかを取ってください:\n` +
                `    1) ~/.splunk-dev.env の SPLUNK_APP を書き込み可能な既存アプリ（例: search）に変える\n` +
                `    2) 管理者に "${app}" アプリを作ってもらう`
        );
    }
    if (created.status !== 201 && created.status !== 200) {
        throw new Error(`アプリ "${app}" の作成に失敗 (HTTP ${created.status}): ${extractMessage(created.body)}`);
    }
    return { created: true, app };
}

/**
 * Studio ダッシュボードを作成／更新する。
 *
 * 定義は <dashboard version="2"> の <definition> に CDATA で JSON を入れる。
 * version="2" が Studio の印（これが無いと classic 扱いになる）。
 */
export async function pushDashboard({
    name,
    definition,
    label,
    description = '',
    theme = 'dark',
    app = config.app,
}) {
    const json = typeof definition === 'string' ? definition : JSON.stringify(definition, null, 2);

    // CDATA は "]]>" を含められない。含む JSON はまず無いが、黙って壊れるより落とす。
    if (json.includes(']]>')) {
        throw new Error('JSON に "]]>" が含まれており CDATA に入れられません');
    }

    const eaiData =
        `<dashboard version="2" theme="${xmlEscape(theme)}">\n` +
        `  <label>${xmlEscape(label ?? name)}</label>\n` +
        `  <description>${xmlEscape(description)}</description>\n` +
        `  <definition><![CDATA[\n${json}\n]]></definition>\n` +
        `</dashboard>`;

    // 既存なら実体 URL へ POST（更新）、無ければコレクションへ POST（新規）。
    // 実体はユーザー名前空間にも nobody にもあり得るので requestEntity で吸収する。
    const exists = await requestEntity('GET', { name, app });
    const isUpdate = exists.status === 200;

    const res = isUpdate
        ? await requestEntity('POST', { name, app }, { 'eai:data': eaiData })
        : await request(
              'POST',
              `${mgmtBase()}/servicesNS/${encodeURIComponent(config.user)}/${encodeURIComponent(app)}/data/ui/views`,
              { name, 'eai:data': eaiData }
          );

    if (res.status !== 200 && res.status !== 201) {
        throw new Error(
            `ダッシュボードの${isUpdate ? '更新' : '作成'}に失敗 (HTTP ${res.status}): ${extractMessage(res.body)}`
        );
    }
    return { updated: isUpdate, name, app };
}

/**
 * 共有範囲をアプリレベルにする。
 * REST で作ったダッシュボードは既定でそのユーザーの private になるため、
 * これをやらないと「Claude は見られるが人が UI から探せない」状態になる。
 */
export async function shareWithApp({ name, app = config.app }) {
    const url = `${mgmtBase()}/servicesNS/${encodeURIComponent(config.user)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}/acl`;
    const res = await request('POST', url, {
        sharing: 'app',
        owner: config.user,
        'perms.read': '*',
        'perms.write': '*',
    });
    if (res.status !== 200) {
        throw new Error(`共有設定に失敗 (HTTP ${res.status}): ${extractMessage(res.body)}`);
    }
}

/**
 * 名前空間違いを吸収してリクエストする。
 *
 * 共有をアプリレベルに上げると所有者が nobody に移り、ユーザー名前空間の URL では
 * 404 になる（2026-08-07 実機で遭遇）。ユーザー → nobody の順に試す。
 */
async function requestEntity(method, { name, app, query = '' }, form) {
    let last;
    for (const owner of [config.user, 'nobody']) {
        const url = `${mgmtBase()}/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}${query}`;
        last = await request(method, url, form);
        if (last.status === 200) return last;
    }
    return last;
}

/** ダッシュボードの JSON 定義を取り出す（実機に入っている実物の確認用）。 */
export async function getDashboard({ name, app = config.app }) {
    const res = await requestEntity('GET', { name, app, query: '?output_mode=json' });
    if (res.status !== 200) {
        throw new Error(`取得に失敗 (HTTP ${res.status}): ${extractMessage(res.body)}`);
    }
    const eaiData = JSON.parse(res.body).entry?.[0]?.content?.['eai:data'] ?? '';
    const m = eaiData.match(/<definition>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/definition>/);
    return { eaiData, definition: m ? m[1].trim() : null };
}

export async function deleteDashboard({ name, app = config.app }) {
    const res = await requestEntity('DELETE', { name, app });
    if (res.status !== 200) {
        throw new Error(`削除に失敗 (HTTP ${res.status}): ${extractMessage(res.body)}`);
    }
}

/** 静的アセットのキャッシュを飛ばす（Splunk 再起動の代替）。 */
export async function bump() {
    // /_bump は Web 層（8000）のエンドポイントで、管理ポートには無い。
    // Web セッションが要るため、実行は shot.mjs 側（ブラウザ経由）で行う。
    throw new Error('bump は shot.mjs（ブラウザ経由）で行う');
}
