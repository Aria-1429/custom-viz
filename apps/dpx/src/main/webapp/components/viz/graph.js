// ── フロー図・関係図のためのグラフ構築 ──────────────────────────
//
// **サンキー（dpx.sankey）とリンクグラフ（dpx.linkGraph）が共有する前処理。**
// 「行の配列」を「ノードとリンク」に畳む部分は両者で同じなので、ここに置く。
//
// ⚠ **依存ゼロで保つ**（React も DOM も d3 も import しない）。
//   グラフの畳み込みは**目視で正しさを判定できない**（リンクが 1 本
//   多重計上されても絵は自然に見える）。素の Node から検算できることが、
//   この層に置く理由そのもの。
//
// ## データ規約
//
// | 列数 | 解釈 |
// |---|---|
// | 3 列 | `src, dst, value` … 自由グラフ（循環がありうる） |
// | 4 列以上 | `stage1, stage2, …, value` … **多段フロー** |
//
// ⭐ **標準 `splunk.sankey` は 4 列以上を渡すと 3 列目以降を黙って捨てる**
//   （2026-08-09 実機確認）。段が消えてもエラーが出ないので気づけない。
//   ここでは**全段を保持する**のが差別化点。
// ────────────────────────────────────────────────────────────────

/**
 * ID の区切り文字。
 *
 * ⚠⚠ **生の NUL（`\x00`）を書かない。** 過去に 2 回やらかしている
 *   （sankey-flow / DPX）。ソースがバイナリ扱いになり **grep が全滅する**。
 *   表示されない制御文字の「記号」である U+241F を使う（見えるので安全）。
 */
export const NODE_SEP = '␟';

/** リンクの多重集計を避けるためのキー。⚠ 区切りは 2 個重ねる（名前に 1 個含まれても衝突しない）。 */
const LINK_SEP = NODE_SEP + NODE_SEP;

/** 数値化。⚠ カンマ区切り（`1,234`）は Splunk の表示形式で普通に来る。 */
export function parseFlowNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    const n = Number(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
}

/**
 * `target` から `from` へ到達できるか（循環検出）。
 *
 * ⚠ **`seen` を必ず渡す**。渡さないと循環グラフ自身で無限再帰する。
 */
export function reaches(adj, from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of adj.get(from) ?? []) {
        if (reaches(adj, next, to, seen)) return true;
    }
    return false;
}

/**
 * 上位 N 本以外を「その他」へ集約する。
 *
 * ⚠ **リンク本数ではなくノード名で畳む**。細いリンクを単に捨てると
 *   **合計が合わなくなる**（画面上は「減った」ように見えず、ただ間違う）。
 */
function applyTopN(links, nodeMap, staged, topN, otherLabel) {
    if (!Number.isFinite(topN) || topN <= 0 || links.length <= topN) {
        return { links, rolled: 0 };
    }
    const sorted = links.slice().sort((a, b) => b.value - a.value);
    const keep = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    const merged = new Map(keep.map((l) => [l.source + LINK_SEP + l.target, { ...l }]));
    const rolledNames = new Set();

    for (const link of rest) {
        // 段構造では「その他」も段ごとに分ける（段をまたいで混ぜない）
        const stage = staged ? (nodeMap.get(link.target)?.firstStage ?? 1) : 1;
        const otherId = staged ? `${stage}${NODE_SEP}${otherLabel}` : otherLabel;
        if (!nodeMap.has(otherId)) {
            nodeMap.set(otherId, { id: otherId, name: otherLabel, firstStage: stage, isOther: true });
        }
        rolledNames.add(link.target);
        const key = link.source + LINK_SEP + otherId;
        const prev = merged.get(key);
        if (prev) prev.value += link.value;
        else merged.set(key, { source: link.source, target: otherId, value: link.value });
    }
    return { links: Array.from(merged.values()), rolled: rolledNames.size };
}

/**
 * 行の配列 → `{nodes, links}`。
 *
 * @param rows 列の配列の配列（`[[src, dst, value], …]`）
 * @param opts `{topN, otherLabel, cycleMode, maxLinks}`
 * @returns `{error}` か `{nodes, links, staged, …}`
 */
