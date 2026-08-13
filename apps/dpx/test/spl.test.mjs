// SPL 整形の単体テスト。
// 実行: node test/spl.test.mjs
//
// ⚠ **整形は「意味を変えない」ことが絶対条件**。
//   単純に `split('|')` すると、文字列リテラルの中の `|` まで割ってしまい
//   SPL が壊れる（`eval x="a|b"` や rex の正規表現で普通に出てくる）。
//   壊れても画面上は「改行されただけ」に見えるので目視では気づけない。
import { formatSpl } from '../src/main/webapp/components/data/spl.js';

let ng = 0;
const ok = (c, m) => {
    if (!c) {
        console.log('✗', m);
        ng++;
    } else console.log('✓', m);
};

// 「整形しても | でつなぎ直せば元と同じ意味になる」ことを見る
const semantic = (s) =>
    formatSpl(s)
        .split('\n')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

console.log('--- 基本 ---');
ok(formatSpl('index=web | stats count by host').split('\n').length === 2, 'パイプで改行される');
ok(formatSpl('index=web | stats count').split('\n')[1].startsWith('| '), '2行目は | で始まる');
ok(formatSpl('| makeresults count=5').split('\n').length === 1, '生成系1本は1行のまま');
ok(formatSpl('') === '', '空文字は空文字');
ok(formatSpl(null) === '', 'null で落ちない');
ok(formatSpl(undefined) === '', 'undefined で落ちない');

console.log('--- 引用符の中の | を割らない（最重要）---');
{
    const src = 'index=web | eval x="a|b" | stats count';
    const f = formatSpl(src);
    ok(f.split('\n').length === 3, `"a|b" の中では割らない（${f.split('\n').length} 行）`);
    ok(f.includes('"a|b"'), 'リテラルが壊れていない');
}
{
    const src = `index=web | rex field=_raw "(?<a>x|y)" | table a`;
    const f = formatSpl(src);
    ok(f.split('\n').length === 3, '正規表現の | で割らない');
    ok(f.includes('(?<a>x|y)'), '正規表現が壊れていない');
}
{
    const src = `index=web | eval s='p|q' | stats count`;
    ok(formatSpl(src).split('\n').length === 3, "シングルクォート内の | も割らない");
}
{
    // エスケープされた引用符をまたぐケース
    const src = 'index=web | eval x="say \\"hi\\" | done" | stats count';
    const f = formatSpl(src);
    ok(f.split('\n').length === 3, 'エスケープされた引用符を跨いでも割らない');
}

console.log('--- 冪等・意味保存 ---');
for (const src of [
    'index=web | stats count by host | sort -count',
    '| makeresults count=5 | eval a="x|y" | table a',
    'index=a|stats count',
    'search foo | eval t=if(x>1,"a|b","c") | table t',
]) {
    ok(formatSpl(formatSpl(src)) === formatSpl(src), `2回整形しても変わらない: ${src.slice(0, 30)}…`);
    // 改行を戻して空白を均せば、元の SPL とトークン列が一致する。
    // ⚠ 期待値を `src.replace(/\s*\|\s*/g,' | ')` で作ってはいけない。
    //   その素朴な置換は**文字列リテラル内の `|` にも空白を入れてしまい**
    //   （`"a|b"` → `"a | b"`）、正しい実装の方を「不一致」と判定する。
    //   ＝ テスト側が同じバグを持つことになる（実際にこれで誤検出した）。
    // 整形は `|` の後ろに空白を1つ入れて揃えるので（`index=a|stats` →
    // `index=a | stats`）、比較は**空白を全部落としたトークン列**で行う
    const squash = (x) => x.replace(/\s+/g, '');
    ok(squash(semantic(src)) === squash(src), `意味が保たれる: ${src.slice(0, 30)}…`);
}

console.log('--- 末尾の | ---');
ok(!formatSpl('index=web |').endsWith('|'), '書きかけの末尾 | は落とす');

console.log(ng === 0 ? '\n✓ 全て成功' : `\n✗ ${ng} 件失敗`);
process.exit(ng ? 1 : 0);
