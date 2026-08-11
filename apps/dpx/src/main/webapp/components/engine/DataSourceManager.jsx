import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { getDataSources, nextSourceId, panelsUsingSource } from './dataSources';
import TimeRangePicker from './TimeRangePicker';
import SplEditor from './SplEditor';
import { Button, Field, TextInput, inputStyle } from './ui';

// ── データソース管理（編集画面の上部から開く）────────────────────
//
// Studio 準拠。**サーチはダッシュボードに属し、パネルはそれを参照する**。
// パネルごとに SPL を書き写す運用をやめ、一覧をここで一元管理する。
//
// Studio との違い（DPX の割り切り）:
//   Studio は ds.search / ds.chain / ds.test と型を分けるが、DPX は
//   「共有サーチ＋postSearch（後続パイプ）」の1種類に畳んである。
//   ds.chain 相当は postSearch で足り、型を増やすほど編集 UI が複雑になるため。
//
// ⚠ 絞り込みは `| where`（`| search` は 0 行になる。後続パイプなので
//   search コマンドの意味が違う）。
// ────────────────────────────────────────────────────────────────

const MONO = { fontFamily: 'Menlo, Consolas, monospace', fontSize: 11, lineHeight: 1.55 };

export default function DataSourceManager({ t, definition, patchDef, onClose }) {
    const sources = getDataSources(definition);
    const ids = useMemo(() => Object.keys(sources), [sources]);
    const [sel, setSel] = useState(() => ids[0] ?? null);

    const patchSource = (id, patch) =>
        patchDef({ dataSources: { ...sources, [id]: { ...sources[id], ...patch } } });

    const addSource = () => {
        const id = nextSourceId(definition);
        patchDef({
            dataSources: {
                ...sources,
                [id]: {
                    name: `データソース ${ids.length + 1}`,
                    spl: '| makeresults count=5 | streamstats count as n | eval label="item-".n, value=(n*23) % 80 + 10 | table label value',
                    earliest: '-24h',
                    latest: 'now',
                },
            },
        });
        setSel(id);
    };

    const removeSource = (id) => {
        const used = panelsUsingSource(definition, id);
        if (used.length > 0) {
            // 黙って壊さない。どのパネルが困るのかを名前で見せる
            const names = (definition.panels ?? [])
                .filter((p) => used.includes(p.id))
                .map((p) => p.title || p.id);
            // eslint-disable-next-line no-alert
            const ok = window.confirm(
                `${used.length} 個のパネル（${names.join(' / ')}）がこのデータソースを使っています。\n` +
                    '削除するとそれらは表示できなくなります。続けますか？'
            );
            if (!ok) return;
        }
        const next = { ...sources };
        delete next[id];
        patchDef({ dataSources: next });
        setSel((cur) => (cur === id ? Object.keys(next)[0] ?? null : cur));
    };

    const duplicate = (id) => {
        const nid = nextSourceId(definition);
        patchDef({
            dataSources: { ...sources, [nid]: { ...sources[id], name: `${sources[id].name || id} のコピー` } },
        });
        setSel(nid);
    };

    const cur = sel ? sources[sel] : null;

    // ⚠ body へポータルする。編集キャンバスの中に置くと、祖先の transform で
    //   position:fixed が壊れて画面に出ない（§8.z の罠）。
    return createPortal(
        <div
            role="presentation"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 6000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(4,8,18,0.66)',
                backdropFilter: 'blur(3px)',
            }}
        >
            <div
                style={{
                    width: 'min(980px, 94vw)',
                    height: 'min(620px, 88vh)',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 12,
                    overflow: 'hidden',
                    border: '1px solid rgba(140,175,235,0.28)',
                    background: t.colorScheme === 'light' ? '#ffffff' : '#0d1526',
                    boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
                    color: t.titleColor,
                    fontFamily: t.fontFamily,
                }}
            >
                {/* ヘッダ */}
                <div
                    style={{
                        flex: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '12px 16px',
                        borderBottom: '1px solid rgba(140,175,235,0.18)',
                    }}
                >
                    <span style={{ fontSize: 14, fontWeight: 700 }}>データソース</span>
                    <span style={{ fontSize: 11, color: t.subColor }}>
                        サーチはダッシュボードに属します。複数パネルで参照しても実行は1回だけです。
                    </span>
                    <span style={{ flex: 1 }} />
                    <Button t={t} label="閉じる" onClick={onClose} />
                </div>

                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                    {/* 一覧 */}
                    <div
                        className="dpx-scroll"
                        style={{
                            width: 260,
                            flex: 'none',
                            overflowY: 'auto',
                            borderRight: '1px solid rgba(140,175,235,0.18)',
                            padding: 10,
                        }}
                    >
                        {ids.length === 0 ? (
                            <div style={{ fontSize: 11, color: t.subColor, lineHeight: 1.7, padding: '6px 4px 12px' }}>
                                まだデータソースがありません。追加すると、パネルの「サーチ元」から選べるようになります。
                            </div>
                        ) : null}
                        {ids.map((id) => {
                            const used = panelsUsingSource(definition, id).length;
                            const on = id === sel;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => setSel(id)}
                                    style={{
                                        display: 'block',
                                        width: '100%',
                                        textAlign: 'left',
                                        padding: '8px 10px',
                                        marginBottom: 5,
                                        borderRadius: 7,
                                        cursor: 'pointer',
                                        fontFamily: 'inherit',
                                        border: `1px solid ${on ? t.accent : 'rgba(140,175,235,0.18)'}`,
                                        background: on ? `${t.accent}1c` : 'transparent',
                                        color: t.titleColor,
                                    }}
                                >
                                    <div
                                        style={{
                                            fontSize: 12,
                                            fontWeight: on ? 700 : 500,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {sources[id].name || id}
                                    </div>
                                    <div style={{ fontSize: 10, color: t.subColor, marginTop: 2 }}>
                                        {id} ／ {used > 0 ? `${used} パネルで使用中` : '未使用'}
                                    </div>
                                </button>
                            );
                        })}
                        <div style={{ marginTop: 8 }}>
                            <Button t={t} label="＋ データソースを追加" onClick={addSource} full />
                        </div>
                    </div>

                    {/* 詳細 */}
                    <div className="dpx-scroll" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
                        {!cur ? (
                            <div style={{ fontSize: 12, color: t.subColor }}>
                                左の一覧から選ぶか、新しく追加してください。
                            </div>
                        ) : (
                            <>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <Field t={t} label="表示名">
                                            <TextInput
                                                t={t}
                                                value={cur.name ?? sel}
                                                placeholder="表示名"
                                                onChange={(v) => patchSource(sel, { name: v })}
                                            />
                                        </Field>
                                    </div>
                                    <div style={{ paddingBottom: 10 }}>
                                        <Button t={t} label="複製" onClick={() => duplicate(sel)} />
                                    </div>
                                    <div style={{ paddingBottom: 10 }}>
                                        <Button t={t} kind="danger" label="削除" onClick={() => removeSource(sel)} />
                                    </div>
                                </div>

                                {/* ⚠ 打鍵ごとに反映すると、このデータソースを参照している
                                    **全パネルが毎回サーチし直す**。確定時だけ反映する。 */}
                                <Field t={t} label="SPL">
                                    <SplEditor
                                        t={t}
                                        height={150}
                                        value={cur.spl ?? ''}
                                        placeholder="index=… | stats count by host"
                                        onCommit={(v) => patchSource(sel, { spl: v })}
                                    />
                                </Field>

                                <Field t={t} label="時間範囲（既定）" hint="パネル側で上書きできます">
                                    <TimeRangePicker
                                        t={t}
                                        earliest={cur.earliest ?? '-24h'}
                                        latest={cur.latest ?? 'now'}
                                        onChange={(e, l) => patchSource(sel, { earliest: e, latest: l })}
                                    />
                                </Field>

                                <Field t={t} label="自動更新（秒。0 で更新しない）">
                                    <TextInput
                                        t={t}
                                        value={String(cur.refresh ?? 0)}
                                        onChange={(v) => patchSource(sel, { refresh: Number(v) || 0 })}
                                    />
                                </Field>

                                <UsageList t={t} definition={definition} id={sel} />
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}

/** このデータソースを使っているパネルを列挙する（消す前に影響が見えるように）。 */
function UsageList({ t, definition, id }) {
    const used = (definition.panels ?? []).filter((p) => p.search?.ref === id);
    return (
        <div
            style={{
                marginTop: 6,
                padding: 10,
                borderRadius: 8,
                border: '1px solid rgba(140,175,235,0.18)',
                background: 'rgba(255,255,255,0.03)',
            }}
        >
            <div style={{ fontSize: 11, color: t.subColor, marginBottom: used.length ? 6 : 0 }}>
                使用中のパネル（{used.length}）
            </div>
            {used.map((p) => (
                <div key={p.id} style={{ fontSize: 11, marginBottom: 3 }}>
                    ・{p.title || p.id}
                    {p.search?.postSearch ? (
                        <span style={{ color: t.subColor, marginLeft: 6, ...MONO }}>{p.search.postSearch}</span>
                    ) : null}
                </div>
            ))}
        </div>
    );
}
