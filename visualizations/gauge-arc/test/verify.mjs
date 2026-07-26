// Gauge Arc viz のローカル検証（happy-dom、Splunk実機なし）
//
// 検証できるのは「options / data が渡ったときに viz が正しく描くか」まで。
// 編集画面に editor UI が実際に出るかは実機でしか確認できない。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_gauge_arc', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
let VW = 900;
let VH = 400;

const win = new Window({ width: VW, height: VH });
const doc = win.document;
globalThis.window = win;
globalThis.document = doc;
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
globalThis.HTMLElement = win.HTMLElement;
globalThis.SVGElement = win.SVGElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.MouseEvent = win.MouseEvent;
globalThis.CustomEvent = win.CustomEvent;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now ? performance.now() : 16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

// コンテナ実寸（リサイズ検証のため getter で可変にする）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH, configurable: true });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};

const observers = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;

async function resize(w, h) {
    VW = w; VH = h;
    observers.forEach((o) => o.cb([]));
    await settle();
}

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [], tokens: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

// 既定データ: 時系列の CPU 使用率（最終行 87 = 危険帯、直前 72 = 警告帯）
const FIELDS = [{ name: '_time' }, { name: 'cpu' }];
const ROWS = [
    ['10:00', '41'],
    ['10:05', '55'],
    ['10:10', '63'],
    ['10:15', '72'],
    ['10:20', '87'],
];

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
    mode: 'view',
    tokens: {
        env: { user: 'admin', app: 'search' },
        submitted: { 'global_time.earliest': '-24h@h', 'global_time.latest': 'now' },
    },
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: VW, height: VH }),
    addDimensionsListener: mkListener('dimensions'),
    getMode: () => ({ mode: state.mode }),
    addModeListener: mkListener('mode'),
    // 実際の getTokens は TokensState = { tokens: Tokens } を返す（型定義で確認）
    getTokens: () => ({ tokens: state.tokens }),
    addTokensListener: mkListener('tokens'),
    setToken: () => {},
    getError: () => null,
    addErrorListener: () => () => {},
    drilldown: () => {},
    addDrilldownListener: () => {},
    triggerDrilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));

// 既定のアニメーション（0.9秒）が終わるまで DOM を読むと途中の値を拾ってしまう。
// 「中央の値の表示が変化しなくなる」まで待ってから検査する。
async function settle(maxMs = 3000) {
    let last = null;
    let stable = 0;
    let sawContent = false;
    for (let waited = 0; waited < maxMs; waited += 60) {
        await sleep(60);
        const valueEl = doc.querySelector('[data-role="value"]');
        const marks = [...doc.querySelectorAll('[data-role="fill"],[data-role="segment"],[data-role="tacho-band"]')];
        // ガード表示（データなし等）に落ちている場合は待っても変わらないので抜ける
        const guarded = !valueEl && (doc.body.textContent || '').includes('データがありません');
        if (guarded) return;
        // 初回マウント前は DOM が空。空のまま「安定した」と誤判定しないよう待ち続ける
        if (valueEl && marks.length > 0) sawContent = true;
        if (!sawContent) continue;
        const now = (valueEl?.textContent || '') + '|' + marks.map((m) => m.getAttribute('fill')).join(',');
        // 中央の値は初回から目標値を表示する（アニメーションするのは弧だけ）ため、
        // 値だけ見ると 200ms 程度で「安定」に見えてしまう。弧が伸び切るまで見るので
        // 連続一致の回数は多めに取る。
        if (now === last) {
            stable += 1;
            if (stable >= 8) return;
        } else {
            stable = 0;
            last = now;
        }
    }
}

const setOpts = async (o) => {
    state.options = o;
    fire('options', { options: state.options });
    await settle();
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await settle();
};

const q = (sel) => doc.querySelector(sel);
const qa = (sel) => [...doc.querySelectorAll(sel)];
const text = () => doc.body.textContent || '';
const valueText = () => (q('[data-role="value"]')?.textContent || '').trim();

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);
await settle();

console.log('\n=== 1. 基本描画（既定オプション） ===');
check('SVG が描かれる', qa('svg').length > 0);
check('中央に値が出る（最終行 87）', valueText().includes('87'), `got="${valueText()}"`);
check('トラックが描かれる', !!q('[data-role="track"]'));
check('連続の塗りが描かれる', qa('[data-role="fill"]').length > 0);
check('セグメントは描かれない（既定は連続）', qa('[data-role="segment"]').length === 0);
check('サブパネルが出る', !!q('[data-role="panel"]'));

