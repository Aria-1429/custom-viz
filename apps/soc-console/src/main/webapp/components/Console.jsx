import React, { useEffect, useMemo, useState } from 'react';

import { useSearch } from './useSearch';
import {
    C,
    severityColor,
    severityRank,
    statusColor,
    statusShort,
    compact,
    agoLabel,
    timeLabel,
} from './theme';
import { StackedTrend, TrendLegend } from './TrendChart';
import {
    SPL_ALERTS,
    SPL_KPI,
    SPL_TREND,
    SPL_TACTICS,
    SPL_ENTITIES,
    buildTimelineSPL,
} from './searches';
import {
    GlobalStyle,
    Screen,
    TopBar,
    Brand,
    StatusDot,
    Clock,
    Body,
    KpiRow,
    Panel,
    PanelLabel,
    KpiValue,
    KpiSub,
    MainRow,
    LeftCol,
    RightCol,
    BottomRow,
    TableScroll,
    HeadRow,
    Row,
    Cell,
    Badge,
    ScoreBar,
    DetailGrid,
    DKey,
    DVal,
    Timeline,
    TlItem,
    TlTime,
    TlText,
    BarRow,
    BarLabel,
    BarTrack,
    BarFill,
    BarValue,
    Center,
    FilterBar,
    Chip,
} from './Styles';

// 一覧の列幅。ヘッダと行で同じ値を使う（ズレると見出しと中身が合わなくなる）。
// ⚠ STATUS は "INVESTIGATING"（13文字）が入る。バッジは折り返さないので
//   列を狭くすると切れる（実機で発生。96px → 118px に拡げた）。
const COLS = '104px 74px 118px 1fr 104px 112px 88px 62px';

const REFRESH_MS = 60000;

const SEVERITIES = [
    { key: 'critical', label: 'crit', color: C.crit },
    { key: 'high', label: 'high', color: C.high },
    { key: 'medium', label: 'med', color: C.warn },
    { key: 'low', label: 'low', color: C.ok },
];

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

