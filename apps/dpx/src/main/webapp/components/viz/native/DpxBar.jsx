import React from 'react';

import {
    BrushOverlay,
    EmptyHint,
    VizTooltip,
    colorForValue,
    fmtNumber,
    niceTicks,
    resolveColorRules,
    seedFor,
    toNum,
    useBrush,
    useContainerSize,
    useDpxTheme,
    usePointer,
    useVizHover,
    useVizKitStyles,
} from '..';

// ── dpx.bar（棒グラフ）──────────────────────────────────────────
//
// データ規約: 1列目 = ラベル、2列目 = 値
// ⚠ 横向き（`layout: 'horizontal'`）でも **dpx-bar-rect** を使う。
//   dpx.ranking と見た目が似るが**別の viz**（過去に取り違えた）。
// ────────────────────────────────────────────────────────────────

export function DpxBar({ dataSources, options = {}, height, loading, onEventTrigger, id }) {
    // ⭐ 画材（Brush Engine）。⚠ フックは early return より前（§8.1）
    const paint = useBrush();
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
                                    {fmtNumber(v, 0)}
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
                                                {fmtNumber(v)}
                                            </span>
                                        ) : null}
                                        <div
                                            className="dpx-bar-rect"
                                            style={{
                                                width: '100%',
                                                height: `${Math.max(ratio * 100, v === null ? 0 : 1.5)}%`,
                                                // ⭐ 画材のときは**この div を透明にして寸法だけ使う**。
                                                //    高さのアニメ・ホバー・クリックは div のまま効く（原則 3）
                                                position: 'relative',
                                                // 細いバーに角丸を付けると形が潰れるので幅で切り替える
                                                borderRadius: paint ? 0 : barW >= 6 ? '4px 4px 1px 1px' : 0,
                                                background: paint
                                                    ? 'none'
                                                    : barW >= 3
                                                        ? `linear-gradient(180deg, ${color}, ${color}77)`
                                                        : color,
                                                // ⚠ 細いバーが大量にあるときに影を全部に付けると
                                                //    塗り面積が増えて重くなる（viz-performance.md §2）。
                                                //    密なときは影を出さない
                                                boxShadow:
                                                    paint || barW < 4
                                                        ? 'none'
                                                        : hovered
                                                          ? `0 0 14px ${color}88, 0 0 3px ${color}`
                                                          : `0 0 8px ${color}33`,
                                                transition: 'height 0.4s ease, box-shadow 0.15s ease',
                                                animation: animate
                                                    ? `dpxGrow 0.6s ease-out ${Math.min(i * 0.05, 0.4)}s both`
                                                    : 'none',
                                            }}
                                        >
                                            {/* ⭐ 画材で塗る（見た目だけ）。当たり判定は親の div */}
                                            {paint ? (
                                                <BrushOverlay
                                                    paint={paint}
                                                    seed={seedFor(id, labels[i], i)}
                                                    color={color}
                                                    opacity={hovered ? 1 : 0.92}
                                                />
                                            ) : null}
                                        </div>
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
                        rows={[{ label: fields[1] ?? '値', value: fmtNumber(values[hoverIdx]) }]}
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
                                            // ⭐ 画材のときは div を透明にして寸法だけ使う（原則 3）
                                            borderRadius: paint ? 0 : '1px 4px 4px 1px',
                                            background: paint
                                                ? 'none'
                                                : `linear-gradient(90deg, ${color}, ${color}77)`,
                                            boxShadow: !paint && hovered ? `0 0 12px ${color}88` : 'none',
                                            transition: 'width 0.4s ease, box-shadow 0.15s ease',
                                        }}
                                    >
                                        {paint ? (
                                            <BrushOverlay
                                                paint={paint}
                                                seed={seedFor(id, label, i)}
                                                color={color}
                                                opacity={hovered ? 1 : 0.92}
                                            />
                                        ) : null}
                                    </div>
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
                                            {fmtNumber(v)}
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
                            {fmtNumber(v, 0)}
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
                    rows={[{ label: fields[1] ?? '値', value: fmtNumber(values[hoverIdx]) }]}
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
