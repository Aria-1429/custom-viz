// 背景エフェクト／出現アニメの配線テスト。
// 実行: node test/backgrounds.test.mjs
//
// ⚠ ここで押さえたい事故は「選択肢と実装のズレ」。どちらも**無言で失敗する**:
//   1. 一覧に足したのに実装が無い → 選ぶと背景が消える（エラーも出ない）
//   2. 実装したのに一覧に無い → 誰も選べない（死にコード）
//   3. 出現アニメの値に対応する @keyframes が無い → アニメが効かず素で出る
//
// ⚠ ソースを**文字列として**読む。BackgroundLayer.jsx は React を import するので
//   素の Node からは実行できない（viewStore と同じ事情）。
import { readFileSync } from 'node:fs';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

const bg = readFileSync(new URL('../src/main/webapp/components/renderer/BackgroundLayer.jsx', import.meta.url), 'utf8');
// ⚠ **アニメの「表」と「@keyframes」は別ファイルに居る**（2026-08-15 に分離）:
//   - 表（ENTRANCE_ANIM / AMBIENT_ANIM）… `rendererConst.js`
//     （Renderer と Panel の両方が使う定数なので共有ファイルへ出した）
//   - @keyframes 本体 …… `DashboardRenderer.jsx`（ダッシュボード全体の global CSS）
//   ファイルを分けたら**このテストの参照先も追う**こと（実際ここが落ちて気づいた）。
const anim = readFileSync(new URL('../src/main/webapp/components/renderer/rendererConst.js', import.meta.url), 'utf8');
const dash = readFileSync(new URL('../src/main/webapp/components/renderer/DashboardRenderer.jsx', import.meta.url), 'utf8');
const insp = readFileSync(new URL('../src/main/webapp/components/builder/Inspector.jsx', import.meta.url), 'utf8');

// ── 背景：選択肢 ↔ 実装 ─────────────────────────────────────
const optBlock = bg.slice(bg.indexOf('BACKGROUND_OPTIONS'), bg.indexOf('];', bg.indexOf('BACKGROUND_OPTIONS')));
const bgValues = [...optBlock.matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
// cssBackgrounds のキー（8スペースのインデント＝オブジェクト直下）
const cssKeys = [...bg.matchAll(/^ {8}([a-zA-Z]+): \{/gm)].map((m) => m[1]);
// canvas シーンの分岐
const canvasKinds = [...bg.matchAll(/kind === '([a-zA-Z]+)'/g)].map((m) => m[1]);
// 手描きの静止画（HAND_DRAWN_BG のキー）
const hdBlock = bg.slice(bg.indexOf('const HAND_DRAWN_BG'), bg.indexOf('};', bg.indexOf('const HAND_DRAWN_BG')));
const handDrawnKinds = [...hdBlock.matchAll(/^ {4}([a-zA-Z]+):/gm)].map((m) => m[1]);

ok(bgValues.length >= 30, `背景の選択肢が30種以上ある（実際 ${bgValues.length}）`);
ok(new Set(bgValues).size === bgValues.length, '背景の value に重複が無い');
ok(bgValues[0] === 'none', '背景の先頭は「なし」');

{
    const impl = new Set([...cssKeys, ...canvasKinds, ...handDrawnKinds, 'none']);
    const missing = bgValues.filter((v) => !impl.has(v));
    ok(missing.length === 0, `全ての選択肢に実装がある（実装なし: ${missing.join(',') || 'なし'}）`);
}
{
    const declared = new Set(bgValues);
    const orphan = [...new Set(cssKeys)].filter((k) => !declared.has(k));
    ok(orphan.length === 0, `一覧に無い実装が残っていない（死にコード: ${orphan.join(',') || 'なし'}）`);
}
{
    // グループ見出しは3種のいずれか（未知のグループは見出しが増えて散らかる）
    const groups = [...new Set([...optBlock.matchAll(/group: '([^']+)'/g)].map((m) => m[1]))];
    const known = ['アニメーション', 'パターン', '手描き', 'グラデーション'];
    ok(groups.every((g) => known.includes(g)), `背景のグループが既知の4種のみ（実際: ${groups.join('/')}）`);
}
{
    // 手描きの背景は「静止画」であること（アニメさせると全面 raster になる）
    ok(handDrawnKinds.length >= 5, `手描きの背景が5種以上ある（実際 ${handDrawnKinds.length}）`);
    ok(
        handDrawnKinds.every((k) => bgValues.includes(k)),
        '手描きの実装が全て一覧に載っている'
    );
    // StaticCanvas（1回だけ描く）を使っていること。requestAnimationFrame を
    // 手描き側で使うと紙が毎フレーム描き直されて重くなる
    ok(bg.includes('function StaticCanvas'), '手描きのために StaticCanvas がある');
}
{
    // ラベルに括弧書きの説明を入れない（v1.9.0 の規約）
    const paren = [...optBlock.matchAll(/label: '([^']*（[^']*)'/g)].map((m) => m[1]);
    ok(paren.length === 0, `背景のラベルに括弧書きが無い（違反: ${paren.join(',') || 'なし'}）`);
}

// ── 出現アニメ：値 ↔ keyframes ↔ 編集パネル ───────────────
const animBlock = anim.slice(anim.indexOf('ENTRANCE_ANIM'), anim.indexOf('};', anim.indexOf('ENTRANCE_ANIM')));
const entranceKeys = [...animBlock.matchAll(/^ {4}([a-zA-Z]+):/gm)].map((m) => m[1]);
const entranceAnims = [...animBlock.matchAll(/'(dpx[A-Za-z]+) /g)].map((m) => m[1]);

ok(entranceKeys.length >= 10, `出現アニメが10種以上ある（実際 ${entranceKeys.length}）`);
{
    // 参照している @keyframes が実在するか
    const missing = entranceAnims.filter((name) => !dash.includes(`@keyframes ${name} `));
    ok(missing.length === 0, `全ての出現アニメに @keyframes がある（欠け: ${missing.join(',') || 'なし'}）`);
}
{
    // 編集パネルの選択肢が ENTRANCE_ANIM に存在するか（none は選択肢だけ）
    const sel = insp.slice(insp.indexOf("value: 'none', label: 'なし'"));
    const block = sel.slice(0, sel.indexOf(']'));
    const uiValues = [...block.matchAll(/value: '([a-zA-Z]+)'/g)].map((m) => m[1]).filter((v) => v !== 'none');
    ok(uiValues.length > 0, '編集パネルから出現アニメの選択肢を読めた');
    const unknown = uiValues.filter((v) => !entranceKeys.includes(v));
    ok(unknown.length === 0, `編集パネルの選択肢が全て実装済み（未実装: ${unknown.join(',') || 'なし'}）`);
}
{
    // ⚠ 動かしてよいのは transform / opacity だけ（面積比例の再描画を避ける）。
    //   filter / box-shadow / background-position を出現アニメに使わない
    const kf = [...dash.matchAll(/@keyframes (dpx(?:Rise|Fade|Zoom|Slide|Flip|Unfold|Drop|Pop|Tilt|Swing)[A-Za-z]*) \{([^}]*\}[^@]*?)(?=@keyframes|';)/g)];
    const bad = kf.filter(([, , body]) => /filter:|box-shadow:|background-position:/.test(body)).map(([, n]) => n);
    ok(bad.length === 0, `出現アニメが transform/opacity 以外を動かしていない（違反: ${bad.join(',') || 'なし'}）`);
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
