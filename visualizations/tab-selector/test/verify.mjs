// Tab Selector viz のローカル検証（happy-dom、Splunk実機なし）
//
// 重点的に確かめること:
//   - タブ定義（editor.arrayOfStrings の文字列配列）が「表示名|トークン値」として解釈されるか
//   - **タブ1つ1つが addDrilldownListener に登録され、それぞれ自分の値を返すか**
//     （1ノード使い回しの実装ミスだと「どれを押しても1番目の値」になる）
//   - タブの増減・改名で登録が張り直されるか
//   - 空・不正なタブ定義でも落ちずに空状態になるか（サンプルが湧かないか）
//   - 旧形式（threshold のオブジェクト）でもタブを失わないか
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_tab_selector', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 120 });
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof performance === 'undefined') globalThis.performance = { now: () => 16 };

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 120 });

// happy-dom はレイアウトを計算しないので offsetLeft/Width が常に 0 になる。
// そのままだとスライドインジケータが「測れない」と判断して非表示になり、
// 見た目の検証ができない。タブ要素にだけ擬似的な寸法を与える。
// （1タブ = 幅100px、左から順に並ぶという単純なモデル）
const TAB_W = 100;
const TAB_H = 38;
Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', {
    get() {
        return this.getAttribute?.('data-role') === 'tab' ? TAB_W : 900;
    },
    configurable: true,
});
Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', {
    get() {
        return this.getAttribute?.('data-role') === 'tab' ? TAB_H : 120;
    },
    configurable: true,
});
Object.defineProperty(win.HTMLElement.prototype, 'offsetLeft', {
    get() {
        if (this.getAttribute?.('data-role') !== 'tab') return 0;
        return Number(this.getAttribute('data-index') || 0) * TAB_W;
    },
    configurable: true,
});
Object.defineProperty(win.HTMLElement.prototype, 'offsetTop', { get: () => 0, configurable: true });

globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [], tokens: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

let state = {
    options: {},
    theme: 'dark',
    mode: 'view',
};

// 登録されたドリルダウンリスナーを記録する。
// node -> { action, payloadCallback } （同じ node への再登録は上書き＝最新のみ有効とみなす）
const registered = new Map();

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: {} }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 120 }),
    addDimensionsListener: mkListener('dimensions'),
    getMode: () => ({ mode: state.mode }),
    addModeListener: mkListener('mode'),
    getTokens: () => ({}),
    addTokensListener: mkListener('tokens'),
    getError: () => null,
    addErrorListener: () => () => {},
    addDrilldownListener: ({ node, action, payloadCallback }) => {
        registered.set(node, { action, payloadCallback });
    },
    triggerDrilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));
const setOpts = async (o) => {
    state.options = o;
    fire('options', { options: state.options });
    await sleep(250);
};
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const tabEls = () => [...doc.querySelectorAll('button[data-role="tab"]')];

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. options 未設定＝タブ無し（既定のサンプルを埋め込まない） ---------------
console.log('\n[1] options 未設定（既定のタブは持たない）');
{
    check('no tabs rendered', tabEls().length === 0, `got ${tabEls().length}`);
    check('empty state shown', !!doc.querySelector('[data-empty="true"]'));
    check('empty state explains what to do',
        doc.body.textContent.includes('タブが設定されていません'), doc.body.textContent.slice(0, 120));
    check('no sample tab names leaked (東京/大阪)',
        !doc.body.textContent.includes('東京') && !doc.body.textContent.includes('大阪'),
        doc.body.textContent.slice(0, 120));
}

