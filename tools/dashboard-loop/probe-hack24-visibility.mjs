// ハック24 決定版：Studio ネイティブの「表示条件」機能の実体を抜く。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';
const S=join(homedir(),'.splunk-dev-session.json'); assertConfig();
const b=await chromium.launch({args:['--ignore-certificate-errors']});
const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:900},...(existsSync(S)?{storageState:S}:{})});
const p=await c.newPage();
const scripts=[];
p.on('response',async r=>{ if(!/\.js(\?|$)/.test(r.url()))return; try{scripts.push(await r.text());}catch{} });
await p.goto(`${webBase()}/en-US/account/login`,{waitUntil:'domcontentloaded'});
if(await p.locator('input[name="username"]').count()){await p.fill('input[name="username"]',config.user);await p.fill('input[name="password"]',config.pass);await p.click('button[type="submit"]');await p.waitForLoadState('networkidle').catch(()=>{});}
await p.goto(`${webBase()}/en-US/app/${config.app}/${process.argv[2]||'hack15_probe'}`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(20000);
await p.click('button:has-text("Edit"), a:has-text("Edit")').catch(()=>{});
await p.waitForTimeout(12000);
const all=scripts.join('\n');
for(const kw of ['hideConditions','showConditions','showConditionsEditor','"conditions"']){
  console.log(`\n===== ${kw} =====`);
  let idx=all.indexOf(kw), n=0;
  while(idx>=0 && n<3){
    console.log('…'+all.slice(Math.max(0,idx-350),idx+450).replace(/\s+/g,' ')+'…\n');
    idx=all.indexOf(kw,idx+400); n++;
  }
  if(!n) console.log('(なし)');
}
await b.close();
