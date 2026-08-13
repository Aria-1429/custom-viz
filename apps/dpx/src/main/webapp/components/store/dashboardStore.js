// ── Dashboard Store（保存対象の状態）──────────────────────────────
//
// **ここが持つのは「保存される定義」だけ。**
// 選択状態・ダイアログの開閉・ドラッグ中の座標は `editorStore` の担当。
//
// ## なぜ分けるのか（ユーザー要件）
//
// 旧実装は `DashboardPage.jsx`（1,072 行）に **useState 20 個**が同居し、
// 保存対象と一時状態の区別が無かった。そのため:
//   - Multi Select / Copy Paste を足す先が無い
//   - 「何を保存すべきか」がコードから読み取れない
//
// **判定基準はひとつ: 「リロードしたら失われて困るか」。**
//   困る → dashboardStore（定義） / 困らない → editorStore（一時状態）
//
// ## Command 層
//
// 編集は**必ず `dispatch()` を通す**。`setDefinition` を直接呼ばない。
//
// ⚠ **履歴に載らない操作を作らないため**。旧実装では
//   「ソースタブの直接編集」「ドラッグ」が履歴から漏れていた前科がある。
//
// ⚠ **「変更前」は更新関数の中で掴む**（外で `pushHistory(def)` しない）。
//   外側で掴むと**レンダー時のクロージャの古い値**が積まれ、
//   1 レンダーに 2 回編集すると Ctrl+Z が**2 手前に飛ぶ**（実機で出た不具合）。
//
// ## 書き込むタイミング（最重要）
//
// ⭐ **ドラッグ中の座標も打鍵中の文字列も「一時的な表示状態」であって
//    保存対象ではない。** 中間状態を定義に書くから履歴が埋まる。
//    **確定時に1回だけ書く**（ドラッグ＝pointerup / テキスト欄＝blur）ことで
//    **「JSON の変化＝1操作」**が自然に成立する。
// ────────────────────────────────────────────────────────────────

import { create } from 'zustand';

import {
    canRedo as histCanRedo,
    canUndo as histCanUndo,
    coalesceKeyFor,
    initHistory,
    isDirty as histIsDirty,
    markSaved,
    pushHistory,
    redoHistory,
    undoHistory,
} from './history.js';
import { parseDefinition } from '../schema/index.js';

export const useDashboardStore = create((set, get) => ({
    // ── 状態 ───────────────────────────────────────────────────
    /** 現在の定義（スキーマ v2・既定値が埋まった状態）。未読込なら null */
    definition: null,
    /** 編集履歴（base / past / future / lastKey） */
    history: initHistory(null),
    /** 読み込み状態: idle | loading | ready | error */
    phase: 'idle',
    error: null,

    // ── 読み込み・保存 ─────────────────────────────────────────

    /**
     * 定義を読み込んで「戻る先の基準」にする。
     *
     * ⚠ **必ず `parseDefinition` を通す**（既定値を埋めるため）。
     *   生の JSON を入れると `?? 'noc'` 相当のフォールバックが
     *   コンポーネント側に必要になり、二重定義が復活する。
     */
    load(raw) {
        const r = parseDefinition(raw);
        if (!r.ok) {
            set({ phase: 'error', error: r.error, definition: null });
            return r;
        }
        set({
            definition: r.definition,
            history: initHistory(r.definition),
            phase: 'ready',
            error: null,
        });
        return r;
    },

    /** 保存が完了した：今の姿を新しい基準にする（＝dirty が false になる）。 */
    markSaved() {
        const { definition, history } = get();
        set({ history: markSaved(history, definition) });
    },

    // ── Command（編集の唯一の入口）─────────────────────────────

    /**
     * 定義を編集する。
     *
     * @param fn  変更前の定義を受け取り、新しい定義を返す関数
     * @param key まとめキー。同じキーが連続したら 1 手に統合する。
     *            省略時は patch の形から自動判定（`coalesceKeyFor`）
     */
    dispatch(fn, key = null) {
        const { definition, history } = get();
        if (!definition) return;
        const next = fn(definition);
        // 中身が変わらないなら履歴も汚さない（端に当たったドラッグなど）
        if (next === definition) return;
        set({
            definition: next,
            history: pushHistory(history, definition, key),
        });
    },

    // ── undo / redo ────────────────────────────────────────────
    //
    // ⚠ **履歴を「正」にして定義を流し込む。** 旧実装では
    //   `setDef` の中で `setHistory` の結果を外の変数に書き戻していたが、
    //   React は更新関数を即時に走らせないので**古い値が返る**
    //   （矢印キーの移動が戻らない不具合として実機に出た）。
    //   zustand は同期的に読めるので `get()` で素直に書ける。

    undo() {
        const { definition, history } = get();
        const r = undoHistory(history, definition);
        if (!r) return;
        set({ definition: r.definition, history: r.history });
    },

    redo() {
        const { definition, history } = get();
        const r = redoHistory(history, definition);
        if (!r) return;
        set({ definition: r.definition, history: r.history });
    },
}));

