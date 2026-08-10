// ハック6 の残件：トークン値の長さ制限を実測する。
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

for (const n of [500, 2000, 8000, 32000]) {
  // n 文字の JSON をトークンに載せて開き、無傷で読めるかを見る
  const payload = JSON.stringify({ hosts: Array.from({length: Math.max(1,Math.floor(n/12))}, (_,i)=>'h'+i) });
  const url = `${webBase()}/en-US/app/${config.app}/hack11_probe?form.sel_json=${encodeURIComponent(payload)}`;
  try {
    await p.goto(url, {waitUntil:'domcontentloaded'});
    await p.waitForTimeout(6000);
    const got = await p.evaluate(()=> new URL(location.href).searchParams.get('form.sel_json'));
    const ok = got === payload;
    let parseOk=false; try{ JSON.parse(got); parseOk=true; }catch(e){}
    console.log(`${String(payload.length).padStart(6)} 文字: ${ok?'✓ 無傷':'✗ 変化/切断 (受信 '+(got?got.length:0)+')'}  parse=${parseOk?'✓':'✗'}`);
  } catch(e) {
    console.log(`${String(payload.length).padStart(6)} 文字: ✗ 例外 ${String(e).slice(0,90)}`);
  }
}
await b.close();
