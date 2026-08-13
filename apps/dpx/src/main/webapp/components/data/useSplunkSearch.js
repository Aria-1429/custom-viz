import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRESTURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit, handleError, handleResponse } from '@splunk/splunk-utils/fetch';
import { username } from '@splunk/splunk-utils/config';

// ── サーチの名前空間（1ビュー集約で必須になった）──────────────────
// 旧方式では「ビューの URL ＝所属アプリ」だったので名前空間を省略できたが、
// ホストビュー方式では URL が常に dpx になる。**所属アプリの
// マクロ・ルックアップを使うサーチが黙って壊れる**ので、ダッシュボードの
// 所属アプリを Context で配り、サーチは必ずその名前空間で実行する。
export const SearchAppContext = createContext(null);

// ── 独自エンジンのデータ層 ────────────────────────────────────────
// SPL を splunkd に投げて {fields, columns}（列指向）で返すフック。
// ops-console の useSearch（実機検証済み）を土台に、viz 契約
// （dataSources.primary.data = {fields:[{name}], columns:[[..]]}）へ整形した。
//
// refresh > 0 なら秒間隔で再実行する（壁掛けボード向け。タブ非アクティブの
// タイマー詰まり対策として setInterval ではなく再帰 setTimeout を使う）。
// ────────────────────────────────────────────────────────────────

/** SPL の最後の | table / | fields 句から宣言済みフィールド順を取り出す。
 *  ワイルドカードや式を含む場合は解釈しない（空を返す＝観測順にフォールバック）。 */
