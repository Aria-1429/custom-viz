import React, { useCallback, useEffect, useMemo, useState } from 'react';

import DpxBootScreen, { dismissBootSplash } from '../renderer/BootScreen';
import DataSourceManager from '../builder/DataSourceManager';
import { getDataSources, nextSourceId } from '../data';
import { movePanelsBy } from '../renderer/groups';
import {
    patchDefinition as storePatchDef,
    patchPanel as storePatchPanel,
    patchPanelSearch as storePatchSearch,
    removePanel as storeRemovePanel,
    selectCanRedo,
    selectCanUndo,
    selectDirty,
    setPanelOption as storeSetOption,
    useDashboardStore,
} from '../store/dashboardStore';
import {
    SEL,
    selectSelectedGroupId,
    selectSelectedInputId,
    selectSelectedPanelId,
    useEditorStore,
} from '../store/editorStore';
import EditToolbar from '../builder/EditToolbar';
import VizPicker from '../builder/VizPicker';
import { listViz } from '../viz/registry';
// ⭐ Dashboard Canvas（編集の器）。ストアから定義を取り Renderer に渡す。
//   ⚠ Renderer（DpxDashboard）を直接使わない＝定義の出どころを 1 つに保つ。
import { DashboardCanvas } from '../canvas';
import { resolveTheme } from '../design';
import Inspector from '../builder/Inspector';
import { parseDpxRoute, homeHref, fetchView, saveView } from '../data/viewStore';
import { PlatformThemeContext } from '../viz/extensionAdapter';
import { PanelFieldsProvider } from '../viz/panelFields';
import SplunkHomeLink from '../shared/SplunkHomeLink';
import { SearchAppContext } from '../data';
import { useDpxGlobalStyles } from '../shared/ui';
import { TokenProvider, initialTokensFromInputs } from '../shared/tokens';
import { VizBusProvider } from '../shared/vizBus';
import DetachedWindow from '../builder/DetachedWindow';

// ── ダッシュボード画面（ホストビュー dpx の ?id= ルート）──────────
// 定義（DPX スキーマ v1）を自前エンジンで描画・編集する。
// ルーティングは pages/dpx/index.jsx が担い、ここは
// { app, view, initialMode, onNavigateHome } を受け取るだけ。
//
// クローム（上部バー）も独自実装:
//   definition.chrome = 'dpx'（既定）… Splunk ヘッダを body>header ごと隠し、
//     DPX 専用トップバーだけにする（noc-wall で実機検証済みのテクニック）
//   definition.chrome = 'splunk' … Splunk ヘッダを残して共存する
// ────────────────────────────────────────────────────────────────

const TOPBAR_H = 48;

/** 入力を追加したときの既定ラベル（型ごと）。 */
const INPUT_LABELS = {
    dropdown: '選択',
    multiselect: '複数選択',
    text: 'キーワード',
    number: '数値',
    timerange: '期間',
    date: '日付',
    daterange: '期間（カレンダー）',
};

function useSplunkChromeHidden(hidden) {
    useEffect(() => {
        if (!hidden) return undefined;
        const style = document.createElement('style');
        style.id = 'dpx-chrome-css';
        // Splunk のヘッダはクラス名がビルドごとに変わるため構造で指定する
        style.textContent = 'body > header { display: none !important; }';
        document.head.appendChild(style);
        return () => style.remove();
    }, [hidden]);
}

