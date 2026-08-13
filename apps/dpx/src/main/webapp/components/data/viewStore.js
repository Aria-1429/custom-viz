// ダッシュボード（＝HTML ビュー XML）の読み書き層。
//
// 保存形式は Studio と同型（ビュー XML に <definition><![CDATA[JSON]]></definition> を
// 埋め込む。往復無傷は 2026-08-10 実機確認済み）。
//
// ── 1ビュー集約方式（2026-08-11 移行・Mako 全廃）─────────────────
// 画面は固定ホストビュー `dpx` の1枚だけ（テンプレートは Splunk 同梱の
// pages/splunk_ui_app.html ＝ ビュー名と同名の pages/dpx.js を読む）。
// ダッシュボードは `/app/dpx/dpx?id=<app>/<name>` で開き、
// 定義は従来どおり「ビュー XML 1枚＝1ダッシュボード」に保存する
// （**定義ビューは直接開かない**。開くと同名 JS が無く白紙になるため
//   isVisible="False" で一覧からも隠す）。
//
// なぜこの形か（全数調査の結論。references/dpx-platform.md §1.1）:
//   カスタム Mako は 10.4.0 非推奨 & AppInspect 4.4.0 から審査 fail。
//   標準テンプレートで動的ビューに JS を配る手段は存在しないので、
//   「ビューを増やさない」ことで同名 JS 制約そのものを消した。

import { createRESTURL, createURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit, handleError, handleResponse } from '@splunk/splunk-utils/fetch';
import { username } from '@splunk/splunk-utils/config';

import { emptyDashboard, isValidDefinition } from '../schema';

/** Splunk 同梱の第一党テンプレート（Mako ではない）。 */
export const TEMPLATE_REF = 'pages/splunk_ui_app.html';
/** ホストビュー名（画面はこの1枚だけ）。 */
export const HOST_VIEW = 'dpx';
/** ホストビューの所属アプリ（ランタイム pages/dpx.js の提供元）。 */
export const HOST_APP = 'dpx';

const FORM_HEADERS = {
    ...defaultFetchInit.headers,
    'Content-Type': 'application/x-www-form-urlencoded',
};

const xmlEscape = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 現在の URL から DPX のルートを取り出す。
 *   ?id=<app>/<name> … ダッシュボード（app 省略時は dpx）
 *   id なし          … ホーム（一覧）
 */
export function parseDpxRoute() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const mode = params.get('mode') === 'edit' ? 'edit' : 'view';
    if (!id) return { id: null, app: null, view: null, mode };
    const slash = id.indexOf('/');
    const app = slash > 0 ? id.slice(0, slash) : HOST_APP;
    const view = slash > 0 ? id.slice(slash + 1) : id;
    return { id: `${app}/${view}`, app, view, mode };
}

/** ダッシュボードを開くパス（ロケール接頭辞付き）。 */
export function dashboardHref({ app, name, mode }) {
    const id = app === HOST_APP ? name : `${app}/${name}`;
    const q = `?id=${encodeURIComponent(id)}${mode === 'edit' ? '&mode=edit' : ''}`;
    return createURL(`app/${HOST_APP}/${HOST_VIEW}`) + q;
}

/** ホーム（一覧）のパス（ロケール接頭辞付き）。 */
export function homeHref() {
    return createURL(`app/${HOST_APP}/${HOST_VIEW}`);
}

// スキーマ判定と取り込み検証は engine/ 側の依存ゼロのモジュールが持つ
// （素の Node からテストできるようにするため）。従来の import 先を壊さないよう
// ここから再輸出する。
export { isValidDefinition };
export { parseImportedDefinition } from '../schema/importDefinition';

/** ダッシュボード定義入りの eai:data を組み立てる。
 *  template は既存ビューの値を保持できるよう引数で受ける（省略時は標準テンプレート）。
 *  ⚠ isVisible="False" が重要：定義ビューは**データ入れ物**であり、直接開くと
 *    「ビュー名と同名の JS」が無く白紙になる。ナビや一覧に出さない。 */
