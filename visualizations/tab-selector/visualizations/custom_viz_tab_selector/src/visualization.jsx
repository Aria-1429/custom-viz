// Tab Selector — クリックでトークンを切り替えるタブバー
//
// 【設計の要点（実機確認済みの制約に基づく）】
//   - カスタム viz は **自分でトークンを書き込めない**。できるのは「クリックされた」という
//     事実をホストへ発火することだけ。何をするか（トークン設定）は編集画面の
//     「インタラクション」でユーザーが定義する。
//   - 発火するのは **addDrilldownListener に登録した DOM ノードのクリック**だけ。
//     triggerDrilldown() は例外も出さずサイレントに無視される。
//   - したがって **タブ1つ1つを addDrilldownListener に登録**し、payloadCallback には
//     そのタブ専用の値を閉じ込める。1ノードだけ登録して使い回すと
//     「どれを押しても1番目のタブの値が飛ぶ」症状になる。
//   - config.json 側に events（tab.click）と supports:["events"] の宣言が必要。
//     宣言が無いとホストがイベント名を認識せず、発火しても無視される。
//
// タブ定義は editor.arrayOfStrings（チップ形式のテキスト入力）。
// 1チップ = 1タブで「表示名|トークン値」の形式。並び順はチップの順そのまま。
//
// 【なぜ editor.threshold ではないか】
//   threshold でも行を動的に増減できるが、value 欄の実体は**カラーピッカー**であり、
//   任意の文字列はダッシュボードのソースを直接編集しないと入れられない
//   （＝編集UIだけでタブ名を決められない）。さらに使わない閾値の数値欄が2つ残る。
//   arrayOfStrings はテキスト入力なので、編集UI だけで完結する。

import { VisualizationExtensionProvider, useOptions, useTheme } from '@splunk/dashboard-studio-extension/react';
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

const VIZ_VERSION = 'tab-selector v1.0.0';

const TAB_STYLES = ['underline', 'filled', 'pill', 'outline'];
const ALIGNS = ['left', 'center', 'right'];

const DEFAULTS = {
    // タブの既定値は **持たない**。中身はユーザーが編集UIで決めるものなので、
    // サンプルを埋め込むと「消し忘れた例示」がダッシュボードに残ってしまう。
    tabs: [],
    defaultTabIndex: 1,
    tabStyle: 'underline',
    align: 'left',
    stretch: false,
    fontSize: 14,
    accentColor: '#00A4FD',
    activeTextColor: '',
    inactiveTextColor: '',
    showTokenHint: false,
};

/** 未設定・型不一致・DOS 文字列に耐えるようオプションを安全側へ補正する */
function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};

    const num = (v, fallback, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        if (typeof min === 'number' && n < min) return min;
        if (typeof max === 'number' && n > max) return max;
        return n;
    };
    const str = (v, fallback) => (typeof v === 'string' && v.trim() !== '' ? v : fallback);
    const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
    const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

    return {
        tabs: parseTabs(o.tabs),
        defaultTabIndex: num(o.defaultTabIndex, DEFAULTS.defaultTabIndex, 1),
        tabStyle: oneOf(o.tabStyle, TAB_STYLES, DEFAULTS.tabStyle),
        align: oneOf(o.align, ALIGNS, DEFAULTS.align),
        stretch: bool(o.stretch, DEFAULTS.stretch),
        fontSize: num(o.fontSize, DEFAULTS.fontSize, 8, 48),
        accentColor: str(o.accentColor, DEFAULTS.accentColor),
        // 空文字＝自動（テーマ由来）なので、ここでは空のままにしておく
        activeTextColor: typeof o.activeTextColor === 'string' ? o.activeTextColor : '',
        inactiveTextColor: typeof o.inactiveTextColor === 'string' ? o.inactiveTextColor : '',
        showTokenHint: bool(o.showTokenHint, DEFAULTS.showTokenHint),
    };
}

/** #RGB / #RRGGBB を {r,g,b} に。解釈できなければ null。 */
function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

/**
 * 背景色の上に置く文字色を白/濃色から選ぶ（相対輝度で判定）。
 * 明るいアクセント色（黄・水色など）に白文字を載せると読めなくなるため、
 * 固定で白にせず必ずここを通す。
 */
function readableOn(bgHex) {
    const rgb = hexToRgb(bgHex);
    if (!rgb) return '#FFFFFF';
    const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    return L > 0.42 ? '#10151B' : '#FFFFFF';
}

