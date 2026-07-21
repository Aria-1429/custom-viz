import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Chord Flow — アニメーションパーティクル付き有向コード・ダイアグラム
//
// データモデル:
//   3列以上 [source, target, ..., value]。第1列=送り元、第2列=送り先、最終列=数値（流量）。
//   同じ (source, target) ペアは合算。source→target と target→source は別リボン
//   （双方向・循環フローをそのまま表現できる。Sankey と違い DAG 制約なし）。
//
// レイアウトは自前実装の「有向コードレイアウト」:
//   - 各エンティティの弧の幅 = 入出フロー合計に比例
//   - 弧の内側に「出フロー帯 → 入フロー帯」の順でサブ弧を割り当て
//   - リボンは出サブ弧 → 入サブ弧を中心向き二次ベジェ（制御点=中心）で結ぶ
//
// アニメーション（network-graph で確立した rAF ハイブリッド描画パターン）:
//   - React(JSX): 弧・リボン・ラベル・グラデーション等「データ/オプション変更時にだけ
//     変わるもの」を描画
//   - rAF ループ: パーティクル(circle)の cx/cy/opacity と回転グループの transform だけを
//     setAttribute で直接更新。React と同じ属性は触らない
//   - 設定・ジオメトリは ref（毎レンダー代入）経由で読み stale closure を回避
//   - パーティクル経路はリボンと同じ二次ベジェ P(t)=(1-t)²A+2t(1-t)C+t²B（C≈中心）なので
//     リボンの上を正確に流れる。密度はフロー量に比例 → 方向と量が一目で分かる
//
// v0.5.0 追加:
//   - クリックで選択を固定（clickToFocus）。再クリック/背景クリックで解除。ロック中は
//     関連しないリボン・弧・パーティクルを減光。有効な選択 sel は rAF ループも参照する
//   - フロー方向の視認性: taperRibbons（source 側を太く target 側を細く）・showArrows
//     （target 端に幅連動の三角矢印）。パーティクルが OFF でも向きが分かる。
//     v0.5.1: テーパー量を 0.62→0.35 に緩め（前の同幅表示に寄せる）、当たり判定は
//     常に全幅の透明パス（.cf-ribbon-hit）が担い、見た目リボンは pointerEvents:none。
//     target 側が細くてもクリック/ホバーしづらくならない
//   - 自己ループ（送信元＝送信先）を showSelfLoops で外向きの小さな戻り弧として描画。
//     弧幅（out+in）には算入しないのでレイアウトは不変。既定は従来どおり除去
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
// 【値→色】editor.dynamicColor はカスタム viz では使えない（範囲配列が options に来ない）
// ため、低値色→(中間色)→高値色の線形補間カラースケールを自前実装している。
const DEFAULTS = {
    sourceField: '', // 送り元フィールド（'' = 第1列。editor.columnSelector が書く DOS 文字列にも対応）
    targetField: '', // 送り先フィールド（'' = 第2列）
    valueField: '', // 数値フィールド（'' = 最終列）
    useGradientRibbons: true, // リボンを source→target 色のグラデーションにする
    ribbonOpacity: 55, // リボンの不透明度（%）
    useValueColors: false, // ON でリボンを値ベースのカラースケールで着色
    lowColor: '#3fb950', // スケール低値側
    highColor: '#ef4d4d', // スケール高値側
    useMidColor: true, // 中間色を挟んで3色スケール
    midColor: '#f5c518', // 中間色
    reverse: false, // 低↔高を反転
    showSelfLoops: false, // 送信元＝送信先（自己ループ）を小さな戻り弧として表示
    showParticles: true, // フローパーティクルを表示
    particleSpeed: 100, // パーティクル速度（%）
    particleDensity: 100, // パーティクル密度（%）
    particleSize: 0, // パーティクル半径 px（0 = 自動）
    glow: true, // 発光（ガウスぼかしフィルタ）
    taperRibbons: true, // リボンを source 側で太く target 側で細くして向きを示す
    showArrows: false, // target 側にリボン幅連動の矢印を描く
    arcThickness: 0, // 外周弧の太さ px（0 = 自動）
    arcPadding: 2, // 弧と弧の間隔（度）
    rotateSpeed: 0, // リング全体の回転（度/秒、0 = 停止、負値で逆回転）
    showLabels: true, // ラベル表示
    showValues: true, // ラベルに値を併記
    labelSize: 0, // ラベル文字サイズ px（0 = 自動）
    showHeader: true, // 上部サマリー
    highlightOnHover: true, // ホバーで関連フローをハイライト
    clickToFocus: true, // クリックで選択をロック（再クリック/背景クリックで解除）
    debug: false, // options の生値を出す診断オーバーレイ
};

// エンティティのカテゴリカルパレット（ライト/ダーク両テーマで視認できる12色）
const PALETTE = [
    '#7B56DB', '#009CEB', '#00CDAF', '#DD9900', '#FF677B', '#CB2196',
    '#5A4575', '#6B85FA', '#8CD156', '#F6540B', '#B6C75A', '#0051B5',
];

// リンク合算キーの区切り文字（フィールド値に現れない制御文字。生バイトではなくエスケープで書く）
const SEP = '\u0001';

const MAX_ENTITIES = 40; // これを超えるエンティティは合計流量の小さい順に落とす
const MAX_LINKS = 400; // リボン数上限（値の大きい順に残す）
const MAX_PARTICLES = 320; // パーティクルプール上限（全リボン合計）
const BASE_TRAVEL_SEC = 2.4; // パーティクルが一周にかける基準秒数（speed 100% 時）

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

// サーチ結果を rows 形式に正規化（rows / columns 両対応・落とさない）
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        // 想定外の形式でも落とさない
    }
    return [];
}

function parseNum(v) {
    if (v === null || v === undefined) return NaN;
    return Number(String(v).replace(/,/g, '').trim());
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function isHexColor(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
}

// options を型・範囲の面で安全側に補正（未設定・型不一致に耐える）
function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const bool = (key) => (o[key] === undefined ? DEFAULTS[key] : !!o[key]);
    const num = (key, lo, hi) => {
        const n = parseNum(o[key]);
        if (!Number.isFinite(n)) return DEFAULTS[key];
        return clamp(n, lo, hi);
    };
    const color = (key) => (isHexColor(o[key]) ? o[key].trim() : DEFAULTS[key]);
    // フィールド指定は「生フィールド名」「DOS 文字列（> primary | seriesByName('x')）」
    // 「ホストが DOS を解決した列データ配列」のどれで届いても後段で解決するため素通しする
    const fieldSpec = (key) => {
        const v = o[key];
        if (typeof v === 'string') return v.trim();
        if (Array.isArray(v)) return v;
        return '';
    };
    return {
        sourceField: fieldSpec('sourceField'),
        targetField: fieldSpec('targetField'),
        valueField: fieldSpec('valueField'),
        useGradientRibbons: bool('useGradientRibbons'),
        ribbonOpacity: num('ribbonOpacity', 5, 100),
        useValueColors: bool('useValueColors'),
        lowColor: color('lowColor'),
        highColor: color('highColor'),
        useMidColor: bool('useMidColor'),
        midColor: color('midColor'),
        reverse: bool('reverse'),
        showSelfLoops: bool('showSelfLoops'),
        showParticles: bool('showParticles'),
        particleSpeed: num('particleSpeed', 10, 400),
        particleDensity: num('particleDensity', 0, 400),
        particleSize: num('particleSize', 0, 12),
        glow: bool('glow'),
        taperRibbons: bool('taperRibbons'),
        showArrows: bool('showArrows'),
        arcThickness: num('arcThickness', 0, 60),
        arcPadding: num('arcPadding', 0, 12),
        rotateSpeed: num('rotateSpeed', -60, 60),
        showLabels: bool('showLabels'),
        showValues: bool('showValues'),
        labelSize: num('labelSize', 0, 32),
        showHeader: bool('showHeader'),
        highlightOnHover: bool('highlightOnHover'),
        clickToFocus: bool('clickToFocus'),
        debug: bool('debug'),
    };
}

