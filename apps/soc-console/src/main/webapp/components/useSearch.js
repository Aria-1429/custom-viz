import { useEffect, useRef, useState } from 'react';
import { createRESTURL } from '@splunk/splunk-utils/url';
import { defaultFetchInit, handleResponse, handleError } from '@splunk/splunk-utils/fetch';

/**
 * SPL を splunkd に投げて結果行を返す React フック。
 *
 * カスタム viz（Studio 拡張）との決定的な違いはここ。
 * viz は「ホストが渡してきたデータを受け取る」だけだが、
 * このページは iframe に閉じ込められていないので、
 * ログイン中のセッションのまま search ジョブを自分で起こせる。
 *
 * 使う API は 2 本だけ:
 *   POST search/jobs              … ジョブ作成（exec_mode=blocking で完了まで待つ）
 *   GET  search/jobs/<sid>/results … 結果取得（JSON）
 *
 * @param {string} spl        実行する SPL（先頭の `search` は不要。`| makeresults` 等はそのまま）
 * @param {object} opts
 * @param {string} opts.earliest 時間範囲の開始（既定 -24h）
 * @param {string} opts.latest   時間範囲の終了（既定 now）
 * @param {number} opts.count    取得する最大行数（既定 1000）
 * @param {number} opts.nonce    値を変えると再実行する（更新ボタン用）
 * @returns {{rows: object[], loading: boolean, error: string|null}}
 */
export function useSearch(spl, { earliest = '-24h', latest = 'now', count = 1000, nonce = 0 } = {}) {
    const [state, setState] = useState({ rows: [], loading: true, error: null });

    // 直前のリクエストを無効化するための世代番号。
    // 連続実行したとき、古い応答が新しい結果を上書きしないようにする。
    const generation = useRef(0);

    useEffect(() => {
        if (!spl || !spl.trim()) {
            setState({ rows: [], loading: false, error: null });
            return undefined;
        }

        const myGen = ++generation.current;
        const isStale = () => myGen !== generation.current;

        setState((prev) => ({ ...prev, loading: true, error: null }));

        // search コマンドで始まらない SPL は `search ` を補う。
        // `|` で始まる生成コマンド（makeresults 等）はそのまま通す。
        const trimmed = spl.trim();
        const query = /^\||^search\b/i.test(trimmed) ? trimmed : `search ${trimmed}`;

        const body = new URLSearchParams({
            search: query,
            earliest_time: earliest,
            latest_time: latest,
            exec_mode: 'blocking', // ジョブ完了まで splunkd 側で待つ（ポーリング不要）
            output_mode: 'json',
            adhoc_search_level: 'smart',
        });

        fetch(createRESTURL('search/jobs'), {
            ...defaultFetchInit, // credentials + CSRF ヘッダが入る
            method: 'POST',
            headers: {
                ...defaultFetchInit.headers,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        })
            .then(handleResponse(201))
            .then((json) => {
                if (isStale()) return null;
                const sid = json && json.sid;
                if (!sid) throw new Error('サーチジョブの作成に失敗しました（sid が返りません）');

                const params = new URLSearchParams({
                    output_mode: 'json',
                    count: String(count),
                });
                return fetch(
                    `${createRESTURL(`search/jobs/${encodeURIComponent(sid)}/results`)}?${params}`,
                    { ...defaultFetchInit }
                ).then(handleResponse(200));
            })
            .then((json) => {
                if (isStale() || json === null) return;
                setState({ rows: (json && json.results) || [], loading: false, error: null });
            })
            .catch((err) => {
                if (isStale()) return;
                // handleError は Splunk の返す messages を読める形にしてくれる
                Promise.resolve(handleError('サーチに失敗しました')(err))
                    .then((msg) => {
                        if (!isStale()) {
                            setState({
                                rows: [],
                                loading: false,
                                error: typeof msg === 'string' ? msg : String(err && err.message ? err.message : err),
                            });
                        }
                    })
                    .catch(() => {
                        if (!isStale()) {
                            setState({ rows: [], loading: false, error: String(err) });
                        }
                    });
            });

        // アンマウント時は世代を進めて結果を捨てる
        return () => {
            generation.current += 1;
        };
    }, [spl, earliest, latest, count, nonce]);

    return state;
}