function parseDeclaredFieldOrder(spl) {
    const matches = [...String(spl).matchAll(/\|\s*(?:table|fields)\s+([^|]+)/gi)];
    if (matches.length === 0) return [];
    const last = matches[matches.length - 1][1];
    if (/[*()="']/.test(last)) return [];
    return last
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== '-' && s !== '+');
}

/**
 * ジョブの完了を待つ（`exec_mode=blocking` の代替）。
 *
 * blocking は HTTP 接続を握ったままサーバ側でジョブを走らせ続けるため、
 * 同時実行の上限に当たりやすい（§8.4.2）。Studio と同じく非ブロッキングで
 * 投げ、`dispatchState` をポーリングして完了を検出する。
 *
 * ⚠ 失敗（FAILED）は messages から理由を取り出して**本物の Error** にする。
 *   ここで握りつぶすと「結果0行」と区別が付かなくなる。
 */
function waitForJob(sid, ns, isStale, { intervalMs = 250, timeoutMs = 120_000 } = {}) {
    const url = `${createRESTURL(`search/jobs/${encodeURIComponent(sid)}`, ns)}?output_mode=json`;
    const started = Date.now();
    const poll = () =>
        fetch(url, { ...defaultFetchInit })
            .then(handleResponse(200))
            .catch(handleError('サーチの状態取得に失敗しました'))
            .then((json) => {
                if (isStale()) return null;
                const c = json?.entry?.[0]?.content ?? {};
                const state = c.dispatchState;
                if (state === 'DONE') return null;
                if (state === 'FAILED') {
                    const msg = (c.messages ?? []).find((m) => m.type === 'ERROR' || m.type === 'FATAL');
                    throw new Error(msg?.text || 'サーチが失敗しました');
                }
                if (Date.now() - started > timeoutMs) {
                    throw new Error('サーチがタイムアウトしました');
                }
                return new Promise((r) => setTimeout(r, intervalMs)).then(poll);
            });
    return poll();
}

export function useSplunkSearch(spl, { earliest = '-24h', latest = 'now', count = 5000, refresh = 0 } = {}) {
    const [state, setState] = useState({ data: null, loading: true, error: null });
    const generation = useRef(0);
    // ダッシュボードの所属アプリ名前空間（未提供なら従来どおり既定の名前空間）
    const searchApp = useContext(SearchAppContext);
    const ns = searchApp ? { app: searchApp, owner: username } : undefined;

    useEffect(() => {
        if (!spl || !spl.trim()) {
            setState({ data: null, loading: false, error: null });
            return undefined;
        }

        const myGen = ++generation.current;
        const isStale = () => myGen !== generation.current;
        let timer = null;

        const runOnce = () => {
            setState((prev) => ({ ...prev, loading: true }));
            const trimmed = spl.trim();
            const query = /^\||^search\b/i.test(trimmed) ? trimmed : `search ${trimmed}`;
            // ⚠ **`exec_mode=blocking` を使わない**（Studio の実装に合わせた。2026-08-12 実機で確定）。
            //
            //   blocking は「ジョブが終わるまで POST の応答を返さない」＝ HTTP 接続を
            //   握ったまま待つ。同時に投げた本数ぶん**サーバ側で同時に生きたジョブが並ぶ**ため、
            //   役割の同時実行上限（srchJobsQuota）に容易に当たり、超えた分が
            //   **HTTP 503「role-based concurrency limit ... has been reached」**で落ちる。
            //
            //   実測（同じ実機・同時12本）:
            //     exec_mode=blocking …… 201×10 / **503×2**
            //     指定なし（Studio 相当）… **201×12**（全部成功）
            //
            //   Studio の標準ダッシュボードは 12 パネルを 19ms 以内に一斉ディスパッチしても
            //   503 が出ない。**キューで絞っているのではなく、blocking を使っていない**ため
            //   （実機で POST body を観測: output_mode/preview/search/sid/check_risky_command/
            //   label/provenance のみ。exec_mode は送っていない）。
            //   → 既定の exec_mode=normal で即座に sid を受け取り、**完了はポーリングで待つ**。
            const body = new URLSearchParams({
                search: query,
                earliest_time: earliest,
                latest_time: latest,
                output_mode: 'json',
                adhoc_search_level: 'smart',
                // Studio と同じく由来を残す（ジョブ一覧でどこから来たか分かる）
                provenance: 'UI:dashboard:dpx',
            });

            fetch(createRESTURL('search/jobs', ns), {
                ...defaultFetchInit,
                method: 'POST',
                headers: { ...defaultFetchInit.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            })
                .then(handleResponse(201))
                // ⚠ `handleResponse` は**生の Response を reject する**（Error ではない）ので、
                //   受け側が err.message を読むと undefined になり `[object Response]` と表示される。
                //   Splunk 自身の splunk-utils/search.js は必ず handleError と対で使っている。
                //   handleError は本文の messages[].text を読んで**本物の Error** にしてくれる。
                .catch(handleError('サーチジョブの作成に失敗しました'))
                .then((json) => {
                    if (isStale()) return null;
                    const sid = json && json.sid;
                    if (!sid) throw new Error('サーチジョブの作成に失敗しました');
                    return waitForJob(sid, ns, isStale).then(() => {
                        if (isStale()) return null;
                        const params = new URLSearchParams({ output_mode: 'json', count: String(count) });
                        return fetch(
                            `${createRESTURL(`search/jobs/${encodeURIComponent(sid)}/results`, ns)}?${params}`,
                            { ...defaultFetchInit }
                        )
                            .then(handleResponse(200))
                            .catch(handleError('サーチ結果の取得に失敗しました'));
                    });
                })
                .then((json) => {
                    if (isStale() || json === null) return;
                    // 行指向 → 列指向（viz 契約）へ。
                    // ⚠ フィールド順は splunkd 応答（fields 配列・行キー順とも）に
                    //   依存しない。同じ SPL でも呼び出しごとに順序が入れ替わる
                    //   ことが実機であった。SPL 末尾の | table / | fields 句が
                    //   あればその順序を正とする（＝ユーザーの意図そのもの）。
                    const rows = json?.results ?? [];
                    const fromFields = (json?.fields ?? []).map((f) => f?.name ?? f);
                    const observed = rows.length > 0 ? Object.keys(rows[0]) : fromFields;
                    const declared = parseDeclaredFieldOrder(query);
                    const fieldNames =
                        declared.length > 0
                            ? [
                                  ...declared.filter((n) => observed.includes(n)),
                                  ...observed.filter((n) => !declared.includes(n)),
                              ]
                            : observed;
                    const data = {
                        fields: fieldNames.map((n) => ({ name: n })),
                        columns: fieldNames.map((n) => rows.map((r) => r[n] ?? null)),
                    };
                    setState({ data, loading: false, error: null });
                })
                .catch((err) => {
                    if (isStale()) return;
                    setState({ data: null, loading: false, error: String(err?.message ?? err) });
                })
                .finally(() => {
                    if (!isStale() && refresh > 0) {
                        timer = setTimeout(runOnce, Math.max(refresh, 5) * 1000);
                    }
                });
        };

        runOnce();
        return () => {
            generation.current += 1;
            if (timer) clearTimeout(timer);
        };
    }, [spl, earliest, latest, count, refresh, searchApp]);

    return state;
}
