import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// ── DPX 共通 UI 部品 ─────────────────────────────────────────────
// インスペクタ・入力バー・ホーム画面が共有する部品。ネイティブの
// <select> はダーク UI から浮く（OS 既定の白いポップアップが出る）ため、
// 自前のドロップダウンを使う。スクロールバーも同様に自前化する。
// ────────────────────────────────────────────────────────────────

/** グローバル CSS（地の色・スクロールバー・フォーカスリング）をテーマに追随させる。
 *
 *  ⚠ `pages/dpx/bootPaint.js` が起動時に `html, body { background: #0a1020 !important }`
 *    を当てている（白フラッシュ対策。JS より先に地を暗くする必要があるため）。
 *    それを消さないと、**ライト系プリセットでも body だけ濃紺のまま**になり、
 *    オーバースクロール・ズーム・コンテンツが短いときに黒帯として見える（実機で確認）。
 *    → テーマが確定したらこちらで上書きする（同じ !important で後勝ちにする）。 */
export function useDpxGlobalStyles(theme) {
    useEffect(() => {
        const id = 'dpx-global-ui-css';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        const accent = theme?.accent ?? '#4ea1ff';
        // canvasBg はグラデーションのことがある。
        // ⚠ 一括の `background` は **background-color を初期値（transparent）に戻す**ので、
        //   後ろに書くと下地の単色が消える（グラデーションの透明部分が抜けて素の白が出る）。
        //   必ず「background（一括）→ background-color」の順で、色を後勝ちにする。
        const canvas = theme?.canvasBg ?? '#0a1020';
        // 下地はプリセット自身の地の色を使う（canvasBg が単色ならそれ、
        // グラデーションなら明暗に応じた既定）。プリセットごとの微妙な色味を保つ。
        const base = /^#|^rgb/.test(canvas)
            ? canvas
            : (theme?.colorScheme === 'light' ? '#f4f6fa' : '#0a1020');
        el.textContent = `
            html, body {
                background: ${canvas} !important;
                background-color: ${base} !important;
                color: ${theme?.titleColor ?? '#e8eefc'};
            }
            .dpx-scroll { scrollbar-width: thin; scrollbar-color: ${accent}66 transparent; }
            .dpx-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
            .dpx-scroll::-webkit-scrollbar-track { background: transparent; }
            .dpx-scroll::-webkit-scrollbar-thumb {
                background: ${accent}55; border-radius: 6px; border: 2px solid transparent; background-clip: content-box;
            }
            .dpx-scroll::-webkit-scrollbar-thumb:hover { background: ${accent}99; background-clip: content-box; }
            .dpx-scroll::-webkit-scrollbar-corner { background: transparent; }
            /* ── 入力コントロールの質感 ──────────────────────────────
               「板に線を1本引いただけ」だと安っぽく見えるので、
               **奥行き（内側の細いハイライト＋落ち影）** と
               **状態の差（hover / focus）** を付ける。
               ⚠ ただし box-shadow を **animate はしない**（毎フレーム再描画になる）。
                 transition は色と影の「切り替わり」だけに使う。 */
            .dpx-input {
                box-shadow: ${
                    theme?.colorScheme === 'light'
                        ? 'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(16,24,40,0.06)'
                        : 'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.35)'
                };
                transition: border-color .13s ease, box-shadow .13s ease, background-color .13s ease;
            }
            .dpx-input:hover:not(:disabled) {
                border-color: ${accent}66;
            }
            /* ⚠ outline は角丸に沿わないので box-shadow でリングを作る
                 （2px の矩形アウトラインが丸角からはみ出して安っぽく見えた） */
            .dpx-input:focus, .dpx-input:focus-visible {
                outline: none;
                border-color: ${accent};
                box-shadow: 0 0 0 3px ${accent}2e, inset 0 1px 0 rgba(255,255,255,0.06);
            }
            .dpx-input::placeholder { color: ${theme?.subColor ?? '#8fa3c8'}; opacity: .65; }
            .dpx-btn {
                transition: border-color .13s ease, box-shadow .13s ease, background-color .13s ease, transform .08s ease;
            }
            .dpx-btn:hover:not(:disabled) { border-color: ${accent}88; }
            /* 押した瞬間の手応え（1px 沈む）。transform なので合成だけで済む */
            .dpx-btn:active:not(:disabled) { transform: translateY(1px); }
            .dpx-btn:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px ${accent}2e;
            }
        `;
        // ⚠ accent だけを見ていると、**accent が同じで地の色だけ違うプリセット**に
        //   切り替えたときに再実行されず、body が前のテーマのままになる。
    }, [theme?.accent, theme?.canvasBg, theme?.colorScheme, theme?.titleColor, theme?.subColor]);
}

