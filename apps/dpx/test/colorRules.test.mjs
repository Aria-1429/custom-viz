// 値→色の変換（gradient / maxContrast）の単体テスト。
// 実行: node test/colorRules.test.mjs
// ⚠ 色の計算は実機で目視しても「合っているか」が判定しづらいので、
//    境界値（最小・最大・同値・非数値）を数値で押さえておく。
import { colorForValue, defaultColorRules, pickTextColor, relativeLuminance, sampleGradient }
  from '../src/main/webapp/components/engine/colorRules.js';
let ng=0; const ok=(c,m)=>{ if(!c){console.log('✗',m);ng++;} else console.log('✓',m); };

// sampleGradient: 両端と中間
console.log('--- gradient ---');
ok(sampleGradient(['#000000','#ffffff'],0)==='#000000','ratio 0 = 先頭色');
ok(sampleGradient(['#000000','#ffffff'],1)==='#ffffff','ratio 1 = 末尾色');
ok(sampleGradient(['#000000','#ffffff'],0.5)==='#808080','ratio .5 = 中間色');
ok(sampleGradient(['#ff0000','#00ff00','#0000ff'],0.5)==='#00ff00','3色の中点=真ん中の色');
ok(sampleGradient([],0.5)===null,'色が無ければ null');
ok(sampleGradient(['#ff0000'],0.7)==='#ff0000','1色なら常にその色');

console.log('--- 値→色（gradient モード）---');
const g={mode:'gradient',colors:['#000000','#ffffff']};
ok(colorForValue(g,0,{min:0,max:100})==='#000000','最小値=先頭色');
ok(colorForValue(g,100,{min:0,max:100})==='#ffffff','最大値=末尾色');
ok(colorForValue(g,50,{min:0,max:100})==='#808080','中央値=中間色');
ok(colorForValue(g,50,{min:50,max:50})==='#808080','全行同値でもゼロ除算しない');
ok(colorForValue(g,'abc',{min:0,max:100})===null,'非数値は null');
ok(colorForValue(g,50)===null,'range 未指定は null（既定色へ）');
ok(colorForValue({...g,min:0,max:200},100,{min:0,max:100})==='#808080','設定の min/max が優先');

console.log('--- maxContrast（文字色の自動選択）---');
ok(pickTextColor('#ffffff')==='#0b1220','白背景 → 黒文字');
ok(pickTextColor('#000000')==='#ffffff','黒背景 → 白文字');
ok(pickTextColor('#fff7b2')==='#0b1220','明るい黄 → 黒文字');
ok(pickTextColor('#0b3d2e')==='#ffffff','濃い緑 → 白文字');
// 単純平均だと緑が過小評価される。係数つきで判定できているか
ok(pickTextColor('#00ff00')==='#0b1220','鮮やかな緑 → 黒文字（輝度係数が効いている）');
ok(pickTextColor('#0000ff')==='#ffffff','青 → 白文字');
ok(pickTextColor('zzz')===null,'解釈できない色は null');
ok(pickTextColor('bad')==='#0b1220','"bad" は妥当な3桁hex(#bbaadd)として扱われる');

console.log('--- 既定設定 ---');
const d=defaultColorRules('gradient');
ok(d.mode==='gradient' && (d.colors||[]).length===3,'gradient の既定は3色');
ok(defaultColorRules('range').mode==='range','range は従来どおり');
ok(defaultColorRules('match').mode==='match','match は従来どおり');

console.log(ng===0?'\n✓ 全て成功':`\n✗ ${ng} 件失敗`);
process.exit(ng?1:0);
