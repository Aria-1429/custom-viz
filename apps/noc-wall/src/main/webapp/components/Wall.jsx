import React, { useEffect, useMemo, useState } from 'react';

import { useSearch } from './useSearch';
import { useAutoAdvance } from './useAutoAdvance';
import { C, severityColor, compact } from './theme';
import { Sparkline, RingGauge, Radar, ColumnChart } from './Charts';
import {
    SPL_KPI,
    SPL_HOSTS,
    SPL_SERVICES,
    SPL_TIMELINE,
    SPL_RESOURCES,
    SPL_STREAM,
} from './searches';
import {
    GlobalWallStyle,
    Screen,
    TopBar,
    Brand,
    StatusDot,
    Clock,
    Stage,
    SectionWrap,
    SectionTitle,
    Panel,
    PanelLabel,
    BigNumber,
    Delta,
    Grid,
    BottomBar,
    Pips,
    Pip,
    Controls,
    CtrlButton,
    BarRow,
    BarLabel,
    BarTrack,
    BarFill,
    BarValue,
    LogLine,
    LogTime,
    LogSev,
    LogMsg,
    Center,
} from './Styles';

// 1 セクションの表示時間。壁掛けで読み切れる長さにする。
const DWELL_MS = 9000;
// サーチの再実行間隔。常時表示なので定期的に更新する。
const REFRESH_MS = 60000;

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/** ---------------------------------------------------------------- 概況 */
function SectionOverview({ kpi }) {
    const rows = kpi.rows;

    // 各系列の最新値と、直前値からの変化率を出す
    const series = useMemo(() => {
        const pick = (f) => rows.map((r) => num(r[f]));
        const stat = (f) => {
            const vals = pick(f);
            const last = vals[vals.length - 1] ?? 0;
            const prev = vals[vals.length - 2] ?? last;
            const delta = prev === 0 ? 0 : ((last - prev) / prev) * 100;
            return { vals, last, delta };
        };
        return {
            events: stat('events'),
            alerts: stat('alerts'),
            latency: stat('latency'),
            hosts: stat('hosts'),
        };
    }, [rows]);

    const cards = [
        { key: 'events', label: 'EVENTS / MIN', color: C.info, s: series.events, unit: '' },
        { key: 'alerts', label: 'ACTIVE ALERTS', color: C.crit, s: series.alerts, unit: '' },
        { key: 'latency', label: 'P99 LATENCY', color: C.warn, s: series.latency, unit: 'ms' },
        { key: 'hosts', label: 'HOSTS ONLINE', color: C.ok, s: series.hosts, unit: '' },
    ];

    if (!rows.length) {
        return <Center $blink>AWAITING DATA…</Center>;
    }

    return (
        <>
            <SectionTitle>Overview</SectionTitle>
            <Grid $cols="repeat(4, 1fr)" $gap="18px" style={{ flex: 'none' }}>
                {cards.map((c) => {
                    const up = c.s.delta >= 0;
                    // アラートとレイテンシは「増加＝悪化」なので色の意味を反転する
                    const bad = c.key === 'alerts' || c.key === 'latency' ? up : !up;
                    return (
                        <Panel key={c.key} $pad="16px 18px">
                            <PanelLabel>{c.label}</PanelLabel>
                            <BigNumber $color={c.color} $size="48px">
                                {compact(c.s.last)}
                                {c.unit && (
                                    <span style={{ fontSize: 20, color: C.textDim }}> {c.unit}</span>
                                )}
                            </BigNumber>
                            <Delta $color={bad ? C.crit : C.ok}>
                                {up ? '▲' : '▼'} {Math.abs(c.s.delta).toFixed(1)}% vs prev
                            </Delta>
                            <div style={{ marginTop: 'auto', paddingTop: 10 }}>
                                <Sparkline values={c.s.vals} color={c.color} height={46} />
                            </div>
                        </Panel>
                    );
                })}
            </Grid>

            <Grid $cols="1fr" $gap="18px" $fill style={{ marginTop: 18 }}>
                <Panel>
                    <PanelLabel>EVENT VOLUME — LAST 40 INTERVALS</PanelLabel>
                    {/* 高さをパネルいっぱいに広げる。Sparkline は
                        preserveAspectRatio="none" なので縦に伸ばして問題ない */}
                    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                        <div style={{ flex: 1, minHeight: 0, alignSelf: 'stretch' }}>
                            <Sparkline
                                values={series.events.vals}
                                color={C.accent}
                                height="100%"
                                width={900}
                            />
                        </div>
                    </div>
                </Panel>
            </Grid>
        </>
    );
}