// ---------------------------------------------------------------------------
// 値→色カラースケール（editor.dynamicColor の代替。knowledge §4 の定番パターン）
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = clamp(t, 0, 1);
    const c = a.map((av, i) => Math.round(av + (b[i] - av) * u));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function scaleColorFor(t, opts) {
    let u = clamp(Number.isFinite(t) ? t : 0.5, 0, 1);
    if (opts.reverse) u = 1 - u;
    if (opts.useMidColor) {
        if (u <= 0.5) return lerpColor(opts.lowColor, opts.midColor, u / 0.5);
        return lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

// ---------------------------------------------------------------------------
// 数値フォーマット
// ---------------------------------------------------------------------------

function fmtCompact(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1e15) return v.toExponential(1); // これ以上の桁は指数表記（ヘッダー崩壊防止）
    if (abs >= 1e12) return `${(v / 1e12).toFixed(abs >= 1e13 ? 0 : 1)}T`;
    if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
}

function fmtFull(v) {
    if (!Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1e15) return v.toExponential(2); // カンマ30桁の怪物を出さない
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// ラベル幅の見積もりとフィット（SVG に measureText は無いので推定で足りる）
// ---------------------------------------------------------------------------

// 推定テキスト幅 px。CJK はほぼ全角（=フォントサイズ）、それ以外は約 0.62 倍
function estTextWidth(s, fontSize) {
    let w = 0;
    for (const ch of String(s)) {
        w += ch.codePointAt(0) > 0x2e7f ? 1.0 : 0.62;
    }
    return w * fontSize;
}

// 推定幅が maxPx に収まるよう末尾を … で切り詰める
function fitText(s, fontSize, maxPx) {
    const str = String(s);
    if (estTextWidth(str, fontSize) <= maxPx) return str;
    let out = '';
    for (const ch of str) {
        if (estTextWidth(`${out}${ch}…`, fontSize) > maxPx) break;
        out += ch;
    }
    return `${out}…`;
}

// ---------------------------------------------------------------------------
// フィールド指定 → 列インデックス解決
//
// editor.columnSelector（標準 viz の「データ設定」と同じ UI）は選択結果を
// DOS 文字列（例: "> primary | seriesByName('src')"）としてオプションに書く。
// カスタム viz には DOS が未解決のまま届く（dynamicColor の実測と同じ挙動）ため、
// 文字列からフィールド名/インデックスを自前でパースする。将来ホストが解決して
// 列データ配列が届くようになっても動くよう、配列は列内容の照合で解決する。
// ---------------------------------------------------------------------------

function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    // ホスト解決済みの列データ（配列）: 先頭数行を各列と照合してインデックスを特定
    if (Array.isArray(spec)) {
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return fallbackIdx;
    }
    if (typeof spec !== 'string') return fallbackIdx;
    const s = spec.trim();
    if (s === '') return fallbackIdx;
    let name = s;
    if (s.startsWith('>')) {
        const byName = s.match(/seriesByName\(\s*['"]([^'"]+)['"]\s*\)/);
        const byIndex = s.match(/seriesByIndex\(\s*(\d+)\s*\)/);
        if (byName) {
            name = byName[1];
        } else if (byIndex) {
            const idx = Number(byIndex[1]);
            return idx >= 0 && idx < fieldNames.length ? idx : fallbackIdx;
        } else {
            return fallbackIdx; // 解釈できない DOS はデフォルト列に退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// ---------------------------------------------------------------------------
// グラフ構築（行 → エンティティ/有向リンク）
// ---------------------------------------------------------------------------

// Splunk のマルチバリューフィールドは1行のセルに配列（環境によっては改行区切り文字列）で
// 届くことがある（mvexpand し忘れ・stats の values() など）。全カラムのトークン数が一致する
// 場合に限り、平行に行へ展開して救済する。String(配列) のカンマ連結や数値の桁連結
// （"5200"+"3100"+… → 5.2e30）といった壊れた表示を防ぐ。
const MAX_MV_EXPAND = 10000;

function cellTokens(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c.includes('\n')) return c.split('\n');
    return [c];
}

function expandMultivalueRows(rows) {
    const out = [];
    for (const row of rows) {
        if (!Array.isArray(row)) {
            out.push(row);
            continue;
        }
        const tokens = row.map(cellTokens);
        const L = tokens.reduce((m, t) => Math.max(m, t.length), 0);
        if (L <= 1) {
            out.push(tokens.map((t) => t[0]));
            continue;
        }
        if (tokens.every((t) => t.length === L)) {
            const n = Math.min(L, MAX_MV_EXPAND);
            for (let k = 0; k < n; k += 1) out.push(tokens.map((t) => t[k]));
        } else {
            // トークン数不一致はゴミデータ。そのまま流すと String(配列)="A,B" や
            // parseNum("10,20")=1020 が「見かけ上有効なリンク」に化けるため null 行にして落とす
            out.push(new Array(row.length).fill(null));
        }
    }
    return out;
}

// 返り値: { entities:[{name,out,in,self,total,color}], links:[{si,ti,value}],
//           droppedInvalid, droppedEntities, truncated, droppedSelf, error }
// colIdx: { s, t, v } — 使用する列インデックス（v = -1 は最終列）。
// keepSelf: true のとき送信元＝送信先（自己ループ）を落とさずエンティティの self に合算する。
function buildGraph(rawRows, colIdx, keepSelf) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount < 3) return { error: 'columns' };
    const ci = colIdx || { s: 0, t: 1, v: -1 };
    const srcIdx = ci.s >= 0 && ci.s < colCount ? ci.s : 0;
    const tgtIdx = ci.t >= 0 && ci.t < colCount ? ci.t : 1;
    const valueIdx = ci.v >= 0 && ci.v < colCount ? ci.v : colCount - 1;
    if (srcIdx === tgtIdx) return { error: 'samefield' };

    const linkMap = new Map(); // "src\u0001tgt" → 合算値
    const selfMap = new Map(); // name → 自己ループ合算値（keepSelf 時のみ集める）
    let droppedInvalid = 0;
    let droppedSelf = 0;
    for (const row of rows) {
        if (!Array.isArray(row)) {
            droppedInvalid += 1;
            continue;
        }
        const value = parseNum(row[valueIdx]);
        const src = row[srcIdx] === null || row[srcIdx] === undefined ? '' : String(row[srcIdx]).trim();
        const tgt = row[tgtIdx] === null || row[tgtIdx] === undefined ? '' : String(row[tgtIdx]).trim();
        if (!Number.isFinite(value) || value <= 0 || src === '' || tgt === '') {
            droppedInvalid += 1;
            continue;
        }
        if (src === tgt) {
            // 自己ループ。keepSelf なら弧の端に小さな戻り帯として描くため別集計、
            // OFF なら従来どおり除去（リング上の弧幅にも算入しない）。
            if (keepSelf) selfMap.set(src, (selfMap.get(src) || 0) + value);
            else droppedSelf += 1;
            continue;
        }
        const key = `${src}\u0001${tgt}`;
        linkMap.set(key, (linkMap.get(key) || 0) + value);
    }
    if (linkMap.size === 0) return { error: 'nolinks', droppedInvalid, droppedSelf };

    // エンティティごとの入出合計
    const totals = new Map(); // name → {out, in}
    const touch = (name) => {
        if (!totals.has(name)) totals.set(name, { out: 0, in: 0 });
        return totals.get(name);
    };
    for (const [key, value] of linkMap) {
        const [src, tgt] = key.split('\u0001');
        touch(src).out += value;
        touch(tgt).in += value;
    }

    // 上位 MAX_ENTITIES を残す（合計流量の大きい順）
    const ranked = Array.from(totals.entries())
        .map(([name, t]) => ({ name, total: t.out + t.in }))
        .sort((a, b) => b.total - a.total);
    const kept = new Set(ranked.slice(0, MAX_ENTITIES).map((e) => e.name));
    const droppedEntities = Math.max(0, ranked.length - MAX_ENTITIES);

    // リンクを確定（両端が残存エンティティのもの。値の大きい順に上限まで）
    let entries = Array.from(linkMap.entries())
        .map(([key, value]) => {
            const [src, tgt] = key.split('\u0001');
            return { src, tgt, value };
        })
        .filter((l) => kept.has(l.src) && kept.has(l.tgt))
        .sort((a, b) => b.value - a.value);
    let truncated = 0;
    if (entries.length > MAX_LINKS) {
        truncated = entries.length - MAX_LINKS;
        entries = entries.slice(0, MAX_LINKS);
    }
    if (entries.length === 0) return { error: 'nolinks', droppedInvalid, droppedSelf };

    // 残ったリンクからエンティティ一覧を再構築（合計流量の大きい順 → パレット割当も安定）
    const used = new Map(); // name → {out, in}
    const use = (name) => {
        if (!used.has(name)) used.set(name, { out: 0, in: 0 });
        return used.get(name);
    };
    entries.forEach((l) => {
        use(l.src).out += l.value;
        use(l.tgt).in += l.value;
    });
    // 自己ループ値は残存エンティティにだけ付ける。弧幅（out+in）には算入しないので
    // レイアウトを崩さず、戻り弧・ツールチップ・ヘッダー集計にのみ使う。
    let selfTotal = 0;
    const entities = Array.from(used.entries())
        .map(([name, t], i) => {
            const self = selfMap.get(name) || 0;
            selfTotal += self;
            return { name, out: t.out, in: t.in, self, total: t.out + t.in, i };
        })
        .sort((a, b) => b.total - a.total)
        .map((e, i) => ({ ...e, color: PALETTE[i % PALETTE.length] }));
    const indexOf = new Map(entities.map((e, i) => [e.name, i]));
    const links = entries.map((l) => ({
        si: indexOf.get(l.src),
        ti: indexOf.get(l.tgt),
        value: l.value,
    }));

    return {
        entities, links, droppedInvalid, droppedEntities, truncated,
        droppedSelf, selfTotal, hasSelf: selfTotal > 0,
    };
}

// ---------------------------------------------------------------------------
// 有向コードレイアウト（角度計算）
//
// 各エンティティの弧の幅 ∝ (out + in)。弧の内側は「出フロー帯（値の大きい順）→
// 入フロー帯（値の大きい順）」でサブ弧を割り当てる。各有向リンクは
// 出サブ弧（source 側）と入サブ弧（target 側）を持ち、両者を結ぶのがリボン。
// 角度は 12時方向を 0 とし時計回り（x = r·sin a, y = -r·cos a）。
// ---------------------------------------------------------------------------

function layoutChords(graph, padDeg) {
    const { entities, links } = graph;
    const n = entities.length;
    const T = entities.reduce((s, e) => s + e.total, 0); // = 2 × 総流量
    if (T <= 0) return null;
    const pad = Math.min((padDeg * Math.PI) / 180, (2 * Math.PI * 0.35) / Math.max(1, n));
    const k = (2 * Math.PI - n * pad) / T; // 値 → ラジアン変換係数

    // 各エンティティの出/入リンクを値の大きい順に並べる
    const outsBy = entities.map(() => []);
    const insBy = entities.map(() => []);
    links.forEach((l, idx) => {
        outsBy[l.si].push(idx);
        insBy[l.ti].push(idx);
    });
    outsBy.forEach((arr) => arr.sort((a, b) => links[b].value - links[a].value));
    insBy.forEach((arr) => arr.sort((a, b) => links[b].value - links[a].value));

    const groups = [];
    const chords = links.map((l) => ({ ...l })); // {si, ti, value} + 角度を追記
    let x = 0;
    for (let i = 0; i < n; i += 1) {
        const start = x;
        for (const idx of outsBy[i]) {
            chords[idx].sa0 = x;
            x += links[idx].value * k;
            chords[idx].sa1 = x;
        }
        for (const idx of insBy[i]) {
            chords[idx].ta0 = x;
            x += links[idx].value * k;
            chords[idx].ta1 = x;
        }
        const g = {
            ...entities[i],
            startAngle: start,
            endAngle: x,
            mid: (start + x) / 2,
        };
        // 自己ループ: 弧の中央付近から外へ膨らんで戻る小さなループの2つの取付角。
        // 弧幅が狭くても最低角を確保し、隣の弧にはみ出さないよう弧幅の 0.9 で頭打ち。
        if (entities[i].self > 0) {
            const span = x - start;
            const loopW = Math.min(span * 0.9, Math.max(span * 0.5, 0.05));
            g.selfA0 = g.mid - loopW / 2;
            g.selfA1 = g.mid + loopW / 2;
        }
        groups.push(g);
        x += pad;
    }

    let minV = Infinity;
    let maxV = -Infinity;
    chords.forEach((c) => {
        if (c.value < minV) minV = c.value;
        if (c.value > maxV) maxV = c.value;
    });

    // 逆方向フローの値（ツールチップで A→B と併せて B→A も見せる）
    const byPair = new Map();
    chords.forEach((c) => byPair.set(`${c.si}:${c.ti}`, c.value));
    chords.forEach((c) => {
        c.reverse = byPair.get(`${c.ti}:${c.si}`) || 0;
    });

    return { groups, chords, minV, maxV, totalFlow: T / 2 };
}

// 角度 → 座標（中心原点、12時=0、時計回り）
function pt(r, a) {
    return [r * Math.sin(a), -r * Math.cos(a)];
}

function ptStr(r, a) {
    const [px, py] = pt(r, a);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
}

// 外周の環状セクタ（エンティティの弧）
function arcPath(r0, r1, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return (
        `M${ptStr(r1, a0)}A${r1},${r1} 0 ${large} 1 ${ptStr(r1, a1)}` +
        `L${ptStr(r0, a1)}A${r0},${r0} 0 ${large} 0 ${ptStr(r0, a0)}Z`
    );
}

// リボン（出サブ弧 → 入サブ弧、中心向き二次ベジェ）。
// taper > 0 のとき target 側サブ弧を中央に向けて縮めて先細りにし、流れの向きを示す
// （taper=1 で完全に一点へ収束、0 で従来どおり同幅）。
function ribbonPath(r, c, taper) {
    const largeS = c.sa1 - c.sa0 > Math.PI ? 1 : 0;
    let t0 = c.ta0;
    let t1 = c.ta1;
    if (taper > 0) {
        const tm = (c.ta0 + c.ta1) / 2;
        const half = ((c.ta1 - c.ta0) / 2) * (1 - clamp(taper, 0, 1));
        t0 = tm - half;
        t1 = tm + half;
    }
    const largeT = t1 - t0 > Math.PI ? 1 : 0;
    return (
        `M${ptStr(r, c.sa0)}A${r},${r} 0 ${largeS} 1 ${ptStr(r, c.sa1)}` +
        `Q0,0 ${ptStr(r, t0)}A${r},${r} 0 ${largeT} 1 ${ptStr(r, t1)}` +
        `Q0,0 ${ptStr(r, c.sa0)}Z`
    );
}

// 自己ループ（送信元＝送信先）: 弧の内側の取付角 a0→a1 から外側へ膨らんで戻る小さなループ。
// 制御点を弧の外（半径 rOut）に置いた三次ベジェで、リボンとは逆に外向きに描く。
function selfLoopPath(rIn, rOut, a0, a1) {
    const [x0, y0] = pt(rIn, a0);
    const [x1, y1] = pt(rIn, a1);
    const [cx0, cy0] = pt(rOut, a0);
    const [cx1, cy1] = pt(rOut, a1);
    return (
        `M${x0.toFixed(2)},${y0.toFixed(2)}` +
        `C${cx0.toFixed(2)},${cy0.toFixed(2)} ${cx1.toFixed(2)},${cy1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`
    );
}

// リボン target 端に置く三角矢印。target サブ弧の中点で、中心→外向きに尖らせる。
function arrowPath(r, aMid, size) {
    const [bx, by] = pt(r, aMid); // 弧上の底辺中点
    // 進行方向（中心→外）の単位ベクトル
    const dx = Math.sin(aMid);
    const dy = -Math.cos(aMid);
    // 接線方向（弧に沿う）の単位ベクトル
    const tx = Math.cos(aMid);
    const ty = Math.sin(aMid);
    const tipX = bx + dx * size * 1.2;
    const tipY = by + dy * size * 1.2;
    const l1x = bx + tx * size * 0.7;
    const l1y = by + ty * size * 0.7;
    const l2x = bx - tx * size * 0.7;
    const l2y = by - ty * size * 0.7;
    return `M${tipX.toFixed(2)},${tipY.toFixed(2)}L${l1x.toFixed(2)},${l1y.toFixed(2)}L${l2x.toFixed(2)},${l2y.toFixed(2)}Z`;
}

// ---------------------------------------------------------------------------
// コンテナ実寸を購読するフック（ResizeObserver、無い環境では初回計測フォールバック）
// ---------------------------------------------------------------------------

function useContainerSize(ref) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const measure = () => {
            setSize((prev) => {
                const width = el.clientWidth;
                const height = el.clientHeight;
                if (prev.width === width && prev.height === height) return prev;
                return { width, height };
            });
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

// ---------------------------------------------------------------------------
// テーマ配色
// ---------------------------------------------------------------------------

function themeColors(mode) {
    if (mode === 'dark') {
        return {
            text: '#e1e6eb',
            muted: '#8a9aa8',
            arcStroke: 'rgba(255,255,255,0.20)',
            tooltipBg: 'rgba(23,29,36,0.96)',
            tooltipBorder: 'rgba(255,255,255,0.14)',
            headerBorder: 'rgba(255,255,255,0.10)',
        };
    }
    return {
        text: '#31373e',
        muted: '#6b7785',
        arcStroke: 'rgba(0,0,0,0.22)',
        tooltipBg: 'rgba(255,255,255,0.97)',
        tooltipBorder: 'rgba(0,0,0,0.14)',
        headerBorder: 'rgba(0,0,0,0.08)',
    };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

let uidSeq = 0;
let layoutVersionSeq = 0;

const nowSec = () =>
    (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;

function ChordFlow({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const containerRef = useRef(null);
    const { width, height } = useContainerSize(containerRef);
    const [hoverSel, setHoverSel] = useState(null); // ホバー中の選択 {type:'group'|'chord', key} | null
    const [focusSel, setFocusSel] = useState(null); // クリックでロックした選択 | null
    const [tooltip, setTooltip] = useState(null); // {x, y, lines} | null
    // 有効な選択 = ロック優先、無ければホバー。ツールチップ等の生の選択判定に使う。
    const hover = focusSel || hoverSel;
    // 強調の対象となる選択。ロック（クリック固定）は highlightOnHover の設定に関わらず有効。
    // ホバー由来の強調は highlightOnHover が ON のときだけ効かせる。rAF ループもこれを見る。
    const sel = focusSel || (opts.highlightOnHover ? hoverSel : null);
    const uid = useMemo(() => `cfw${(uidSeq += 1)}`, []);
    const colors = themeColors(mode);

    const data = dataSources?.primary?.data;
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && f.name !== undefined ? String(f.name) : String(f))),
        [data]
    );
    // 編集画面で選択されたフィールド（DOS 文字列/名前/配列）を列インデックスへ解決
    const colIdx = useMemo(() => ({
        s: resolveFieldIndex(opts.sourceField, fieldNames, rows, 0),
        t: resolveFieldIndex(opts.targetField, fieldNames, rows, 1),
        v: resolveFieldIndex(opts.valueField, fieldNames, rows, -1),
    }), [opts.sourceField, opts.targetField, opts.valueField, fieldNames, rows]);
    const graph = useMemo(
        () => buildGraph(rows, colIdx, opts.showSelfLoops),
        [rows, colIdx, opts.showSelfLoops]
    );

    // データが変わったらパーティクルを張り直すためのバージョン番号
    const layoutVersion = useMemo(() => (layoutVersionSeq += 1), [graph]);

    // ヘッダー分を差し引いた描画領域
    const headerH = opts.showHeader ? 34 : 0;
    const chartW = width;
    const chartH = Math.max(0, height - headerH);

    // ジオメトリ（角度レイアウト + 半径 + ラベルフィット）
    //
    // ラベル余白は「実ラベルの推定幅」から計算する（固定比率だと長い名前が見切れる）。
    // 収まらないときは 値の併記オフ → 名前の切り詰め → ラベル自体を非表示 の順に退避し、
    // リング半径を優先する（名前はツールチップで常に確認できる）。
    const layout = useMemo(() => {
        if (graph.error || chartW < 60 || chartH < 60) return null;
        const angles = layoutChords(graph, opts.arcPadding);
        if (!angles) return null;
        const size = Math.min(chartW, chartH);
        const fontSize = opts.labelSize > 0
            ? opts.labelSize
            : clamp(Math.round(size / 34), 9, 13);
        // 極小パネルでは値の併記を自動オフしてラベル余白を稼ぐ
        const showVals = opts.showValues && size >= 240;
        let showLabels = opts.showLabels;
        // 自己ループは outerR の外側（+max(10, outerR*0.10)）に描くため、
        // その張り出しぶんを余白として先に確保しないと小パネルで見切れる。
        const hasSelfLoop =
            opts.showSelfLoops && angles.groups.some((g) => g.selfA0 !== undefined);
        const selfLoopPad = hasSelfLoop ? Math.max(12, size * 0.06) : 0;
        let labelPad = 10;
        if (showLabels) {
            const maxLabelPx = angles.groups.reduce((m, g) => {
                const valW = showVals ? estTextWidth(` ${fmtCompact(g.total)}`, fontSize - 1) : 0;
                return Math.max(m, estTextWidth(g.name, fontSize) + valW);
            }, 0);
            // 必要幅ぶん確保しつつ、リングが痩せすぎないよう面積の 28% で頭打ち
            labelPad = clamp(maxLabelPx + 12, 24, size * 0.28);
        }
        // ラベルと自己ループの張り出しは同じ外側領域を使う。大きい方を確保する。
        labelPad = Math.max(labelPad, selfLoopPad);
        let outerR = size / 2 - labelPad;
        if (showLabels && outerR < 48) {
            // ラベルを確保するとリングが小さくなりすぎる → ラベルを諦めてリング優先。
            // ただし自己ループの張り出しぶんは残す（外側に描くため）。
            showLabels = false;
            labelPad = Math.max(10, selfLoopPad);
            outerR = size / 2 - labelPad;
        }
        if (outerR < 36) return { tooSmall: true };
        const thickness = opts.arcThickness > 0
            ? Math.min(opts.arcThickness, outerR * 0.5)
            : clamp(size * 0.035, 8, 22);
        const innerR = outerR - thickness;
        // 各ラベルを利用可能幅に切り詰め（値の併記分は先に確保）
        const availPx = labelPad - 12;
        const groups = angles.groups.map((g) => {
            const valText = showVals ? ` ${fmtCompact(g.total)}` : '';
            const valW = valText ? estTextWidth(valText, fontSize - 1) : 0;
            const label = showLabels
                ? fitText(g.name, fontSize, Math.max(availPx - valW, fontSize * 1.5))
                : g.name;
            return { ...g, label, valText };
        });
        return {
            ...angles, groups, outerR, innerR,
            cx: chartW / 2, cy: chartH / 2, fontSize, showLabels, showVals,
        };
    }, [graph, chartW, chartH, opts.arcPadding, opts.arcThickness,
        opts.showLabels, opts.showValues, opts.labelSize]);

    const layoutOk = !!(layout && !layout.tooSmall);

    // リボンの塗り色（value スケール > グラデーション > ソース色）
    const ribbonFill = (c, i) => {
        if (opts.useValueColors) {
            const span = layout.maxV - layout.minV;
            const t = span > 0 ? (c.value - layout.minV) / span : 0.5;
            return scaleColorFor(t, opts);
        }
        if (opts.useGradientRibbons && layout.groups[c.si].color !== layout.groups[c.ti].color) {
            return `url(#${uid}-g${i})`;
        }
        return layout.groups[c.si].color;
    };

    // パーティクルストリーム（リボンごとの経路・色・発生レート）。rAF ループは ref 経由で読む
    const streams = useMemo(() => {
        if (!layoutOk) return [];
        const { chords, innerR, minV, maxV } = layout;
        return chords.map((c, i) => {
            const span = maxV - minV;
            const t = span > 0 ? (c.value - minV) / span : 0.5;
            const color = opts.useValueColors
                ? scaleColorFor(t, opts)
                : layout.groups[c.si].color;
            const A = pt(innerR, (c.sa0 + c.sa1) / 2);
            const B = pt(innerR, (c.ta0 + c.ta1) / 2);
            // 発生レート（個/秒）: 最小でも 0.5、最大フローで 3.5
            const rate = 0.5 + 3.0 * (maxV > 0 ? c.value / maxV : 0.5);
            // ジッタ幅はリボン幅（サブ弧の弧長）に比例させ、リボンからはみ出しにくくする
            const halfW = Math.min((c.sa1 - c.sa0) * innerR, (c.ta1 - c.ta0) * innerR) / 2;
            return { A, B, color, rate, si: c.si, ti: c.ti, jitter: Math.min(halfW, innerR * 0.08) };
        });
    }, [layoutOk, layout, opts, uid]);

    // rAF ループから読む共有 ref（毎レンダー代入で stale closure を回避）
    const animRef = useRef({
        pool: [], // 生成済み circle 要素（再利用）
        particles: [], // アクティブパーティクル
        acc: [], // ストリームごとの発生アキュムレータ
        groupEl: null, // パーティクル用 <g>
        rotEl: null, // 回転対象 <g>
        rot: 0,
        appliedRot: null,
        last: 0,
        version: -1,
    });
    const geomRef = useRef({});
    geomRef.current = {
        streams,
        innerR: layoutOk ? layout.innerR : 0,
        version: layoutVersion,
        layoutOk,
    };
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const hoverRef = useRef(null);
    hoverRef.current = sel; // 有効な選択（ロック優先・ホバーは設定次第）。rAF ループが読む

    // rAF ループ（マウント中は常駐。パーティクル位置と回転 transform のみを直接更新）
    useEffect(() => {
        if (!layoutOk) return undefined;
        if (typeof requestAnimationFrame === 'undefined') return undefined;
        let rafId = 0;
        let alive = true;
        const anim = animRef.current;
        anim.last = nowSec();

        const hide = (p) => {
            if (p.el) {
                p.el.setAttribute('opacity', '0');
            }
        };
        const spawn = (streamIdx, t0) => {
            const geom = geomRef.current;
            const o = optsRef.current;
            const s = geom.streams[streamIdx];
            if (!s) return;
            let el = null;
            for (const cand of anim.pool) {
                if (!cand.busy) {
                    el = cand;
                    break;
                }
            }
            if (!el) {
                if (anim.pool.length >= MAX_PARTICLES || !anim.groupEl) return;
                const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                c.setAttribute('class', 'cf-particle');
                c.setAttribute('opacity', '0');
                anim.groupEl.appendChild(c);
                el = c;
                anim.pool.push(el);
            }
            el.busy = true;
            const jr = (Math.random() * 2 - 1) * s.jitter;
            const ja = Math.random() * Math.PI * 2;
            anim.particles.push({
                el,
                streamIdx,
                t: t0,
                sp: (1 / BASE_TRAVEL_SEC) * (0.85 + Math.random() * 0.3),
                cx: Math.cos(ja) * jr, // ベジェ制御点のジッタ（中心付近）
                cy: Math.sin(ja) * jr,
                size: o.particleSize,
            });
        };

        const step = () => {
            if (!alive) return;
            rafId = requestAnimationFrame(step);
            const geom = geomRef.current;
            const o = optsRef.current;
            const anim2 = animRef.current;
            const t = nowSec();
            const dt = clamp(t - anim2.last, 0, 0.1);
            anim2.last = t;

            // 回転（オプション時のみ transform を触る）
            if (anim2.rotEl) {
                if (o.rotateSpeed !== 0) anim2.rot = (anim2.rot + o.rotateSpeed * dt) % 360;
                const want = o.rotateSpeed !== 0 || anim2.rot !== 0 ? anim2.rot : 0;
                if (anim2.appliedRot !== want) {
                    anim2.rotEl.setAttribute('transform', `rotate(${want.toFixed(3)})`);
                    anim2.appliedRot = want;
                }
            }

            if (!geom.layoutOk) return;

            // データが変わったら全パーティクルを回収してプレウォーム
            if (anim2.version !== geom.version) {
                anim2.version = geom.version;
                anim2.particles.forEach((p) => {
                    hide(p);
                    p.el.busy = false;
                });
                anim2.particles = [];
                anim2.acc = geom.streams.map(() => 0);
                if (o.showParticles && o.particleDensity > 0) {
                    geom.streams.forEach((s, i) => {
                        const count = Math.min(5, Math.floor(s.rate * BASE_TRAVEL_SEC * 0.6));
                        for (let j = 0; j < count; j += 1) spawn(i, Math.random());
                    });
                }
            }

            // 発生
            if (o.showParticles && o.particleDensity > 0) {
                const density = o.particleDensity / 100;
                for (let i = 0; i < geom.streams.length; i += 1) {
                    anim2.acc[i] = (anim2.acc[i] || 0) + geom.streams[i].rate * density * dt;
                    while (anim2.acc[i] >= 1) {
                        anim2.acc[i] -= 1;
                        if (anim2.particles.length < MAX_PARTICLES) spawn(i, 0);
                    }
                }
            }

            // 移動・描画
            const speedF = o.particleSpeed / 100;
            const autoSize = clamp(geom.innerR * 0.018, 1.6, 4);
            const hov = hoverRef.current;
            const keep = [];
            for (const p of anim2.particles) {
                const s = geom.streams[p.streamIdx];
                if (!s || !o.showParticles) {
                    hide(p);
                    p.el.busy = false;
                    continue;
                }
                p.t += p.sp * speedF * dt;
                if (p.t >= 1) {
                    hide(p);
                    p.el.busy = false;
                    continue;
                }
                const u = p.t;
                const w = 1 - u;
                const x = w * w * s.A[0] + 2 * u * w * p.cx + u * u * s.B[0];
                const y = w * w * s.A[1] + 2 * u * w * p.cy + u * u * s.B[1];
                let alpha = Math.min(1, u / 0.12, (1 - u) / 0.12) * 0.95;
                if (hov) {
                    const active = hov.type === 'chord'
                        ? hov.key === p.streamIdx
                        : s.si === hov.key || s.ti === hov.key;
                    if (!active) alpha *= 0.12;
                }
                p.el.setAttribute('cx', x.toFixed(2));
                p.el.setAttribute('cy', y.toFixed(2));
                p.el.setAttribute('r', String(p.size > 0 ? p.size : autoSize));
                p.el.setAttribute('fill', s.color);
                p.el.setAttribute('opacity', alpha.toFixed(3));
                keep.push(p);
            }
            anim2.particles = keep;
        };

        rafId = requestAnimationFrame(step);
        return () => {
            alive = false;
            if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
        };
    }, [layoutOk]);

    // callback ref（ガード表示⇔本表示の切替で要素を確実に掴み直す）。
    // インライン関数だと再レンダーのたびに React が ref を付け直してプールが孤児化する
    // （古い circle が固まったまま残る）ため、useCallback([]) で安定化が必須。
    const particleGroupCb = useCallback((el) => {
        const anim = animRef.current;
        anim.groupEl = el;
        if (el) {
            while (el.firstChild) el.removeChild(el.firstChild);
        }
        anim.pool = [];
        anim.particles = [];
        anim.version = -1; // 再プレウォーム
    }, []);
    const rotGroupCb = useCallback((el) => {
        animRef.current.rotEl = el;
        animRef.current.appliedRot = null;
    }, []);

    // 強調（React 側: リボン・弧・ラベルの不透明度）
    const baseRibbonOpacity = opts.ribbonOpacity / 100;
    const ribbonOpacityFor = (c, idx) => {
        if (!sel) return baseRibbonOpacity;
        const active = sel.type === 'chord'
            ? sel.key === idx
            : c.si === sel.key || c.ti === sel.key;
        return active ? clamp(baseRibbonOpacity * 1.8, 0.6, 0.95) : baseRibbonOpacity * 0.12;
    };
    const groupOpacityFor = (gi) => {
        if (!sel) return 1;
        if (sel.type === 'group') {
            if (gi === sel.key) return 1;
            const related = layout.chords.some(
                (c) => (c.si === sel.key && c.ti === gi) || (c.ti === sel.key && c.si === gi)
            );
            return related ? 1 : 0.25;
        }
        const c = layout.chords[sel.key];
        if (!c) return 1;
        return c.si === gi || c.ti === gi ? 1 : 0.25;
    };

    // ツールチップ（コンテナ相対座標、右端では左に反転）
    const showTooltip = (evt, lines) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = evt.clientX - rect.left + 12;
        const y = clamp(evt.clientY - rect.top + 12, 0, Math.max(0, height - 80));
        if (x > width - 190) x = Math.max(0, evt.clientX - rect.left - 202);
        setTooltip({ x, y, lines });
    };
    const clearHover = () => {
        setHoverSel(null);
        setTooltip(null);
    };
    // クリックで選択をロック/解除（同じ対象を再クリックで解除、別対象で付け替え）
    const toggleFocus = (nextSel) => {
        if (!opts.clickToFocus) return;
        setFocusSel((prev) =>
            prev && prev.type === nextSel.type && prev.key === nextSel.key ? null : nextSel
        );
    };
    // 背景クリックでロック解除
    const clearFocus = () => setFocusSel(null);

    // ---- 状態別の表示 ----------------------------------------------------

    const centerBox = (child) => (
        <div
            ref={containerRef}
            style={{
                width: '100%', height: '100%', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
            }}
        >
            {child}
        </div>
    );

    if (loading && rows.length === 0) return centerBox(<WaitSpinner size="medium" />);
    if (!data || rows.length === 0) {
        return centerBox(<Paragraph>データがありません。結果を返すサーチを実行してください。</Paragraph>);
    }
    if (graph.error === 'columns') {
        return centerBox(
            <Paragraph>
                Chord Flow には最低3列が必要です（送信元・送信先・数値）。
            </Paragraph>
        );
    }
    if (graph.error === 'samefield') {
        return centerBox(
            <Paragraph>
                送信元フィールドと送信先フィールドは別の列にしてください（「データ」セクションで変更）。
            </Paragraph>
        );
    }
    if (graph.error === 'nolinks') {
        return centerBox(
            <Paragraph>
                有効なフローがありません。数値列が正の数か、送信元・送信先が空でないかを確認してください
                {graph.droppedSelf > 0 ? '（自己ループのみの場合は「自己ループを表示」をON）' : ''}。
            </Paragraph>
        );
    }
    if (layout && layout.tooSmall) {
        return centerBox(<Paragraph>パネルが小さすぎてコード図を描画できません。</Paragraph>);
    }

    const notices = [];
    if (graph.droppedEntities > 0) notices.push(`エンティティ${graph.droppedEntities}件`);
    if (graph.truncated > 0) notices.push(`小さいフロー${graph.truncated}件`);

    // ラベルサイズ・表示可否はレイアウト計算済みの値を使う（フィット判定と一致させる）
    const fontSize = layoutOk ? layout.fontSize : 11;

    // ヘッダーは幅に応じて段階的に簡略化する（nowrap で右端が見切れるのを防ぐ）。
    // 狭い順に：値カラー凡例 → 補助統計（除外/自己ループ/選択固定）→ を隠し、
    // フォントも縮める。ごく狭いときは合計＋エンティティ数のみ残す。
    const headerFont = clamp(Math.round(chartW / 32), 9, 12);
    const headerShowLegend = chartW >= 340;
    const headerShowExtras = chartW >= 240;

    // ---- 描画 ------------------------------------------------------------

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
            onMouseLeave={clearHover}
            onClick={clearFocus} /* 背景クリックでロック解除。要素側は stopPropagation する */
        >
            {opts.showHeader && layoutOk && (
                <div
                    style={{
                        height: headerH - 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: headerShowExtras ? 14 : 8,
                        padding: '0 8px',
                        fontSize: headerFont,
                        color: colors.muted,
                        borderBottom: `1px solid ${colors.headerBorder}`,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                    }}
                >
                    <span>
                        合計{' '}
                        <strong style={{ color: colors.text }}>{fmtFull(layout.totalFlow)}</strong>
                    </span>
                    <span>{layout.groups.length} エンティティ</span>
                    {headerShowExtras && <span>{layout.chords.length} フロー</span>}
                    {headerShowExtras && graph.hasSelf && (
                        <span>自己ループ {fmtCompact(graph.selfTotal)}</span>
                    )}
                    {headerShowExtras && notices.length > 0 && (
                        <span>（除外: {notices.join('・')}）</span>
                    )}
                    {headerShowExtras && focusSel && (
                        <span style={{ color: colors.text }}>● 選択固定中（背景クリックで解除）</span>
                    )}
                    {opts.useValueColors && headerShowLegend && (
                        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{fmtCompact(layout.minV)}</span>
                            <span
                                style={{
                                    width: 72,
                                    height: 8,
                                    borderRadius: 4,
                                    background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
                                        .map((t) => scaleColorFor(t, opts))
                                        .join(', ')})`,
                                }}
                            />
                            <span>{fmtCompact(layout.maxV)}</span>
                        </span>
                    )}
                </div>
            )}

            {layoutOk && (
                <svg
                    width={chartW}
                    height={chartH}
                    style={{ display: 'block' }}
                    role="img"
                    aria-label="Chord flow diagram"
                >
                    <defs>
                        {opts.glow && (
                            <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
                                <feGaussianBlur stdDeviation="2.2" result="b" />
                                <feMerge>
                                    <feMergeNode in="b" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        )}
                        {/* リボン用グラデーション（source 色 → target 色、リボン両端の座標で張る） */}
                        {opts.useGradientRibbons && !opts.useValueColors && layout.chords.map((c, i) => {
                            const [x1, y1] = pt(layout.innerR, (c.sa0 + c.sa1) / 2);
                            const [x2, y2] = pt(layout.innerR, (c.ta0 + c.ta1) / 2);
                            return (
                                <linearGradient
                                    key={`g${i}`}
                                    id={`${uid}-g${i}`}
                                    gradientUnits="userSpaceOnUse"
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                >
                                    <stop offset="0%" stopColor={layout.groups[c.si].color} />
                                    <stop offset="100%" stopColor={layout.groups[c.ti].color} />
                                </linearGradient>
                            );
                        })}
                    </defs>

                    <g transform={`translate(${layout.cx},${layout.cy})`}>
                        {/* 回転対象グループ（transform は rAF ループだけが触る） */}
                        <g ref={rotGroupCb}>
                            {/* リボン。
                                当たり判定は「常に全幅（テーパー無し）の透明パス」が担い、
                                見た目のリボンは pointerEvents:none。こうすると target 側を細く
                                しても細い部分でクリック/ホバーしづらくならない。
                                テーパーは向きを示す控えめな量（0.35）に抑え、前の同幅表示に寄せる。 */}
                            <g>
                                {layout.chords.map((c, i) => {
                                    const pctS = layout.totalFlow > 0
                                        ? ((c.value / layout.totalFlow) * 100).toFixed(1)
                                        : null;
                                    const locked = focusSel && focusSel.type === 'chord' && focusSel.key === i;
                                    const tipLines = [
                                        `${layout.groups[c.si].name} → ${layout.groups[c.ti].name}`,
                                        `${fmtFull(c.value)}${pctS !== null ? `（全体の${pctS}%）` : ''}`,
                                        ...(c.reverse > 0 ? [`⇄ 逆方向: ${fmtFull(c.reverse)}`] : []),
                                        ...(opts.clickToFocus
                                            ? [locked ? 'クリックで選択解除' : 'クリックで選択を固定']
                                            : []),
                                    ];
                                    return (
                                        <g key={`r${i}`}>
                                            {/* 当たり判定（全幅・透明）。クリック/ホバーはここで受ける */}
                                            <path
                                                className="cf-ribbon-hit"
                                                d={ribbonPath(layout.innerR, c, 0)}
                                                fill="#000"
                                                fillOpacity={0}
                                                style={{ cursor: opts.clickToFocus ? 'pointer' : 'default' }}
                                                onMouseEnter={() => setHoverSel({ type: 'chord', key: i })}
                                                onMouseMove={(evt) => showTooltip(evt, tipLines)}
                                                onMouseLeave={clearHover}
                                                onClick={(evt) => {
                                                    evt.stopPropagation();
                                                    toggleFocus({ type: 'chord', key: i });
                                                }}
                                            />
                                            {/* 見た目（テーパーは控えめ）。イベントは拾わない */}
                                            <path
                                                className="cf-ribbon"
                                                d={ribbonPath(layout.innerR, c, opts.taperRibbons ? 0.35 : 0)}
                                                fill={ribbonFill(c, i)}
                                                fillOpacity={ribbonOpacityFor(c, i)}
                                                stroke={locked ? colors.text : 'none'}
                                                strokeWidth={locked ? 1 : 0}
                                                style={{ transition: 'fill-opacity 120ms', pointerEvents: 'none' }}
                                            />
                                        </g>
                                    );
                                })}
                            </g>

                            {/* 自己ループ（送信元＝送信先）。オプション ON かつ self>0 のエンティティに描く */}
                            {opts.showSelfLoops && (
                                <g fill="none">
                                    {layout.groups.map((g, gi) => {
                                        if (!(g.self > 0) || g.selfA0 === undefined) return null;
                                        const loopR = layout.outerR + Math.max(10, layout.outerR * 0.10);
                                        return (
                                            <path
                                                key={`self${gi}`}
                                                className="cf-selfloop"
                                                d={selfLoopPath(layout.innerR, loopR, g.selfA0, g.selfA1)}
                                                stroke={g.color}
                                                strokeWidth={clamp(Math.max(2, layout.innerR * 0.02), 2, 6)}
                                                strokeLinecap="round"
                                                opacity={groupOpacityFor(gi)}
                                                style={{ transition: 'opacity 120ms', cursor: 'default' }}
                                                onMouseEnter={() => setHoverSel({ type: 'group', key: gi })}
                                                onMouseMove={(evt) => showTooltip(evt, [
                                                    `${g.name} ↺ 自己ループ`,
                                                    `${fmtFull(g.self)}`,
                                                ])}
                                                onMouseLeave={clearHover}
                                            />
                                        );
                                    })}
                                </g>
                            )}

                            {/* 矢印（target サブ弧中点に、リボン幅連動サイズで） */}
                            {opts.showArrows && (
                                <g style={{ pointerEvents: 'none' }}>
                                    {layout.chords.map((c, i) => {
                                        const aMid = (c.ta0 + c.ta1) / 2;
                                        const w = (c.ta1 - c.ta0) * layout.innerR;
                                        const size = clamp(w * 0.5, 3, 10);
                                        return (
                                            <path
                                                key={`arr${i}`}
                                                className="cf-arrow"
                                                d={arrowPath(layout.innerR, aMid, size)}
                                                fill={layout.groups[c.ti].color}
                                                opacity={ribbonOpacityFor(c, i) > 0.3 ? 0.9 : 0.15}
                                            />
                                        );
                                    })}
                                </g>
                            )}

                            {/* エンティティの弧 */}
                            <g>
                                {layout.groups.map((g, gi) => {
                                    const locked = focusSel && focusSel.type === 'group' && focusSel.key === gi;
                                    return (
                                        <path
                                            key={`a${gi}`}
                                            className="cf-arc"
                                            d={arcPath(layout.innerR, layout.outerR, g.startAngle, g.endAngle)}
                                            fill={g.color}
                                            stroke={locked ? colors.text : colors.arcStroke}
                                            strokeWidth={locked ? 1.5 : 0.5}
                                            opacity={groupOpacityFor(gi)}
                                            style={{
                                                transition: 'opacity 120ms',
                                                cursor: opts.clickToFocus ? 'pointer' : 'default',
                                            }}
                                            onMouseEnter={() => setHoverSel({ type: 'group', key: gi })}
                                            onMouseMove={(evt) => showTooltip(evt, [
                                                g.name,
                                                `送信 ${fmtFull(g.out)} / 受信 ${fmtFull(g.in)}`,
                                                `合計 ${fmtFull(g.total)}`,
                                                ...(g.self > 0 ? [`↺ 自己ループ ${fmtFull(g.self)}`] : []),
                                                ...(opts.clickToFocus
                                                    ? [locked ? 'クリックで選択解除' : 'クリックで選択を固定']
                                                    : []),
                                            ])}
                                            onMouseLeave={clearHover}
                                            onClick={(evt) => {
                                                evt.stopPropagation();
                                                toggleFocus({ type: 'group', key: gi });
                                            }}
                                        />
                                    );
                                })}
                            </g>

                            {/* ラベル（放射方向。左半分は 180° 反転して読みやすく。
                                表示可否・切り詰めはレイアウト計算済み） */}
                            {layout.showLabels && (
                                <g style={{ pointerEvents: 'none' }}>
                                    {layout.groups.map((g, gi) => {
                                        const span = (g.endAngle - g.startAngle) * layout.outerR;
                                        const hovered = hover && hover.type === 'group' && hover.key === gi;
                                        if (span < fontSize * 0.8 && !hovered) return null;
                                        const deg = (g.mid * 180) / Math.PI;
                                        const flip = g.mid > Math.PI;
                                        return (
                                            <text
                                                key={`t${gi}`}
                                                className="cf-label"
                                                transform={`rotate(${(deg - 90).toFixed(2)}) translate(${layout.outerR + 7},0)${flip ? ' rotate(180)' : ''}`}
                                                textAnchor={flip ? 'end' : 'start'}
                                                dy="0.35em"
                                                fontSize={fontSize}
                                                fill={colors.text}
                                                opacity={groupOpacityFor(gi)}
                                                style={{ transition: 'opacity 120ms' }}
                                            >
                                                {g.label}
                                                {g.valText && (
                                                    <tspan fill={colors.muted} fontSize={fontSize - 1}>
                                                        {g.valText}
                                                    </tspan>
                                                )}
                                            </text>
                                        );
                                    })}
                                </g>
                            )}

                            {/* パーティクル（子要素は rAF ループが直接管理。React は触らない） */}
                            <g
                                ref={particleGroupCb}
                                style={{ pointerEvents: 'none' }}
                                filter={opts.glow ? `url(#${uid}-glow)` : undefined}
                            />
                        </g>
                    </g>
                </svg>
            )}

            {/* ツールチップ */}
            {tooltip && (
                <div
                    style={{
                        position: 'absolute',
                        left: tooltip.x,
                        top: tooltip.y,
                        maxWidth: 240,
                        padding: '6px 10px',
                        borderRadius: 6,
                        background: colors.tooltipBg,
                        border: `1px solid ${colors.tooltipBorder}`,
                        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                        color: colors.text,
                        fontSize: 12,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                        zIndex: 10,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {tooltip.lines.map((line, i) => (
                        <div key={i} style={i === 0 ? { fontWeight: 600 } : { color: colors.muted }}>
                            {line}
                        </div>
                    ))}
                </div>
            )}

            {/* 診断オーバーレイ（options の生値を確認する。dynamicColor 事件の教訓） */}
            {opts.debug && (
                <pre
                    style={{
                        position: 'absolute',
                        right: 4,
                        bottom: 4,
                        maxWidth: '60%',
                        maxHeight: '60%',
                        overflow: 'auto',
                        margin: 0,
                        padding: 8,
                        fontSize: 10,
                        background: colors.tooltipBg,
                        border: `1px solid ${colors.tooltipBorder}`,
                        borderRadius: 6,
                        color: colors.text,
                        zIndex: 20,
                    }}
                >
                    {JSON.stringify({ options, normalized: opts }, null, 2)}
                </pre>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（テーマガード必須: テーマ未取得の間はレンダリングしない）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <ChordFlow mode={mode} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。公式フックは購読登録時に現在値を再送しないため、
// 初期 state がマウントより後に届くと取り逃して永久に描画されないことがある。
// 最大5秒待っても揃わない場合はフォールバック描画（テーマは light 既定）に入る。
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
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
