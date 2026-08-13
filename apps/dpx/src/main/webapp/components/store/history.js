// ── 編集履歴（Ctrl+Z / Ctrl+Shift+Z）────────────────────────────────
//
// 「あらゆる操作を戻せる」「戻しきったら保存できなくなる」を成立させる中核。
//
// ⚠ **なぜ関数を切り出したか**: 以前は DashboardPage の中で
//   `setHistory((h) => ({ past: [...h.past, def] }))` と書いていたが、
//   この `def` は **レンダー時のクロージャが掴んだ古い値**だった。
//   1 回のレンダーで 2 回編集すると **2 回とも同じ古い定義**が積まれ、
//   Ctrl+Z が「1 手前」ではなく「2 手前」に飛ぶ。
//   → **履歴の更新は必ず「直前の状態」を引数に取る純粋関数**にして、
//     React の state 更新関数の中だけで呼ぶ（＝古い値を掴みようがない）。
//
// ## 設計
//
// - 履歴は **定義（definition）のスナップショット列**。差分ではない。
//   ダッシュボード定義は数十 KB の JSON で、1 操作あたりの複製は誤差
//   （実測 1 スナップショット ≒ 20KB / 上限 100 手で 2MB 程度）。
//   差分にすると「区画の複製」のような**構造が大きく変わる操作**で
//   逆適用のバグが出るため、素直に丸ごと持つ。
// - **`base` を持つ**（保存直後 or 読み込み直後の定義）。
//   `dirty` は「今の定義が base と違うか」で判定する。
//   ⚠ カウンタ方式（編集で +1・undo で −1）にしてはいけない。
//   「A→B に変えて、また A に戻す」がカウンタでは 2 になり、
//   **中身は同じなのに保存ボタンが押せる**状態になる。
//
// ## 履歴をまとめる（coalesce）
//
// ドラッグ 1 回で 8 回 `onPanelLayout` が飛ぶ（セル境界を跨ぐたび）。
// 素直に積むと **Ctrl+Z がドラッグを 1 セルずつ巻き戻す**ことになり、
// 「操作 1 回＝ Ctrl+Z 1 回」という期待から外れる。
// → 同じ `coalesceKey`（例 `move:p1`）の連続操作は **1 手にまとめる**。
//   文字入力も同様（`title:p1` など）。
//
// ⚠ まとめるのは **連続しているときだけ**。間に別の操作が挟まったら
//   区切る（そうしないと「動かす→色を変える→また動かす」で
//   最初と最後の移動が合体して、間の操作だけ取り残される）。

/** 履歴の初期状態。`base` は「保存済みの姿」。 */
export function initHistory(definition) {
    return { base: definition, past: [], future: [], lastKey: null };
}

/** 上限（1 操作あたり ≒ 20KB 想定で 100 手 ≒ 2MB） */
export const HISTORY_LIMIT = 100;

/**
 * 編集を 1 手積む。
 *
 * @param h    直前の履歴
 * @param prev **変更前**の定義（これが past に積まれる）
 * @param key  まとめ用のキー。同じキーが連続したら 1 手に統合する。
 *             null/undefined なら毎回独立した 1 手になる。
 * @returns 新しい履歴
 */
export function pushHistory(h, prev, key = null) {
    // ⚠ 同じキーが連続したら **積まない**（最初の1回だけが「変更前」）。
    //   ドラッグ中の中間状態を積まないことで、Ctrl+Z がドラッグ全体を戻す。
    if (key != null && h.lastKey === key && h.past.length > 0) {
        return { ...h, future: [], lastKey: key };
    }
    return {
        base: h.base,
        past: [...h.past, prev].slice(-HISTORY_LIMIT),
        future: [], // 新しい編集をしたら redo は捨てる（分岐は持たない）
        lastKey: key ?? null,
    };
}

/**
 * 1 手戻す。
 *
 * @param h       現在の履歴
 * @param current 現在の定義（redo 用に future へ積む）
 * @returns {{history, definition}|null} 戻せないときは null
 */
