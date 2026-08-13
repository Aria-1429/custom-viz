// 手描き画材の実描画（handDrawn.js）のテスト。
// 実行: node test/handDrawn.test.mjs
//
// ⚠ ここで押さえたい事故:
//   1. **乱数が決定的でない** → React の再描画のたびに絵が変わり画面がチラつく。
//      これが一番怖い（実害が「なんとなく画面が落ち着かない」で現れ、原因が特定しにくい）
//   2. 画材のパラメータが欠ける → その画材だけ描画時に落ちる
//   3. 紙の目を濃くしすぎる → デジタルなノイズに見える（試作で実際に失敗した）
import { MEDIUM_PRESETS, isHandDrawn, rng, seedFrom } from '../src/main/webapp/components/engine/handDrawn.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

// ── 決定性（最重要）────────────────────────────────────────
{
    const a = Array.from({ length: 50 }, rng(12345));
    const b = Array.from({ length: 50 }, rng(12345));
    ok(JSON.stringify(a) === JSON.stringify(b), '同じ seed は必ず同じ列を返す（再描画でチラつかない）');
    const c = Array.from({ length: 50 }, rng(12346));
    ok(JSON.stringify(a) !== JSON.stringify(c), 'seed が違えば違う列になる');
    ok(a.every((v) => v >= 0 && v < 1), '値が 0〜1 に収まる');
    // 偏りがひどいと「縞」に見えるので最低限の分布を見る
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    ok(mean > 0.3 && mean < 0.7, `平均が偏っていない（${mean.toFixed(3)}）`);
}
{
    ok(seedFrom('panel-1') === seedFrom('panel-1'), '同じ文字列は同じ seed');
    ok(seedFrom('panel-1') !== seedFrom('panel-2'), '違う文字列は違う seed');
    ok(Number.isInteger(seedFrom('x')) && seedFrom('x') >= 0, 'seed は非負の整数');
    // パネル ID は連番になりがち。隣同士で似た seed になると隣のパネルが同じ絵になる
    const s1 = seedFrom('p1');
    const s2 = seedFrom('p2');
    ok(Math.abs(s1 - s2) > 1000, '連番の ID でも seed が離れる（隣のパネルと同じ絵にならない）');
}

// ── 画材のパラメータ ──────────────────────────────────────
const MEDIA = ['crayon', 'pencil', 'watercolor', 'inkwash'];
for (const m of MEDIA) {
    const cfg = MEDIUM_PRESETS[m];
    ok(Boolean(cfg), `${m}: プリセットがある`);
    ok(cfg.fill && cfg.frame && cfg.line, `${m}: fill / frame / line が揃っている`);
    ok(cfg.fill.alpha > 0 && cfg.fill.alpha < 0.5, `${m}: 塗りの1本は薄い（重ねて濃さを作る）`);
    ok(cfg.fill.gap > 0, `${m}: 塗りの間隔が正`);
    ok(cfg.frame.width > 0, `${m}: 枠の太さが正`);
    // ⚠ 濃い目は「デジタルなノイズ」に見える（試作で失敗）
    ok(cfg.tooth > 0 && cfg.tooth <= 0.15, `${m}: 紙の目が濃すぎない（${cfg.tooth}）`);
}
ok(isHandDrawn('crayon') && !isHandDrawn('noc'), 'isHandDrawn が画材だけを true にする');

// ── 画材ごとの性格が違うこと（全部同じ値なら意味が無い）──────
{
    const c = MEDIUM_PRESETS.crayon;
    const p = MEDIUM_PRESETS.pencil;
    const w = MEDIUM_PRESETS.watercolor;
    ok(c.fill.width > p.fill.width, 'クレヨンは色鉛筆より太い');
    ok(w.fill.alpha < c.fill.alpha, '水彩はクレヨンより薄い');
    ok(w.fill.width > p.fill.width, '水彩は色鉛筆より広く塗る');
    ok(MEDIUM_PRESETS.inkwash.frame.alpha > w.frame.alpha, 'インクは水彩より輪郭がはっきりする');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