console.log('\n=== 2. 円弧パスの妥当性（NaN 混入がないこと） ===');
const allPaths = qa('path').map((p) => p.getAttribute('d') || '');
check('path の d に NaN/undefined が無い', allPaths.every((d) => !/NaN|undefined/.test(d)),
    allPaths.filter((d) => /NaN|undefined/.test(d)).slice(0, 2).join(' | '));
check('塗りパスが閉じている（Z で終わる）', qa('[data-role="fill"]').every((p) => (p.getAttribute('d') || '').trim().endsWith('Z')));

console.log('\n=== 3. 帯による色分け（threshold） ===');
// 87 は既定帯の 85+ = 危険（#ef4444）
const fillColors = qa('[data-role="fill"]').map((p) => p.getAttribute('fill'));
check('最終区間が危険色 #ef4444', fillColors.includes('#ef4444'), `got=${JSON.stringify(fillColors)}`);
check('低い帯（緑）も塗られている（帯ごとに分割）', fillColors.includes('#22c55e'), `got=${JSON.stringify(fillColors)}`);
// 帯のバッジ（例 "80 +"）はゲージ外の境界値と冗長なので既定は非表示（v1.2.1）
check('帯のバッジは既定で出ない', !q('[data-role="band-label"]'));
await setOpts({ showBandLabel: true });
check('帯のバッジは明示的に ON にすれば出る', !!q('[data-role="band-label"]'));
check('ON にした帯のバッジは該当範囲を表す', (q('[data-role="band-label"]')?.textContent || '').includes('85'),
    q('[data-role="band-label"]')?.textContent);
await setOpts({});

await setOpts({ colorBands: [{ from: null, to: 200, value: '#00ccff' }] });
check('帯を1段に変えると全部その色', qa('[data-role="fill"]').every((p) => p.getAttribute('fill') === '#00ccff'));

await setOpts({ colorMode: 'fixed', fixedColor: '#ff00ff' });
check('単色モードで fixedColor が使われる', qa('[data-role="fill"]').some((p) => p.getAttribute('fill') === '#ff00ff'));

console.log('\n=== 4. ゲージの種類の切り替え ===');
await setOpts({ gaugeStyle: 'segmented', segmentCount: 20 });
const segs = qa('[data-role="segment"]');
check('セグメントが描かれる', segs.length > 0, `n=${segs.length}`);
check('セグメント数がほぼ指定どおり', Math.abs(segs.length - 20) <= 1, `n=${segs.length}`);
check('連続の塗りは消える', qa('[data-role="fill"]').length === 0);
const lit = segs.filter((s) => s.getAttribute('data-lit') === '1');
check('点灯セグメントがある', lit.length > 0, `lit=${lit.length}`);
check('消灯セグメントもある（87/100 なので全点灯ではない）', lit.length < segs.length, `lit=${lit.length}/${segs.length}`);
// 87% なので 20 分割中およそ 17 個が点灯するはず
check('点灯数が値に比例する（87% ≒ 17/20）', Math.abs(lit.length - 17) <= 1, `lit=${lit.length}`);

await setOpts({ gaugeStyle: 'segmented', segmentCount: 20, litMode: 'current' });
const litCur = qa('[data-role="segment"]').filter((s) => s.getAttribute('data-lit') === '1');
const litColors = new Set(litCur.map((s) => s.getAttribute('fill')));
check('litMode=current で点灯色が1色に統一される', litColors.size === 1, `colors=${[...litColors]}`);

await setOpts({ gaugeStyle: 'segmented', segmentCount: 20, litMode: 'band' });
const litBand = qa('[data-role="segment"]').filter((s) => s.getAttribute('data-lit') === '1');
check('litMode=band で点灯色が複数になる', new Set(litBand.map((s) => s.getAttribute('fill'))).size > 1);

console.log('\n=== 5. 前回との比較 ===');
await setOpts({});
// 最終 87 / 直前 72 → +15 (+20.8%)
const dText = q('[data-role="delta"]')?.textContent || '';
check('差分が表示される', dText.length > 0);
check('差分の値が +15', dText.includes('15'), `got="${dText}"`);
check('差分の割合が約 20.8%', dText.includes('20.8'), `got="${dText}"`);
check('増加なので良い色（緑 #22c55e）', (q('[data-role="delta"]')?.getAttribute('style') || '').includes('34, 197, 94')
    || (q('[data-role="delta"]')?.getAttribute('style') || '').includes('#22c55e'),
    q('[data-role="delta"]')?.getAttribute('style'));

