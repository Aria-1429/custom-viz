import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createURL } from '@splunk/splunk-utils/url';

import BackgroundLayer from './BackgroundLayer';
import { resolvePanelSearch } from './dataSources';
import PanelContextMenu, { buildSearchUrl, toCsv } from './PanelContextMenu';
import InputsBar from './InputsBar';
import { useRegisterPanelFields } from './panelFields';
import {
    DpxThemeContext,
    bracketArmLength,
    panelStyleOverrides,
    panelSurface,
    panelTitleSkin,
    resolveTheme,
} from './themes';
import { applyTokens, useDpxTokens } from './tokens';
import { useDpxGlobalStyles } from './ui';
import { useSplunkSearch } from './useSplunkSearch';
import { defaultVariantFor, resolveViz } from './vizRegistry';

// ── 独自ダッシュボードエンジン（作業名 DPX）─────────────────────
// スキーマ v1:
// {
//   version: 1, title, description?,
//   style?: { preset, accent?, background?, entrance? },
//   chrome?: 'dpx'|'splunk', hideHeader?: bool,
//   grid: { columns, rowHeight, gap },
//   inputs: [...],
//   tabs?: [{ id, label }],                      // 省略時は単一タブ
//   rotate?: { enabled, intervalSec },           // タブ自動送り
//   panels: [{ id, viz, title?, tab?, x, y, w, h,
//     style?: { variant, hideTitle?, z? },
//     search?: { spl, earliest?, latest?, refresh? },
//     options?: {}, onEvent?: { setTokens: {} } }]
// }
// ────────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const TITLE_H = 36;
/** 全画面表示のときに画面端に残す余白（px）。 */
const FULL_INSET = 12;

/** ビューポートの高さを購読する。全画面パネルの中身の高さを実測で決めるために使う。
 *  ⚠ viz には数値の height を渡す必要がある（'100%' だと chart が既定幅で固まる）。 */
function useViewportHeight() {
    const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
    useEffect(() => {
        const onResize = () => setVh(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    return vh;
}


/** タブの帯。横（上部）と縦（左サイドバー）の両方に対応する。
 *  ⚠ サイドバー配置は Studio に無い（Studio のタブは上部固定）。
 *     壁掛けディスプレイでは縦に並べた方が本文の横幅を使えるため用意した。 */
/**
 * ヘッダに出す時計。
 *
 * ⚠ **有効なときだけ 1 秒タイマーを回す。** 常時回すと、時計を出していない
 *   ダッシュボードでも毎秒 React の再描画が走る（パネルが多いと無駄が大きい）。
 * ⚠ 秒を出さない設定なら **30 秒間隔**で十分（毎秒起こす必要がない）。
 */
function HeaderClock({ t, cfg }) {
    const showSeconds = cfg.seconds !== false;
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), showSeconds ? 1000 : 30000);
        return () => clearInterval(id);
    }, [showSeconds]);

    const size = Number(cfg.clockSize) > 0 ? Number(cfg.clockSize) : 22;
    const time = now.toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        ...(showSeconds ? { second: '2-digit' } : {}),
    });
    const date = now.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short' });
    return (
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: 'none' }}>
            {cfg.clockDate !== false ? (
                <span style={{ fontSize: Math.max(10, size * 0.5), color: t.subColor }}>{date}</span>
            ) : null}
            <span
                style={{
                    fontSize: size,
                    fontWeight: 700,
                    color: t.titleColor,
                    // ⚠ 等幅の数字にしないと秒が変わるたびに幅が動いて隣がガタつく
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: '0.02em',
                }}
            >
                {time}
            </span>
        </span>
    );
}

/**
 * ダッシュボードの見出し。
 *
 * パネルのタイトルと同じく、以前は「左上・20px・固定」だった。
 * 位置・大きさ・質感を選べるようにする（既定は従来どおりの見た目）。
 *
 * `style.header`:
 *   align  … left（既定）| center | right
 *   size   … 見出しの文字サイズ(px)。既定 20
 *   skin   … plain（既定）| accentBar | underline | filled | glow | mono
 *   stamp  … 右端の「DPX v1 / 日付」を出すか（既定 true）
 *   clock      … ヘッダに時計を出すか（既定 false）
 *   clockSize  … 時計の文字サイズ(px)。既定 22
 *   seconds    … 秒を出すか（既定 true）
 *   clockDate  … 日付を添えるか（既定 true）
 */
