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
    PRESET_ORDER,
    groupSurface,
    orderedPresets,
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
// ⚠ v1.10.0: 手描き4種の**線は canvas で実描画**に変えた（handDrawn.js）。
//   CSS の border / repeating-linear-gradient では「線がふらつく・二度なぞる・
//   かすれる」が作れず、質感が偽物だったため（ユーザー指摘）。
//   ここで見るのは「CSS の偽の線を持たないこと」と「実描画の指示があること」。
const sCrayon = panelSurface(wt, 'crayon');
ok(sCrayon.border === 'none', 'クレヨン: CSS の偽の縁取りを持たない');
ok(sCrayon.__handDrawn === 'crayon', 'クレヨン: canvas 実描画の指示がある');
ok(Number(sCrayon.borderRadius) >= 8, 'クレヨン: 角が丸い');
const sPencil = panelSurface(wt, 'pencil');
ok(sPencil.border === 'none', '色鉛筆: CSS の偽の輪郭を持たない');
ok(sPencil.__handDrawn === 'pencil', '色鉛筆: canvas 実描画の指示がある');
ok(/2\.5px 2\.5px/.test(String(sPencil.boxShadow)), '色鉛筆: 紙に落ちる影は残っている');
const sInk = panelSurface(wt, 'inkwash');
ok(sInk.border === 'none', 'インク＋水彩: CSS の偽の輪郭を持たない');
ok(sInk.__handDrawn === 'inkwash', 'インク＋水彩: canvas 実描画の指示がある');
ok(/radial-gradient/.test(String(sInk.backgroundImage)), 'インク＋水彩: 淡彩のウォッシュは CSS のまま');
ok(String(sInk.backgroundImage).includes('radial-gradient'), 'インク＋水彩: ウォッシュがある');

// ── 4.5 Liquid Glass（iOS 26） ─────────────────────────────────
ok(resolveTheme({ style: { preset: 'liquidGlass' } }).colorScheme === 'light', 'Liquid Glass はライト扱い（銀地）');
for (const scheme of ['midnight', 'liquidGlass']) {
    const t = resolveTheme({ style: { preset: scheme } });
    const s = panelSurface(t, 'liquidGlass');
    ok(s.border === 'none', `${scheme}/liquidGlass: 枠線ではなく縁の光で見せる`);
    // ダークは blur/saturate を掛けない（滲み対策）ので「レンズフィルタ参照」を本質とする
    ok(
        String(s.backdropFilter).includes('url(#dpx-liquid-lens)'),
        `${scheme}/liquidGlass: レンズフィルタ（屈折＝ガラスの本質）を参照している`
    );
    ok(/inset 0 1(\.5)?px/.test(String(s.boxShadow)), `${scheme}/liquidGlass: 上辺のスペキュラがある`);
    ok(Number(s.borderRadius) >= 20, `${scheme}/liquidGlass: カプセルの大きな丸みを自前で持つ`);
}

// ── 5. 区画（グループ）流用でも壊れない ────────────────────────
for (const v of ['watercolor', 'crayon', 'pencil', 'inkwash']) {
    const g = groupSurface(wt, v);
    ok(g && typeof g === 'object', `区画/${v}: groupSurface が返る`);
}
// 色指定は「もともと線を持つプロパティ」だけを差し替える
// ⚠ crayon はもう CSS の線を持たない（canvas 実描画）ので、
//   色の差し替え検査は**線を持つ質感**で行う
const gc = groupSurface(wt, 'letterpress', '#ff0000');
ok(String(gc.borderTop || gc.border || '').includes('#ff0000'), '区画/letterpress: 色指定で線の色が変わる');
const gw = groupSurface(wt, 'watercolor', '#ff0000');
ok(gw.border === 'none', '区画/watercolor: 色指定しても線は生えない');



// ── 名前と並び順（v1.9.0 で短縮・再編）────────────────────────
//
// ⚠ ここで押さえたい退化は2つ:
//   1. 名前に説明を括弧で足してしまう（「カーボン（無彩色・硬質）」に戻る）。
//      選択肢が18〜25個あるので、括弧付きだと一覧が読めなくなる
//   2. プリセットを足したとき PRESET_ORDER に入れ忘れる（並びが崩れる／消える）
{
    const named = Object.entries(DPX_PRESETS).filter(([, p]) => p.name?.includes('（'));
    ok(named.length === 0, `プリセット名に括弧書きの説明が無い（違反: ${named.map(([k]) => k).join(',')}）`);

    const paren = PANEL_VARIANTS.filter((v) => v.label.includes('（'));
    ok(paren.length === 0, `質感のラベルに括弧書きの説明が無い（違反: ${paren.map((v) => v.value).join(',')}）`);
}
{
    // 並び順の配列と実体がずれていないか
    const missing = Object.keys(DPX_PRESETS).filter((k) => !PRESET_ORDER.includes(k));
    ok(missing.length === 0, `全プリセットが PRESET_ORDER にある（漏れ: ${missing.join(',')}）`);

    const ghost = PRESET_ORDER.filter((k) => !(k in DPX_PRESETS));
    ok(ghost.length === 0, `PRESET_ORDER に実在しないキーが無い（幽霊: ${ghost.join(',')}）`);

    const ordered = orderedPresets();
    ok(ordered.length === Object.keys(DPX_PRESETS).length, 'orderedPresets が全プリセットを返す（1つも落とさない）');
    ok(ordered[0][0] === 'midnight', 'orderedPresets の先頭は midnight（既定値）');
    ok(
        ordered.every(([, p]) => typeof p?.canvasBg === 'string'),
        'orderedPresets の各要素が実体を伴う（[key, preset] の形）'
    );
}
{
    // 並び順に無いキーを混ぜても落とさない（足し忘れの保険が効くか）
    const keys = orderedPresets().map(([k]) => k);
    ok(new Set(keys).size === keys.length, 'orderedPresets が重複を返さない');
}

console.log(ng === 0 ? '\nすべて成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