/** rgba 文字列を作る（アクセント色の淡い影・グロー用） */
function withAlpha(hex, alpha) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 'transparent';
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * editor.arrayOfStrings の配列をタブ定義へ変換する。
 *
 * 届くのは `["東京|tokyo", "大阪|osaka"]` のような**文字列の配列**。
 * 1要素 = 1タブで、`表示名|トークン値` の形式。区切りが無ければ表示名をそのまま値に使う。
 * **並び順はチップの並び順そのまま**（threshold のような並べ替え用の数値欄は無い）。
 *
 * 旧形式（v1.1.0 以前の `editor.threshold` が保存した `{from,to,value}` オブジェクト）も
 * 読めるようにしておく。既存ダッシュボードが更新でタブを失わないための救済で、
 * こちらは新規に作られることはない。
 */
function parseTabs(raw) {
    // 配列以外（未設定・DOS 文字列など）はタブ無しとして扱う。
    // 既定のタブは持たないので、ここでフォールバック先を用意する必要はない。
    const src = Array.isArray(raw) ? raw : [];
    const tabs = [];

    src.forEach((entry, i) => {
        // 新形式（arrayOfStrings）＝生の文字列。旧形式＝{value} オブジェクト。
        let text = '';
        if (typeof entry === 'string') {
            text = entry;
        } else if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
            text = entry.value;
        }
        if (text.trim() === '') return;

        // 最初の | だけを区切りとして扱う（トークン値に | が入る場合に備える）
        const sep = text.indexOf('|');
        const label = (sep >= 0 ? text.slice(0, sep) : text).trim();
        const tokenValue = sep >= 0 ? text.slice(sep + 1).trim() : label;
        if (label === '') return;

        tabs.push({
            id: `tab-${i}`,
            label,
            value: tokenValue === '' ? label : tokenValue,
        });
    });

    return tabs;
}

