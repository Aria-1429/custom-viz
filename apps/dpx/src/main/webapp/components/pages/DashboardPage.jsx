import React, { useCallback, useEffect, useMemo, useState } from 'react';

import DpxBootScreen, { dismissBootSplash } from '../engine/BootScreen';
import DataSourceManager from '../engine/DataSourceManager';
import { getDataSources, migrateToDataSources, nextSourceId } from '../engine/dataSources';
import EditToolbar from '../engine/EditToolbar';
import VizPicker from '../engine/VizPicker';
import { listViz } from '../engine/vizRegistry';
import DpxDashboard from '../engine/DpxDashboard';
import { resolveTheme } from '../engine/themes';
import Inspector from '../engine/Inspector';
import { parseDpxRoute, homeHref, fetchView, saveView } from '../viewStore';
import { PlatformThemeContext } from '../extensionAdapter';
import { PanelFieldsProvider } from '../engine/panelFields';
import SplunkHomeLink from '../engine/SplunkHomeLink';
import { SearchAppContext } from '../engine/useSplunkSearch';
import { useDpxGlobalStyles } from '../engine/ui';
import { TokenProvider, initialTokensFromInputs } from '../engine/tokens';
import { VizBusProvider } from '../vizBus';
import DetachedWindow from '../engine/DetachedWindow';

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
    // モードは state で持つ（URL は History API で追随させる）。
    // 以前は mode を変えるたびに location.href を書き換えて**ページを丸ごと再読込**して
    // いたため、切替のたびに白い画面を挟んでいた。DPX は Studio と違って
    // 表示/編集が同じ React ツリーなので、再読込せず即座に切り替えられる。
    const [mode, setMode] = useState(initialMode);
    const [phase, setPhase] = useState('loading'); // loading | ready | error
    const [errorMsg, setErrorMsg] = useState(null);
    const [def, setDef] = useState(null);
    const [meta, setMeta] = useState({ owner: null, template: null, label: '' });
    const [selectedId, setSelectedId] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [saveMsg, setSaveMsg] = useState(null);
    const [migratedCount, setMigratedCount] = useState(0); // 旧形式から移行したパネル数（通知用）
    const [showSource, setShowSource] = useState(false);
    const [sourceDraft, setSourceDraft] = useState('');
    const [sourceError, setSourceError] = useState(null);
    const [activeTab, setActiveTab] = useState(null);
    const [pickerTab, setPickerTab] = useState(null); // viz ピッカー（null で非表示）
    const [selectedInputId, setSelectedInputId] = useState(null); // 選択中の入力
    // 設定を別ウィンドウに出しているか。true の間は**右カラムを畳んで**
    // ダッシュボードを全幅で見せる（「全幅で見たまま調整したい」という要件）
    const [detached, setDetached] = useState(false);
    const [history, setHistory] = useState({ past: [], future: [] });
    // データソース管理ダイアログ。
    // ⚠ 開くときに「どのデータソースを選んだ状態にするか」も持つ。
    //   パネルから飛んだのに一覧の先頭が開くと迷子になる（実機で指摘された）
    const [showDataSources, setShowDataSources] = useState(false);
    const [dsFocus, setDsFocus] = useState(null);
    const openDataSources = (focusId) => {
        setDsFocus(typeof focusId === 'string' ? focusId : null);
        setShowDataSources(true);
    };
    // キオスク表示：トップバーも Splunk ヘッダも消して中身だけにする（壁掛け用）。
    // ⚠ 抜け出せなくならないよう、Esc と画面隅のボタンの両方で戻れるようにする。
    const [kiosk, setKiosk] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchView(app, view)
            .then((v) => {
                if (cancelled) return;
                setMeta({ owner: v.owner, template: v.template, label: v.label });
                // 旧形式（パネルに SPL 直書き）はデータソース参照へ寄せてから描く。
                // ⚠ ここでは dirty にしない（開いただけで「未保存」にはしない）。
                //   保存するとその時点で新形式が書き戻る。
                const { definition, migrated } = migrateToDataSources(v.definition);
                if (migrated > 0) setMigratedCount(migrated);
                setDef(definition);
                setPhase('ready');
            })
            .catch((err) => {
                if (cancelled) return;
                setErrorMsg(String(err?.message ?? err));
                setPhase('error');
            });
        return () => {
            cancelled = true;
        };
    }, [app, view]);

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

    // ── 定義の編集ヘルパ（def が唯一の真実。ソースタブは表示時に直列化）──
    // 変更を積む（undo 用）。def の差し替え前に呼ぶこと。
    const pushHistory = useCallback(() => {
        setHistory((h) => ({ past: [...h.past.slice(-49), def], future: [] }));
    }, [def]);

    const touch = () => {
        pushHistory();
        setDirty(true);
        setSaveMsg(null);
    };

    const undo = () => {
        setHistory((h) => {
            if (h.past.length === 0) return h;
            const prev = h.past[h.past.length - 1];
            setDef(prev);
            setDirty(true);
            return { past: h.past.slice(0, -1), future: [def, ...h.future].slice(0, 50) };
        });
    };

    const redo = () => {
        setHistory((h) => {
            if (h.future.length === 0) return h;
            const next = h.future[0];
            setDef(next);
            setDirty(true);
            return { past: [...h.past, def], future: h.future.slice(1) };
        });
    };
    const patchDef = (patch) => {
        setDef((d) => ({ ...d, ...patch }));
        touch();
    };
    const patchPanel = (id, patch) => {
        setDef((d) => ({ ...d, panels: d.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
        touch();
    };
    const patchSearch = (id, patch) => {
        setDef((d) => ({
            ...d,
            panels: d.panels.map((p) => (p.id === id ? { ...p, search: { ...(p.search ?? {}), ...patch } } : p)),
        }));
        touch();
    };
    const setOption = (id, key, value) => {
        setDef((d) => ({
            ...d,
            panels: d.panels.map((p) =>
                p.id === id ? { ...p, options: { ...(p.options ?? {}), [key]: value } } : p
            ),
        }));
        touch();
    };

    // ── 入力（キャンバス上で選択・ドラッグ並べ替え）────────────────
    const addInput = (type) => {
        setDef((d) => {
            const inputs = Array.isArray(d.inputs) ? d.inputs : [];
            let n = inputs.length + 1;
            while (inputs.some((x) => x.id === `in${n}`)) n += 1;
            const id = `in${n}`;
            const base = { id, type, token: `tok${n}`, label: INPUT_LABELS[type] ?? '入力', width: 190 };
            // 選択肢が要る型には、空だと何も選べないので雛形を入れておく
            const withChoices =
                type === 'dropdown' || type === 'multiselect'
                    ? { ...base, choices: [{ label: 'すべて', value: '*' }] }
                    : base;
            setSelectedInputId(id);
            setSelectedId(null);
            return { ...d, inputs: [...inputs, withChoices] };
        });
        touch();
    };

    const reorderInputs = (next) => {
        setDef((d) => ({ ...d, inputs: next }));
        touch();
    };

    const addTab = () => {
        setDef((d) => {
            const tabs = Array.isArray(d.tabs) ? d.tabs : [];
            let n = tabs.length + 1;
            while (tabs.some((x) => x.id === `tab${n}`)) n += 1;
            return { ...d, tabs: [...tabs, { id: `tab${n}`, label: `タブ ${n}` }] };
        });
        touch();
    };

    // パネル追加は「まず viz を選ぶ」。ピッカーを開くだけで、実際の追加は
    // 選択後の createPanel が行う（作業順に UI を合わせる）。
    const addPanel = (tabId) => setPickerTab({ tabId: tabId ?? null });

    const createPanel = (vizType) => {
        setPickerTab(null);
        setDef((d) => {
            const tabs = d.tabs ?? [];
            const targetTab = tabs.length > 0 ? (pickerTab?.tabId ?? tabs[0].id) : undefined;
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
            setSelectedId(id);
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
        touch();
    };
    const removePanel = (id) => {
        setDef((d) => ({ ...d, panels: d.panels.filter((p) => p.id !== id) }));
        setSelectedId(null);
        touch();
    };

    /** パネルを複製する（右か下の空きに置く）。 */
    const duplicatePanel = (id) => {
        setDef((d) => {
            const src = d.panels.find((p) => p.id === id);
            if (!src) return d;
            let n = d.panels.length + 1;
            while (d.panels.some((p) => p.id === `p${n}`)) n += 1;
            const nid = `p${n}`;
            const cols = d.grid?.columns ?? 12;
            // 右に置けるならそこ、無理なら真下
            const right = src.x + src.w * 2 <= cols;
            const copy = {
                ...JSON.parse(JSON.stringify(src)),
                id: nid,
                x: right ? src.x + src.w : src.x,
                y: right ? src.y : src.y + src.h,
            };
            setSelectedId(nid);
            return { ...d, panels: [...d.panels, copy] };
        });
        touch();
    };

    /** 選択パネルの配置を少しずつ動かす（矢印キー用）。 */
    const nudgePanel = (id, dx, dy, resize) => {
        setDef((d) => ({
            ...d,
            panels: d.panels.map((p) => {
                if (p.id !== id) return p;
                const cols = d.grid?.columns ?? 12;
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
        }));
        touch();
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
                setDirty(false);
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
        setMode(nextMode);
        if (nextMode !== 'edit') setSelectedId(null);
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
                setSelectedId(null);
                setSelectedInputId(null);
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
    }, [mode, selectedId, dirty, onSave, def]);

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
        const onPop = () => setMode(parseDpxRoute().mode);
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
    if (phase === 'loading') {
        return <DpxBootScreen />;
    }
    if (phase === 'error') {
        return <DpxBootScreen error={errorMsg} />;
    }

    const isLegacy = def?.version !== 1;
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
            onSelectInput={setSelectedInputId}
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
            focusId={dsFocus}
            dirty={dirty}
            onSave={onSave}
            onClose={() => setShowDataSources(false)}
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
                    setShowSource((s) => {
                        if (!s) {
                            setSourceDraft(JSON.stringify(def, null, 2));
                            setSourceError(null);
                        }
                        return !s;
                    });
                }}
                onSave={onSave}
                onSwitchMode={switchMode}
                onKiosk={() => setKiosk(true)}
                onHome={goHome}
            />
            )}
            {isLegacy ? (
                <div style={{ padding: 16, color: t.errorColor, fontSize: 13 }}>
                    この定義は旧形式です。DPX スキーマ v1（{'{"version":1, "panels":[...]}'}）へ書き換えてください
                    （「ソース」から編集できます）。
                </div>
            ) : null}
            {/* パネル直書きのサーチをデータソースへ寄せたことを知らせる。
                黙って形が変わると「勝手に書き換わった」と見えるため明示する */}
            {migratedCount > 0 && mode === 'edit' ? (
                <div
                    style={{
                        margin: '0 14px 10px',
                        padding: '8px 12px',
                        borderRadius: 8,
                        fontSize: 12,
                        color: t.titleColor,
                        background: `${t.accent}1c`,
                        border: `1px solid ${t.accent}55`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                    }}
                >
                    <span style={{ flex: 1 }}>
                        パネルに直接書かれていたサーチ {migratedCount} 件を<b>データソース</b>にまとめました。
                        保存すると確定します。
                    </span>
                    <button
                        type="button"
                        onClick={() => openDataSources()}
                        style={{
                            border: `1px solid ${t.accent}88`,
                            background: 'transparent',
                            color: t.titleColor,
                            borderRadius: 6,
                            padding: '4px 10px',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        確認する
                    </button>
                    <button
                        type="button"
                        onClick={() => setMigratedCount(0)}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: t.subColor,
                            cursor: 'pointer',
                            fontSize: 14,
                            lineHeight: 1,
                            padding: 2,
                        }}
                    >
                        ✕
                    </button>
                </div>
            ) : null}
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <div className="dpx-scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {!isLegacy && def ? (
                        <DpxDashboard
                            selectedInputId={selectedInputId}
                            onSelectInput={(id) => {
                                setSelectedInputId(id);
                                setSelectedId(null);
                            }}
                            onReorderInputs={reorderInputs}
                            toolbar={
                                mode === 'edit' ? (
                                    <EditToolbar
                                        t={t}
                                        onAddViz={(vizType) => createPanel(vizType)}
                                        onAddInput={addInput}
                                        onAddTab={addTab}
                                        canUndo={history.past.length > 0}
                                        canRedo={history.future.length > 0}
                                        onUndo={undo}
                                        onRedo={redo}
                                        onOpenDataSources={openDataSources}
                                        dataSourceCount={Object.keys(getDataSources(def)).length}
                                    />
                                ) : null
                            }
                            definition={def}
                            mode={mode}
                            app={app}
                            selectedId={selectedId}
                            onSelect={(id) => {
                                // パネルと入力の選択は排他。どちらかを選んだら他方は外す
                                setSelectedId(id);
                                if (id) setSelectedInputId(null);
                            }}
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
                                        setDef(parsed);
                                        touch();
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
        {pickerTab ? <VizPicker t={t} onPick={createPanel} onCancel={() => setPickerTab(null)} /> : null}
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
                    {showDataSources ? dataSourceDialog : null}
                </div>
            </DetachedWindow>
        ) : null}
        {/* 別ウィンドウを開いていないときは従来どおり本体ページに出す */}
        {showDataSources && !detached ? dataSourceDialog : null}
        </TokenProvider>
        </PanelFieldsProvider>
        </VizBusProvider>
        </SearchAppContext.Provider>
        </PlatformThemeContext.Provider>
    );
};

export default DashboardPage;