export function undoHistory(h, current) {
    if (h.past.length === 0) return null;
    const definition = h.past[h.past.length - 1];
    return {
        definition,
        history: {
            base: h.base,
            past: h.past.slice(0, -1),
            future: [current, ...h.future].slice(0, HISTORY_LIMIT),
            // ⚠ まとめキーを消す。消さないと undo 直後の同種操作が
            //   「連続」と誤判定され、戻した手が積まれない
            lastKey: null,
        },
    };
}

/** 1 手進める。戻せないときは null。 */
export function redoHistory(h, current) {
    if (h.future.length === 0) return null;
    const definition = h.future[0];
    return {
        definition,
        history: {
            base: h.base,
            past: [...h.past, current].slice(-HISTORY_LIMIT),
            future: h.future.slice(1),
            lastKey: null,
        },
    };
}

/** 保存が完了したときに「今の姿」を新しい基準にする（＝dirty が false になる）。 */
export function markSaved(h, definition) {
    return { ...h, base: definition, lastKey: null };
}

export const canUndo = (h) => (h?.past?.length ?? 0) > 0;
export const canRedo = (h) => (h?.future?.length ?? 0) > 0;

/**
 * ⭐ **未保存かどうかを「中身の比較」で決める**（ユーザー指定の中核）。
 *
 * 「戻しきったら保存ボタンを押せなくする」＝ **base と同じ中身なら押せない**。
 *
 * ⚠ 参照比較（`a !== b`）では駄目。undo は past に積んだ**別オブジェクト**を
 *   復元するので、中身が同じでも参照は必ず違う。
 * ⚠ `JSON.stringify` の素の比較も駄目。**キーの順序**が違うだけで
 *   別物と判定される（`{a,b}` と `{b,a}`）。ソース編集タブで JSON を
 *   打ち直すと順序が変わりうる。→ キーをソートして直列化する。
 */
export function isDirty(h, definition) {
    if (!h) return false;
    return stableStringify(definition) !== stableStringify(h.base);
}

/**
 * ⭐ **編集内容から「まとめキー」を自動で決める**。
 *
 * ⚠ **本筋は「書き込むタイミングを絞ること」**（ドラッグ＝離した時／
 *   テキスト欄＝確定時）。まとめキーはそれが**できない入力のための保険**で、
 *   現在の対象は:
 *     - **スライダー・数値欄**（`NumberInput`。つまみを動かす間ずっと値が飛ぶ）
 *     - **矢印キーの連打**（「終わり」が無いので確定点を決められない）
 *     - **ソースタブの JSON 直接編集**（打鍵ごとに全体を差し替える）
 *   `TextInput` は v1.5.2 で確定時書き込みに変わったので**対象外**。
 *
 * 呼び出し側（インスペクタの ~100 箇所）に手でキーを配ると配り忘れが必ず出るので、
 * **patch の形から機械的に決める**。
 *
 * 規則:
 *   - **文字列・数値を 1 つだけ**変える patch は「同じ場所の連続編集」と見なして
 *     まとめる（例 `p1/title`）。文字入力・スライダーがこれに当たる。
 *   - 真偽値・複数キー・オブジェクト/配列を含む patch は **まとめない**
 *     （チェックボックスや構造の入れ替えは 1 操作ずつ戻せるべき）。
 *
 * @param scope 対象の識別子（パネル ID など）。無ければ 'def'
 * @param patch 変更内容
 * @returns まとめキー。まとめない場合は null
 */
export function coalesceKeyFor(scope, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const keys = Object.keys(patch);
    if (keys.length !== 1) return null; // 複数同時変更は1操作＝まとめない
    const v = patch[keys[0]];
    // ⚠ 真偽値はまとめない。チェックボックスを2回押すと元に戻るが、
    //   まとめると「2回分が1手」になって戻し先が消える
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    return `${scope ?? 'def'}/${keys[0]}`;
}

/** キー順に依存しない直列化（オブジェクトのキーだけソートする）。 */
export function stableStringify(value) {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys); // ⚠ 配列は順序が意味を持つのでソートしない
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
        return out;
    }
    return v;
}
