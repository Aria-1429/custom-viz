import React, { useMemo, useState } from 'react';
import Button from '@splunk/react-ui/Button';
import TextArea from '@splunk/react-ui/TextArea';
import Select from '@splunk/react-ui/Select';
import Table from '@splunk/react-ui/Table';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import Heading from '@splunk/react-ui/Heading';
import ControlGroup from '@splunk/react-ui/ControlGroup';

import { useSearch } from './useSearch';
import {
    StyledContainer,
    StyledHeader,
    StyledSubtle,
    StyledCardRow,
    StyledCard,
    StyledCardLabel,
    StyledCardValue,
    StyledSearchBar,
    StyledBarRow,
    StyledBarLabel,
    StyledBarTrack,
    StyledBarFill,
    StyledBarValue,
} from './Styles';

// 既定の SPL。実データが無い環境でも必ず絵が出るよう makeresults で自己完結させてある。
// 画面上で自由に書き換えられる（＝ページ側が能動的にサーチを組み立てられる実証）。
const DEFAULT_SPL = `| makeresults count=1
| eval src="10.0.0.1 web-01,10.0.0.2 db-02,10.0.0.3 api-03,10.0.0.4 cache-04,10.0.0.5 lb-05,10.0.0.6 worker-06"
| makemv delim="," src
| mvexpand src
| rex field=src "(?<ip>\\S+)\\s(?<host>\\S+)"
| eval count = 20 + (random() % 180)
| eval severity = case(count > 150, "critical", count > 100, "high", count > 60, "medium", true(), "low")
| table host ip severity count
| sort - count`;

const SEVERITY_COLORS = {
    critical: '#D41F1F',
    high: '#F58220',
    medium: '#F8BE34',
    low: '#5CC05C',
};

const TIME_PRESETS = [
    { label: '直近 15 分', value: '-15m' },
    { label: '直近 1 時間', value: '-1h' },
    { label: '直近 24 時間', value: '-24h' },
    { label: '直近 7 日', value: '-7d' },
];

/** 行の中から数値として使える列を選ぶ（count が無いデータでも動くように）。 */
function pickNumericField(rows) {
    if (!rows.length) return null;
    const candidates = ['count', 'total', 'value', 'sum', 'c'];
    const keys = Object.keys(rows[0]).filter((k) => !k.startsWith('_'));
    const named = candidates.find((c) => keys.includes(c));
    if (named) return named;
    // 名前で当たらなければ、全行が数値として読める最初の列を使う
    return (
        keys.find((k) => rows.every((r) => r[k] !== '' && Number.isFinite(Number(r[k])))) || null
    );
}

/** 行のラベルに使う列（数値列以外の最初の列）。 */
function pickLabelField(rows, numericField) {
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]).filter((k) => !k.startsWith('_'));
    return keys.find((k) => k !== numericField) || keys[0] || null;
}