function TopBar({ t, definition, app, view, mode, dirty, saveMsg, showSource, onToggleSource, onSave, onSwitchMode, onKiosk, onHome }) {
    const btn = (primary) => ({
        background: primary ? t.accent : 'transparent',
        border: primary ? 'none' : `1px solid ${t.accent}88`,
        borderRadius: 6,
        color: primary ? '#fff' : t.titleColor,
        padding: '6px 14px',
        fontSize: 12,
        cursor: 'pointer',
        opacity: 1,
    });
    return (
        <div
            style={{
                height: TOPBAR_H,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 14px',
                boxSizing: 'border-box',
                // ⚠ 地の色をテーマから取る。決め打ちの濃紺のままだと
                //    ライト系プリセット（light / paper）で**文字が見えなくなる**（実機で発生）
                background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.97)' : 'rgba(10, 16, 30, 0.97)',
                borderBottom:
                    t.colorScheme === 'light'
                        ? '1px solid rgba(20,24,31,0.14)'
                        : '1px solid rgba(90,130,200,0.3)',
                color: t.titleColor,
            }}
        >
            {/* Splunk 本体への出口。DPX は Splunk ヘッダを隠すので、
                これが無いとブラウザの戻るしか帰り道が無い */}
            <SplunkHomeLink t={t} />
            <span
                style={{
                    width: 1,
                    height: 18,
                    flex: 'none',
                    background: t.colorScheme === 'light' ? 'rgba(20,24,31,0.16)' : 'rgba(140,175,235,0.26)',
                }}
            />
            <a
                href={homeHref()}
                // SPA 内遷移（pushState）。ページ再読込が無いのでフラッシュ自体が出ない。
                // href は残す＝Ctrl/⌘ クリックの別タブは効く
                onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onHome();
                }}
                style={{ color: t.accent, fontWeight: 800, fontSize: 15, letterSpacing: '0.12em', textDecoration: 'none' }}
            >
                DPX
            </a>
            <span style={{ opacity: 0.35 }}>/</span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{definition.title || view}</span>
            <span style={{ opacity: 0.45, fontSize: 11 }}>
                {app} / {view}
            </span>
            <span style={{ flex: 1 }} />
            {saveMsg ? (
                <span style={{ fontSize: 12, color: saveMsg.type === 'error' ? '#ff7b7b' : t.subColor }}>
                    {saveMsg.text}
                </span>
            ) : null}
            {mode === 'edit' ? (
                <>
                    <button type="button" style={btn(false)} onClick={onToggleSource}>
                        {showSource ? 'インスペクタ' : 'ソース'}
                    </button>
                    <button
                        type="button"
                        style={{ ...btn(true), opacity: dirty ? 1 : 0.4, cursor: dirty ? 'pointer' : 'default' }}
                        disabled={!dirty}
                        onClick={onSave}
                    >
                        保存
                    </button>
                    <button type="button" style={btn(false)} onClick={() => onSwitchMode('view')}>
                        表示モードへ
                    </button>
                </>
            ) : (
                <>
                    {/* 壁掛け表示用。クロームを全部隠して中身だけにする */}
                    <button type="button" style={btn(false)} title="キオスク表示（K）" onClick={onKiosk}>
                        キオスク
                    </button>
                    <button type="button" style={btn(true)} onClick={() => onSwitchMode('edit')}>
                        編集
                    </button>
                </>
            )}
        </div>
    );
}

