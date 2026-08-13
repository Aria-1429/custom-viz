import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ── パネルのフィールド名レジストリ ───────────────────────────────
// 各パネルが自分のサーチ結果の列名をここに登録し、インスペクタ（右ペイン）が
// 読む。`editor.columnSelector` のような「列を選ぶ」editor 型に、実際の
// サーチ結果の列名を候補として出すためだけの仕組み。
//
// なぜストアが要るか:
//   サーチは Panel コンポーネントの中で useSplunkSearch が実行しており、
//   結果は Panel のローカル state にある。インスペクタは別のツリー（右ペイン）
//   なので、そのままでは列名を知る術がない。Studio は editor 側が
//   dataSourceKey からデータを引くが、DPX にはその配管が無いので自前で持つ。
//
// 設計メモ:
//   - パネル ID → 列名配列 の単純な Map。パネル削除時は unregister で消す。
//   - 列が変わらない限り再レンダリングしないよう、登録側で浅い比較をする
//     （サーチが 5 秒ごとに走る画面で毎回 setState すると全体が再描画される）。
// ────────────────────────────────────────────────────────────────

const PanelFieldsContext = createContext({ fieldsByPanel: {}, registerFields: () => {} });

export function PanelFieldsProvider({ children }) {
    const [fieldsByPanel, setFieldsByPanel] = useState({});

    const registerFields = useCallback((panelId, fields) => {
        if (!panelId) return;
        setFieldsByPanel((prev) => {
            const next = Array.isArray(fields) ? fields : [];
            const cur = prev[panelId];
            // 中身が同じなら state を変えない（無用な再描画を避ける）
            if (cur && cur.length === next.length && cur.every((f, i) => f === next[i])) {
                return prev;
            }
            return { ...prev, [panelId]: next };
        });
    }, []);

    const unregisterFields = useCallback((panelId) => {
        setFieldsByPanel((prev) => {
            if (!(panelId in prev)) return prev;
            const next = { ...prev };
            delete next[panelId];
            return next;
        });
    }, []);

    const value = useMemo(
        () => ({ fieldsByPanel, registerFields, unregisterFields }),
        [fieldsByPanel, registerFields, unregisterFields]
    );
    return <PanelFieldsContext.Provider value={value}>{children}</PanelFieldsContext.Provider>;
}

export function usePanelFields() {
    return useContext(PanelFieldsContext);
}

/** パネル側から呼ぶ。列名が変わったときだけレジストリを更新する。 */
export function useRegisterPanelFields(panelId, fields) {
    const { registerFields, unregisterFields } = usePanelFields();
    const key = Array.isArray(fields) ? fields.join('\u0000') : '';
    useEffect(() => {
        registerFields(panelId, key ? key.split('\u0000') : []);
    }, [panelId, key, registerFields]);
    useEffect(() => () => unregisterFields(panelId), [panelId, unregisterFields]);
}
