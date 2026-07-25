// ---------------------------------------------------------------------------
// Drilldown Table Probe / ROUND 11 — click 以外のトリガーを検証する
//
// 【ROUND 9 で確定したこと（実機）】
//   - config.json に events / supports 宣言があれば**トークン設定はできる**
//   - ただし実際にトークンを更新していたのは **addDrilldownListener 側**だった。
//     各セルの onClick から呼んでいた triggerDrilldown は効いていなかった
//     （「②のノードを押したときだけ反映される」という実機の挙動が証拠）。
//     payloadCallback を1行目固定にしていたため
//     「どの行を押しても1行目の値」に見えていた。
//
// 【ROUND 10 の変更】
//   セル1つ1つを **addDrilldownListener に登録**する。
//   payloadCallback はそのセル専用（行/列を閉じ込める）なので固定でよい。
//   → デフォルト viz と同じく「セルを押した瞬間にトークンが入る」ことを狙う。
//   triggerDrilldown も併置してあり、**どちらが発火源か**を切り分けられる。
//
// 【確認手順】
//   1. 編集画面「インタラクション」→「トークンを設定」を追加
//   2. 表示モードでセルをクリック（①のスナップショットは押さなくてよい）
//   3. クリックした瞬間に probe_token が変われば成功
// ---------------------------------------------------------------------------

import { VisualizationExtensionProvider, useDataSources, useMode, useOptions, useTheme, useTokens } from '@splunk/dashboard-studio-extension/react';
import { addDrilldownListener, triggerDrilldown } from '@splunk/dashboard-studio-extension/visualization';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

const PROBE_VERSION = 'probe-6.0.0 (ROUND11: click以外のトリガー)';

const cell = { padding: '6px 10px', borderBottom: '1px solid rgba(128,128,128,0.25)', fontSize: 12 };

// rows / columns 両形式に対応（既存 viz と同じ定番パターン）
function normalizeData(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.rows) && data.rows.length > 0) return data.rows;
    if (Array.isArray(data.columns) && data.columns.length > 0) {
        const n = data.columns[0].length;
        return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
    }
    return [];
}

// トークンは { env:{…}, default:{…}, submitted:{…} } の入れ子で届く（ROUND 7 で判明）
function findToken(obj, name, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
    for (const v of Object.values(obj)) {
        const hit = findToken(v, name, depth + 1);
        if (hit !== undefined) return hit;
    }
    return undefined;
}

