// SPL の文字列操作（純粋関数だけ）。
//
// ⚠ **JSX を含むファイルに置かない。** SplEditor.jsx に書くと
//    `node test/*.mjs` から import できずテストが書けない（scale.js と同じ理由）。
//    整形は「意味を変えない」ことが絶対条件なので、必ずテストできる場所に置く。

/** パイプごとに改行して整形する。文字列リテラル内の `|` は割らない。 */
export function formatSpl(src) {
    const s = String(src ?? '');
    const out = [];
    let buf = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            buf += c;
            // エスケープされた引用符は閉じ扱いにしない
            if (c === quote && s[i - 1] !== '\\') quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            buf += c;
            continue;
        }
        if (c === '|') {
            const line = buf.trim();
            if (line) out.push(line);
            // ⚠ ここで `'| '` と空白を足すと、元の SPL にあった空白と重なって
            //   **整形するたびにインデントが1つずつ増える**（冪等でなくなる）。
            //   テストで検出（`| stats` → `|  stats` → `|   stats`）。
            //   区切りだけ置き、空白は最後にまとめて均す。
            buf = '|';
            continue;
        }
        buf += c;
    }
    const last = buf.trim();
    if (last && last !== '|') out.push(last);
    // 先頭が `|` で始まる生成系はそのまま活かす。
    // `|` の直後の空白は1つに揃える（何回整形しても同じ結果になる）
    return out.map((l) => l.replace(/^\|\s*/, '| ')).join('\n');
}
