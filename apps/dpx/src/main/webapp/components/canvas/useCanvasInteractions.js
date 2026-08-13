// ── Dashboard Canvas（編集の器）─────────────────────────────────
//
// **編集モードでしか起きないこと**をここに集める:
//   ドラッグ（移動 / リサイズ / 区画ごと移動）・配置プレビュー・
//   余白の右クリックメニュー・余白クリックでの選択解除。
//
// ## なぜ Renderer から分けるのか
//
// 以前は `DpxDashboard.jsx`（1600 行超）に描画と編集が同居していた。
// 分けたことで **Renderer は「定義 → 画面」だけの純粋な層**になり、
// 表示専用の用途（壁掛け・埋め込み・印刷）で編集コードを読み込まずに済む。
//
// ```
// DashboardCanvas（編集の器）
//    └─ useCanvasInteractions … ドラッグと一時状態（このファイル）
//         └─ DpxDashboard（Renderer） … 定義を受け取って描くだけ
// ```
//
// ## ⭐ このファイルが守っている 2 つの性質（過去に壊した）
//
// 1. **ドラッグ中は定義を書き換えない。** 見た目だけ動かし（`layoutPreview`）、
//    **離した時に 1 回だけ**定義へ書く。
//    → 「JSON の変化 = 1 操作」が保たれ、履歴のまとめキーが要らなくなる。
//
// 2. **移動量は毎回「掴んだ時点の座標」から計算する**（累積で足さない）。
//    前フレームからの差分を足し込む形にすると、**クランプで止まった後に
//    戻すときズレる**（実機で発生）。
//
// ⚠ 座標計算そのものは持たない。**すべて Layout Engine に委譲する**
//   （grid / freeform で実装が変わるため。純粋関数なのでテストがある）。
// ────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react';

/**
 * 編集モードの操作を組み立てる。
 *
 * ⚠ **view モードでも同じように呼んでよい**（フックの規則を守るため）。
 *   `mode !== 'edit'` のときは各ハンドラが即 return するので、
 *   呼び出し側で条件分岐して**フックを呼んだり呼ばなかったりしない**こと
 *   （DPX で最頻の白紙バグがフック規則違反）。
 *
 * @returns {{
 *   layoutPreview: object|null,   Renderer に渡す「見た目だけの配置」
 *   gridRef: object,              グリッド本体の ref
 *   observeGrid: Function,        幅を実測する callback ref
 *   gridWidth: number,            実測幅（0 のうちはドラッグしても動かない）
 *   canvasMenu: object|null,      余白の右クリックメニューの座標
 *   openCanvasMenu: Function,
 *   closeCanvasMenu: Function,
 *   onDragStart: Function,        パネルの移動 / リサイズ
 *   onGroupDragStart: Function,   区画ごと移動
 *   sync: Function,               描画のたびに現在の場面を入れ直す（必須）
 * }}
 */