export function buildFlowGraph(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const colCount = list.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    // 3 列（src,dst,value）が最小。⚠ 2 列だと「値が無い」のか
    //    「行き先が無い」のか区別できないので、推測せずエラーにする
    if (colCount < 3) return { error: 'columns', colCount };

    const valueIdx = colCount - 1;
    const stageCount = colCount - 1;
    const staged = stageCount > 2; // 4 列以上 ＝ 多段フロー

    const otherLabel = opts.otherLabel || 'その他';
    const maxLinks = Number.isFinite(opts.maxLinks) ? opts.maxLinks : 600;

    const linkMap = new Map();
    const nodeMap = new Map();
    let droppedInvalid = 0;

    const addNode = (id, name, stage) => {
        if (!nodeMap.has(id)) nodeMap.set(id, { id, name, firstStage: stage });
    };
    const addLink = (a, b, value) => {
        const key = a + LINK_SEP + b;
        linkMap.set(key, (linkMap.get(key) || 0) + value);
    };

    for (const row of list) {
        if (!Array.isArray(row)) {
            droppedInvalid += 1;
            continue;
        }
        const value = parseFlowNum(row[valueIdx]);
        // ⚠ 0 と負値も落とす。サンキーは「量」の図なので、幅 0 のリボンは
        //   描けないし、負の流量は意味が定義できない
        if (!Number.isFinite(value) || value <= 0) {
            droppedInvalid += 1;
            continue;
        }
        // ⚠⚠ **途中で終わる経路は「不正」ではない**（離脱・タイムアウト・遮断）。
        //   最初の空欄までで**打ち切る**。行ごと捨てると**離脱ぶんの量が
        //   グラフから消え**、しかも「段ごとの損失」が常に 0 になって
        //   機能が死ぬ（実機のカタログで実際に 255 件が消えた）。
        //   ⚠ ただし**1 段目が空**なら出発点が無いので、これは落とす。
        const names = [];
        for (let i = 0; i < stageCount; i += 1) {
            const name = row[i] === null || row[i] === undefined ? '' : String(row[i]).trim();
            if (name === '') break; // ここで経路が終わる
            names.push(name);
        }
        // 段が 1 つしか無い＝リンクが引けない（出発点だけの行）
        if (names.length < 2) {
            droppedInvalid += 1;
            continue;
        }
        if (staged) {
            // ⚠ 段番号を ID に含める。同じ名前でも**段が違えば別ノード**
            //   （そうしないと「往復」が循環になって落ちる）
            for (let i = 0; i < names.length - 1; i += 1) {
                const a = `${i}${NODE_SEP}${names[i]}`;
                const b = `${i + 1}${NODE_SEP}${names[i + 1]}`;
                addNode(a, names[i], i);
                addNode(b, names[i + 1], i + 1);
                addLink(a, b, value);
            }
        } else {
            const [src, tgt] = names;
            if (src === tgt) {
                droppedInvalid += 1; // 自己ループは描けない
                continue;
            }
            addNode(src, src, 0);
            addNode(tgt, tgt, 1);
            addLink(src, tgt, value);
        }
    }

    let entries = Array.from(linkMap.entries())
        .map(([key, value]) => {
            const [source, target] = key.split(LINK_SEP);
            return { source, target, value };
        })
        .sort((a, b) => b.value - a.value);

    // ⚠ 集約は循環除去より**先**にやる（集約でリンクが減り、循環も減る）
    const rollup = applyTopN(entries, nodeMap, staged, opts.topN, otherLabel);
    entries = rollup.links;

    let truncated = 0;
    if (entries.length > maxLinks) {
        entries.sort((a, b) => b.value - a.value);
        truncated = entries.length - maxLinks;
        entries = entries.slice(0, maxLinks);
    }

    // 循環処理は自由グラフのみ（段構造は定義上 DAG なので不要）
    let droppedCyclic = 0;
    if (!staged) {
        const adj = new Map();
        const kept = [];
        for (const link of entries) {
            if (reaches(adj, link.target, link.source, new Set())) {
                droppedCyclic += 1;
                continue;
            }
            if (!adj.has(link.source)) adj.set(link.source, []);
            adj.get(link.source).push(link.target);
            kept.push(link);
        }
        entries = kept;
    }

    if (entries.length === 0) {
        return { error: 'nolinks', droppedInvalid, droppedCyclic };
    }

    const used = new Set();
    entries.forEach((l) => {
        used.add(l.source);
        used.add(l.target);
    });
    const nodes = Array.from(nodeMap.values()).filter((n) => used.has(n.id));

    return {
        nodes,
        links: entries,
        staged,
        droppedInvalid,
        droppedCyclic,
        truncated,
        rolledNodes: rollup.rolled,
    };
}

/**
 * 表示名 → 色の索引。**段をまたいで同名なら同色**にする
 * （そうしないと同じものが段ごとに違う色になり、流れを目で追えない）。
 */
export function colorIndexByName(nodes) {
    const byName = new Map();
    (nodes ?? [])
        .slice()
        .sort((a, b) => (a.firstStage ?? 0) - (b.firstStage ?? 0))
        .forEach((n) => {
            if (!byName.has(n.name)) byName.set(n.name, byName.size);
        });
    return byName;
}

/**
 * あるノードを通るフロー全体（上流・下流の両方向）をたどる。
 *
 * ⭐ **標準 sankey / networkGraph には無い**（隣接しか光らない）。
 *   多段フローでは「どこから来てどこへ抜けたか」が見たいので、
 *   隣ではなく**経路全体**を返す。
 *
 * @param layout d3-sankey の出力（`nodeById` 付き）
 */
