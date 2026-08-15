import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import BackgroundLayer from './BackgroundLayer';
import LiquidGlassDefs from './liquidGlassDefs';
// ⭐ パネル 1 枚の描画は Panel が持つ（このファイルは「どう並べるか」だけ）。
import Panel from './Panel';
import PanelContextMenu, { buildSearchUrl, toCsv } from '../builder/PanelContextMenu';
import InputsBar from './InputsBar';
import {
    DpxThemeContext,
    groupSurface,
    groupTitleStyle,
    resolveTheme,
} from '../design';
import { applyLayoutPreview, groupInset as groupInsetPx, groupRect } from './groups';
import { useDpxGlobalStyles } from '../shared/ui';
import { SCHEMA_VERSION } from '../schema';
// ⭐ Layout Engine（grid / freeform を差し替え可能にする）。
//   座標計算は**すべてここを通す**（テストで押さえてある純粋関数）。
import { layoutFor, makeLayoutContext } from '../layout';
// ⭐ Dashboard Canvas（編集の器）。ドラッグと一時状態はすべてここが持つ。
//   Renderer（このファイル）は「定義 → 画面」だけに保つ。
import { useCanvasInteractions } from '../canvas/useCanvasInteractions';
// ⭐ タブの生存管理（どのタブを DOM に残すか）。純粋関数＋テストで方針を固定。
import { pruneTabs, tabsToRender, touchTab } from './tabLifecycle';
// ⭐ タブ 1 枚ぶんのレイアウト解決（区画の見出し行の挿し込み）。これも純粋関数。
import { GROUP_HEADER_H, panelsOfTab, resolveTabLayout } from './tabLayout';
// ⭐ **デザインは Design Engine ただ1つの入口から取る**
//    （Theme / Surface / Brush / Motion の 4 軸をまとめて解決する）
import { DesignProvider, resolveDesign } from '../design';

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

/**
 * パネルグループの枠（★Studio では原理的に不可能）。
 *
 * **パネルと同じ CSS grid に、背面レイヤとして敷く。**
 * メンバーの座標から外接矩形を出すので、パネルを動かせば枠が追従する
 * （図形を手で合わせる方式と違い、ズレようがない）。
 *
 * ⚠ **`pointerEvents: 'none'` を必ず付ける。** 枠はパネルの下に敷くが、
 *   グリッドの重なり順ではパネルより手前に来る領域が生じるため、
 *   付けないと**枠の上のクリックがパネルに届かない**（選択もドリルダウンも死ぬ）。
 *
 * ⚠ 見出しは**枠の罫を切り欠いて**置く（設計図・計器盤の意匠）。
 *   罫の上に文字を重ねると線が文字を貫いて読みにくい。
 */
