// ハック6 の本命：viz 側（useTokens）が JSON トークンを壊れずに受け取れるか。
// SPL に埋めると eval が壊れるのは分かった。では viz が読む分には無傷か？
import { chromium } from 'playwright';
import { existsSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const S=join(homedir(),'.splunk-dev-session.json');
const b=await chromium.launch({args:['--ignore-certificate-errors']});
const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:900},...(existsSync(S)?{storageState:S}:{})});
const p=await c.newPage();
await p.goto(`${webBase()}/en-US/account/login`,{waitUntil:'domcontentloaded'});
if(await p.locator('input[name="username"]').count()){await p.fill('input[name="username"]',config.user);await p.fill('input[name="password"]',config.pass);await p.click('button[type="submit"]');await p.waitForLoadState('networkidle').catch(()=>{});}
await p.goto(`${webBase()}/en-US/app/${config.app}/hack11_probe`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(20000);

// 合成クリックで JSON トークンを飛ばす
const vf=p.frames().find(f=>f!==p.mainFrame());
await vf.evaluate(()=>{
  const s=[...document.querySelectorAll('svg')].filter(e=>{const r=e.getBoundingClientRect();return r.width>150&&r.height>80;});
  const r=s[0].getBoundingClientRect();
  (document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)||s[0])
    .dispatchEvent(new MouseEvent('click',{view:window,bubbles:true,cancelable:true,button:0}));
});
await p.waitForTimeout(8000);

// URL のトークン値を厳密に取り出して、JSON.parse できるかを確かめる
const res = await p.evaluate(() => {
  const u = new URL(location.href);
  const raw = u.searchParams.get('form.sel_json');
  let parsed=null, err=null;
  try { parsed = JSON.parse(raw); } catch(e){ err=String(e); }
  return { raw, parsed, err, len: raw ? raw.length : 0 };
});
console.log('URL 上のトークン値:', JSON.stringify(res.raw));
console.log('長さ:', res.len);
console.log('JSON.parse:', res.err ? '✗ '+res.err : '✓ 成功 -> '+JSON.stringify(res.parsed));
console.log('特殊文字の保存:',
  res.raw && res.raw.includes('a&b=c d') ? '✓ & = 空白すべて無傷' : '✗ 壊れた');
await b.close();
