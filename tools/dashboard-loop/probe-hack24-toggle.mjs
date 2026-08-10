// ハック24：トークンを切り替えて、②と③の表示が入れ替わるかを確認する。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';
const S=join(homedir(),'.splunk-dev-session.json'); assertConfig();
const name=process.argv[2]||'hack24_probe', OUT=process.argv[3]||'/tmp/h24';
const b=await chromium.launch({args:['--ignore-certificate-errors']});
const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:700},...(existsSync(S)?{storageState:S}:{})});
const p=await c.newPage();
await p.goto(`${webBase()}/en-US/account/login`,{waitUntil:'domcontentloaded'});
if(await p.locator('input[name="username"]').count()){await p.fill('input[name="username"]',config.user);await p.fill('input[name="password"]',config.pass);await p.click('button[type="submit"], input[type="submit"]').catch(()=>{});await p.waitForLoadState('networkidle').catch(()=>{});}

const shot=async(sev)=>{
  await p.goto(`${webBase()}/en-US/app/${config.app}/${name}?form.sev=${sev}`,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(22000);
  const panels=await p.evaluate(()=>{
    const out=[];
    for(const el of document.querySelectorAll('[data-test="viz-item"]')){
      const t=(el.innerText||'').replace(/\s+/g,' ').trim();
      const r=el.getBoundingClientRect();
      if(t) out.push(t.split(' ')[0].slice(0,20)+` (${Math.round(r.width)}x${Math.round(r.height)})`);
    }
    return [...new Set(out)];
  });
  console.log(`\n=== sev=${sev} で見えているパネル (${panels.length}枚) ===`);
  panels.forEach(x=>console.log('  ', x));
  await p.screenshot({path:`${OUT}_${sev}.png`});
  return panels;
};
const ok=await shot('ok');
const cr=await shot('critical');
console.log('\n================ 判定 ================');
console.log('ok のとき     :', ok.length, '枚');
console.log('critical のとき:', cr.length, '枚');
console.log(JSON.stringify(ok)!==JSON.stringify(cr)
  ? '✓ トークンでパネルの出し隠しが切り替わった'
  : '✗ 変化なし');
await b.close();
