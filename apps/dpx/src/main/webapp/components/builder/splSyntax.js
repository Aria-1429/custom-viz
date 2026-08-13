// ── SPL の構文定義（コマンド一覧）を実機の Splunk から取る ───────────
//
// ⭐ **コマンド一覧を手で書かない。** Splunk 本体のサーチバーが読んでいるのと
//    同じ REST（`configs/conf-searchbnf`）から取る。実機で確認済み:
//      - Splunk Web のサーチ画面が実際に叩いているのは
//        `/en-US/splunkd/__raw/servicesNS/<user>/search/configs/conf-searchbnf?count=0`
//      - 手元の環境では **560 スタンザ / うち `*-command` が 166 個**
//    → **その Splunk に入っているコマンド（カスタムコマンド含む）がそのまま色付く。**
//      手書きのリストだとバージョン差・アプリ独自コマンドで必ずズレる。
//
// ⚠ 取得に失敗しても**エディタは動く**（ハイライトが控えめになるだけ）。
//   サーチ編集ができなくなる方が致命的なので、失敗は握りつぶす。
// ────────────────────────────────────────────────────────────────

import { createRESTURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit } from '@splunk/splunk-utils/fetch';

let cache = null; // { commands: string[], functions: string[] }
let inflight = null;

/** `eval` 等でよく使う関数名。BNF から関数だけを抜くのは形が揃わないので、
 *  ここは「よく使うもの」を補助的に持つ（コマンドは REST が正）。 */
const COMMON_FUNCTIONS = [
    'abs', 'case', 'ceiling', 'cidrmatch', 'coalesce', 'exact', 'exp', 'floor', 'if', 'in',
    'isnotnull', 'isnull', 'isnum', 'isstr', 'len', 'like', 'ln', 'log', 'lower', 'ltrim',
    'match', 'max', 'md5', 'min', 'mvcount', 'mvfilter', 'mvindex', 'mvjoin', 'mvzip', 'now',
    'null', 'nullif', 'random', 'relative_time', 'replace', 'round', 'rtrim', 'searchmatch',
    'split', 'sqrt', 'strftime', 'strptime', 'substr', 'time', 'tonumber', 'tostring', 'trim',
    'typeof', 'upper', 'urldecode', 'validate',
    // 統計関数
    'avg', 'count', 'dc', 'distinct_count', 'earliest', 'latest', 'list', 'median', 'mode',
    'perc', 'range', 'stdev', 'sum', 'sumsq', 'values', 'var',
];

/** SPL のキーワード（コマンドでも関数でもないが色を付けたいもの）。 */
const KEYWORDS = ['as', 'by', 'or', 'and', 'not', 'in', 'over', 'where', 'output', 'outputnew', 'span'];

/**
 * コマンド一覧を取得する（1回だけ。以後はキャッシュ）。
 * @returns Promise<{commands:string[], functions:string[], keywords:string[]}>
 */
export function loadSplSyntax() {
    if (cache) return Promise.resolve(cache);
    if (inflight) return inflight;

    const fallback = { commands: [], functions: COMMON_FUNCTIONS, keywords: KEYWORDS };

    inflight = fetch(
        // ⚠ `count=0` を付けないと既定 30 件で切られる（Splunk Web も 0 を渡している）
        createRESTURL('configs/conf-searchbnf', { app: 'search', owner: 'nobody' }) +
            '?output_mode=json&count=0',
        { ...defaultFetchInit, method: 'GET' }
    )
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
            const commands = [];
            for (const e of j?.entry ?? []) {
                // スタンザ名は `<command>-command`。それ以外（引数の定義など）は使わない
                const m = /^([a-zA-Z0-9_]+)-command$/.exec(e?.name ?? '');
                if (m) commands.push(m[1]);
            }
            // ⚠ 長い名前を先に並べる。`stats` が `eventstats` より先に当たると
            //    途中でマッチして色が崩れる（正規表現の交替は先勝ちのため）
            commands.sort((a, b) => b.length - a.length || a.localeCompare(b));
            cache = { commands, functions: COMMON_FUNCTIONS, keywords: KEYWORDS };
            return cache;
        })
        .catch(() => {
            // 取れなくても編集は続けられる。次回また試せるよう inflight だけ解除
            cache = fallback;
            return fallback;
        })
        .finally(() => {
            inflight = null;
        });

    return inflight;
}

/**
 * `ace/mode/spl` のコンストラクタに渡す形へ変換する。
 *
 * バンドルを読んで判明した形（`buildRules` / `buildCommandTokens`）:
 *   { "<stanza名>": { other: [], args: [{key,valueType?}], functions: [{name,parenOptional?}], keywords: [] } }
 *   - キーは **`<command>-command`**（`conf-searchbnf` のスタンザ名と同じ）
 *   - 開始状態は **`start` = `search-command`** が使われる
 *     （＝ `search-command` を必ず入れる。無いと素の状態になり色が付かない）
 *
 * ⚠ `other` / `args` / `functions` / `keywords` は**4つとも必ず配列で渡す**。
 *   `buildCommandTokens` が `e.other.forEach` / `e.args.length` を無条件に触るので、
 *   1つでも欠けると **TypeError でエディタごと落ちる**。
 */
export function toAceSyntax({ commands, functions, keywords }) {
    // 「| の直後」に来るコマンド名を色付けするルール。
    // ⚠ `command` トークンは SPL モード側が用意していないので、
    //    コマンド名は keywords（modifier トークン）として渡して色を付ける。
    const cmdList = (commands ?? []).filter(Boolean);
    const fnList = (functions ?? []).map((name) => ({ name, parenOptional: false }));

    const base = {
        other: [],
        args: [],
        functions: fnList,
        // コマンド名 + SPL キーワードをまとめて modifier として色付けする
        keywords: [...cmdList, ...(keywords ?? [])],
    };

    // 各コマンドの状態と、開始状態（search-command）を用意する。
    // 状態ごとに中身を変える必要は今のところ無いので同じ規則を共有する。
    const syntax = { 'search-command': base };
    for (const c of cmdList) syntax[`${c}-command`] = base;
    return syntax;
}

/** テスト・デバッグ用（キャッシュを捨てる）。 */
export function _resetSplSyntaxCache() {
    cache = null;
    inflight = null;
}