/** ------------------------------------------------------------ 脅威／上位 */
function SectionThreats({ hosts, services }) {
    const rows = hosts.rows;
    const max = Math.max(...rows.map((r) => num(r.count)), 1);

    const radarItems = services.rows.map((r) => ({
        label: r.service,
        value: num(r.score),
    }));

    return (
        <>
            <SectionTitle>Threat Surface</SectionTitle>
            <Grid $cols="1.35fr 1fr" $gap="18px" $fill>
                <Panel>
                    <PanelLabel>TOP HOSTS BY EVENT COUNT</PanelLabel>
                    {rows.length === 0 ? (
                        <Center $blink>AWAITING DATA…</Center>
                    ) : (
                        // 行をパネルの高さいっぱいに均等配置する（余白を残さない）
                        <div
                            style={{
                                flex: 1,
                                minHeight: 0,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'space-evenly',
                            }}
                        >
                            {rows.slice(0, 8).map((r, i) => {
                                const v = num(r.count);
                                const col = severityColor(r.severity);
                                return (
                                    <BarRow key={r.host ?? i} style={{ marginBottom: 0 }}>
                                        <BarLabel $w="120px" style={{ fontSize: 15 }}>
                                            {r.host}
                                        </BarLabel>
                                        <BarTrack style={{ height: 22 }}>
                                            <BarFill
                                                $pct={(v / max) * 100}
                                                $color={col}
                                                $delay={`${i * 0.22}s`}
                                            />
                                        </BarTrack>
                                        <BarValue style={{ fontSize: 15 }}>{compact(v)}</BarValue>
                                    </BarRow>
                                );
                            })}
                        </div>
                    )}
                </Panel>

                <Panel>
                    <PanelLabel>SERVICE HEALTH INDEX</PanelLabel>
                    <div
                        style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: 0,
                        }}
                    >
                        {radarItems.length >= 3 ? (
                            <Radar items={radarItems} responsive />
                        ) : (
                            <Center $blink>AWAITING DATA…</Center>
                        )}
                    </div>
                </Panel>
            </Grid>
        </>
    );
}

/** -------------------------------------------------------------- 稼働状況 */
function SectionCapacity({ resources, timeline }) {
    const res = resources.rows;
    const tl = timeline.rows.map((r) => ({ label: r.label, value: num(r.count) }));

    const colorForPct = (p) => {
        if (p >= 85) return C.crit;
        if (p >= 70) return C.high;
        if (p >= 50) return C.warn;
        return C.ok;
    };

    return (
        <>
            <SectionTitle>Capacity</SectionTitle>
            <Grid $cols="repeat(4, 1fr)" $gap="18px" style={{ flex: 'none' }}>
                {res.length === 0
                    ? null
                    : res.slice(0, 4).map((r) => {
                          const p = num(r.pct);
                          return (
                              <Panel key={r.metric} $pad="14px">
                                  <div
                                      style={{
                                          display: 'flex',
                                          justifyContent: 'center',
                                          alignItems: 'center',
                                          flex: 1,
                                      }}
                                  >
                                      <RingGauge
                                          ratio={p / 100}
                                          value={`${Math.round(p)}%`}
                                          label={String(r.metric).toUpperCase()}
                                          color={colorForPct(p)}
                                          size={210}
                                      />
                                  </div>
                              </Panel>
                          );
                      })}
            </Grid>

            <Grid $cols="1fr" $gap="18px" $fill style={{ marginTop: 18 }}>
                <Panel>
                    <PanelLabel>THROUGHPUT BY INTERVAL</PanelLabel>
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'flex-end' }}>
                        {tl.length ? (
                            <ColumnChart
                                items={tl}
                                height="100%"
                                colorFor={(d, ratio) =>
                                    ratio > 0.86 ? C.crit : ratio > 0.62 ? C.warn : C.info
                                }
                            />
                        ) : (
                            <Center $blink>AWAITING DATA…</Center>
                        )}
                    </div>
                </Panel>
            </Grid>
        </>
    );
}

