import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRESTURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit, handleResponse } from '@splunk/splunk-utils/fetch';
import { username } from '@splunk/splunk-utils/config';

// ── サーチの名前空間（1ビュー集約で必須になった）──────────────────
// 旧方式では「ビューの URL ＝所属アプリ」だったので名前空間を省略できたが、
// ホストビュー方式では URL が常に dash_platform になる。**所属アプリの
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
            const body = new URLSearchParams({
                search: query,
                earliest_time: earliest,
                latest_time: latest,
                exec_mode: 'blocking',
                output_mode: 'json',
                adhoc_search_level: 'smart',
            });

            fetch(createRESTURL('search/jobs', ns), {
                ...defaultFetchInit,
                method: 'POST',
                headers: { ...defaultFetchInit.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            })
                .then(handleResponse(201))
                .then((json) => {
                    if (isStale()) return null;
                    const sid = json && json.sid;
                    if (!sid) throw new Error('サーチジョブの作成に失敗しました');
                    const params = new URLSearchParams({ output_mode: 'json', count: String(count) });
                    return fetch(
                        `${createRESTURL(`search/jobs/${encodeURIComponent(sid)}/results`, ns)}?${params}`,
                        { ...defaultFetchInit }
                    ).then(handleResponse(200));
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