export function useCanvasInteractions({
    mode,
    onPanelLayout,
    onMoveGroup,
    onSelect,
    onSelectGroup,
}) {
    // ⭐ ドラッグ中の配置は定義に書かず、ここで見た目だけ差し替える。
    const [layoutPreview, setLayoutPreview] = useState(null);
    const [canvasMenu, setCanvasMenu] = useState(null);
    const gridRef = useRef(null);
    const dragRef = useRef(null);

    // ⭐ **循環依存を切るための箱**。
    //   ドラッグに要る値（パネル・区画・エンジン・レイアウト文脈）は、
    //   **`gridWidth` から計算される**（幅 → layoutCtx → …）。その `gridWidth` は
    //   このフックが持つので、引数で受け取ると値が一周して決まらなくなる。
    //   → 描画のたびに Renderer が `sync()` で入れ直し、ハンドラは**発火時に読む**。
    //
    //   ⚠ この箱の中身を **useCallback の依存に入れない**（ref は変化しないので
    //     入れても意味が無く、入れたつもりで「古い値を掴む」錯覚を生む）。
    //     ハンドラは必ず `sceneRef.current` から読むこと。
    const sceneRef = useRef({ allPanels: [], visibleGroups: [], engine: null, layoutCtx: null });
    const sync = useCallback((scene) => {
        sceneRef.current = scene;
    }, []);

    // グリッド本体の実測幅（ドラッグのセル換算に要る）。
    // ⚠ **callback ref で観測を始める**。mount 時 effect だと、データ到着前に
    //   early return する経路で ref がまだ null で**観測が永久に始まらない**
    //   （実機で踏んだ「既定幅 600px のまま固まる」と同じ罠）。
    const [gridWidth, setGridWidth] = useState(0);
    const observeGrid = useCallback((el) => {
        gridRef.current = el;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([entry]) => {
            const w = entry?.contentRect?.width ?? 0;
            setGridWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
        });
        ro.observe(el);
    }, []);

    /**
     * ⭐ **区画ごとドラッグして動かす**（メンバー全員が付いてくる）。
     *
     * これが無いと区画は「枠がパネルを追いかけるだけの飾り」になる。
     * ヘッダ帯（罫と区画名の帯）を掴んで動かす＝パネルのタイトルバーと同じ操作感。
     */
    const onGroupDragStart = useCallback(
        (groupId, e) => {
            if (mode !== 'edit' || !onMoveGroup) return;
            if (!gridRef.current) return;
            const { allPanels, visibleGroups, engine, layoutCtx } = sceneRef.current;
            if (!engine || !layoutCtx) return;
            e.preventDefault();
            e.stopPropagation();
            onSelectGroup?.(groupId);

            const group = visibleGroups.find((g) => g.id === groupId);
            const memberIds = (group?.panels ?? []).map(String);
            if (memberIds.length === 0) return;
            // 掴んだ時点のメンバー座標を控える（プレビューとクランプの基準）
            const base = allPanels
                .filter((p) => memberIds.includes(String(p.id)))
                .map((p) => ({ ...p }));

            const start = { x: e.clientX, y: e.clientY };
            let last = { dx: 0, dy: 0 };

            const onMove = (ev) => {
                // ⭐ ピクセル → レイアウト単位の換算もエンジンに任せる
                const raw = engine.toCells(
                    { dx: ev.clientX - start.x, dy: ev.clientY - start.y },
                    layoutCtx
                );
                // ⚠ クランプは**区画全体**で判定する（メンバーごとに丸めると形が崩れる。
                //   movePanelsBy と同じ規則をプレビューでも守る）
                const { dx, dy } = engine.clampGroupDelta(base, raw, layoutCtx);
                if (dx === last.dx && dy === last.dy) return;
                last = { dx, dy };
                // ⭐ 定義は書き換えず、見た目だけ動かす
                setLayoutPreview({
                    ids: memberIds,
                    byId: Object.fromEntries(
                        base.map((p) => [
                            String(p.id),
                            { x: (Number(p.x) || 0) + dx, y: (Number(p.y) || 0) + dy },
                        ])
                    ),
                });
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                setLayoutPreview(null);
                // ⭐ **離した時に1回だけ定義へ書く**＝履歴も1手・JSON の変化も1回
                if (last.dx !== 0 || last.dy !== 0) onMoveGroup(groupId, last.dx, last.dy);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        },
        [mode, onMoveGroup, onSelectGroup]
    );

    /** パネルの移動 / リサイズ。`kind` は 'move' | それ以外（リサイズ）。 */
    const onDragStart = useCallback(
        (id, kind, e) => {
            if (mode !== 'edit' || !onPanelLayout) return;
            const { allPanels, engine, layoutCtx } = sceneRef.current;
            const panel = allPanels.find((p) => p.id === id);
            if (!gridRef.current || !panel || !engine || !layoutCtx) return;
            e.preventDefault();
            e.stopPropagation();
            onSelect?.(id, e);

            const start = { x: e.clientX, y: e.clientY, panel: { ...panel } };
            dragRef.current = { id, kind, start };

            // ⭐ ドラッグ中は**定義を書き換えない**。最後に確定した値だけを持っておく
            let pending = null;

            const onMove = (ev) => {
                const d = dragRef.current;
                if (!d) return;
                // ⭐ 座標計算は Layout Engine に委譲する（grid / freeform で実装が変わる）。
                //    ⚠ **掴んだ時点の座標（p0）からの絶対量**で計算する。前フレームからの
                //      差分を足し込むと、クランプで止まった後に戻すときズレる
                const p0 = d.start.panel;
                const delta = { dx: ev.clientX - d.start.x, dy: ev.clientY - d.start.y };
                const next =
                    d.kind === 'move'
                        ? engine.applyDrag(p0, delta, layoutCtx)
                        : engine.applyResize(p0, delta, layoutCtx);
                // エンジンが null を返す＝動いていない＝保存対象にしない
                pending = next;
                setLayoutPreview(next ? { id: d.id, patch: next } : null);
            };
            const onUp = () => {
                const d = dragRef.current;
                dragRef.current = null;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                setLayoutPreview(null);
                // ⭐ **離した時に1回だけ定義へ書く**。
                //   これで「JSON の変化＝1操作」になり、履歴のまとめキーが要らない
                if (d && pending) onPanelLayout(d.id, pending);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        },
        [mode, onPanelLayout, onSelect]
    );

    const openCanvasMenu = useCallback((x, y) => setCanvasMenu({ x, y }), []);
    const closeCanvasMenu = useCallback(() => setCanvasMenu(null), []);

    return {
        layoutPreview,
        gridRef,
        observeGrid,
        gridWidth,
        canvasMenu,
        openCanvasMenu,
        closeCanvasMenu,
        onDragStart,
        onGroupDragStart,
        // ⚠ 描画のたびに呼ぶこと（呼ばないとドラッグが「掴めるが動かない」になる）
        sync,
    };
}

export default useCanvasInteractions;