// ── セレクタ（派生値）───────────────────────────────────────────
//
// ⚠ **`dirty` は state で持たない。** `base` との**内容比較で導出**する。
//   カウンタ方式（編集で +1 / undo で −1）は「変えて元に戻す」で壊れ、
//   別 state 方式は undo で戻しきっても true のまま残る（両方とも実機で出た）。

export const selectDirty = (s) => histIsDirty(s.history, s.definition);
export const selectCanUndo = (s) => histCanUndo(s.history);
export const selectCanRedo = (s) => histCanRedo(s.history);
export const selectDefinition = (s) => s.definition;
export const selectPanels = (s) => s.definition?.panels ?? [];
export const selectDataSources = (s) => s.definition?.dataSources ?? {};

/** パネルを ID で引くセレクタを作る。 */
export const selectPanelById = (id) => (s) =>
    (s.definition?.panels ?? []).find((p) => p.id === id) ?? null;

// ── よく使う編集コマンド ────────────────────────────────────────
//
// **インスペクタの入力は ~100 箇所ある。** 呼び出し側にまとめキーを手で配ると
// 必ず漏れるので、**patch の形から機械的に決める**（`coalesceKeyFor`）。
// 明示したいとき（ドラッグなど）は最後の引数で上書きできる。

/** ダッシュボード直下のキーを変える。 */
export function patchDefinition(patch, key) {
    useDashboardStore.getState().dispatch(
        (d) => ({ ...d, ...patch }),
        key === undefined ? coalesceKeyFor('def', patch) : key
    );
}

/** パネル 1 枚を変える。 */
export function patchPanel(id, patch, key) {
    useDashboardStore.getState().dispatch(
        (d) => ({
            ...d,
            panels: d.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }),
        key === undefined ? coalesceKeyFor(id, patch) : key
    );
}

/** パネルの見た目（style）を変える。未指定のキーは触らない。 */
export function patchPanelStyle(id, patch, key) {
    useDashboardStore.getState().dispatch(
        (d) => ({
            ...d,
            panels: d.panels.map((p) =>
                p.id === id ? { ...p, style: { ...(p.style ?? {}), ...patch } } : p
            ),
        }),
        key === undefined ? coalesceKeyFor(`${id}/style`, patch) : key
    );
}

/** パネルのサーチ設定を変える。 */
export function patchPanelSearch(id, patch, key) {
    useDashboardStore.getState().dispatch(
        (d) => ({
            ...d,
            panels: d.panels.map((p) =>
                p.id === id ? { ...p, search: { ...(p.search ?? {}), ...patch } } : p
            ),
        }),
        key === undefined ? coalesceKeyFor(`${id}/search`, patch) : key
    );
}

/** viz のオプションを 1 つ変える。 */
export function setPanelOption(id, optionKey, value, key) {
    useDashboardStore.getState().dispatch(
        (d) => ({
            ...d,
            panels: d.panels.map((p) =>
                p.id === id ? { ...p, options: { ...(p.options ?? {}), [optionKey]: value } } : p
            ),
        }),
        key === undefined ? coalesceKeyFor(`${id}/options`, { [optionKey]: value }) : key
    );
}

/**
 * パネルを削除する。
 *
 * ⚠ **区画のメンバー一覧からも外す。** 外し忘れると、消えたパネルを
 *   参照する区画が残り、外接矩形の計算が狂う。
 */
export function removePanel(id) {
    useDashboardStore.getState().dispatch((d) => ({
        ...d,
        panels: d.panels.filter((p) => p.id !== id),
        groups: (d.groups ?? []).map((g) => ({
            ...g,
            panels: (g.panels ?? []).filter((pid) => pid !== id),
        })),
    }));
}