function Probe({ mode }) {
    const { options } = useOptions();
    const { dataSources } = useDataSources();
    const { mode: dashMode } = useMode();
    const tokensApi = useTokens();
    const tokens = tokensApi?.tokens;

    const [log, setLog] = useState([]);
    const [tokenSnapshot, setTokenSnapshot] = useState(null);
    const [lastSent, setLastSent] = useState(null);
    const [listenerRegistered, setListenerRegistered] = useState('未登録');

    const raw = dataSources?.primary?.data || null;
    const rows = normalizeData(raw);
    const fields = (raw?.fields || []).map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);

    const colors =
        mode === 'dark'
            ? { fg: '#e6e6e6', sub: '#9aa0a6', ok: '#3fb950', ng: '#d29922', head: '#c9d1d9', hover: 'rgba(31,111,235,0.25)' }
            : { fg: '#1a1a1a', sub: '#5f6368', ok: '#1a7f37', ng: '#9a6700', head: '#24292f', hover: 'rgba(9,105,218,0.15)' };

    const push = useCallback((msg) => {
        setLog((prev) => [`${prev.length + 1}. ${msg}`, ...prev].slice(0, 10));
    }, []);

    // 標準 viz（Table.js）と同じ形でイベントを送る。
    // action:'setToken' のような「命令」は送らない。「クリックされた事実」だけを送り、
    // 何をするかはホスト側のインタラクション定義に委ねる。
    const buildPayload = (rowIdx, colIdx) => {
        const row = rows[rowIdx] || [];
        const payload = {};
        fields.forEach((name, i) => {
            payload[`row.${name}.value`] = row[i];
        });
        // クリックされたセル自身の情報（標準 viz も name/value を載せる）
        const clickedField = fields[colIdx] ?? `col${colIdx}`;
        payload.name = clickedField;
        payload.value = row[colIdx];
        return payload;
    };

    // ---------------------------------------------------------------------
    // ROUND 11：クリック以外のトリガー
    //
    // addDrilldownListener は **click しか見ない**（型定義に "listens to 'click' events" とある）。
    // したがってホバー／範囲選択は triggerDrilldown で送るしかない。
    // ただし ROUND 10 で「triggerDrilldown は効かない」ことが分かっているため、
    // **クリック以外が本当に発火できるのかはここで初めて検証する**（未検証）。
    //
    // 念のため両方の経路を用意する:
    //   - hover / range は triggerDrilldown（他に手段が無い）
    //   - click は addDrilldownListener（ROUND 10 で有効と確定済み）
    // ---------------------------------------------------------------------

    const fire = (type, payload, e, label) => {
        setLastSent({ type, payload });
        try {
            triggerDrilldown({ type, originalEvent: e && (e.nativeEvent || e), payload });
            push(`${type} 発火 — ${label}`);
        } catch (err) {
            push(`${type} 例外: ${err && err.message}`);
        }
    };

    // --- ホバー（point.mouseover / point.mouseout） ---
    const hoverTimerRef = useRef(null);
    const onRowEnter = (rowIdx) => () => {
        // 連続ホバーで大量発火しないよう 150ms デバウンス
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
            const payload = buildPayload(rowIdx, Math.max(0, fields.length - 1));
            fire('point.mouseover', payload, null, `${rowIdx + 1}行目にホバー`);
        }, 150);
    };
    const onRowLeave = (rowIdx) => () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        const payload = buildPayload(rowIdx, Math.max(0, fields.length - 1));
        fire('point.mouseout', payload, null, `${rowIdx + 1}行目から離脱`);
    };

    // --- 範囲選択（range.select）：ドラッグで複数行を選ぶ ---
    const [selRange, setSelRange] = useState(null); // {from, to}
    const dragRef = useRef({ active: false, from: null });

    const onRowMouseDown = (rowIdx) => () => {
        dragRef.current = { active: true, from: rowIdx };
        setSelRange({ from: rowIdx, to: rowIdx });
    };
    const onRowMouseMove = (rowIdx) => () => {
        if (!dragRef.current.active) return;
        setSelRange({ from: dragRef.current.from, to: rowIdx });
    };
    const onRowMouseUp = (rowIdx) => () => {
        if (!dragRef.current.active) return;
        dragRef.current.active = false;
        const from = Math.min(dragRef.current.from, rowIdx);
        const to = Math.max(dragRef.current.from, rowIdx);
        setSelRange({ from, to });
        if (from === to) return; // 単なるクリックは range 扱いしない

        // 標準 viz の range.select は earliest/latest を載せる（時系列の範囲選択）
        const timeIdx = fields.findIndex((f) => f === '_time');
        const payload = {
            'row.rangeFrom.value': from + 1,
            'row.rangeTo.value': to + 1,
            name: 'range',
            value: `${from + 1}-${to + 1}`,
        };
        if (timeIdx >= 0) {
            payload.earliest = rows[from]?.[timeIdx];
            payload.latest = rows[to]?.[timeIdx];
        }
        fire('range.select', payload, null, `${from + 1}〜${to + 1}行目を選択`);
    };

    const isSelected = (rowIdx) =>
        selRange && rowIdx >= Math.min(selRange.from, selRange.to) && rowIdx <= Math.max(selRange.from, selRange.to);

    // --- 各セルを addDrilldownListener で登録する（ROUND 10） ---
    //
    // 【ROUND 9 で分かったこと（実機）】
    //   実際にトークンを更新していたのは **addDrilldownListener 側**だった。
    //   各セルの onClick から呼んでいた triggerDrilldown は効いていなかった
    //   （「②のノードを押したときだけ反映される」という実機の挙動がその証拠）。
    //   payloadCallback を1行目固定にしていたため「どの行を押しても1行目の値」に見えていた。
    //
    // 【したがって】セルごとに即トークンを入れたいなら、
    //   **セル1つ1つを addDrilldownListener に登録する**のが正しい。
    //   payloadCallback はそのセル自身の行/列を閉じ込めておけばよい。
    const cellRefs = useRef(new Map());
    useEffect(() => {
        if (rows.length === 0 || fields.length === 0) return undefined;
        let ok = 0;
        let lastErr = null;
        cellRefs.current.forEach((node, key) => {
            if (!node) return;
            const [r, c] = key.split(':').map(Number);
            try {
                addDrilldownListener({
                    node,
                    action: 'cell.click',
                    payloadCallback: () => buildPayload(r, c), // このセル専用（固定でよい）
                });
                ok += 1;
            } catch (err) {
                lastErr = err;
            }
        });
        setListenerRegistered(lastErr ? `一部失敗: ${lastErr.message}` : `${ok} セルを登録`);
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length, fields.join(','), JSON.stringify(rows)]);

    // 「クリック前後でトークンが変わったか」を機械的に判定する
    const snapshotTokens = () => {
        setTokenSnapshot(JSON.stringify(tokens || {}));
        push('トークンのスナップショットを取得（この後セルをクリックする）');
    };
    const tokensChanged = tokenSnapshot !== null && tokenSnapshot !== JSON.stringify(tokens || {});

    const probeTok = findToken(tokens, 'probe_token');
    const tokenKeys = tokens && typeof tokens === 'object' ? Object.keys(tokens) : [];

    // border の shorthand と borderStyle を混ぜると React が警告を出すので個別指定にする
    const btn = {
        padding: '5px 10px',
        marginRight: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: colors.sub,
        background: 'transparent',
        color: colors.fg,
        cursor: 'pointer',
        fontSize: 11,
    };

    return (
        <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: 12, boxSizing: 'border-box', color: colors.fg }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                Drilldown Table Probe <span style={{ color: colors.sub, fontWeight: 400 }}>({PROBE_VERSION})</span>
            </div>
            <div style={{ fontSize: 11, color: colors.sub, marginBottom: 10 }}>
                <b style={{ color: colors.ng }}>表示モードで操作すること。</b>
                現在: <b style={{ color: colors.fg }}>{dashMode || '(不明)'}</b> / {rows.length} 行 × {fields.length} 列
                <br />
                手順：編集画面「インタラクション」→<b style={{ color: colors.fg }}>「トークンを設定」</b>を追加
                → 表示モードで<b style={{ color: colors.fg }}>セルをクリック</b>。
                <br />
                <b style={{ color: colors.fg }}>3つのトリガーを試せる</b>:
                <b>セルをクリック</b>（cell.click / addDrilldownListener 経由・実機確認済み） /
                <b>行にホバー</b>（point.mouseover・mouseout） /
                <b>行を縦にドラッグ</b>（range.select）。
                <br />
                編集画面のインタラクションで<b style={{ color: colors.fg }}>トリガーを選べるか</b>も確認する
                （選択肢に mouseover / range.select が出るか）。
            </div>

            <div style={{ marginBottom: 8 }}>
                <button type="button" style={btn} onClick={snapshotTokens} data-role="btn-snapshot">
                    ① クリック前のトークンを記録
                </button>
                <span style={{ fontSize: 11, color: colors.sub }} data-role="listener-note">
                    ② 各セルを addDrilldownListener に登録済み（{listenerRegistered}）
                </span>
            </div>

            <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 10 }} data-role="probe-table">
                <thead>
                    <tr>
                        {fields.map((f) => (
                            <th key={f} style={{ ...cell, textAlign: 'left', color: colors.head, borderBottom: `1px solid ${colors.sub}` }}>
                                {f}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.slice(0, 8).map((row, ri) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <tr
                            key={ri}
                            data-role="probe-row"
                            data-row={ri}
                            onMouseEnter={onRowEnter(ri)}
                            onMouseLeave={onRowLeave(ri)}
                            onMouseDown={onRowMouseDown(ri)}
                            onMouseMove={onRowMouseMove(ri)}
                            onMouseUp={onRowMouseUp(ri)}
                            style={{ background: isSelected(ri) ? colors.hover : 'transparent' }}
                        >
                            {fields.map((f, ci) => (
                                <td
                                    key={f}
                                    ref={(el) => {
                                        // 各セルを addDrilldownListener に登録するため ref を集める
                                        // （click は addDrilldownListener でしか発火しない。ROUND 10 で確定）
                                        if (el) cellRefs.current.set(`${ri}:${ci}`, el);
                                        else cellRefs.current.delete(`${ri}:${ci}`);
                                    }}
                                    data-role="probe-cell"
                                    data-row={ri}
                                    data-col={ci}
                                    style={{ ...cell, cursor: 'pointer', userSelect: 'none' }}
                                >
                                    {String(row[ci] ?? '')}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>

            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <tbody>
                    <tr>
                        <td style={{ ...cell, color: colors.head, width: 220 }}>クリック後にトークンが変化したか</td>
                        <td style={{ ...cell, color: tokensChanged ? colors.ok : colors.ng }}>
                            {tokenSnapshot === null
                                ? '· まず①でスナップショットを取る'
                                : tokensChanged
                                  ? '✓ 変化した（＝ホストがトークンを更新した）'
                                  : '· 変化なし'}
                        </td>
                    </tr>
                    <tr>
                        <td style={{ ...cell, color: colors.head }}>最後に送った値</td>
                        <td style={{ ...cell, fontFamily: 'monospace' }} data-role="last-sent">
                            {lastSent
                                ? `${lastSent.type} → ${JSON.stringify(lastSent.payload).slice(0, 120)}`
                                : '· まだ発火していない'}
                        </td>
                    </tr>
                    <tr>
                        <td style={{ ...cell, color: colors.head }}>probe_token</td>
                        <td style={{ ...cell, color: probeTok !== undefined ? colors.ok : colors.ng, fontFamily: 'monospace' }}>
                            {probeTok !== undefined ? `✓ ${JSON.stringify(probeTok)}` : '· 未設定'}
                        </td>
                    </tr>
                    <tr>
                        <td style={{ ...cell, color: colors.head }}>② リスナー登録</td>
                        <td style={{ ...cell, color: listenerRegistered.startsWith('登録成功') ? colors.ok : colors.ng }}>
                            {listenerRegistered}
                        </td>
                    </tr>
                    <tr>
                        <td style={{ ...cell, color: colors.head }}>トークン ({tokenKeys.length})</td>
                        <td style={{ ...cell, fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all' }}>
                            {JSON.stringify(tokens) || '{}'}
                        </td>
                    </tr>
                    <tr>
                        <td style={{ ...cell, color: colors.head }}>options</td>
                        <td style={{ ...cell, fontFamily: 'monospace', fontSize: 10 }}>{JSON.stringify(options) || '{}'}</td>
                    </tr>
                </tbody>
            </table>

            <div style={{ marginTop: 10, fontSize: 11 }}>
                <b style={{ color: colors.head }}>発火ログ</b>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0', color: colors.sub, maxHeight: 140, overflow: 'auto' }}>
                    {log.length ? log.join('\n') : '(まだ発火していない)'}
                </pre>
            </div>
        </div>
    );
}

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light';
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <Probe mode={mode} />
        </SplunkThemeProvider>
    );
}

// ---- マウントゲート（ナレッジ §2「ルート構成」に準拠） -----------------------
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
    } catch (e) {
        return false;
    }
}

function mountApp() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(
        <VisualizationExtensionProvider>
            <App />
        </VisualizationExtensionProvider>
    );
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