export function tracePath(layout, startId) {
    const nodeIds = new Set([startId]);
    const linkSet = new Set();
    const start = layout?.nodeById?.get(startId);
    if (!start) return { nodeIds, linkSet };

    // 下流へ
    const down = [start];
    while (down.length) {
        const n = down.pop();
        for (const l of n.sourceLinks ?? []) {
            if (linkSet.has(l.index)) continue;
            linkSet.add(l.index);
            nodeIds.add(l.target.id);
            down.push(l.target);
        }
    }
    // 上流へ
    const up = [start];
    while (up.length) {
        const n = up.pop();
        for (const l of n.targetLinks ?? []) {
            if (linkSet.has(l.index)) continue;
            linkSet.add(l.index);
            nodeIds.add(l.source.id);
            up.push(l.source);
        }
    }
    return { nodeIds, linkSet };
}

/**
 * 段ごとの損失（その段に入った量 − 次の段へ出た量）。
 *
 * ⭐ **標準 sankey には無い。** ファネルの離脱・パケットロスを数値で出せる。
 * ⚠ 最終段は出口が無いだけなので**損失に数えない**（全部が損失に見えてしまう）。
 */
export function lossByStage(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const stages = 1 + list.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
    const out = [];
    for (let d = 0; d < stages; d += 1) {
        const inStage = list.filter((n) => (n.depth ?? 0) === d);
        if (inStage.length === 0) continue;
        const hasNext = list.some((n) => (n.depth ?? 0) === d + 1);
        if (!hasNext) continue;
        const incoming = inStage.reduce((s, n) => s + (n.value || 0), 0);
        const outgoing = inStage.reduce(
            (s, n) => s + (n.sourceLinks ?? []).reduce((tot, l) => tot + l.value, 0),
            0
        );
        out.push({ depth: d, incoming, outgoing, loss: Math.max(0, incoming - outgoing) });
    }
    return out;
}
/**
 * 簡易な力学配置（反発 + バネ）を**固定回数だけ**回して座標を返す。
 *
 * ⚠ **乱数を使わない**。初期配置を円周上に取ることで、
 *   同じデータなら**毎回同じ絵**になる（再サーチのたびに配置が変わると
 *   「何か起きた」と誤読される）。
 *
 * @returns `Map<id, {x, y}>`（0〜1 の正規化座標）
 */
export function forceLayout(nodes, links, iterations = 220) {
    const n = nodes.length;
    const pos = new Map();
    if (n === 0) return pos;
    // 初期配置＝円周（決定的）
    nodes.forEach((node, i) => {
        const a = (i / n) * Math.PI * 2;
        pos.set(node.id, { x: 0.5 + Math.cos(a) * 0.35, y: 0.5 + Math.sin(a) * 0.35, vx: 0, vy: 0 });
    });
    if (n === 1) {
        pos.set(nodes[0].id, { x: 0.5, y: 0.5 });
        return pos;
    }

    // 次数（つながりの多いノードほど中心に寄せたい）
    const deg = new Map();
    for (const l of links) {
        deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
        deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    }

    const repel = 0.35 / n; // ノードが増えるほど1対の反発は弱める（発散防止）
    for (let step = 0; step < iterations; step += 1) {
        const cool = 1 - step / iterations; // 徐々に動きを止める（収束させる）
        // 反発（全対）
        for (let i = 0; i < n; i += 1) {
            const a = pos.get(nodes[i].id);
            for (let j = i + 1; j < n; j += 1) {
                const b = pos.get(nodes[j].id);
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                // ⚠ 完全に重なると 0 除算で NaN になり**全ノードが消える**。
                //   最小距離を入れて必ず割れるようにする
                if (d2 < 1e-6) {
                    dx = (i - j) * 1e-3;
                    dy = 1e-3;
                    d2 = dx * dx + dy * dy;
                }
                const f = (repel / d2) * cool;
                const d = Math.sqrt(d2);
                a.vx += (dx / d) * f;
                a.vy += (dy / d) * f;
                b.vx -= (dx / d) * f;
                b.vy -= (dy / d) * f;
            }
        }
        // バネ（つながっている対を引き寄せる）
        for (const l of links) {
            const a = pos.get(l.source);
            const b = pos.get(l.target);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
            const f = (d - 0.18) * 0.045 * cool;
            a.vx += (dx / d) * f;
            a.vy += (dy / d) * f;
            b.vx -= (dx / d) * f;
            b.vy -= (dy / d) * f;
        }
        // 中心へ引く（ばらけて画面外へ出るのを防ぐ）。次数が高いほど強く
        for (const node of nodes) {
            const p = pos.get(node.id);
            const pull = 0.006 * (1 + Math.min(3, deg.get(node.id) ?? 0) * 0.25) * cool;
            p.vx += (0.5 - p.x) * pull;
            p.vy += (0.5 - p.y) * pull;
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.82; // 減衰
            p.vy *= 0.82;
        }
    }

    // 0〜1 に正規化し直す（力学の結果は範囲がまちまちなので、必ず収める）
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pos.values()) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const out = new Map();
    for (const [key, p] of pos) {
        out.set(key, { x: (p.x - minX) / spanX, y: (p.y - minY) / spanY });
    }
    return out;
}

