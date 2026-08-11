import { useMemo } from 'react';

import { getDataSources } from './dataSources';
import { applyTokens } from './tokens';
import { useSplunkSearch } from './useSplunkSearch';

// ── 入力の選択肢（静的 / サーチ由来）────────────────────────────
//
// Studio から持ってきた機能。Studio の dropdown / multiselect は
// **サーチ結果から選択肢を作れる**（`ds.search` を指定して valueField /
// labelField を選ぶ）。DPX にも同じことができるようにする。
//
// スキーマ（後方互換あり。従来の `choices` はそのまま動く）:
//   {
//     id, type: 'dropdown'|'multiselect', token, label,
//     choicesMode: 'static' | 'search',        // 省略時は static
//     choices: [{ value, label }],             // static のとき
//     choiceSearch: {                          // search のとき
//       ref: 'ds_hosts',                       //   共有データソースを参照、または
//       spl: 'index=… | stats count by host',  //   直書き
//       earliest: '-24h', latest: 'now',
//       valueField: 'host',                    //   トークンに入る列
//       labelField: 'host',                    //   画面に出す列（省略時は valueField）
//     },
//     staticChoicesFirst: [{ value:'*', label:'すべて' }],  // 先頭に足す固定行
//   }
//
// ⚠ 選択肢サーチにもトークンを展開する（`$env$` で絞る等）。
//   ただし**未解決トークンがある間は実行しない**（パネルと同じ規約）。
// ────────────────────────────────────────────────────────────────

/** 入力が選択肢を必要とする型か。 */
export function needsChoices(input) {
    return input?.type === 'dropdown' || input?.type === 'multiselect';
}

/** 選択肢サーチを使う設定か。 */
export function usesSearchChoices(input) {
    return needsChoices(input) && input?.choicesMode === 'search';
}

/** 選択肢サーチの SPL/時間を解決する（共有データソース参照にも対応）。 */
export function resolveChoiceSearch(input, definition) {
    const cs = input?.choiceSearch ?? {};
    if (cs.ref) {
        const src = getDataSources(definition)[cs.ref];
        if (!src) return { spl: '', earliest: '-24h', latest: 'now', missingRef: cs.ref };
        return {
            spl: String(src.spl ?? ''),
            earliest: cs.earliest ?? src.earliest ?? '-24h',
            latest: cs.latest ?? src.latest ?? 'now',
            missingRef: null,
        };
    }
    return {
        spl: String(cs.spl ?? ''),
        earliest: cs.earliest ?? '-24h',
        latest: cs.latest ?? 'now',
        missingRef: null,
    };
}

/**
 * 入力の選択肢を解決する。
 *
 * ⚠ **フックなので条件分岐の中で呼ばない。** static のときは SPL に空文字を
 *   渡して useSplunkSearch を素通しさせる（フック数を常に一定に保つ）。
 *
 * @returns {{choices: Array<{value:string,label:string}>, loading:boolean, error:string|null}}
 */
export function useInputChoices(input, definition, tokens) {
    const useSearch = usesSearchChoices(input);
    const { spl, earliest, latest, missingRef } = resolveChoiceSearch(input, definition);

    // トークン展開。未解決が残っている間は実行しない（空 SPL にする）
    const splT = applyTokens(useSearch ? spl : '', tokens ?? {});
    const eT = applyTokens(earliest, tokens ?? {});
    const lT = applyTokens(latest, tokens ?? {});
    const gated = splT.missing.length > 0 || eT.missing.length > 0 || lT.missing.length > 0;

    const { data, loading, error } = useSplunkSearch(gated ? '' : splT.text, {
        earliest: eT.text,
        latest: lT.text,
        count: 1000,
    });

    return useMemo(() => {
        if (!useSearch) {
            return { choices: normalizeChoices(input?.choices), loading: false, error: null };
        }
        if (missingRef) {
            return { choices: [], loading: false, error: `データソース ${missingRef} が見つかりません` };
        }
        if (gated) return { choices: [], loading: true, error: null };

        const cs = input?.choiceSearch ?? {};
        const names = (data?.fields ?? []).map((f) => f?.name ?? f);
        const cols = data?.columns ?? [];
        // 列が指定されていなければ1列目を値に使う（Studio も同様の親切設計）
        const vi = names.indexOf(cs.valueField) >= 0 ? names.indexOf(cs.valueField) : 0;
        const li = names.indexOf(cs.labelField) >= 0 ? names.indexOf(cs.labelField) : vi;

        const values = cols[vi] ?? [];
        const labels = cols[li] ?? values;
        const seen = new Set();
        const dynamic = [];
        for (let i = 0; i < values.length; i += 1) {
            const v = values[i];
            if (v == null || v === '') continue;
            const key = String(v);
            if (seen.has(key)) continue; // 重複は落とす（stats by で出た値をそのまま使えるように）
            seen.add(key);
            dynamic.push({ value: key, label: String(labels[i] ?? key) });
        }
        return {
            choices: [...normalizeChoices(input?.staticChoicesFirst), ...dynamic],
            loading,
            error: error ?? null,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useSearch, input?.choices, input?.staticChoicesFirst, input?.choiceSearch, data, loading, error, gated, missingRef]);
}

/** `[{value,label}]` に均す（文字列だけの配列も許容）。 */
export function normalizeChoices(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((c) => {
            if (c == null) return null;
            if (typeof c === 'string') return { value: c, label: c };
            const value = c.value ?? c.label;
            if (value == null || value === '') return null;
            return { value: String(value), label: String(c.label ?? value) };
        })
        .filter(Boolean);
}
