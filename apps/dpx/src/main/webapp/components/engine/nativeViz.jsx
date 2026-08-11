import React from 'react';

import { colorForValue, defaultColorRules, labelForValue, pickTextColor, resolveColorRules } from './colorRules';
import { dosToField } from './optionEditors';
import { useDpxTheme } from './themes';
import { VizTooltip, useCountUp, usePointer, useVizKitStyles } from './vizKit';
import { formatAxisLabels, niceScale, niceTicks } from './scale';
import { useVizHover } from '../vizBus';

// ── DPX ネイティブ viz スイート ──────────────────────────────────
// プラットフォーム標準のチャート群。外部チャートライブラリに依存せず
// SVG/DOM で描く。全て解決済みテーマ（useDpxTheme）に連動し、
// editorConfig（日本語ラベル）でインスペクタのフォームが自動生成される。
//
// データ規約（dataSources.primary.data = {fields, columns}）:
//   dpx.line   … 1列目 = X（ラベル/時刻）、2列目以降 = 数値系列
//   dpx.bar    … 1列目 = ラベル、2列目 = 値
//   dpx.value  … 最初の数値列を使う（最終値＝現在値、直前値との差分を表示）
//   dpx.status … 1列目 = 名前、2列目 = 状態、3列目 = 補足（任意）
//   dpx.table  … 全列をそのまま表
// ────────────────────────────────────────────────────────────────

