// ── 層の境界を機械で守る ────────────────────────────────────────
//
// **図に描いた構造を、コードが実際に守っているかを検査する。**
//
// ```
// DPX
// ├─ Dashboard Builder（Palette / Canvas / Property Editor）
// ├─ Dashboard Schema
// ├─ State / Command Layer
// ├─ Layout Engine
// ├─ Visualization Registry
// ├─ Dashboard Renderer
// ├─ Splunk Data / Search Layer
// └─ Design / Material Engine
// ```
//
// ## なぜ「テスト」にするのか
//
// **層の分離はコメントで書いても必ず腐る。** 実際 DPX では
// 「Renderer に編集コードが混ざる」形で 1,600 行まで膨らんだ前科がある。
// 依存の向きは**機械が読める性質**なので、テストで固定する。
//
// ⚠ ここが落ちたときは「テストを直す」のではなく、**まず設計を疑う**。
//   本当に必要な依存なら、この表を意図的に更新して理由を書き添えること。
//
// 実行: node test/layers.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = join(HERE, '../src/main/webapp/components');

let pass = 0;
const test = (name, fn) => {
    try {
        fn();
        pass += 1;
    } catch (err) {
        console.error(`✗ ${name}\n  ${err.message}`);
        process.exitCode = 1;
    }
};

const read = (rel) => readFileSync(join(COMPONENTS, rel), 'utf8');
const exists = (rel) => {
    try {
        return statSync(join(COMPONENTS, rel)) != null;
    } catch {
        return false;
    }
};

