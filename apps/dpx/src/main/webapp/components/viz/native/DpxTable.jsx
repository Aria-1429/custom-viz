import React from 'react';

import {
    EmptyHint,
    colorForValue,
    dosToField,
    pickTextColor,
    resolveColorRules,
    toNum,
    useDpxTheme,
} from '..';

// ── dpx.table（表）──────────────────────────────────────────────
//
// データ規約: 全列をそのまま表にする
// ────────────────────────────────────────────────────────────────

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

    /**
     * セル 1 個を表示用の文字列にする。
     *
     * ⚠ **SDK の `fmtNumber` とは別物**（引数も意味も違う）。
     *   分割前は両方 `fmt` という名前で**シャドーイングしていた**ため、
     *   機械置換で取り違えて `e.toFixed is not a function` を出した。
     *   紛らわしい名前にしないこと。
     */
    const formatCell = (raw, isNum, c) => {
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
            {/* ⚠ 表だけは溝を確保する（右端の列にバーが被るため）。
                他のパネルには付けない（常時みぞができて質感に合わない） */}
            <div className="dpx-scroll dpx-scroll-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
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
                                                <span style={{ position: 'relative' }}>{formatCell(raw, isNum, c)}</span>
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
                                        {c === 0 && !stats[0]?.isNumeric ? '合計' : stats[c]?.isNumeric ? formatCell(stats[c].sum, true, c) : ''}
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
