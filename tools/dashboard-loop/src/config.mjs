// 接続設定の読み込み。
//
// 認証情報はリポジトリに置かない（このリポジトリは public）。
// 既定では ~/.splunk-dev.env（chmod 600）から読む。環境変数が優先。
//
//   SPLUNK_HOST=<開発機のIP>
//   SPLUNK_USER=<開発用ユーザー>
//   SPLUNK_PASS=<パスワード>
//   SPLUNK_APP=dev_dashboards        # 省略可
//   SPLUNK_WEB_PORT=8000             # 省略可
//   SPLUNK_MGMT_PORT=8089            # 省略可

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_FILE = process.env.SPLUNK_ENV_FILE || join(homedir(), '.splunk-dev.env');

function parseEnvFile(path) {
    if (!existsSync(path)) return {};
    const out = {};
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // 値を囲む引用符は剥がす
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

const fileEnv = parseEnvFile(ENV_FILE);
const pick = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

const missing = [];
function required(key) {
    const v = pick(key);
    if (!v) missing.push(key);
    return v;
}

export const config = {
    host: required('SPLUNK_HOST'),
    user: required('SPLUNK_USER'),
    pass: required('SPLUNK_PASS'),
    app: pick('SPLUNK_APP', 'dev_dashboards'),
    webPort: Number(pick('SPLUNK_WEB_PORT', '8000')),
    mgmtPort: Number(pick('SPLUNK_MGMT_PORT', '8089')),
    envFile: ENV_FILE,
};

/** 設定が揃っているか検証する。足りなければ、作り方を示して終了する。 */
export function assertConfig() {
    if (missing.length === 0) return config;
    console.error(`✗ 設定が足りません: ${missing.join(', ')}`);
    console.error(`  読んだファイル: ${config.envFile}${existsSync(ENV_FILE) ? '' : '（存在しません）'}`);
    console.error('');
    console.error('  次のように作ってください（認証情報はチャットに貼らないこと）:');
    console.error('');
    console.error(`    cat > ${ENV_FILE} <<'EOF'`);
    console.error('    SPLUNK_HOST=<開発機のIP>');
    console.error('    SPLUNK_USER=<開発用ユーザー>');
    console.error('    SPLUNK_PASS=<パスワード>');
    console.error('    EOF');
    console.error(`    chmod 600 ${ENV_FILE}`);
    process.exit(2);
}

export const mgmtBase = () => `https://${config.host}:${config.mgmtPort}`;
export const webBase = () => `https://${config.host}:${config.webPort}`;