function TabSelector({ mode }) {
    const optionsApi = useOptions();
    const opts = useMemo(() => normalizeOptions(optionsApi?.options), [optionsApi?.options]);
    const { tabs } = opts;

    const isDark = mode === 'dark';
    const palette = {
        fg: isDark ? '#E9EDF2' : '#2B3138',
        sub: isDark ? '#8E99A6' : '#6B7785',
        border: isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.11)',
        hover: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        // 走行レーンの下地。タブ群が「1つの部品」に見えるようにする
        trackBg: isDark ? 'rgba(255,255,255,0.045)' : 'rgba(15,23,32,0.045)',
    };
    const isSolid = opts.tabStyle === 'filled' || opts.tabStyle === 'pill';
    const activeText = opts.activeTextColor || (isSolid ? readableOn(opts.accentColor) : opts.accentColor);
    const inactiveText = opts.inactiveTextColor || palette.sub;

    // 選択中タブ。ホストから現在値を読む手段は無いので viz 側で保持する。
    const [selectedId, setSelectedId] = useState(null);
    const [hoverId, setHoverId] = useState(null);

    // 初期選択：defaultTabIndex（1始まり）。範囲外は端に丸める。
    //
    // 選択の保持は「タブの中身が変わっていない」ときだけにする。id は tab-0/tab-1… と
    // 位置ベースなので、id の存在チェックだけで判定すると**別物のタブ構成なのに
    // 前の選択位置が居座る**（設定を編集したのに初期選択が効かなく見える）。
    // 中身のキーが一致するときだけ選択を維持し、それ以外は既定へ戻す。
    //
    // 「初期選択タブ」を編集画面で変えたときも即反映したいので、defaultTabIndex も
    // 再適用のトリガーに含める（含めないと設定を変えても効かないように見える）。
    const tabsIdentity = `${tabs.map((t) => `${t.label}|${t.value}`).join(',')}#${opts.defaultTabIndex}`;
    const prevIdentityRef = useRef(null);

    useEffect(() => {
        const sameSettings = prevIdentityRef.current === tabsIdentity;
        prevIdentityRef.current = tabsIdentity;

        setSelectedId((prev) => {
            // 設定が変わっていないなら、ユーザーのクリック選択を尊重する
            if (sameSettings && prev && tabs.some((t) => t.id === prev)) return prev;
            const idx = Math.min(Math.max(opts.defaultTabIndex, 1), tabs.length) - 1;
            return tabs[idx] ? tabs[idx].id : null;
        });
    }, [tabsIdentity, tabs, opts.defaultTabIndex]);

    // --- 各タブを addDrilldownListener に登録する ---
    //
    // payloadCallback はそのタブ専用（値を閉じ込める）。1ノードで使い回すと
    // どれを押しても同じ値が飛ぶので、必ずタブごとに登録する。
    // タブ構成が変わると要素が作り直されるため、依存配列にタブ定義を入れて再登録する。
    const tabRefs = useRef(new Map());
    const [listenerNote, setListenerNote] = useState('');

    const tabsKey = tabs.map((t) => `${t.id}|${t.label}|${t.value}`).join(',');

    useEffect(() => {
        let ok = 0;
        let lastErr = null;

        tabs.forEach((tab, i) => {
            const node = tabRefs.current.get(tab.id);
            if (!node) return;
            try {
                addDrilldownListener({
                    node,
                    action: 'tab.click',
                    payloadCallback: () => ({
                        // インタラクション設定で $name$ / $value$ 相当として参照される値
                        name: 'tab',
                        value: tab.value,
                        // フィールド指定のインタラクションから参照できるよう行形式でも載せる
                        'row.tab.value': tab.value,
                        'row.label.value': tab.label,
                        'row.index.value': i + 1,
                        data: { tab: tab.value, label: tab.label, index: i + 1 },
                    }),
                });
                ok += 1;
            } catch (err) {
                lastErr = err;
            }
        });

        setListenerNote(lastErr ? `登録に失敗: ${lastErr.message}` : `${ok} タブを登録`);
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabsKey]);

    const justify = opts.align === 'center' ? 'center' : opts.align === 'right' ? 'flex-end' : 'flex-start';

    // --- スライドインジケータ ---
    //
    // この viz の「らしさ」を担う部分。選択中のタブを個別に塗るのではなく、
    // **1枚のインジケータが選択タブへ滑って移動する**。タブ群が連続した1つの
    // 部品として振る舞い、どこからどこへ移ったかが目で追える。
    //
    // 位置は実測（offsetLeft/offsetWidth）でしか出せない（文字幅が可変なため）ので、
    // レイアウト後に測って state に入れる。測れるまでは非表示にしてチラつきを防ぐ。
    const listRef = useRef(null);
    const [indicator, setIndicator] = useState(null);
    // 初回だけはアニメーションさせない（マウント時に左端から滑ってくるのを防ぐ）
    const hasMeasuredRef = useRef(false);

    const measureIndicator = useCallback(() => {
        const list = listRef.current;
        const node = selectedId ? tabRefs.current.get(selectedId) : null;
        if (!list || !node) {
            setIndicator(null);
            return;
        }
        const left = node.offsetLeft;
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        const top = node.offsetTop;
        if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) {
            setIndicator(null);
            return;
        }
        setIndicator({ left, width, top, height, animate: hasMeasuredRef.current });
        hasMeasuredRef.current = true;
    }, [selectedId]);

    // 選択・タブ構成・見た目オプションが変わったら測り直す
    useEffect(() => {
        measureIndicator();
    }, [measureIndicator, tabsKey, opts.fontSize, opts.stretch, opts.align, opts.tabStyle, opts.showTokenHint]);

    // パネルのリサイズ（幅が変わると位置が動く）に追従する
    useEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => measureIndicator());
        ro.observe(list);
        return () => ro.disconnect();
    }, [measureIndicator]);

    // 角丸は形ごとに1か所で決める（インジケータとタブで必ず一致させるため）
    const radius = opts.tabStyle === 'pill' ? 999 : opts.tabStyle === 'underline' ? 0 : 6;
    // 走行レーンを敷くか（塗り系はレーンがあると「群」としてまとまる）
    const hasTrack = isSolid;

    /**
     * タブ1つ分の見た目。
     *
     * 選択中の塗り・下線・枠線は**インジケータ側が描く**ので、ここでは描かない。
     * ボタン自身は文字色とホバーだけを持つ（＝重ね塗りによるズレが起きない）。
     *
     * ⚠ border は shorthand（borderWidth）と個別指定（borderBottomWidth）を混ぜない。
     * 混ぜると React が「Removing a style property during rerender」を警告し、
     * 形状オプションを切り替えたときに前の枠線が残る等の描画バグになる。
     */
    function tabStyleFor(isActive, isHover) {
        return {
            appearance: 'none',
            font: 'inherit',
            fontSize: opts.fontSize,
            // 選択で太さが変わると幅が動いてインジケータがズレるため、
            // 太さは固定して「色」で選択を表す
            fontWeight: 500,
            letterSpacing: '0.01em',
            lineHeight: 1.2,
            padding: opts.tabStyle === 'underline' ? '9px 16px 10px' : '9px 18px',
            cursor: 'pointer',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            transition: 'color 180ms cubic-bezier(0.4, 0, 0.2, 1), opacity 180ms ease',
            flex: opts.stretch ? '1 1 0' : '0 0 auto',
            textAlign: 'center',
            borderStyle: 'solid',
            borderTopWidth: 0,
            borderRightWidth: 0,
            borderBottomWidth: 0,
            borderLeftWidth: 0,
            borderTopColor: 'transparent',
            borderRightColor: 'transparent',
            borderBottomColor: 'transparent',
            borderLeftColor: 'transparent',
            // ホバーは「うっすら浮く」程度に留める。主役はインジケータ。
            backgroundColor: !isActive && isHover ? palette.hover : 'transparent',
            color: isActive ? activeText : inactiveText,
            opacity: isActive || isHover ? 1 : 0.82,
            borderRadius: radius,
            minWidth: 0,
            position: 'relative',
            zIndex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        };
    }

    /** スライドインジケータの見た目（形ごとに姿を変える） */
    function indicatorStyle() {
        if (!indicator) return { opacity: 0 };
        const common = {
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: 0,
            // 位置・サイズだけをアニメーションさせる。初回は動かさない。
            transition: indicator.animate
                ? 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1), width 320ms cubic-bezier(0.22, 1, 0.36, 1), background-color 200ms ease, box-shadow 200ms ease'
                : 'none',
            transform: `translateX(${indicator.left}px)`,
            width: indicator.width,
            left: 0,
        };

        if (opts.tabStyle === 'underline') {
            // 下線は「文字幅ぶんの短い線」にすると軽快に見える
            return {
                ...common,
                top: indicator.top + indicator.height - 2,
                height: 2,
                borderRadius: 2,
                backgroundColor: opts.accentColor,
                boxShadow: `0 0 10px ${withAlpha(opts.accentColor, 0.55)}`,
            };
        }
        if (opts.tabStyle === 'outline') {
            return {
                ...common,
                top: indicator.top,
                height: indicator.height,
                borderRadius: radius,
                backgroundColor: withAlpha(opts.accentColor, isDark ? 0.14 : 0.09),
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: opts.accentColor,
                boxSizing: 'border-box',
            };
        }
        // filled / pill：アクセント色のカプセルが滑る
        return {
            ...common,
            top: indicator.top,
            height: indicator.height,
            borderRadius: radius,
            backgroundColor: opts.accentColor,
            boxShadow: `0 1px 2px ${withAlpha('#000000', isDark ? 0.5 : 0.16)}, 0 0 0 1px ${withAlpha(opts.accentColor, 0.35)}`,
        };
    }

    // タブ未設定のときは空パネルにせず、何をすればよいかを示す。
    // （タブの中身はユーザーが決めるものなので、既定のサンプルは埋め込まない）
    if (tabs.length === 0) {
        return (
            <div
                className="viz-container"
                style={{
                    width: '100%',
                    height: '100%',
                    boxSizing: 'border-box',
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    color: palette.sub,
                }}
                data-role="tab-selector"
                data-empty="true"
                data-version={VIZ_VERSION}
            >
                {/* 空状態も「タブの形」で見せる。何が置かれる場所なのかが一目で分かる。 */}
                <div
                    aria-hidden="true"
                    style={{
                        display: 'flex',
                        gap: 4,
                        padding: 4,
                        marginBottom: 12,
                        borderRadius: 9,
                        backgroundColor: palette.trackBg,
                    }}
                >
                    {[52, 40, 46].map((w, i) => (
                        <span
                            key={w}
                            style={{
                                width: w,
                                height: 20,
                                borderRadius: 6,
                                backgroundColor: i === 0 ? withAlpha(opts.accentColor, 0.35) : palette.hover,
                                borderWidth: 1,
                                borderStyle: 'dashed',
                                borderColor: i === 0 ? withAlpha(opts.accentColor, 0.5) : palette.border,
                                boxSizing: 'border-box',
                            }}
                        />
                    ))}
                </div>
                <div style={{ fontSize: 13, marginBottom: 4, color: palette.fg, fontWeight: 500 }}>
                    タブが設定されていません。
                </div>
                <div style={{ fontSize: 11, opacity: 0.8, lineHeight: 1.6 }}>
                    編集パネルの「タブ」→「タブ一覧」に
                    <br />
                    「表示名|トークン値」を1行ずつ入力してください。
                </div>
            </div>
        );
    }

    return (
        <div
            className="viz-container"
            style={{
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                padding: 8,
                overflow: 'auto',
                color: palette.fg,
            }}
            data-role="tab-selector"
            data-version={VIZ_VERSION}
        >
            <div
                role="tablist"
                ref={listRef}
                style={{
                    position: 'relative',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'stretch',
                    justifyContent: opts.stretch ? 'stretch' : justify,
                    gap: opts.tabStyle === 'underline' ? 2 : 4,
                    // 塗り系はレーンで囲って「1つの部品」に見せる
                    padding: hasTrack ? 4 : 0,
                    backgroundColor: hasTrack ? palette.trackBg : 'transparent',
                    borderRadius: hasTrack ? (opts.tabStyle === 'pill' ? 999 : 9) : 0,
                    borderBottomWidth: opts.tabStyle === 'underline' ? 1 : 0,
                    borderBottomStyle: 'solid',
                    borderBottomColor: opts.tabStyle === 'underline' ? palette.border : 'transparent',
                }}
            >
                {/* 選択中を示す1枚のインジケータ。タブ間を滑って移動する。 */}
                <span aria-hidden="true" data-role="indicator" style={indicatorStyle()} />

                {tabs.map((tab, i) => {
                    const isActive = tab.id === selectedId;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            data-role="tab"
                            data-index={i}
                            data-value={tab.value}
                            data-active={isActive ? 'true' : 'false'}
                            ref={(el) => {
                                // addDrilldownListener に登録するため要素を集める
                                if (el) tabRefs.current.set(tab.id, el);
                                else tabRefs.current.delete(tab.id);
                            }}
                            // クリック時の見た目の切替は viz 側の責務。
                            // トークン設定そのものは addDrilldownListener 経由でホストが行う。
                            onClick={() => setSelectedId(tab.id)}
                            // 矢印キーで隣のタブへ移動できるようにする（tablist の作法）。
                            // ただし**トークンを設定するのはホストで、発火はクリックのみ**なので、
                            // キー操作では選択を動かしたうえで実際に click() を発火させる。
                            onKeyDown={(e) => {
                                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                                e.preventDefault();
                                const dir = e.key === 'ArrowRight' ? 1 : -1;
                                const next = tabs[(i + dir + tabs.length) % tabs.length];
                                const nextNode = next && tabRefs.current.get(next.id);
                                if (nextNode) {
                                    nextNode.focus();
                                    nextNode.click();
                                }
                            }}
                            onMouseEnter={() => setHoverId(tab.id)}
                            onMouseLeave={() => setHoverId((prev) => (prev === tab.id ? null : prev))}
                            onFocus={() => setHoverId(tab.id)}
                            onBlur={() => setHoverId((prev) => (prev === tab.id ? null : prev))}
                            tabIndex={isActive ? 0 : -1}
                            style={tabStyleFor(isActive, hoverId === tab.id)}
                            title={opts.showTokenHint ? undefined : `トークン値: ${tab.value}`}
                        >
                            {tab.label}
                            {opts.showTokenHint && (
                                <span style={{ marginLeft: 6, opacity: 0.65, fontSize: Math.max(9, opts.fontSize - 3), fontWeight: 400 }}>
                                    {tab.value}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* 登録状況は画面には出さない（タブバーだけを見せる）。
                ローカル検証や実機のデバッグで参照できるよう属性としてだけ持たせる。 */}
            <span data-role="listener-note" data-note={listenerNote} style={{ display: 'none' }} />
        </div>
    );
}

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 未取得でも light で必ず描画する
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <TabSelector mode={mode} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ等の初期 state 受信）を待ってからマウントする。
// 公式フックは購読登録時に現在値を再送しないため、初期 state を取り逃すと描画されない。
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme);
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