const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const fmt = (v, decimals = 1) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(decimals)}G`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(decimals)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(decimals)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(decimals);
};

function useContainerSize(defaultW = 600) {
    // ⚠ callback ref を使う。データ到着前に「データがありません」ブランチを
    // 返すコンポーネントでは、mount 時の effect では ref がまだ null で、
    // 観測が永久に始まらない（実機で発生：チャートが既定幅 600px のまま）。
    const [w, setW] = React.useState(defaultW);
    const roRef = React.useRef(null);
    const ref = React.useCallback((el) => {
        if (roRef.current) {
            roRef.current.disconnect();
            roRef.current = null;
        }
        if (!el) return;
        if (el.offsetWidth) setW(el.offsetWidth);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                const width = entries[0]?.contentRect?.width;
                if (width) setW(width);
            });
            ro.observe(el);
            roRef.current = ro;
        }
    }, []);
    return [ref, w];
}

/** 系列（またはラベル）の色を決める。
 *  cfg は colorRules の設定（一致モードなら名前で、範囲モードなら値で判定）。
 *  当たらなければテーマのパレットを順に使う。 */
function seriesColor(cfg, t, index, name) {
    const hit = cfg ? colorForValue(cfg, name) : null;
    return hit || t.palette[index % t.palette.length];
}

function EmptyHint({ loading, message }) {
    return (
        <div style={{ padding: 14, fontSize: 12, opacity: 0.55 }}>
            {loading ? '読み込み中…' : message}
        </div>
    );
}

// ── dpx.line ─────────────────────────────────────────────────────
// インタラクション:
//   - マウス追従のクロスヘア＋最近傍点のマーカー、値ツールチップ
//   - 凡例または線のホバーで **その系列にフォーカス**（他系列を減光・細く）
//   - 系列クリックで固定（ピン）。もう一度で解除
//   - 初回描画は stroke-dashoffset で「引かれていく」アニメ（ジオメトリを動かさない）

export function DpxLine({ dataSources, options = {}, height, loading }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const [ref, width] = useContainerSize();
    const [pt, pointerHandlers] = usePointer();
    const [hoverSeries, setHoverSeries] = React.useState(null);
    const [pinned, setPinned] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[1] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=X、2列目以降=数値系列）" />;
    }

    const h = Math.max(typeof height === 'number' ? height : 240, 80);
    const xLabels = cols[0].map((v) => String(v));
    const series = cols
        .slice(1)
        .map((col, i) => ({ name: fields[i + 1] ?? `series${i + 1}`, values: col.map(toNum) }))
        .filter((s) => s.values.some((v) => v !== null));

    const lineColorCfg = resolveColorRules(options.colors ?? options.seriesColors, null);
    const showArea = options.showArea !== false;
    const showDots = Boolean(options.showDots);
    const showGrid = options.showGrid !== false;
    const showLegend = options.showLegend !== false && series.length > 1;
    const lineWidth = Number(options.lineWidth) || 2;
    const smooth = options.smooth !== false;
    const animate = options.animate !== false;
    const focused = pinned ?? hoverSeries;

    // ── 第2軸（★大きな系列に潰されないようにする）─────────────────
    // 実データで踏んだ問題: splunkd（3000〜12000）が1本混じるだけで、
    // 他9系列（0〜800）が全部「下の方の平らな線」になって読めない。
    // 標準 viz も同じ挙動だが、標準には第2Y軸という逃げ道がある（それに倣う）。
    //
    // `axisRight` に系列名を挙げると、その系列だけ右側の軸で描く。
    // 何も指定していないときは `autoSplitAxis` が桁違いの系列を自動で右へ回す。
    const rightNames = new Set(
        Array.isArray(options.axisRight) ? options.axisRight.map(String) : []
    );
    const autoSplit = options.autoSplitAxis === true && rightNames.size === 0 && series.length > 1;
    if (autoSplit) {
        // 各系列の最大値を見て、全体の中央値より1桁以上大きいものを右軸へ
        const maxes = series.map((s) => Math.max(...s.values.filter((v) => v !== null).map(Math.abs), 0));
        const sorted = [...maxes].filter((m) => m > 0).sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)] || 0;
        if (med > 0) {
            series.forEach((s, i) => {
                if (maxes[i] >= med * 10) rightNames.add(s.name);
            });
        }
        // 全部が右になったら意味がないので取り消す
        if (rightNames.size === series.length) rightNames.clear();
    }
    const isRight = (name) => rightNames.has(String(name));
    const hasRightAxis = rightNames.size > 0 && rightNames.size < series.length;

    const valuesOf = (pred) =>
        series.filter((s) => pred(s.name)).flatMap((s) => s.values).filter((v) => v !== null);
    const leftVals = hasRightAxis ? valuesOf((n) => !isRight(n)) : series.flatMap((s) => s.values).filter((v) => v !== null);
    const rightVals = hasRightAxis ? valuesOf(isRight) : [];

    // ⚠ 目盛りは「切りのいい数」にする。生の min/max だと 14.1k / 10.6k のような
    //    半端な目盛りになって読めない（標準は 2.5K/5.0K/… と丸めている）。
    //    折れ線は負の値もあり得るので niceScale（0 起点でない版）を使う。
    const scaleL = niceScale(Math.min(...leftVals, 0), Math.max(...leftVals, 0), 4);
    const scaleR = hasRightAxis
        ? niceScale(Math.min(...rightVals, 0), Math.max(...rightVals, 0), 4)
        : scaleL;
    const minV = scaleL.min;
    const maxV = scaleL.max;
    const span = maxV - minV || 1;
    const spanR = scaleR.max - scaleR.min || 1;

    const padL = 46;
    // 右軸があるぶんだけ右余白を広げる
    const padR = hasRightAxis ? 46 : 14;
    const padT = 12;
    // 凡例は「下に並べる」か「右に縦積み」か。系列が多いときは右の方が全部読める
    // （標準 viz も右側に縦で並べている）
    const legendSide = showLegend && (options.legendPos === 'right' || (options.legendPos !== 'bottom' && series.length > 6));
    const legendW = legendSide ? Math.min(Math.max(width * 0.22, 110), 200) : 0;
    // 下に置くときは行数ぶん高さを取る（1行に収まらないと切れる）
    const legendH = showLegend && !legendSide ? 24 : 0;
    const padB = 26;
    const plotW = Math.max(width - padL - padR - legendW, 10);
    const plotH = Math.max(h - padT - padB - legendH, 10);
    const px = (i) => padL + (xLabels.length <= 1 ? plotW / 2 : (i / (xLabels.length - 1)) * plotW);
    // 系列ごとに使う軸を切り替える
    const pyOn = (v, right) =>
        right
            ? padT + plotH - ((v - scaleR.min) / spanR) * plotH
            : padT + plotH - ((v - minV) / span) * plotH;
    const py = (v) => pyOn(v, false);

    // なめらかな線（Catmull-Rom 由来の三次ベジェ）。点を動かさないので追加コストは軽い
    const pathFor = (vals, right = false) => {
        const pts = [];
        vals.forEach((v, i) => {
            if (v !== null) pts.push([px(i), pyOn(v, right)]);
        });
        if (pts.length === 0) return '';
        if (!smooth || pts.length < 3) {
            return pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
        }
        let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] ?? pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2] ?? p2;
            const c1x = p1[0] + (p2[0] - p0[0]) / 6;
            const c1y = p1[1] + (p2[1] - p0[1]) / 6;
            const c2x = p2[0] - (p3[0] - p1[0]) / 6;
            const c2y = p2[1] - (p3[1] - p1[1]) / 6;
            d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
        }
        return d;
    };

    // ⚠ 旧実装は `[0,.25,.5,.75,1]` を min〜max に割り当てていたため、
    //    14.1k / 10.6k / 7.1k のような半端な目盛りになっていた。
    //    niceScale が返す「切りのいい目盛り」をそのまま使う
    const ticks = scaleL.ticks;
    // X 軸ラベル。ISO の先頭切り出しをやめ、時刻軸として整形する（§scale.js）
    // ⚠ **ここで `useMemo` を使ってはいけない。** この位置は
    //    「データがありません」の early return より**後ろ**なので、
    //    フックを置くとデータ到着の瞬間にフック数が変わって落ちる（§8.1）。
    //    素の関数呼び出しにする（点数ぶんの整形なので十分軽い）
    const axisLabels = formatAxisLabels(xLabels);
    // ラベル1つぶんの実幅から間引き間隔を出す（固定値だと狭いパネルで重なる）
    const xTickEvery = Math.max(1, Math.ceil(xLabels.length / Math.max(2, Math.floor(plotW / 64))));

    // カーソルに最も近い X インデックス
    const hoverIdx =
        pt.x != null && xLabels.length > 0
            ? Math.max(
                  0,
                  Math.min(
                      xLabels.length - 1,
                      Math.round(((pt.x - padL) / Math.max(plotW, 1)) * (xLabels.length - 1))
                  )
              )
            : null;
    const showCrosshair = hoverIdx != null && pt.x >= padL - 8 && pt.x <= padL + plotW + 8;

    return (
        <div ref={ref} style={{ height: h, position: 'relative' }} {...pointerHandlers}>
            <svg width="100%" height={h - legendH} style={{ display: 'block' }} className="dpx-hit">
                {showGrid
                    ? ticks.map((v) => (
                          <g key={v}>
                              <line
                                  x1={padL}
                                  x2={padL + plotW}
                                  y1={py(v)}
                                  y2={py(v)}
                                  stroke={t.subColor}
                                  strokeOpacity={0.16}
                              />
                              <text x={padL - 7} y={py(v) + 3} textAnchor="end" fontSize={10} fill={t.subColor}>
                                  {fmt(v)}
                              </text>
                          </g>
                      ))
                    : null}
                {/* 右軸の目盛り（第2軸を使うときだけ） */}
                {showGrid && hasRightAxis
                    ? scaleR.ticks.map((v) => (
                          <text
                              key={`r${v}`}
                              x={padL + plotW + 7}
                              y={pyOn(v, true) + 3}
                              textAnchor="start"
                              fontSize={10}
                              fill={t.subColor}
                              opacity={0.85}
                          >
                              {fmt(v)}
                          </text>
                      ))
                    : null}

                {/* X 軸ラベル。時刻は `15:00`、日付が変わる位置だけ下段に `8/12` を出す
                    （ISO を切り詰めると全部 `2026-08-1…` になる。実機で発生） */}
                {axisLabels.map((lab, i) =>
                    i % xTickEvery === 0 ? (
                        <g key={i}>
                            <text
                                x={px(i)}
                                y={padT + plotH + 14}
                                textAnchor="middle"
                                fontSize={10}
                                fill={t.subColor}
                            >
                                {lab.main}
                            </text>
                            {lab.sub ? (
                                <text
                                    x={px(i)}
                                    y={padT + plotH + 24}
                                    textAnchor="middle"
                                    fontSize={9}
                                    fill={t.subColor}
                                    opacity={0.8}
                                >
                                    {lab.sub}
                                </text>
                            ) : null}
                        </g>
                    ) : null
                )}

                {/* クロスヘア（縦線）。ジオメトリの再ラスタライズを避けるため線1本のみ */}
                {showCrosshair ? (
                    <line
                        x1={px(hoverIdx)}
                        x2={px(hoverIdx)}
                        y1={padT}
                        y2={padT + plotH}
                        stroke={t.accent}
                        strokeOpacity={0.5}
                        strokeDasharray="3 3"
                    />
                ) : null}

                {series.map((s, si) => {
                    const color = seriesColor(lineColorCfg, t, si, s.name);
                    const right = isRight(s.name);
                    const line = pathFor(s.values, right);
                    const isFocused = focused === s.name;
                    const dim = focused != null && !isFocused;
                    const firstIdx = s.values.findIndex((v) => v !== null);
                    const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
                    const w = isFocused ? lineWidth + 1.2 : lineWidth;
                    return (
                        <g
                            key={s.name}
                            style={{ opacity: dim ? 0.18 : 1, transition: 'opacity 0.18s ease' }}
                            onMouseEnter={() => setHoverSeries(s.name)}
                            onMouseLeave={() => setHoverSeries(null)}
                            onClick={() => setPinned((prev) => (prev === s.name ? null : s.name))}
                        >
                            {showArea && firstIdx >= 0 ? (
                                <path
                                    // ⚠ 塗りの底辺は**その系列が使っている軸の下端**にする。
                                    //    左軸固定にすると右軸の系列だけ塗りが浮く／突き抜ける
                                    d={`${line}L${px(lastIdx).toFixed(1)},${pyOn(right ? scaleR.min : minV, right)}L${px(firstIdx).toFixed(1)},${pyOn(right ? scaleR.min : minV, right)}Z`}
                                    fill={color}
                                    fillOpacity={isFocused ? 0.2 : dim ? 0.05 : 0.12}
                                    style={{ transition: 'fill-opacity 0.18s ease' }}
                                />
                            ) : null}
                            {/* フォーカス時のグローは「太い半透明の実線」で代替（SVG フィルタは使わない） */}
                            {isFocused ? (
                                <path d={line} fill="none" stroke={color} strokeWidth={w + 5} strokeOpacity={0.18} />
                            ) : null}
                            <path
                                d={line}
                                fill="none"
                                stroke={color}
                                strokeWidth={w}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                ref={(el) => {
                                    if (!el || !animate || el.dataset.drawn) return;
                                    const len = el.getTotalLength?.() ?? 0;
                                    if (!len) return;
                                    el.dataset.drawn = '1';
                                    el.style.setProperty('--dpx-len', len);
                                    el.style.strokeDasharray = len;
                                    el.style.animation = `dpxDraw 0.9s ease-out ${si * 0.08}s both`;
                                    // ⚠ 描き込みが終わったら dasharray を必ず捨てる。
                                    //   残したままだとパネル幅が変わった（ResizeObserver で
                                    //   後から広がる）ときに「古い長さの破線」が線を途中で
                                    //   切ってしまう。塗り(area)は dasharray の影響を受けない
                                    //   ため、線だけが途中で消えて見える（実機で再現・確認）。
                                    const clear = () => {
                                        el.style.animation = '';
                                        el.style.strokeDasharray = '';
                                        el.style.strokeDashoffset = '';
                                    };
                                    el.addEventListener('animationend', clear, { once: true });
                                    // アニメが走らなかった場合の保険（タブ非表示など）
                                    setTimeout(clear, 1200 + si * 80);
                                }}
                                style={{ transition: 'stroke-width 0.18s ease' }}
                            />
                            {showDots
                                ? s.values.map((v, i) =>
                                      v === null ? null : (
                                          <circle key={i} cx={px(i)} cy={pyOn(v, right)} r={2.5} fill={color} />
                                      )
                                  )
                                : null}
                            {/* クロスヘア位置のマーカー */}
                            {showCrosshair && s.values[hoverIdx] !== null && !dim ? (
                                <g>
                                    <circle
                                        cx={px(hoverIdx)}
                                        cy={pyOn(s.values[hoverIdx], right)}
                                        r={7}
                                        fill={color}
                                        fillOpacity={0.22}
                                    />
                                    <circle
                                        cx={px(hoverIdx)}
                                        cy={pyOn(s.values[hoverIdx], right)}
                                        r={3.5}
                                        fill={color}
                                        stroke={t.colorScheme === 'light' ? '#fff' : '#0b1220'}
                                        strokeWidth={1.5}
                                    />
                                </g>
                            ) : null}
                        </g>
                    );
                })}
            </svg>

            {showCrosshair ? (
                <VizTooltip
                    t={t}
                    x={pt.x}
                    y={pt.y}
                    width={width}
                    height={h}
                    // ツールチップの見出しも整形済みラベルにする（ISO の生文字列は長すぎる）
                    title={
                        axisLabels[hoverIdx]
                            ? `${axisLabels[hoverIdx].sub ? `${axisLabels[hoverIdx].sub} ` : ''}${axisLabels[hoverIdx].main}`
                            : xLabels[hoverIdx]
                    }
                    accent={t.accent}
                    // ⚠ **値の大きい順に並べる。** 行数が入りきらないときは
                    //    VizTooltip が後ろを切るので、並べ替えないと
                    //    「たまたま後ろにいた大きな系列」が消える。
                    //    固定中の系列は必ず先頭に置く（見たいものが切られないように）
                    rows={series
                        .map((s, si) => ({
                            label: s.name,
                            value: fmt(s.values[hoverIdx]),
                            raw: s.values[hoverIdx],
                            color: seriesColor(lineColorCfg, t, si, s.name),
                            dim: focused != null && focused !== s.name,
                        }))
                        .sort((a, b) => {
                            if (focused) {
                                if (a.label === focused) return -1;
                                if (b.label === focused) return 1;
                            }
                            return (b.raw ?? -Infinity) - (a.raw ?? -Infinity);
                        })}
                />
            ) : null}

            {showLegend ? (
                <div
                    style={
                        legendSide
                            ? {
                                  // 右に縦積み（標準 viz と同じ形）。系列が多くても全部読める。
                                  // ⚠ 下に横並びだと、はみ出したぶんが**黙って切れる**
                                  //    （実機で「node…」で切れていた）。縦なら溢れても
                                  //    スクロールで到達できる
                                  position: 'absolute',
                                  right: 4,
                                  top: 8,
                                  width: legendW - 8,
                                  maxHeight: h - 16,
                                  overflowY: 'auto',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 2,
                                  fontSize: 11,
                              }
                            : { display: 'flex', gap: 12, padding: '2px 12px', fontSize: 11, flexWrap: 'wrap' }
                    }
                    className={legendSide ? 'dpx-scroll' : undefined}
                >
                    {series.map((s, si) => {
                        const color = seriesColor(lineColorCfg, t, si, s.name);
                        const isFocused = focused === s.name;
                        const dim = focused != null && !isFocused;
                        return (
                            <button
                                key={s.name}
                                type="button"
                                onMouseEnter={() => setHoverSeries(s.name)}
                                onMouseLeave={() => setHoverSeries(null)}
                                onClick={() => setPinned((prev) => (prev === s.name ? null : s.name))}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    background: 'transparent',
                                    border: 'none',
                                    padding: '2px 4px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    color: dim ? t.subColor : t.titleColor,
                                    opacity: dim ? 0.5 : 1,
                                    fontFamily: 'inherit',
                                    fontSize: 11,
                                    transition: 'opacity 0.15s ease',
                                    // 縦積みのときは左揃え＋幅いっぱい（ボタンが中央に寄ると読みにくい）
                                    ...(legendSide ? { width: '100%', textAlign: 'left', minWidth: 0 } : null),
                                }}
                                // 系列名は長いことがある。ツールチップで全体を読めるようにする
                                title={`${s.name}${isRight(s.name) ? '（右軸）' : ''} — ${
                                    pinned === s.name ? 'クリックで固定を解除' : 'クリックでこの系列に固定'
                                }`}
                            >
                                <span
                                    style={{
                                        width: isFocused ? 14 : 10,
                                        height: 3,
                                        borderRadius: 2,
                                        background: color,
                                        flex: 'none',
                                        transition: 'width 0.15s ease',
                                    }}
                                />
                                <span
                                    style={{
                                        minWidth: 0,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {s.name}
                                </span>
                                {/* 右軸の系列は見た目で分かるようにする（軸が2本あると混乱するため） */}
                                {isRight(s.name) ? (
                                    <span style={{ color: t.subColor, fontSize: 9, flex: 'none' }}>R</span>
                                ) : null}
                                {pinned === s.name ? <span style={{ color: t.accent, fontSize: 9 }}>●</span> : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}

DpxLine.config = {
    key: 'dpx.line',
    name: '折れ線・エリア',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        colors: { type: 'object', default: {} },
        showArea: { type: 'boolean', default: true },
        showDots: { type: 'boolean', default: false },
        showGrid: { type: 'boolean', default: true },
        showLegend: { type: 'boolean', default: true },
        smooth: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        lineWidth: { type: 'number', default: 2 },
        legendPos: { type: 'string', default: 'auto' },
        axisRight: { type: 'array', default: [] },
        autoSplitAxis: { type: 'boolean', default: false },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '塗りつぶし', option: 'showArea', editor: 'editor.checkbox' }],
                [{ label: 'なめらかな線', option: 'smooth', editor: 'editor.checkbox' }],
                [{ label: 'ポイント表示', option: 'showDots', editor: 'editor.checkbox' }],
                [{ label: 'グリッド線', option: 'showGrid', editor: 'editor.checkbox' }],
                [{ label: '凡例を表示', option: 'showLegend', editor: 'editor.checkbox' }],
                [
                    {
                        label: '凡例の位置',
                        option: 'legendPos',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { value: 'auto', label: '自動' },
                                { value: 'right', label: '右' },
                                { value: 'bottom', label: '下' },
                            ],
                        },
                    },
                ],
                [{ label: '描画アニメ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: '線の太さ(px)', option: 'lineWidth', editor: 'editor.slider', editorProps: { min: 1, max: 6, step: 0.5 } }],
            ],
        },
        {
            // 桁違いの系列が1本あるだけで、他が全部「下の平らな線」になってしまう。
            // 標準 viz と同じく第2軸で逃がせるようにする
            label: '第2軸（桁違いの系列を分ける）',
            layout: [
                [{ label: '桁違いの系列を自動で右軸へ', option: 'autoSplitAxis', editor: 'editor.checkbox' }],
                [
                    {
                        label: '右軸で描く系列',
                        option: 'axisRight',
                        editor: 'editor.columnMultiSelectionByFieldNameEditor',
                    },
                ],
            ],
        },
        {
            label: '値→色',
            layout: [
                [
                    {
                        label: '系列の色（未設定ならテーマ配色）',
                        option: 'colors',
                        editor: 'editor.colorRules',
                        editorProps: { valueHint: '系列名（例: web）' },
                    },
                ],
            ],
        },
    ],
};

// ── dpx.bar ──────────────────────────────────────────────────────
// インタラクション: ホバーで対象を強調＋他を減光、値ツールチップ、
// クリックでトークン発火。初回は下から伸びるアニメ（transform のみ）。

export function DpxBar({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const { hoverKey, setHoverKey } = useVizHover();
    const [ref, width] = useContainerSize();
    const [pt, pointerHandlers] = usePointer();
    const [hoverIdx, setHoverIdx] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const h = Math.max(typeof height === 'number' ? height : 240, 60);
    const allLabels = cols[0].map((v) => String(v));
    const allValues = cols[1].map(toNum);

    // ⚠ **上限件数は必ず設ける。** 標準 viz も無制限には描かない。
    //    0 / 未設定は「制限なし」の意味にする（既定は 200）
    const maxBars = Number.isFinite(Number(options.maxBars)) ? Number(options.maxBars) : 200;
    const truncated = maxBars > 0 && allLabels.length > maxBars;
    const labels = truncated ? allLabels.slice(0, maxBars) : allLabels;
    const values = truncated ? allValues.slice(0, maxBars) : allValues;

    const n = labels.length;
    const maxV = Math.max(...values.filter((v) => v !== null), 1);
    const singleColor = options.monochrome !== false;
    // ⚠ **件数が多いときは描画アニメを切る。**
    //    `dpxGrow ... both` は終了後も要素を「アニメーション中」の状態に留めるので、
    //    合成レイヤが残り続けて**画面全体が重くなる**。
    //    実測（1920x1080・454本）: 22.6fps → アニメ停止で 60.7fps。
    //    バーを visibility:hidden にしても改善しなかった（＝塗りではなくアニメが原因）。
    //    60本を超えたら演出より読めることを優先する。
    const animate = options.animate !== false && n <= 60;
    const barColorCfg = resolveColorRules(options.colors ?? options.barColors, null);
    // 標準の splunk.bar（横向き）/ splunk.column（縦向き）に合わせて向きを選べる。
    // 件数が多いときは横向きの方がラベルを読める（標準もそうなっている）
    const horizontal = options.orientation === 'horizontal';
    const showAxis = options.showAxis !== false;

    const baseColor = typeof options.color === 'string' && options.color ? options.color : t.accent;
    const colorAt = (i) => {
        const ruled = barColorCfg
            ? colorForValue(barColorCfg, labels[i]) ?? colorForValue(barColorCfg, values[i])
            : null;
        return ruled || (singleColor ? baseColor : t.palette[i % t.palette.length]);
    };

    const ticks = showAxis ? niceTicks(maxV, horizontal ? 5 : 4) : [];
    // ⚠ 軸の上端は**最後の目盛りそのもの**にする。max で割ると
    //    一番上のグリッド線の位置と数字がズレる（scale.test.mjs で担保）
    const axisMax = ticks.length > 1 ? ticks[ticks.length - 1] : maxV;

    // ── 縦向き（splunk.column 相当）─────────────────────────────
    if (!horizontal) {
        // ⚠ **ここが「200行で棒が消えた」原因。**
        //    flex + gap:8 の固定間隔だと、件数×8px が幅を食い尽くして
        //    バー自身の幅が 0 になる（実機計測：200件で 171/171 本が 0px）。
        //    → **間隔は「幅から算出する」**。1本あたりの取り分を先に決め、
        //      そこから隙間を比率で取る（最低 1px はバーに残す）。
        const axisW = showAxis ? 44 : 0;
        const plotW = Math.max(width - axisW - 12, 40);
        const slot = plotW / n;
        // 隙間はスロットの 18%、ただし最大 6px。細いときは 0 まで詰める
        const gap = Math.min(slot * 0.18, 6);
        const barW = Math.max(slot - gap, 1);
        // 値ラベルは「入るときだけ」出す（標準も詰まると出さない）
        const showValues = options.showValues !== false && slot >= 26;
        // ラベルは間引く。全部出すと重なって読めない（実機で確認済み）
        const labelEvery = Math.max(1, Math.ceil(52 / slot));
        const showLabels = options.showLabels !== false && slot >= 6;
        const labelH = showLabels ? 20 : 4;

        return (
            <div
                ref={ref}
                style={{ height: h, position: 'relative', boxSizing: 'border-box', padding: '8px 8px 2px' }}
                {...pointerHandlers}
            >
                <div style={{ display: 'flex', height: `calc(100% - ${labelH}px)`, minHeight: 0 }}>
                    {/* 値軸（標準 viz と同じく目盛りとグリッド線を出す）。
                        1本ずつの数字が出せない密度でも、これがあれば大きさが読める */}
                    {showAxis ? (
                        <div style={{ width: 44, flex: 'none', position: 'relative' }}>
                            {ticks.map((v) => (
                                <span
                                    key={v}
                                    style={{
                                        position: 'absolute',
                                        right: 6,
                                        bottom: `${(v / axisMax) * 100}%`,
                                        transform: 'translateY(50%)',
                                        fontSize: 9,
                                        color: t.subColor,
                                        opacity: 0.75,
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {fmt(v, 0)}
                                </span>
                            ))}
                        </div>
                    ) : null}
                    <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                        {showAxis
                            ? ticks.map((v) => (
                                  <span
                                      key={v}
                                      style={{
                                          position: 'absolute',
                                          left: 0,
                                          right: 0,
                                          bottom: `${(v / axisMax) * 100}%`,
                                          borderTop: `1px solid ${t.subColor}${v === 0 ? '44' : '1c'}`,
                                          pointerEvents: 'none',
                                      }}
                                  />
                              ))
                            : null}
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'flex-end',
                                justifyContent: 'space-between',
                            }}
                        >
                            {labels.map((label, i) => {
                                const v = values[i];
                                const ratio = v === null ? 0 : v / axisMax;
                                const color = colorAt(i);
                                const key = `bar:${label}`;
                                const hovered = hoverIdx === i || hoverKey === key;
                                const dimmed =
                                    (hoverIdx !== null && hoverIdx !== i) ||
                                    (hoverKey?.startsWith('bar:') && hoverKey !== key);
                                return (
                                    <div
                                        key={label + i}
                                        onMouseEnter={() => {
                                            setHoverIdx(i);
                                            setHoverKey(key);
                                        }}
                                        onMouseLeave={() => {
                                            setHoverIdx(null);
                                            setHoverKey(null);
                                        }}
                                        onClick={(originalEvent) =>
                                            onEventTrigger?.({
                                                type: 'bar.click',
                                                originalEvent,
                                                payload: {
                                                    name: fields[0] ?? 'label',
                                                    value: label,
                                                    [`row.${fields[0] ?? 'label'}.value`]: label,
                                                    [`row.${fields[1] ?? 'value'}.value`]: v,
                                                },
                                            })
                                        }
                                        style={{
                                            width: barW,
                                            flex: 'none',
                                            height: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            justifyContent: 'flex-end',
                                            cursor: onEventTrigger ? 'pointer' : 'default',
                                            opacity: dimmed ? 0.32 : 1,
                                            transition: 'opacity 0.15s ease',
                                            position: 'relative',
                                        }}
                                    >
                                        {showValues ? (
                                            <span
                                                style={{
                                                    fontSize: 11,
                                                    color: hovered ? t.titleColor : t.subColor,
                                                    marginBottom: 3,
                                                    fontWeight: hovered ? 700 : 400,
                                                    whiteSpace: 'nowrap',
                                                    transition: 'color 0.15s ease',
                                                }}
                                            >
                                                {fmt(v)}
                                            </span>
                                        ) : null}
                                        <div
                                            className="dpx-bar-rect"
                                            style={{
                                                width: '100%',
                                                height: `${Math.max(ratio * 100, v === null ? 0 : 1.5)}%`,
                                                // 細いバーに角丸を付けると形が潰れるので幅で切り替える
                                                borderRadius: barW >= 6 ? '4px 4px 1px 1px' : 0,
                                                background:
                                                    barW >= 3
                                                        ? `linear-gradient(180deg, ${color}, ${color}77)`
                                                        : color,
                                                // ⚠ 細いバーが大量にあるときに影を全部に付けると
                                                //    塗り面積が増えて重くなる（viz-performance.md §2）。
                                                //    密なときは影を出さない
                                                boxShadow:
                                                    barW < 4
                                                        ? 'none'
                                                        : hovered
                                                          ? `0 0 14px ${color}88, 0 0 3px ${color}`
                                                          : `0 0 8px ${color}33`,
                                                transition: 'height 0.4s ease, box-shadow 0.15s ease',
                                                animation: animate
                                                    ? `dpxGrow 0.6s ease-out ${Math.min(i * 0.05, 0.4)}s both`
                                                    : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
                {/* ラベル行。間引いて重なりを防ぐ */}
                {showLabels ? (
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            height: labelH,
                            marginLeft: showAxis ? 44 : 0,
                            overflow: 'hidden',
                        }}
                    >
                        {labels.map((label, i) => (
                            <div
                                key={label + i}
                                style={{
                                    width: barW,
                                    flex: 'none',
                                    fontSize: 10,
                                    color: hoverIdx === i ? t.titleColor : t.subColor,
                                    textAlign: 'center',
                                    whiteSpace: 'nowrap',
                                    overflow: 'visible',
                                    paddingTop: 3,
                                }}
                            >
                                {i % labelEvery === 0 ? label : ''}
                            </div>
                        ))}
                    </div>
                ) : null}
                {truncated ? <TruncNote t={t} shown={n} total={allLabels.length} /> : null}
                {hoverIdx !== null ? (
                    <VizTooltip
                        t={t}
                        x={pt.x}
                        y={pt.y}
                        width={width}
                        height={h}
                        title={labels[hoverIdx]}
                        rows={[{ label: fields[1] ?? '値', value: fmt(values[hoverIdx]) }]}
                    />
                ) : null}
            </div>
        );
    }

    // ── 横向き（splunk.bar 相当）───────────────────────────────
    // 件数が多いときはこちらが読める。1本の高さを確保し、入りきらなければ
    // パネル内を縦スクロールさせる（標準は潰すが、DPX は読めることを優先）
    const rowH = Math.max(Number(options.rowHeight) || 22, 8);
    const labelW = Math.min(Math.max(Number(options.labelWidth) || 90, 40), 260);
    const needScroll = n * rowH > h - 26;

    return (
        <div ref={ref} style={{ height: h, display: 'flex', flexDirection: 'column', minHeight: 0 }} {...pointerHandlers}>
            <div
                className="dpx-scroll"
                style={{ flex: 1, minHeight: 0, overflowY: needScroll ? 'auto' : 'hidden', overflowX: 'hidden', position: 'relative' }}
            >
                <div style={{ position: 'relative', padding: '4px 10px 4px 0' }}>
                    {/* 縦のグリッド線＋目盛り（値軸） */}
                    {showAxis
                        ? ticks.map((v) => (
                              <span
                                  key={v}
                                  style={{
                                      position: 'absolute',
                                      top: 0,
                                      bottom: 0,
                                      left: `calc(${labelW}px + (100% - ${labelW}px - 10px) * ${v / axisMax})`,
                                      borderLeft: `1px solid ${t.subColor}${v === 0 ? '44' : '1c'}`,
                                      pointerEvents: 'none',
                                  }}
                              />
                          ))
                        : null}
                    {labels.map((label, i) => {
                        const v = values[i];
                        const ratio = v === null ? 0 : v / axisMax;
                        const color = colorAt(i);
                        const key = `bar:${label}`;
                        const hovered = hoverIdx === i || hoverKey === key;
                        const dimmed =
                            (hoverIdx !== null && hoverIdx !== i) || (hoverKey?.startsWith('bar:') && hoverKey !== key);
                        return (
                            <div
                                key={label + i}
                                onMouseEnter={() => {
                                    setHoverIdx(i);
                                    setHoverKey(key);
                                }}
                                onMouseLeave={() => {
                                    setHoverIdx(null);
                                    setHoverKey(null);
                                }}
                                onClick={(originalEvent) =>
                                    onEventTrigger?.({
                                        type: 'bar.click',
                                        originalEvent,
                                        payload: {
                                            name: fields[0] ?? 'label',
                                            value: label,
                                            [`row.${fields[0] ?? 'label'}.value`]: label,
                                            [`row.${fields[1] ?? 'value'}.value`]: v,
                                        },
                                    })
                                }
                                style={{
                                    height: rowH,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    cursor: onEventTrigger ? 'pointer' : 'default',
                                    opacity: dimmed ? 0.32 : 1,
                                    transition: 'opacity 0.15s ease',
                                    position: 'relative',
                                }}
                            >
                                <div
                                    style={{
                                        width: labelW,
                                        flex: 'none',
                                        fontSize: rowH >= 16 ? 11 : 9,
                                        color: hovered ? t.titleColor : t.subColor,
                                        textAlign: 'right',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                    }}
                                >
                                    {label}
                                </div>
                                <div style={{ flex: 1, minWidth: 0, position: 'relative', height: '100%' }}>
                                    <div
                                        className="dpx-bar-rect"
                                        style={{
                                            position: 'absolute',
                                            left: 0,
                                            top: '50%',
                                            transform: 'translateY(-50%)',
                                            height: Math.max(rowH - 6, 3),
                                            width: `${Math.max(ratio * 100, v === null ? 0 : 0.6)}%`,
                                            borderRadius: '1px 4px 4px 1px',
                                            background: `linear-gradient(90deg, ${color}, ${color}77)`,
                                            boxShadow: hovered ? `0 0 12px ${color}88` : 'none',
                                            transition: 'width 0.4s ease, box-shadow 0.15s ease',
                                        }}
                                    />
                                    {options.showValues !== false && rowH >= 14 ? (
                                        <span
                                            style={{
                                                position: 'absolute',
                                                left: `calc(${Math.max(ratio * 100, 0)}% + 6px)`,
                                                top: '50%',
                                                transform: 'translateY(-50%)',
                                                fontSize: 10,
                                                color: hovered ? t.titleColor : t.subColor,
                                                whiteSpace: 'nowrap',
                                                pointerEvents: 'none',
                                            }}
                                        >
                                            {fmt(v)}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            {/* 値軸の数字（横向きは下に置く） */}
            {showAxis ? (
                <div style={{ flex: 'none', height: 14, position: 'relative', marginLeft: labelW + 6, marginRight: 10 }}>
                    {ticks.map((v) => (
                        <span
                            key={v}
                            style={{
                                position: 'absolute',
                                left: `${(v / axisMax) * 100}%`,
                                transform: 'translateX(-50%)',
                                fontSize: 9,
                                color: t.subColor,
                                opacity: 0.75,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {fmt(v, 0)}
                        </span>
                    ))}
                </div>
            ) : null}
            {truncated ? <TruncNote t={t} shown={n} total={allLabels.length} /> : null}
            {hoverIdx !== null ? (
                <VizTooltip
                    t={t}
                    x={pt.x}
                    y={pt.y}
                    width={width}
                    height={h}
                    title={labels[hoverIdx]}
                    rows={[{ label: fields[1] ?? '値', value: fmt(values[hoverIdx]) }]}
                />
            ) : null}
        </div>
    );
}

/** 件数を切り詰めたことを黙って隠さない（「全部出ている」と誤解させないため）。 */
function TruncNote({ t, shown, total }) {
    return (
        <div
            style={{
                position: 'absolute',
                right: 8,
                top: 4,
                fontSize: 9,
                color: t.subColor,
                background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.8)' : 'rgba(10,16,30,0.72)',
                padding: '1px 5px',
                borderRadius: 3,
                pointerEvents: 'none',
            }}
        >
            上位 {shown} / {total} 件
        </div>
    );
}

DpxBar.config = {
    key: 'dpx.bar',
    name: '棒グラフ',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        orientation: { type: 'string', default: 'vertical' },
        maxBars: { type: 'number', default: 200 },
        showAxis: { type: 'boolean', default: true },
        showValues: { type: 'boolean', default: true },
        showLabels: { type: 'boolean', default: true },
        rowHeight: { type: 'number', default: 22 },
        labelWidth: { type: 'number', default: 90 },
        monochrome: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        color: { type: 'string', default: '' },
        colors: { type: 'object', default: {} },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [
                    {
                        label: '向き',
                        option: 'orientation',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { value: 'vertical', label: '縦' },
                                { value: 'horizontal', label: '横' },
                            ],
                        },
                    },
                ],
                [{ label: '値軸と目盛り線', option: 'showAxis', editor: 'editor.checkbox' }],
                [{ label: '値を表示', option: 'showValues', editor: 'editor.checkbox' }],
                [{ label: 'ラベルを表示', option: 'showLabels', editor: 'editor.checkbox' }],
                [{ label: '単色にする', option: 'monochrome', editor: 'editor.checkbox' }],
                [{ label: '描画アニメ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: 'バーの色（単色時）', option: 'color', editor: 'editor.color' }],
            ],
        },
        {
            label: '件数が多いとき',
            layout: [
                [{ label: '最大件数（0で無制限）', option: 'maxBars', editor: 'editor.number' }],
                [{ label: '1行の高さ(px)（横向き）', option: 'rowHeight', editor: 'editor.number' }],
                [{ label: 'ラベル幅(px)（横向き）', option: 'labelWidth', editor: 'editor.number' }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [
                    {
                        label: 'ラベル/値の色（設定すると優先）',
                        option: 'colors',
                        editor: 'editor.colorRules',
                        editorProps: { valueHint: 'ラベル（例: app-1）' },
                    },
                ],
            ],
        },
    ],
};

// ── dpx.value ────────────────────────────────────────────────────

export function DpxValue({ dataSources, options = {}, height, loading }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const numericCol = cols.find((col) => col.some((v) => toNum(v) !== null)) ?? [];
    const values = numericCol.map(toNum).filter((v) => v !== null);
    const current = values.length > 0 ? values[values.length - 1] : null;
    // ⚠ フックは early return より前に呼ぶ（データ有無でフック数が変わると
    //    React が "Rendered more hooks than during the previous render" で落ちる。
    //    データ到着で「なし→あり」に変わる viz では必ず踏む）
    const animatedValue = useCountUp(current, { enabled: options.animate !== false && current !== null });
    if (values.length === 0) {
        return <EmptyHint loading={loading} message="数値列がありません" />;
    }

    const h = typeof height === 'number' ? height : 160;
    const prev = values.length > 1 ? values[values.length - 2] : null;
    const delta = prev !== null && prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : null;
    const size = Number(options.size) || 44;
    // 値→色（範囲モードのしきい値）。当たらなければ options.color → アクセント
    const colorCfg = resolveColorRules(options.colors ?? options.thresholds, null);
    const color = (colorCfg ? colorForValue(colorCfg, current) : null) || options.color || t.accent;
    const showSpark = options.showSpark !== false && values.length > 1;
    const decimals = Number.isFinite(Number(options.decimals)) ? Number(options.decimals) : 1;
    const deltaUp = delta !== null && delta >= 0;
    const deltaColor = delta === null ? t.subColor : deltaUp === (options.upIsBad === true) ? '#ff5c8a' : '#3cdcb4';

    const sparkW = 120;
    const sparkH = 30;
    const minV = Math.min(...values);
    const span = Math.max(...values) - minV || 1;
    const sparkPts = values
        .map((v, i) => `${((i / (values.length - 1)) * sparkW).toFixed(1)},${(sparkH - ((v - minV) / span) * sparkH).toFixed(1)}`)
        .join(' ');

    return (
        <div style={{ height: h, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            {options.caption ? (
                <span style={{ fontSize: 12, color: t.subColor, letterSpacing: '0.1em' }}>{options.caption}</span>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span
                    style={{
                        fontSize: size,
                        fontWeight: 700,
                        color,
                        fontVariantNumeric: 'tabular-nums',
                        textShadow: options.glow ? `0 0 16px ${color}` : 'none',
                        lineHeight: 1,
                    }}
                >
                    {fmt(animatedValue, decimals)}
                </span>
                {options.unit ? <span style={{ fontSize: size * 0.4, color: t.subColor }}>{options.unit}</span> : null}
            </div>
            {delta !== null ? (
                <span style={{ fontSize: 12, color: deltaColor }}>
                    {deltaUp ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
                </span>
            ) : null}
            {showSpark ? (
                <svg width={sparkW} height={sparkH} style={{ overflow: 'visible', marginTop: 2 }}>
                    <polygon
                        points={`0,${sparkH} ${sparkPts} ${sparkW},${sparkH}`}
                        fill={color}
                        fillOpacity={0.15}
                    />
                    <polyline
                        points={sparkPts}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.6}
                        strokeOpacity={0.85}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                    {/* 末端のパルス（transform/opacity のみ＝コンポジタ処理） */}
                    <circle
                        cx={sparkW}
                        cy={sparkH - ((values[values.length - 1] - minV) / span) * sparkH}
                        r={4}
                        fill={color}
                        style={{ transformOrigin: `${sparkW}px ${sparkH - ((values[values.length - 1] - minV) / span) * sparkH}px`, animation: 'dpxPulse 2s ease-in-out infinite' }}
                    />
                    <circle
                        cx={sparkW}
                        cy={sparkH - ((values[values.length - 1] - minV) / span) * sparkH}
                        r={2}
                        fill={color}
                    />
                </svg>
            ) : null}
        </div>
    );
}

DpxValue.config = {
    key: 'dpx.value',
    name: '単一値',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        caption: { type: 'string', default: '' },
        unit: { type: 'string', default: '' },
        size: { type: 'number', default: 44 },
        decimals: { type: 'number', default: 1 },
        color: { type: 'string', default: '' },
        colors: { type: 'object', default: {} },
        glow: { type: 'boolean', default: false },
        showSpark: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        upIsBad: { type: 'boolean', default: false },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: 'キャプション', option: 'caption', editor: 'editor.text' }],
                [{ label: '単位', option: 'unit', editor: 'editor.text' }],
                [{ label: 'サイズ(px)', option: 'size', editor: 'editor.number' }],
                [{ label: '小数桁', option: 'decimals', editor: 'editor.number' }],
                [{ label: '色', option: 'color', editor: 'editor.color' }],
                [{ label: 'グロー', option: 'glow', editor: 'editor.checkbox' }],
                [{ label: 'スパークライン', option: 'showSpark', editor: 'editor.checkbox' }],
                [{ label: 'カウントアップ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: '増加を悪化として扱う', option: 'upIsBad', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値→色',
            layout: [[{ label: 'しきい値の色', option: 'colors', editor: 'editor.colorRules' }]],
        },
    ],
};

// ── dpx.status ───────────────────────────────────────────────────

// ステータスの既定色（一致モードの初期値として使う）
const DEFAULT_STATUS_MATCHES = [
    { value: 'ok', color: '#3cdcb4', label: '' },
    { value: 'warn', color: '#ffb020', label: '' },
    { value: 'crit', color: '#ff5c8a', label: '' },
];
const DEFAULT_STATUS_COLORS = {
    ok: '#3cdcb4', up: '#3cdcb4', normal: '#3cdcb4', healthy: '#3cdcb4', success: '#3cdcb4', good: '#3cdcb4', green: '#3cdcb4',
    warn: '#ffb020', warning: '#ffb020', degraded: '#ffb020', slow: '#ffb020', amber: '#ffb020', yellow: '#ffb020',
    crit: '#ff5c8a', critical: '#ff5c8a', down: '#ff5c8a', error: '#ff5c8a', fail: '#ff5c8a', failed: '#ff5c8a', red: '#ff5c8a',
    info: '#4ea1ff', blue: '#4ea1ff',
};

export function DpxStatus({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const { hoverKey, setHoverKey } = useVizHover();
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=名前、2列目=状態）" />;
    }

    const h = typeof height === 'number' ? height : 200;
    const names = cols[0].map((v) => String(v));
    const states = cols[1].map((v) => String(v ?? ''));
    const details = cols[2] ?? [];
    const columns = Math.max(1, Number(options.columns) || 3);
    const showDetail = options.showDetail !== false && cols.length > 2;
    // options.colors（新形式）→ 旧 options.rules（配列）→ 未設定 の順で解決する
    const colorCfg = resolveColorRules(options.colors ?? options.rules, null);
    const upperState = options.upperCaseState !== false;

    return (
        <div
            className="dpx-scroll"
            style={{
                height: h,
                overflow: 'auto',
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: 8,
                padding: 10,
                boxSizing: 'border-box',
                alignContent: 'start',
            }}
        >
            {names.map((name, i) => {
                const state = states[i];
                // 設定があればそれに従い、無ければ「よくある表記」の既定色にフォールバック
                const configured = colorCfg ? colorForValue(colorCfg, state) : null;
                const color = configured || DEFAULT_STATUS_COLORS[String(state).toLowerCase()] || t.subColor;
                const stateLabel = (colorCfg ? labelForValue(colorCfg, state) : null) || state;
                const hkey = `status:${name}`;
                const hovered = hoverKey === hkey;
                const dimmed = hoverKey?.startsWith('status:') && !hovered;
                return (
                    <div
                        key={name + i}
                        onMouseEnter={() => setHoverKey(hkey)}
                        onMouseLeave={() => setHoverKey(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'status.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'name',
                                    value: name,
                                    [`row.${fields[0] ?? 'name'}.value`]: name,
                                    [`row.${fields[1] ?? 'status'}.value`]: state,
                                },
                            })
                        }
                        style={{
                            border: `1px solid ${color}${hovered ? '99' : '55'}`,
                            borderLeft: `4px solid ${color}`,
                            borderRadius: 8,
                            padding: '8px 10px',
                            background: hovered ? `${color}1f` : `${color}0d`,
                            cursor: onEventTrigger ? 'pointer' : 'default',
                            minWidth: 0,
                            transform: hovered ? 'translateY(-2px)' : 'none',
                            boxShadow: hovered ? `0 6px 18px rgba(0,0,0,0.35), 0 0 0 1px ${color}44` : 'none',
                            opacity: dimmed ? 0.45 : 1,
                            transition: 'transform 0.15s ease, background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ position: 'relative', width: 8, height: 8, flex: 'none' }}>
                                {options.pulse !== false ? (
                                    <span
                                        style={{
                                            position: 'absolute',
                                            inset: 0,
                                            borderRadius: 4,
                                            background: color,
                                            animation: 'dpxPulse 1.8s ease-in-out infinite',
                                        }}
                                    />
                                ) : null}
                                <span
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        borderRadius: 4,
                                        background: color,
                                        boxShadow: `0 0 8px ${color}`,
                                    }}
                                />
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {name}
                            </span>
                        </div>
                        <div
                            style={{
                                fontSize: 10,
                                color: t.subColor,
                                marginTop: 3,
                                textTransform: upperState ? 'uppercase' : 'none',
                            }}
                        >
                            {stateLabel}
                            {showDetail && details[i] !== undefined ? ` ・ ${details[i]}` : ''}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

DpxStatus.config = {
    key: 'dpx.status',
    name: 'ステータス一覧',
    category: 'status',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        columns: { type: 'number', default: 3 },
        showDetail: { type: 'boolean', default: true },
        upperCaseState: { type: 'boolean', default: true },
        pulse: { type: 'boolean', default: true },
        colors: { type: 'object', default: { mode: 'match', matches: DEFAULT_STATUS_MATCHES, defaultColor: '' } },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '列数', option: 'columns', editor: 'editor.slider', editorProps: { min: 1, max: 6, step: 1 } }],
                [{ label: '補足列を表示', option: 'showDetail', editor: 'editor.checkbox' }],
                [{ label: '状態を大文字で表示', option: 'upperCaseState', editor: 'editor.checkbox' }],
                [{ label: 'ドットを脈動させる', option: 'pulse', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [{ label: '状態の色', option: 'colors', editor: 'editor.colorRules', editorProps: { valueHint: '状態（例: ok）' } }],
            ],
        },
    ],
};

// ── dpx.table ────────────────────────────────────────────────────

export function DpxTable({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    const [hoverRow, setHoverRow] = React.useState(null);
    // ヘッダクリックのソート。null = 元の並び（サーチ結果の順）
    const [sort, setSort] = React.useState(null); // { col: number, dir: 'asc'|'desc' }
    const [query, setQuery] = React.useState('');

    const data = dataSources?.primary?.data;
    const cols = React.useMemo(() => data?.columns ?? [], [data]);
    const fields = React.useMemo(() => (data?.fields ?? []).map((f) => f?.name ?? f), [data]);

    const maxRows = Number(options.maxRows) || 50;
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);
    // 色を適用する列（未指定なら全ての数値列）
    const colorTarget = dosToField(options.colorColumn);
    const colorMode = options.colorMode ?? 'text'; // text | cell | row
    const sortable = options.sortable !== false;

    // ── 行の並び替えと絞り込み ──────────────────────────────
    // ⚠ 列は「縦持ち（columns[c][r]）」なので、行を並べ替えるには
    //   行インデックスの配列を作って順序だけ入れ替える（列配列は触らない）。
    const order = React.useMemo(() => {
        const total = cols[0]?.length ?? 0;
        let idx = Array.from({ length: total }, (_, i) => i);

        const q = String(query).trim().toLowerCase();
        if (q) {
            idx = idx.filter((r) => cols.some((col) => String(col[r] ?? '').toLowerCase().includes(q)));
        }

        if (sort && cols[sort.col]) {
            const col = cols[sort.col];
            const sign = sort.dir === 'desc' ? -1 : 1;
            idx = idx.slice().sort((a, b) => {
                const na = toNum(col[a]);
                const nb = toNum(col[b]);
                // 数値どうしは数値比較、それ以外は文字列比較（数値は常に手前）
                if (na !== null && nb !== null) return (na - nb) * sign;
                if (na !== null) return -1;
                if (nb !== null) return 1;
                return String(col[a] ?? '').localeCompare(String(col[b] ?? ''), 'ja') * sign;
            });
        }
        return idx;
    }, [cols, sort, query]);

    const rowCount = Math.min(order.length, maxRows);

    // 列ごとの数値の最大値と合計（値バーのスケール／合計行に使う）
    // ⚠ 絞り込み後の行だけを対象にする（表示していない行を混ぜない）
    const stats = React.useMemo(
        () =>
            cols.map((col) => {
                const nums = order.slice(0, rowCount).map((r) => toNum(col[r])).filter((v) => v !== null);
                return {
                    // gradient は「その列の最小〜最大」に写像するので min も要る
                    min: nums.length ? Math.min(...nums) : 0,
                    max: nums.length ? Math.max(...nums) : 0,
                    sum: nums.reduce((a, b) => a + b, 0),
                    isNumeric: nums.length > 0 && nums.length >= Math.ceil(rowCount * 0.6),
                };
            }),
        [cols, order, rowCount]
    );

    // フック（useState / useMemo）はすべて return より前に置く。
    // ⚠ ここで early return より後に書くとデータ到着の瞬間に落ちる（§8.1）
    if (cols.length === 0 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません" />;
    }

    const h = typeof height === 'number' ? height : 240;
    const dense = Boolean(options.dense);
    const pad = dense ? '4px 10px' : '7px 10px';
    const decimals = Number.isFinite(Number(options.decimals)) ? Number(options.decimals) : null;
    const showTotals = Boolean(options.showTotals);
    const showFilter = Boolean(options.showFilter);

    // 文字色の自動選択（DOS maxContrast 相当）。セル塗りのときだけ意味がある
    const autoText = Boolean(options.autoTextColor) && colorMode === 'cell';

    // ⚠ **固定ヘッダの地は「不透明な色」でなければならない。**
    //    `background: 'inherit'` と書くと親の <tr>（transparent）を継承するので
    //    **計算値が rgba(0,0,0,0) になり、スクロールした行がヘッダを突き抜けて
    //    文字が重なる**（実機で確認：headerBg=rgba(0,0,0,0) / ヘッダ矩形と交差する td が10個）。
    //    position:sticky は効いているのに「透けている」だけなので、
    //    sticky を疑うと原因に辿り着けない。
    //    パネルの地（質感によっては半透明）とは無関係に、**ここだけは不透明**にする。
    //    ただし**「色を付ける」わけではない**。パネルの地とほぼ同じ色を敷いて、
    //    見た目は「背景なし」のまま、スクロールした行だけを隠す。
    //    ヘッダらしさは**字間・大文字・下罫線**で出す（色に頼らない）。
    // ⚠ 色ルールの色をそのまま地にすると濃すぎるので、パネルの地と混ぜる。
    //    **混ぜた後の色**で文字色を判定しないと、実際の見た目と合わない
    const panelBg = t.colorScheme === 'light' ? { r: 255, g: 255, b: 255 } : { r: 12, g: 20, b: 36 };
    // 固定ヘッダの地＝**パネルの地そのもの**（＝見た目は「背景なし」）。
    // 別の色を持たせると「ヘッダに色が付いている」ように見えるので、ここは必ず panelBg から作る
    const stickyBg = `rgb(${panelBg.r}, ${panelBg.g}, ${panelBg.b})`;
    const mixOnPanel = (hex, ratio) => {
        const s2 = String(hex).replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(s2)) return hex;
        const r = parseInt(s2.slice(0, 2), 16);
        const g = parseInt(s2.slice(2, 4), 16);
        const b = parseInt(s2.slice(4, 6), 16);
        const m = (a, bb) => Math.round(bb + (a - bb) * ratio);
        const h2 = (n) => n.toString(16).padStart(2, '0');
        return `#${h2(m(r, panelBg.r))}${h2(m(g, panelBg.g))}${h2(m(b, panelBg.b))}`;
    };

    // DOS の divideBy / prefix 相当。SPL を書き換えずに見た目だけ整える
    const divisor = Number(options.divideBy);
    const unit = String(options.unit ?? '');
    const prefix = String(options.prefix ?? '');
    // ⚠ **書式は「対象の列」を指定できないと使い物にならない。**
    //    未指定のまま全列に適用すると、CPU まで "0.0 MiB"、ホスト名まで
    //    "srv-web-01" になる（実機で確認して列指定を足した）。
    const formatTarget = dosToField(options.formatColumn);
    const formatApplies = (c) => (formatTarget ? fields[c] === formatTarget : true);
    const fmt = (raw, isNum, c) => {
        if (raw === null || raw === undefined || raw === '') return '';
        const on = formatApplies(c);
        if (!isNum) return on && prefix ? `${prefix}${raw}` : String(raw);
        let n = toNum(raw);
        if (n === null) return String(raw);
        // ⚠ 0 や負数で割らない（Infinity / 符号反転になる）
        if (on && Number.isFinite(divisor) && divisor > 0) n /= divisor;
        const body =
            decimals !== null
                ? n.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
                : options.thousands !== false
                  ? n.toLocaleString('ja-JP')
                  : String(n);
        return on ? `${prefix}${body}${unit}` : body;
    };

    // その列に色ルールを適用するか
    const colorApplies = (c) => {
        if (!colorCfg) return false;
        if (colorTarget) return fields[c] === colorTarget;
        return stats[c]?.isNumeric;
    };

    const toggleSort = (c) => {
        if (!sortable) return;
        setSort((prev) => {
            if (!prev || prev.col !== c) return { col: c, dir: 'asc' };
            if (prev.dir === 'asc') return { col: c, dir: 'desc' };
            return null; // 3回目で解除＝元の並びへ
        });
    };

    return (
        <div style={{ height: h, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {showFilter ? (
                <input
                    className="dpx-input"
                    value={query}
                    placeholder="絞り込み…"
                    onChange={(e) => setQuery(e.target.value)}
                    style={{
                        margin: '0 0 6px',
                        padding: '4px 8px',
                        fontSize: 11,
                        borderRadius: 4,
                        border: '1px solid rgba(140,175,235,0.28)',
                        background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(0,0,0,0.28)',
                        color: t.titleColor,
                        outline: 'none',
                        flex: 'none',
                    }}
                />
            ) : null}
            <div className="dpx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: dense ? 11 : 12 }}>
                    <thead>
                        <tr>
                            {fields.map((f, c) => {
                                const active = sort?.col === c;
                                return (
                                    <th
                                        key={f}
                                        onClick={() => toggleSort(c)}
                                        title={sortable ? 'クリックで並び替え（3回で解除）' : undefined}
                                        style={{
                                            position: 'sticky',
                                            top: 0,
                                            textAlign: stats[c]?.isNumeric ? 'right' : 'left',
                                            padding: pad,
                                            // ── 「カラム名だ」と分かる要素は**色ではなく書体と罫線**で出す ──
                                            //    小さめ・大文字・字間広め・少し太字＋下の罫線。
                                            //    地に色を敷くと表全体が重くなる（ユーザー指摘で色を外した）
                                            fontSize: 10,
                                            fontWeight: 600,
                                            letterSpacing: '0.1em',
                                            textTransform: 'uppercase',
                                            color: active ? t.accent : t.subColor,
                                            // 罫線はアクセントではなく中性色にする（色味を持たせない）。
                                            // 並び替え中の列だけアクセントで示す
                                            borderBottom: active
                                                ? `2px solid ${t.accent}aa`
                                                : `1px solid ${t.colorScheme === 'light' ? 'rgba(20,24,31,0.22)' : 'rgba(150,180,225,0.28)'}`,
                                            // ⚠ 'inherit' にすると透明になり行が透ける（上の stickyBg の注記）。
                                            //    地は**パネルと同色**なので見た目は「背景なし」
                                            background: stickyBg,
                                            cursor: sortable ? 'pointer' : 'default',
                                            userSelect: 'none',
                                            whiteSpace: 'nowrap',
                                            // 重なり順でも行より前に出しておく（地が不透明でも
                                            // 行側の box-shadow が被ることがあるため）
                                            zIndex: 2,
                                        }}
                                    >
                                        {f}
                                        {/* 並び順の矢印。未ソート列は出さない（ヘッダが記号だらけになるため） */}
                                        {active ? (
                                            <span style={{ marginLeft: 4 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
                                        ) : null}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: rowCount }, (_, i) => {
                            const r = order[i];
                            // 行全体を塗るモードでは、色の判定に使う列の値で行の色を決める
                            const rowColor =
                                colorMode === 'row' && colorCfg
                                    ? (() => {
                                          const ci = colorTarget ? fields.indexOf(colorTarget) : cols.findIndex((_, c) => colorApplies(c));
                                          if (ci < 0) return null;
                                          return colorForValue(colorCfg, cols[ci][r], stats[ci]);
                                      })()
                                    : null;
                            return (
                                <tr
                                    key={r}
                                    onMouseEnter={() => setHoverRow(r)}
                                    onMouseLeave={() => setHoverRow(null)}
                                    onClick={(originalEvent) =>
                                        onEventTrigger?.({
                                            type: 'row.click',
                                            originalEvent,
                                            payload: Object.fromEntries([
                                                ['name', fields[0] ?? 'col0'],
                                                ['value', cols[0][r]],
                                                ...fields.map((f, c) => [`row.${f}.value`, cols[c][r]]),
                                            ]),
                                        })
                                    }
                                    style={{
                                        background:
                                            hoverRow === r
                                                ? `${t.accent}1f`
                                                : rowColor
                                                  ? `${rowColor}26`
                                                  : options.striped !== false && i % 2 === 1
                                                    ? 'rgba(128,160,220,0.06)'
                                                    : 'transparent',
                                        cursor: onEventTrigger ? 'pointer' : 'default',
                                        boxShadow: hoverRow === r ? `inset 3px 0 0 ${t.accent}` : 'none',
                                        transition: 'background 0.12s ease',
                                    }}
                                >
                                    {cols.map((col, c) => {
                                        const raw = col[r];
                                        const num = toNum(raw);
                                        const isNum = stats[c]?.isNumeric && num !== null;
                                        const colMax = stats[c]?.max ?? 0;
                                        const showBar = options.valueBars !== false && isNum && colMax > 0;
                                        // 値による色。text=文字色 / cell=セルの地 / row=行（上で処理済み）
                                        const cellColor = colorApplies(c) ? colorForValue(colorCfg, raw, stats[c]) : null;
                                        return (
                                            <td
                                                key={c}
                                                style={{
                                                    padding: pad,
                                                    borderBottom: '1px solid rgba(128,160,220,0.08)',
                                                    position: 'relative',
                                                    textAlign: isNum ? 'right' : 'left',
                                                    fontVariantNumeric: isNum ? 'tabular-nums' : 'normal',
                                                    // 文字色: text モードは値の色、cell モードで
                                                    // 「自動」が ON なら地の色から読みやすい方を選ぶ（DOS maxContrast 相当）
                                                    color:
                                                        cellColor && colorMode === 'text'
                                                            ? cellColor
                                                            : cellColor && colorMode === 'cell' && autoText
                                                              ? pickTextColor(mixOnPanel(cellColor, 0.55)) ?? undefined
                                                              : undefined,
                                                    fontWeight: cellColor && colorMode === 'text' ? 600 : undefined,
                                                    // ⚠ セル塗りを濃くすると値バーと数字が沈む。
                                                    //    薄い地＋左の色帯で「色が付いている」ことを示す
                                                    background:
                                                        cellColor && colorMode === 'cell'
                                                            ? autoText
                                                                ? mixOnPanel(cellColor, 0.55)
                                                                : `${cellColor}1f`
                                                            : undefined,
                                                    boxShadow:
                                                        cellColor && colorMode === 'cell' ? `inset 3px 0 0 ${cellColor}` : undefined,
                                                }}
                                            >
                                                {showBar ? (
                                                    <span
                                                        style={{
                                                            position: 'absolute',
                                                            left: 0,
                                                            top: 3,
                                                            bottom: 3,
                                                            width: `${Math.max((num / colMax) * 100, 1)}%`,
                                                            background: cellColor ? `${cellColor}2b` : `${t.accent}1c`,
                                                            borderRadius: 3,
                                                            pointerEvents: 'none',
                                                        }}
                                                    />
                                                ) : null}
                                                <span style={{ position: 'relative' }}>{fmt(raw, isNum, c)}</span>
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                    {showTotals ? (
                        <tfoot>
                            <tr>
                                {cols.map((col, c) => (
                                    <td
                                        key={c}
                                        style={{
                                            position: 'sticky',
                                            bottom: 0,
                                            zIndex: 2,
                                            padding: pad,
                                            // ヘッダと同じく色味を持たせず、罫線で区切る
                                            borderTop: `1px solid ${t.colorScheme === 'light' ? 'rgba(20,24,31,0.28)' : 'rgba(150,180,225,0.34)'}`,
                                            // ⚠ 半透明（0.94）だと下の行が透けて数字が重なって読めない。
                                            //    実機のスクリーンショットで「合計」に行が重なって発覚
                                            background: stickyBg,
                                            color: t.titleColor,
                                            fontWeight: 700,
                                            textAlign: stats[c]?.isNumeric ? 'right' : 'left',
                                            fontVariantNumeric: 'tabular-nums',
                                            fontSize: dense ? 11 : 12,
                                        }}
                                    >
                                        {c === 0 && !stats[0]?.isNumeric ? '合計' : stats[c]?.isNumeric ? fmt(stats[c].sum, true, c) : ''}
                                    </td>
                                ))}
                            </tr>
                        </tfoot>
                    ) : null}
                </table>
            </div>
            {/* 絞り込みで件数が変わるので、件数を出しておく（何件中何件かが分かる） */}
            {showFilter && query ? (
                <div style={{ flex: 'none', fontSize: 10, color: t.subColor, padding: '4px 2px 0' }}>
                    {order.length} 件 / 全 {cols[0].length} 件
                </div>
            ) : null}
        </div>
    );
}

DpxTable.config = {
    key: 'dpx.table',
    name: 'テーブル',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        maxRows: { type: 'number', default: 50 },
        striped: { type: 'boolean', default: true },
        dense: { type: 'boolean', default: false },
        valueBars: { type: 'boolean', default: true },
        sortable: { type: 'boolean', default: true },
        showFilter: { type: 'boolean', default: false },
        showTotals: { type: 'boolean', default: false },
        thousands: { type: 'boolean', default: true },
        decimals: { type: 'number', default: null },
        colors: { type: 'object', default: null },
        colorColumn: { type: 'string', default: '' },
        colorMode: { type: 'string', default: 'text' },
        autoTextColor: { type: 'boolean', default: false },
        formatColumn: { type: 'string', default: '' },
        divideBy: { type: 'number', default: null },
        unit: { type: 'string', default: '' },
        prefix: { type: 'string', default: '' },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '最大行数', option: 'maxRows', editor: 'editor.number' }],
                [{ label: 'しましま', option: 'striped', editor: 'editor.checkbox' }],
                [{ label: '高密度', option: 'dense', editor: 'editor.checkbox' }],
                [{ label: '数値列に値バー', option: 'valueBars', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '操作',
            layout: [
                [{ label: 'ヘッダで並び替え', option: 'sortable', editor: 'editor.checkbox' }],
                [{ label: '絞り込み欄を出す', option: 'showFilter', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '数値の書式',
            layout: [
                [{ label: '桁区切り', option: 'thousands', editor: 'editor.checkbox' }],
                [{ label: '小数点以下の桁数', option: 'decimals', editor: 'editor.number', editorProps: { min: 0, max: 6 } }],
                [{ label: '書式の対象列（未指定なら全列）', option: 'formatColumn', editor: 'editor.columnSelector' }],
                // DOS の divideBy 相当。SPL を書き換えずに単位を変えられる
                [{ label: '割る数（1024=KiB, 1048576=MiB）', option: 'divideBy', editor: 'editor.number', editorProps: { min: 0 } }],
                [{ label: '単位（値の後ろ）', option: 'unit', editor: 'editor.text' }],
                [{ label: '接頭辞（値の前）', option: 'prefix', editor: 'editor.text' }],
                [{ label: '合計行を出す', option: 'showTotals', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値による色',
            layout: [
                [
                    {
                        label: '対象の列（未指定なら数値列すべて）',
                        option: 'colorColumn',
                        editor: 'editor.columnSelector',
                    },
                ],
                [
                    {
                        label: '塗り方',
                        option: 'colorMode',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'text', label: '文字の色' },
                                { value: 'cell', label: 'セルの背景' },
                                { value: 'row', label: '行の背景' },
                            ],
                        },
                    },
                ],
                // セル塗りのとき、地の色に応じて文字色を白/黒から自動で選ぶ
                [{ label: '文字色を自動で読みやすく', option: 'autoTextColor', editor: 'editor.checkbox' }],
                [{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }],
            ],
        },
    ],
};

// ── dpx.donut ────────────────────────────────────────────────────
// 構成比を見せる円（ドーナツ）。中央に合計を出す。
// ⚠ カスタム viz の donut-graph とは別物。あちらは Studio 向けの作り込み版で、
//    こちらは「サーチを挿せばすぐ出る」ネイティブの素朴版。
//    ネイティブ側に無いと、DPX だけで構成比が描けないため用意する。
export function DpxDonut({ dataSources, options = {}, width, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    const [hover, setHover] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const labels = cols[0];
    const values = cols[1].map(toNum);
    const pairs = labels
        .map((l, i) => ({ label: String(l ?? ''), value: values[i] ?? 0 }))
        .filter((p) => Number.isFinite(p.value) && p.value > 0);
    if (pairs.length === 0) return <EmptyHint loading={loading} message="数値がありません" />;

    const total = pairs.reduce((a, b) => a + b.value, 0);
    const w = typeof width === 'number' ? width : 320;
    const h = typeof height === 'number' ? height : 240;
    const size = Math.max(Math.min(w, h) - 16, 80);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const inner = r * (Number(options.innerRatio) || 0.62);
    const palette = t.palette ?? [];

    // 円弧のパスを作る。⚠ 1件しか無いと start==end で円が消えるので、
    //    その場合はドーナツを丸ごと1色で描く。
    const arc = (a0, a1) => {
        const p = (a) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
        const q = (a) => [cx + Math.sin(a) * inner, cy - Math.cos(a) * inner];
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = p(a0);
        const [x1, y1] = p(a1);
        const [x2, y2] = q(a1);
        const [x3, y3] = q(a0);
        return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
    };

    let acc = 0;
    const slices = pairs.map((p, i) => {
        const a0 = (acc / total) * Math.PI * 2;
        acc += p.value;
        const a1 = (acc / total) * Math.PI * 2;
        const ruled = colorCfg ? colorForValue(colorCfg, p.label) ?? colorForValue(colorCfg, p.value) : null;
        return { ...p, a0, a1, color: ruled || palette[i % palette.length] || t.accent, pct: (p.value / total) * 100 };
    });

    const showLegend = options.showLegend !== false;
    const fmtN = (n) => n.toLocaleString('ja-JP');

    return (
        <div style={{ height: h, display: 'flex', alignItems: 'center', gap: 12, minHeight: 0 }}>
            <svg width={size} height={size} style={{ flex: 'none', overflow: 'visible' }}>
                {slices.map((s, i) => (
                    <path
                        key={i}
                        d={pairs.length === 1 ? arc(0, Math.PI * 1.9999) : arc(s.a0, s.a1)}
                        fill={s.color}
                        opacity={hover === null || hover === i ? 1 : 0.42}
                        stroke={t.colorScheme === 'light' ? '#ffffff' : '#0a1020'}
                        strokeWidth="1.5"
                        style={{ cursor: onEventTrigger ? 'pointer' : 'default', transition: 'opacity 0.12s ease' }}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'slice.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'label',
                                    value: s.label,
                                    [`row.${fields[0] ?? 'label'}.value`]: s.label,
                                    [`row.${fields[1] ?? 'value'}.value`]: s.value,
                                },
                            })
                        }
                    />
                ))}
                {/* 中央：合計、ホバー中はその要素の値 */}
                <text x={cx} y={cy - 4} textAnchor="middle" fontSize={Math.max(size * 0.055, 9)} fill={t.subColor}>
                    {hover === null ? options.centerLabel || '合計' : slices[hover].label}
                </text>
                <text
                    x={cx}
                    y={cy + Math.max(size * 0.085, 14)}
                    textAnchor="middle"
                    fontSize={Math.max(size * 0.115, 14)}
                    fontWeight="700"
                    fill={t.titleColor}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {hover === null ? fmtN(total) : `${slices[hover].pct.toFixed(1)}%`}
                </text>
            </svg>
            {showLegend ? (
                <div className="dpx-scroll" style={{ flex: 1, minWidth: 0, maxHeight: h, overflow: 'auto', fontSize: 11 }}>
                    {slices.map((s, i) => (
                        <div
                            key={i}
                            onMouseEnter={() => setHover(i)}
                            onMouseLeave={() => setHover(null)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '2px 4px',
                                borderRadius: 4,
                                background: hover === i ? `${t.accent}1f` : 'transparent',
                            }}
                        >
                            <span style={{ width: 9, height: 9, flex: 'none', borderRadius: 2, background: s.color }} />
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.titleColor }}>
                                {s.label}
                            </span>
                            <span style={{ color: t.subColor, fontVariantNumeric: 'tabular-nums' }}>
                                {options.legendShows === 'value' ? fmtN(s.value) : `${s.pct.toFixed(1)}%`}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

DpxDonut.config = {
    key: 'dpx.donut',
    name: 'ドーナツ（構成比）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        innerRatio: { type: 'number', default: 0.62 },
        showLegend: { type: 'boolean', default: true },
        legendShows: { type: 'string', default: 'percent' },
        centerLabel: { type: 'string', default: '合計' },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '穴の大きさ', option: 'innerRatio', editor: 'editor.slider', editorProps: { min: 0, max: 0.85, step: 0.01 } }],
                [{ label: '中央の見出し', option: 'centerLabel', editor: 'editor.text' }],
                [{ label: '凡例を出す', option: 'showLegend', editor: 'editor.checkbox' }],
                [
                    {
                        label: '凡例に出す値',
                        option: 'legendShows',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'percent', label: '割合（%）' },
                                { value: 'value', label: '実数' },
                            ],
                        },
                    },
                ],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};

// ── dpx.ranking ──────────────────────────────────────────────────
// 横棒のランキング。上位 N 件を「順位・ラベル・バー・値」で並べる。
// 縦棒（dpx.bar）はラベルが長いと潰れるので、項目名を読ませたいときはこちら。
export function DpxRanking({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    const [hover, setHover] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const topN = Number(options.topN) || 10;
    const rows = cols[0]
        .map((l, i) => ({ label: String(l ?? ''), value: toNum(cols[1][i]) ?? 0 }))
        .filter((r) => Number.isFinite(r.value));
    // 既定は降順。SPL 側で並べ替え済みの順を尊重したいときは「元の順」を選ぶ
    const sorted = options.order === 'none' ? rows : rows.slice().sort((a, b) => (options.order === 'asc' ? a.value - b.value : b.value - a.value));
    const shown = sorted.slice(0, topN);
    if (shown.length === 0) return <EmptyHint loading={loading} message="数値がありません" />;

    const max = Math.max(...shown.map((r) => r.value), 0) || 1;
    const h = typeof height === 'number' ? height : 240;
    const palette = t.palette ?? [];
    const showRank = options.showRank !== false;
    const fmtN = (n) => n.toLocaleString('ja-JP');

    return (
        <div className="dpx-scroll" style={{ height: h, overflow: 'auto' }}>
            {shown.map((r, i) => {
                const ruled = colorCfg ? colorForValue(colorCfg, r.label) ?? colorForValue(colorCfg, r.value) : null;
                const color = ruled || (options.monochrome !== false ? t.accent : palette[i % palette.length] || t.accent);
                return (
                    <div
                        key={`${r.label}-${i}`}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'bar.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'label',
                                    value: r.label,
                                    [`row.${fields[0] ?? 'label'}.value`]: r.label,
                                    [`row.${fields[1] ?? 'value'}.value`]: r.value,
                                },
                            })
                        }
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '4px 6px',
                            borderRadius: 4,
                            background: hover === i ? `${t.accent}14` : 'transparent',
                            cursor: onEventTrigger ? 'pointer' : 'default',
                        }}
                    >
                        {showRank ? (
                            <span
                                style={{
                                    flex: 'none',
                                    width: 20,
                                    textAlign: 'right',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: i < 3 ? t.accent : t.subColor,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                {i + 1}
                            </span>
                        ) : null}
                        <span
                            style={{
                                flex: 'none',
                                width: `${Math.min(Math.max(Number(options.labelWidth) || 34, 10), 60)}%`,
                                fontSize: 11,
                                color: t.titleColor,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                            title={r.label}
                        >
                            {r.label}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, height: 14, background: 'rgba(128,160,220,0.12)', borderRadius: 3, overflow: 'hidden' }}>
                            <span
                                style={{
                                    display: 'block',
                                    height: '100%',
                                    width: `${Math.max((r.value / max) * 100, 1)}%`,
                                    background: `linear-gradient(90deg, ${color}bb, ${color})`,
                                    borderRadius: 3,
                                    transition: 'width 0.3s ease',
                                }}
                            />
                        </span>
                        <span style={{ flex: 'none', fontSize: 11, color: t.titleColor, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
                            {fmtN(r.value)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

DpxRanking.config = {
    key: 'dpx.ranking',
    name: 'ランキング（横棒）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        topN: { type: 'number', default: 10 },
        order: { type: 'string', default: 'desc' },
        showRank: { type: 'boolean', default: true },
        monochrome: { type: 'boolean', default: true },
        labelWidth: { type: 'number', default: 34 },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '上位何件', option: 'topN', editor: 'editor.number', editorProps: { min: 1, max: 100 } }],
                [
                    {
                        label: '並び順',
                        option: 'order',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'desc', label: '大きい順' },
                                { value: 'asc', label: '小さい順' },
                                { value: 'none', label: 'サーチ結果のまま' },
                            ],
                        },
                    },
                ],
                [{ label: '順位を出す', option: 'showRank', editor: 'editor.checkbox' }],
                [{ label: '単色にする', option: 'monochrome', editor: 'editor.checkbox' }],
                [{ label: 'ラベル幅（%）', option: 'labelWidth', editor: 'editor.slider', editorProps: { min: 10, max: 60, step: 1 } }],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};