/** ------------------------------------------------------------ ライブログ */
function SectionStream({ stream, hosts }) {
    const logs = stream.rows;
    const rows = hosts.rows;
    const max = Math.max(...rows.map((r) => num(r.count)), 1);

    return (
        <>
            <SectionTitle>Live Stream</SectionTitle>
            <Grid $cols="1.5fr 1fr" $gap="18px" $fill>
                <Panel>
                    <PanelLabel>EVENT FEED</PanelLabel>
                    <div
                        style={{
                            flex: 1,
                            minHeight: 0,
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-evenly',
                        }}
                    >
                        {logs.length === 0 ? (
                            <Center $blink>AWAITING DATA…</Center>
                        ) : (
                            logs.slice(0, 12).map((r, i) => {
                                const col = severityColor(r.severity);
                                // エポック秒 → ブラウザのタイムゾーンで整形（時計と揃える）
                                const ts = Number(r.epoch);
                                const label = Number.isFinite(ts)
                                    ? new Date(ts * 1000).toLocaleTimeString('en-GB', {
                                          hour12: false,
                                      })
                                    : '--:--:--';
                                return (
                                    <LogLine
                                        // 行が入れ替わってもアニメーションが走るよう内容をキーに含める
                                        key={`${r.epoch}-${i}`}
                                        $color={col}
                                        style={{
                                            animationDelay: `${i * 55}ms`,
                                            marginBottom: 0,
                                            fontSize: 15,
                                            padding: '9px 12px',
                                        }}
                                    >
                                        <LogTime>{label}</LogTime>
                                        <LogSev $color={col}>{r.severity}</LogSev>
                                        <LogMsg>{r.msg}</LogMsg>
                                    </LogLine>
                                );
                            })
                        )}
                    </div>
                </Panel>

                <Panel>
                    <PanelLabel>SEVERITY DISTRIBUTION</PanelLabel>
                    <div
                        style={{
                            flex: 1,
                            minHeight: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-evenly',
                        }}
                    >
                        {rows.slice(0, 8).map((r, i) => {
                            const v = num(r.count);
                            const col = severityColor(r.severity);
                            return (
                                <BarRow key={r.host ?? i} style={{ marginBottom: 0 }}>
                                    <BarLabel $w="96px" style={{ fontSize: 15 }}>
                                        {r.host}
                                    </BarLabel>
                                    <BarTrack style={{ height: 20 }}>
                                        <BarFill
                                            $pct={(v / max) * 100}
                                            $color={col}
                                            $delay={`${i * 0.18}s`}
                                        />
                                    </BarTrack>
                                </BarRow>
                            );
                        })}
                    </div>
                </Panel>
            </Grid>
        </>
    );
}

