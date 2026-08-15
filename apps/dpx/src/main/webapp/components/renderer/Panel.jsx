// ── Panel（パネル 1 枚）──────────────────────────────────────────
//
// **サーチを実行し、viz を描き、タイトルと枠を着せる。** DPX の最小単位。
//
// ## なぜ独立したファイルなのか（2026-08-15 に分離）
//
// `DashboardRenderer.jsx` は 1,609 行あり、その **37% がこの Panel** だった。
// ⚠ ただし分けた理由は「長いから」ではない。**関心が違う**からで:
//   - Panel …… 「1 枚のパネルをどう描くか」（サーチ・viz・質感・全画面）
//   - Renderer … 「パネルをどう並べるか」（グリッド・タブ・区画・背景）
// 実際、両者が共有していたのは**寸法とアニメ表の定数だけ**（rendererConst.js へ）で、
// 状態の共有はゼロだった。＝**元から独立していたものが同居していた**。
//
// ⚠ **Renderer を import しない**（循環参照になる）。Panel は下位の部品。
// ────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createURL } from '@splunk/splunk-utils/url';

import HandDrawnFrame from './HandDrawnFrame';
import { AMBIENT_ANIM, ENTRANCE_ANIM, FULL_INSET, HAND_DRAWN_INSET, TITLE_H } from './rendererConst';
import { resolvePanelSearch, useSplunkSearch } from '../data';
import { useRegisterPanelFields } from '../viz/panelFields';
import { defaultVariantFor, resolveViz } from '../viz/registry';
import { resolveBrushToken } from '../viz/timeBrush';
import { applyTokens, useDpxTokens } from '../shared/tokens';
import {
    allowsAnimation,
    applyQuality,
    bracketArmLength,
    brushFilterCss,
    panelStyleOverrides,
    panelSurface,
    panelTitleSkin,
    useInkFilter,
} from '../design';

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

