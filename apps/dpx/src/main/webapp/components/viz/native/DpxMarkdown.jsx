import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
    applyFieldValues,
    applyTokens,
    optionalExcept,
    useDpxTheme,
    useDpxTokens,
    useVizData,
} from '..';

// ── dpx.markdown（リッチテキスト）────────────────────────────────
//
// **サーチ不要**（データソースを繋げば `$列名$` で値も差し込める）。
//
// ## なぜ作るのか（Studio の markdown との差）
//
// **実測（2026-08-15・Studio のバンドルから schema を抽出）**:
// `splunk.markdown` のオプションは **4 つだけ**で、説明文にも
// 「Add text using **basic** markdown syntax」と書かれている。
//
// | | splunk.markdown | dpx.markdown |
// |---|---|---|
// | オプション | `markdown` / `fontSize` / `fontFamily` / `rotation` の **4 つ** | 下記 |
// | 表・打ち消し線・チェックリスト | **GFM 非対応**（basic のみ） | ✅ `remark-gfm` |
// | サーチ結果の差し込み | ✗ | ✅ `$列名$`（1 行目の値） |
// | トークン展開 | ✅（`$tok$`） | ✅ 同じ |
// | テーマ連動の配色 | ✗（固定色） | ✅ プリセットの配色に追従 |
// | 表示密度・最大幅・配置 | ✗ | ✅ |
//
// ⚠ **HTML は通さない**（`react-markdown` は既定で生 HTML を無効化する）。
//   ダッシュボード定義は編集権限があれば誰でも書けるので、
//   **HTML を許すと XSS の入口になる**。表現力は GFM の範囲で足りる。
//
// ⚠ **`rotation` は作らない**（Studio にはあるが、回転した本文は読めない。
//   意匠として傾けたいなら図形 viz を重ねるほうが素直）。
// ────────────────────────────────────────────────────────────────

/** 本文の基準サイズ（px）。行間・見出しは全部ここからの相対で決める。 */
const SIZES = { xs: 11, s: 12, m: 14, l: 16, xl: 20 };

export function DpxMarkdown({ dataSources, options = {}, height, width }) {
    const t = useDpxTheme();
    const { tokens } = useDpxTokens();
    const d = useVizData(dataSources);

    const size = SIZES[options.fontSize] ?? SIZES.m;
    const src = String(options.markdown ?? '');

    // トークン → 列の値、の順で差し込む
    const text = React.useMemo(() => {
        // ⚠ **`applyTokens` は `{text, missing}` を返す**（文字列ではない）。
        //   ここで `.text` を取り忘れると "[object Object]" が本文に出る。
        // ⚠ 第3引数は「未設定でも空にしてよいトークン名の Set」。
        //   本文は SPL ではないので**未設定は空文字**でよい（描画を止めない）。
        // ⚠ 列名と「知らない名前」は optional に入れない
        //   （入れると列の差し込みより先に空文字化され、綴り間違いも消える）
        const tok = tokens ?? {};
        const withTokens = applyTokens(src, tok, optionalExcept(d.fieldNames, tok)).text;
        if (d.isEmpty) return withTokens;
        const firstRow = d.columns.map((c) => (Array.isArray(c) ? c[0] : undefined));
        return applyFieldValues(withTokens, d.fieldNames, firstRow);
    }, [src, tokens, d]);

    const h = typeof height === 'number' ? height : undefined;
    const align = options.align || 'left';
    const maxW = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : null;

    // ⚠ 見出し・表・コードの色は**テーマから引く**。決め打ちにすると
    //   ライト系プリセットで文字が消える（§8 の再発防止）。
    const css = `
        /* ⚠⚠ **子要素にも明示的に色を指定する。**
           Splunk のページ側に h1, p への白指定という**インラインの
           グローバル CSS** があり（DPX の外・変更できない）、
           .dpx-md にだけ色を置くと **p だけ白のまま**になって
           ライト系テーマで本文が消える（実機で発生。太字だけ読めるので
           「行が重なっている」ように見えて誤診しやすい）。
           継承に頼らず、**テキストを持つ要素すべてに効くセレクタ**で上書きする。 */
        .dpx-md,
        .dpx-md p, .dpx-md li, .dpx-md td, .dpx-md span, .dpx-md div {
            color: ${t.textColor || t.titleColor};
        }
        .dpx-md { font-size: ${size}px; line-height: 1.75; }
        .dpx-md > *:first-child { margin-top: 0; }
        .dpx-md > *:last-child { margin-bottom: 0; }
        .dpx-md h1, .dpx-md h2, .dpx-md h3, .dpx-md h4 {
            color: ${t.titleColor}; line-height: 1.35; margin: 1.1em 0 0.5em;
            font-weight: 700; letter-spacing: 0.01em;
        }
        .dpx-md h1 { font-size: ${Math.round(size * 1.9)}px; }
        .dpx-md h2 { font-size: ${Math.round(size * 1.5)}px; }
        .dpx-md h3 { font-size: ${Math.round(size * 1.22)}px; }
        .dpx-md h4 { font-size: ${Math.round(size * 1.06)}px; }
        /* 見出しの下線は h1/h2 だけ（全部に引くと圧が強い） */
        .dpx-md h1, .dpx-md h2 { border-bottom: 1px solid ${t.accent}33; padding-bottom: 0.28em; }
        .dpx-md p { margin: 0.65em 0; }
        .dpx-md a { color: ${t.accent}; text-decoration: underline; text-underline-offset: 2px; }
        .dpx-md strong { color: ${t.titleColor}; font-weight: 700; }
        .dpx-md ul, .dpx-md ol { margin: 0.6em 0; padding-left: 1.5em; }
        .dpx-md li { margin: 0.28em 0; }
        .dpx-md li::marker { color: ${t.accent}; }
        /* GFM のチェックリスト（splunk.markdown では出せない）。
           ⚠ 既定のマーカーを消さないと「・☑」と**二重に見える**（実機で確認） */
        .dpx-md li.task-list-item { list-style: none; margin-left: -1.15em; }
        .dpx-md input[type="checkbox"] { margin-right: 0.5em; accent-color: ${t.accent}; }
        .dpx-md code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 0.9em; padding: 0.12em 0.38em; border-radius: 4px;
            background: ${t.accent}1f; color: ${t.titleColor};
        }
        .dpx-md pre {
            margin: 0.8em 0; padding: 0.8em 1em; border-radius: 6px; overflow-x: auto;
            background: ${t.colorScheme === 'light' ? 'rgba(16,24,40,0.06)' : 'rgba(0,0,0,0.28)'};
            border: 1px solid ${t.accent}22;
        }
        .dpx-md pre code { background: none; padding: 0; font-size: 0.92em; }
        .dpx-md blockquote {
            margin: 0.8em 0; padding: 0.1em 0 0.1em 0.9em;
            border-left: 3px solid ${t.accent}; color: ${t.subColor};
        }
        /* GFM の表（splunk.markdown では出せない） */
        .dpx-md table { border-collapse: collapse; margin: 0.8em 0; width: 100%; font-size: 0.95em; }
        .dpx-md th, .dpx-md td {
            border: 1px solid ${t.accent}2e; padding: 0.4em 0.6em; text-align: left;
        }
        .dpx-md th { background: ${t.accent}1a; color: ${t.titleColor}; font-weight: 700; }
        /* 数値列を読みやすく（右寄せは書き手が :---: で決める） */
        .dpx-md td { font-variant-numeric: tabular-nums; }
        .dpx-md hr { border: none; border-top: 1px solid ${t.accent}33; margin: 1.2em 0; }
        .dpx-md del { color: ${t.subColor}; }
        .dpx-md img { max-width: 100%; height: auto; }
    `;

    return (
        <div
            className="dpx-scroll"
            style={{
                height: h,
                overflow: 'auto',
                display: 'flex',
                justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
                padding: `${Number(options.padding) || 4}px 6px`,
            }}
        >
            <style>{css}</style>
            <div
                className="dpx-md"
                style={{
                    width: maxW ? Math.min(maxW, width || maxW) : '100%',
                    maxWidth: '100%',
                    textAlign: options.textAlign || 'left',
                }}
            >
                {/* ⚠ `rehype-raw` を入れない＝生 HTML は無効のまま（XSS 対策） */}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
        </div>
    );
}