await setOpts({ goodDirection: 'down' });
const dStyle = q('[data-role="delta"]')?.getAttribute('style') || '';
check('goodDirection=down では増加が悪い色（赤）', dStyle.includes('239, 68, 68') || dStyle.includes('#ef4444'), dStyle);

await setOpts({ deltaFormat: 'percent' });
check('deltaFormat=percent では割合のみ', !(q('[data-role="delta"]')?.textContent || '').includes('15'),
    q('[data-role="delta"]')?.textContent);

await setOpts({ compareMode: 'first' });
// 最終 87 / 先頭 41 → +46
check('compareMode=first で先頭行と比較', (q('[data-role="delta"]')?.textContent || '').includes('46'),
    q('[data-role="delta"]')?.textContent);

await setOpts({ compareMode: 'fixed', compareValue: 100 });
// 87 - 100 = -13
check('compareMode=fixed で固定値と比較', (q('[data-role="delta"]')?.textContent || '').includes('13'),
    q('[data-role="delta"]')?.textContent);

await setOpts({ compareMode: 'none' });
check('compareMode=none では比較対象なし表記', (text().includes('比較対象がありません')),
    q('[data-role="delta"]')?.textContent);

console.log('\n=== 6. 値の決め方（集計） ===');
await setOpts({ aggMode: 'sum' });     // 41+55+63+72+87 = 318
check('合計 318', valueText().includes('318'), valueText());
await setOpts({ aggMode: 'avg' });     // 63.6
check('平均 64（小数0桁）', valueText().includes('64'), valueText());
await setOpts({ aggMode: 'max' });
check('最大 87', valueText().includes('87'), valueText());
await setOpts({ aggMode: 'min' });
check('最小 41', valueText().includes('41'), valueText());
await setOpts({ aggMode: 'count' });
check('件数 5', valueText().includes('5'), valueText());
await setOpts({ aggMode: 'first' });
check('先頭 41', valueText().includes('41'), valueText());

console.log('\n=== 7. サブ情報パネルのスロット ===');
await setOpts({ slot1: 'stats', slot2: 'breakdown', slot3: 'ranking', slot4: 'legend' });
check('サブ指標が出る', qa('[data-role="stat"]').length > 0);
check('内訳が出る', qa('[data-role="breakdown"]').length > 0);
check('ランキングが出る', qa('[data-role="rank"]').length > 0);
check('凡例が出る（帯 3 段）', text().includes('凡例'));

await setOpts({ slot1: 'sparkline', slot2: 'none', slot3: 'none', slot4: 'none' });
check('スパークラインが出る', !!q('[data-role="sparkline"]'));
const spd = q('[data-role="sparkline"] path')?.getAttribute('d') || '';
check('スパークラインの d が正しい', spd.startsWith('M') && !/NaN/.test(spd), spd.slice(0, 40));

await setOpts({ slot1: 'target', targetValue: 100, showTarget: true });
check('目標スロットが出る', !!q('[data-role="target-rate"]'));
check('達成率 87.0%', (q('[data-role="target-rate"]')?.textContent || '').includes('87.0'),
    q('[data-role="target-rate"]')?.textContent);
check('ゲージ上に目標線が引かれる', !!q('[data-role="target"]'));

await setOpts({ slot1: 'period', slot2: 'none', slot3: 'none', slot4: 'none' });
check('期間スロットにトークンの時間レンジが出る', text().includes('-24h@h'), text().slice(0, 200));

await setOpts({ slot1: 'note', noteText: 'メモです', slot2: 'none', slot3: 'none', slot4: 'none' });
check('自由テキストが出る', text().includes('メモです'));

await setOpts({ panelPosition: 'none' });
check('パネルなしにできる', !q('[data-role="panel"]'));
check('パネルなしでも比較が中央下に出る', !!q('[data-role="delta-inline"]'));

console.log('\n=== 8. 範囲・目盛り・装飾 ===');
await setOpts({ minValue: 0, maxValue: 200 });
check('最大値 200 のラベルが出る', text().includes('200'));
await setOpts({ autoScale: true });
// データは 41..87
check('autoScale でデータ範囲が使われる', text().includes('41') && text().includes('87'), text().slice(0, 200));

