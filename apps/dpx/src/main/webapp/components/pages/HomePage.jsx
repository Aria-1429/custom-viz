import React, { useCallback, useEffect, useMemo, useState } from 'react';

import DpxBootScreen, { dismissBootSplash } from '../engine/BootScreen';
import { emptyDashboard } from '../engine/templates';
import { DPX_PRESETS, resolveTheme } from '../engine/themes';
import { Button, Field, Select, TextInput, inputStyle, useDpxGlobalStyles } from '../engine/ui';
import { dashboardHref, listDashboards, listApps, createView, deleteView } from '../viewStore';
import SplunkHomeLink from '../engine/SplunkHomeLink';

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

/** 相対時刻（「3時間前」）。正確な日時はツールチップで出すので、ここは読みやすさ優先。 */
function relTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return `${m}分前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}時間前`;
    const d = Math.floor(h / 24);
    if (d === 1) return '昨日';
    if (d < 7) return `${d}日前`;
    return new Date(iso).toLocaleDateString();
}

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

    // アプリ別のグループ。sorted は更新降順なので、
    // 「最初に現れた順」＝最近触ったアプリが上に来る
    const groups = useMemo(() => {
        const m = new Map();
        for (const d of sorted) {
            if (!m.has(d.app)) m.set(d.app, []);
            m.get(d.app).push(d);
        }
        return [...m.entries()];
    }, [sorted]);

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
        // ⚠ owner / sharing も渡す（削除を試す名前空間の決定に使う。viewStore 参照）
        deleteView({ app: d.app, name: d.name, owner: d.owner, sharing: d.sharing })
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
                {/* Splunk 本体への出口（ダッシュボード側のトップバーと同じ位置・同じ形） */}
                <SplunkHomeLink t={t} />
                <span
                    style={{
                        width: 1,
                        height: 18,
                        flex: 'none',
                        background: 'rgba(140,175,235,0.26)',
                    }}
                />
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
                    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
                        {/* 行のホバー効果。inline style では :hover が書けないのでここに置く */}
                        <style>{`
                            .dpx-home-row { border: 1px solid transparent; background: transparent; }
                            .dpx-home-row:hover {
                                background: rgba(120, 160, 255, 0.07);
                                border-color: rgba(120, 160, 255, 0.28);
                            }
                            .dpx-home-row .dpx-row-actions { opacity: 0.55; }
                            .dpx-home-row:hover .dpx-row-actions { opacity: 1; }
                        `}</style>
                        {groups.map(([app, rows]) => (
                            <section key={app}>
                                {/* アプリ見出し：管制ラベル（小・大文字・字間広め）＋ヘアライン */}
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                        margin: '22px 4px 6px',
                                        color: t.subColor,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        letterSpacing: '0.18em',
                                        textTransform: 'uppercase',
                                    }}
                                >
                                    <span style={{ color: t.accent }}>{app}</span>
                                    <span style={{ flex: 1, height: 1, background: 'rgba(140,175,235,0.18)' }} />
                                    <span>{rows.length}件</span>
                                </div>
                                {rows.map((d) => {
                                    // ボードの「顔」＝そのボードのプリセットの地とアクセント。
                                    // 定義由来の実情報であり飾りではない（開く前に配色が分かる）
                                    const st = resolveTheme({ style: { preset: d.preset } });
                                    const presetName = DPX_PRESETS[d.preset]?.name ?? d.preset;
                                    const meta = [
                                        presetName,
                                        `パネル ${d.panelCount}`,
                                        d.tabCount > 1 ? `タブ ${d.tabCount}` : null,
                                    ]
                                        .filter(Boolean)
                                        .join('・');
                                    return (
                                        <a
                                            key={`${d.app}/${d.name}`}
                                            className="dpx-home-row"
                                            href={dashboardUrl(d, 'view')}
                                            // SPA 遷移（再読込なし＝フラッシュなし）。
                                            // href は残すので Ctrl/⌘ クリックの別タブは効く
                                            onClick={(e) => {
                                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                                                e.preventDefault();
                                                navigate(dashboardUrl(d, 'view'));
                                            }}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: '46px minmax(0,1fr) auto auto',
                                                alignItems: 'center',
                                                gap: 14,
                                                padding: '9px 12px',
                                                borderRadius: 9,
                                                textDecoration: 'none',
                                                color: t.titleColor,
                                            }}
                                        >
                                            {/* テーマスウォッチ：プリセットの canvasBg をそのまま塗る */}
                                            <span
                                                aria-hidden
                                                style={{
                                                    width: 46,
                                                    height: 34,
                                                    borderRadius: 6,
                                                    background: st.canvasBg,
                                                    border: '1px solid rgba(255,255,255,0.16)',
                                                    position: 'relative',
                                                    overflow: 'hidden',
                                                    flex: 'none',
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        position: 'absolute',
                                                        left: 6,
                                                        bottom: 5,
                                                        width: 8,
                                                        height: 8,
                                                        borderRadius: '50%',
                                                        background: st.accent,
                                                    }}
                                                />
                                            </span>
                                            <span style={{ minWidth: 0 }}>
                                                <span
                                                    style={{
                                                        display: 'block',
                                                        fontSize: 14,
                                                        fontWeight: 700,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {d.label}
                                                </span>
                                                <span
                                                    style={{
                                                        display: 'block',
                                                        fontSize: 11,
                                                        color: t.subColor,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    <code style={{ opacity: 0.85 }}>{d.name}</code>
                                                    <span style={{ opacity: 0.6 }}>　{meta}</span>
                                                </span>
                                            </span>
                                            <span
                                                title={new Date(d.updated).toLocaleString()}
                                                style={{ fontSize: 11, color: t.subColor, whiteSpace: 'nowrap' }}
                                            >
                                                {relTime(d.updated)}
                                            </span>
                                            {/* 行クリック＝開く なので、ボタンは編集と削除だけ。
                                                アンカー内のボタンなので既定遷移を必ず止める */}
                                            <span
                                                className="dpx-row-actions"
                                                style={{ display: 'flex', gap: 6 }}
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }}
                                            >
                                                <Button
                                                    t={t}
                                                    label="編集"
                                                    onClick={() => navigate(dashboardUrl(d, 'edit'))}
                                                />
                                                {/* 権限が無いビュー（nobody 所有の共有等）は押せて必ず
                                                    失敗するボタンを出さない。理由はツールチップで示す */}
                                                <span
                                                    title={
                                                        d.canWrite
                                                            ? undefined
                                                            : '削除する権限がありません（所有者または管理者のみ）'
                                                    }
                                                >
                                                    <Button
                                                        t={t}
                                                        kind="danger"
                                                        label="削除"
                                                        disabled={!d.canWrite}
                                                        onClick={() => onDelete(d)}
                                                    />
                                                </span>
                                            </span>
                                        </a>
                                    );
                                })}
                            </section>
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
