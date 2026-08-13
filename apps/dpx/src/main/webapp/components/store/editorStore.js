// ── Editor Store（保存しない一時状態）────────────────────────────
//
// **選択・ダイアログ・ドラッグプレビュー・モード。**
// リロードで失われて構わないものだけを置く。
//
// 判定基準: **「リロードしたら失われて困るか」**。
//   困る → `dashboardStore`（定義） / 困らない → ここ
//
// ## 選択は「3 種の排他」
//
// 編集の選択対象は **パネル / 入力 / 区画**の 3 つあり、**同時に選ばれてはいけない**。
// 旧実装は 3 つの useState を個別に持っていたため、片方だけ消す実装漏れで
// 「パネルと区画が同時に選択中」になりうる状態だった。
// → **`selection` 1 つにまとめ、種別を持たせる**ことで排他を構造的に保証する。
//
// ## Multi Select の受け皿
//
// `selection.ids` は**常に配列**。現状の UI は 1 件しか入れないが、
// 複数選択を足すときに**型を変えずに済む**（配列を前提に書いておく）。
// ────────────────────────────────────────────────────────────────

import { create } from 'zustand';

/** 選択の種別。 */
export const SEL = { PANEL: 'panel', INPUT: 'input', GROUP: 'group' };

const EMPTY_SELECTION = { kind: null, ids: [] };

export const useEditorStore = create((set, get) => ({
    // ── 状態 ───────────────────────────────────────────────────
    /** 'view' | 'edit'。URL は History API で追随させる（再読込しない） */
    mode: 'view',
    /** { kind: 'panel'|'input'|'group'|null, ids: string[] } */
    selection: EMPTY_SELECTION,
    /** ソースタブ（JSON 直接編集）を出しているか */
    showSource: false,
    /** データソース管理ダイアログ。focus は「開いたときに選ぶ ID」 */
    dataSourceDialog: { open: false, focus: null },
    /** viz ピッカー。null で非表示。{ tabId } で開く */
    vizPicker: null,
    /** 表示中のタブ ID */
    activeTab: null,
    /** キオスク表示（トップバーごと消す。壁掛け用） */
    kiosk: false,
    /** 設定を別ウィンドウに出しているか */
    detached: false,
    /**
     * ドラッグ中の見た目だけの差し替え。
     *
     * ⭐ **確定するまで定義に書かない。** ここに置くことで
     *    「絵は動くが保存ボタンは押せない」が成立する（＝定義は無傷）。
     */
    layoutPreview: null,
    /** 保存メッセージ { type: 'info'|'error', text } */
    saveMsg: null,

    // ── モード ─────────────────────────────────────────────────
    setMode(mode) {
        // モードを抜けるときは選択を落とす（編集の選択が表示モードに残らないように）
        set(mode === 'edit' ? { mode } : { mode, selection: EMPTY_SELECTION });
    },

    // ── 選択（3 種の排他）───────────────────────────────────────

    /** 単一選択。種別が変われば前の選択は自動的に外れる。 */
    select(kind, id) {
        if (!kind || !id) {
            set({ selection: EMPTY_SELECTION });
            return;
        }
        set({ selection: { kind, ids: [String(id)] } });
    },

    /**
     * 選択に足す / 外す（Multi Select 用）。
     *
     * ⚠ **種別をまたぐ複数選択は作らない。** パネルと区画を同時に選ぶと
     *   「矢印キーで何が動くか」が決められなくなる。
     *   種別が違うときは**新しい種別で選び直す**。
     */
    toggleSelect(kind, id) {
        const { selection } = get();
        const sid = String(id);
        if (selection.kind !== kind) {
            set({ selection: { kind, ids: [sid] } });
            return;
        }
        const has = selection.ids.includes(sid);
        const ids = has ? selection.ids.filter((x) => x !== sid) : [...selection.ids, sid];
        set({ selection: ids.length === 0 ? EMPTY_SELECTION : { kind, ids } });
    },

    clearSelection() {
        set({ selection: EMPTY_SELECTION });
    },

    // ── ダイアログ ─────────────────────────────────────────────

    /**
     * データソース管理を開く。
     *
     * ⚠ **どれを選んだ状態で開くかも持つ。** パネルから飛んだのに
     *   一覧の先頭が開くと迷子になる（実機で指摘された）。
     */
    openDataSources(focus = null) {
        set({ dataSourceDialog: { open: true, focus: typeof focus === 'string' ? focus : null } });
    },
    closeDataSources() {
        set({ dataSourceDialog: { open: false, focus: null } });
    },

    openVizPicker(tabId = null) {
        set({ vizPicker: { tabId } });
    },
    closeVizPicker() {
        set({ vizPicker: null });
    },

    // ── そのほか ───────────────────────────────────────────────
    setShowSource(v) {
        set({ showSource: Boolean(v) });
    },
    setActiveTab(id) {
        set({ activeTab: id });
    },
    setKiosk(v) {
        set({ kiosk: Boolean(v) });
    },
    setDetached(v) {
        set({ detached: Boolean(v) });
    },
    setLayoutPreview(p) {
        set({ layoutPreview: p });
    },
    setSaveMsg(m) {
        set({ saveMsg: m });
    },
}));

// ── セレクタ ───────────────────────────────────────────────────

export const selectMode = (s) => s.mode;
export const selectIsEdit = (s) => s.mode === 'edit';

/** 選択中のパネル ID（単一）。パネル以外を選んでいるなら null。 */
export const selectSelectedPanelId = (s) =>
    s.selection.kind === SEL.PANEL ? (s.selection.ids[0] ?? null) : null;

export const selectSelectedInputId = (s) =>
    s.selection.kind === SEL.INPUT ? (s.selection.ids[0] ?? null) : null;

export const selectSelectedGroupId = (s) =>
    s.selection.kind === SEL.GROUP ? (s.selection.ids[0] ?? null) : null;

/** 選択中の全 ID（Multi Select 用）。 */
export const selectSelectedIds = (s) => s.selection.ids;

/** その ID が選択されているか。 */
export const selectIsSelected = (kind, id) => (s) =>
    s.selection.kind === kind && s.selection.ids.includes(String(id));