export function buildEaiData({ label, definition, template = TEMPLATE_REF }) {
    const json = typeof definition === 'string' ? definition : JSON.stringify(definition, null, 2);
    if (json.includes(']]>')) {
        throw new Error('定義 JSON に "]]>" が含まれており保存できません');
    }
    return (
        `<view template="${xmlEscape(template)}" type="html" isDashboard="False" isVisible="False">\n` +
        `    <label>${xmlEscape(label)}</label>\n` +
        `    <definition><![CDATA[\n${json}\n]]></definition>\n` +
        `</view>`
    );
}

/** eai:data（XML 文字列）から {label, definition} を取り出す。 */
export function parseEaiData(eaiData) {
    const doc = new DOMParser().parseFromString(eaiData, 'text/xml');
    if (doc.querySelector('parsererror')) {
        throw new Error('ビュー XML を解析できません');
    }
    const label = doc.querySelector('view > label')?.textContent ?? '';
    const template = doc.querySelector('view')?.getAttribute('template') ?? TEMPLATE_REF;
    const defNode = doc.querySelector('view > definition');
    if (!defNode) {
        throw new Error('このビューには definition がありません（このプラットフォームのダッシュボードではありません）');
    }
    return { label, template, definition: JSON.parse(defNode.textContent) };
}

