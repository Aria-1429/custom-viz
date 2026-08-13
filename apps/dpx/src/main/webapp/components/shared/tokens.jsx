import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

// ── DPX トークン基盤 ─────────────────────────────────────────────
// ダッシュボード内で共有される名前付き値。入力（InputsBar）とパネルの
// クリックアクション（onEvent.setTokens）が書き、SPL・時間範囲・タイトルの
// `$name$` 置換が読む。全パネルが同一 React ツリーなので配信は即時。
// ────────────────────────────────────────────────────────────────

const TokenContext = createContext({
    tokens: {},
    setToken: () => {},
    setTokens: () => {},
    undoTokens: () => {},
    canUndo: false,
});

export function TokenProvider({ initial = {}, children }) {
    const [tokens, setTokensState] = useState(initial);
    // ⚠ **時間ブラシで絞ったら戻れなければならない。**
    //   ドラッグで期間を絞る操作は必ず「絞りすぎ」を起こすので、
    //   1手で戻せないと時間ピッカーを手で打ち直すことになり、
    //   ブラシの利点（速さ）が丸ごと消える。
    //   直前のトークン状態だけを持つ（履歴は深追いしない。
    //   複数段は「戻る」の意味が曖昧になるため）。
    const [prev, setPrev] = useState(null);

    const setToken = useCallback((name, value) => {
        setTokensState((t) => {
            setPrev(t);
            return { ...t, [name]: value };
        });
    }, []);
    const setTokens = useCallback((map) => {
        setTokensState((t) => {
            setPrev(t);
            return { ...t, ...map };
        });
    }, []);
    const undoTokens = useCallback(() => {
        setTokensState((t) => {
            if (prev === null) return t;
            setPrev(null);
            return prev;
        });
    }, [prev]);

    const value = useMemo(
        () => ({ tokens, setToken, setTokens, undoTokens, canUndo: prev !== null }),
        [tokens, setToken, setTokens, undoTokens, prev]
    );
    return <TokenContext.Provider value={value}>{children}</TokenContext.Provider>;
}

export function useDpxTokens() {
    return useContext(TokenContext);
}

/** 文字列中の $name$ を置換する。未解決トークンは missing に集める。 */
/**
 * `$token$` を展開する。
 *
 * @param optional 「未設定でも待たずに空文字へ置き換える」トークン名の集合。
 *   複数選択の入力（未選択＝絞り込みなし）に使う。ここに入れないと、
 *   `$svc$` がそのまま SPL に残って**リテラル文字列として検索されてしまう**。
 */
export function applyTokens(text, tokens, optional) {
    if (typeof text !== 'string' || text.indexOf('$') === -1) {
        return { text, missing: [] };
    }
    const missing = [];
    const replaced = text.replace(/\$([A-Za-z0-9_.]+)\$/g, (whole, name) => {
        const v = tokens?.[name];
        if (v === undefined || v === null || v === '') {
            if (optional?.has?.(name)) return '';
            missing.push(name);
            return whole;
        }
        return String(v);
    });
    return { text: replaced, missing };
}

/** 入力定義の defaultValue から初期トークンを組み立てる。 */
export function initialTokensFromInputs(inputs) {
    const t = {};
    for (const input of inputs ?? []) {
        if (!input?.token) continue;
        if (input.type === 'timerange') {
            const [earliest = '-24h', latest = 'now'] = String(input.defaultValue ?? '-24h,now').split(',');
            t[`${input.token}.earliest`] = earliest.trim();
            t[`${input.token}.latest`] = latest.trim();
        } else if (input.defaultValue !== undefined && input.defaultValue !== '') {
            t[input.token] = input.defaultValue;
        } else if (input.type === 'multiselect') {
            // ⚠ 複数選択は「未選択＝絞り込みなし」が自然な運用なので、
            //    空文字で**解決済み**にしておく。未定義のままだと参照している
            //    パネルが「トークン待ち」で永久に止まる（実機で発生）。
            t[input.token] = '';
        }
    }
    return t;
}