/** そのファイルが import しているパスを列挙する。 */
function importsOf(rel) {
    const src = read(rel);
    const out = [];
    const re = /(?:from|import)\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

/** ディレクトリ以下の .js/.jsx を再帰で集める（components からの相対パス）。 */
function filesUnder(rel) {
    const out = [];
    const walk = (dir) => {
        for (const name of readdirSync(join(COMPONENTS, dir))) {
            const child = `${dir}/${name}`;
            if (statSync(join(COMPONENTS, child)).isDirectory()) walk(child);
            else if (/\.jsx?$/.test(name)) out.push(child);
        }
    };
    walk(rel);
    return out;
}

// ── 各層が「実在する」ことを確かめる ─────────────────────────────
//
// 図にあるのにファイルが無い＝絵に描いた餅、を防ぐ。

test('8 つの層がディレクトリ / ファイルとして実在する', () => {
    const layers = {
        'Dashboard Schema': 'schema/index.js',
        'State / Command Layer': 'store/dashboardStore.js',
        'Layout Engine': 'layout/index.js',
        'Visualization Registry': 'viz/registry.js',
        'Studio Extension Adapter': 'viz/extensionAdapter.jsx',
        'Dashboard Renderer': 'renderer/DashboardRenderer.jsx',
        'Splunk Data / Search Layer': 'data/index.js',
        'Design / Material Engine': 'design/index.jsx',
        'Dashboard Canvas': 'canvas/DashboardCanvas.jsx',
        'Component Palette': 'builder/VizPicker.jsx',
        'Property Editor': 'builder/Inspector.jsx',
    };
    for (const [label, path] of Object.entries(layers)) {
        assert.ok(exists(path), `${label} が見つからない: ${path}`);
    }
});

// ── ⭐ Renderer は編集を知らない（今回の再設計の主目的）─────────────

test('⭐ Renderer はストアを import しない（表示専用で使えること）', () => {
    // ストアを読むと、壁掛け・印刷・埋め込みで**ストアごと持ち込む羽目になる**
    const imports = importsOf('renderer/DashboardRenderer.jsx');
    const bad = imports.filter((i) => i.includes('store/'));
    assert.deepEqual(bad, [], `Renderer がストアに依存している: ${bad.join(', ')}`);
});

test('⭐ Renderer にドラッグの実装が残っていない（Canvas 層の担当）', () => {
    const src = read('renderer/DashboardRenderer.jsx');
    // pointermove の購読＝ドラッグを自分で実装している証拠
    assert.ok(
        !src.includes("addEventListener('pointermove'"),
        'Renderer にドラッグ実装が残っている（canvas/useCanvasInteractions.js へ）'
    );
});

// ── ⭐ Renderer の内部分割（2026-08-15）──────────────────────────
//
// **「1 枚をどう描くか」と「どう並べるか」を分ける。**
// 分割前は 1 ファイルに同居していたが、共有していたのは寸法とアニメ表の
// 定数だけで、状態の共有はゼロだった（＝元から独立していた）。

test('⭐ Panel が Renderer を import しない（循環参照を作らない）', () => {
    const bad = importsOf('renderer/Panel.jsx').filter((i) => i.includes('DashboardRenderer'));
    assert.deepEqual(bad, [], `Panel が Renderer に依存している: ${bad.join(', ')}`);
});

test('⭐ Renderer が Panel の中身（サーチ・viz 解決）を知らない', () => {
    // パネル 1 枚の関心（どのサーチを流し、どの viz を描くか）は Panel の担当。
    // ここが戻ると「並べる」と「描く」がまた混ざる。
    const imports = importsOf('renderer/DashboardRenderer.jsx');
    const bad = imports.filter((i) => i.includes('viz/registry') || i.includes('viz/panelFields'));
    assert.deepEqual(bad, [], `Renderer が viz の解決を抱えている: ${bad.join(', ')}`);
});

test('⭐ 寸法・アニメ表の定数が 1 か所（両ファイルに数値を書かない）', () => {
    // 片方だけ直して罫や余白がずれる事故を防ぐ。実際 GROUP_HEADER_H が
    // 2 か所に書かれていて、危うく同じ事故になりかけた。
    for (const name of ['TITLE_H', 'HAND_DRAWN_INSET', 'FULL_INSET', 'ENTRANCE_ANIM', 'AMBIENT_ANIM']) {
        const re = new RegExp(`^(?:export )?const ${name}\\s*=`, 'm');
        const dupes = ['renderer/DashboardRenderer.jsx', 'renderer/Panel.jsx', 'renderer/rendererConst.js']
            .filter((f) => re.test(read(f)));
        assert.deepEqual(dupes, ['renderer/rendererConst.js'], `${name} の定義が rendererConst.js 以外にある: ${dupes.join(', ')}`);
    }
    // GROUP_HEADER_H は tabLayout.js（行テンプレートを組む側）が持つ
    const ghDefs = ['renderer/DashboardRenderer.jsx', 'renderer/tabLayout.js']
        .filter((f) => /^export const GROUP_HEADER_H\s*=|^const GROUP_HEADER_H\s*=/m.test(read(f)));
    assert.deepEqual(ghDefs, ['renderer/tabLayout.js'], `GROUP_HEADER_H の定義が重複: ${ghDefs.join(', ')}`);
});

test('⭐ タブの生存判定・レイアウト解決は React に依存しない（純粋関数）', () => {
    // 素の Node でテストできることが、方針（LRU 上限・消えたタブの掃除・
    // 見出し行の挿し込み）を機械で固定できる根拠になっている。
    for (const f of ['renderer/tabLifecycle.js', 'renderer/tabLayout.js']) {
        assert.ok(!importsOf(f).includes('react'), `${f} が React に依存している`);
    }
});

test('Canvas 層が Renderer を使う（依存の向きが逆になっていない）', () => {
    const imports = importsOf('canvas/DashboardCanvas.jsx');
    assert.ok(
        imports.some((i) => i.includes('DashboardRenderer')),
        'Canvas が Renderer を使っていない'
    );
    // 逆向き（Renderer → DashboardCanvas）が無いこと
    const back = importsOf('renderer/DashboardRenderer.jsx').filter((i) => i.includes('DashboardCanvas'));
    assert.deepEqual(back, [], 'Renderer が Canvas を import している（依存が循環する）');
});

// ── Data 層の境界 ───────────────────────────────────────────────

test('⭐ Data 層の中身へ直接 import していない（必ず barrel を通す）', () => {
    // 直接 import が増えると、層の入れ替え・実装変更がどこに響くか読めなくなる
    const offenders = [];
    for (const f of filesUnder('.')) {
        if (f.startsWith('engine/data/')) continue; // 層の内部は自由
        for (const i of importsOf(f)) {
            if (/(^|\/)data\/(useSplunkSearch|dataSources|inputChoices)$/.test(i)) {
                offenders.push(`${f} → ${i}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `barrel を通さない import: ${offenders.join(' / ')}`);
});

test('Data 層は viz / 描画を知らない（サーチの実行だけを担う）', () => {
    for (const f of filesUnder('data')) {
        const bad = importsOf(f).filter(
            (i) => i.includes('vizRegistry') || i.includes('nativeViz') || i.includes('themes')
        );
        assert.deepEqual(bad, [], `${f} が描画層に依存している: ${bad.join(', ')}`);
    }
});

// ── Schema / Layout / Design の独立性 ───────────────────────────

test('⭐ Schema は React にも他の層にも依存しない（純粋なデータ定義）', () => {
    for (const f of filesUnder('schema')) {
        const bad = importsOf(f).filter(
            (i) => i === 'react' || i.includes('/engine/') || i.includes('store/')
        );
        assert.deepEqual(bad, [], `${f} が他層に依存している: ${bad.join(', ')}`);
    }
});

test('Layout Engine は React に依存しない（純粋関数でテストできること）', () => {
    for (const f of filesUnder('layout')) {
        assert.ok(!importsOf(f).includes('react'), `${f} が React に依存している`);
    }
});

test('Motion Engine は依存ゼロ（素の Node でテストできること）', () => {
    assert.deepEqual(importsOf('design/motion.js'), []);
});

// ── Registry ────────────────────────────────────────────────────

test('⭐ 生成物を手で編集していない（再生成で消える変更を防ぐ）', () => {
    const src = read('viz/registry.generated.js');
    assert.ok(src.includes('自動生成'), '生成物の警告コメントが消えている');
});

test('Registry 経由でしか viz を引かない（Renderer が viz を直接知らない）', () => {
    const imports = importsOf('renderer/DashboardRenderer.jsx');
    const bad = imports.filter((i) => i.includes('vizRegistry.generated'));
    assert.deepEqual(bad, [], 'Renderer が生成物を直接見ている（vizRegistry を通すこと）');
});

// ── ⚠ テキストとして読めること（過去に踏んだ罠）──────────────────

test('⚠ ソースに制御文字が混入していない（grep が効かなくなる）', () => {
    // 生の NUL をセパレータに書いてファイルがバイナリ扱いになり、
    // grep が全滅した前科がある（dataSources.js / sankey-flow）。
    const offenders = [];
    for (const f of filesUnder('.')) {
        const buf = readFileSync(join(COMPONENTS, f));
        for (const b of buf) {
            if (b < 9 || b === 11 || b === 12 || (b >= 14 && b <= 31)) {
                offenders.push(f);
                break;
            }
        }
    }
    assert.deepEqual(offenders, [], `制御文字が混入: ${offenders.join(', ')}`);
});


// ── ⭐ viz の契約（Viz SDK）─────────────────────────────────────
//
// **viz を足すときに見る場所を 1 つに保つ**ための検査。
// これが崩れると「既存 viz を読んで真似する」しか方法が無くなる。

/**
 * viz **本体**のファイルか。
 *
 * ⚠ `viz/` には SDK 本体と **Registry / Adapter** も居る。
 *   - `registry.js` … 全 viz を束ねるので当然 viz を import する
 *   - `registry.generated.js` … リポジトリ外の 30 viz を指す（生成物）
 *   - `extensionAdapter.jsx` … ホスト側の橋渡しなので shared に触れてよい
 *   これらに SDK 規則を掛けると「当たり前の依存」を違反と報告してしまう。
 */
const isVizComponent = (f) =>
    !['viz/index.js', 'viz/data.js', 'viz/kit.js', 'viz/types.js',
      'viz/registry.js', 'viz/registry.generated.js', 'viz/extensionAdapter.jsx',
      'viz/colorRules.js', 'viz/scale.js', 'viz/timeBrush.js',
      'viz/parts.jsx', 'viz/panelFields.jsx'].includes(f);

test('⭐ viz は Viz SDK だけを見る（他層の内部を直接 import しない）', () => {
    const offenders = [];
    for (const f of filesUnder('viz')) {
        if (!isVizComponent(f)) continue;
        for (const i of importsOf(f)) {
            if (i === 'react' || i === '.' || i === '..') continue;
            if (i.startsWith('./') && !f.includes('/native/')) continue; // 層内の相対は可
            if (f.includes('/native/') && (i === '..' || i.startsWith('./'))) continue;
            // engine の別モジュールを掘っていないか
            if (/\.\.\/(?!\.)/.test(i) && !i.startsWith('../viz')) {
                offenders.push(`${f} → ${i}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `viz が SDK を迂回している: ${offenders.join(' / ')}`);
});

test('⭐ viz は Builder（Inspector / Canvas）を知らない', () => {
    // かつて nativeViz.jsx が optionEditors.jsx（Property Editor）から
    // dosToField を import していた（層違反）。同じことを繰り返さない。
    const offenders = [];
    for (const f of filesUnder('viz')) {
        for (const i of importsOf(f)) {
            if (/optionEditors|Inspector|VizPicker|EditToolbar/.test(i)) {
                offenders.push(`${f} → ${i}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `viz が Builder に依存している: ${offenders.join(' / ')}`);
});

test('viz はストアを知らない', () => {
    const offenders = [];
    for (const f of filesUnder('viz')) {
        for (const i of importsOf(f)) {
            if (i.includes('store/')) offenders.push(`${f} → ${i}`);
        }
    }
    assert.deepEqual(offenders, [], `viz がストアに依存している: ${offenders.join(' / ')}`);
});

test('Viz SDK は viz を import しない（循環を作らない）', () => {
    const bad = importsOf('viz/index.js').filter(
        (i) => i.includes('native') || i.includes('Dpx') || i.includes('shapes') || i.includes('deco')
    );
    assert.deepEqual(bad, [], `SDK が viz を import している: ${bad.join(', ')}`);
});

test('1 viz = 1 ファイル（ネイティブ viz が再び 1 枚に戻っていない）', () => {
    const files = filesUnder('viz/native').filter((f) => f.endsWith('.jsx'));
    assert.ok(files.length >= 7, `ネイティブ viz のファイルが少ない: ${files.length}`);
    for (const f of files) {
        const n = read(f).split('\n').length;
        assert.ok(n < 1000, `${f} が ${n} 行（分割を検討する）`);
    }
});

// ── ⭐ Theme / Surface の分離 ───────────────────────────────────

test('⭐ Theme と Surface が別ファイルとして実在する', () => {
    assert.ok(exists('design/theme/index.js'), 'Theme の実体が無い');
    assert.ok(exists('design/surface/index.js'), 'Surface の実体が無い');
});

test('Surface は React に依存しない（純粋にスタイルを作る）', () => {
    assert.ok(!importsOf('design/surface/index.js').includes('react'));
});



// ── ⭐ 再編成後の構造（engine/ を廃止した）─────────────────────────

test('⭐ engine/ が復活していない（層で分けたことの担保）', () => {
    // 以前は `engine/` 直下に 31 ファイルが平置きで、層と雑多が混ざっていた。
    assert.ok(!exists('engine'), 'engine/ が復活している（層のどこかへ置くこと）');
});

test('⭐ トップレベルが図の層と一致する', () => {
    const dirs = readdirSync(COMPONENTS).filter((n) =>
        statSync(join(COMPONENTS, n)).isDirectory()
    );
    const expected = [
        'builder', 'canvas', 'data', 'design', 'layout',
        'pages', 'renderer', 'schema', 'shared', 'store', 'viz',
    ];
    assert.deepEqual(dirs.sort(), expected.sort(), 'トップレベルの層が図とズレている');
});

test('⭐ Design Engine の 4 軸すべてが design/ 配下に実体を持つ', () => {
    // Brush だけ material/ に残っていた時期があり、「Material Engine と
    // Design Engine の 2 つがある」ように見えていた。
    for (const p of [
        'design/theme/index.js',
        'design/surface/index.js',
        'design/brush/index.jsx',
        'design/brush/filter.jsx',
        'design/motion.js',
    ]) {
        assert.ok(exists(p), `Design Engine の実体が無い: ${p}`);
    }
    assert.ok(!exists('material'), 'material/ が残っている（design/ へ寄せる）');
});

test('viz が Renderer / Builder を import しない（描画の向きが逆にならない）', () => {
    const offenders = [];
    for (const f of filesUnder('viz')) {
        if (!isVizComponent(f)) continue;
        for (const i of importsOf(f)) {
            if (/renderer\/|builder\//.test(i)) offenders.push(`${f} → ${i}`);
        }
    }
    assert.deepEqual(offenders, [], `viz が上位層に依存: ${offenders.join(' / ')}`);
});

console.log(`layers: ${pass} tests passed`);