await setOpts({ showTicks: false, showRangeLabels: false, showTrack: false });
check('目盛りを消せる', qa('line').filter((l) => l.getAttribute('stroke-linecap') === 'round').length === 0
    || !q('[data-role="track"]'));
check('トラックを消せる', !q('[data-role="track"]'));

await setOpts({ showNeedle: true });
check('針を出せる', !!q('[data-role="needle"]'));

await setOpts({ sweepAngle: 180 });
check('開き角 180 でも NaN が出ない', qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));
await setOpts({ sweepAngle: 320 });
check('開き角 320 でも NaN が出ない', qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));
await setOpts({ sweepAngle: '240' });
check('開き角が文字列で届いても動く', qa('path').length > 0 && qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));

console.log('\n=== 9. 単位・桁・タイトル ===');
await setOpts({ unitText: '%', titleText: 'CPU 使用率', decimals: 1 });
check('単位が出る', text().includes('%'));
check('タイトルが出る', text().includes('CPU 使用率'));
check('小数1桁になる', valueText().includes('87.0'), valueText());
await setOpts({ compactNumbers: true });
await setData({ fields: FIELDS, rows: [['a', '1500000'], ['b', '2400000']] });
check('省略表記 2.4M', valueText().includes('2.4M'), valueText());

console.log('\n=== 10. ガードと異常データ ===');
await setOpts({});
await setData({ fields: FIELDS, rows: [] });
check('空データでメッセージ', text().includes('データがありません'));

await setData({ fields: FIELDS, rows: [['a', 'xyz'], ['b', '-']] });
check('数値が無い場合もメッセージ', text().includes('データがありません'));

// columns 形式（rows が空でも落とさない）
await setData({ fields: FIELDS, columns: [['x', 'y', 'z'], ['10', '20', '30']] });
check('columns 形式で描画できる', valueText().includes('30'), valueText());

// 1列だけ
await setData({ fields: [{ name: 'v' }], rows: [['12'], ['34']] });
check('1列データでも描画できる', valueText().includes('34'), valueText());

// カンマ付き数値
await setData({ fields: FIELDS, rows: [['a', '1,234'], ['b', '2,345']] });
check('カンマ付き数値を読める', valueText().includes('2,345'), valueText());

// マルチバリューセル
await setData({ fields: FIELDS, rows: [[['a', 'b'], ['10', '20']]] });
check('マルチバリューを平行展開して落ちない', qa('svg').length > 0);

// 全て同値（autoScale で範囲が潰れないこと）
await setOpts({ autoScale: true });
await setData({ fields: FIELDS, rows: [['a', '50'], ['b', '50']] });
check('全同値 + autoScale でも NaN が出ない', qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));

// 負の値
await setOpts({});
await setData({ fields: FIELDS, rows: [['a', '-30'], ['b', '-10']] });
check('負の値でも描画できる', qa('svg').length > 0 && qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));

// 範囲外の値（max を超える）
await setData({ fields: FIELDS, rows: [['a', '50'], ['b', '9999']] });
check('範囲外の値でも端に張り付いて描ける', qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));

// 壊れた options（型不一致）
await setData({ fields: FIELDS, rows: ROWS });
await setOpts({ arcThickness: 'abc', segmentCount: -5, sweepAngle: null, colorBands: 'broken', statList: 42, panelWidth: 99 });
check('壊れた options でも描画を継続する', qa('svg').length > 0 && valueText().includes('87'), valueText());

console.log('\n=== 11. リサイズ（段階退避） ===');
await setOpts({ slot1: 'delta', slot2: 'stats', slot3: 'sparkline' });
await resize(900, 400);
check('広いときは横にパネルが出る', !!q('[data-role="panel"]'));
await resize(260, 300);
check('狭いと下へ退避（またはパネル非表示）でも描画は続く', qa('svg').length > 0);
await resize(200, 130);
check('極小でもゲージは描かれる', qa('svg').length > 0);
check('極小では中央の値が残る', valueText().length > 0, valueText());
await resize(900, 400);
check('元に戻すとパネルが復帰', !!q('[data-role="panel"]'));

console.log('\n=== 13. v1.1.0 の追加要望 ===');
await setOpts({});

