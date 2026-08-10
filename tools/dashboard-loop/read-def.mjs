// ダッシュボード定義を正しく読む（eai:data は XML、JSON は CDATA の中）。
//   node read-def.mjs <dashboard-name> [出力先.json]
import { writeFileSync } from 'node:fs';
import { assertConfig, config, mgmtBase } from './src/config.mjs';
assertConfig();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const name = process.argv[2];
const out = process.argv[3];
const auth = 'Basic ' + Buffer.from(config.user + ':' + config.pass).toString('base64');
const r = await fetch(`${mgmtBase()}/servicesNS/-/${config.app}/data/ui/views/${name}?output_mode=json`,
    { headers: { Authorization: auth } });
if (!r.ok) { console.error('HTTP', r.status); process.exit(1); }
const j = await r.json();
const xml = j.entry?.[0]?.content?.['eai:data'] || '';
const m = xml.match(/<definition>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/definition>/);
const jsonText = m ? m[1] : xml;
let def;
try { def = JSON.parse(jsonText); } catch (e) { console.error('JSON parse 失敗:', e.message); console.log(jsonText.slice(0, 800)); process.exit(1); }
if (out) { writeFileSync(out, JSON.stringify(def, null, 2)); console.error('保存:', out); }
console.log(JSON.stringify(def, null, 1));
