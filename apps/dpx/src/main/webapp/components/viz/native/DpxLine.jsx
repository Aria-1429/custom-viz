import React from 'react';

import {
    BrushStrokes,
    EmptyHint,
    VizTooltip,
    axisTimes,
    fmtNumber,
    formatAxisLabels,
    formatSpan,
    niceScale,
    rangeFromIndices,
    resolveColorRules,
    seedFor,
    toNum,
    useBrush,
    useContainerSize,
    useDpxTheme,
    usePointer,
    useVizKitStyles,
} from '..';

// ── dpx.line（折れ線）────────────────────────────────────────────
//
// インタラクション:
//   - マウス追従のクロスヘア＋最近傍点のマーカー、値ツールチップ
//   - 凡例または線のホバーで **その系列にフォーカス**（他系列を減光・細く）
//   - 系列クリックで固定（ピン）。もう一度で解除
//   - 初回描画は stroke-dashoffset で「引かれていく」アニメ
//     （⚠ ジオメトリを動かさない＝再描画にならない）
//
// データ規約: 1列目 = X（ラベル/時刻）、2列目以降 = 数値系列
// ────────────────────────────────────────────────────────────────

/** 系列（またはラベル）の色を決める。
 *  cfg は colorRules の設定（一致モードなら名前で、範囲モードなら値で判定）。
 *  当たらなければテーマのパレットを順に使う。 */
function seriesColor(cfg, t, index, name) {
    const hit = cfg ? colorForValue(cfg, name) : null;
    return hit || t.palette[index % t.palette.length];
}