function GroupFrame({ group, panels, grid, t, mode, selected, onSelect, onDragStart, rowOf, headerRows, engine, layoutCtx }) {
    const rect = groupRect(group, panels);
    if (!rect) return null;

    const pad = Number.isFinite(Number(group.pad)) ? Number(group.pad) : 8;
    // 区画が外へ広がってよい量。**gap の内側を超えない**（超えると隣のパネルに食い込む）。
    // `pad` は利用者の希望値だが、ここで必ず上限に丸める。
    const inset = groupInsetPx(pad, grid.gap);
    // ⚠ **上へ伸ばせる量は「その区画の真上が空いているか」で変わる**。
    //   最上段（y=0）は grid の paddingTop に帯ぶんの余白があるので伸ばせるが、
    //   途中の行では**上のパネルとの隙間は gap しかない**ので、
    //   帯（18px）をそのまま出すと必ず食い込む（実測 6px。ユーザー指摘）。
    //   → 上に何かある場合は `inset` までに留め、足りないぶんは
    //   見出しを中身側へ寄せて確保する。
    const atTop = rect.y === 0;
    // ⭐ 途中の区画は**手前に見出し行が確保されている**（2026-08-12・ユーザー指定）。
    //   その行を使えるので、最上段と同じように見出しの領域が取れる。
    const hasHeaderRow = !atTop && headerRows?.has?.(rect.y);
    // 見出しの帯を上へ伸ばす量。見出し行がある場合はその行が帯そのものなので伸ばさない
    const topRoom = atTop ? GROUP_HEADER_H : 0;
    // ⚠ **最上段でない区画は「見出しの居場所」が無い**（2026-08-12・実測で確定）。
    //   上はパネル（gap 12px しかない）、下はメンバーのタイトル。どちらへ逃がしても重なる:
    //     - 下へ（`top: 4`）→ **メンバーのタイトルに重なって文字が潰れた**
    //     - 上へ（`top: -13`）→ **上のパネルへ 5px 食い込んだ**（枠の箱は 7px 空いていたが、
    //       **見出しは箱の外に出る**ので、箱だけ測って「直った」と誤判定した）
    //   → **最上段でない区画では見出しを出さない**。区画の存在は罫と返しで示し、
    //   名前はインスペクタで確認する。**重なった文字を出すより、出さない方がよい**。
    //   （行を1つ空ける案は、全パネルの座標に触るので影響が大きく採らない）
    //   ⚠ ただし**編集モードでは必ず出す**。見出しは区画を選択・ドラッグする
    //   唯一の掴み手なので、隠すと区画を触れなくなる（重なっても操作性を優先する）。
    const editing = mode === 'edit';
    // 見出しを出せる条件＝**居場所がある**こと。
    // 最上段＝グリッド上部の余白／途中＝確保した見出し行。
    // 編集中は掴み手として必ず出す（重なっても操作性を優先）。
    const showLabel = atTop || hasHeaderRow || editing;
    const labelTop = 4;
    const label = String(group.label ?? '').trim();
    const surface = groupSurface(t, group.variant, group.color);
    // ⭐ 見出しの字面は**パネルのタイトル質感から導く**（区画だけ決め打ちしない）。
    //   区画側の指定 > ダッシュボードの既定、の順で解決する
    // 既定は**メンバー（先頭のパネル）のタイトル質感**に合わせる。
    // 区画は「その区画のパネル群の親」なので、中身と字面が揃う方が自然。
    const memberSkin = (panels ?? []).find((p) => (group.panels ?? []).map(String).includes(String(p.id)))
        ?.style?.titleSkin;
    const labelStyle = groupTitleStyle(group.titleSkin ?? memberSkin, t, group.color);

    return (
        <div
            data-group-id={group.id}
            style={{
                // ⭐ 枠の配置も Layout Engine を通す（メンバーの外接矩形をパネルと
                //    同じ配置規則に載せる＝図形を手で合わせる方式と違いズレようがない）。
                // ⚠ 見出しを持つ途中の区画は、**手前に確保した見出し行から**始める
                //   （その行が区画タイトルの領域になる）。最上段はグリッド上部の
                //   余白を使うので従来どおり。ここは grid 固有の調整なので
                //   `hasHeaderRow` のときだけ engine の結果を上書きする
                ...engine.styleFor({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }, layoutCtx),
                ...(hasHeaderRow
                    ? { gridRow: `${rowOf(rect.y) - 1} / span ${rect.h + 1}` }
                    : {}),
                // パネル（既定 z=1）より必ず後ろへ
                zIndex: 0,
                position: 'relative',
                // ⚠ グリッドのセル境界ぴったりだとパネルの縁と枠が重なって
                //   線が二重に見える。gap の内側へ少し広げて「囲っている」形にする。
                // ⚠ **見出しの居場所を枠自身が持つ**（2026-08-12 修正）。
                //   以前は見出しを枠の外（`top:-13`）へ逃がしていたため、
                //   **区画の上辺とパネルの上端が同じ帯に重なっていた**
                //   （ユーザー指摘・2x 拡大で確認）。
                //   上へ伸ばした帯に罫と見出しを置く。
                //   グリッド上部の余白（paddingTop）はこの帯のために空けてある。
                // ⚠ **上へも `inset` までしか伸ばせない**（2026-08-12・ユーザー指摘で修正）。
                //   ヘッダ帯（18px）をそのまま上へ出すと gap(12px) を超えるため、
                //   **区画の真上にパネルがあると必ず食い込む**（実測 6px）。
                //   最上段は grid の paddingTop に余白があるので伸ばせるが、
                //   途中の行では伸ばせない。→ **上のパネルの有無で切り替える**。
                //   伸ばせないぶんは中身側（下）へ寄せて帯の高さを確保する（headerPad）
                marginTop: -topRoom,
                // ⚠ **外へ広げてよいのは「gap の内側」まで**（2026-08-12・ユーザー指摘で修正）。
                //   パネルは元のサイズのまま動かないので、区画が gap を超えて広がると
                //   **隣・下の（区画外の）パネルに食い込む**。実測でも下端の余白が
                //   4px しか残らず、下のパネルのカギ括弧と区画の返しが重なっていた。
                //   → **4辺すべて同じ規則**（gap/2 − 1px）で丸める。
                //   こうすると「区画は必ず gap の中に収まる」ので、
                //   どのパネルとも重ならないことが**構造的に保証される**。
                //   ⚠ 以前は左右だけ gap/2、**下は生の `pad`** という非対称な実装だった
                //   （隣り合う区画の罫の連結だけを見て直したため、外側パネルを見落とした）
                marginLeft: -inset,
                marginRight: -inset,
                marginBottom: -inset,
                // ⚠ 枠自体はクリックを通す（下のパネルを触れなくなるため）。
                //   選択させたいのは**見出しだけ**なので、そこだけ pointerEvents を戻す
                pointerEvents: 'none',
                ...surface,
                // 選択中は枠を強調する（どの区画を編集しているか分かるように）
                ...(selected ? { borderTopColor: t.selection, borderColor: t.selection } : null),
            }}
        >
            {showLabel && (label || editing) ? (
                <div
                    onPointerDown={
                        editing
                            ? (e) => {
                                  // ⚠ パネルの選択解除（キャンバスの空きクリック）に
                                  //   飲まれないよう伝播を止める
                                  e.stopPropagation();
                                  onSelect?.(group.id);
                                  // ⭐ 掴んだらそのまま**区画ごと移動**できる
                                  //   （パネルのタイトルバーと同じ操作感）
                                  onDragStart?.(group.id, e);
                              }
                            : undefined
                    }
                    title={editing ? 'ドラッグで区画ごと移動 / クリックで編集' : undefined}
                    style={{
                        position: 'absolute',
                        // ⚠ 編集中だけ掴めるようにする（表示モードでは邪魔をしない）
                        pointerEvents: editing ? 'auto' : 'none',
                        // 掴んで動かせることを示す（パネルのタイトルバーと同じ move）
                        cursor: editing ? 'move' : 'default',
                        // ⚠ 区画名は短いので、**文字の幅だけ**だと掴む場所が小さすぎる。
                        //   編集中はヘッダ帯の高さぶんの当たり判定を持たせる
                        ...(editing
                            ? { paddingRight: 10, paddingBottom: 4, minWidth: 40 }
                            : null),
                        // ⚠ **見出しは枠が確保したヘッダ帯の中に置く**（枠の外へ出さない）。
                        //   外へ逃がすと、上にあるもの（パネル・ダッシュボードの見出し）と
                        //   必ず重なる。帯の中なら重なりようがない。
                        //   罫（borderTop）は帯の上端に引かれるので、見出しはその下に座る。
                        //   ⚠ 上へ伸ばせなかったぶんは下げる（`labelTop`）。
                        //   固定値にすると、途中の行の区画で**見出しがメンバーのタイトルに重なる**
                        top: labelTop,
                        // ⚠ **左端に寄せすぎない。** 罫の上に載せる配置（途中の行）では、
                        //   `left:2` だと**上のパネルの左下カギ括弧に文字が重なる**
                        //   （実機のスクリーンショットで確認）。括弧の腕（11px）を
                        //   避ける位置まで寄せる。最上段は帯の中なので従来どおりでよい
                        left: atTop ? 2 : 16,
                        padding: 0,
                        lineHeight: 1,
                        // ⭐ 字面は**パネルのタイトル質感から導く**（`groupTitleStyle`）。
                        //   ⚠ ここに fontSize / letterSpacing をベタ書きしない。
                        //   以前は決め打ちだったため、パネルのタイトル質感を変えても
                        //   **区画名だけが取り残されて「小さい・質感が違う」**状態になった
                        //   （ユーザー指摘・2026-08-12）
                        ...labelStyle,
                        // ⚠ **薄くしすぎない。** 区画名は「読めること」が最低条件。
                        //   選択中は選択色で上書きする
                        ...(selected ? { color: t.selection } : null),
                        opacity: selected ? 1 : 0.85,
                        // ⚠ 編集モードで最上段以外の区画は、見出しが**メンバーのタイトルの上**に
                        //   出る（掴み手を消せないため）。素のままだと文字が重なって読めないので、
                        //   **編集中だけ**地を敷いて可読性を確保する（表示モードでは出さない）
                        ...(editing && !atTop
                            ? {
                                  background:
                                      t.colorScheme === 'light'
                                          ? 'rgba(255,255,255,0.92)'
                                          : 'rgba(10, 16, 30, 0.92)',
                                  paddingLeft: 4,
                                  borderRadius: 3,
                              }
                            : null),
                        whiteSpace: 'nowrap',
                        maxWidth: 'calc(100% - 32px)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {/* 名前なしの区画は編集中だけ掴めるように印を出す
                        （出さないとクリックする場所が無く、選べなくなる） */}
                    {label || '（区画）'}
                </div>
            ) : null}
        </div>
    );
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
 *   stamp  … 右端の「DPX v<スキーマ版> / 日付」を出すか（既定 true）
 *            ⚠ 版はスキーマから導く（ベタ書きすると v2 化のときのように取り残される）
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
                                DPX v{SCHEMA_VERSION} / {now.toLocaleDateString()}
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
                                DPX v{SCHEMA_VERSION} / {now.toLocaleDateString()}
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
                            DPX v{SCHEMA_VERSION} / {now.toLocaleDateString()}
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
    // 区画（グループ）＝パネル・入力と並ぶ第3の選択対象
    selectedGroupId = null,
    onSelectGroup,
    onMoveGroup,
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
    // ⚠ スキーマ v2 で grid は `layout.grid` へ移った（Layout Engine 差し替えの受け皿）。
    //   既定値は parseDefinition が埋めているので、ここでのフォールバックは
    //   「ストアを通さず生の定義を渡された場合」の保険にすぎない。
    const grid = useMemo(
        () => ({ columns: 12, rowHeight: 72, gap: 12, ...(definition.layout?.grid ?? {}) }),
        [definition.layout?.grid]
    );
    // ⭐ **Layout Engine を差し替える唯一の場所**（`layout.type` で決まる）。
    //    以降の座標計算はすべて `engine` 経由にする＝ freeform を足しても
    //    Renderer 側は変更不要（Phase 3 の目的）。
    const engine = useMemo(() => layoutFor(definition), [definition.layout?.type]);

    // ⭐ **Material の品質レベル**（Phase 4）。
    //    見た目のための重い処理（backdrop-filter・発光・canvas アニメ）を
    //    パネル数と環境に応じて自動で簡略化する。
    //    ⚠ **`prefers-reduced-motion` を尊重する**（動きで酔う利用者がいる）。
    //      演出より優先する。明示指定（`style.quality`）があればそれが最優先。
    const prefersReducedMotion = useMemo(
        () =>
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        []
    );
    // ⭐ **4 軸をまとめて解決する**（Theme / Surface / Brush / Motion）。
    //    ⚠ 描画側が個別に resolveTheme / resolveQuality / resolveMotion を
    //      呼ばないこと（解決規則が散らばり、片方だけ直す事故が起きる）
    const design = useMemo(
        () => resolveDesign(definition, { prefersReducedMotion }),
        [definition, prefersReducedMotion]
    );
    const quality = design.quality;

    // ⭐ **編集の操作はすべて Dashboard Canvas 層が持つ**（Renderer は描くだけ）。
    //   ⚠ view モードでも必ず呼ぶ（条件付きでフックを呼ばない＝白紙バグの原因）。
    //     `mode !== 'edit'` のときは各ハンドラが即 return する。
    const canvas = useCanvasInteractions({
        mode,
        onPanelLayout,
        onMoveGroup,
        onSelect,
        onSelectGroup,
    });
    const { layoutPreview, observeGrid, gridWidth, canvasMenu } = canvas;

    const allPanels = useMemo(
        () => applyLayoutPreview(Array.isArray(definition.panels) ? definition.panels : [], layoutPreview),
        [definition.panels, layoutPreview]
    );
    const tabs = Array.isArray(definition.tabs) && definition.tabs.length > 0 ? definition.tabs : null;
    // タブの配置：'top'（既定）/ 'left'（サイドバー。Studio には無い）
    const tabPos = definition.tabPosition === 'left' ? 'left' : 'top';
    const [now] = useState(() => new Date());
    const showHeader = definition.hideHeader !== true;

    // タブ未指定のパネルは最初のタブに属する
    const currentTab = tabs ? activeTab ?? tabs[0].id : null;
    // 指定タブのパネルを取り出す（引数の tabs/allPanels を束ねただけの薄い包み）。
    // ⚠ **`panelsOfTab` と紛らわしい名前にしない。** 元は同名だったせいで、
    //   3 引数の import 版を 1 引数で呼んでも**エラーにならず空配列**が返り、
    //   「パネルが 1 枚も出ない」形で実機まで通り抜けた（2026-08-15 の実害）。
    const panelsIn = useCallback((tabId) => panelsOfTab(allPanels, tabs, tabId), [allPanels, tabs]);
    const panels = panelsIn(currentTab);

    // ⚡ **一度開いたタブは DOM に残す**（2026-08-15）。
    //
    //   従来はタブ外のパネルを配列から落としていた（＝React が丸ごとアンマウント）ため、
    //   **タブを戻すたびに全パネルを作り直していた**：サーチの再実行・手描き枠の再描画・
    //   出現アニメの再生が毎回走り、切替が重かった（実機計測: 安定まで 963ms）。
    //
    //   ⭐ **判定は `tabLifecycle.js`（純粋関数）が持つ。** ここに `useState` で
    //     生存リストを書くと、保存されない状態が描画コンポーネントに散り、
    //     State 層を独立させた設計に逆行する。方針（初回は開いたタブだけ・
    //     LRU で上限・消えたタブは捨てる）は同ファイルとテストで固定してある。
    //   ⚠ 隠すのは `display:none`。`visibility:hidden` や 0 透明度だと
    //     **場所を取ったまま**になり、レイアウトが壊れる。
    const [aliveTabs, setAliveTabs] = useState(() => touchTab([], currentTab));
    // ⚠ **タブ ID の配列は毎レンダー新しい参照になる**ので、そのまま effect の
    //   依存に置くと毎回発火する。**メモ化した配列**にして中身で比較できる形にする。
    //   ⚠ 区切り文字で1本の文字列に詰めない（ID に何が入るか保証が無いうえ、
    //     生の制御文字を区切りに使ってファイルがバイナリ扱いになった前科がある）
    const tabIds = useMemo(() => (tabs ? tabs.map((tb) => tb.id) : []), [tabs]);
    useEffect(() => {
        setAliveTabs((prev) => {
            // 定義から消えたタブを先に落としてから、今のタブを触る
            const pruned = tabIds.length > 0 ? pruneTabs(prev, tabIds) : prev;
            const next = touchTab(pruned, currentTab);
            // ⚠ 中身が同じなら**同じ参照を返す**（無限再レンダーを防ぐ）
            return next.length === prev.length && next.every((x, i) => x === prev[i]) ? prev : next;
        });
    }, [currentTab, tabIds]);
    const renderTabs = tabs ? tabsToRender(tabs, aliveTabs, currentTab) : null;

    // ⚡ **タブ 1 枚ぶんのレイアウトを求める**（2026-08-15）。
    //   隠して残すタブも同じ計算が要るので、**純粋関数として `tabLayout.js` へ
    //   切り出した**（React 不要＝素の Node でテストできる）。
    const layoutOfTab = useCallback(
        (tabId, tabPanels) =>
            resolveTabLayout({
                definition,
                allPanels,
                tabPanels,
                tabs,
                tabId,
                rowHeight: grid.rowHeight,
            }),
        [definition, tabs, allPanels, grid.rowHeight]
    );

    // 表示中のタブぶん（編集の当たり判定・canvas.sync・layoutCtx が使う）。
    // ⚠ 描画側は `layoutOfTab()` の戻りを各タブで使う（ここは**表示中のタブ専用**）
    const active = layoutOfTab(currentTab, panels);
    const visibleGroups = active.groups;
    const { headerRows, rowOf } = active;

    // ⭐ **レイアウト文脈**。Layout Engine に渡す唯一の入力。
    //    ⚠ `rowOf` を含めるのが要点で、これにより区画の見出し行のズレを
    //      エンジン側が意識せずに済む（grid も freeform も同じ契約で書ける）。
    //    ⚠ 幅は実測値。ドラッグのセル換算に要るので、無いうちは 0 のままでよい
    //      （`applyDrag` が 0 を検出して null を返す＝掴んでも動かないだけ）。
    const layoutCtx = useMemo(
        () =>
            makeLayoutContext({
                layout: definition.layout,
                containerWidth: gridWidth,
                rowOf,
                headerRows: headerRows.size,
            }),
        [definition.layout, gridWidth, rowOf, headerRows]
    );

    // ⭐ **Canvas 層に現在の場面を渡す**（ドラッグのハンドラが発火時に読む）。
    //   ⚠ これを呼ばないと「掴めるが動かない」になる。`layoutCtx` は
    //     `gridWidth` から決まり、その `gridWidth` は Canvas 層が持つので、
    //     引数で渡すと値が一周してしまう。だから描画のたびに入れ直す。
    canvas.sync({ allPanels, visibleGroups, engine, layoutCtx });

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
            // ── 登場アニメ（v1.9.0 追加）──────────────────────
            // パネルは index×70ms でずれて出るので、方向のあるものは
            // 「盤面を波が走る」ように見える（既存の stagger をそのまま使う）
            //
            // 落ちて弾む。overshoot は translateY だけで作る（scale だと文字が滲む）
            '@keyframes dpxDropIn { 0% { opacity: 0; transform: translateY(-22px); } ' +
            '60% { opacity: 1; transform: translateY(4px); } 100% { opacity: 1; transform: none; } }' +
            // 右から差し込む（slide の逆向き。左右で意味を分けたいときに使う）
            '@keyframes dpxSlideInRight { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }' +
            // 少し縮んでから戻る＝「置かれた」感じ。ズームの逆方向
            '@keyframes dpxPopIn { 0% { opacity: 0; transform: scale(1.06); } 100% { opacity: 1; transform: none; } }' +
            // 横に開く（unfold の横版）。表・一覧が並ぶ盤面で気持ちよく出る
            '@keyframes dpxUnfoldX { from { opacity: 0; transform: scaleX(0.86); } to { opacity: 1; transform: none; } }' +
            // わずかに傾いて起き上がる（紙を置く動き）。手描き系テーマと相性が良い
            '@keyframes dpxTiltIn { from { opacity: 0; transform: rotate(-1.5deg) translateY(10px); } to { opacity: 1; transform: none; } }' +
            // 奥から迫る（Y 軸の回転）。flip の縦版で、左右に並ぶ盤面で効く
            '@keyframes dpxSwingIn { from { opacity: 0; transform: perspective(800px) rotateY(-14deg) translateX(-10px); } to { opacity: 1; transform: none; } }' +
            // ── 常時アニメ（パネル単位で任意に付ける）──────────
            '@keyframes dpxFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }' +
            '@keyframes dpxBreathe { 0%,100% { opacity: 1; } 50% { opacity: 0.82; } }' +
            // 走査線が上から下へ流れる（管制画面の意匠）。1本の細い線を動かすだけ
            '@keyframes dpxScanSweep { from { transform: translateY(-100%); } to { transform: translateY(2000%); } }' +
            // 枠を光が一周する。background-position だけを動かす
            '@keyframes dpxBorderFlow { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }';
        document.head.appendChild(style);
    }, []);

    // ⚠ ドラッグのハンドラ（パネル / 区画）は **Dashboard Canvas 層**にある。
    //   → engine/canvas/useCanvasInteractions.js
    //   ここ（Renderer）は「定義を受け取って描く」だけに保つこと。

    return (
        <DpxThemeContext.Provider value={t}>
        {/* ⭐ 画材（Brush Engine）を配る。既定 'flat' では viz 側の
            `useBrush()` が null を返し、**従来の描画経路がそのまま通る**（原則 4） */}
        <DesignProvider design={design}>
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
                          canvas.openCanvasMenu(e.clientX, e.clientY);
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
            <LiquidGlassDefs />
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
                {/* ⚡ **タブごとに1つのグリッドを持つ**（2026-08-15）。
                    一度開いたタブは `display:none` で残し、戻ったときに作り直さない。
                    ⚠ タブを1つの器に混ぜてはいけない：行テンプレート（区画の見出し行）も
                      `paddingTop` もタブごとに違うので、混ぜるとレイアウトが壊れる。
                    ⚠ `observeGrid`（幅の実測＝ドラッグのセル換算）は**表示中のタブだけ**に付ける。
                      隠れた器は幅 0 なので、付けるとセル換算が 0 になって掴んでも動かなくなる。 */}
                {(renderTabs ?? [null]).map((tb) => {
                    const tabId = tb ? tb.id : null;
                    const isActive = tabId === currentTab;
                    const tabPanels = tb ? panelsIn(tabId) : panels;
                    const lay = isActive ? active : layoutOfTab(tabId, tabPanels);
                    return (
                        <div
                            key={tabId ?? '__single__'}
                            ref={isActive ? observeGrid : undefined}
                            // 隠れたタブは操作対象にしない（見えないものを掴めてしまう事故を防ぐ）
                            aria-hidden={isActive ? undefined : true}
                            inert={isActive ? undefined : ''}
                            style={{
                                flex: 1,
                                minWidth: 0,
                                // ⭐ **コンテナの CSS は Layout Engine が決める**
                                //    （grid では display:grid ＋ 列/行テンプレート、
                                //      freeform では position:relative になる）。
                                //    ⚠ ここに display:grid 等を直書きすると **freeform を上書きしてしまう**
                                //      ので書かないこと。
                                //    ⚠ **見出し行を挿し込むため `gridTemplateRows` を明示する**
                                //      （`gridAutoRows` は全行が同じ高さになり「見出し行だけ低く」ができない）。
                                //      rowTemplate は engine 側へ渡している
                                ...engine.containerStyle(layoutCtx, lay.rowTemplate),
                                // ⚠ 最上段の区画はヘッダ帯のぶん上へ伸びるので、その居場所を空ける。
                                //   空けないとダッシュボードのタイトルに重なる（実機で発生）。
                                // ⚠ **帯のぶんだけでは足りない。** ぴったりだと罫が見出しの
                                //   すぐ下（12px）に来て窮屈に見えた（実機で計測）。
                                //   帯＋余白で「見出しとは別の段」に見せる
                                //   区画が最上段に無い時は従来どおり（既存ボードの間延びを防ぐ）
                                paddingTop: lay.labeled ? GROUP_HEADER_H + 10 : 0,
                                gap: grid.gap,
                                // ⚠ `display` は engine の containerStyle が決めた値を
                                //   **隠すときだけ**上書きする（表示中は触らない）
                                ...(isActive ? null : { display: 'none' }),
                            }}
                        >
                            {/* グループ枠。パネルより先に描き、zIndex:0 で背面に置く。
                                ⚠ そのタブに属するものだけ（切り替えても枠が残らないように） */}
                            {lay.groups.map((g) => (
                                <GroupFrame
                                    key={g.id}
                                    group={g}
                                    panels={tabPanels}
                                    grid={grid}
                                    t={t}
                                    mode={mode}
                                    selected={isActive && selectedGroupId === g.id}
                                    onSelect={onSelectGroup}
                                    onDragStart={canvas.onGroupDragStart}
                                    rowOf={lay.rowOf}
                                    engine={engine}
                                    layoutCtx={layoutCtx}
                                    quality={quality}
                                    design={design}
                                    headerRows={lay.headerRows}
                                />
                            ))}
                            {tabPanels.map((p, i) => (
                                <Panel
                                    key={p.id}
                                    panel={p}
                                    grid={grid}
                                    theme={t}
                                    mode={mode}
                                    selected={isActive && selectedId === p.id}
                                    onSelect={(id, e) => {
                                        e?.stopPropagation?.();
                                        onSelect?.(id);
                                    }}
                                    onDragStart={canvas.onDragStart}
                                    // ⚠ **出現アニメは初めて開くときだけ**。隠して残す方式では
                                    //   2 回目以降のタブ戻りで再生されない（DOM が残っているため
                                    //   CSS animation が再実行されない）＝意図どおり
                                    entrance={definition.style?.entrance ?? 'rise'}
                                    index={i}
                                    onDuplicatePanel={onDuplicatePanel}
                                    onRemovePanel={onRemovePanel}
                                    onPatchPanel={onPatchPanel}
                                    onOpenDataSources={onOpenDataSources}
                                    onDetachSettings={onDetachSettings}
                                    definition={definition}
                                    app={app}
                                    rowOf={lay.rowOf}
                                    engine={engine}
                                    layoutCtx={layoutCtx}
                                    quality={quality}
                                    design={design}
                                />
                            ))}
                        </div>
                    );
                })}
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
                    onClose={canvas.closeCanvasMenu}
                />
            ) : null}
        </div>
        </DesignProvider>
        </DpxThemeContext.Provider>
    );
}