const DashboardPage = ({ app, view, initialMode = 'view', onNavigateHome }) => {
    // ── 状態はすべてストアから来る（useState は持たない）────────────
    //
    // ⭐ **保存対象（定義）と一時状態（選択・ダイアログ）を分離した。**
    //   判定基準は「リロードしたら失われて困るか」。
    //   困る → dashboardStore / 困らない → editorStore。
    //
    // ⚠ **セレクタは 1 つずつ購読する。** オブジェクトを新規生成して返すセレクタ
    //   （`(s) => ({a, b})`）は毎回別参照になり、zustand v5 は無限再レンダーになる。
    const definition = useDashboardStore((s) => s.definition);
    const phase = useDashboardStore((s) => s.phase);
    const errorMsg = useDashboardStore((s) => s.error);
    const dirty = useDashboardStore(selectDirty);
    const canUndo = useDashboardStore(selectCanUndo);
    const canRedo = useDashboardStore(selectCanRedo);
    const loadDefinition = useDashboardStore((s) => s.load);
    const dispatch = useDashboardStore((s) => s.dispatch);
    const undo = useDashboardStore((s) => s.undo);
    const redo = useDashboardStore((s) => s.redo);
    const markSavedInStore = useDashboardStore((s) => s.markSaved);

    const mode = useEditorStore((s) => s.mode);
    const setModeInStore = useEditorStore((s) => s.setMode);
    const selectedId = useEditorStore(selectSelectedPanelId);
    const selectedInputId = useEditorStore(selectSelectedInputId);
    const selectedGroupId = useEditorStore(selectSelectedGroupId);
    const selectOne = useEditorStore((s) => s.select);
    const clearSelection = useEditorStore((s) => s.clearSelection);
    const showSource = useEditorStore((s) => s.showSource);
    const setShowSource = useEditorStore((s) => s.setShowSource);
    const activeTab = useEditorStore((s) => s.activeTab);
    const setActiveTab = useEditorStore((s) => s.setActiveTab);
    const kiosk = useEditorStore((s) => s.kiosk);
    const setKiosk = useEditorStore((s) => s.setKiosk);
    const detached = useEditorStore((s) => s.detached);
    const setDetached = useEditorStore((s) => s.setDetached);
    const saveMsg = useEditorStore((s) => s.saveMsg);
    const setSaveMsg = useEditorStore((s) => s.setSaveMsg);
    const vizPicker = useEditorStore((s) => s.vizPicker);
    const openVizPicker = useEditorStore((s) => s.openVizPicker);
    const closeVizPicker = useEditorStore((s) => s.closeVizPicker);
    const dsDialog = useEditorStore((s) => s.dataSourceDialog);
    const openDataSources = useEditorStore((s) => s.openDataSources);
    const closeDataSources = useEditorStore((s) => s.closeDataSources);

    // 定義の別名（既存コードが `def` を参照しているため）
    const def = definition;

    // ── ここだけローカル state（この画面の外に出ない一時値）──────────
    // ソースタブの下書きと JSON エラー。**ストアに置く価値が無い**
    // （画面を閉じれば消えてよく、他のコンポーネントも読まない）
    const [sourceDraft, setSourceDraft] = useState('');
    const [sourceError, setSourceError] = useState(null);
    // ビューのメタ情報（保存時に必要な owner / template）。定義そのものではない
    const [meta, setMeta] = useState({ owner: null, template: null, label: '' });

    // ⚠ **URL のモードをストアへ反映する**（`?mode=edit` で開いた場合）。
    //   ストアは画面をまたいで生き続けるので、開き直しのたびに
    //   URL 側の指定で上書きしないと**前回のモードが残る**。
    useEffect(() => {
        setModeInStore(initialMode);
    }, [initialMode, setModeInStore]);

    useEffect(() => {
        let cancelled = false;
        fetchView(app, view)
            .then((v) => {
                if (cancelled) return;
                setMeta({ owner: v.owner, template: v.template, label: v.label });
                // ⭐ **必ずストアの load を通す**（parseDefinition で既定値が埋まる）。
                //   生の JSON を state に入れると `?? 'noc'` 相当のフォールバックが
                //   コンポーネント側に必要になり、二重定義が復活する。
                //   読み込んだ姿が「戻る先の基準」になる（開いた直後は dirty にならない）。
                loadDefinition(v.definition);
            })
            .catch((err) => {
                if (cancelled) return;
                useDashboardStore.setState({
                    phase: 'error',
                    error: String(err?.message ?? err),
                });
            });
        return () => {
            cancelled = true;
        };
    }, [app, view, loadDefinition]);

    const t = resolveTheme(def ?? {});
    const theme = t.colorScheme; // 既存 viz 向け（PlatformThemeContext）
    const chromeHidden = (def?.chrome ?? 'dpx') !== 'splunk';
    useSplunkChromeHidden(phase === 'ready' && chromeHidden);
    // 地の色（html/body）をテーマに追随させる。bootPaint の暗い既定を上書きする。
    // ⚠ フックなので早期 return より前に置くこと（フック数が変わると落ちる）。
    useDpxGlobalStyles(t);

    useEffect(() => {
        if (mode !== 'edit') return undefined;
        const onBeforeUnload = (e) => {
            if (dirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [mode, dirty]);

    // ── 定義の編集（すべてストアの Command 経由）────────────────────
    //
    // ⭐ **編集は必ず `dispatch()` を通す。** 定義を直接書き換えない。
    //   履歴に載らない操作を作らないための規律（旧実装では「ソースタブの
    //   直接編集」「ドラッグ」が履歴から漏れていた前科がある）。
    //
    // ⚠ **「変更前」はストアの中で掴む。** 外側のクロージャで掴むと
    //   レンダー時の古い値が積まれ、1 レンダーに 2 回編集すると
    //   Ctrl+Z が 2 手前へ飛ぶ（実機で出た不具合）。
    //
    // ⚠ **まとめキーは patch の形から自動判定される**（`coalesceKeyFor`）。
    //   インスペクタの入力は ~100 箇所あるので手で配ると必ず漏れる。
    //   明示したいとき（ドラッグなど）は最後の引数で上書きできる。
    const edit = dispatch;
    const patchDef = storePatchDef;
    const patchPanel = storePatchPanel;
    const patchSearch = storePatchSearch;
    const setOption = storeSetOption;

    // ── 入力（キャンバス上で選択・ドラッグ並べ替え）────────────────
    const addInput = (type) => {
        // ⚠ ID の採番は「今の定義」から先に決める。setDef の更新関数の中で
        //   選択状態を触ると、React が更新関数を 2 回呼んだときに二重に走る
        const inputs = Array.isArray(def?.inputs) ? def.inputs : [];
        let n = inputs.length + 1;
        while (inputs.some((x) => x.id === `in${n}`)) n += 1;
        const id = `in${n}`;
        const base = { id, type, token: `tok${n}`, label: INPUT_LABELS[type] ?? '入力', width: 190 };
        // 選択肢が要る型には、空だと何も選べないので雛形を入れておく
        const withChoices =
            type === 'dropdown' || type === 'multiselect'
                ? { ...base, choices: [{ label: 'すべて', value: '*' }] }
                : base;
        edit((d) => ({ ...d, inputs: [...(Array.isArray(d.inputs) ? d.inputs : []), withChoices] }));
        selectOne(SEL.INPUT, id);
    };

    const reorderInputs = (next) => edit((d) => ({ ...d, inputs: next }));

    /**
     * 区画（グループ）を追加する。
     *
     * ⚠ **選択中のパネルがあれば、それを最初のメンバーにする。**
     *   空の区画を作っても枠は描かれないので（メンバーの外接矩形が無い）、
     *   「追加したのに何も出ない」に見える。選択中のパネルから始めれば
     *   その場で枠が出て、何が起きたか分かる。
     */
    const addGroup = () => {
        const groups = Array.isArray(def?.groups) ? def.groups : [];
        let n = groups.length + 1;
        while (groups.some((g) => g.id === `g${n}`)) n += 1;
        const id = `g${n}`;
        const seed = selectedId ? [String(selectedId)] : [];
        edit((d) => ({
            ...d,
            groups: [
                ...(Array.isArray(d.groups) ? d.groups : []),
                { id, label: `区画 ${n}`, panels: seed, variant: 'rule' },
            ],
        }));
        selectOne(SEL.GROUP, id);
    };

    /**
     * ⭐ 区画ごと移動する（メンバー全員が相対位置を保ったまま動く）。
     *
     * ⚠ クランプは `movePanelsBy` が**グループ全体で**判定する。
     *   パネルごとに丸めると端で形が崩れる（テストで押さえてある）。
     */
    const moveGroup = (groupId, dx, dy, key = null) => {
        edit((d) => {
            const g = (d.groups ?? []).find((x) => x.id === groupId);
            if (!g) return d;
            const panels = movePanelsBy(d.panels ?? [], g.panels ?? [], dx, dy, d.layout?.grid?.columns ?? 12);
            // 動けなかった（端に当たった）ときは定義を作り替えない＝dirty にしない
            if (panels === d.panels) return d;
            return { ...d, panels };
        }, key);
    };

    /**
     * ⭐ 区画ごと複製する（メンバーのパネルもまとめて複製して新しい区画に入れる）。
     *
     * 「同じ構成をもう1系統」を1操作で作るためのもの。
     *
     * ⚠ **サーチ（`search.ref`）はそのまま共有する。** データソースまで複製すると
     *   同じ SPL が2つに増えて管理が破綻する（dataSources.js の設計方針と同じ）。
     *   複製後にパネル側で参照先を変えれば済む。
     * ⚠ 複製先は**区画の真下**（右に置くと 12 列に収まらないことが多い）。
     */
    const duplicateGroup = (groupId) => {
        // 新しい区画 ID は先に決める（選択の切替を更新関数の外でやるため）
        const groups0 = def?.groups ?? [];
        let gn = groups0.length + 1;
        while (groups0.some((x) => x.id === `g${gn}`)) gn += 1;
        const gid = `g${gn}`;

        edit((d) => {
            const g = (d.groups ?? []).find((x) => x.id === groupId);
            if (!g) return d;
            const memberIds = new Set((g.panels ?? []).map(String));
            const members = (d.panels ?? []).filter((p) => memberIds.has(String(p.id)));
            if (members.length === 0) return d;

            // 区画の高さぶん下へずらす
            const bottom = Math.max(...members.map((p) => (Number(p.y) || 0) + (Number(p.h) || 1)));
            const top = Math.min(...members.map((p) => Number(p.y) || 0));
            const dy = bottom - top;

            let pn = (d.panels ?? []).length + 1;
            const nextPanelId = () => {
                while ((d.panels ?? []).some((p) => p.id === `p${pn}`)) pn += 1;
                return `p${pn++}`;
            };
            const newPanels = [];
            const newIds = [];
            for (const src of members) {
                const nid = nextPanelId();
                newIds.push(nid);
                newPanels.push({
                    ...JSON.parse(JSON.stringify(src)),
                    id: nid,
                    y: (Number(src.y) || 0) + dy,
                });
            }

            return {
                ...d,
                panels: [...(d.panels ?? []), ...newPanels],
                groups: [
                    ...(d.groups ?? []),
                    { ...g, id: gid, label: `${g.label || g.id} のコピー`, panels: newIds },
                ],
            };
        });
        selectOne(SEL.GROUP, gid);
    };

    const addTab = () =>
        edit((d) => {
            const tabs = Array.isArray(d.tabs) ? d.tabs : [];
            let n = tabs.length + 1;
            while (tabs.some((x) => x.id === `tab${n}`)) n += 1;
            return { ...d, tabs: [...tabs, { id: `tab${n}`, label: `タブ ${n}` }] };
        });

    // パネル追加は「まず viz を選ぶ」。ピッカーを開くだけで、実際の追加は
    // 選択後の createPanel が行う（作業順に UI を合わせる）。
    const addPanel = (tabId) => openVizPicker(tabId ?? null);

    const createPanel = (vizType) => {
        closeVizPicker();
        // パネル ID は先に決める（選択の切替を更新関数の外でやるため）
        let n0 = (def?.panels ?? []).length + 1;
        while ((def?.panels ?? []).some((p) => p.id === `p${n0}`)) n0 += 1;
        const newId = `p${n0}`;
        edit((d) => {
            const tabs = d.tabs ?? [];
            const targetTab = tabs.length > 0 ? (vizPicker?.tabId ?? tabs[0].id) : undefined;
            // 追加先タブ内の最下段の下に置く
            const inTab = d.panels.filter((p) => (tabs.length === 0 ? true : (p.tab ?? tabs[0].id) === targetTab));
            const bottom = inTab.reduce((m, p) => Math.max(m, p.y + p.h), 0);
            let n = d.panels.length + 1;
            while (d.panels.some((p) => p.id === `p${n}`)) n += 1;
            const id = `p${n}`;
            const vizName = listViz().find((v) => v.type === vizType)?.name ?? '新しいパネル';
            // 既に共有データソースがあれば先頭を既定で参照する（使い回しを促す）
            const existingSources = getDataSources(d);
            const firstDs = Object.keys(existingSources)[0];
            // 1つも無いときに作る新規データソースの ID
            const newDsId = nextSourceId(d);
            return {
                ...d,
                panels: [
                    ...d.panels,
                    {
                        id,
                        viz: vizType,
                        title: `${vizName} ${n}`,
                        ...(targetTab ? { tab: targetTab } : {}),
                        x: 0,
                        y: bottom,
                        w: 6,
                        h: 3,
                        // サーチは必ずデータソース参照。既存があれば先頭を、
                        // 無ければサンプル SPL のデータソースをこの場で作る
                        // （パネルに直書きする形は v0.4.0 で廃止）
                        search: { ref: firstDs ?? newDsId },
                        options: {},
                    },
                ],
                ...(firstDs
                    ? {}
                    : {
                          dataSources: {
                              ...existingSources,
                              [newDsId]: {
                                  name: 'サンプルデータ',
                                  spl: '| makeresults count=5 | streamstats count as n | eval label="item-".n, value=(n*23) % 80 + 10 | table label value',
                              },
                          },
                      }),
            };
        });
        selectOne(SEL.PANEL, newId);
    };
    // ⚠ 区画のメンバー一覧からも外す（ストア側が面倒を見る）。
    //   外し忘れると消えたパネルを参照する区画が残り、外接矩形が狂う
    const removePanel = (id) => {
        storeRemovePanel(id);
        clearSelection();
    };

    /** パネルを複製する（右か下の空きに置く）。 */
    const duplicatePanel = (id) => {
        let n0 = (def?.panels ?? []).length + 1;
        while ((def?.panels ?? []).some((p) => p.id === `p${n0}`)) n0 += 1;
        const nid = `p${n0}`;
        edit((d) => {
            const src = d.panels.find((p) => p.id === id);
            if (!src) return d;
            const cols = d.layout?.grid?.columns ?? 12;
            // 右に置けるならそこ、無理なら真下
            const right = src.x + src.w * 2 <= cols;
            const copy = {
                ...JSON.parse(JSON.stringify(src)),
                id: nid,
                x: right ? src.x + src.w : src.x,
                y: right ? src.y : src.y + src.h,
            };
            return { ...d, panels: [...d.panels, copy] };
        });
        selectOne(SEL.PANEL, nid);
    };

    /**
     * 選択パネルの配置を少しずつ動かす（矢印キー用）。
     *
     * ⚠ **まとめキーを付ける。** 矢印を押しっぱなしにすると 1 秒で数十回飛ぶので、
     *   1 回ずつ積むと Ctrl+Z が何十回も要る。連続した同種操作は 1 手にまとめる。
     */
    const nudgePanel = (id, dx, dy, resize) => {
        edit(
            (d) => ({
                ...d,
                panels: d.panels.map((p) => {
                    if (p.id !== id) return p;
                    const cols = d.layout?.grid?.columns ?? 12;
                    if (resize) {
                        return {
                            ...p,
                            w: Math.max(1, Math.min(p.w + dx, cols - p.x)),
                            h: Math.max(1, p.h + dy),
                        };
                    }
                    return {
                        ...p,
                        x: Math.max(0, Math.min(p.x + dx, cols - p.w)),
                        y: Math.max(0, p.y + dy),
                    };
                }),
            }),
            `${resize ? 'nudge-resize' : 'nudge'}:${id}`
        );
    };

    const onSave = useCallback(() => {
        setSaveMsg({ type: 'info', text: '保存中…' });
        saveView({
            app,
            name: view,
            owner: meta.owner,
            label: def.title || view,
            definition: def,
            template: meta.template,
        })
            .then(() => {
                // 保存した姿を新しい基準にする（＝dirty が消える）。
                // ⚠ 履歴自体は残す。保存後も Ctrl+Z で戻せるほうが自然
                markSavedInStore();
                setSaveMsg({ type: 'success', text: `保存しました ${new Date().toLocaleTimeString()}` });
            })
            .catch((err) => {
                setSaveMsg({ type: 'error', text: `保存に失敗: ${String(err?.message ?? err)}` });
            });
    }, [app, view, def, meta]);

    // 表示 ⇄ 編集の切替。再読込しないので白フラッシュが起きない。
    // URL は History API で書き換えるので、リロードやブックマークでも同じモードで開ける。
    const switchMode = (nextMode) => {
        if (nextMode !== 'edit' && dirty) {
            const ok = window.confirm('保存していない変更があります。表示モードに戻りますか？');
            if (!ok) return;
        }
        const url = new URL(window.location.href);
        if (nextMode === 'edit') url.searchParams.set('mode', 'edit');
        else url.searchParams.delete('mode');
        window.history.pushState({ dpxMode: nextMode }, '', url.toString());
        setModeInStore(nextMode);
        // 選択の解除は setMode が面倒を見る（3 種すべてが同時に外れる）
    };

    // ── 編集モードのキーボード操作 ──────────────────────────────
    // ⚠ 入力欄にフォーカスがあるときは何もしない（SPL を打っている最中に
    //   Delete でパネルが消えたら事故になる）。
    useEffect(() => {
        if (mode !== 'edit') return undefined;
        const typing = (el) =>
            el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

        const onKey = (e) => {
            if (e.key === 'Escape') {
                clearSelection();
                return;
            }
            if (typing(document.activeElement)) return;

            const mod = e.ctrlKey || e.metaKey;
            // 保存（Ctrl/⌘+S）
            if (mod && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (dirty) onSave();
                return;
            }
            // undo / redo
            if (mod && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
                return;
            }
            if (mod && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redo();
                return;
            }
            // ⭐ 区画が選択されているときは**矢印で区画ごと移動**（パネルと同じ操作系）。
            //   パネルの処理より前に置く（両方選ばれることは無いが、順序を明示する）
            if (selectedGroupId) {
                const gd = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
                if (gd) {
                    e.preventDefault();
                    moveGroup(selectedGroupId, gd[0], gd[1]);
                }
                return;
            }
            if (!selectedId) return;
            // 複製（Ctrl/⌘+D）
            if (mod && e.key.toLowerCase() === 'd') {
                e.preventDefault();
                duplicatePanel(selectedId);
                return;
            }
            // 削除
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                removePanel(selectedId);
                return;
            }
            // 矢印で移動／Shift+矢印でリサイズ
            const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (delta) {
                e.preventDefault();
                nudgePanel(selectedId, delta[0], delta[1], e.shiftKey);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        // ⚠ selectedGroupId を依存に入れる。入れないと**古い選択値を掴んだまま**の
        //   ハンドラが残り、区画を選び直しても矢印が効かない（クロージャの罠）
    }, [mode, selectedId, selectedGroupId, dirty, onSave, def]);

    // 表示モードのキー操作：K でキオスク切替、Esc で解除
    useEffect(() => {
        if (mode === 'edit') return undefined;
        const onKey = (e) => {
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
            if (e.key === 'Escape') setKiosk(false);
            else if (e.key.toLowerCase() === 'k') setKiosk((v) => !v);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [mode]);

    // ブラウザの戻る／進むでモードを合わせる（pushState したので効かせる必要がある）
    useEffect(() => {
        const onPop = () => setModeInStore(parseDpxRoute().mode);
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    // ホームへ戻る（SPA）。未保存の変更があれば確認する
    // （ページ遷移ではないので beforeunload ガードが効かないため、ここで自前確認）
    const goHome = () => {
        if (dirty && !window.confirm('保存していない変更があります。ホームに戻りますか？')) return;
        onNavigateHome();
    };

    const selectedPanel = useMemo(
        () => def?.panels?.find((p) => p.id === selectedId) ?? null,
        [def, selectedId]
    );

    // 描ける状態になったら起動スプラッシュを消す。
    // ⚠ フックなので早期 return より前に置くこと（フック数が変わると落ちる）。
    useEffect(() => {
        if (phase === 'ready') dismissBootSplash();
    }, [phase]);

    // 起動スプラッシュ（Mako が出している #dpx-boot）は、中身を描ける状態に
    // なってから消す。ここで消さないと白フラッシュ対策の意味が無い。
    if (phase === 'error') {
        return <DpxBootScreen error={errorMsg} />;
    }
    // ⚠ **「読み込み中でない」ではなく「描ける」ことを条件にする。**
    //   ストアの初期値は `idle` なので、`phase === 'loading'` だけを弾くと
    //   **マウント直後の 1 フレームが def=null のまま描画に進み**、
    //   `def.tabs` で落ちる（実機で発生。ビルドでは検出できない）。
    //   定義の有無も併せて見るのが確実。
    if (phase !== 'ready' || !def) {
        return <DpxBootScreen />;
    }

    const outerHeight = chromeHidden ? '100vh' : 'calc(100vh - 80px)';

    // インスペクタ本体。**右カラムと別ウィンドウで同じものを使い回す**
    // （設定項目を二重に持つと必ず片方が古くなるため）。
    // 選択（パネル / 入力 / どちらも無し＝ダッシュボード）に追従する仕組みは
    // Inspector が既に持っているので、別ウィンドウでもそのまま効く。
    const inspectorEl = (
        <Inspector
            definition={def}
            selectedPanel={selectedPanel}
            selectedInputId={selectedInputId}
            onSelectInput={(id) => selectOne(SEL.INPUT, id)}
            selectedGroupId={selectedGroupId}
            onSelectGroup={(id) => selectOne(SEL.GROUP, id)}
            onDuplicateGroup={duplicateGroup}
            patchDef={patchDef}
            patchPanel={patchPanel}
            patchSearch={patchSearch}
            setOption={setOption}
            addPanel={addPanel}
            removePanel={removePanel}
            duplicatePanel={duplicatePanel}
            activeTab={activeTab ?? def.tabs?.[0]?.id}
            onOpenDataSources={openDataSources}
            // 別ウィンドウのときだけ広いレイアウト（タブ＋段組み）にする
            wide={detached}
        />
    );

    const dataSourceDialog = (
        <DataSourceManager
            t={t}
            definition={def}
            patchDef={patchDef}
            focusId={dsDialog.focus}
            dirty={dirty}
            onSave={onSave}
            onClose={closeDataSources}
        />
    );

    return (
        <PlatformThemeContext.Provider value={theme}>
        {/* サーチは必ず所属アプリの名前空間で走らせる（1ビュー集約の必須項目） */}
        <SearchAppContext.Provider value={app}>
        <VizBusProvider>
        <PanelFieldsProvider>
        <TokenProvider
            key={JSON.stringify(def?.inputs ?? [])}
            initial={initialTokensFromInputs(def?.inputs)}
        >
        <div style={{ display: 'flex', flexDirection: 'column', height: outerHeight, background: t.canvasBg }}>
            {kiosk ? null : (
            <TopBar
                t={t}
                definition={def}
                app={app}
                view={view}
                mode={mode}
                dirty={dirty}
                saveMsg={saveMsg}
                showSource={showSource}
                onToggleSource={() => {
                    if (!showSource) {
                        setSourceDraft(JSON.stringify(def, null, 2));
                        setSourceError(null);
                    }
                    setShowSource(!showSource);
                }}
                onSave={onSave}
                onSwitchMode={switchMode}
                onKiosk={() => setKiosk(true)}
                onHome={goHome}
            />
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <div className="dpx-scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {def ? (
                        <DashboardCanvas
                            selectedInputId={selectedInputId}
                            onSelectInput={(id) => selectOne(SEL.INPUT, id)}
                            selectedGroupId={selectedGroupId}
                            // 3種（パネル / 入力 / 区画）の排他はストアが構造的に保証する
                            onSelectGroup={(id) => selectOne(SEL.GROUP, id)}
                            onMoveGroup={moveGroup}
                            onReorderInputs={reorderInputs}
                            toolbar={
                                mode === 'edit' ? (
                                    <EditToolbar
                                        t={t}
                                        onAddViz={(vizType) => createPanel(vizType)}
                                        onAddInput={addInput}
                                        onAddTab={addTab}
                                        onAddGroup={addGroup}
                                        canUndo={canUndo}
                                        canRedo={canRedo}
                                        onUndo={undo}
                                        onRedo={redo}
                                        onOpenDataSources={openDataSources}
                                        dataSourceCount={Object.keys(getDataSources(def)).length}
                                    />
                                ) : null
                            }
                            mode={mode}
                            app={app}
                            selectedId={selectedId}
                            onSelect={(id) => selectOne(SEL.PANEL, id)}
                            onPanelLayout={patchPanel}
                            onDuplicatePanel={duplicatePanel}
                            onRemovePanel={removePanel}
                            onPatchPanel={patchPanel}
                            onOpenDataSources={openDataSources}
                            onDetachSettings={() => setDetached(true)}
                            activeTab={activeTab ?? def.tabs?.[0]?.id}
                            onTabChange={setActiveTab}
                        />
                    ) : null}
                </div>
                {mode === 'edit' ? (
                    showSource ? (
                        <div
                            style={{
                                width: 420,
                                flex: 'none',
                                display: 'flex',
                                flexDirection: 'column',
                                background: t.panelBg,
                                borderLeft: t.panelBorder,
                            }}
                        >
                            <div style={{ padding: '6px 10px', fontSize: 11, color: t.subColor }}>
                                定義ソース（編集すると即プレビュー反映）
                                {sourceError ? (
                                    <span style={{ color: t.errorColor, marginLeft: 8 }}>JSON エラー</span>
                                ) : null}
                            </div>
                            <textarea
                                className="dpx-scroll"
                                value={sourceDraft}
                                spellCheck={false}
                                onChange={(e) => {
                                    setSourceDraft(e.target.value);
                                    try {
                                        const parsed = JSON.parse(e.target.value);
                                        setSourceError(null);
                                        // ⚠ 1文字ごとに1手積むと Ctrl+Z が使い物にならない。
                                        //   連続した打鍵は1手にまとめる
                                        edit(() => parsed, 'source-edit');
                                    } catch (err) {
                                        setSourceError(String(err?.message ?? err));
                                    }
                                }}
                                style={{
                                    flex: 1,
                                    resize: 'none',
                                    border: 'none',
                                    outline: 'none',
                                    padding: 12,
                                    fontFamily: 'Menlo, Consolas, monospace',
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    // ⚠ ライト系テーマでは暗い地＋明るい文字だと浮くうえ、
                                    //    地だけ暗くして文字色を変えないと読めなくなる。必ず対で分岐する
                                    background: t.colorScheme === 'light' ? '#ffffff' : '#10192e',
                                    color: t.colorScheme === 'light' ? '#1a2333' : '#d7e3ff',
                                }}
                            />
                        </div>
                    ) : detached ? null : (
                        inspectorEl
                    )
                ) : null}
            </div>
        </div>
        {kiosk ? (
            // ⚠ キオスク中でも必ず戻れる導線を残す（Esc だけだと気づけない）
            <button
                type="button"
                title="キオスクを解除（Esc）"
                onClick={() => setKiosk(false)}
                style={{
                    position: 'fixed',
                    right: 10,
                    top: 10,
                    zIndex: 7000,
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    border: '1px solid rgba(140,175,235,0.25)',
                    background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(10,16,30,0.5)',
                    color: t.subColor,
                    cursor: 'pointer',
                    fontSize: 12,
                    lineHeight: 1,
                    opacity: 0.35,
                    fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.35'; }}
            >
                ✕
            </button>
        ) : null}
        {vizPicker ? <VizPicker t={t} onPick={createPanel} onCancel={closeVizPicker} /> : null}
        {/* 設定の別ウィンドウ。開いている間、右カラムは畳まれている（上の detached 判定）。
            ⚠ 編集モードを抜けたら閉じる（表示モードに設定ウィンドウが残ると迷子になる） */}
        {detached && mode === 'edit' && !showSource ? (
            <DetachedWindow title="DPX 設定" width={920} height={560} onClose={() => setDetached(false)}>
                <div
                    style={{
                        height: '100%',
                        // ⚠ ここでスクロールさせない。タブの中身側がスクロールを持つ
                        //   （二重スクロールになるとタブ帯まで流れて見出しが消える）
                        overflow: 'hidden',
                        background: t.panelBg,
                        color: t.textColor,
                        fontFamily: t.fontFamily,
                    }}
                >
                    {inspectorEl}
                    {/* ⚠ データソースのダイアログは**ウィンドウの中**に出す。
                        外（本体ページ側）に置くと createPortal の行き先が親ページの body になり、
                        「ボタンを押したのに何も起きない（実は後ろのダッシュボードに出ている）」
                        という状態になる（実機で再現・確認済み） */}
                    {dsDialog.open ? dataSourceDialog : null}
                </div>
            </DetachedWindow>
        ) : null}
        {/* 別ウィンドウを開いていないときは従来どおり本体ページに出す */}
        {dsDialog.open && !detached ? dataSourceDialog : null}
        </TokenProvider>
        </PanelFieldsProvider>
        </VizBusProvider>
        </SearchAppContext.Provider>
        </PlatformThemeContext.Provider>
    );
};

export default DashboardPage;