function DashboardHeader({ t, definition, now }) {
    const cfg = definition.style?.header ?? {};
    const align = cfg.align ?? 'left';
    const size = Number(cfg.size) > 0 ? Number(cfg.size) : 20;
    const skin = cfg.skin ?? 'plain';
    const showStamp = cfg.stamp !== false;
    const showClock = cfg.clock === true;
    const ac = t.accent;

    // 質感ごとの装飾。⚠ `background`（一括）は使わない（§8.jj と同じ理由）
    const box = {};
    const text = { margin: 0, fontSize: size, color: t.titleColor, letterSpacing: '0.04em' };
    if (skin === 'accentBar') {
        box.boxShadow = `inset 4px 0 0 ${ac}`;
        box.paddingLeft = 12;
    } else if (skin === 'underline') {
        box.borderBottom = `2px solid ${ac}66`;
        box.paddingBottom = 8;
    } else if (skin === 'filled') {
        box.backgroundColor = `${ac}18`;
        box.padding = '8px 14px';
        box.borderRadius = t.radius;
    } else if (skin === 'glow') {
        // ⚠ text-shadow は「文字」にしか掛からないので面積が小さく、
        //    パネル全体に filter を掛けるのと違って再描画コストが小さい
        text.textShadow = `0 0 18px ${ac}88, 0 0 4px ${ac}55`;
        text.color = ac;
    } else if (skin === 'mono') {
        text.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        text.letterSpacing = '0.12em';
    }

    // 中央寄せのときはスタンプを下段に回す（同じ行に置くと見出しが中央からずれる）
    const stacked = align === 'center';

    return (
        <div style={{ marginBottom: 12, ...box }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 14,
                    justifyContent:
                        align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
                }}
            >
                {align === 'right' && (showStamp || showClock) && !stacked ? (
                    <>
                        {showStamp ? (
                            <span style={{ color: t.subColor, fontSize: 11 }}>
                                DPX v1 / {now.toLocaleDateString()}
                            </span>
                        ) : null}
                        {showClock ? <HeaderClock t={t} cfg={cfg} /> : null}
                        <span style={{ flex: 1 }} />
                    </>
                ) : null}
                <h1 style={text}>{definition.title ?? ''}</h1>
                {definition.description ? (
                    <span style={{ color: t.subColor, fontSize: 12 }}>{definition.description}</span>
                ) : null}
                {align === 'left' && (showStamp || showClock) ? (
                    <>
                        <span style={{ flex: 1 }} />
                        {showClock ? <HeaderClock t={t} cfg={cfg} /> : null}
                        {showStamp ? (
                            <span style={{ color: t.subColor, fontSize: 11 }}>
                                DPX v1 / {now.toLocaleDateString()}
                            </span>
                        ) : null}
                    </>
                ) : null}
            </div>
            {stacked && (showStamp || showClock) ? (
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'baseline',
                        gap: 12,
                        marginTop: 4,
                    }}
                >
                    {showClock ? <HeaderClock t={t} cfg={cfg} /> : null}
                    {showStamp ? (
                        <span style={{ color: t.subColor, fontSize: 11 }}>
                            DPX v1 / {now.toLocaleDateString()}
                        </span>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function TabStrip({ t, tabs, currentTab, onTabChange, rotate, mode, vertical, width = 168 }) {
    const auto = rotate?.enabled && mode !== 'edit';
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: vertical ? 'column' : 'row',
                alignItems: vertical ? 'stretch' : 'center',
                gap: vertical ? 4 : 6,
                marginBottom: vertical ? 0 : 12,
                width: vertical ? width : undefined,
                flex: vertical ? 'none' : undefined,
                paddingRight: vertical ? 12 : 0,
                borderRight: vertical ? '1px solid rgba(140,175,235,0.16)' : 'none',
                marginRight: vertical ? 14 : 0,
            }}
        >
            {tabs.map((tab) => {
                const on = tab.id === currentTab;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onTabChange?.(tab.id);
                        }}
                        style={{
                            padding: vertical ? '9px 12px' : '7px 16px',
                            textAlign: vertical ? 'left' : 'center',
                            borderRadius: vertical ? 8 : '8px 8px 0 0',
                            border: 'none',
                            borderBottom: vertical ? 'none' : `2px solid ${on ? t.accent : 'transparent'}`,
                            borderLeft: vertical ? `3px solid ${on ? t.accent : 'transparent'}` : 'none',
                            background: on ? `${t.accent}1f` : 'transparent',
                            color: on ? t.accent : t.subColor,
                            fontSize: 13,
                            fontWeight: on ? 700 : 400,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        {tab.label ?? tab.id}
                    </button>
                );
            })}
            {auto ? (
                <span
                    style={{
                        marginLeft: vertical ? 12 : 8,
                        marginTop: vertical ? 6 : 0,
                        fontSize: 10,
                        color: t.accent,
                        letterSpacing: '0.08em',
                    }}
                >
                    ● AUTO {Math.max(3, Number(rotate.intervalSec) || 15)}s
                </span>
            ) : null}
        </div>
    );
}

// 登場アニメの選択肢 → keyframes 名。
// ⚠ `rotate` を付けたパネルは必ず fade に落とす。他のアニメは transform を
//    `none` まで動かすので、**後勝ちで傾きが打ち消される**（実機で発覚・§8.aa）
const ENTRANCE_ANIM = {
    rise: 'dpxRiseIn',
    fade: 'dpxFadeIn',
    zoom: 'dpxZoomIn',
    slide: 'dpxSlideIn',
    flip: 'dpxFlipIn',
    unfold: 'dpxUnfold',
};