DpxMarkdown.config = {
    key: 'dpx.markdown',
    name: 'マークダウン',
    category: 'deco',
    // サーチ不要。⚠ 両方とも空にする（primary を挙げるとデータソース指定を求められる）
    dataContract: { requiredDataSources: [], optionalDataSources: [] },
    optionsSchema: {
        markdown: { type: 'string', default: '## 見出し\n\n本文を **マークダウン** で書けます。\n\n| 列 | 値 |\n|---|---|\n| A | 1 |' },
        fontSize: { type: 'string', default: 'm' },
        align: { type: 'string', default: 'left' },
        textAlign: { type: 'string', default: 'left' },
        maxWidth: { type: 'number', default: 0 },
        padding: { type: 'number', default: 4 },
    },
    editorConfig: [
        {
            label: '本文',
            layout: [[{ label: 'マークダウン（$トークン$ / $列名$ 展開）', option: 'markdown', editor: 'editor.text' }]],
        },
        {
            label: '表示',
            layout: [
                [
                    {
                        label: '文字の大きさ',
                        option: 'fontSize',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'xs', label: '極小（11px）' },
                                { value: 's', label: '小（12px）' },
                                { value: 'm', label: '標準（14px）' },
                                { value: 'l', label: '大（16px）' },
                                { value: 'xl', label: '特大（20px）' },
                            ],
                        },
                    },
                ],
                [
                    {
                        label: '文字の揃え',
                        option: 'textAlign',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { value: 'left', label: '左' },
                                { value: 'center', label: '中央' },
                                { value: 'right', label: '右' },
                            ],
                        },
                    },
                ],
                [
                    {
                        label: 'ブロックの配置',
                        option: 'align',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { value: 'left', label: '左' },
                                { value: 'center', label: '中央' },
                                { value: 'right', label: '右' },
                            ],
                        },
                    },
                ],
                [{ label: '最大幅(px、0で制限なし)', option: 'maxWidth', editor: 'editor.number', editorProps: { min: 0, max: 1600 } }],
                [{ label: '内側の余白(px)', option: 'padding', editor: 'editor.slider', editorProps: { min: 0, max: 40, step: 2 } }],
            ],
        },
    ],
};
