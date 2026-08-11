import React, { useCallback, useEffect, useMemo, useState } from 'react';

import DpxBootScreen, { dismissBootSplash } from '../engine/BootScreen';
import { emptyDashboard } from '../engine/templates';
import { resolveTheme } from '../engine/themes';
import { Button, Field, Select, TextInput, inputStyle, useDpxGlobalStyles } from '../engine/ui';
import { dashboardHref, listDashboards, listApps, createView, deleteView } from '../viewStore';

// ── DPX ホーム（ダッシュボード管理）──────────────────────────────
// ホストビュー dpx の「?id= なし」ルート。ダッシュボード本体と同じ
// 視覚言語（ダークシェル・ガラスカード・アクセント）で統一する。
// 開く/編集は SPA 遷移（props.navigate）— ページ再読込ゼロ。
// ────────────────────────────────────────────────────────────────

const HOME_DEF = { style: { preset: 'midnight' } };

const slugify = (s) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);

// dashboardHref はロケール接頭辞付きのパスを返す（?id= 形式）
const dashboardUrl = (d, mode) => dashboardHref({ app: d.app, name: d.name, mode });

function useHiddenSplunkChrome() {
    useEffect(() => {
        const style = document.createElement('style');
        style.textContent = 'body > header { display: none !important; }';
        document.head.appendChild(style);
        return () => style.remove();
    }, []);
}