const Console = () => {
    const [now, setNow] = useState(() => new Date());
    const [nonce, setNonce] = useState(0);
    const [selectedId, setSelectedId] = useState(null);
    // severity フィルタ。既定は全部 ON。
    const [sevOn, setSevOn] = useState({ critical: true, high: true, medium: true, low: true });
    const [openOnly, setOpenOnly] = useState(false);

    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        const t = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
        return () => clearInterval(t);
    }, []);

    const opts = { earliest: '-24h', nonce };
    const alerts = useSearch(SPL_ALERTS, opts);
    const kpi = useSearch(SPL_KPI, opts);
    const trend = useSearch(SPL_TREND, opts);
    const tactics = useSearch(SPL_TACTICS, opts);
    const entities = useSearch(SPL_ENTITIES, opts);

    // 深刻な順 → 新しい順に並べる。SOC の見る順序に合わせる。
    const sorted = useMemo(() => {
        const rows = [...alerts.rows];
        rows.sort((a, b) => {
            const d = severityRank(b.severity) - severityRank(a.severity);
            if (d !== 0) return d;
            return num(b.time) - num(a.time);
        });
        return rows;
    }, [alerts.rows]);

    const filtered = useMemo(
        () =>
            sorted.filter((r) => {
                const sev = String(r.severity || '').toLowerCase();
                if (!sevOn[sev]) return false;
                if (openOnly && String(r.status || '').toLowerCase() === 'closed') return false;
                return true;
            }),
        [sorted, sevOn, openOnly]
    );

    // 選択が消えたら（フィルタで隠れた等）先頭を選び直す。
    // 「何も選ばれていない」状態を作らないことで、詳細ペインが空にならない。
    const selected = useMemo(
        () => filtered.find((r) => r.id === selectedId) || filtered[0] || null,
        [filtered, selectedId]
    );

    // 選択したアラートの関連イベント。entity が変わったときだけ再検索する。
    const timelineSPL = useMemo(
        () => (selected ? buildTimelineSPL(selected.entity) : ''),
        [selected]
    );
    const timeline = useSearch(timelineSPL, { earliest: '-24h', nonce });

    const k = kpi.rows[0] || {};
    const criticalOpen = num(k.critical_open);

    const tacticRows = tactics.rows;
    const tacticMax = Math.max(...tacticRows.map((r) => num(r.count)), 1);
    const entityRows = entities.rows;
    const entityMax = Math.max(...entityRows.map((r) => num(r.count)), 1);

    const firstError = [alerts, kpi, trend, tactics, entities].find((s) => s.error);
    const anyLoading = alerts.loading || kpi.loading;

    const statusText = anyLoading
        ? 'SYNCING'
        : criticalOpen > 0
          ? `${criticalOpen} CRITICAL OPEN`
          : 'NO CRITICAL OPEN';
    const statusCol = anyLoading ? C.info : criticalOpen > 0 ? C.crit : C.ok;

    const toggleSev = (key) => setSevOn((s) => ({ ...s, [key]: !s[key] }));

    // 上下キーで一覧を移動できるようにする（トリアージは連続操作になるため）
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            if (!filtered.length) return;
            e.preventDefault();
            const idx = filtered.findIndex((r) => r.id === (selected && selected.id));
            const nextIdx =
                e.key === 'ArrowDown'
                    ? Math.min(filtered.length - 1, idx + 1)
                    : Math.max(0, idx - 1);
            const nextRow = filtered[nextIdx];
            if (nextRow) setSelectedId(nextRow.id);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [filtered, selected]);

    const kpiCards = [
        { label: 'NEW', value: k.new_count, color: C.crit, sub: '未着手' },
        { label: 'INVESTIGATING', value: k.investigating, color: C.warn, sub: '調査中' },
        { label: 'CRITICAL OPEN', value: k.critical_open, color: C.crit, sub: '要即応' },
        { label: 'MTTD', value: k.mttd_min, color: C.info, sub: '検知まで(分)' },
        { label: 'MTTR', value: k.mttr_min, color: C.accent, sub: '復旧まで(分)' },
        { label: 'CLOSED TODAY', value: k.closed_today, color: C.ok, sub: '本日クローズ' },
    ];

    return (
        <>
            <GlobalStyle />
            <Screen>
                <TopBar>
                    <Brand>SOC CONSOLE</Brand>
                    <div style={{ fontSize: 12, color: C.textDim, letterSpacing: '0.1em' }}>
                        <StatusDot $color={statusCol} />
                        {statusText}
                    </div>
                    <div style={{ fontSize: 11, color: C.textFaint, letterSpacing: '0.08em' }}>
                        {filtered.length} / {sorted.length} ALERTS
                    </div>
                    {firstError && (
                        <div style={{ fontSize: 11, color: C.crit }}>
                            SEARCH ERROR: {String(firstError.error).slice(0, 70)}
                        </div>
                    )}
                    <Clock>
                        {now.toLocaleTimeString('en-GB', { hour12: false })}
                        <span style={{ fontSize: 11, color: C.textFaint, marginLeft: 10 }}>
                            {now.toLocaleDateString('en-CA')}
                        </span>
                    </Clock>
                </TopBar>

                <Body>
                    <KpiRow>
                        {kpiCards.map((c) => (
                            <Panel key={c.label} $pad="11px 13px">
                                <PanelLabel>{c.label}</PanelLabel>
                                <KpiValue $color={c.color}>
                                    {c.value === undefined ? '—' : compact(c.value)}
                                </KpiValue>
                                <KpiSub>{c.sub}</KpiSub>
                            </Panel>
                        ))}
                    </KpiRow>

                    <MainRow>
                        <LeftCol>
                            {/* ------------------------------------------- アラート一覧 */}
                            <Panel>
                                <PanelLabel>
                                    ALERT QUEUE
                                    <FilterBar>
                                        {SEVERITIES.map((s) => (
                                            <Chip
                                                key={s.key}
                                                $on={sevOn[s.key]}
                                                $color={s.color}
                                                onClick={() => toggleSev(s.key)}
                                            >
                                                {s.label}
                                            </Chip>
                                        ))}
                                        <Chip
                                            $on={openOnly}
                                            $color={C.info}
                                            onClick={() => setOpenOnly((v) => !v)}
                                        >
                                            open only
                                        </Chip>
                                    </FilterBar>
                                </PanelLabel>

                                <HeadRow $cols={COLS}>
                                    <div>ID</div>
                                    <div>SEV</div>
                                    <div>STATUS</div>
                                    <div>RULE</div>
                                    <div>ENTITY</div>
                                    <div>TECHNIQUE</div>
                                    <div>OWNER</div>
                                    <div style={{ textAlign: 'right' }}>SCORE</div>
                                </HeadRow>

                                {alerts.loading && !filtered.length ? (
                                    <Center>LOADING ALERTS…</Center>
                                ) : !filtered.length ? (
                                    <Center>
                                        該当するアラートがありません
                                        <br />
                                        （フィルタを見直してください）
                                    </Center>
                                ) : (
                                    <TableScroll>
                                        {filtered.map((r) => {
                                            const sc = severityColor(r.severity);
                                            const st = statusColor(r.status);
                                            const isSel = selected && selected.id === r.id;
                                            const score = num(r.score);
                                            return (
                                                <Row
                                                    key={r.id}
                                                    $cols={COLS}
                                                    $accent={sc}
                                                    $selected={isSel}
                                                    onClick={() => setSelectedId(r.id)}
                                                >
                                                    <Cell $color={C.textDim}>{r.id}</Cell>
                                                    <Cell>
                                                        <Badge $color={sc}>{r.severity}</Badge>
                                                    </Cell>
                                                    <Cell>
                                                        <Badge $color={st} title={r.status}>
                                                            {statusShort(r.status)}
                                                        </Badge>
                                                    </Cell>
                                                    <Cell title={r.rule}>{r.rule}</Cell>
                                                    <Cell $color={C.info}>{r.entity}</Cell>
                                                    <Cell $color={C.textDim}>
                                                        {r.technique}
                                                    </Cell>
                                                    <Cell $color={C.textDim}>{r.owner}</Cell>
                                                    <Cell $align="right">
                                                        {score}
                                                        <ScoreBar $pct={score} $color={sc} />
                                                    </Cell>
                                                </Row>
                                            );
                                        })}
                                    </TableScroll>
                                )}
                            </Panel>

                            {/* ------------------------------------------- 24h 推移 */}
                            <Panel>
                                <PanelLabel>
                                    ALERT VOLUME — 24H
                                    <TrendLegend />
                                </PanelLabel>
                                {trend.rows.length ? (
                                    <StackedTrend rows={trend.rows} />
                                ) : (
                                    <Center>NO TREND DATA</Center>
                                )}
                            </Panel>
                        </LeftCol>

                        <RightCol>
                            {/* ------------------------------------------- 選択の詳細 */}
                            <Panel>
                                <PanelLabel>
                                    ALERT DETAIL
                                    {selected && (
                                        <span style={{ marginLeft: 'auto', color: C.textFaint }}>
                                            {agoLabel(selected.time)}
                                        </span>
                                    )}
                                </PanelLabel>

                                {!selected ? (
                                    <Center>アラートを選択してください</Center>
                                ) : (
                                    <>
                                        <div
                                            style={{
                                                fontSize: 14,
                                                color: C.text,
                                                marginBottom: 10,
                                                lineHeight: 1.4,
                                            }}
                                        >
                                            {selected.rule}
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                                            <Badge $color={severityColor(selected.severity)}>
                                                {selected.severity}
                                            </Badge>
                                            <Badge $color={statusColor(selected.status)}>
                                                {selected.status}
                                            </Badge>
                                            <Badge $color={C.accent}>
                                                score {num(selected.score)}
                                            </Badge>
                                        </div>
                                        <DetailGrid>
                                            <DKey>ID</DKey>
                                            <DVal $color={C.textDim}>{selected.id}</DVal>
                                            <DKey>Detected</DKey>
                                            <DVal>{timeLabel(selected.time)}</DVal>
                                            <DKey>Entity</DKey>
                                            <DVal $color={C.info}>{selected.entity}</DVal>
                                            <DKey>Source</DKey>
                                            <DVal>{selected.src_ip}</DVal>
                                            <DKey>Dest</DKey>
                                            <DVal>{selected.dest_ip}</DVal>
                                            <DKey>Tactic</DKey>
                                            <DVal $color={C.accent}>{selected.tactic}</DVal>
                                            <DKey>Technique</DKey>
                                            <DVal $color={C.accent}>{selected.technique}</DVal>
                                            <DKey>Owner</DKey>
                                            <DVal $color={C.textDim}>{selected.owner}</DVal>
                                        </DetailGrid>
                                    </>
                                )}
                            </Panel>

                            {/* ------------------------------------------- タイムライン */}
                            <Panel>
                                <PanelLabel>
                                    INVESTIGATION TIMELINE
                                    {selected && (
                                        <span style={{ marginLeft: 'auto', color: C.info }}>
                                            {selected.entity}
                                        </span>
                                    )}
                                </PanelLabel>
                                {!selected ? (
                                    <Center>—</Center>
                                ) : timeline.loading && !timeline.rows.length ? (
                                    <Center>LOADING…</Center>
                                ) : !timeline.rows.length ? (
                                    <Center>関連イベントがありません</Center>
                                ) : (
                                    <Timeline>
                                        {timeline.rows.map((t, i) => {
                                            const stage = String(t.stage || '');
                                            const col =
                                                stage === 'detection'
                                                    ? C.crit
                                                    : stage === 'enrichment'
                                                      ? C.warn
                                                      : stage === 'correlation'
                                                        ? C.accent
                                                        : C.info;
                                            return (
                                                // eslint-disable-next-line react/no-array-index-key
                                                <TlItem key={`${t.time}-${i}`} $color={col}>
                                                    <TlTime>
                                                        {timeLabel(t.time)} · {stage}
                                                    </TlTime>
                                                    <TlText>{t.action}</TlText>
                                                </TlItem>
                                            );
                                        })}
                                    </Timeline>
                                )}
                            </Panel>
                        </RightCol>
                    </MainRow>

                    {/* ------------------------------------------- 下段：戦術 / 資産 */}
                    <BottomRow style={{ flex: 'none', height: 168 }}>
                        <Panel>
                            <PanelLabel>MITRE ATT&CK — TACTICS</PanelLabel>
                            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                                {tacticRows.map((r, i) => {
                                    const v = num(r.count);
                                    return (
                                        <BarRow key={r.tactic ?? i}>
                                            <BarLabel $w="150px" title={r.tactic}>
                                                {r.tactic}
                                            </BarLabel>
                                            <BarTrack>
                                                <BarFill
                                                    $pct={(v / tacticMax) * 100}
                                                    $color={C.accent}
                                                />
                                            </BarTrack>
                                            <BarValue>{v}</BarValue>
                                        </BarRow>
                                    );
                                })}
                            </div>
                        </Panel>

                        <Panel>
                            <PanelLabel>TOP AFFECTED ENTITIES</PanelLabel>
                            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                                {entityRows.map((r, i) => {
                                    const v = num(r.count);
                                    const col = severityColor(r.severity);
                                    return (
                                        <BarRow key={r.entity ?? i}>
                                            <BarLabel $w="118px" title={r.entity}>
                                                {r.entity}
                                            </BarLabel>
                                            <BarTrack>
                                                <BarFill
                                                    $pct={(v / entityMax) * 100}
                                                    $color={col}
                                                />
                                            </BarTrack>
                                            <BarValue>{v}</BarValue>
                                        </BarRow>
                                    );
                                })}
                            </div>
                        </Panel>
                    </BottomRow>
                </Body>
            </Screen>
        </>
    );
};

export default Console;
