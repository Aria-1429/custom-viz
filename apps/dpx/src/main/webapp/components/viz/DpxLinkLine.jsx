import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

// ⭐ viz は **Viz SDK だけ**を見る（engine の内部を直接 import しない）
import {
    colorForValue,
    defaultColorRules,
    dosToField,
    labelForValue,
    resolveColorRules,
    useDpxTheme,
    useVizKitStyles,
} from './';

// ── コネクタ線（パネル同士を結ぶ線）──────────────────────────────
// Studio 拡張の link-line 相当を DPX ネイティブ viz として実装したもの。
//
// link-line との違い（DPX ならではの点）:
//   - iframe が無いので**パネルを跨いだ座標**をそのまま扱える
//   - 図形（shape.*）と同じく背面に敷ける（質感＝枠なし＋ style.z を小さく）
//   - 色分けは DPX の `editor.colorRules` を流用＝**範囲／一致／グラデーションの3モード**が
//     最初から使える（link-line は範囲と一致の2モード）
//
// データ規約（link-line と同じ「シングルバリュー」）:
//   値列（未指定なら「数値を含む最後の列」）の**最終行**を採って線の色を決める。
//   ⚠ データが無くても線は消さない。ニュートラル色＋「N/A」で描き続ける
//     （コネクタは「そこに繋がりがある」ことの表示なので、消えると構図が壊れる）。
// ────────────────────────────────────────────────────────────────

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 未設定時の既定の色ルール。
 *
 * ⚠ `defaultColorRules('range')` をそのまま使ってはいけない。
 *   共通の既定パレット（trafficDark）は **低い値ほど赤**（スコア・達成率向け）で、
 *   コネクタ線が測る指標（遅延・ロス率・エラー率）とは**good/bad が逆**になる。
 *   実機で 12ms が赤・95ms が緑になって発覚した。
 *   → ここでは**低い値ほど緑**に並べ替えた配色を既定にする。
 *   ユーザーが「色のルール」を設定した場合はそちらが優先される（この既定は使われない）。
 */
const DEFAULT_LINK_RULES = {
    mode: 'range',
    thresholds: [20, 40, 60, 80],
    colors: ['#3fa34d', '#8fbf45', '#d9a441', '#d35400', '#c0392b'],
    defaultColor: '',
};

/** 数値化（link-line と同じ寛容さ: カンマ・空白・単位を落とす）。 */
function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[,\s]/g, '').replace(/[^\d.eE+-].*$/, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * 線の形（正規化座標 0..1 の点列）を解決する。
 *
 * ⚠ `points` は **optionsSchema に載せない**（載せると編集パネルに JSON 欄が出る）。
 *   スキーマに無いキーもダッシュボード定義に保存され viz に届くことは実機確認済み
 *   （link-line v1.11.0 の labelPos と同じ手）。
 */
function resolvePoints(raw, orientation) {
    let pts = raw;
    if (typeof pts === 'string' && pts.trim()) {
        try {
            pts = JSON.parse(pts);
        } catch {
            pts = null;
        }
    }
    const ok =
        Array.isArray(pts) &&
        pts.length >= 2 &&
        pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n))));
    if (ok) return pts.map(([x, y]) => [Number(x), Number(y)]);
    // 既定は端から端まで。縦横は orientation で決める
    return orientation === 'vertical'
        ? [
              [0.5, 0.04],
              [0.5, 0.96],
          ]
        : [
              [0.02, 0.5],
              [0.98, 0.5],
          ];
}

/** 折れ線の全長（px）。破線アニメの周期を長さに比例させるのに使う。 */
function pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) {
        len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return len;
}

/** 折れ線の中央（長さの半分の位置）を返す。値ラベルの既定位置。 */
function midPoint(pts) {
    const total = pathLength(pts);
    if (total === 0) return pts[0];
    let acc = 0;
    for (let i = 1; i < pts.length; i += 1) {
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + seg >= total / 2) {
            const r = (total / 2 - acc) / (seg || 1);
            return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * r, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * r];
        }
        acc += seg;
    }
    return pts[pts.length - 1];
}