const HomePage = ({ navigate }) => {
    const t = resolveTheme(HOME_DEF);
    useDpxGlobalStyles(t);
    useHiddenSplunkChrome();

    const [dashboards, setDashboards] = useState(null);
    const [apps, setApps] = useState([]);
    const [error, setError] = useState(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState('');
    const [form, setForm] = useState({
        label: '',
        name: '',
        app: 'dpx',
        touchedName: false,
    });

    const reload = useCallback(() => {
        listDashboards()
            .then(setDashboards)
            .catch((err) => setError(String(err?.message ?? err)));
    }, []);

    useEffect(() => {
        reload();
        listApps()
            .then(setApps)
            .catch(() => setApps([{ id: 'dpx', label: 'DPX' }]));
    }, [reload]);

    const sorted = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (dashboards ?? [])
            .filter((d) => !q || d.label.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
            .slice()
            .sort((a, b) => (a.updated < b.updated ? 1 : -1));
    }, [dashboards, query]);

    const onCreate = () => {
        const name = form.name || slugify(form.label);
        if (!form.label.trim() || !name) return;
        setBusy(true);
        createView({
            app: form.app,
            name,
            label: form.label.trim(),
            definition: emptyDashboard(form.label.trim()),
        })
            .then(() => {
                navigate(dashboardUrl({ app: form.app, name }, 'edit'));
            })
            .catch((err) => {
                setBusy(false);
                setError(`作成に失敗: ${String(err?.message ?? err)}`);
            });
    };

    const onDelete = (d) => {
        // eslint-disable-next-line no-alert
        if (!window.confirm(`「${d.label}」(${d.app}/${d.name}) を削除しますか？`)) return;
        deleteView({ app: d.app, name: d.name })
            .then(reload)
            .catch((err) => setError(`削除に失敗: ${String(err?.message ?? err)}`));
    };

    // 一覧が届いてから Mako のスプラッシュを消す。
    // ⚠ フックなので早期 return より前に置くこと（フック数が変わると落ちる）。
    const ready = dashboards !== null || error !== null;
    useEffect(() => {
        if (ready) dismissBootSplash();
    }, [ready]);

    // 一覧が来るまではスプラッシュと同じ意匠の全面スクリーンを出す。
    // ⚠ ここで素の「読み込み中…」を描くと、スプラッシュが消えた直後に
    //   別デザインの画面が一瞬挟まって見える（実機で指摘を受けた）。
    if (!ready) {
        return <DpxBootScreen />;
    }

    return (
        <div
            style={{
                minHeight: '100vh',
                background: t.canvasBg,
                color: t.titleColor,
                fontFamily: t.fontFamily,
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {/* トップバー（ダッシュボードと同じ意匠） */}
            <div
                style={{
                    height: 48,
                    flex: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '0 20px',
                    background: 'rgba(10, 16, 30, 0.97)',
                    borderBottom: '1px solid rgba(90,130,200,0.3)',
                }}
            >
                <span style={{ color: t.accent, fontWeight: 800, fontSize: 15, letterSpacing: '0.12em' }}>DPX</span>
                <span style={{ opacity: 0.35 }}>/</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>ダッシュボード</span>
                <span style={{ flex: 1 }} />
                <input
                    className="dpx-input"
                    placeholder="検索…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ ...inputStyle(t), width: 200 }}
                />
                <Button t={t} kind="primary" label="＋ 新規作成" onClick={() => setCreating(true)} />
            </div>

            <div className="dpx-scroll" style={{ flex: 1, overflow: 'auto', padding: '24px 28px 40px' }}>
                {error ? (
                    <div
                        style={{
                            background: 'rgba(220,70,90,0.15)',
                            border: '1px solid rgba(220,70,90,0.4)',
                            borderRadius: 8,
                            padding: '10px 14px',
                            marginBottom: 16,
                            fontSize: 12,
                            color: '#ffb0b0',
                        }}
                    >
                        {error}
                    </div>
                ) : null}

                {sorted.length === 0 ? (
                    <div
                        style={{
                            border: '1px dashed rgba(140,175,235,0.3)',
                            borderRadius: 12,
                            padding: '48px 24px',
                            textAlign: 'center',
                            color: t.subColor,
                        }}
                    >
                        <div style={{ fontSize: 15, marginBottom: 6, color: t.titleColor }}>
                            {query ? '一致するダッシュボードがありません' : 'まだダッシュボードがありません'}
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 16 }}>
                            空のダッシュボードを作って、編集モードでパネルを追加していきます。
                        </div>
                        <Button t={t} kind="primary" label="＋ 新規作成" onClick={() => setCreating(true)} />
                    </div>
                ) : (
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                            gap: 14,
                        }}
                    >
                        {sorted.map((d) => (
                            <div
                                key={`${d.app}/${d.name}`}
                                style={{
                                    ...t.panel.glass,
                                    borderRadius: 12,
                                    padding: 16,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 8,
                                }}
                            >
                                <a
                                    href={dashboardUrl(d, 'view')}
                                    // SPA 遷移（再読込なし＝フラッシュなし）。
                                    // href は残すので Ctrl/⌘ クリックの別タブは効く
                                    onClick={(e) => {
                                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                                        e.preventDefault();
                                        navigate(dashboardUrl(d, 'view'));
                                    }}
                                    style={{
                                        color: t.titleColor,
                                        fontSize: 15,
                                        fontWeight: 700,
                                        textDecoration: 'none',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {d.label}
                                </a>
                                <div style={{ fontSize: 11, color: t.subColor, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <span
                                        style={{
                                            padding: '2px 8px',
                                            borderRadius: 10,
                                            background: `${t.accent}1f`,
                                            color: t.accent,
                                        }}
                                    >
                                        {d.app}
                                    </span>
                                    <code style={{ opacity: 0.8 }}>{d.name}</code>
                                </div>
                                <div style={{ fontSize: 11, color: t.subColor }}>
                                    更新 {new Date(d.updated).toLocaleString()}
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                    <Button
                                        t={t}
                                        kind="primary"
                                        label="開く"
                                        onClick={() => {
                                            navigate(dashboardUrl(d, 'view'));
                                        }}
                                    />
                                    <Button
                                        t={t}
                                        label="編集"
                                        onClick={() => {
                                            navigate(dashboardUrl(d, 'edit'));
                                        }}
                                    />
                                    <span style={{ flex: 1 }} />
                                    <Button t={t} kind="danger" label="削除" onClick={() => onDelete(d)} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {creating ? (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(4,8,18,0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 9000,
                    }}
                    onClick={() => !busy && setCreating(false)}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="dpx-scroll"
                        style={{
                            width: 560,
                            maxHeight: '86vh',
                            overflowY: 'auto',
                            background: '#0e1628',
                            border: `1px solid ${t.accent}44`,
                            borderRadius: 14,
                            boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
                            padding: 22,
                        }}
                    >
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>ダッシュボードを新規作成</div>

                        <Field t={t} label="タイトル">
                            <TextInput
                                t={t}
                                value={form.label}
                                onChange={(v) =>
                                    setForm((f) => ({ ...f, label: v, name: f.touchedName ? f.name : slugify(v) }))
                                }
                            />
                        </Field>
                        <Field t={t} label="ID（ビュー名）" hint="英数字・ハイフン・アンダースコア">
                            <TextInput
                                t={t}
                                value={form.name}
                                onChange={(v) => setForm((f) => ({ ...f, name: slugify(v), touchedName: true }))}
                            />
                        </Field>
                        <Field t={t} label="所属アプリ" hint="ダッシュボード（ビュー）の保存先">
                            <Select
                                t={t}
                                value={form.app}
                                options={apps.map((a) => ({ value: a.id, label: `${a.label} (${a.id})` }))}
                                onChange={(v) => setForm((f) => ({ ...f, app: v }))}
                            />
                        </Field>

                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
                            <Button t={t} label="キャンセル" disabled={busy} onClick={() => setCreating(false)} />
                            <Button
                                t={t}
                                kind="primary"
                                label={busy ? '作成中…' : '作成して編集へ'}
                                disabled={busy || !form.label.trim()}
                                onClick={onCreate}
                            />
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
};

export default HomePage;
