// ── 共有データソース（Studio 準拠、DPX 流に簡素化）─────────────
//
// これまでは「1 パネル = 1 SPL」で、同じサーチを何枚ものパネルに書き写す必要があった。
// 定義に `dataSources` を持たせ、パネルはそれを **参照** できるようにする。
//
// **サーチは必ずデータソースに置く**（2026-08-11 / v0.4.0 でこの形に統一）。
// パネルに SPL を直書きする形は廃止した。同じサーチが何枚ものパネルに散らばると、
// 「どのパネルがどのサーチを使っているか」「直すとき何枚直せばよいか」が
// 追えなくなり管理が破綻するため。パネルは**参照するだけ**にする。
//
// スキーマ v1:
//   {
//     "dataSources": {
//       "ds_traffic": {
//         "name": "トラフィック",              // インスペクタでの表示名
//         "spl": "index=web | timechart count",
//         "earliest": "-24h", "latest": "now", // 省略可（パネル側 / 入力で上書き可）
//         "refresh": 60                        // 省略可（秒。0/未指定で自動更新しない）
//       }
//     },
//     "panels": [
//       { "id": "p1", "search": { "ref": "ds_traffic" } },                 // ← 参照
//       { "id": "p2", "search": { "ref": "ds_traffic", "postSearch":       // ← 参照＋加工
//                                 "| where status>=500" } }
//     ]
//   }
//
// ⚠ 旧形式（`search.spl` の直書き）の定義も読めるようにしてある（`migrateToDataSources`）。
//   読み込み時にデータソースへ切り出すので、既存ダッシュボードは開くだけで移行される。
//
// **Studio との違い（DPX の割り切り）**:
//   Studio は ds.search / ds.chain / ds.test… と型を分けるが、DPX では
//   「共有サーチ1種類＋postSearch（後続パイプ）」に畳んだ。ds.chain 相当は
//   postSearch で足りるし、型を増やすほど編集 UI が複雑になるため。
//
// ⚠ 実測メモ: 絞り込みは `| where` を使う（`| search` は 0 行になる。
//   これはサブサーチではなく後続パイプなので、`search` コマンドの意味が違うため）。
// ────────────────────────────────────────────────────────────────

/** 定義から dataSources を取り出す（無ければ空オブジェクト）。 */
export function getDataSources(definition) {
    const ds = definition?.dataSources;
    return ds && typeof ds === 'object' ? ds : {};
}

/**
 * パネルの search 設定を「実行できる形」に解決する。
 * 参照（ref）なら共有データソースを引き、postSearch があれば連結する。
 *
 * @returns {{spl:string, earliest:string, latest:string, refresh:number,
 *            sourceName:string|null, missingRef:string|null}}
 */
export function resolvePanelSearch(panel, definition) {
    const s = panel?.search ?? {};
    const sources = getDataSources(definition);
    const ref = s.ref;

    if (!ref) {
        // 従来どおりの直書き
        return {
            spl: s.spl ?? '',
            earliest: s.earliest ?? '-24h',
            latest: s.latest ?? 'now',
            refresh: Number(s.refresh ?? 0) || 0,
            sourceName: null,
            missingRef: null,
        };
    }

    const src = sources[ref];
    if (!src) {
        // 参照先が消えている（データソースを消したのにパネルが残っている等）
        return {
            spl: '',
            earliest: s.earliest ?? '-24h',
            latest: s.latest ?? 'now',
            refresh: 0,
            sourceName: null,
            missingRef: ref,
        };
    }

    const base = String(src.spl ?? '').trim();
    const post = String(s.postSearch ?? '').trim();
    // postSearch はパイプで繋ぐ。先頭の | は付いていても付いていなくてもよい。
    const spl = post ? `${base} ${post.startsWith('|') ? post : `| ${post}`}` : base;

    return {
        spl,
        // 時間はパネル側の指定を優先（入力から受け取る運用があるため）
        earliest: s.earliest ?? src.earliest ?? '-24h',
        latest: s.latest ?? src.latest ?? 'now',
        refresh: Number(s.refresh ?? src.refresh ?? 0) || 0,
        sourceName: src.name || ref,
        missingRef: null,
    };
}

/** データソースを参照しているパネル ID の一覧（削除時の警告に使う）。 */
export function panelsUsingSource(definition, ref) {
    return (definition?.panels ?? []).filter((p) => p.search?.ref === ref).map((p) => p.id);
}

/** 新しいデータソース ID を採番する（ds1, ds2, …）。 */
export function nextSourceId(definition) {
    const sources = getDataSources(definition);
    let n = Object.keys(sources).length + 1;
    while (sources[`ds${n}`]) n += 1;
    return `ds${n}`;
}

/**
 * 旧形式（パネルに SPL 直書き）を **データソース参照へ移行**する。
 *
 * - 直書きパネルの SPL をデータソースとして切り出し、`search.ref` に張り替える
 * - **同じ SPL は 1 つのデータソースに集約**する（時間指定が同じものだけ。
 *   earliest/latest が違うものを混ぜると片方の期間が変わってしまうため）
 * - 変更が無ければ**同じ参照をそのまま返す**（無駄な再描画・dirty 化を防ぐ）
 *
 * @returns {{definition:object, migrated:number}} migrated は移行したパネル数
 */
export function migrateToDataSources(definition) {
    const panels = definition?.panels;
    if (!Array.isArray(panels)) return { definition, migrated: 0 };

    const inline = panels.filter((p) => !p?.search?.ref && String(p?.search?.spl ?? '').trim());
    if (inline.length === 0) return { definition, migrated: 0 };

    const sources = { ...getDataSources(definition) };
    // 「SPL＋時間」が同じものは 1 つにまとめるための索引
    const byKey = new Map();
    for (const [id, src] of Object.entries(sources)) {
        byKey.set(`${String(src?.spl ?? '').trim()}\u0000${src?.earliest ?? ''}\u0000${src?.latest ?? ''}`, id);
    }

    let seq = Object.keys(sources).length;
    const nextId = () => {
        do {
            seq += 1;
        } while (sources[`ds${seq}`]);
        return `ds${seq}`;
    };

    const nextPanels = panels.map((p) => {
        const s = p?.search ?? {};
        const spl = String(s.spl ?? '').trim();
        if (s.ref || !spl) return p;

        const key = `${spl}\u0000${s.earliest ?? ''}\u0000${s.latest ?? ''}`;
        let id = byKey.get(key);
        if (!id) {
            id = nextId();
            sources[id] = {
                name: p.title || id,
                spl,
                ...(s.earliest ? { earliest: s.earliest } : {}),
                ...(s.latest ? { latest: s.latest } : {}),
                ...(s.refresh ? { refresh: s.refresh } : {}),
            };
            byKey.set(key, id);
        }
        // 直書きの痕跡（spl）は残さない。時間・更新間隔はデータソース側に移した
        const { spl: _drop, earliest: _e, latest: _l, refresh: _r, ...rest } = s;
        return { ...p, search: { ...rest, ref: id } };
    });

    return {
        definition: { ...definition, dataSources: sources, panels: nextPanels },
        migrated: inline.length,
    };
}
