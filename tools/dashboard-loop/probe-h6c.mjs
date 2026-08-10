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
// 実際に dispatch された SPL を REST で読む（真実はここにある）
const blob=encodeURIComponent('{"hosts":["web-01","web-02"],"n":2,"q":"a&b=c d"}');
await p.goto(`${webBase()}/en-US/app/${config.app}/hack11_probe?form.sel_metric=cpu&form.sel_json=${blob}`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(24000);
// splunkd の直近ジョブから echo パネルの SPL を探す
const jobs = await p.evaluate(async () => {
  const r = await fetch('/en-US/splunkd/__raw/services/search/jobs?output_mode=json&count=25&sort_key=published&sort_dir=desc');
  if(!r.ok) return {err:r.status};
  const j = await r.json();
  return j.entry.map(e=>({search:(e.content.eventSearch||e.content.search||'').slice(0,220), state:e.content.dispatchState, msg:JSON.stringify(e.content.messages||'').slice(0,200)}))
           .filter(x=>x.search.includes('json_tok')||x.search.includes('json_len'));
});
console.log(JSON.stringify(jobs,null,1).slice(0,2500));
await b.close();