// --- 帯の境界の数値表示 ---
const bl = qa('[data-role="boundary-label"]').map((t) => t.textContent);
check('色が切り替わる位置に数値が出る', bl.length > 0, `got=${JSON.stringify(bl)}`);
check('境界の数値が帯の値（60 / 85）と一致', bl.includes('60') && bl.includes('85'), `got=${JSON.stringify(bl)}`);
await setOpts({ showBoundaryValues: false });
check('境界の数値をオフにできる', qa('[data-role="boundary-label"]').length === 0);

// --- 最小/最大ラベルが見切れないこと ---
await setOpts({});
const svgW = Number(q('svg')?.getAttribute('width') || 0);
const loEl = q('[data-role="range-lo"]');
const hiEl = q('[data-role="range-hi"]');
check('最小/最大ラベルが描かれる', !!loEl && !!hiEl);
const loX = Number(loEl?.getAttribute('x') || -1);
const hiX = Number(hiEl?.getAttribute('x') || -1);
check('最小ラベルが SVG の内側にある', loX >= 0 && loX <= svgW, `x=${loX} w=${svgW}`);
check('最大ラベルが SVG の内側にある', hiX >= 0 && hiX <= svgW, `x=${hiX} w=${svgW}`);
check('端ラベルは中央寄せでなく放射方向に逃がしている',
    loEl?.getAttribute('text-anchor') !== hiEl?.getAttribute('text-anchor'),
    `lo=${loEl?.getAttribute('text-anchor')} hi=${hiEl?.getAttribute('text-anchor')}`);

// --- タコメーター ---
await setOpts({ gaugeStyle: 'tachometer' });
check('タコメーターの帯が描かれる', qa('[data-role="tacho-band"]').length > 0);
check('タコメーターは帯を全周ぶん塗る（3帯）', qa('[data-role="tacho-band"]').length === 3,
    `n=${qa('[data-role="tacho-band"]').length}`);
check('タコメーターは針を常に出す（showNeedle 未指定でも）', !!q('[data-role="needle"]'));
check('タコメーターの針は三角形（polygon）', !!q('[data-role="needle"] polygon'));
check('タコメーターでも NaN が出ない', qa('path,polygon').every((p) =>
    !/NaN/.test(p.getAttribute('d') || '') && !/NaN/.test(p.getAttribute('points') || '')));
check('タコメーターでは連続の塗りを使わない', qa('[data-role="fill"]').length === 0);
// 針と重ならないよう数値が下へずれること
const centerBox = q('[data-role="value"]')?.parentElement;
const topPct = parseFloat((centerBox?.getAttribute('style') || '').match(/top:\s*([\d.]+)%/)?.[1] || '0');
check('タコメーターは数値を下へずらす（top > 70%）', topPct > 70, `top=${topPct}%`);
await setOpts({ gaugeStyle: 'continuous' });
const topPct2 = parseFloat((q('[data-role="value"]')?.parentElement?.getAttribute('style') || '').match(/top:\s*([\d.]+)%/)?.[1] || '0');
check('連続では数値が中央付近のまま', topPct2 < 60, `top=${topPct2}%`);

// --- 単位を入れても数値が中央固定 ---
await setOpts({ unitText: '' });
const noUnitLeft = q('[data-role="value"]')?.getBoundingClientRect?.();
await setOpts({ unitText: '%%%%' });
check('単位は絶対配置で数値の外に出す', !!q('[data-role="unit"]'));
const unitStyle = q('[data-role="unit"]')?.getAttribute('style') || '';
check('単位が position:absolute（数値の中心を動かさない）', /position:\s*absolute/.test(unitStyle), unitStyle);
check('単位が数値の右（left:100%）に置かれる', /left:\s*100%/.test(unitStyle), unitStyle);

// --- 仕切り線の削除 ---
await setOpts({ panelPosition: 'right' });
const panelWrap = q('[data-role="panel"]')?.parentElement;
const wrapStyle = panelWrap?.getAttribute('style') || '';
// box-sizing: border-box は「境界線」ではないので除外して判定する
check('ゲージとサブ情報の間に境界線が無い',
    !/border-(left|right|top|bottom)\s*:/i.test(wrapStyle), wrapStyle);

// --- 下パネルは中央寄せ ---
await setOpts({ panelPosition: 'bottom', slot1: 'stats', slot2: 'target', targetValue: 100 });
await resize(900, 460);
const statRow = q('[data-role="stat"]');
const statStyle = statRow?.getAttribute('style') || '';
check('下パネルではラベルと数値を中央寄せにする',
    /justify-content:\s*center/.test(statStyle), statStyle);