/** 入力コントロールの共通の高さ（px）。
 *  ⚠ padding 任せにすると型ごとに 1〜3px ずれて、入力バーに横並びしたとき
 *    下端が揃わない（実機で確認）。高さは必ずここで固定する。
 *    textarea など複数行のものだけ height を上書きしてよい。 */
export const CONTROL_H = 30;

export const inputStyle = (t) => ({
    width: '100%',
    height: CONTROL_H,
    boxSizing: 'border-box',
    // ⚠ 黒の半透明を固定で敷くと、ライト系プリセットで
    //   「明るい地に灰色の入力欄＋濃い文字」になり読みづらい（実機で確認）。
    //   明るいテーマでは白地＋濃いめの枠にする。
    background: t?.colorScheme === 'light' ? '#ffffff' : 'rgba(0,0,0,0.28)',
    border: `1px solid ${t?.colorScheme === 'light' ? 'rgba(20,24,31,0.22)' : 'rgba(140,175,235,0.28)'}`,
    borderRadius: 6,
    color: t.titleColor,
    padding: '0 9px',
    fontSize: 12,
    fontFamily: 'inherit',
    outline: 'none',
});

/** ラベル＋コントロールの1行。ラベルは上、コントロールは幅いっぱい（見切れ防止）。 */
export function Field({ t, label, hint, children, inline = false }) {
    if (inline) {
        return (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
                {children}
                <span style={{ fontSize: 12, color: t.titleColor }}>{label}</span>
            </label>
        );
    }
    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: t.subColor, marginBottom: 4 }}>{label}</div>
            {children}
            {hint ? <div style={{ fontSize: 10, color: t.subColor, marginTop: 3, opacity: 0.8 }}>{hint}</div> : null}
        </div>
    );
}

/** 折りたためるセクション。見出しは読める明度で出す（旧 UI は暗すぎた）。 */
export function Section({ t, title, children, defaultOpen = true, right }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div style={{ borderBottom: '1px solid rgba(140,175,235,0.14)' }}>
            <button
                type="button"
                className="dpx-btn"
                onClick={() => setOpen((o) => !o)}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    background: 'rgba(255,255,255,0.03)',
                    border: 'none',
                    color: t.titleColor,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    cursor: 'pointer',
                    textAlign: 'left',
                }}
            >
                <span style={{ color: t.accent, fontSize: 9, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    ▶
                </span>
                {title}
                <span style={{ flex: 1 }} />
                {right}
            </button>
            {open ? <div style={{ padding: '4px 14px 14px' }}>{children}</div> : null}
        </div>
    );
}

/** 自前ドロップダウン。ネイティブ select の OS 既定ポップアップを避ける。
 *  ポップアップは position:fixed（親の overflow に切られない＝見切れない）。 */
