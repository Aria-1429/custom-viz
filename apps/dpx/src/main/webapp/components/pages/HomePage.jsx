import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import DpxBootScreen, { dismissBootSplash } from '../renderer/BootScreen';
import { emptyDashboard } from '../schema/templates';
import { DPX_PRESETS, orderedPresets, resolveTheme } from '../design';
import { Button, CONTROL_H, Field, Select, TextInput, inputStyle, useDpxGlobalStyles } from '../shared/ui';
import {
    dashboardHref,
    listDashboards,
    listApps,
    createView,
    deleteView,
    duplicateView,
    renameView,
    exportView,
    parseImportedDefinition,
} from '../data/viewStore';
import SplunkHomeLink from '../shared/SplunkHomeLink';

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

/** タイトルから ID の候補を作る。
 *
 *  ⚠ **日本語だけのタイトルは slugify すると空になる**（「売上ボード」→ ""）。
 *    ここは日本語タイトルが普通なので、空のまま返すと ID 欄が埋まらず
 *    「作成」が押せないまま理由も分からない、という詰み方をする（実機で発生）。
 *    ASCII が残らないときは日付ベースの一意な ID を宛てがう（利用者は
 *    ID 欄でいつでも書き換えられる）。 */
const suggestName = (label) => {
    const slug = slugify(label);
    if (slug) return slug;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `dpx_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

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

/** ダイアログの外枠（作成／複製／名前変更で共用）。 */
function Modal({ t, title, width = 560, onClose, children }) {
    return (
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
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="dpx-scroll"
                style={{
                    width,
                    maxHeight: '86vh',
                    overflowY: 'auto',
                    background: '#0e1628',
                    border: `1px solid ${t.accent}44`,
                    borderRadius: 14,
                    boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
                    padding: 22,
                }}
            >
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>{title}</div>
                {children}
            </div>
        </div>
    );
}

/** 行の「…」メニュー（複製 / 名前変更 / 書き出し）。
 *
 *  ⚠ 外側クリックの判定は **mousedown を document で拾い、ref に含まれるかで見る**。
 *    blur で閉じると、メニュー内のボタンが押される前に閉じてクリックが落ちる
 *    （DPX で既出の罠）。 */
function RowMenu({ t, canWrite, onDuplicate, onRename, onExport }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const item = (label, onClick, disabled, title) => (
        <button
            type="button"
            title={title}
            disabled={disabled}
            onClick={() => {
                setOpen(false);
                onClick();
            }}
            style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 12px',
                fontSize: 12,
                border: 'none',
                background: 'transparent',
                color: disabled ? t.subColor : t.titleColor,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
                if (!disabled) e.currentTarget.style.background = 'rgba(120,160,255,0.14)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
            }}
        >
            {label}
        </button>
    );

    return (
        <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
                type="button"
                title="その他の操作"
                aria-label="その他の操作"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                style={{
                    height: CONTROL_H,
                    width: 30,
                    borderRadius: 7,
                    border: '1px solid rgba(140,175,235,0.28)',
                    background: open ? 'rgba(120,160,255,0.16)' : 'transparent',
                    color: t.titleColor,
                    cursor: 'pointer',
                    fontSize: 15,
                    lineHeight: 1,
                    fontFamily: 'inherit',
                }}
            >
                …
            </button>
            {open ? (
                <div
                    style={{
                        position: 'absolute',
                        top: CONTROL_H + 4,
                        right: 0,
                        minWidth: 168,
                        background: '#0e1628',
                        border: '1px solid rgba(140,175,235,0.3)',
                        borderRadius: 9,
                        boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
                        padding: '4px 0',
                        zIndex: 40,
                    }}
                >
                    {item('複製', onDuplicate)}
                    {item(
                        '名前を変更',
                        onRename,
                        !canWrite,
                        canWrite ? undefined : '変更する権限がありません（所有者または管理者のみ）'
                    )}
                    {item('JSON を書き出し', onExport)}
                </div>
            ) : null}
        </span>
    );
}

/** テーマピッカー：プリセットを名前ではなく「地の色そのもの」で選ばせる。
 *
 *  ⚠ プリセットは 18 種あり、名前（「インクウォッシュ」等）だけでは何色か分からない。
 *    一覧の行スウォッチと同じ描き方（canvasBg をそのまま塗り、アクセントを点で置く）に
 *    揃えることで、「作成時に選んだ絵 ＝ 一覧に並ぶ絵」になる。 */
function ThemePicker({ t, value, onChange }) {
    return (
        <div
            className="dpx-scroll"
            style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                gap: 8,
                maxHeight: 232,
                overflowY: 'auto',
                padding: 2,
            }}
        >
            {orderedPresets().map(([key, p]) => {
                const st = resolveTheme({ style: { preset: key } });
                const on = value === key;
                return (
                    <button
                        key={key}
                        type="button"
                        title={p.name}
                        onClick={() => onChange(key)}
                        style={{
                            display: 'block',
                            padding: 0,
                            border: on ? `2px solid ${t.accent}` : '1px solid rgba(140,175,235,0.24)',
                            // 選択枠が太くなる分の 1px を内側で吸収して、格子が揺れないようにする
                            margin: on ? 0 : 1,
                            borderRadius: 8,
                            background: 'transparent',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            textAlign: 'left',
                        }}
                    >
                        <span
                            aria-hidden
                            style={{
                                display: 'block',
                                height: 42,
                                background: st.canvasBg,
                                position: 'relative',
                            }}
                        >
                            <span
                                style={{
                                    position: 'absolute',
                                    left: 7,
                                    bottom: 6,
                                    width: 9,
                                    height: 9,
                                    borderRadius: '50%',
                                    background: st.accent,
                                }}
                            />
                        </span>
                        <span
                            style={{
                                display: 'block',
                                padding: '4px 6px 5px',
                                fontSize: 10,
                                fontWeight: on ? 700 : 500,
                                color: on ? t.accent : t.subColor,
                                background: 'rgba(6,10,22,0.6)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {p.name}
                        </span>
                    </button>
                );
            })}
        </div>
    );
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
        preset: 'midnight',
    });
    // 複製／名前変更のダイアログ。対象の行をそのまま持つ（null = 閉じている）
    const [dup, setDup] = useState(null);
    const [rename, setRename] = useState(null);
    // 取り込んだ定義（{name, definition}）。作成ダイアログに相乗りする
    const [imported, setImported] = useState(null);

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

    /** 既存の名前と衝突しない ID を作る（`foo` → `foo_copy` → `foo_copy2` …）。 */
    const uniqueName = useCallback(
        (base, app) => {
            const taken = new Set(
                (dashboards ?? []).filter((d) => d.app === app).map((d) => d.name)
            );
            if (!taken.has(base)) return base;
            for (let i = 2; i < 200; i += 1) {
                if (!taken.has(`${base}${i}`)) return `${base}${i}`;
            }
            return `${base}_${Date.now()}`;
        },
        [dashboards]
    );

    const openCreate = () => {
        // ⚠ 取り込み結果を必ず捨てる。残っていると次の「新規作成」が
        //   前回貼った JSON から始まってしまう
        setImported(null);
        // ID は最初から埋めておく。日本語タイトルだと slugify が空になるので、
        // 「タイトルを書いたのに作成が押せない」状態を作らないための初期値
        setForm({
            label: '',
            name: suggestName(''),
            app: 'dpx',
            touchedName: false,
            preset: 'midnight',
        });
        setCreating(true);
    };

    const onCreate = () => {
        const name = form.name || suggestName(form.label);
        const label = form.label.trim();
        if (!label || !name) return;
        setBusy(true);
        // 取り込んだ定義があればそれを土台にし、無ければ空板。
        // どちらの場合もタイトルと配色はこのダイアログの入力を正とする
        const base = imported?.definition ?? emptyDashboard(label);
        const definition = {
            ...base,
            title: label,
            style: { ...(base.style ?? {}), preset: form.preset },
        };
        createView({ app: form.app, name, label, definition })
            .then(() => {
                navigate(dashboardUrl({ app: form.app, name }, 'edit'));
            })
            .catch((err) => {
                setBusy(false);
                setError(`作成に失敗: ${String(err?.message ?? err)}`);
            });
    };

    /** JSON ファイルを読み込んで作成ダイアログに載せる。 */
    const onPickFile = (file) => {
        if (!file) return;
        file.text()
            .then((text) => {
                const { definition, error: parseError } = parseImportedDefinition(text);
                if (parseError) {
                    setError(`取り込めません: ${parseError}`);
                    return;
                }
                const label = definition.title || file.name.replace(/\.json$/i, '');
                setImported({ definition, fileName: file.name });
                setForm({
                    label,
                    name: uniqueName(suggestName(label), 'dpx'),
                    app: 'dpx',
                    touchedName: false,
                    preset: definition.style?.preset ?? 'midnight',
                });
                setError(null);
                setCreating(true);
            })
            .catch((err) => setError(`ファイルを読めません: ${String(err?.message ?? err)}`));
    };

    const onDuplicate = () => {
        if (!dup) return;
        const label = dup.label.trim();
        const name = dup.name.trim();
        if (!label || !name) return;
        setBusy(true);
        duplicateView({ app: dup.src.app, name: dup.src.name, toApp: dup.app, toName: name, label })
            .then(() => {
                setBusy(false);
                setDup(null);
                reload();
            })
            .catch((err) => {
                setBusy(false);
                setError(`複製に失敗: ${String(err?.message ?? err)}`);
            });
    };

    const onRename = () => {
        if (!rename) return;
        const label = rename.label.trim();
        if (!label) return;
        setBusy(true);
        renameView({ app: rename.src.app, name: rename.src.name, owner: rename.src.owner, label })
            .then(() => {
                setBusy(false);
                setRename(null);
                reload();
            })
            .catch((err) => {
                setBusy(false);
                setError(`名前の変更に失敗: ${String(err?.message ?? err)}`);
            });
    };

    const onExport = (d) => {
        exportView({ app: d.app, name: d.name }).catch((err) =>
            setError(`書き出しに失敗: ${String(err?.message ?? err)}`)
        );
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
                {/* 取り込みは file input が本体。ボタンは見た目を揃えるための飾りで、
                    クリックを隠し input に中継する */}
                <input
                    id="dpx-import-file"
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        onPickFile(e.target.files?.[0]);
                        // 同じファイルを続けて選んでも change が出るようにクリアする
                        e.target.value = '';
                    }}
                />
                <Button
                    t={t}
                    label="取り込み"
                    onClick={() => document.getElementById('dpx-import-file')?.click()}
                />
                <Button t={t} kind="primary" label="＋ 新規作成" onClick={openCreate} />
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
                        <Button t={t} kind="primary" label="＋ 新規作成" onClick={openCreate} />
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
                                            {/* 行クリック＝開く なので、常設ボタンは編集と削除だけ。
                                                複製・名前変更・書き出しは「…」に畳む（4つ以上を
                                                並べると行が窮屈になり、肝心のラベルが縮む）。
                                                アンカー内のボタンなので既定遷移を必ず止める */}
                                            <span
                                                className="dpx-row-actions"
                                                style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }}
                                            >
                                                <RowMenu
                                                    t={t}
                                                    canWrite={d.canWrite}
                                                    onDuplicate={() =>
                                                        setDup({
                                                            src: d,
                                                            app: d.app,
                                                            label: `${d.label} のコピー`,
                                                            name: uniqueName(`${d.name}_copy`, d.app),
                                                        })
                                                    }
                                                    onRename={() => setRename({ src: d, label: d.label })}
                                                    onExport={() => onExport(d)}
                                                />
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
                <Modal
                    t={t}
                    title={imported ? 'JSON から作成' : 'ダッシュボードを新規作成'}
                    onClose={() => !busy && setCreating(false)}
                >
                    {imported ? (
                        <div
                            style={{
                                background: 'rgba(78,161,255,0.12)',
                                border: `1px solid ${t.accent}55`,
                                borderRadius: 8,
                                padding: '9px 12px',
                                marginBottom: 14,
                                fontSize: 11.5,
                                color: t.subColor,
                            }}
                        >
                            <code style={{ color: t.titleColor }}>{imported.fileName}</code> を読み込みました（パネル{' '}
                            {imported.definition.panels?.length ?? 0}）。保存先とタイトルを決めて作成します。
                        </div>
                    ) : null}

                    <Field t={t} label="タイトル">
                        <TextInput
                            t={t}
                            value={form.label}
                            onChange={(v) =>
                                setForm((f) => ({
                                    ...f,
                                    label: v,
                                    // 打鍵のたびに日付 ID を振り直さないよう、空になるときだけ補う
                                    name: f.touchedName ? f.name : slugify(v) || f.name,
                                }))
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
                    <Field
                        t={t}
                        label="配色プリセット"
                        hint={imported ? '取り込んだ定義の配色を上書きします' : 'あとから編集モードで変更できます'}
                    >
                        <ThemePicker
                            t={t}
                            value={form.preset}
                            onChange={(v) => setForm((f) => ({ ...f, preset: v }))}
                        />
                    </Field>

                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
                        <Button t={t} label="キャンセル" disabled={busy} onClick={() => setCreating(false)} />
                        <Button
                            t={t}
                            kind="primary"
                            label={busy ? '作成中…' : '作成して編集へ'}
                            disabled={busy || !form.label.trim() || !form.name}
                            onClick={onCreate}
                        />
                    </div>
                </Modal>
            ) : null}

            {dup ? (
                <Modal t={t} title="ダッシュボードを複製" width={520} onClose={() => !busy && setDup(null)}>
                    <div style={{ fontSize: 11.5, color: t.subColor, marginBottom: 14 }}>
                        複製元：<code style={{ color: t.titleColor }}>{`${dup.src.app}/${dup.src.name}`}</code>
                        <br />
                        パネル・データソース・タブ・入力をそのまま引き継ぎます。
                    </div>
                    <Field t={t} label="タイトル">
                        <TextInput t={t} value={dup.label} onChange={(v) => setDup((s) => ({ ...s, label: v }))} />
                    </Field>
                    <Field t={t} label="ID（ビュー名）" hint="複製元と同じ ID は使えません">
                        <TextInput
                            t={t}
                            value={dup.name}
                            onChange={(v) => setDup((s) => ({ ...s, name: slugify(v) }))}
                        />
                    </Field>
                    <Field t={t} label="所属アプリ" hint="別のアプリへコピーできます">
                        <Select
                            t={t}
                            value={dup.app}
                            options={apps.map((a) => ({ value: a.id, label: `${a.label} (${a.id})` }))}
                            onChange={(v) => setDup((s) => ({ ...s, app: v }))}
                        />
                    </Field>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
                        <Button t={t} label="キャンセル" disabled={busy} onClick={() => setDup(null)} />
                        <Button
                            t={t}
                            kind="primary"
                            label={busy ? '複製中…' : '複製'}
                            disabled={busy || !dup.label.trim() || !dup.name.trim()}
                            onClick={onDuplicate}
                        />
                    </div>
                </Modal>
            ) : null}

            {rename ? (
                <Modal t={t} title="名前を変更" width={460} onClose={() => !busy && setRename(null)}>
                    <div style={{ fontSize: 11.5, color: t.subColor, marginBottom: 14 }}>
                        ID（<code style={{ color: t.titleColor }}>{rename.src.name}</code>）は変わりません。
                        既存のリンクはそのまま使えます。
                    </div>
                    <Field t={t} label="タイトル">
                        <TextInput
                            t={t}
                            value={rename.label}
                            onChange={(v) => setRename((s) => ({ ...s, label: v }))}
                        />
                    </Field>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
                        <Button t={t} label="キャンセル" disabled={busy} onClick={() => setRename(null)} />
                        <Button
                            t={t}
                            kind="primary"
                            label={busy ? '保存中…' : '保存'}
                            disabled={busy || !rename.label.trim()}
                            onClick={onRename}
                        />
                    </div>
                </Modal>
            ) : null}
        </div>
    );
};

export default HomePage;