const Overview = () => {
    // 画面で編集中の SPL と、実際に実行した SPL を分ける。
    // 「実行」を押すまでサーチが走らないようにするため。
    const [draftSpl, setDraftSpl] = useState(DEFAULT_SPL);
    const [runningSpl, setRunningSpl] = useState(DEFAULT_SPL);
    const [earliest, setEarliest] = useState('-24h');
    const [nonce, setNonce] = useState(0);

    const { rows, loading, error } = useSearch(runningSpl, { earliest, nonce });

    const numericField = useMemo(() => pickNumericField(rows), [rows]);
    const labelField = useMemo(() => pickLabelField(rows, numericField), [rows, numericField]);

    // KPI: 件数・合計・最大・severity 別内訳
    const stats = useMemo(() => {
        if (!rows.length || !numericField) {
            return { total: 0, max: 0, bySeverity: {} };
        }
        let total = 0;
        let max = 0;
        const bySeverity = {};
        rows.forEach((r) => {
            const n = Number(r[numericField]);
            if (Number.isFinite(n)) {
                total += n;
                if (n > max) max = n;
            }
            const sev = String(r.severity || '').toLowerCase();
            if (sev) bySeverity[sev] = (bySeverity[sev] || 0) + 1;
        });
        return { total, max, bySeverity };
    }, [rows, numericField]);

    const runSearch = () => {
        if (draftSpl === runningSpl) {
            // 同じ SPL なら nonce を進めて明示的に再実行する
            setNonce((n) => n + 1);
        } else {
            setRunningSpl(draftSpl);
        }
    };

    const columns = rows.length ? Object.keys(rows[0]).filter((k) => !k.startsWith('_')) : [];

    return (
        <StyledContainer>
            <StyledHeader>
                <div>
                    <Heading level={1}>Ops Console</Heading>
                    <StyledSubtle>
                        Splunk 上で動く独立 React アプリ。ダッシュボードのパネルではなく 1 枚のページで、
                        SPL の実行から描画までをこのページ自身が行っている。
                    </StyledSubtle>
                </div>
            </StyledHeader>

            <ControlGroup
                label="SPL"
                labelPosition="top"
                help="このページが splunkd に直接投げるサーチ。書き換えて「実行」を押すと結果が変わる。"
                controlsLayout="fill"
                style={{ width: '100%' }}
            >
                <StyledSearchBar>
                    <TextArea
                        value={draftSpl}
                        onChange={(e, { value }) => setDraftSpl(value)}
                        rowsMin={10}
                        style={{ flex: '1 1 auto', minWidth: 0 }}
                    />
                    <div>
                        <Select
                            value={earliest}
                            onChange={(e, { value }) => setEarliest(value)}
                            style={{ marginBottom: 8, width: 150 }}
                        >
                            {TIME_PRESETS.map((t) => (
                                <Select.Option key={t.value} label={t.label} value={t.value} />
                            ))}
                        </Select>
                        <Button
                            label={loading ? '実行中…' : '実行'}
                            appearance="primary"
                            disabled={loading}
                            onClick={runSearch}
                            style={{ width: 150 }}
                        />
                    </div>
                </StyledSearchBar>
            </ControlGroup>

            {error && (
                <Message appearance="fill" type="error">
                    {error}
                </Message>
            )}

            {loading && !rows.length && (
                <div style={{ padding: 24, textAlign: 'center' }}>
                    <WaitSpinner size="medium" /> サーチを実行しています…
                </div>
            )}

            {!loading && !error && !rows.length && (
                <Message appearance="fill" type="info">
                    結果が 0 件です。SPL または時間範囲を見直してください。
                </Message>
            )}

            {rows.length > 0 && (
                <>
                    <StyledCardRow>
                        <StyledCard>
                            <StyledCardLabel>行数</StyledCardLabel>
                            <StyledCardValue>{rows.length.toLocaleString()}</StyledCardValue>
                        </StyledCard>
                        {numericField && (
                            <>
                                <StyledCard>
                                    <StyledCardLabel>{numericField} 合計</StyledCardLabel>
                                    <StyledCardValue>
                                        {stats.total.toLocaleString()}
                                    </StyledCardValue>
                                </StyledCard>
                                <StyledCard>
                                    <StyledCardLabel>{numericField} 最大</StyledCardLabel>
                                    <StyledCardValue>{stats.max.toLocaleString()}</StyledCardValue>
                                </StyledCard>
                            </>
                        )}
                        {Object.keys(stats.bySeverity).length > 0 &&
                            Object.keys(SEVERITY_COLORS)
                                .filter((sev) => stats.bySeverity[sev])
                                .map((sev) => (
                                    <StyledCard key={sev}>
                                        <StyledCardLabel>{sev}</StyledCardLabel>
                                        <StyledCardValue $color={SEVERITY_COLORS[sev]}>
                                            {stats.bySeverity[sev]}
                                        </StyledCardValue>
                                    </StyledCard>
                                ))}
                    </StyledCardRow>

                    {numericField && labelField && (
                        <div style={{ marginBottom: 24 }}>
                            <Heading level={3}>
                                {labelField} 別 {numericField}
                            </Heading>
                            {rows.slice(0, 15).map((r, i) => {
                                const n = Number(r[numericField]) || 0;
                                const pct = stats.max > 0 ? (n / stats.max) * 100 : 0;
                                const sev = String(r.severity || '').toLowerCase();
                                return (
                                    <StyledBarRow key={`${r[labelField]}-${i}`}>
                                        <StyledBarLabel title={String(r[labelField])}>
                                            {r[labelField]}
                                        </StyledBarLabel>
                                        <StyledBarTrack>
                                            <StyledBarFill
                                                $pct={pct}
                                                $color={SEVERITY_COLORS[sev] || '#7B56DB'}
                                            />
                                        </StyledBarTrack>
                                        <StyledBarValue>{n.toLocaleString()}</StyledBarValue>
                                    </StyledBarRow>
                                );
                            })}
                        </div>
                    )}

                    <Heading level={3}>結果</Heading>
                    <Table stripeRows>
                        <Table.Head>
                            {columns.map((c) => (
                                <Table.HeadCell key={c}>{c}</Table.HeadCell>
                            ))}
                        </Table.Head>
                        <Table.Body>
                            {rows.slice(0, 100).map((r, i) => (
                                // eslint-disable-next-line react/no-array-index-key
                                <Table.Row key={i}>
                                    {columns.map((c) => (
                                        <Table.Cell key={c}>{String(r[c] ?? '')}</Table.Cell>
                                    ))}
                                </Table.Row>
                            ))}
                        </Table.Body>
                    </Table>
                    {rows.length > 100 && (
                        <StyledSubtle>
                            先頭 100 行のみ表示（全 {rows.length.toLocaleString()} 行）
                        </StyledSubtle>
                    )}
                </>
            )}
        </StyledContainer>
    );
};

export default Overview;