export function DpxLine({ dataSources, options = {}, height, loading, onEventTrigger, brushTarget, mode, id }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const [ref, width] = useContainerSize();
    const [pt, pointerHandlers] = usePointer();
    // ⭐ 画材（Brush Engine）。⚠ **既存の `brush` は時間ブラシの state なので別名**。
    //    flat では null が返り、下の描画は**従来の <path> 経路にそのまま落ちる**（原則 4）。
    //    ⚠ フックなので early return より前に置く（§8.1）
    const paint = useBrush();
    const [hoverSeries, setHoverSeries] = React.useState(null);
    const [pinned, setPinned] = React.useState(null);
    // ⚠ **フックは必ず early return より前に置く**（§8.1）。
    //    データ到着で「なし→あり」に変わった瞬間にフック数が変わると画面が白紙になる。
    //    ブラシの選択状態も例外ではない。
    const [brush, setBrush] = React.useState(null); // {from, to} … X インデックス
    // 「たった今ブラシで確定した」フラグ。直後に来る click（系列の固定）を捨てる。
    // state ではなく ref を使う（再描画を挟まずに同じイベントループで読むため）。
    const justBrushedRef = React.useRef(false);
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
    /**
     * ⭐ **Brush 用の生座標**（Visual Path の材料）。
     *
     * ⚠ `pathFor` と**同じ計算**から作ること。別々に持つと
     *   「線の形」と「当たり判定」がずれる（原則 3）。
     */
    const pointsFor = (vals, right = false) => {
        const out = [];
        vals.forEach((v, i) => {
            if (v !== null) out.push([px(i), pyOn(v, right)]);
        });
        return out;
    };

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

    // ── 時間ブラシ（★Studio では原理的に不可能）─────────────────────
    // 横にドラッグして選んだ区間を、ダッシュボード全体の時間範囲へ流す。
    //
    // 出す条件を厳しくしている。**ドラッグできるのに何も起きない**のが
    // 一番たちの悪い UI なので、確実に効く場合だけカーソルと選択帯を出す:
    //   (1) X 軸が時刻として読める（ホスト名の軸では時間範囲を作れない）
    //   (2) 書き込み先の時間範囲入力がある（brushTarget）
    //   (3) 表示モード（編集中はパネルの移動・選択が優先。掴めなくなる）
    const times = options.timeBrush === false ? null : axisTimes(xLabels);
    const brushable = times != null && Boolean(brushTarget) && mode !== 'edit';

    // ドラッグ中の見た目。確定は onPointerUp（クリックとの取り違えを防ぐため、
    // **1バケット以上動いたときだけ**範囲として扱う）
    const idxAt = (clientX, rect) => {
        const x = clientX - rect.left;
        return Math.max(
            0,
            Math.min(
                xLabels.length - 1,
                Math.round(((x - padL) / Math.max(plotW, 1)) * (xLabels.length - 1))
            )
        );
    };

    const brushHandlers = brushable
        ? {
              onPointerDown: (e) => {
                  // 左ボタンのみ。右クリックはパネルのコンテキストメニュー用
                  if (e.button !== 0) return;
                  // ⚠ 既定動作（文字の範囲選択・画像のドラッグ）を止める。
                  //   これが無いと横ドラッグが軸ラベルの選択になり、
                  //   ラベルが青く反転する（実機で発生）
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const i = idxAt(e.clientX, rect);
                  setBrush({ from: i, to: i });
                  // ⚠ ドラッグ開始時に系列のフォーカスを解除する。
                  //   ブラシは線の上を通るので、掴んだ瞬間に「その系列に固定」が
                  //   効いてしまい、**絞り込んだ後も他系列が減光したまま**になる
                  //   （実機のスクリーンショットで発覚）。範囲を選ぶ操作と
                  //   系列を選ぶ操作を混ぜない。
                  setHoverSeries(null);
                  // ⚠ ポインタを捕捉する。捕捉しないとパネルの外へ出た瞬間に
                  //    pointermove が来なくなり、**選択帯が途中で固まる**
                  e.currentTarget.setPointerCapture?.(e.pointerId);
              },
              onPointerMove: (e) => {
                  if (!brush) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setBrush((b) => (b ? { ...b, to: idxAt(e.clientX, rect) } : b));
              },
              onPointerUp: (e) => {
                  e.currentTarget.releasePointerCapture?.(e.pointerId);
                  // 掴む前に始まっていた選択が残ることがあるので、確定時に消す
                  window.getSelection?.()?.removeAllRanges?.();
                  const b = brush;
                  setBrush(null);
                  if (!b) return;
                  // 1バケットも動いていなければ「ただのクリック」。
                  // ここで範囲にすると、系列を固定しようとしただけで
                  // 期間が1バケットに絞られる事故になる
                  if (b.from === b.to) return;
                  // この後に来る click（系列の固定）を1回だけ捨てる
                  justBrushedRef.current = true;
                  setTimeout(() => {
                      justBrushedRef.current = false;
                  }, 0);
                  const range = rangeFromIndices(times, b.from, b.to);
                  if (range) {
                      onEventTrigger?.({
                          type: 'time.brush',
                          originalEvent: e,
                          payload: { earliest: range.earliest, latest: range.latest },
                      });
                  }
              },
              onPointerCancel: () => setBrush(null),
          }
        : null;

    // 選択帯の描画位置（ドラッグ中のみ）
    const brushLo = brush ? Math.min(brush.from, brush.to) : null;
    const brushHi = brush ? Math.max(brush.from, brush.to) : null;
    const brushRange = brush && brushLo !== brushHi ? rangeFromIndices(times, brushLo, brushHi) : null;

    return (
        <div
            ref={ref}
            style={{
                height: h,
                position: 'relative',
                touchAction: brushable ? 'none' : undefined,
                // ⚠ **ブラシ中に軸ラベルの文字が選択されるのを防ぐ**（実機で発生）。
                //   横ドラッグはブラウザから見れば「文字の範囲選択」なので、
                //   放っておくと軸ラベルが青く反転してコピー状態になる。
                //   ブラシを出すパネルでは選択自体を殺す（表ではないので
                //   文字を選ぶ用途が無い）。`preventDefault` だけでは
                //   既に始まった選択が残るため、CSS と両方で止める。
                userSelect: brushable ? 'none' : undefined,
                WebkitUserSelect: brushable ? 'none' : undefined,
            }}
            {...pointerHandlers}
            {...brushHandlers}
        >
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
                                  {fmtNumber(v)}
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
                              {fmtNumber(v)}
                          </text>
                      ))
                    : null}

                {/* X 軸ラベル。時刻は `15:00`、日付が変わる位置だけ下段に `8/12` を出す
                    （ISO を切り詰めると全部 `2026-08-1…` になる。実機で発生） */}
                {axisLabels.map((lab, i) => {
                    if (i % xTickEvery !== 0) return null;
                    // ⚠ **両端のラベルは中央揃えにしない。**
                    //   `textAnchor="middle"` のままだと、右端のラベル（`08:01` 等）は
                    //   半分が padR（14px）を越えてはみ出し、**見切れる**（実機で発生）。
                    //   端だけ内側へ寄せる（右端＝右揃え／左端＝左揃え）。
                    //   padR を広げる手もあるが、それだとプロット領域が常に狭くなるうえ、
                    //   ラベルの文字数（`08:01` と `2026-08-13`）で必要量が変わる
                    const x = px(i);
                    const nearRight = x > padL + plotW - 24;
                    const nearLeft = x < padL + 24;
                    const anchor = nearRight ? 'end' : nearLeft ? 'start' : 'middle';
                    return (
                        <g key={i}>
                            <text
                                x={x}
                                y={padT + plotH + 14}
                                textAnchor={anchor}
                                fontSize={10}
                                fill={t.subColor}
                            >
                                {lab.main}
                            </text>
                            {lab.sub ? (
                                <text
                                    x={x}
                                    y={padT + plotH + 24}
                                    textAnchor={anchor}
                                    fontSize={9}
                                    fill={t.subColor}
                                    opacity={0.8}
                                >
                                    {lab.sub}
                                </text>
                            ) : null}
                        </g>
                    );
                })}

                {/* 時間ブラシの選択帯。ドラッグ中だけ出る。
                    ⚠ 塗りは**選択部分だけ**（面積が小さい）。「選択外を暗くする」
                      表現にすると常にパネル全面の半透明塗りになり、
                      面積比例の raster コストが乗る（§7.1 の性能方針）。 */}
                {brush && brushLo !== brushHi ? (
                    <g pointerEvents="none">
                        <rect
                            x={px(brushLo)}
                            y={padT}
                            width={Math.max(px(brushHi) - px(brushLo), 1)}
                            height={plotH}
                            fill={t.accent}
                            fillOpacity={0.16}
                        />
                        {/* 両端の掴み線。どこからどこまで選んだかを明示する */}
                        <line x1={px(brushLo)} x2={px(brushLo)} y1={padT} y2={padT + plotH} stroke={t.accent} strokeWidth={1.5} />
                        <line x1={px(brushHi)} x2={px(brushHi)} y1={padT} y2={padT + plotH} stroke={t.accent} strokeWidth={1.5} />
                    </g>
                ) : null}

                {/* クロスヘア（縦線）。ジオメトリの再ラスタライズを避けるため線1本のみ */}
                {showCrosshair && !brush ? (
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
                    // Brush 用の生座標（flat では使われない）
                    const pts = paint ? pointsFor(s.values, right) : null;
                    const isFocused = focused === s.name;
                    const dim = focused != null && !isFocused;
                    const firstIdx = s.values.findIndex((v) => v !== null);
                    const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
                    const w = isFocused ? lineWidth + 1.2 : lineWidth;
                    return (
                        <g
                            key={s.name}
                            style={{ opacity: dim ? 0.18 : 1, transition: 'opacity 0.18s ease' }}
                            onMouseEnter={() => (brush ? null : setHoverSeries(s.name))}
                            onMouseLeave={() => setHoverSeries(null)}
                            // ⚠ ブラシで範囲を選んだ直後の click は無視する。
                            //   ドラッグの終点がたまたま線の上だと「系列を固定」が
                            //   同時に起きて、絞り込みと固定が一度に発動してしまう。
                            onClick={() => {
                                if (justBrushedRef.current) return;
                                setPinned((prev) => (prev === s.name ? null : s.name));
                            }}
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
                            {/* ⭐ 画材が選ばれていれば、その質感で線を描く。
                                ⚠ **当たり判定は元の geometry のまま**（この g は
                                   pointerEvents:'none'）。ホバー・時間ブラシは影響を受けない */}
                            {paint ? (
                                <BrushStrokes
                                    paths={paint.line(
                                        pts,
                                        // ⚠ **seed に「値」を入れない**（再サーチのたびに形が変わる）。
                                        //    パネル・系列・点数だけで決める
                                        seedFor(id, s.name, pts.length)
                                    )}
                                    color={color}
                                    opacity={dim ? 0.35 : 1}
                                />
                            ) : (
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
                            )}
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

            {/* ドラッグ中の範囲表示。ツールチップと同時に出すと重なって読めないので、
                ブラシ中はこちらだけを出す（上の crosshair も止めてある）。
                ⚠ 期間（3.5時間 など）を必ず添える。開始と終了の時刻だけだと
                  「どれくらいの幅を選んだか」が読み取りづらい。 */}
            {brushRange ? (
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        top: 6,
                        pointerEvents: 'none',
                        background: t.colorScheme === 'light' ? 'rgba(255,255,255,0.97)' : 'rgba(10,16,30,0.94)',
                        border: `1px solid ${t.accent}88`,
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 11,
                        color: t.titleColor,
                        whiteSpace: 'nowrap',
                        zIndex: 21,
                    }}
                >
                    <span style={{ color: t.accent, fontWeight: 600 }}>
                        {formatSpan(brushRange.from, brushRange.to)}
                    </span>
                    <span style={{ color: t.subColor, marginLeft: 8 }}>
                        {brushRange.earliest.replace('T', ' ')} → {brushRange.latest.replace('T', ' ')}
                    </span>
                </div>
            ) : null}

            {showCrosshair && !brush ? (
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
                            value: fmtNumber(s.values[hoverIdx]),
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
        timeBrush: { type: 'boolean', default: true },
        brushToken: { type: 'string', default: '' },
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
            // 横ドラッグで選んだ区間をダッシュボード全体の時間範囲にする。
            // 時間範囲入力が無いダッシュボードでは自動的に無効になる（viz 側で判定）。
            label: '時間ブラシ（ドラッグで期間を絞る）',
            layout: [
                [{ label: 'ドラッグで期間を絞る', option: 'timeBrush', editor: 'editor.checkbox' }],
                [
                    {
                        label: '書き込む時間範囲入力（空で先頭）',
                        option: 'brushToken',
                        editor: 'editor.text',
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