/** 1 件取得。共有後は owner が nobody に移るので順に試す（実機で確認済みの挙動）。 */
export async function fetchView(app, name) {
    let lastErr = null;
    for (const owner of [username, 'nobody', '-']) {
        try {
            const url = createRESTURL(`data/ui/views/${encodeURIComponent(name)}`, { app, owner });
            const res = await fetch(`${url}?output_mode=json`, { ...defaultFetchInit }).then(
                handleResponse(200)
            );
            const entry = res.entry[0];
            const { label, template, definition } = parseEaiData(entry.content['eai:data']);
            return { app, name, owner: entry.acl.owner, updated: entry.updated, label, template, definition };
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('ビューを取得できません');
}

/** 保存（既存ビューの eai:data を更新）。
 *  アプリ共有オブジェクトはどの owner 名前空間で更新できるかが状況で変わる
 *  （実機で 404 を踏んだ）ので、候補を順に試す。 */
export async function saveView({ app, name, owner, label, definition, template }) {
    const body = new URLSearchParams({ 'eai:data': buildEaiData({ label, definition, template }) });
    const owners = [...new Set([owner, username, 'nobody'].filter(Boolean))];
    let lastErr = null;
    for (const o of owners) {
        try {
            const url = createRESTURL(`data/ui/views/${encodeURIComponent(name)}`, { app, owner: o });
            await fetch(`${url}?output_mode=json`, {
                ...defaultFetchInit,
                method: 'POST',
                headers: FORM_HEADERS,
                body: body.toString(),
            })
                .then(handleResponse(200))
                .catch(handleError('ダッシュボードの保存に失敗しました'));
            return;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('保存に失敗しました');
}

/** 新規作成（＋アプリ共有）。definition 省略時は空定義（テンプレートから渡せる）。 */
export async function createView({ app, name, label, definition: providedDefinition }) {
    const definition = providedDefinition ?? emptyDefinition(label);
    const url = createRESTURL('data/ui/views', { app, owner: username });
    const body = new URLSearchParams({ name, 'eai:data': buildEaiData({ label, definition }) });
    await fetch(`${url}?output_mode=json`, {
        ...defaultFetchInit,
        method: 'POST',
        headers: FORM_HEADERS,
        body: body.toString(),
    })
        .then(handleResponse(201))
        .catch(handleError('ダッシュボードの作成に失敗しました'));

    // アプリ共有にする（private のままだと他の人が UI から開けない）
    const aclUrl = createRESTURL(`data/ui/views/${encodeURIComponent(name)}/acl`, {
        app,
        owner: username,
    });
    const aclBody = new URLSearchParams({
        sharing: 'app',
        owner: username,
        'perms.read': '*',
        'perms.write': '*',
    });
    await fetch(`${aclUrl}?output_mode=json`, {
        ...defaultFetchInit,
        method: 'POST',
        headers: FORM_HEADERS,
        body: aclBody.toString(),
    })
        .then(handleResponse(200))
        .catch(handleError('共有設定の変更に失敗しました'));
}

/** ラベル（表示名）だけを差し替える。
 *
 *  ⚠ **`label` 単独の POST では変わらない。** ラベルは eai:data（ビュー XML）の
 *    `<label>` が実体なので、**定義ごと読み直して XML を組み直す**必要がある
 *    （`saveView` と同じ経路に載せる）。template も既存値を保持する。 */
export async function renameView({ app, name, owner, label }) {
    const current = await fetchView(app, name);
    await saveView({
        app,
        name,
        owner: owner ?? current.owner,
        label,
        definition: { ...current.definition, title: label },
        template: current.template,
    });
}

/** 複製。既存ボードの定義をそのまま新しいビューへ写す。
 *
 *  定義の `title` は新しいラベルに合わせて書き換える（ボード内の表示と
 *  一覧のラベルが食い違わないようにする）。データソース・パネル・タブ・
 *  入力はすべて定義 JSON の中なので、丸ごとコピーで完全に複製できる。 */
export async function duplicateView({ app, name, toApp, toName, label }) {
    const src = await fetchView(app, name);
    await createView({
        app: toApp ?? app,
        name: toName,
        label,
        definition: { ...src.definition, title: label },
    });
}

/** 失敗レスポンスから人間が読める文言を取り出す。
 *  ⚠ これを通さず Response をそのまま throw すると、画面に
 *  「削除に失敗: [object Response]」と出る（実機で発生した不具合）。 */
async function messageFromResponse(res, fallback) {
    try {
        const body = await res.json();
        const text = body?.messages?.[0]?.text;
        if (text) return `${fallback}（HTTP ${res.status}: ${text}）`;
    } catch {
        /* JSON でない応答はそのまま落ちる */
    }
    return `${fallback}（HTTP ${res.status}）`;
}

/** 削除。
 *
 *  ⚠ **試す名前空間は ACL の実態から決める**（2026-08-13 修正）:
 *    - アプリ/グローバル共有 … 実体は **nobody** 名前空間（owner 名では 404。実機で確認）
 *    - プライベート … **所有者**の名前空間（自分以外の private は一覧に出ない）
 *    旧実装は [username, 'nobody'] 固定だったため、他ユーザーが所有する
 *    共有ボードでも順に舐めれば消せたが、**404 以外の失敗（403 権限なし等）も
 *    「次の owner を試す」で握り潰し、最後に生の Response を throw していた**
 *    → 画面が「削除に失敗: [object Response]」になっていた。
 *    404（そこに実体が無い）だけ次を試し、**403 等は即座に理由を表示する**。 */
export async function deleteView({ app, name, owner, sharing }) {
    const namespaces =
        sharing === 'user'
            ? [...new Set([owner, username].filter(Boolean))]
            : [...new Set(['nobody', owner, username].filter(Boolean))];
    let lastMessage = null;
    for (const ns of namespaces) {
        const url = createRESTURL(`data/ui/views/${encodeURIComponent(name)}`, { app, owner: ns });
        const res = await fetch(`${url}?output_mode=json`, {
            ...defaultFetchInit,
            method: 'DELETE',
        });
        if (res.ok) return;
        if (res.status === 404) {
            // この名前空間に実体が無いだけ。次の候補を試す
            lastMessage = await messageFromResponse(res, '削除対象が見つかりません');
            continue;
        }
        // 404 以外（403 権限なし・405 削除不可 等）は理由が確定しているので即座に伝える
        throw new Error(await messageFromResponse(res, '削除できません'));
    }
    throw new Error(lastMessage ?? '削除に失敗しました');
}

/** このプラットフォームのダッシュボードを全アプリ横断で一覧する。
 *
 *  ⚠ **テンプレート名で絞ってはいけない。** 標準テンプレート
 *  （pages/splunk_ui_app.html）に移行したので、それで絞ると
 *  **Splunk の標準ビューまで拾ってしまう**。
 *  DPX の目印は `<definition>` を持っていること（他のビューには無い）。 */
export async function listDashboards() {
    // ⚠ 絞り込みは2段構え。REST の search は「候補を減らす」だけで、
    //   **DPX かどうかの判定は定義の中身で行う**。
    //   - テンプレート名で絞る → 移行の途中で取りこぼす
    //   - `<definition>` で絞る → **Dashboard Studio も同じ入れ物を使う**ので
    //     Studio のダッシュボードまで一覧に出る（実機で 19 件中 15 件が Studio だった）
    const search = 'eai:data="*<definition>*"';
    const url = createRESTURL('data/ui/views', { app: '-', owner: '-' });
    const params = new URLSearchParams({ output_mode: 'json', count: '0', search });
    const res = await fetch(`${url}?${params}`, { ...defaultFetchInit }).then(handleResponse(200));
    return (res.entry ?? [])
        .map((e) => {
            try {
                const { label, definition } = parseEaiData(e.content['eai:data']);
                if (!isValidDefinition(definition)) return null;
                return {
                    name: e.name,
                    app: e.acl.app,
                    owner: e.acl.owner,
                    sharing: e.acl.sharing,
                    // 削除・保存の可否（UI 側でボタンの活性に使う）。
                    // ⚠ nobody 所有の共有ビュー等は can_write=False が返る（実機で確認）。
                    //   押せるのに必ず失敗するボタンを出さないための情報
                    canWrite: e.acl.can_write !== false && e.acl.removable !== false,
                    label: label || e.name,
                    updated: e.updated,
                    // ホーム一覧の「顔」になる定義由来のメタ（ここで定義は既にパース済み＝無料）
                    preset:
                        definition.style?.preset ??
                        (definition.theme === 'light' ? 'light' : 'midnight'),
                    panelCount: Array.isArray(definition.panels) ? definition.panels.length : 0,
                    tabCount: Array.isArray(definition.tabs) ? definition.tabs.length : 0,
                };
            } catch {
                // 定義が読めないものは DPX ではないと判断して出さない
                return null;
            }
        })
        .filter(Boolean);
}

/** ダッシュボード定義を .json としてダウンロードさせる。
 *
 *  ⚠ **Blob URL は revoke を遅らせる。** click() の直後に revoke すると
 *    ブラウザがダウンロードを始める前に URL が死ぬことがある。 */
export async function exportView({ app, name }) {
    const { label, definition } = await fetchView(app, name);
    const json = JSON.stringify({ ...definition, title: definition.title ?? label }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 書き込み可能で UI に見えるアプリの一覧（新規作成先の選択肢）。 */
export async function listApps() {
    const url = createRESTURL('apps/local');
    const params = new URLSearchParams({
        output_mode: 'json',
        count: '0',
        search: 'disabled=0',
    });
    const res = await fetch(`${url}?${params}`, { ...defaultFetchInit }).then(handleResponse(200));
    return (res.entry ?? [])
        .filter((e) => e.content.visible !== false && !e.content.disabled)
        .map((e) => ({ id: e.name, label: e.content.label || e.name }));
}

/** 新規ダッシュボードの空定義（DPX スキーマ v2）。
 *  ⚠ **形をここで組み立てない。** 既定値はスキーマが唯一の出どころ。 */
export function emptyDefinition(title) {
    return emptyDashboard(title || 'New Dashboard');
}