// ---- 1b. ユーザーがタブを設定すれば描画される --------------------------------
console.log('\n[1b] ユーザー設定のタブ');
{
    await setOpts({
        tabs: [
            '東京|tokyo',
            '大阪|osaka',
        ],
    });
    const tabs = tabEls();
    check('2 tabs rendered', tabs.length === 2, `got ${tabs.length}`);
    check('labels from user setting',
        tabs.map((t) => t.textContent.trim()).join(',') === '東京,大阪',
        tabs.map((t) => t.textContent.trim()).join(','));
    check('token values parsed from 表示名|トークン値',
        tabs.map((t) => t.getAttribute('data-value')).join(',') === 'tokyo,osaka',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
    check('first tab is active by default', tabs[0].getAttribute('data-active') === 'true');
}

// ---- 2. 各タブが個別に addDrilldownListener へ登録されているか ---------------
console.log('\n[2] drilldown registration (タブごとに固有の payload か)');
{
    const tabs = tabEls();
    check('all tabs registered', tabs.every((t) => registered.has(t)),
        `${tabs.filter((t) => registered.has(t)).length}/${tabs.length}`);

    const payloads = tabs.map((t) => registered.get(t)?.payloadCallback());
    check('action is tab.click', tabs.every((t) => registered.get(t)?.action === 'tab.click'));

    // ★ ここが最重要。1ノード使い回しのバグだと両方 tokyo になる。
    check('payload values are per-tab (tokyo / osaka)',
        payloads[0]?.value === 'tokyo' && payloads[1]?.value === 'osaka',
        JSON.stringify(payloads.map((p) => p?.value)));
    check('payload name is "tab"', payloads.every((p) => p?.name === 'tab'));
    check('row.tab.value carries token value',
        payloads[1]?.['row.tab.value'] === 'osaka', JSON.stringify(payloads[1]));
    check('row.label.value carries display label',
        payloads[1]?.['row.label.value'] === '大阪', JSON.stringify(payloads[1]));
    check('row.index.value is 1-based',
        payloads[0]?.['row.index.value'] === 1 && payloads[1]?.['row.index.value'] === 2);
}

// ---- 3. タブを 4 個に増やす（＋名前も自由） -----------------------------------
console.log('\n[3] タブを増やす（チップを追加した想定）');
{
    await setOpts({
        tabs: [
            '東京|tokyo',
            '大阪|osaka',
            '名古屋|nagoya',
            '福岡|fukuoka',
        ],
    });
    const tabs = tabEls();
    check('4 tabs rendered', tabs.length === 4, `got ${tabs.length}`);
    check('labels correct',
        tabs.map((t) => t.textContent.trim()).join(',') === '東京,大阪,名古屋,福岡',
        tabs.map((t) => t.textContent.trim()).join(','));

    // 増やしたタブも登録され、固有の値を返すこと（再登録が効いているか）
    const payloads = tabs.map((t) => registered.get(t)?.payloadCallback());
    check('newly added tabs registered', tabs.every((t) => registered.has(t)));
    check('all 4 payloads distinct & correct',
        payloads.map((p) => p?.value).join(',') === 'tokyo,osaka,nagoya,fukuoka',
        payloads.map((p) => p?.value).join(','));
}

// ---- 4. 区切り無し＝表示名がそのままトークン値 --------------------------------
console.log('\n[4] 区切り無し（表示名をそのまま値に使う）');
{
    await setOpts({
        tabs: [
            '本番',
            '検証',
        ],
    });
    const tabs = tabEls();
    check('2 tabs rendered', tabs.length === 2, `got ${tabs.length}`);
    check('label used as token value',
        tabs.map((t) => t.getAttribute('data-value')).join(',') === '本番,検証',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
    const payloads = tabs.map((t) => registered.get(t)?.payloadCallback());
    check('payload values match labels',
        payloads.map((p) => p?.value).join(',') === '本番,検証',
        payloads.map((p) => p?.value).join(','));
}

// ---- 5. クリックで選択状態が移るか ------------------------------------------
console.log('\n[5] クリックで選択状態が移る');
{
    await setOpts({
        tabs: [
            'A|a',
            'B|b',
            'C|c',
        ],
    });
    let tabs = tabEls();
    check('tab 1 active initially', tabs[0].getAttribute('data-active') === 'true');

    click(tabs[2]);
    await sleep(150);
    tabs = tabEls();
    check('tab 3 active after click', tabs[2].getAttribute('data-active') === 'true',
        tabs.map((t) => t.getAttribute('data-active')).join(','));
    check('tab 1 no longer active', tabs[0].getAttribute('data-active') === 'false');
}

// ---- 6. 初期選択タブの指定 ---------------------------------------------------
console.log('\n[6] defaultTabIndex');
{
    await setOpts({
        tabs: [
            'A|a',
            'B|b',
            'C|c',
        ],
        defaultTabIndex: 2,
    });
    const tabs = tabEls();
    check('2nd tab active', tabs[1].getAttribute('data-active') === 'true',
        tabs.map((t) => t.getAttribute('data-active')).join(','));
}
{
    // 範囲外は端に丸める（落ちない）
    await setOpts({
        tabs: ['A|a', 'B|b'],
        defaultTabIndex: 99,
    });
    const tabs = tabEls();
    check('out-of-range index clamps to last', tabs[1].getAttribute('data-active') === 'true',
        tabs.map((t) => t.getAttribute('data-active')).join(','));
}

// ---- 7. 並び順は入力順そのまま（勝手に並べ替えない） ---------------------------
console.log('\n[7] 並び順＝入力順');
{
    await setOpts({
        tabs: [
            '3番目|c',
            '1番目|a',
            '2番目|b',
        ],
    });
    const tabs = tabEls();
    check('order follows input order (no sorting)',
        tabs.map((t) => t.getAttribute('data-value')).join(',') === 'c,a,b',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
    check('labels follow input order',
        tabs.map((t) => t.textContent.trim()).join(',') === '3番目,1番目,2番目',
        tabs.map((t) => t.textContent.trim()).join(','));
}

// ---- 7b. 旧形式（threshold が保存したオブジェクト）も読める --------------------
//
// v1.1.0 以前のダッシュボードには {from,to,value} 形式が保存されている。
// 更新でタブが消えないよう救済する（新規に作られる形式ではない）。
console.log('\n[7b] 旧形式（threshold のオブジェクト）の後方互換');
{
    await setOpts({
        tabs: [
            { from: 1, to: 1, value: '東京|tokyo' },
            { from: 2, to: 2, value: '大阪|osaka' },
        ],
    });
    const tabs = tabEls();
    check('legacy object format still renders', tabs.length === 2, `got ${tabs.length}`);
    check('legacy labels parsed',
        tabs.map((t) => t.textContent.trim()).join(',') === '東京,大阪',
        tabs.map((t) => t.textContent.trim()).join(','));
    check('legacy token values parsed',
        tabs.map((t) => t.getAttribute('data-value')).join(',') === 'tokyo,osaka',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
}

// ---- 7c. 文字列と旧オブジェクトの混在でも壊れない -----------------------------
console.log('\n[7c] 新旧混在');
{
    await setOpts({ tabs: ['新|new', { from: 2, to: 2, value: '旧|old' }] });
    const tabs = tabEls();
    check('mixed formats parsed', tabs.length === 2, `got ${tabs.length}`);
    check('mixed values correct',
        tabs.map((t) => t.getAttribute('data-value')).join(',') === 'new,old',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
}

// ---- 8. 見た目オプション -----------------------------------------------------
console.log('\n[8] 見た目オプション');
{
    await setOpts({
        tabs: ['A|a', 'B|b'],
        tabStyle: 'filled',
        accentColor: '#FF5733',
        fontSize: 20,
        align: 'center',
    });
    const tabs = tabEls();
    const active = tabs[0];
    // 選択中の塗りは**インジケータ**が描く（タブ自身は塗らない）。
    // タブ側に accent が乗っていると二重塗りなので、それも確認する。
    const indicator = doc.querySelector('[data-role="indicator"]');
    check('indicator element exists', !!indicator);
    const indStyle = indicator?.getAttribute('style') || '';
    check('indicator carries the accent color',
        indStyle.includes('rgb(255, 87, 51)') || indStyle.includes('#FF5733'), indStyle);
    check('tab itself is not filled (no double paint)',
        !(active.getAttribute('style') || '').includes('rgb(255, 87, 51)'),
        active.getAttribute('style'));
    check('active tab text uses readable color on accent',
        (active.getAttribute('style') || '').includes('color: #10151B')
        || (active.getAttribute('style') || '').includes('color: #FFFFFF'),
        active.getAttribute('style'));
    check('fontSize applied', (active.getAttribute('style') || '').includes('20px'),
        active.getAttribute('style'));
}
{
    await setOpts({
        tabs: ['A|a', 'B|b'],
        showTokenHint: true,
    });
    check('token hint shown', doc.body.textContent.includes('a') && doc.body.textContent.includes('b'));
}

// ---- 8a. インジケータが選択タブへ移動する（この viz の要） ---------------------
console.log('\n[8a] インジケータの移動');
{
    await setOpts({ tabs: ['A|a', 'B|b', 'C|c'], tabStyle: 'pill', accentColor: '#00A4FD' });
    const indStyle = () => doc.querySelector('[data-role="indicator"]')?.getAttribute('style') || '';

    check('indicator starts at tab 1 (x=0)',
        indStyle().includes('translateX(0px)'), indStyle());

    click(tabEls()[2]);
    await sleep(150);
    check('indicator moves to tab 3 (x=200)',
        indStyle().includes('translateX(200px)'), indStyle());
    check('indicator width matches tab width',
        indStyle().includes('width: 100px'), indStyle());

    click(tabEls()[1]);
    await sleep(150);
    check('indicator moves back to tab 2 (x=100)',
        indStyle().includes('translateX(100px)'), indStyle());
    check('indicator animates after first measure',
        indStyle().includes('transition: transform'), indStyle());
}

// ---- 8b. 明るいアクセント色でも文字が読める（自動で濃色に切り替わる） -----------
//
// 白固定だと黄色などの明るい色で文字が消える。輝度で判定していることを確認する。
console.log('\n[8b] アクセント色に応じた文字色の自動選択');
{
    await setOpts({
        tabs: ['A|a', 'B|b'],
        tabStyle: 'filled',
        accentColor: '#F5D90A', // 明るい黄
    });
    const active = tabEls()[0];
    check('dark text on bright accent',
        (active.getAttribute('style') || '').includes('color: #10151B'),
        active.getAttribute('style'));
}
{
    await setOpts({
        tabs: ['A|a', 'B|b'],
        tabStyle: 'filled',
        accentColor: '#1A237E', // 濃紺
    });
    const active = tabEls()[0];
    check('white text on dark accent',
        (active.getAttribute('style') || '').includes('color: #FFFFFF'),
        active.getAttribute('style'));
}

// ---- 8c. 形ごとにインジケータの姿が変わる -------------------------------------
console.log('\n[8c] 形ごとのインジケータ');
{
    await setOpts({ tabs: ['A|a', 'B|b'], tabStyle: 'underline', accentColor: '#00A4FD' });
    const ind = doc.querySelector('[data-role="indicator"]')?.getAttribute('style') || '';
    check('underline indicator is a thin bar', ind.includes('height: 2px'), ind);

    await setOpts({ tabs: ['A|a', 'B|b'], tabStyle: 'pill', accentColor: '#00A4FD' });
    const pill = doc.querySelector('[data-role="indicator"]')?.getAttribute('style') || '';
    check('pill indicator is fully rounded', pill.includes('border-radius: 999px'), pill);

    await setOpts({ tabs: ['A|a', 'B|b'], tabStyle: 'outline', accentColor: '#00A4FD' });
    const outline = doc.querySelector('[data-role="indicator"]')?.getAttribute('style') || '';
    check('outline indicator has a border', outline.includes('border-width: 1px'), outline);
}

// ---- 9. 不正・空のタブ定義でも落ちない ---------------------------------------
//
// 既定のタブは持たない方針なので、フォールバック先は「空状態」であって
// サンプルタブではない。勝手に東京/大阪が湧いてこないことを確認する。
console.log('\n[9] 異常系（落ちずに空状態へ）');
{
    await setOpts({ tabs: [] });
    check('empty array → empty state', tabEls().length === 0, `got ${tabEls().length}`);
    check('empty state message shown', !!doc.querySelector('[data-empty="true"]'));

    await setOpts({ tabs: 'not-an-array' });
    check('string → empty state', tabEls().length === 0, `got ${tabEls().length}`);

    await setOpts({ tabs: '> primary | seriesByName(\'x\')' });
    check('DOS string → empty state', tabEls().length === 0, `got ${tabEls().length}`);

    await setOpts({ tabs: ['', '  ', null, 42] });
    check('blank/garbage entries dropped → empty state', tabEls().length === 0, `got ${tabEls().length}`);
    check('no sample tabs resurrected',
        !doc.body.textContent.includes('東京') && !doc.body.textContent.includes('大阪'));

    await setOpts({
        tabs: ['OK|ok', '', { value: '値だけ|v' }],
    });
    const tabs = tabEls();
    check('valid entries kept, blanks dropped', tabs.length === 2, `got ${tabs.length}`);
    check('mixed string / legacy object entries work',
        tabs.map((t) => t.getAttribute('data-value')).sort().join(',') === 'ok,v',
        tabs.map((t) => t.getAttribute('data-value')).join(','));
}
{
    // 区切り文字まわりの端ケース
    await setOpts({ tabs: ['ラベルのみ', '空値|', '|値のみ', ' 前後空白 | spaced '] });
    const tabs = tabEls();
    check('label-only → label used as value',
        tabs[0]?.getAttribute('data-value') === 'ラベルのみ', tabs[0]?.getAttribute('data-value'));
    check('empty value after | → falls back to label',
        tabs[1]?.getAttribute('data-value') === '空値', tabs[1]?.getAttribute('data-value'));
    check('entry with empty label dropped', tabs.length === 3, `got ${tabs.length}`);
    check('whitespace trimmed around label and value',
        tabs[2]?.textContent.trim() === '前後空白' && tabs[2]?.getAttribute('data-value') === 'spaced',
        `${tabs[2]?.textContent.trim()} / ${tabs[2]?.getAttribute('data-value')}`);
}
{
    // トークン値に | が含まれる場合、最初の | だけが区切り
    await setOpts({ tabs: ['検索|a|b|c'] });
    const tabs = tabEls();
    check('only first | splits (value keeps the rest)',
        tabs[0]?.getAttribute('data-value') === 'a|b|c', tabs[0]?.getAttribute('data-value'));
    check('label is text before first |',
        tabs[0]?.textContent.trim() === '検索', tabs[0]?.textContent.trim());
}
{
    // 型不一致のオプションを詰め込んでも描画が続くこと
    await setOpts({
        tabs: ['A|a'],
        fontSize: 'huge',
        tabStyle: 'nonexistent',
        align: 42,
        stretch: 'yes',
        defaultTabIndex: null,
        accentColor: 123,
    });
    check('survives garbage options', tabEls().length === 1, `got ${tabEls().length}`);
}

// ---- 10. ライトテーマ --------------------------------------------------------
console.log('\n[10] テーマ切替');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    check('still renders in light theme', tabEls().length >= 1, `got ${tabEls().length}`);
}

// ---- 結果 -------------------------------------------------------------------
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}  pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