export function Select({ t, value, options, onChange, placeholder = '選択…' }) {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState(null);
    const btnRef = useRef(null);
    const popRef = useRef(null);
    const current = options.find((o) => String(o.value) === String(value));

    useLayoutEffect(() => {
        if (!open || !btnRef.current) return;
        setRect(btnRef.current.getBoundingClientRect());
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        // ⚠ ポップアップは position:fixed で body 直下相当の位置に描かれるが、
        //    React ツリー上はここの子。DOM 上はトリガーの外なので、
        //    ポップアップ自身も「外側クリック」の除外対象に入れないと、
        //    項目クリックが「外側」と判定されて閉じるだけで終わる
        //    （実機で発生：選んでも値が変わらない）。
        const close = (e) => {
            if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e) => e.key === 'Escape' && setOpen(false);
        const onScroll = (e) => {
            // ポップアップ内のスクロールでは閉じない
            if (popRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            window.removeEventListener('pointerdown', close, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open]);

    // グループ化（option に group がある場合）
    const groups = [];
    for (const o of options) {
        const g = o.group ?? '';
        let bucket = groups.find((x) => x.name === g);
        if (!bucket) {
            bucket = { name: g, items: [] };
            groups.push(bucket);
        }
        bucket.items.push(o);
    }

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="dpx-input dpx-btn"
                onClick={() => setOpen((o) => !o)}
                style={{
                    ...inputStyle(t),
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                }}
            >
                <span
                    style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        opacity: current ? 1 : 0.5,
                    }}
                >
                    {current?.label ?? placeholder}
                </span>
                <span style={{ color: t.accent, fontSize: 9 }}>▼</span>
            </button>
            {open && rect ? (
                <div
                    ref={popRef}
                    className="dpx-scroll"
                    style={{
                        position: 'fixed',
                        left: rect.left,
                        top: Math.min(rect.bottom + 4, window.innerHeight - 240),
                        width: rect.width,
                        maxHeight: 260,
                        overflowY: 'auto',
                        background: t.colorScheme === 'light' ? '#ffffff' : '#111a2e',
                        border: `1px solid ${t.accent}55`,
                        borderRadius: 8,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                        zIndex: 10000,
                        padding: 4,
                    }}
                >
                    {groups.map((g) => (
                        <div key={g.name}>
                            {g.name ? (
                                <div style={{ fontSize: 10, color: t.subColor, padding: '6px 8px 3px', letterSpacing: '0.08em' }}>
                                    {g.name}
                                </div>
                            ) : null}
                            {g.items.map((o) => {
                                const selected = String(o.value) === String(value);
                                return (
                                    <button
                                        key={String(o.value)}
                                        type="button"
                                        onClick={() => {
                                            onChange(o.value);
                                            setOpen(false);
                                        }}
                                        style={{
                                            display: 'block',
                                            width: '100%',
                                            textAlign: 'left',
                                            padding: '6px 8px',
                                            background: selected ? `${t.accent}22` : 'transparent',
                                            border: 'none',
                                            borderRadius: 5,
                                            color: selected ? t.accent : t.titleColor,
                                            fontSize: 12,
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = selected ? `${t.accent}33` : 'rgba(140,175,235,0.12)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = selected ? `${t.accent}22` : 'transparent';
                                        }}
                                    >
                                        {o.label}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            ) : null}
        </>
    );
}

/** テキスト入力。
 *  - 打鍵ごとに即反映（プレビューが遅れない）。ただし **IME 変換中は反映しない**
 *    （composition 中に確定させると日本語入力が壊れる）
 *  - 外部から value が変わったら追従する（テンプレ切替・タブ切替など）
 *  - クリアボタン付き
 */
export function TextInput({ t, value, onChange, placeholder, mono = false, clearable = true }) {
    const [draft, setDraft] = useState(value ?? '');
    const composing = useRef(false);
    const lastPropValue = useRef(value);

    useEffect(() => {
        // 自分の編集で親が更新した場合は書き戻さない（カーソルが飛ぶため）
        if (value !== lastPropValue.current) {
            lastPropValue.current = value;
            setDraft(value ?? '');
        }
    }, [value]);

    const commit = (v) => {
        lastPropValue.current = v;
        onChange(v);
    };

    return (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
                className="dpx-input"
                style={{
                    ...inputStyle(t),
                    fontFamily: mono ? 'Menlo, Consolas, monospace' : 'inherit',
                    paddingRight: clearable && draft ? 26 : 9,
                }}
                value={draft}
                placeholder={placeholder}
                onCompositionStart={() => {
                    composing.current = true;
                }}
                onCompositionEnd={(e) => {
                    composing.current = false;
                    setDraft(e.target.value);
                    commit(e.target.value);
                }}
                onChange={(e) => {
                    setDraft(e.target.value);
                    if (!composing.current) commit(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                        setDraft(value ?? '');
                        commit(value ?? '');
                        e.currentTarget.blur();
                    }
                }}
            />
            {clearable && draft ? (
                <button
                    type="button"
                    onClick={() => {
                        setDraft('');
                        commit('');
                    }}
                    title="クリア"
                    style={{
                        position: 'absolute',
                        right: 4,
                        width: 18,
                        height: 18,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 9,
                        border: 'none',
                        background: 'rgba(140,175,235,0.18)',
                        color: t.subColor,
                        fontSize: 11,
                        lineHeight: 1,
                        cursor: 'pointer',
                        padding: 0,
                    }}
                >
                    ×
                </button>
            ) : null}
        </div>
    );
}

export function NumberInput({ t, value, onChange, min, max, step }) {
    return (
        <input
            className="dpx-input"
            type="number"
            style={inputStyle(t)}
            value={value ?? ''}
            min={min}
            max={max}
            step={step}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
    );
}

export function Toggle({ t, checked, onChange, disabled }) {
    return (
        <button
            type="button"
            className="dpx-btn"
            disabled={disabled}
            onClick={() => onChange(!checked)}
            style={{
                width: 36,
                height: 20,
                flex: 'none',
                borderRadius: 10,
                border: `1px solid ${checked ? t.accent : 'rgba(140,175,235,0.35)'}`,
                background: checked ? `${t.accent}55` : 'rgba(0,0,0,0.3)',
                position: 'relative',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                padding: 0,
                transition: 'background 0.15s',
            }}
        >
            <span
                style={{
                    position: 'absolute',
                    top: 2,
                    left: checked ? 18 : 2,
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    background: checked ? t.accent : 'rgba(200,215,240,0.7)',
                    transition: 'left 0.15s',
                }}
            />
        </button>
    );
}

/** 透明を表す市松模様（透明色そのものは色として表示できないため）。 */
const CHECKERBOARD =
    'linear-gradient(45deg, #8b98a5 25%, transparent 25%, transparent 75%, #8b98a5 75%),' +
    'linear-gradient(45deg, #8b98a5 25%, transparent 25%, transparent 75%, #8b98a5 75%)';

/** その色指定が「透明」か。CSS の transparent と α=0 の rgba を拾う。 */
export function isTransparent(value) {
    if (typeof value !== 'string') return false;
    const s = value.trim().toLowerCase();
    if (s === 'transparent' || s === 'none') return true;
    // rgba(…, 0) / hsla(…, 0) と #rrggbb00・#rgb0（8桁/4桁の α=0）
    const m = /^(?:rgba|hsla)\([^)]*,\s*(0|0?\.0+)\s*\)$/.exec(s);
    if (m) return true;
    return /^#[0-9a-f]{6}00$/.test(s) || /^#[0-9a-f]{3}0$/.test(s);
}

/**
 * 色の入力欄。ネイティブのカラーピッカー＋自由入力に加えて
 * **「透明」ボタン**を持つ（`transparent` は type="color" では選べないため）。
 *
 * ⚠ 透明のときはピッカーに fallback 色が出てしまうので、市松模様のプレビューに
 *   差し替える（そうしないと「透明にしたのに色が付いて見える」と誤解される）。
 *
 * ⚠ **未設定のときは「実際に適用されている色」を見せる。**
 *   `<input type="color">` は空値を持てず、何を渡しても必ず色が表示される。
 *   以前は既定値 `#4ea1ff` を渡していたため、
 *   **「背景色に #4ea1ff が設定されている」と誤解させていた**（実機で確認）。
 *   → 呼び出し側から **`effective`（＝いま実際に効いている色）** を受け取り、
 *   未設定のときはその色をスウォッチに出す。**UI の見た目と実物が一致する。**
 *   未設定であることは**枠を破線にし、入力欄に実効値をグレーで示す**ことで伝える
 *   （「指定済み」と混同させない）。
 *
 * @param fallback 「透明を解除したとき」の戻り先。
 * @param effective 未設定のときに**実際に適用されている色**（CSS 色文字列）。
 *                 `'none'` を渡すと「枠線なし」のように**色が無いのが実効値**だと示す。
 *                 省略すると従来どおり `fallback` を表示する。
 * @param allowUnset 未設定状態を許すか。既定 true。
 *                 `false` は「必ず値が入る欄」（ダッシュボードのアクセント色など）。
 */
export function ColorInput({ t, value, onChange, fallback = '#4ea1ff', effective, allowUnset = true }) {
    const transparent = isTransparent(value);
    // 「何も入っていない」＝プリセット任せ。透明（明示的な指定）とは別物。
    const unset = allowUnset && !transparent && !(typeof value === 'string' && value.trim() !== '');
    // 未設定のときスウォッチに出す色＝いま実際に効いている色
    const effColor = effective ?? fallback;
    const effNone = effColor === 'none';
    // ⚠ fallback 自体が透明になりうる（呼び出し側が `fallback={t.accent}` を渡し、
    //    その accent は `style.accent || preset.accent` で解決されるため、
    //    accent を透明にすると fallback も透明になる＝**透明を解除できなくなる**。
    //    実機で発生）。透明解除の戻り先は必ず不透明な色にする。
    // 透明を解除したときの戻り先。fallback 自体が透明なら（＝呼び出し側が
    // テーマ値を渡していて、そのテーマ値が透明になっている）テーマの
    // アクセント、それも駄目なら固定色まで落とす。
    const safeFallback = !isTransparent(fallback)
        ? fallback
        : !isTransparent(t?.accent)
          ? t.accent
          : '#4ea1ff';
    const v = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : safeFallback;
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {unset ? (
                // 未設定：**いま実際に効いている色**をそのまま出す（UI と実物を一致させる）。
                // 「指定済み」と区別するため、枠を破線にする。押すとその色で確定できる。
                <button
                    type="button"
                    title={
                        effNone
                            ? '現在は枠線なし（未設定）。押すと色を指定できます'
                            : `現在の実効値 ${effColor}（未設定＝プリセットのまま）。押すとこの色で確定します`
                    }
                    onClick={() => onChange(effNone ? safeFallback : effColor)}
                    style={{
                        width: 34,
                        height: 26,
                        flex: 'none',
                        padding: 0,
                        // 破線＝「まだ自分で指定していない」印
                        border: '1px dashed rgba(140,175,235,0.55)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        // 実効値が「無し」のときだけ斜線、それ以外は実際の色を塗る
                        background: effNone
                            ? 'linear-gradient(to top right, transparent calc(50% - 1px), rgba(140,175,235,0.55) calc(50% - 1px), rgba(140,175,235,0.55) calc(50% + 1px), transparent calc(50% + 1px))'
                            : effColor,
                    }}
                />
            ) : transparent ? (
                // 透明中はピッカーを出さず、市松模様を見せる。押すと通常の色へ戻す
                <button
                    type="button"
                    title="色を選ぶ（透明を解除）"
                    onClick={() => onChange(safeFallback)}
                    style={{
                        width: 34,
                        height: 26,
                        flex: 'none',
                        padding: 0,
                        border: '1px solid rgba(140,175,235,0.28)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: CHECKERBOARD,
                        backgroundSize: '8px 8px',
                        backgroundPosition: '0 0, 4px 4px',
                        backgroundColor: '#2a3242',
                    }}
                />
            ) : (
                <input
                    type="color"
                    value={v}
                    onChange={(e) => onChange(e.target.value)}
                    style={{
                        width: 34,
                        height: 26,
                        flex: 'none',
                        padding: 0,
                        border: '1px solid rgba(140,175,235,0.28)',
                        borderRadius: 6,
                        background: 'transparent',
                        cursor: 'pointer',
                    }}
                />
            )}
            <input
                className="dpx-input"
                style={{ ...inputStyle(t), fontFamily: 'Menlo, Consolas, monospace' }}
                value={value ?? ''}
                // 空欄には**いま実際に効いている値**を出す。
                // 「（既定）」のような一般名だと、何が適用されているのか分からない
                placeholder={
                    !allowUnset
                        ? '（既定）'
                        : effNone
                          ? 'なし（枠線を引かない）'
                          : `${effColor}（プリセットのまま）`
                }
                onChange={(e) => onChange(e.target.value)}
            />
            {/* 指定済みのときだけ「未設定へ戻す」を出す（元に戻す手段が無いと詰む） */}
            {allowUnset && !unset ? (
                <button
                    type="button"
                    title="未設定に戻す（プリセットのままにする）"
                    onClick={() => onChange('')}
                    style={{
                        flex: 'none',
                        height: 26,
                        width: 26,
                        padding: 0,
                        borderRadius: 6,
                        border: '1px solid rgba(140,175,235,0.28)',
                        background: 'transparent',
                        color: t.subColor,
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: 1,
                        fontFamily: 'inherit',
                    }}
                >
                    ×
                </button>
            ) : null}
            {/* 透明はカラーピッカーで選べないので専用ボタンを置く */}
            <button
                type="button"
                title={transparent ? '透明を解除' : '透明にする'}
                aria-pressed={transparent}
                onClick={() => onChange(transparent ? safeFallback : 'transparent')}
                style={{
                    flex: 'none',
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: `1px solid ${transparent ? t.accent : 'rgba(140,175,235,0.28)'}`,
                    background: transparent ? `${t.accent}22` : 'transparent',
                    color: transparent ? t.accent : t.subColor,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                }}
            >
                透明
            </button>
        </div>
    );
}

export function Slider({ t, value, onChange, min = 0, max = 1, step = 0.1 }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value ?? min}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{ flex: 1, accentColor: t.accent }}
            />
            <span style={{ fontSize: 11, color: t.subColor, width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {value ?? min}
            </span>
        </div>
    );
}

export function Button({ t, label, onClick, kind = 'default', disabled, full }) {
    const bg =
        kind === 'primary' ? t.accent : kind === 'danger' ? 'rgba(220,70,90,0.9)' : 'transparent';
    const border = kind === 'default' ? `1px solid ${t.accent}66` : 'none';
    return (
        <button
            type="button"
            className="dpx-btn"
            disabled={disabled}
            onClick={onClick}
            style={{
                background: bg,
                border,
                borderRadius: 6,
                color: kind === 'default' ? t.titleColor : '#fff',
                padding: '7px 12px',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : 1,
                width: full ? '100%' : undefined,
            }}
        >
            {label}
        </button>
    );
}