export function DpxLinkLine({ dataSources, options = {}, width, height, loading, mode, onEventTrigger, onOptionsChange }) {
    const t = useDpxTheme();
    useVizKitStyles(); // 流れアニメの @keyframes を注入する
    const boxRef = useRef(null);
    // ⚠ フックは early return より前に全部呼ぶ（§8.1）。
    //   この viz はデータ無しでも描くので early return しないが、規約として先頭に置く。
    const [box, setBox] = useState({ w: 0, h: 0 });
    const [dragging, setDragging] = useState(null); // {kind:'point'|'label', index}
    // ⚠ 矢印マーカーの id はパネルごとに一意にする。
    //   同じ id を複数パネルが持つと、SVG の参照が**最初の1つに解決されて**
    //   別パネルの矢印まで同じ色になる（id は文書全体で共有されるため）
    const uid = useId().replace(/:/g, '');

    // ⚠ ResizeObserver は callback ref で始める（mount 時 effect だと ref が
    //   まだ null で観測が永久に始まらないことがある。§8.3）
    const attach = React.useCallback((el) => {
        boxRef.current = el;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setBox({ w: r.width, h: r.height });
        });
        ro.observe(el);
        const r = el.getBoundingClientRect();
        setBox({ w: r.width, h: r.height });
    }, []);

    // ── データ → 値 ─────────────────────────────────────────
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => (typeof f === 'string' ? f : f?.name));
    const valueField = dosToField(options.valueColumn);
    const valueIdx = useMemo(() => {
        if (valueField) {
            const i = fields.indexOf(valueField);
            if (i >= 0) return i;
        }
        // 既定は「数値を含む最後の列」（link-line と同じ規約）
        for (let i = cols.length - 1; i >= 0; i -= 1) {
            if ((cols[i] ?? []).some((v) => toNum(v) !== null)) return i;
        }
        return -1;
    }, [fields, valueField, cols]);

    const rawValue = useMemo(() => {
        if (valueIdx < 0) return null;
        const col = cols[valueIdx] ?? [];
        // 最終行（timechart なら最新値）
        for (let i = col.length - 1; i >= 0; i -= 1) {
            const v = col[i];
            if (v !== null && v !== undefined && v !== '') return v;
        }
        return null;
    }, [cols, valueIdx]);

    const numericValue = toNum(rawValue);
    // グラデーションモード用に列の実データ範囲を渡す（渡さないと既定色に落ちる）
    const range = useMemo(() => {
        if (valueIdx < 0) return undefined;
        const ns = (cols[valueIdx] ?? []).map(toNum).filter((n) => n !== null);
        return ns.length ? { min: Math.min(...ns), max: Math.max(...ns) } : undefined;
    }, [cols, valueIdx]);

    // ⚠ **optionsSchema の default は viz に届かない**（Inspector が表示に使うだけで、
    //   options にはマージされない。実機で確認）。したがって「未設定なら既定の
    //   しきい値で色分けする」は**ここで自分で担保する**必要がある。
    //   これを null フォールバックにすると、置いた直後の線が
    //   一律アクセント色になり「値で色が変わらない」と見える（実機で踏んだ）。
    const colorCfg = useMemo(() => resolveColorRules(options.colors, DEFAULT_LINK_RULES), [options.colors]);
    const neutral = options.neutralColor || t.subColor || 'rgba(150,160,180,0.55)';
    // 一致モードは生の文字列で判定する（link-line v1.10.0 と同じ）
    const matchTarget = colorCfg?.mode === 'match' ? rawValue : numericValue;
    const resolved = rawValue === null ? null : colorForValue(colorCfg, matchTarget, range);
    const stroke = resolved || options.stroke || (rawValue === null ? neutral : t.accent);

    // ── 形 ────────────────────────────────────────────────
    const points = resolvePoints(options.points, options.orientation);
    const W = box.w || num(width, 300);
    const H = box.h || num(height, 120);
    const px = (p) => [p[0] * W, p[1] * H];
    const pxPts = points.map(px);
    const d = pxPts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

    const strokeWidth = num(options.strokeWidth, 2);
    const strokeOpacity = num(options.strokeOpacity, 0.9);
    const texture = options.texture || 'flat';
    const arrow = options.arrow ?? 'end';
    const flow = options.flow || 'none';
    const flowSpeed = num(options.flowSpeed, 3);

    // 値ラベル
    const decimals = Number.isFinite(Number(options.decimals)) ? Number(options.decimals) : 1;
    const unit = String(options.unit ?? '');
    const connName = String(options.connectionName ?? '');
    const showLabel = options.showLabel !== false;
    const labelPos = Array.isArray(options.labelPos) && options.labelPos.length === 2 ? options.labelPos : midPoint(points);
    const [lx, ly] = px(labelPos);

    const matchLabel = labelForValue(colorCfg, rawValue);
    const valueText =
        rawValue === null
            ? 'N/A'
            : colorCfg?.mode === 'match'
              ? matchLabel || String(rawValue)
              : numericValue === null
                ? String(rawValue)
                : `${numericValue.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
    const chipText = connName ? (showLabel ? `${connName}  ${valueText}` : connName) : showLabel ? valueText : '';

    // ── 線編集（★編集モードのみ）──────────────────────────────────
    //
    // ⭐ **これは Studio ではできなかったこと。**
    //   Studio 拡張（link-line）はパネルが iframe に隔離されており、
    //   編集モード中のポインタ入力を**ホストがパネル選択に使ってしまう**ため、
    //   線の形は「表示モードで整える」しかなかった（link-line の README にある制約。
    //   表示モードに「✎ 線を編集」トグルを置くという回避策もそこから来ている）。
    //
    //   DPX はキャンバスも viz も同じ DOM ツリーにあるので、
    //   **編集モードでそのまま掴んで動かせる**（実機で永続化まで確認済み）。
    //   → 表示画面での編集は**不要になったので持たない**。
    //     ダッシュボードは「編集モードで作り、表示モードでは触らない」が自然で、
    //     表示側にトグルを置くと壁掛け・キオスクで誤操作の入口になる。
    //
    // 編集モードでは最初からハンドルを出す（形を整えるのが編集モードの仕事なので、
    // わざわざトグルを押させない）。
    const editing = mode === 'edit';
    const commit = (next) => onOptionsChange?.(next);

    useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (e) => {
            const el = boxRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
            const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)));
            if (dragging.kind === 'label') {
                commit({ labelPos: [nx, ny] });
            } else {
                const next = points.slice();
                next[dragging.index] = [nx, ny];
                commit({ points: next });
            }
        };
        const onUp = () => setDragging(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [dragging, points]); // eslint-disable-line react-hooks/exhaustive-deps

    const addPoint = (segIdx) => {
        const a = points[segIdx];
        const b = points[segIdx + 1];
        const next = points.slice();
        next.splice(segIdx + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        commit({ points: next });
    };
    const removePoint = (i) => {
        if (i === 0 || i === points.length - 1 || points.length <= 2) return; // 両端は消さない
        const next = points.slice();
        next.splice(i, 1);
        commit({ points: next });
    };

    const arrowId = `dpx-ll-arrow-${uid}`;

    const clickable = !!onEventTrigger && !editing;
    const fireClick = () => {
        if (!clickable) return;
        onEventTrigger({
            type: 'line.click',
            payload: { value: rawValue, name: connName || 'link', row: {} },
        });
    };

    return (
        <div ref={attach} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 40 }}>
            <svg width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
                <defs>
                    <marker
                        id={arrowId}
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth={Math.max(4, 6 - strokeWidth * 0.2)}
                        markerHeight={Math.max(4, 6 - strokeWidth * 0.2)}
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 1 L 9 5 L 0 9 z" fill={stroke} />
                    </marker>
                </defs>

                {/* 質感。⚠ SVG フィルタ（feGaussianBlur）は使わない（面積比例の再描画で重い。§7.1）。
                    発光は「太くて薄い線を下に重ねる」で出す */}
                {texture === 'neon' ? (
                    <>
                        <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth * 4} strokeOpacity={0.12} strokeLinecap="round" strokeLinejoin="round" />
                        <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth * 2} strokeOpacity={0.22} strokeLinecap="round" strokeLinejoin="round" />
                    </>
                ) : null}
                {texture === 'shadow' ? (
                    <path d={d} fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth={strokeWidth + 2} strokeOpacity={0.5} strokeLinecap="round" strokeLinejoin="round" transform="translate(0,1.5)" />
                ) : null}
                {texture === 'pipe' ? (
                    <path d={d} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={Math.max(1, strokeWidth * 0.35)} strokeLinecap="round" strokeLinejoin="round" transform={`translate(0,${-strokeWidth * 0.28})`} />
                ) : null}

                {/* 本体 */}
                <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeOpacity={strokeOpacity}
                    strokeDasharray={options.dashed ? `${strokeWidth * 3} ${strokeWidth * 2.5}` : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    markerEnd={arrow === 'end' || arrow === 'both' ? `url(#${arrowId})` : undefined}
                    markerStart={arrow === 'start' || arrow === 'both' ? `url(#${arrowId})` : undefined}
                    onClick={fireClick}
                    style={{ cursor: clickable ? 'pointer' : 'default', pointerEvents: clickable ? 'stroke' : 'none' }}
                />

                {/* 流れアニメ。⚠ animate するのは stroke-dashoffset だけ（合成に載る。§7.1） */}
                {flow !== 'none' && flowSpeed > 0 ? (
                    <path
                        d={d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={strokeWidth * 1.1}
                        strokeLinecap="round"
                        strokeDasharray={`${strokeWidth * 2.5} ${strokeWidth * 9}`}
                        style={{
                            animation: `dpxLinkFlow ${flowSpeed}s linear infinite${flow === 'reverse' ? ' reverse' : ''}`,
                            opacity: 0.85,
                            pointerEvents: 'none',
                        }}
                    />
                ) : null}

                {/* 両端のコネクタ（丸端子） */}
                {options.endCaps !== false ? (
                    <>
                        <circle cx={pxPts[0][0]} cy={pxPts[0][1]} r={strokeWidth * 1.6} fill={stroke} fillOpacity={0.9} />
                        <circle cx={pxPts[pxPts.length - 1][0]} cy={pxPts[pxPts.length - 1][1]} r={strokeWidth * 1.6} fill={stroke} fillOpacity={0.9} />
                    </>
                ) : null}

                {/* 編集ハンドル（表示モードで「✎ 線を編集」を押した間だけ） */}
                {editing
                    ? pxPts.map(([x, y], i) => (
                          <g key={`pt-${i}`}>
                              {i < pxPts.length - 1 ? (
                                  <circle
                                      cx={(x + pxPts[i + 1][0]) / 2}
                                      cy={(y + pxPts[i + 1][1]) / 2}
                                      r={6}
                                      fill={t.canvasBg}
                                      stroke={t.accent}
                                      strokeWidth={1.2}
                                      style={{ cursor: 'copy' }}
                                      onPointerDown={(e) => {
                                          e.stopPropagation();
                                          addPoint(i);
                                      }}
                                  />
                              ) : null}
                              <circle
                                  cx={x}
                                  cy={y}
                                  r={7}
                                  fill={t.accent}
                                  fillOpacity={0.9}
                                  stroke={t.canvasBg}
                                  strokeWidth={1.5}
                                  style={{ cursor: 'grab' }}
                                  onPointerDown={(e) => {
                                      e.stopPropagation();
                                      setDragging({ kind: 'point', index: i });
                                  }}
                                  onDoubleClick={(e) => {
                                      e.stopPropagation();
                                      removePoint(i);
                                  }}
                              />
                          </g>
                      ))
                    : null}
            </svg>

            {/* 値ラベル（チップ）。SVG の外に HTML で出す＝文字が滲まない */}
            {chipText ? (
                <div
                    onPointerDown={(e) => {
                        if (!editing) return;
                        e.stopPropagation();
                        setDragging({ kind: 'label', index: -1 });
                    }}
                    onDoubleClick={() => editing && commit({ labelPos: midPoint(points) })}
                    style={{
                        position: 'absolute',
                        left: lx,
                        top: ly,
                        transform: 'translate(-50%, -50%)',
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: 11,
                        lineHeight: 1.5,
                        whiteSpace: 'nowrap',
                        color: t.titleColor,
                        background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(8,14,26,0.82)',
                        border: `1px solid ${stroke}`,
                        cursor: editing ? 'grab' : 'default',
                        pointerEvents: editing ? 'auto' : 'none',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {chipText}
                </div>
            ) : null}

            {/* 表示モードには編集 UI を一切出さない（トグルも置かない）。
                線の形は編集モードで決めるものなので、表示画面は「見るだけ」に保つ。 */}
        </div>
    );
}

DpxLinkLine.config = {
    key: 'dpx.linkLine',
    name: 'コネクタ線',
    category: 'shape',
    // ⭐ 編集モードでも viz 自身がポインタを受け取る（★Studio では不可能だった）。
    //    DpxDashboard はこのフラグを見て**移動用オーバーレイを敷かない**。
    //    パネルの移動はタイトルバー（タイトル非表示なら上端の細い帯）で行う。
    canvasEdit: true,
    optionsSchema: {
        // ⚠ points / labelPos は**あえてスキーマに載せない**。
        //   キャンバス上のドラッグで決まる値なので、編集パネルに JSON 欄を出す意味が無い。
        //   スキーマ外のキーも定義に保存され viz に届く（実機確認済み）。
        valueColumn: { type: 'string', default: '' },
        colors: { type: 'object', default: defaultColorRules('range') },
        neutralColor: { type: 'string', default: '' },
        stroke: { type: 'string', default: '' },
        strokeWidth: { type: 'number', default: 2 },
        strokeOpacity: { type: 'number', default: 0.9 },
        orientation: { type: 'string', default: 'horizontal' },
        texture: { type: 'string', default: 'flat' },
        arrow: { type: 'string', default: 'end' },
        dashed: { type: 'boolean', default: false },
        flow: { type: 'string', default: 'none' },
        flowSpeed: { type: 'number', default: 3 },
        endCaps: { type: 'boolean', default: true },
        showLabel: { type: 'boolean', default: true },
        connectionName: { type: 'string', default: '' },
        unit: { type: 'string', default: '' },
        decimals: { type: 'number', default: 1 },
    },
    editorConfig: [
        {
            // 線の形は編集パネルではなく**キャンバス上のドラッグ**で決める。
            // それが分かる場所が無いと「折れ点の増やし方」に辿り着けないので、
            // 先頭のセクション名で操作方法を明示する
            label: 'データ（線の形はキャンバスをドラッグ）',
            layout: [
                [{ label: '値の列（未指定なら数値の最終列）', option: 'valueColumn', editor: 'editor.columnSelector' }],
                [{ label: '接続名（例: DB → App）', option: 'connectionName', editor: 'editor.text' }],
            ],
        },
        {
            label: '線の色',
            layout: [
                [{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }],
                [{ label: '該当なしの色', option: 'neutralColor', editor: 'editor.color' }],
            ],
        },
        {
            label: '線',
            layout: [
                [
                    {
                        label: '既定の向き',
                        option: 'orientation',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { label: '横', value: 'horizontal' },
                                { label: '縦', value: 'vertical' },
                            ],
                        },
                    },
                ],
                [
                    {
                        label: '質感',
                        option: 'texture',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { label: 'フラット', value: 'flat' },
                                { label: 'ソフトシャドウ', value: 'shadow' },
                                { label: 'ネオン発光', value: 'neon' },
                                { label: '立体パイプ', value: 'pipe' },
                            ],
                        },
                    },
                ],
                [
                    {
                        label: '矢印',
                        option: 'arrow',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { label: 'なし', value: 'none' },
                                { label: '終点', value: 'end' },
                                { label: '始点', value: 'start' },
                                { label: '両端', value: 'both' },
                            ],
                        },
                    },
                ],
                [{ label: '線の太さ', option: 'strokeWidth', editor: 'editor.slider', editorProps: { min: 0.5, max: 10, step: 0.5 } }],
                [{ label: '不透明度', option: 'strokeOpacity', editor: 'editor.slider', editorProps: { min: 0.1, max: 1, step: 0.05 } }],
                [{ label: '破線にする', option: 'dashed', editor: 'editor.checkbox' }],
                [{ label: '端に丸端子', option: 'endCaps', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '流れ',
            layout: [
                [
                    {
                        label: '流れの向き',
                        option: 'flow',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { label: 'なし', value: 'none' },
                                { label: '順方向', value: 'forward' },
                                { label: '逆方向', value: 'reverse' },
                            ],
                        },
                    },
                ],
                [{ label: '周期（秒）', option: 'flowSpeed', editor: 'editor.slider', editorProps: { min: 0, max: 10, step: 0.5 } }],
            ],
        },
        {
            label: 'ラベル',
            layout: [
                [{ label: '値を表示', option: 'showLabel', editor: 'editor.checkbox' }],
                [{ label: '単位（例: ms）', option: 'unit', editor: 'editor.text' }],
                [{ label: '小数桁', option: 'decimals', editor: 'editor.number' }],
            ],
        },
    ],
};

export default DpxLinkLine;