export default function Panel({
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
    rowOf,
    engine,
    layoutCtx,
    quality,
    design,
}) {
    const t = theme;
    const [menu, setMenu] = useState(null);      // {x,y} 右クリックメニュー
    const [full, setFull] = useState(false);     // 全画面表示
    const vh = useViewportHeight();
    const { tokens, setTokens } = useDpxTokens();

    // ⭐ **画材は「印」だけに当てる**（Ink Layer）。
    //   ⚠ ここでフックを条件付きで呼ばない（データ有無で早期 return する
    //     経路があるため、必ず先頭で呼ぶ）。画材が無ければ内部で何もしない。
    //   ⚠ canvas を含む viz は既定で対象外（文字が焼き込まれていて分離できない）。
    //     承知のうえで掛けたいパネルは `style.brushCanvas: true`。
    const inkRef = useInkFilter(
        brushFilterCss(design?.brush, design?.brushIntensity ?? 1),
        panel.style?.brushCanvas === true
    );

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
        // (0) 時間ブラシ（★Studio では原理的に不可能）
        // viz の上を横にドラッグして選んだ区間で、**ダッシュボード全体の
        // 時間範囲**（時間範囲入力のトークン）を書き換える。
        //
        // Studio はパネルが iframe なので、パネル内のドラッグ座標をホストの
        // 時間ピッカーへ渡せない。DPX は全パネルが同一 React ツリーにいるので
        // TokenProvider を直接叩ける。
        //
        // ⚠ 書き込み先は**時間範囲入力のトークン**であって、パネル固有の
        //   earliest/latest ではない。パネル側を直接書くと「そのパネルだけ
        //   期間が変わる」ことになり、**全体に効く**という肝心の価値が消える。
        if (e?.type === 'time.brush') {
            const token = resolveBrushToken(definition?.inputs, panel.options?.brushToken);
            // 時間範囲入力が無ければ何もしない（黙って別のトークンを書かない）。
            // viz 側でも入力の有無を見てブラシ自体を無効にしているが、
            // **書き込む側でも必ず確かめる**（片方だけの防御にしない）。
            if (token && e.payload?.earliest && e.payload?.latest) {
                setTokens({
                    [`${token}.earliest`]: e.payload.earliest,
                    [`${token}.latest`]: e.payload.latest,
                });
            }
            return;
        }

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
    // ⭐ 実寸は Layout Engine が決める（freeform では px がそのまま出る）。
    //    viz には**数値の height** が要る（'100%' だと中身が潰れる viz がある）
    const laidOutH = engine.pixelSize(panel, layoutCtx).height;
    // 配置 CSS（grid: gridColumn/gridRow / freeform: absolute+left/top/width/height）
    const layoutStyle = engine.styleFor(panel, layoutCtx);
    const contentHeight = full
        ? Math.max(vh - FULL_INSET * 2 - (hideTitle ? 0 : TITLE_H + 8), 120)
        : laidOutH - (hideTitle ? 0 : TITLE_H + 8);
    // パネルの実高さ（px）。背が低いとカギ括弧の腕を詰める（§ bracketArmLength）
    const panelPxHeight = full ? vh - FULL_INSET * 2 : laidOutH;
    // ⚠ `__handDrawn` は「canvas で実描画する画材」の指示であって CSS ではない。
    //   React に渡すと不明なスタイルとして DOM に漏れるので、必ず取り除く。
    const { __handDrawn: handDrawnMedium, ...rawSurface } = panelSurface(
        t,
        variant,
        bracketArmLength(panelPxHeight)
    );
    // ⭐ **品質レベルで重い指定を落とす**（Phase 4）。
    //    パネル数が多い盤面では `backdrop-filter` を外す＝面積比例の再ブラーを止める。
    //    ⚠ **色や配置は変えない。** 変えると「テーマが切り替わった」ように見える。
    const surface = applyQuality(rawSurface, quality, t);

    // タイトルバーの位置と質感（既定は 'auto' ＝ 質感に追従＝従来の見た目のまま）
    const titleAlign = panel.style?.titleAlign ?? 'left';
    const skin = panelTitleSkin(panel.style?.titleSkin, t, variant, panel.style?.accent);
    const titleSkin = skin.box;
    const titleTextStyle = skin.text;
    const titleDot = skin.dot;
    const titleDivider = Boolean(skin.divider);

    const body = (
        <div
            // E2E / 撮影ツールがパネルを一意に狙うための目印。
            // これが無いと「ページ全体から circle を拾って別パネルを掴む」ような
            // 取り違えが起きる（コネクタ線のドラッグ検証で実際に踏んだ）
            data-panel-id={panel.id}
            data-viz={panel.viz}
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
                          // ⭐ 配置は Layout Engine が決める（grid / freeform で実装が変わる）。
                          // ⚠ 行番号は `rowOf()` を通す。区画の見出し行が
                          //   挿し込まれると、その下の全パネルが1行ずつずれる
                          ...layoutStyle,
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
                // ⚠ **`position` を決め打ちしない。** freeform では Layout Engine が
                //   `absolute` を指定しており、ここで `relative` を後から書くと
                //   **通常フローの位置からのオフセットになって全パネルが縦に積まれる**
                //   （実機で発生。left/top は効いているのに絵が合わない、という形で出る）。
                //   grid のときだけ従来どおり relative にする（子の絶対配置の基準）。
                ...(full || layoutStyle.position ? null : { position: 'relative' }),
                color: t.titleColor,
                // ⚠ **手描きの枠は中身に食い込む。** canvas の枠はパネルの外周に
                //   描かれるが、CSS の border と違って**レイアウト上の幅を持たない**ので、
                //   そのままだとタイトルやグラフの上に線が重なる（実機で発生）。
                //   枠のぶんだけ内側に余白を作って、線の居場所を確保する
                ...(handDrawnMedium ? { padding: HAND_DRAWN_INSET } : null),
                // ⚠ 全画面ではアニメーションを外す。entrance は transform を使うため、
                //    残すと中の position:fixed（ツールチップ等）が壊れる（§8.z）。
                // ⚠ 傾き（style.rotate）を付けたパネルでは rise を使わない。
                //    dpxRiseIn は transform を `none` まで動かすアニメなので、
                //    **後勝ちで rotate が打ち消される**（実機で傾かず発覚）。
                //    傾いているときは transform を触らない fade に落とす。
                // 登場アニメ＋常時アニメ。両方あるときはカンマで連結する
                // （CSS の animation は複数指定できる）
                // ⭐ 品質が minimal のときはアニメを出さない（Phase 4）。
                //    `prefers-reduced-motion` もここに効く（動きで酔う利用者への配慮）
                animation: [
                    allowsAnimation(quality) && !full && mode !== 'edit' && entrance && entrance !== 'none'
                        ? ENTRANCE_ANIM[Number(panel.style?.rotate) ? 'fade' : entrance] ?? ENTRANCE_ANIM.rise
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
            {/* 手描き画材の枠は canvas で実描画する（CSS の border では
                線のふらつき・二度なぞり・かすれが作れない）。
                ⚠ パネル本体の背面に敷く（内容の上に出さない） */}
            {handDrawnMedium ? (
                <HandDrawnFrame
                    medium={handDrawnMedium}
                    color={panel.style?.accent || t.accent}
                    paper={t.paperColor}
                    seedKey={panel.id}
                    radius={surface.borderRadius ?? t.radius}
                    inset={HAND_DRAWN_INSET}
                />
            ) : null}
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
                    // ⭐⭐ **Brush の疎結合はここで成立している。**
                    //    画材が選ばれていれば**外から**質感を与えるだけで、
                    //    viz は自分が歪まされることを知らない（依存の矢印が無い）。
                    //    → **カスタム viz 30 個が無改変で質感を纏う**。
                    //
                    //    ⚠⚠ **filter をこの div に直接掛けない**（2026-08-13 に修正）。
                    //      掛けると中身が丸ごと歪み、**ラベルの文字まで波打つ**。
                    //      → `useInkFilter` が「印」だけを選んで当てる（Ink Layer）。
                    //      実機で確認済み: 棒の質感はそのままに、日本語ラベルの歪みが消えた。
                    //    ⚠ ヒットテストは元の DOM 形状で行われるので**当たり判定は無傷**。
                    <div
                        ref={inkRef}
                        style={{
                            width: '100%',
                            height: typeof contentHeight === 'number' ? contentHeight : '100%',
                        }}
                    >
                    <Viz
                        id={panel.id}
                        dataSources={{ primary: { data: data ?? { fields: [], columns: [] } } }}
                        loading={loading}
                        options={panel.options ?? {}}
                        width="100%"
                        height={contentHeight}
                        mode={mode}
                        // viz 自身がオプションを書き戻す口（コネクタ線の点列など、
                        // **キャンバス上のドラッグでしか決まらない値**のために要る）。
                        // ⚠ 以前は `() => {}` の空実装だった。viz 側は「保存された」と
                        //   思って描き続けるので、**動くのに保存されない**という
                        //   分かりにくい壊れ方をする。
                        onOptionsChange={
                            onPatchPanel
                                ? (patch) =>
                                      onPatchPanel(panel.id, {
                                          options: { ...(panel.options ?? {}), ...patch },
                                      })
                                : undefined
                        }
                        onEventTrigger={onEventTrigger}
                        // 時間ブラシの書き込み先。**null なら viz 側でブラシを出さない**
                        // （ドラッグできるのに何も起きない、という無反応 UI を作らないため）。
                        brushTarget={resolveBrushToken(definition?.inputs, panel.options?.brushToken)}
                    />
                    </div>
                )}
                {/* 編集モードの移動用オーバーレイ。
                    ⚠ **viz が自前でキャンバス編集を持つ場合は敷かない**（`canvasEdit`）。
                      敷くと viz のハンドルにポインタが一切届かず、
                      「編集モードでは線をいじれない」という Studio と同じ制約が
                      DPX にも生まれてしまう（コネクタ線で実際に踏んだ）。
                    そのぶん移動手段が減るので、**タイトルバーのドラッグは従来どおり効く**。
                    タイトル非表示のときは掴む場所が無くなるため、上端に細い帯を残す。 */}
                {editing && !Viz?.config?.canvasEdit ? (
                    <div
                        onPointerDown={(e) => onDragStart?.(panel.id, 'move', e)}
                        style={{ position: 'absolute', inset: 0, cursor: 'move' }}
                    />
                ) : null}
                {editing && Viz?.config?.canvasEdit && hideTitle ? (
                    <div
                        title="ドラッグでパネルを移動"
                        onPointerDown={(e) => onDragStart?.(panel.id, 'move', e)}
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 10, cursor: 'move' }}
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