// 常時アニメ（パネル単位）。控えめな動きだけを用意する。
// ⚠ 動きは transform / opacity に限る。box-shadow や filter を animate すると
//    毎フレーム再描画になり、パネル数に比例して重くなる（viz-performance.md §2）
const AMBIENT_ANIM = {
    float: 'dpxFloat 4.5s ease-in-out infinite',
    breathe: 'dpxBreathe 3.6s ease-in-out infinite',
};

function Panel({
    panel,
    grid,
    theme,
    mode,
    selected,
    onSelect,
    onDragStart,
    entrance,
    index,
    definition,
    app,
    onDuplicatePanel,
    onRemovePanel,
    onPatchPanel,
    onOpenDataSources,
    onDetachSettings,
}) {
    const t = theme;
    const [menu, setMenu] = useState(null);      // {x,y} 右クリックメニュー
    const [full, setFull] = useState(false);     // 全画面表示
    const vh = useViewportHeight();
    const { tokens, setTokens } = useDpxTokens();

    // 全画面中は Esc で戻す。全画面はメニューからしか入れないので、
    // 出口が「もう一度右クリック」だけだと分かりにくい。
    useEffect(() => {
        if (!full) return undefined;
        const onKey = (e) => e.key === 'Escape' && setFull(false);
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [full]);
    // 共有データソース（search.ref）を解決する。直書き（search.spl）も従来どおり動く。
    const { spl, earliest, latest, refresh, missingRef } = resolvePanelSearch(panel, definition);
    const Viz = resolveViz(panel.viz);
    // 既定の質感。データを見せるパネルは「コーナーフレーム」（四隅のカギ括弧）、
    // **図形・装飾は枠なし**にする。
    // ⚠ 図形にパネルの枠を付けると、図形自身が描く枠と**二重になる**
    //   （コーナーフレーム図形で実際に発生。実機で確認）。
    //   図形は「絵そのもの」なので、パネル側の装飾は一切載せない。
    const variant = panel.style?.variant ?? defaultVariantFor(panel.viz);
    const hideTitle = Boolean(panel.style?.hideTitle) || variant === 'frameless';
    const z = Number(panel.style?.z ?? 1);

    // 複数選択は「未選択＝絞り込みなし」。待たずに空文字へ展開する
    // （置き換えないと `$svc$` が SPL にリテラルで残る）。
    const optionalTokens = new Set(
        (definition?.inputs ?? [])
            .filter((x) => x?.type === 'multiselect' && x?.token)
            .map((x) => x.token)
    );
    const splT = applyTokens(spl, tokens, optionalTokens);
    const earliestT = applyTokens(earliest, tokens, optionalTokens);
    const latestT = applyTokens(latest, tokens, optionalTokens);
    const titleT = applyTokens(panel.title ?? panel.id, tokens, optionalTokens);
    const missing = [...new Set([...splT.missing, ...earliestT.missing, ...latestT.missing])];
    const gated = missing.length > 0;

    const { data, loading, error } = useSplunkSearch(gated ? '' : splT.text, {
        earliest: earliestT.text,
        latest: latestT.text,
        refresh,
    });
    const editing = mode === 'edit';

    // 列名をインスペクタへ公開する（editor.columnSelector の候補に使う）。
    // ⚠ data.fields は Studio 互換の [{name}] なので、文字列に均してから渡す
    //   （オブジェクトのまま渡すと候補が [object Object] になる。実機で踏んだ）。
    // ⚠ フックなので早期 return より前に置くこと（フック数が変わると落ちる）。
    useRegisterPanelFields(panel.id, (data?.fields ?? []).map((f) => f?.name ?? f));

    const onEventTrigger = (e) => {
        // (1) クリック値をトークンへ
        const map = panel.onEvent?.setTokens;
        if (map) {
            const patch = {};
            for (const [tok, key] of Object.entries(map)) {
                if (e?.payload && e.payload[key] !== undefined) patch[tok] = e.payload[key];
            }
            if (Object.keys(patch).length > 0) setTokens(patch);
        }

        // (2) ドリルダウン（クリックで別画面へ）
        // Studio の「リンク」相当。押した行の値を URL に差し込めるように、
        // **クリックの payload もトークンとして展開できる**ようにしてある
        //   例: /app/search/search?q=index%3Dweb host%3D$click.value$
        const dd = panel.onEvent?.drilldown;
        if (dd?.enabled && dd.url) {
            const clickTokens = { ...tokens };
            for (const [k, v] of Object.entries(e?.payload ?? {})) {
                clickTokens[`click.${k}`] = v;
            }
            const built = applyTokens(String(dd.url), clickTokens, new Set()).text;
            // 相対パスなら Splunk のロケール接頭辞を付ける（絶対 URL はそのまま）
            const href = /^https?:\/\//.test(built)
                ? built
                : createURL(built.replace(/^\/+/, ''));
            if (dd.newTab === false) window.location.href = href;
            else window.open(href, '_blank', 'noopener');
        }
    };

    // ── 右クリックメニューの項目 ─────────────────────────────────
    // Studio ではパネルが iframe なので親がここを乗っ取れない。DPX だからできる。
    //
    // 編集モードでは「作る側」の操作を出す（表示モードの項目とは別物）。
    // インスペクタを開いて探さなくても、その場で複製・重なり順・
    // タイトルの有無を変えられるようにする。
    // `z` は上で解決済みのものを使う（重複宣言しない）
    const patchStyle = (patch) =>
        onPatchPanel?.(panel.id, { style: { ...(panel.style ?? {}), ...patch } });

    const editMenuItems = [
        {
            label: '複製',
            icon: '⧉',
            hint: 'Ctrl+D',
            disabled: !onDuplicatePanel,
            onClick: () => onDuplicatePanel?.(panel.id),
        },
        {
            label: 'このパネルの設定を開く',
            icon: '⚙',
            onClick: () => onSelect?.(panel.id),
        },
        {
            // 別ウィンドウ版。ダッシュボードを全幅で見たまま調整するための導線
            label: '設定を別ウィンドウで開く',
            icon: '⧉',
            disabled: !onDetachSettings,
            onClick: () => {
                onSelect?.(panel.id);
                onDetachSettings?.();
            },
        },
        {
            label: 'データソースを編集',
            icon: '⌕',
            disabled: !onOpenDataSources || !panel.search?.ref,
            onClick: () => onOpenDataSources?.(panel.search?.ref),
        },
        { divider: true },
        { label: '最前面へ', icon: '↑', onClick: () => patchStyle({ z: z + 1 }) },
        { label: '最背面へ', icon: '↓', onClick: () => patchStyle({ z: Math.max(0, z - 1) }) },
        {
            label: hideTitle ? 'タイトルバーを出す' : 'タイトルバーを隠す',
            icon: '▤',
            // frameless はタイトルを持たない質感なので触らせない
            disabled: variant === 'frameless',
            onClick: () => patchStyle({ hideTitle: !panel.style?.hideTitle }),
        },
        { divider: true },
        { label: 'SPL をコピー', icon: '⧉', disabled: !splT.text, onClick: () => navigator.clipboard?.writeText(splT.text) },
        {
            label: '削除',
            icon: '✕',
            danger: true,
            disabled: !onRemovePanel,
            onClick: () => onRemovePanel?.(panel.id),
        },
    ];

    const viewMenuItems = [
        {
            label: 'サーチで開く',
            icon: '⌕',
            hint: '新しいタブ',
            disabled: !splT.text,
            onClick: () => {
                const url = buildSearchUrl({
                    app,
                    spl: splT.text,
                    earliest: earliestT.text,
                    latest: latestT.text,
                });
                window.open(url, '_blank', 'noopener');
            },
        },
        {
            label: 'SPL をコピー',
            icon: '⧉',
            disabled: !splT.text,
            onClick: () => navigator.clipboard?.writeText(splT.text),
        },
        {
            label: '結果を CSV で保存',
            icon: '⤓',
            disabled: !(data?.columns ?? []).length,
            onClick: () => {
                const blob = new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${panel.id}.csv`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            },
        },
        { divider: true },
        { label: full ? '全画面を解除' : '全画面表示', icon: '⛶', onClick: () => setFull((v) => !v) },
    ];

    // 全画面時はビューポートから逆算する。グリッド由来の高さを使うと
    // 画面いっぱいに広げても中身が元のサイズのままになる（実機で確認）。
    const contentHeight = full
        ? Math.max(vh - FULL_INSET * 2 - (hideTitle ? 0 : TITLE_H + 8), 120)
        : panel.h * grid.rowHeight + (panel.h - 1) * grid.gap - (hideTitle ? 0 : TITLE_H + 8);
    // パネルの実高さ（px）。背が低いとカギ括弧の腕を詰める（§ bracketArmLength）
    const panelPxHeight = full
        ? vh - FULL_INSET * 2
        : panel.h * grid.rowHeight + (panel.h - 1) * grid.gap;
    const surface = panelSurface(t, variant, bracketArmLength(panelPxHeight));

    // タイトルバーの位置と質感（既定は 'auto' ＝ 質感に追従＝従来の見た目のまま）
    const titleAlign = panel.style?.titleAlign ?? 'left';
    const skin = panelTitleSkin(panel.style?.titleSkin, t, variant, panel.style?.accent);
    const titleSkin = skin.box;
    const titleTextStyle = skin.text;
    const titleDot = skin.dot;
    const titleDivider = Boolean(skin.divider);

    const body = (
        <div
            onPointerDown={editing ? (e) => onSelect?.(panel.id, e) : undefined}
            // 表示モードだけ右クリックメニューを出す（編集中はブラウザ既定に任せる）
            // ⚠ 編集モードでもメニューを出す（以前はブラウザ既定に任せていた）。
            //   編集中こそ「複製・重なり順・削除」を手元で出したい。
            //   ⚠ 右クリックした瞬間に**そのパネルを選択**してから開く。
            //     選択しないまま「設定を開く」を押すと別のパネルの設定が出る
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (editing) onSelect?.(panel.id);
                setMenu({ x: e.clientX, y: e.clientY });
            }}
            style={{
                // 全画面のときはポータルで body 直下に出しているので、
                // グリッド配置（gridColumn/gridRow）は付けない。付けたままだと
                // グリッド項目として shrink-wrap され、隅に潰れる（実機で発生）。
                ...(full
                    ? { width: '100%', height: '100%' }
                    : {
                          gridColumn: `${panel.x + 1} / span ${panel.w}`,
                          gridRow: `${panel.y + 1} / span ${panel.h}`,
                          zIndex: z,
                      }),
                ...surface,
                // 角の丸みはテーマ由来（既定 2px）。パネル個別指定は下の
                // panelStyleOverrides が後勝ちで上書きする。
                // ⚠ ただし**質感が自分で borderRadius を決めている場合はそれを尊重する**
                //   （印画紙・パンチカードのように「角が立っていること」が
                //   意匠の一部の質感がある。ここで t.radius を上書きすると丸まってしまう）
                borderRadius:
                    variant === 'frameless' && !full
                        ? 0
                        : surface.borderRadius !== undefined
                          ? surface.borderRadius
                          : t.radius,
                // パネル個別の見た目上書き（色・角丸・発光・傾きなど）。
                // 全画面のときは構図用の傾き・不透明度を無効化する（読むための表示なので）
                ...panelStyleOverrides(full ? { ...panel.style, rotate: 0, opacity: 1 } : panel.style, t),
                // 選択枠は最後に上書きする（個別指定より優先。編集中に見失わないため）
                ...(selected ? { border: `2px solid ${t.selection}` } : null),
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                position: 'relative',
                color: t.titleColor,
                // ⚠ 全画面ではアニメーションを外す。entrance は transform を使うため、
                //    残すと中の position:fixed（ツールチップ等）が壊れる（§8.z）。
                // ⚠ 傾き（style.rotate）を付けたパネルでは rise を使わない。
                //    dpxRiseIn は transform を `none` まで動かすアニメなので、
                //    **後勝ちで rotate が打ち消される**（実機で傾かず発覚）。
                //    傾いているときは transform を触らない fade に落とす。
                // 登場アニメ＋常時アニメ。両方あるときはカンマで連結する
                // （CSS の animation は複数指定できる）
                animation: [
                    !full && mode !== 'edit' && entrance && entrance !== 'none'
                        ? `${ENTRANCE_ANIM[Number(panel.style?.rotate) ? 'fade' : entrance] ?? 'dpxRiseIn'} 0.5s ease both`
                        : null,
                    // ⚠ 常時アニメは編集中と全画面では止める。
                    //    編集中に動くと掴みにくく、全画面は「読むための表示」なので
                    !full && mode !== 'edit' && AMBIENT_ANIM[panel.style?.ambient]
                        ? AMBIENT_ANIM[panel.style.ambient]
                        : null,
                ]
                    .filter(Boolean)
                    .join(', ') || 'none',
                animationDelay: full ? undefined : `${Math.min(index * 70, 600)}ms`,
            }}
        >
            {hideTitle ? null : (
                <div
                    onPointerDown={editing ? (e) => onDragStart?.(panel.id, 'move', e) : undefined}
                    style={{
                        height: TITLE_H,
                        flex: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        // 位置（左/中央/右）。中央・右寄せは「1枚だけ見せる」構図で効く
                        justifyContent:
                            titleAlign === 'center' ? 'center' : titleAlign === 'right' ? 'flex-end' : 'flex-start',
                        padding: '0 12px',
                        gap: 8,
                        // ⚠ NOC 質感ではタイトルと中身の間に線を引かない
                        //    （区切り線があると「枠のある箱」に見えてしまう）
                        //    質感で「下線」を選んだときだけ明示的に引く
                        borderBottom: titleDivider
                            ? `1px solid ${panel.style?.accent || t.accent}55`
                            : variant === 'noc'
                              ? 'none'
                              : surface.border ?? 'none',
                        ...titleSkin,
                        cursor: editing ? 'move' : 'default',
                        userSelect: 'none',
                    }}
                >
                    {/* 丸は「バッジ」質感のときだけ。NOC はラベルだけの方が壁面表示で静かに見える */}
                    {titleDot ? (
                        <span
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                // パネル個別のアクセント色があればそれを使う
                                background: panel.style?.accent || t.accent,
                                flex: 'none',
                            }}
                        />
                    ) : null}
                    <span
                        style={{
                            ...titleTextStyle,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {titleT.text}
                    </span>
                    {/* 中央寄せのときに伸縮スペーサを入れると中央がずれるので、
                        左寄せのときだけ「更新中…」を右端へ押しやる */}
                    {titleAlign === 'left' ? <span style={{ flex: 1 }} /> : null}
                    {loading ? (
                        <span style={{ color: t.subColor, fontSize: 11, flex: 'none' }}>更新中…</span>
                    ) : null}
                </div>
            )}
            <div className="dpx-scroll" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                {missingRef ? (
                    <div style={{ color: t.errorColor, fontSize: 12, padding: 12 }}>
                        データソース <code>{missingRef}</code> が見つかりません（削除された可能性があります）
                    </div>
                ) : gated ? (
                    <div style={{ color: t.subColor, fontSize: 12, padding: 12 }}>
                        トークン待ち: {missing.map((m) => `$${m}$`).join(', ')}
                    </div>
                ) : error ? (
                    <div style={{ color: t.errorColor, fontSize: 12, padding: 12 }}>{error}</div>
                ) : !Viz ? (
                    <div style={{ color: t.errorColor, fontSize: 12, padding: 12 }}>
                        未登録の viz: <code>{panel.viz}</code>
                    </div>
                ) : (
                    <Viz
                        id={panel.id}
                        dataSources={{ primary: { data: data ?? { fields: [], columns: [] } } }}
                        loading={loading}
                        options={panel.options ?? {}}
                        width="100%"
                        height={contentHeight}
                        mode={mode}
                        onOptionsChange={() => {}}
                        onEventTrigger={onEventTrigger}
                    />
                )}
                {editing ? (
                    <div
                        onPointerDown={(e) => onDragStart?.(panel.id, 'move', e)}
                        style={{ position: 'absolute', inset: 0, cursor: 'move' }}
                    />
                ) : null}
            </div>
            {menu ? (
                <PanelContextMenu
                    t={t}
                    x={menu.x}
                    y={menu.y}
                    items={editing ? editMenuItems : viewMenuItems}
                    onClose={() => setMenu(null)}
                />
            ) : null}
            {full ? (
                <button
                    type="button"
                    title="全画面を解除（Esc）"
                    onClick={() => setFull(false)}
                    style={{
                        position: 'absolute',
                        top: 8,
                        right: 10,
                        zIndex: 20,
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        border: '1px solid rgba(140,175,235,0.3)',
                        background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(10,16,30,0.7)',
                        color: t.subColor,
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: 1,
                        fontFamily: 'inherit',
                    }}
                >
                    ✕
                </button>
            ) : null}
            {editing ? (
                <div
                    onPointerDown={(e) => onDragStart?.(panel.id, 'resize', e)}
                    style={{
                        position: 'absolute',
                        right: 2,
                        bottom: 2,
                        width: 16,
                        height: 16,
                        cursor: 'nwse-resize',
                        borderRight: `3px solid ${t.selection}`,
                        borderBottom: `3px solid ${t.selection}`,
                        borderRadius: 2,
                        opacity: selected ? 1 : 0.4,
                        zIndex: 10,
                    }}
                />
            ) : null}
        </div>
    );

    // ── 全画面：body へポータルする ────────────────────────────────
    // グリッド内で position:fixed にするだけでは駄目だった（実機で確認）:
    //   1. グリッド項目のままなので shrink-wrap されて隅に潰れる
    //   2. 祖先の transform（entrance アニメ）で fixed がビューポート基準に
    //      ならず、さらに overflow:hidden のスクロール枠で切り取られる（§8.z）
    // ポータルで DOM ごと外に出すのが確実。**これは Studio には作れない**
    // （パネルが iframe に閉じ込められていて外に出られない）。
    if (!full) return body;
    return createPortal(
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 5500,
                padding: FULL_INSET,
                boxSizing: 'border-box',
                background: t.colorScheme === 'light' ? 'rgba(240,244,250,0.94)' : 'rgba(6,10,20,0.9)',
                backdropFilter: 'blur(3px)',
            }}
        >
            {body}
        </div>,
        document.body
    );
}

export default function DpxDashboard({
    definition,
    mode = 'view',
    selectedId,
    onSelect,
    onPanelLayout,
    activeTab,
    onTabChange,
    selectedInputId = null,
    onSelectInput,
    app,
    onReorderInputs,
    toolbar = null,
    // 編集モードの右クリックメニュー用（無ければその項目を出さない）
    onDuplicatePanel,
    onRemovePanel,
    onPatchPanel,
    onOpenDataSources,
    onDetachSettings,
}) {
    const t = resolveTheme(definition);
    useDpxGlobalStyles(t);
    const grid = useMemo(
        () => ({ columns: 12, rowHeight: 72, gap: 12, ...(definition.grid ?? {}) }),
        [definition.grid]
    );
    const allPanels = Array.isArray(definition.panels) ? definition.panels : [];
    const tabs = Array.isArray(definition.tabs) && definition.tabs.length > 0 ? definition.tabs : null;
    // タブの配置：'top'（既定）/ 'left'（サイドバー。Studio には無い）
    const tabPos = definition.tabPosition === 'left' ? 'left' : 'top';
    const gridRef = useRef(null);
    const dragRef = useRef(null);
    const [now] = useState(() => new Date());
    // キャンバス余白の右クリックメニュー（ダッシュボード設定への入口）
    const [canvasMenu, setCanvasMenu] = useState(null);
    const showHeader = definition.hideHeader !== true;

    // タブ未指定のパネルは最初のタブに属する
    const currentTab = tabs ? activeTab ?? tabs[0].id : null;
    const panels = tabs
        ? allPanels.filter((p) => (p.tab ?? tabs[0].id) === currentTab)
        : allPanels;

    // ── タブ自動送り（ローテーション）──────────────────────────
    // ⚠ setInterval の発火回数で数えない（非アクティブタブで詰まる）。
    //    「最後に切り替えた時刻」からの経過で判定する（noc-wall の実機知見）。
    // ⚠ effect を currentTab に依存させない。依存させると切替のたびに
    //    effect が張り直されて基準時刻がリセットされ、間隔が狂う
    //    （実機で 15 秒設定が 4 秒で切り替わった）。
    const rotate = definition.rotate;
    const rotateStateRef = useRef({ lastSwitch: Date.now(), tabId: currentTab });
    rotateStateRef.current.tabId = currentTab;
    useEffect(() => {
        if (mode === 'edit' || !tabs || tabs.length < 2 || !rotate?.enabled) return undefined;
        const intervalMs = Math.max(3, Number(rotate.intervalSec) || 15) * 1000;
        rotateStateRef.current.lastSwitch = Date.now();
        const id = setInterval(() => {
            const st = rotateStateRef.current;
            if (Date.now() - st.lastSwitch < intervalMs) return;
            const idx = tabs.findIndex((x) => x.id === st.tabId);
            const next = tabs[(Math.max(idx, 0) + 1) % tabs.length];
            st.lastSwitch = Date.now();
            if (next && next.id !== st.tabId) onTabChange?.(next.id);
        }, 1000);
        return () => clearInterval(id);
        // currentTab は意図的に依存から外している（上のコメント参照）
    }, [mode, tabs, rotate?.enabled, rotate?.intervalSec, onTabChange]);

    React.useEffect(() => {
        if (document.getElementById('dpx-anim-css')) return;
        const style = document.createElement('style');
        style.id = 'dpx-anim-css';
        style.textContent =
            '@keyframes dpxRiseIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }' +
            '@keyframes dpxFadeIn { from { opacity: 0; } to { opacity: 1; } }' +
            // ⚠ background-position ではなく transform で動かす（合成のみ＝再描画なし）。
            //    旧実装は 1920x1080 で 22fps だった（実測。詳細は BackgroundLayer.jsx）
            '@keyframes dpxGridPan { from { transform: translate3d(0,0,0); } to { transform: translate3d(48px,48px,0); } }' +
            '@keyframes dpxAurora { from { transform: translate3d(-2%, -1%, 0) scale(1.05); } to { transform: translate3d(2%, 1%, 0) scale(1.12); } }' +
            // ── 登場アニメ（追加分）────────────────────────────
            // ⚠ すべて transform / opacity だけで作る。GPU 合成に載るので
            //    面積に比例したコストにならない（viz-performance.md §2）。
            //    filter / box-shadow をアニメさせると毎フレーム再描画になる。
            '@keyframes dpxZoomIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: none; } }' +
            '@keyframes dpxSlideIn { from { opacity: 0; transform: translateX(-18px); } to { opacity: 1; transform: none; } }' +
            '@keyframes dpxFlipIn { from { opacity: 0; transform: perspective(700px) rotateX(-12deg) translateY(10px); } to { opacity: 1; transform: none; } }' +
            '@keyframes dpxUnfold { from { opacity: 0; transform: scaleY(0.82); } to { opacity: 1; transform: none; } }' +
            // ── 常時アニメ（パネル単位で任意に付ける）──────────
            '@keyframes dpxFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }' +
            '@keyframes dpxBreathe { 0%,100% { opacity: 1; } 50% { opacity: 0.82; } }' +
            // 走査線が上から下へ流れる（管制画面の意匠）。1本の細い線を動かすだけ
            '@keyframes dpxScanSweep { from { transform: translateY(-100%); } to { transform: translateY(2000%); } }' +
            // 枠を光が一周する。background-position だけを動かす
            '@keyframes dpxBorderFlow { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }';
        document.head.appendChild(style);
    }, []);

    const onDragStart = (id, kind, e) => {
        if (mode !== 'edit' || !onPanelLayout) return;
        const gridEl = gridRef.current;
        const panel = allPanels.find((p) => p.id === id);
        if (!gridEl || !panel) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect?.(id, e);

        const rect = gridEl.getBoundingClientRect();
        const cellW = (rect.width - grid.gap * (grid.columns - 1)) / grid.columns;
        const start = { x: e.clientX, y: e.clientY, panel: { ...panel } };
        dragRef.current = { id, kind, start, cellW };

        const onMove = (ev) => {
            const d = dragRef.current;
            if (!d) return;
            const dxCells = Math.round((ev.clientX - d.start.x) / (d.cellW + grid.gap));
            const dyRows = Math.round((ev.clientY - d.start.y) / (grid.rowHeight + grid.gap));
            const p0 = d.start.panel;
            if (d.kind === 'move') {
                onPanelLayout(d.id, {
                    x: clamp(p0.x + dxCells, 0, grid.columns - p0.w),
                    y: Math.max(p0.y + dyRows, 0),
                });
            } else {
                onPanelLayout(d.id, {
                    w: clamp(p0.w + dxCells, 1, grid.columns - p0.x),
                    h: Math.max(p0.h + dyRows, 1),
                });
            }
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    return (
        <DpxThemeContext.Provider value={t}>
        <div
            // キャンバスの空白をクリックしたら選択を全部解除する。
            // ⚠ パネルだけでなく**入力の選択も**解除すること。片方だけだと
            //   「入力を一度選ぶと編集 UI が出たまま戻らない」状態になる（実機で発生）。
            onPointerDown={
                mode === 'edit'
                    ? () => {
                          onSelect?.(null);
                          onSelectInput?.(null);
                      }
                    : undefined
            }
            // 余白の右クリック＝**ダッシュボード自体**の設定への入口。
            // ⚠ パネル側の onContextMenu は stopPropagation しているので、
            //    ここに来るのは「本当に余白を押したとき」だけ（実機で確認）
            onContextMenu={
                mode === 'edit'
                    ? (e) => {
                          e.preventDefault();
                          onSelect?.(null);
                          onSelectInput?.(null);
                          setCanvasMenu({ x: e.clientX, y: e.clientY });
                      }
                    : undefined
            }
            style={{
                background: t.canvasBg,
                minHeight: '100%',
                padding: '20px 24px 32px',
                boxSizing: 'border-box',
                fontFamily: t.fontFamily,
                position: 'relative',
            }}
        >
            <BackgroundLayer kind={definition.style?.background} accent={t.accent} />
            <div style={{ position: 'relative', zIndex: 1 }}>
                {showHeader ? (
                    <DashboardHeader t={t} definition={definition} now={now} />
                ) : null}

                {tabs && tabPos !== 'left' ? (
                    <TabStrip
                        t={t}
                        tabs={tabs}
                        currentTab={currentTab}
                        onTabChange={onTabChange}
                        rotate={rotate}
                        mode={mode}
                        vertical={false}
                    />
                ) : null}

                {toolbar}
                <InputsBar
                    definition={definition}
                    theme={t}
                    editing={mode === 'edit'}
                    selectedInputId={selectedInputId}
                    onSelectInput={onSelectInput}
                    onReorder={onReorderInputs}
                />
                <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                {tabs && tabPos === 'left' ? (
                    <TabStrip
                        t={t}
                        tabs={tabs}
                        currentTab={currentTab}
                        onTabChange={onTabChange}
                        rotate={rotate}
                        mode={mode}
                        vertical
                        width={Number(definition.tabWidth) || 168}
                    />
                ) : null}
                <div
                    ref={gridRef}
                    style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'grid',
                        gridTemplateColumns: `repeat(${grid.columns}, 1fr)`,
                        gridAutoRows: `${grid.rowHeight}px`,
                        gap: grid.gap,
                    }}
                >
                    {panels.map((p, i) => (
                        <Panel
                            key={p.id}
                            panel={p}
                            grid={grid}
                            theme={t}
                            mode={mode}
                            selected={selectedId === p.id}
                            onSelect={(id, e) => {
                                e?.stopPropagation?.();
                                onSelect?.(id);
                            }}
                            onDragStart={onDragStart}
                            entrance={definition.style?.entrance ?? 'rise'}
                            index={i}
                            onDuplicatePanel={onDuplicatePanel}
                            onRemovePanel={onRemovePanel}
                            onPatchPanel={onPatchPanel}
                            onOpenDataSources={onOpenDataSources}
                            onDetachSettings={onDetachSettings}
                            definition={definition}
                            app={app}
                        />
                    ))}
                </div>
                </div>
            </div>
            {canvasMenu ? (
                <PanelContextMenu
                    t={t}
                    x={canvasMenu.x}
                    y={canvasMenu.y}
                    items={[
                        {
                            label: 'ダッシュボードの設定',
                            icon: '⚙',
                            onClick: () => {
                                onSelect?.(null);
                                onSelectInput?.(null);
                            },
                        },
                        {
                            label: '設定を別ウィンドウで開く',
                            icon: '⧉',
                            disabled: !onDetachSettings,
                            onClick: () => {
                                onSelect?.(null);
                                onSelectInput?.(null);
                                onDetachSettings?.();
                            },
                        },
                    ]}
                    onClose={() => setCanvasMenu(null)}
                />
            ) : null}
        </div>
        </DpxThemeContext.Provider>
    );
}
