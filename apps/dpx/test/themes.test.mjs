// テーマ／質感の整合テスト。
// 実行: node test/themes.test.mjs
//
// 目視で判定しづらい「配線の欠け」を数値で押さえる:
//   - プリセットを足したのに PALETTES に系列色が無い（midnight に黙って落ちる）
//   - 質感が backgroundImage と `background`（一括）を同時に持つ
//     （一括指定は backgroundImage をリセットする。カギ括弧消失の前科）
//   - ライト／ダークの分類漏れ（ライト地に白文字で消える。実機で前科あり）
import {
    DPX_PRESETS,
    PANEL_VARIANTS,
    groupSurface,
    panelSurface,
    resolveTheme,
} from '../src/main/webapp/components/engine/themes.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

// ── 1. 全プリセットの整合 ──────────────────────────────────────
for (const key of Object.keys(DPX_PRESETS)) {
    const t = resolveTheme({ style: { preset: key } });
    ok(Array.isArray(t.palette) && t.palette.length >= 6, `${key}: 系列色が6色以上ある`);
    // 落ちてないこと（未登録だと midnight のパレットに黙って落ちる）
    ok(
        key === 'midnight' || t.palette !== resolveTheme({ style: { preset: 'midnight' } }).palette,
        `${key}: PALETTES に固有の系列色が登録されている`
    );
    ok(t.colorScheme === 'light' || t.colorScheme === 'dark', `${key}: colorScheme が付く`);
    ok(typeof t.textColor === 'string' && t.textColor.length > 0, `${key}: textColor が定義される`);
}

// ── 2. 手描き系4種の分類（紙＝ライト、黒画用紙＝ダーク） ─────────
ok(resolveTheme({ style: { preset: 'watercolor' } }).colorScheme === 'light', '水彩はライト扱い');
ok(resolveTheme({ style: { preset: 'pencil' } }).colorScheme === 'light', '色鉛筆はライト扱い');
ok(resolveTheme({ style: { preset: 'inkwash' } }).colorScheme === 'light', 'インク＋水彩はライト扱い');
ok(resolveTheme({ style: { preset: 'crayon' } }).colorScheme === 'dark', 'クレヨン（黒画用紙）はダーク扱い');

// ── 3. 全質感 × ライト/ダーク で破綻しない ─────────────────────
const themes = [
    resolveTheme({ style: { preset: 'midnight' } }),
    resolveTheme({ style: { preset: 'watercolor' } }),
];
for (const t of themes) {
    for (const { value } of PANEL_VARIANTS) {
        const s = panelSurface(t, value);
        ok(s && typeof s === 'object', `${t.presetName}/${value}: panelSurface が返る`);
        // ⚠ backgroundImage を持つ質感が `background`（一括）も持つと、
        //   一括側が image をリセットして意匠が消える（実機で踏んだ罠の再発防止）
        ok(
            !(s.backgroundImage && s.background),
            `${t.presetName}/${value}: background(一括) と backgroundImage を併用していない`
        );
    }
}

// ── 4. 新質感4種の意匠が生きている ─────────────────────────────
const wt = resolveTheme({ style: { preset: 'watercolor' } });
const sWater = panelSurface(wt, 'watercolor');
ok(sWater.border === 'none', '水彩: 輪郭線を持たない（にじみの縁だけ）');
ok(String(sWater.boxShadow).includes('inset'), '水彩: エッジの濃まり（inset）がある');
const sCrayon = panelSurface(wt, 'crayon');
ok(/^4px solid /.test(String(sCrayon.border)), 'クレヨン: 蝋の太い縁取り（4px）');
ok(Number(sCrayon.borderRadius) >= 8, 'クレヨン: 角が丸い');
const sPencil = panelSurface(wt, 'pencil');
ok(
    (String(sPencil.backgroundImage).match(/repeating-linear-gradient/g) || []).length >= 2,
    '色鉛筆: クロスハッチ（2方向）がある'
);
ok(/2\.5px 2\.5px/.test(String(sPencil.boxShadow)), '色鉛筆: 二度引きの線（ずれた影）がある');
const sInk = panelSurface(wt, 'inkwash');
ok(/^2px solid /.test(String(sInk.border)), 'インク＋水彩: インクの輪郭線（2px）');
ok(String(sInk.backgroundImage).includes('radial-gradient'), 'インク＋水彩: ウォッシュがある');

// ── 5. 区画（グループ）流用でも壊れない ────────────────────────
for (const v of ['watercolor', 'crayon', 'pencil', 'inkwash']) {
    const g = groupSurface(wt, v);
    ok(g && typeof g === 'object', `区画/${v}: groupSurface が返る`);
}
// 色指定は「もともと線を持つプロパティ」だけを差し替える
const gc = groupSurface(wt, 'crayon', '#ff0000');
ok(gc.border === '4px solid #ff0000', '区画/crayon: 色指定で線の色だけ変わる（幅・種別は不変）');
const gw = groupSurface(wt, 'watercolor', '#ff0000');
ok(gw.border === 'none', '区画/watercolor: 色指定しても線は生えない');

console.log(ng === 0 ? '\nすべて成功' : `\n失敗 ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