/** ------------------------------------------------------------------ 本体 */
const Wall = () => {
    const [paused, setPaused] = useState(false);
    const [nonce, setNonce] = useState(0);
    const [now, setNow] = useState(() => new Date());

    // 時計。1 秒ごとに進める。
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(t);
    }, []);

    // 定期的にサーチを回して数字を更新する（常時表示のため）
    useEffect(() => {
        const t = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
        return () => clearInterval(t);
    }, []);

    const opts = { earliest: '-24h', nonce };
    const kpi = useSearch(SPL_KPI, opts);
    const hosts = useSearch(SPL_HOSTS, opts);
    const services = useSearch(SPL_SERVICES, opts);
    const timeline = useSearch(SPL_TIMELINE, opts);
    const resources = useSearch(SPL_RESOURCES, opts);
    const stream = useSearch(SPL_STREAM, opts);

    const sections = useMemo(
        () => [
            { id: 'overview', node: <SectionOverview kpi={kpi} /> },
            { id: 'threats', node: <SectionThreats hosts={hosts} services={services} /> },
            { id: 'capacity', node: <SectionCapacity resources={resources} timeline={timeline} /> },
            { id: 'stream', node: <SectionStream stream={stream} hosts={hosts} /> },
        ],
        [kpi, hosts, services, timeline, resources, stream]
    );

    const { index, progress, next, prev, goTo } = useAutoAdvance(
        sections.length,
        DWELL_MS,
        paused
    );

    // キーボード操作（←→ で送り、Space で一時停止）。壁掛けでも手元で操作できる。
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'ArrowRight') next();
            else if (e.key === 'ArrowLeft') prev();
            else if (e.code === 'Space') {
                e.preventDefault();
                setPaused((p) => !p);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [next, prev]);

    // 全体の状態表示。critical が居れば赤、そうでなければ緑。
    const anyCritical = hosts.rows.some(
        (r) => String(r.severity || '').toLowerCase().startsWith('crit')
    );
    const loadingAny = kpi.loading || hosts.loading;
    const statusColor = loadingAny ? C.info : anyCritical ? C.crit : C.ok;
    const statusText = loadingAny
        ? 'SYNCING'
        : anyCritical
          ? 'CRITICAL ACTIVITY'
          : 'SYSTEM NOMINAL';

    const firstError = [kpi, hosts, services, timeline, resources, stream].find((s) => s.error);

    return (
        <>
            <GlobalWallStyle />
            <Screen>
                <TopBar>
                    <Brand>NOC WALL</Brand>
                    <div style={{ fontSize: 13, color: C.textDim, letterSpacing: '0.12em' }}>
                        <StatusDot $color={statusColor} />
                        {statusText}
                    </div>
                    {firstError && (
                        <div style={{ fontSize: 12, color: C.crit, letterSpacing: '0.08em' }}>
                            SEARCH ERROR: {String(firstError.error).slice(0, 80)}
                        </div>
                    )}
                    <Clock>
                        {now.toLocaleTimeString('en-GB', { hour12: false })}
                        <span style={{ fontSize: 13, color: C.textFaint, marginLeft: 12 }}>
                            {now.toLocaleDateString('en-CA')}
                        </span>
                    </Clock>
                </TopBar>

                <Stage>
                    {sections.map((s, i) => (
                        <SectionWrap key={s.id} $active={i === index}>
                            {s.node}
                        </SectionWrap>
                    ))}
                </Stage>

                <BottomBar>
                    <Pips>
                        {sections.map((s, i) => (
                            <Pip
                                key={s.id}
                                $active={i === index}
                                $progress={i === index ? progress : 0}
                                onClick={() => goTo(i)}
                                aria-label={s.id}
                            />
                        ))}
                    </Pips>
                    <div style={{ fontSize: 12, color: C.textFaint, letterSpacing: '0.16em' }}>
                        {String(index + 1).padStart(2, '0')} / {String(sections.length).padStart(2, '0')}
                        {' · '}
                        {sections[index] ? sections[index].id.toUpperCase() : ''}
                    </div>
                    <Controls>
                        <CtrlButton onClick={prev}>◀ PREV</CtrlButton>
                        <CtrlButton onClick={() => setPaused((p) => !p)}>
                            {paused ? '▶ RESUME' : '❚❚ PAUSE'}
                        </CtrlButton>
                        <CtrlButton onClick={next}>NEXT ▶</CtrlButton>
                    </Controls>
                </BottomBar>
            </Screen>
        </>
    );
};

export default Wall;