await setOpts({ panelPosition: 'right', slot1: 'stats', slot2: 'none', slot3: 'none', slot4: 'none' });
const sideStyle = q('[data-role="stat"]')?.getAttribute('style') || '';
check('右パネルでは従来どおり両端に配置', /justify-content:\s*space-between/.test(sideStyle), sideStyle);

console.log('\n=== 14. v1.1.1 レイアウト（余白・見切れ）===');
await resize(560, 400);
await setOpts({ panelPosition: 'none', unitText: '%', titleText: 'CPU' });

// SVG 内の全 y 座標から、描画物が縦にどこを占めているかを測る
function vExtent() {
    let minY = Infinity;
    let maxY = -Infinity;
    const note = (y) => { if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
    qa('svg text').forEach((t) => {
        const y = Number(t.getAttribute('y'));
        const fs = Number(t.getAttribute('font-size') || q('svg')?.getAttribute('font-size') || 12);
        note(y); note(y - fs); // ベースラインと文字の上端
    });
    // パスは M/L の "x y" と、A の末尾 "… x y" だけが実座標。
    // A の rx/ry/回転/フラグを座標と誤読しないようコマンド単位で解釈する。
    qa('svg path').forEach((p) => {
        const d = p.getAttribute('d') || '';
        (d.match(/[MLA][^MLAZ]*/gi) || []).forEach((seg) => {
            const cmd = seg[0].toUpperCase();
            const nums = (seg.slice(1).match(/-?\d+\.?\d*/g) || []).map(Number);
            if (cmd === 'M' || cmd === 'L') {
                for (let i = 0; i + 1 < nums.length; i += 2) note(nums[i + 1]);
            } else if (cmd === 'A' && nums.length >= 7) {
                // A rx ry rot large sweep x y
                note(nums[6]);
            }
        });
    });
    return { minY, maxY };
}

const svgH = Number(q('svg')?.getAttribute('height') || 0);
const ext = vExtent();
check('SVG の高さが取れる', svgH > 0, `h=${svgH}`);
check('上端の描画が SVG の外にはみ出していない（上の数字が見切れない）',
    ext.minY >= -0.5, `minY=${ext.minY.toFixed(1)}`);
check('下端の描画が SVG の外にはみ出していない',
    ext.maxY <= svgH + 0.5, `maxY=${ext.maxY.toFixed(1)} h=${svgH}`);
// 240° の弧は下端が中心の 0.5r。下に巨大な余白が残っていないこと
const bottomSlack = svgH - ext.maxY;
check('下の余白が過大でない（描画が縦の 75% 以上を使う）',
    (ext.maxY - ext.minY) / svgH >= 0.75,
    `used=${(((ext.maxY - ext.minY) / svgH) * 100).toFixed(0)}% slack下=${bottomSlack.toFixed(1)}`);
check('上下の余白がおおむね均等（片寄っていない）',
    Math.abs(ext.minY - bottomSlack) <= svgH * 0.18,
    `上=${ext.minY.toFixed(1)} 下=${bottomSlack.toFixed(1)}`);

// 開き角ごとに「はみ出さない」かを確認（180 は横長、320 はほぼ全周）
for (const sw of [180, 240, 280, 320]) {
    await setOpts({ panelPosition: 'none', sweepAngle: sw });
    const e = vExtent();
    const sh = Number(q('svg')?.getAttribute('height') || 0);
    check(`開き角 ${sw}° で上下がはみ出さない`,
        e.minY >= -0.5 && e.maxY <= sh + 0.5,
        `minY=${e.minY.toFixed(1)} maxY=${e.maxY.toFixed(1)} h=${sh}`);
}

// --- 下パネル：中身の量に応じた高さになり、ゲージを潰さないこと ---
await setOpts({ panelPosition: 'bottom', slot1: 'delta', slot2: 'none', slot3: 'none', slot4: 'none' });
const gaugeH1 = Number(q('svg')?.getAttribute('height') || 0);
await setOpts({ panelPosition: 'bottom', slot1: 'ranking', slot2: 'none', slot3: 'none', slot4: 'none', rankCount: 5 });
const gaugeH2 = Number(q('svg')?.getAttribute('height') || 0);
check('下パネルが中身の量で高さを変える（少ない方がゲージが大きい）',
    gaugeH1 > gaugeH2, `delta時=${gaugeH1} ranking5件時=${gaugeH2}`);
await setOpts({ panelPosition: 'none' });
const gaugeFull = Number(q('svg')?.getAttribute('height') || 0);
check('下パネル1スロットならゲージが全体の 65% 以上を保つ',
    gaugeH1 / gaugeFull >= 0.65, `${gaugeH1}/${gaugeFull}`);

console.log('\n=== 15. 中央の数値の色 ===');
await resize(900, 400);
await setOpts({ panelPosition: 'none' });

const valueColorOf = () => {
    const st = q('[data-role="value"]')?.getAttribute('style') || '';
    const m = st.match(/(?:^|[;\s])color:\s*([^;]+)/);
    return (m ? m[1] : '').trim();
};

// 既定は band（ゲージと同じ色）。値 87 = 危険帯 #ef4444 系のはず
check('既定は「ゲージと同じ色」モード',
    q('[data-role="value"]')?.getAttribute('data-value-color-mode') === 'band',
    q('[data-role="value"]')?.getAttribute('data-value-color-mode'));
const bandColor = valueColorOf();
check('band モードで色が付く（テーマ標準の文字色ではない）',
    bandColor !== '' && bandColor !== '#e6edf3', `got=${bandColor}`);
// #ef4444 = rgb(239,68,68) を白へ 0.22 寄せ → r が最大、b が最小の赤系になる
const rgbOf = (s) => (s.match(/\d+/g) || []).map(Number);
const bc = rgbOf(bandColor);
check('band モードの色が赤系（危険帯 #ef4444 由来）',
    bc.length === 3 && bc[0] > bc[1] && bc[0] > bc[2], `got=${bandColor}`);

// 値を変えると色も追従する（帯が変わる）
await setData({ fields: FIELDS, rows: [['a', '10'], ['b', '20']] });
const lowColor = valueColorOf();
const lc = rgbOf(lowColor);
check('値が下がると数値の色も帯に追従する（緑系になる）',
    lc.length === 3 && lc[1] > lc[0] && lc[1] > lc[2], `got=${lowColor}`);
await setData({ fields: FIELDS, rows: ROWS });

// fixed モード
await setOpts({ panelPosition: 'none', valueColorMode: 'fixed', valueFixedColor: '#00b3ff' });
const fixedColor = valueColorOf();
const fc = rgbOf(fixedColor);
check('fixed モードは指定した色（青系）になる',
    fc.length === 3 && fc[2] > fc[0], `got=${fixedColor}`);
// 値を変えても固定色は変わらない
await setData({ fields: FIELDS, rows: [['a', '10'], ['b', '20']] });
check('fixed モードは値が変わっても色が変わらない', valueColorOf() === fixedColor,
    `before=${fixedColor} after=${valueColorOf()}`);
await setData({ fields: FIELDS, rows: ROWS });

// auto モード
await setOpts({ panelPosition: 'none', valueColorMode: 'auto' });
check('auto モードはテーマ標準の文字色になる', valueColorOf() === '#e6edf3', `got=${valueColorOf()}`);
// ライトテーマでは黒側の文字色になること
state.theme = 'light';
fire('theme', { theme: 'light' });
await settle();
check('auto モードはライトテーマで暗い文字色になる', valueColorOf() === '#1a1c20', `got=${valueColorOf()}`);
state.theme = 'dark';
fire('theme', { theme: 'dark' });
await settle();

// 壊れた値でも落ちない
await setOpts({ panelPosition: 'none', valueColorMode: 'bogus', valueFixedColor: 'not-a-color' });
check('未知のモード／不正な色でも描画を継続する（既定へ丸める）',
    qa('svg').length > 0 && valueText().includes('87'), valueText());
check('不正なモードは band（既定）へ丸められる',
    q('[data-role="value"]')?.getAttribute('data-value-color-mode') === 'band');

console.log('\n=== 16. グラデーション（colorMode=gradient）===');
await resize(900, 400);
await setOpts({ panelPosition: 'none', colorMode: 'gradient' });

const fills16 = qa('[data-role="fill"]');
check('グラデーションでも塗りが描かれる', fills16.length > 0, `n=${fills16.length}`);
// 帯の境界数（2）より遥かに多い小片に分割されているはず
check('帯の境界数より多く分割される（滑らかにするため）', fills16.length > 10, `n=${fills16.length}`);
const gcolors = fills16.map((p) => p.getAttribute('fill'));
check('補間色は rgb() 形式で出る', gcolors.some((c) => /^rgb\(/.test(c)), gcolors.slice(0, 3).join(' '));
check('すべて異なる色ではなく連続的に変化する（隣接色が近い）', (() => {
    const rgb = (s) => (String(s).match(/\d+/g) || []).map(Number);
    for (let i = 1; i < gcolors.length; i += 1) {
        const a = rgb(gcolors[i - 1]);
        const b = rgb(gcolors[i]);
        if (a.length !== 3 || b.length !== 3) continue;
        const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        if (d > 60) return false; // 階段状なら隣接で大きく飛ぶ
    }
    return true;
})(), '隣接する小片の色差が大きい（階段状になっている）');
check('グラデーションでも NaN が出ない',
    qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));

// band（階段状）と比べて中間色が生まれていること
await setOpts({ panelPosition: 'none', colorMode: 'band' });
const bandColors = new Set(qa('[data-role="fill"]').map((p) => p.getAttribute('fill')));
await setOpts({ panelPosition: 'none', colorMode: 'gradient' });
const gradColors = new Set(qa('[data-role="fill"]').map((p) => p.getAttribute('fill')));
check('band より gradient の方が色数が多い（中間色が生まれる）',
    gradColors.size > bandColors.size, `band=${bandColors.size} gradient=${gradColors.size}`);

// 帯の中央では、その帯の色そのものになる（アンカー点）
// 既定帯: 〜60=#22c55e(緑) / 60〜85=#f59e0b(橙) / 85〜=#ef4444(赤)
// 緑帯の中央は (0+60)/2 = 30
await setData({ fields: FIELDS, rows: [['a', '10'], ['b', '30']] });
const at30 = (q('[data-role="value"]')?.getAttribute('style') || '');
check('帯の中央の値では中央数値がその帯の色に近い（緑系）', (() => {
    const m = at30.match(/color:\s*([^;]+)/);
    const c = (String(m ? m[1] : '').match(/\d+/g) || []).map(Number);
    return c.length === 3 && c[1] > c[0] && c[1] > c[2];
})(), at30);
await setData({ fields: FIELDS, rows: ROWS });

// タコメーター・セグメントでもグラデーションが効く
await setOpts({ panelPosition: 'none', colorMode: 'gradient', gaugeStyle: 'tachometer' });
const tach = qa('[data-role="tacho-band"]');
check('タコメーターでもグラデーションで分割される', tach.length > 10, `n=${tach.length}`);
check('タコメーターのグラデーションで NaN が出ない',
    qa('path,polygon').every((p) => !/NaN/.test(p.getAttribute('d') || '') && !/NaN/.test(p.getAttribute('points') || '')));

await setOpts({ panelPosition: 'none', colorMode: 'gradient', gaugeStyle: 'segmented', segmentCount: 20 });
const segLit = qa('[data-role="segment"]').filter((s) => s.getAttribute('data-lit') === '1');
check('セグメントでもグラデーション色になる（rgb 形式）',
    segLit.some((s) => /^rgb\(/.test(s.getAttribute('fill') || '')),
    segLit.slice(0, 2).map((s) => s.getAttribute('fill')).join(' '));

// 単色モードは従来どおり（グラデーションの影響を受けない）
await setOpts({ panelPosition: 'none', colorMode: 'fixed', fixedColor: '#ff00ff' });
check('単色モードは1本の塗りのまま', qa('[data-role="fill"]').length === 1,
    `n=${qa('[data-role="fill"]').length}`);

// 帯が1つでも落ちない
await setOpts({ panelPosition: 'none', colorMode: 'gradient', colorBands: [{ from: null, to: null, value: '#00ccff' }] });
check('帯が1つのグラデーションでも落ちない',
    qa('[data-role="fill"]').length > 0 && qa('path').every((p) => !/NaN/.test(p.getAttribute('d') || '')));
await setOpts({ panelPosition: 'none', colorMode: 'gradient', colorBands: 'broken' });
check('壊れた帯でもグラデーションが落ちない', qa('svg').length > 0 && valueText().includes('87'), valueText());

console.log('\n=== 12. テーマ切り替え ===');
state.theme = 'light';
fire('theme', { theme: 'light' });
await settle();
check('ライトテーマでも描画される', qa('svg').length > 0 && valueText().includes('87'), valueText());
state.theme = 'dark';
fire('theme', { theme: 'dark' });
await settle();
check('ダークへ戻せる', qa('svg').length > 0);

console.log(`\n===== 結果: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
