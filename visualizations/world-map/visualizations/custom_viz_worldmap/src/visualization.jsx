import {
    VisualizationExtensionProvider,
    useDataSources,
    useOptions,
    useTheme,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン API は /react ではなくコア側にある（公式 docs の記載は誤り。
// 型定義 visualization.d.mts の export 一覧で確認済み）。
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import Select from '@splunk/react-ui/Select';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { geoBounds, geoNaturalEarth1, geoPath } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { feature } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import worldTopo50 from 'world-atlas/countries-50m.json';
import CITY_DATA from './data/cities.json';
import COUNTRY_JA from './data/country-names-ja.json';
import './visualization.css';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
// 色分けの基準となる列（categoryField）は **何でもよい**。
// severity（深刻度）とは限らず、ログ種別・プロトコル・部署・ステータス等、
// ユーザーが選んだ任意の文字列カテゴリを色分けに使える。
//
// 【設計方針】色の決定は「ユーザーが明示したものだけ」に依存する
//   この viz は以前 KNOWN_SEVERITY_ORDER（critical→high→medium→low）で
//   カテゴリを勝手に並べ替え、その順にパレットを配っていた。これは
//   「色分けの基準は深刻度である」という前提を viz が押し付けるもので、
//   ログ種別（`auth` / `firewall` / `dns` …）のような語彙では
//   **並び順に意味が無いのに色だけ勝手に決まる**という問題があった。
//
//   現在は「カテゴリ名 → 色」をユーザーが editor.arrayOfStrings で
//   1行ずつ明示する。viz 側の語彙推測・自動解釈は一切行わない。
//   マッピングに無いカテゴリは fallbackColor（既定色）で描く。
//
// 明示マッピングが1件も無いときだけ、見た目が壊れないよう最低限の
// 既定色として使う（ユーザーが色を決めていない状態のプレースホルダ）。
const DEFAULT_CATEGORY_COLOR = '#38a6ff';

/**
 * 「カテゴリ名|色」形式の行（editor.arrayOfStrings）を解釈して
 * Map<カテゴリ名(小文字), 色文字列> を返す。
 *
 * 受け付ける書式（tab-selector の「表示名|トークン値」と同じ区切り文字）:
 *   "high|#ff0000"      → high を赤
 *   "auth | #00ff00"    → 空白は無視
 *   "firewall|red"      → CSS 色名も可（parseColor が解釈できるものはそのまま使う）
 *
 * 色が解釈できない行・区切りが無い行は**黙って捨てる**（描画を壊さない）。
 * 大文字小文字は同一視する（`High` と `high` を別カテゴリにしない）。
 */
function parseCategoryColorMap(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    raw.forEach((line) => {
        if (typeof line !== 'string') return;
        const sep = line.indexOf('|');
        if (sep < 0) return;
        const name = line.slice(0, sep).trim();
        const color = line.slice(sep + 1).trim();
        if (name === '' || color === '') return;
        // parseColor で解釈できる色だけ採用（不正値で描画が壊れるのを防ぐ）
        if (parseColor(color) === null) return;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, color);
    });
    return map;
}

// ライト/ダークモード別の地図配色
const MAP_PALETTES = {
    dark: {
        containerBg: '#03080f',
        bgStops: [
            { offset: '0%', color: '#0a1a33' },
            { offset: '60%', color: '#061224' },
            { offset: '100%', color: '#03080f' },
        ],
        landGlow: '#1d5aa8',
        landGlowOpacity: 0.4,
        landFill: '#0d2b52',
        landStroke: '#3d84d6',
        landStrokeOpacity: 0.35,
        titleColor: '#f2f6fb',
        titleShadow: '0 0 14px rgba(60, 140, 255, 0.6)',
        panelBg: 'rgba(10, 24, 46, 0.85)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendBg: 'rgba(10, 24, 46, 0.75)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.25)',
        legendText: '#e8eef6',
        // 地名ラベル（地図由来）と始点/終点ラベル（データ由来）。
        // labelHalo は文字の縁取り色（背景に溶けず読めるようにする）
        placeLabel: '#cfe0f5',
        endpointLabel: '#ffffff',
        labelHalo: 'rgba(3, 8, 15, 0.9)',
    },
    light: {
        containerBg: '#dde7f2',
        bgStops: [
            { offset: '0%', color: '#f6fafe' },
            { offset: '60%', color: '#e9f0f8' },
            { offset: '100%', color: '#dde7f2' },
        ],
        landGlow: '#9db8d8',
        landGlowOpacity: 0.35,
        landFill: '#c3d4e6',
        landStroke: '#6f96c2',
        landStrokeOpacity: 0.6,
        titleColor: '#16283e',
        titleShadow: '0 0 10px rgba(255, 255, 255, 0.8)',
        panelBg: 'rgba(255, 255, 255, 0.88)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.45)',
        legendBg: 'rgba(255, 255, 255, 0.82)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendText: '#24354a',
        placeLabel: '#31445c',
        endpointLabel: '#0e1a29',
        labelHalo: 'rgba(255, 255, 255, 0.92)',
    },
};

// ---------------------------------------------------------------------------
// 色ユーティリティ
// （ユーザーが設定した線の色から、ホットスポットのグローと中心点の色を導出する）
// Splunkのカラーピッカーは "transparent" やアルファ付きhex（#RRGGBBAA）を
// 返すことがあるため、{r, g, b, a} に正規化して扱う
// ---------------------------------------------------------------------------
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// 手入力（editor.arrayOfStrings の「カテゴリ名|色」）で使われやすい色名。
// tint/shade でトーンを導出する都合上 {r,g,b} が必要なため、
// ブラウザ任せにせず自前で hex に解決する。ここに無い色名は hex 指定を促す。
const NAMED_COLORS = {
    red: '#ff0000', crimson: '#dc143c', orange: '#ffa500', gold: '#ffd700',
    yellow: '#ffff00', lime: '#00ff00', green: '#008000', teal: '#008080',
    cyan: '#00ffff', aqua: '#00ffff', blue: '#0000ff', navy: '#000080',
    purple: '#800080', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb',
    brown: '#a52a2a', white: '#ffffff', black: '#000000', gray: '#808080',
    grey: '#808080', silver: '#c0c0c0',
};

// 色文字列を {r, g, b, a} へ変換。解釈できない値は null
function parseColor(value) {
    if (typeof value !== 'string') return null;
    let v = value.trim().toLowerCase();
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED_COLORS[v]) v = NAMED_COLORS[v];
    if (!HEX_RE.test(v)) return null;
    let h = v.slice(1);
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
}

function toCss({ r, g, b, a }) {
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

// 白と混ぜて明るいトーンを作る（amount: 0=元の色, 1=白）。アルファは維持
function tint(c, amount) {
    const mix = (v) => Math.round(v + (255 - v) * amount);
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// 黒と混ぜて暗いトーンを作る（amount: 0=元の色, 1=黒）。アルファは維持
function shade(c, amount) {
    const mix = (v) => Math.round(v * (1 - amount));
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// ---------------------------------------------------------------------------
// 世界地図（ビルド時にバンドルされるため実行時のインターネット通信は不要）
// ---------------------------------------------------------------------------
const WORLD = (() => {
    try {
        const geo = feature(worldTopo, worldTopo.objects.countries);
        geo.features = geo.features.filter((f) => f?.properties?.name !== 'Antarctica');
        return geo;
    } catch (e) {
        return null;
    }
})();

// 高詳細の国境（Natural Earth 50m 相当）。世界全体表示では 110m で十分なため、
// 初めて必要になったときに一度だけデコードして使い回す（初期表示を遅くしない）。
// デコードに失敗しても 110m へ退避して描画は続ける。
let WORLD_50M_CACHE = null;
function getWorld50() {
    if (WORLD_50M_CACHE) return WORLD_50M_CACHE;
    try {
        const geo = feature(worldTopo50, worldTopo50.objects.countries);
        geo.features = geo.features.filter((f) => f?.properties?.name !== 'Antarctica');
        WORLD_50M_CACHE = geo;
    } catch (e) {
        WORLD_50M_CACHE = WORLD;
    }
    return WORLD_50M_CACHE;
}

// mapDetail='auto' の 110m ↔ 50m 切替ズーム。
// 上げるとき（IN）と下げるとき（OUT）をずらしたヒステリシスにして、
// しきい値付近のズーム操作で詳細度がパカパカ切り替わるのを防ぐ。
// IN=4 は実測に基づく：50m は画面内の国だけに絞ってもパス生成が
// zoom3 で約31ms/フレームと重く、zoom4 以上なら約16ms以下に収まる。
const DETAIL_ZOOM_IN = 4;
const DETAIL_ZOOM_OUT = 3;

// ---------------------------------------------------------------------------
// ビューポート絞り込み（50m 国境を操作中も使い続けるための最適化）
// ---------------------------------------------------------------------------
// 50m の全 242 フィーチャを毎フレーム投影すると約 60ms/フレームかかり、
// ドラッグ / ズームがカクつく。ズーム中は画面に映る国が数個〜数十個しか
// 無いため、**フィーチャの経緯度バウンディングボックスが画面と重なるものだけ**
// パス生成する（zoom6 で 15/242 件・約13ms/フレームまで下がる実測）。

// 各フィーチャの経緯度バウンディングボックスを一度だけ計算して付与する
function ensureFeatureBounds(world) {
    if (!world || world.__boundsReady) return;
    try {
        world.features.forEach((f) => {
            f.__bounds = geoBounds(f);
        });
        world.__boundsReady = true;
    } catch (e) {
        /* 失敗しても絞り込み無しで描けるので握りつぶす */
    }
}

// 画面の枠を逆投影して「見えている経緯度範囲」を求める。
// 経度は中心経度からの角距離（±180 をまたいでも壊れない形）で持つ。
// 逆投影が十分に取れない（＝ほぼ世界全体が見えている）場合は null ＝絞り込み無し。
function viewportGeoBounds(projection, size, centerLon) {
    if (!projection || !projection.invert || !size) return null;
    const { w, h } = size;
    let dLon = 0;
    let minLat = 90;
    let maxLat = -90;
    let ok = 0;
    const SAMPLES = 16;
    for (let i = 0; i < SAMPLES; i += 1) {
        const t = i / (SAMPLES - 1);
        const pts = [[t * w, 0], [t * w, h], [0, t * h], [w, t * h]];
        for (const [x, y] of pts) {
            const g = projection.invert([x, y]);
            if (!g || !g.every(Number.isFinite)) continue;
            ok += 1;
            const d = Math.abs((((g[0] - centerLon) % 360) + 540) % 360 - 180);
            if (d > dLon) dLon = d;
            if (g[1] < minLat) minLat = g[1];
            if (g[1] > maxLat) maxLat = g[1];
        }
    }
    if (ok < SAMPLES) return null; // 枠の多くが地図の外＝広域表示。絞り込み不要
    return {
        dLon: Math.min(dLon * 1.15 + 2, 180), // 端でのポップイン防止マージン
        minLat: minLat - 3,
        maxLat: maxLat + 3,
    };
}

// フィーチャのバウンディングボックスが表示範囲と重なるか（経度は円環として判定）
function featureInView(f, vb, centerLon) {
    const b = f.__bounds;
    if (!b) return true; // バウンディングボックスが無ければ安全側（描く）
    const [[west, south], [east, north]] = b;
    if (north < vb.minLat || south > vb.maxLat) return false;
    if (west > east) return true; // 反対経線をまたぐ広大なフィーチャは保守的に描く
    const dw = ((((west - centerLon) % 360) + 540) % 360) - 180;
    const de = ((((east - centerLon) % 360) + 540) % 360) - 180;
    const d = dw <= 0 && de >= 0 ? 0 : Math.min(Math.abs(dw), Math.abs(de));
    return d <= vb.dLon;
}

// 国名ラベルの表示位置（各国ポリゴンの重心を経緯度で保持）。
// 投影は毎フレーム変わるので、ここでは地理座標のままにしておき描画時に投影する。
// 面積の小さい国は低ズームで潰れるため、面積順でしきい値を持たせる。
const COUNTRY_LABELS = (() => {
    if (!WORLD) return [];
    try {
        const path = geoPath(geoNaturalEarth1());
        return WORLD.features
            .map((f) => {
                const name = f?.properties?.name;
                if (!name) return null;
                const c = path.centroid(f);
                if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
                // 投影平面上の面積を「表示に値する大きさ」の代理指標にする
                const area = Math.abs(path.area(f)) || 0;
                // 重心を経緯度へ戻す（描画時に現在の投影で投影し直すため）
                const inv = geoNaturalEarth1().invert ? geoNaturalEarth1().invert(c) : null;
                if (!inv || !Number.isFinite(inv[0]) || !Number.isFinite(inv[1])) return null;
                // 日本語国名（Natural Earth admin-0 の NAME_JA 由来・パブリックドメイン）
                return { name, ja: COUNTRY_JA[name] || '', lon: inv[0], lat: inv[1], area };
            })
            .filter(Boolean)
            .sort((a, b) => b.area - a.area);
    } catch (e) {
        return [];
    }
})();

// 都市ラベル（Natural Earth ne_10m_populated_places / パブリックドメイン）。
// [name, lon, lat, scalerank, isCapital, name_ja?] のタプル配列。scalerank は小さいほど主要。
// 重要度順にソート済みなので、ズームに応じて先頭から N 件を採用すればよい。
// 6要素目の日本語名（NAME_JA）は英語名と同じ場合に省略されている。
const CITY_LABELS = (() => {
    try {
        if (!Array.isArray(CITY_DATA)) return [];
        return CITY_DATA.map((c) => {
            if (!Array.isArray(c) || c.length < 4) return null;
            const [name, lon, lat, rank, cap, ja] = c;
            if (typeof name !== 'string' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
                return null;
            }
            return {
                name,
                ja: typeof ja === 'string' ? ja : '',
                lon,
                lat,
                rank: Number(rank) || 0,
                capital: cap === 1,
            };
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
})();

// ---------------------------------------------------------------------------
// カメラ（ズーム / 中心座標）
// ---------------------------------------------------------------------------
// zoom=1 が「世界全体がパネルに収まる」状態。地図アプリと同じくホイールで
// 拡大縮小し、ドラッグでパンする。上限は都市名が読める程度まで。
const ZOOM_MIN = 1;
const ZOOM_MAX = 40;
// ホイール1ノッチあたりの倍率（トラックパッドの細かい delta でも滑らかに効く）
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 経度は -180..180 に正規化（入力が 190 や -400 でも破綻させない）
function wrapLon(lon) {
    let v = ((lon + 180) % 360 + 360) % 360 - 180;
    if (!Number.isFinite(v)) v = 0;
    return v;
}

/**
 * ズーム段階に応じて表示するラベルを決める。
 *
 * 低ズームでは主要国のみ、拡大するほど小さい国 → 主要都市 → 地方都市の順に
 * 現れる（地図アプリの挙動）。件数を絞ることで文字の洪水と描画負荷を防ぐ。
 */
/**
 * カメラ（中心経緯度＋ズーム）から投影を作る。
 *
 * 描画とズーム計算の両方がこの関数を通ることで、「画面上のどこが
 * どの地理座標か」の解釈が必ず一致する（食い違うとホイールズームが
 * カーソル位置からずれる）。
 *
 *   - 経度方向は rotate で回す（東西の継ぎ目が出ない）
 *   - 緯度方向は投影後の translate で寄せる（rotate すると図法が歪むため）
 */
function makeProjection(size, camera) {
    if (!WORLD || !size) return null;
    try {
        const { w, h } = size;
        // 世界全体がちょうど収まる基準スケール（zoom=1 の定義）
        const baseScale = geoNaturalEarth1().fitSize([w, h], WORLD).scale();
        const projection = geoNaturalEarth1()
            .rotate([-camera.lon, 0])
            .scale(baseScale * camera.zoom)
            .translate([w / 2, h / 2]);
        const centerPt = projection([camera.lon, camera.lat]);
        if (centerPt && centerPt.every(Number.isFinite)) {
            projection.translate([
                w / 2 - (centerPt[0] - w / 2),
                h / 2 - (centerPt[1] - h / 2),
            ]);
        }
        return projection;
    } catch (e) {
        return null;
    }
}

function labelBudget(zoom, density) {
    // density: 地名の表示量の倍率（ユーザー設定。1 = 標準）
    const k = Number.isFinite(density) && density > 0 ? density : 1;
    // 国: zoom1 で 14 件、zoom8 以上でほぼ全件
    const countries = Math.round(
        clamp((10 + (zoom - 1) * 14) * k, 10, COUNTRY_LABELS.length || 10)
    );
    // 都市: zoom<2 では出さない（世界表示では国名だけの方が読みやすい）。
    // 上限はデータ件数そのもの（画面内に絞ってから採るので、
    // 実際に描かれる数は重なり判定で自然に頭打ちになる）。
    let cities = 0;
    if (zoom >= 2) {
        cities = Math.round(clamp((zoom - 2) * 40 * k + 20 * k, 0, CITY_LABELS.length || 0));
    }
    return { countries, cities };
}

// ---------------------------------------------------------------------------
// 件数（count）しきい値の色分け（colorMode='count'）
// ---------------------------------------------------------------------------
// editor.threshold から届く [{from, to, value}] を正規化する。
// openRanges:true のため from/to は null（開いた範囲）でありうる → ±Infinity に読み替える。
// 色が解釈できない行・数値でない行は捨てる（描画を壊さない）。from 昇順に整列する。
function normalizeThresholds(raw) {
    if (!Array.isArray(raw)) return [];
    const bands = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const from = b.from === null || b.from === undefined ? -Infinity : Number(b.from);
        const to = b.to === null || b.to === undefined ? Infinity : Number(b.to);
        if (Number.isNaN(from) || Number.isNaN(to) || from > to) return;
        if (typeof b.value !== 'string' || parseColor(b.value) === null) return;
        bands.push({ from, to, value: b.value });
    });
    bands.sort((a, b) => a.from - b.from || a.to - b.to);
    return bands;
}

// バンドの表示名（凡例・フィルタ・ツールチップに使う）。
// 判定は from <= count < to（下端を含み上端を含まない）
function bandLabel(band) {
    if (!Number.isFinite(band.from) && !Number.isFinite(band.to)) return 'すべて';
    if (!Number.isFinite(band.from)) return `${band.to}未満`;
    if (!Number.isFinite(band.to)) return `${band.from}以上`;
    return `${band.from}〜${band.to}`;
}

// ホストは既定値と同じ値を options に載せないため、未設定（＝schema の default のまま）は
// ここで同じ内容を再現する。schema 側の default と一致させておくこと
const DEFAULT_COUNT_BANDS = [
    { from: 0, to: 100, value: '#38a6ff' },
    { from: 100, to: Infinity, value: '#ff5a2e' },
];

// ---------------------------------------------------------------------------
// オプション正規化（未設定・型不一致でも安全側に倒す）
// ---------------------------------------------------------------------------
const LABEL_LANGS = ['en', 'ja'];
const MAP_DETAILS = ['auto', 'low', 'high'];
const COLOR_MODES = ['category', 'count'];

function normalizeOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    return {
        showTitle: bool(o.showTitle, true),
        // タイトル文字列。編集画面のテキスト欄で自由に変更できる。
        // 空文字は「タイトル無し」として尊重する（既定値へ戻さない）。
        // ホストは未設定のキーを options に載せないため、
        // 「キーが無い＝未設定」だけを既定値に倒す。
        titleText:
            typeof o.titleText === 'string' ? o.titleText : 'GLOBAL THREAT MAP',
        showLegend: bool(o.showLegend, true),
        showFilter: bool(o.showFilter, true),
        // 光の筋がパスを走り切る秒数。0 でアニメーション停止（静的表示）
        animDuration: Math.min(Math.max(num(o.animDuration, 2.8), 0), 60),
        // --- カメラ（地図の中心とズーム） ---
        // 中心経度・中心緯度。ここを変えると地図の中心が動く（例: 経度135=日本中心）
        centerLon: wrapLon(num(o.centerLon, 0)),
        centerLat: clamp(num(o.centerLat, 0), -85, 85),
        // 初期ズーム倍率。1=世界全体
        initialZoom: clamp(num(o.initialZoom, 1), ZOOM_MIN, ZOOM_MAX),
        // ホイールズーム / ドラッグパンを許可するか
        enableZoom: bool(o.enableZoom, true),
        // --- 弧の見た目・件数 ---
        // count に応じた太さの強調度。0 で一律の細線、大きいほど差が出る
        widthScale: clamp(num(o.widthScale, 1), 0, 10),
        // 描画する弧の上限（count の多い順）。0 で無制限
        maxArcs: Math.max(0, Math.round(num(o.maxArcs, 0))),
        // 地点にマウスを乗せたとき、その地点に繋がる弧だけを強調する
        highlightOnHover: bool(o.highlightOnHover, true),
        // 近接した地点をまとめる半径（画面px）。0 で集約しない（1点1マーカー）。
        // 画面距離なので、ズームすると同じ設定値でもクラスタは自然に分離する
        clusterRadius: clamp(num(o.clusterRadius, 18), 0, 80),
        // 凡例に「表示 N / 全 M」の内訳を出す
        showTotals: bool(o.showTotals, true),
        // 凡例の各カテゴリ行に件数を併記する
        showCategoryCounts: bool(o.showCategoryCounts, true),
        // --- 地図の詳細度（国境の解像度） ---
        // auto: ズームに応じて 110m → 50m へ切り替え / low: 常に 110m / high: 常に 50m
        mapDetail: MAP_DETAILS.includes(o.mapDetail) ? o.mapDetail : 'auto',
        // --- 地名ラベル ---
        showPlaceLabels: bool(o.showPlaceLabels, true),
        showEndpointLabels: bool(o.showEndpointLabels, true),
        placeLabelSize: clamp(num(o.placeLabelSize, 11), 6, 24),
        // 地名の表示量の倍率。大きいほど多くの地名が出る（重なると自動で間引かれる）
        labelDensity: clamp(num(o.labelDensity, 1), 0.2, 5),
        // 地名の言語（地図由来の国名・都市名のみ。データ由来の src_name/dst_name には影響しない）
        labelLang: LABEL_LANGS.includes(o.labelLang) ? o.labelLang : 'en',
        // --- 色分けモード ---
        // category: 色分け列の文字列カテゴリで色分け（従来どおり）
        // count:    件数（count）のしきい値バンドで色分け（editor.threshold）
        colorMode: COLOR_MODES.includes(o.colorMode) ? o.colorMode : 'category',
        countThresholds: (() => {
            const bands = normalizeThresholds(o.countThresholds);
            return bands.length > 0 ? bands : DEFAULT_COUNT_BANDS;
        })(),
        // --- 色分け（カテゴリ） ---
        // 「カテゴリ名|色」の明示マッピング。ここに書かれたものだけが色の根拠になる
        categoryColors: Array.isArray(o.categoryColors) ? o.categoryColors : [],
        // マッピングに無いカテゴリの色（未分類をどう見せるか）
        fallbackColor:
            parseColor(o.fallbackColor) !== null ? o.fallbackColor : DEFAULT_CATEGORY_COLOR,
        // 凡例・フィルタに出すカテゴリの並び順（明示指定が最優先）
        categoryOrder: Array.isArray(o.categoryOrder) ? o.categoryOrder : [],
        // 色分けの基準列を何と呼ぶか（凡例やフィルタの見出しに使う表示上のラベル）
        categoryLabel:
            typeof o.categoryLabel === 'string' && o.categoryLabel.trim() !== ''
                ? o.categoryLabel.trim()
                : '',
        // フィールド選択（editor.columnSelector）。未設定は名前ベースの自動判定
        srcLatField: o.srcLatField,
        srcLonField: o.srcLonField,
        dstLatField: o.dstLatField,
        dstLonField: o.dstLonField,
        categoryField: o.categoryField,
        countField: o.countField,
        srcNameField: o.srcNameField,
        dstNameField: o.dstNameField,
    };
}

// ---------------------------------------------------------------------------
// データ処理ユーティリティ
// ---------------------------------------------------------------------------
function normalizeData(data) {
    if (data.rows && data.rows.length > 0) return data.rows;
    if (data.columns && data.columns.length > 0) {
        const numRows = data.columns[0].length;
        return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
    }
    return [];
}

function findFieldIndex(fieldNames, candidates) {
    return fieldNames.findIndex((name) => candidates.includes(String(name).toLowerCase()));
}

/**
 * editor.columnSelector の選択値を列インデックスへ解決する。
 * カスタムvizには DOS 文字列（"> primary | seriesByName('x')"）が未解決のまま
 * 届くため自前でパースする。以下すべてを受けて壊れない:
 * - 未設定/空文字 → fallbackIdx（名前ベースの自動判定結果）
 * - DOS 文字列 → seriesByName / seriesByIndex を正規表現で解決
 * - 生フィールド名 → そのまま照合
 * - ホスト解決済みの列データ（配列）→ 先頭数行を各列と照合して特定
 */
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
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

// 色分けカテゴリが空だった行に使う表示名。
// 「未分類」という事実を示すだけで、深刻度のような意味は持たせない。
const UNCATEGORIZED = '(未分類)';

/**
 * サーチ結果をレコードの配列へ変換する。
 * 列の決定: editor.columnSelector の選択が最優先。未設定の列は
 * フィールド名の候補リスト（src_lat 等）で自動判定する。
 * 必須: 起点/終点の緯度経度4列。任意: 色分けカテゴリ, count, 表示名2列。
 *
 * カテゴリ値はサーチ結果の文字列を**そのまま**使う（大文字小文字だけ同一視し、
 * 最初に登場した表記を代表とする）。viz 側で意味の解釈・並べ替えは行わない。
 */
function parseThreats(fieldNames, rows, opts) {
    const lower = fieldNames.map((f) => String(f).toLowerCase());
    const auto = {
        srcLat: findFieldIndex(lower, ['src_lat', 'source_lat', 'slat']),
        srcLon: findFieldIndex(lower, ['src_lon', 'src_lng', 'source_lon', 'slon']),
        dstLat: findFieldIndex(lower, ['dst_lat', 'dest_lat', 'target_lat', 'dlat']),
        dstLon: findFieldIndex(lower, ['dst_lon', 'dst_lng', 'dest_lon', 'target_lon', 'dlon']),
        // 色分け列の自動判定は「よくある列名」の便宜的な当て推量にすぎない。
        // severity 以外（category/type/status…）も同列に扱い、深刻度を特別視しない。
        // 明示指定（categoryField）があれば常にそちらが優先される。
        category: findFieldIndex(lower, [
            'category', 'type', 'log_type', 'event_type', 'status', 'protocol',
            'severity', 'threat_level', 'level',
        ]),
        count: findFieldIndex(lower, ['count', 'events', 'total']),
        srcName: findFieldIndex(lower, ['src_name', 'src', 'source']),
        dstName: findFieldIndex(lower, ['dst_name', 'dst', 'dest', 'target']),
    };
    const iSrcLat = resolveFieldIndex(opts.srcLatField, fieldNames, rows, auto.srcLat);
    const iSrcLon = resolveFieldIndex(opts.srcLonField, fieldNames, rows, auto.srcLon);
    const iDstLat = resolveFieldIndex(opts.dstLatField, fieldNames, rows, auto.dstLat);
    const iDstLon = resolveFieldIndex(opts.dstLonField, fieldNames, rows, auto.dstLon);
    const iCat = resolveFieldIndex(opts.categoryField, fieldNames, rows, auto.category);
    const iCount = resolveFieldIndex(opts.countField, fieldNames, rows, auto.count);
    const iSrcName = resolveFieldIndex(opts.srcNameField, fieldNames, rows, auto.srcName);
    const iDstName = resolveFieldIndex(opts.dstNameField, fieldNames, rows, auto.dstName);

    if (iSrcLat < 0 || iSrcLon < 0 || iDstLat < 0 || iDstLon < 0) {
        return { threats: [], missingFields: true, hasCount: false };
    }

    // 表記ゆれ（high / High / HIGH）を同一カテゴリに束ねる。
    // 代表表記は「最初に登場したもの」＝データ側の表記を尊重する。
    const catCanon = new Map();
    const toCategory = (raw) => {
        const s = String(raw ?? '').trim();
        if (s === '') return UNCATEGORIZED;
        const key = s.toLowerCase();
        if (!catCanon.has(key)) catCanon.set(key, s);
        return catCanon.get(key);
    };

    const threats = [];
    rows.forEach((row, i) => {
        const srcLat = parseFloat(row[iSrcLat]);
        const srcLon = parseFloat(row[iSrcLon]);
        const dstLat = parseFloat(row[iDstLat]);
        const dstLon = parseFloat(row[iDstLon]);
        if (![srcLat, srcLon, dstLat, dstLon].every(Number.isFinite)) return;
        if (Math.abs(srcLat) > 90 || Math.abs(dstLat) > 90) return;
        threats.push({
            id: i,
            srcLat,
            srcLon,
            dstLat,
            dstLon,
            category: toCategory(iCat >= 0 ? row[iCat] : ''),
            count: iCount >= 0 ? parseFloat(row[iCount]) || 1 : 1,
            srcName: iSrcName >= 0 ? String(row[iSrcName] ?? '') : '',
            dstName: iDstName >= 0 ? String(row[iDstName] ?? '') : '',
        });
    });
    // count 列が解決できたかを返す（件数サマリーの単位を「件」/「本」で切り替えるため）
    return { threats, missingFields: false, hasCount: iCount >= 0 };
}

/**
 * サーチ結果に登場したカテゴリの一覧（表示順）と色の割り当てを作る。
 *
 * 【重要】色も並び順も、viz は一切推測しない。
 *
 * - **色**: `categoryColors`（「カテゴリ名|色」の明示マッピング）に書かれた色だけを使う。
 *   マッピングに無いカテゴリは `fallbackColor` で描く（勝手にパレットを配らない）。
 *   これにより「深刻度だと思って赤が振られる」ような意図しない色付けが起きない。
 * - **並び順**: `categoryOrder` に書かれた順を最優先。書かれていないカテゴリは
 *   その後ろに**検索結果への登場順**で続く（同じサーチなら毎回同じ順序＝決定的）。
 *   語彙の意味（critical が high より重い等）による並べ替えはしない。
 */
function buildCategoryModel(threats, opts) {
    // 検索結果に実際に登場したカテゴリ（登場順）
    const seen = [];
    threats.forEach((t) => {
        if (!seen.includes(t.category)) seen.push(t.category);
    });

    // 並び順: ユーザー指定を先頭に（指定されたが実データに無いものは出さない）
    const orderSpec = opts.categoryOrder
        .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
        .filter((s) => s !== '');
    const ordered = [];
    orderSpec.forEach((key) => {
        const hit = seen.find((s) => s.toLowerCase() === key);
        if (hit !== undefined && !ordered.includes(hit)) ordered.push(hit);
    });
    const categoryList = [...ordered, ...seen.filter((s) => !ordered.includes(s))];

    // 色: 明示マッピングのみ。無ければ fallbackColor
    const colorMap = parseCategoryColorMap(opts.categoryColors);
    const fallback = parseColor(opts.fallbackColor) || parseColor(DEFAULT_CATEGORY_COLOR);
    const categoryColors = {};
    // どのカテゴリがユーザー指定の色を持つか（凡例で「未設定」を示すのに使う）
    const explicit = {};
    categoryList.forEach((cat) => {
        const hit = colorMap.get(cat.toLowerCase());
        explicit[cat] = hit !== undefined;
        categoryColors[cat] = (hit !== undefined ? parseColor(hit) : null) || fallback;
    });
    return { categoryList, categoryColors, explicit };
}

// 弧（2次ベジェ曲線）の制御点を求める。
// SVG パス文字列と Canvas サンプリングの両方で同一曲線を使うため、
// 制御点 (cx, cy) を単一の関数から供給して食い違いを防ぐ。
function arcControl(sx, sy, tx, ty) {
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    const nx = -dy / dist;
    const ny = dx / dist;
    const bend = dist * 0.22;
    const dir = ny < 0 ? 1 : -1;
    const cx = mx + nx * bend * dir;
    const cy = my + ny * bend * dir - dist * 0.12;
    return { cx, cy };
}

// 弧（ベジェ曲線）の SVG パス文字列を生成（ベース軌道の描画に使用）
function arcPath(sx, sy, tx, ty) {
    const { cx, cy } = arcControl(sx, sy, tx, ty);
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

// 2次ベジェの点 (t: 0..1)。Canvas での彗星サンプリングに使用
function bezierPoint(sx, sy, cx, cy, tx, ty, t) {
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    return { x: a * sx + b * cx + c * tx, y: a * sy + b * cy + c * ty };
}

// ツールチップ用の地点表記（名前が無ければ緯度経度で代替）
function pointLabel(name, lat, lon) {
    return name || `${lat.toFixed(1)}, ${lon.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// 地点クラスタリング（画面距離ベース）
// ---------------------------------------------------------------------------
// 【なぜ必要か】v1.8.2 までの地点集約は「投影後の座標を小数1桁で丸めたキー」
// （`${x.toFixed(1)},${y.toFixed(1)}`）の完全一致だけで、実質 0.1px 以内に
// 重なった点しかまとまらなかった。IP ジオロケーションのデータは同一都市でも
// 緯度経度がわずかにばらけるため、東京付近に数百個のホットスポットが重なって
// 描かれ、弧の終端も同様に潰れて読めなくなる。
//
// ここでは **画面上の距離** で集約する。地理座標ではなく画面距離を使うのは、
// ズームすると同じ radius が地理的により狭い範囲を指すことになり、
// 拡大するにつれてクラスタが自然に分離する（地図アプリのピンクラスタと同じ挙動）ため。
//
// アルゴリズム: radius をセル幅とした均一グリッドに点を撒き、各点は自セル＋
// 隣接8セルだけを探索して既存クラスタに吸着する（総当たり O(n^2) を避ける）。
// 入力順に貪欲に処理するので、同じ入力なら常に同じ結果になる（決定的）。
//
// 代表座標はクラスタ内の **count 加重平均**。件数の多い地点へ寄るため、
// 大量の小さな地点に引っ張られて代表点が実態からずれるのを防ぐ。
//
// 【重み付けの安全弁】count は生のサーチ結果なので 0 や負値もありうる
// （`| eval count=a-b` のような差分を入れられる）。負の重みをそのまま使うと
// 加重平均がクラスタの外へ飛ぶ（実測: x=100 と x=110 の2点に count=10/-9 を
// 与えると代表点が x=10 になる）。重みは 0 以上に丸め、合計が 0 以下の
// ときは単純平均へ退避する。arcWidth が Math.max(count,0) で守っているのと同じ方針。
function clusterPoints(points, radius) {
    if (!(radius > 0)) return null;
    const cell = radius;
    const grid = new Map();
    const clusters = [];
    const key = (cx, cy) => `${cx}|${cy}`;
    // 重みは非負に丸める（負値・NaN は 0 として扱う）
    const weightOf = (p) => (Number.isFinite(p.count) && p.count > 0 ? p.count : 0);
    // 重みの合計が 0（全点が count<=0）のクラスタは単純平均で代表点を出す
    const recenter = (c) => {
        if (c.w > 0) {
            c.x = c.ax / c.w;
            c.y = c.ay / c.w;
            return;
        }
        let sx = 0;
        let sy = 0;
        c.members.forEach((m) => {
            sx += m.x;
            sy += m.y;
        });
        c.x = sx / c.members.length;
        c.y = sy / c.members.length;
    };
    points.forEach((p) => {
        const cx = Math.floor(p.x / cell);
        const cy = Math.floor(p.y / cell);
        // 自セル＋隣接8セルの中から、半径内で最も近いクラスタを探す
        let best = null;
        let bestD2 = radius * radius;
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                const bucket = grid.get(key(cx + dx, cy + dy));
                if (!bucket) continue;
                bucket.forEach((ci) => {
                    const c = clusters[ci];
                    const d2 = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
                    if (d2 <= bestD2) {
                        bestD2 = d2;
                        best = ci;
                    }
                });
            }
        }
        if (best === null) {
            // 新しいクラスタ。位置はグリッドに登録した時点で固定する
            // （吸着で代表点が動くとグリッドとの整合が崩れるため、
            //   セル登録は「作成時の座標」で行い、以降も同じセルに属させる）
            const ci = clusters.length;
            const w0 = weightOf(p);
            clusters.push({
                x: p.x,
                y: p.y,
                ax: p.x * w0,
                ay: p.y * w0,
                w: w0,
                members: [p],
            });
            const k = key(cx, cy);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(ci);
        } else {
            const c = clusters[best];
            const w = weightOf(p);
            c.members.push(p);
            c.ax += p.x * w;
            c.ay += p.y * w;
            c.w += w;
            // 代表座標は count 加重平均へ更新（吸着判定の中心も追従させる）
            recenter(c);
        }
    });
    return clusters;
}

// カスタムツールチップをカーソル近くへ置く。右端・下端ではカーソルの反対側へ
// 反転させ、パネルの外へはみ出さないようにする
function applyTooltipPos(el, x, y, w, h) {
    const tw = el.offsetWidth || 240;
    const th = el.offsetHeight || 52;
    let left = x + 14;
    if (left + tw > w - 6) left = Math.max(6, x - tw - 14);
    let top = y + 16;
    if (top + th > h - 6) top = Math.max(6, y - th - 12);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

// 件数の桁区切り表記（8432 → "8,432"）。
// toLocaleString はロケール依存で happy-dom / 実機の差が出るため自前で整形する。
function formatCount(n) {
    if (!Number.isFinite(n)) return '0';
    const v = Math.round(n);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ツールチップ用のカテゴリ表記。末尾に区切りを含めて返す（呼び出し側は
// `(${describeCategory(c)}count N)` の形で使う）。
// 色分け列が無い／値が空のときは「(未分類)」を出さず、カテゴリごと省略する。
function describeCategory(category) {
    return !category || category === UNCATEGORIZED ? '' : `${category}, `;
}

// ---------------------------------------------------------------------------
// コンテナの実サイズを監視するフック
// （地図をパネル全体にフィットさせるため）
// ---------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w > 0 && h > 0) {
                setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
            }
        };
        update();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return [ref, size];
}

// ---------------------------------------------------------------------------
// 弧を流れる「光の帯」キャンバス
//   流れる筋だけを Canvas に描く（地図・陸地・ホットスポット・弧のベース軌道は
//   SVG のまま）。元の意図どおり「カテゴリ色の短いセグメントが弧に沿って
//   飛んでいく」表現。
//   ※加算合成(lighter)での発光は廃止：弧が終点に収束する場所で重なった光の
//     RGB が飽和して真っ白に見えたため。通常合成＋純粋なカテゴリ色のみで
//     描くことで、何本重なっても色相が保たれる（白くならない）。
//   チープな単色ベタ棒に見せないため:
//     - 帯は「両端が滑らかに窄まるテーパー形状」のポリゴンを 1 回塗りで描く
//       （幅・不透明度とも sin エンベロープで両端 0 へ。急な切れ目が無い）
//     - 下に太く淡い同色グローを敷き、柔らかい輪郭を出す
//   実装メモ:
//     - 弧は 2次ベジェ。SVG と同じ制御点(arcControl)をサンプリングして完全一致。
//     - ポリゴン 1 回塗りなのでサンプル同士のアルファ累積も起きない。
//     - animDuration=0 で rAF を回さない（静的表示。CPU 0）。
//     - devicePixelRatio は 2 で頭打ち（高精細でも描画量を抑える）。
// ---------------------------------------------------------------------------
// 帯の弧長比（パス全体に対する光の帯の長さ）
const FLOW_LEN = 0.22;
// 帯を構成するサンプル点の数（多いほど滑らか。数十本×この数でも 60fps 余裕）
const FLOW_SAMPLES = 16;

function ArcFlowCanvas({ arcs, width, height, duration, hoverKey }) {
    const canvasRef = useRef(null);
    // 最新の arcs / サイズを rAF ループから参照するための ref（再購読でループを
    // 張り直さず、値だけ差し替える）
    const stateRef = useRef({ arcs, width, height, duration, hoverKey });
    stateRef.current = { arcs, width, height, duration, hoverKey };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !width || !height) return undefined;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;

        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));

        let raf = 0;
        let start = 0;

        // 光の帯1本を描く。head は帯の先頭位置(0..1)。帯は head から後方へ
        // FLOW_LEN ぶんの区間を占め、幅・不透明度とも sin エンベロープで
        // 前後両端に向かって 0 に窄まる（テーパー形状）。
        const drawFlow = (a, head, dim) => {
            const { sx, sy, cx, cy, tx, ty, color, w } = a;
            // 帯の中心線サンプル（座標＋法線＋エンベロープ）を先に集める
            const pts = [];
            for (let k = 0; k <= FLOW_SAMPLES; k += 1) {
                const u = k / FLOW_SAMPLES; // 0=帯の先頭, 1=帯の末尾
                const tt = head - u * FLOW_LEN;
                if (tt < 0 || tt > 1) continue; // パス外（出発前/到達後）は描かない
                const p = bezierPoint(sx, sy, cx, cy, tx, ty, tt);
                // 2次ベジェの接線 → 単位法線（帯の幅方向）
                const dx = 2 * (1 - tt) * (cx - sx) + 2 * tt * (tx - cx);
                const dy = 2 * (1 - tt) * (cy - sy) + 2 * tt * (ty - cy);
                const len = Math.hypot(dx, dy) || 1;
                pts.push({
                    x: p.x,
                    y: p.y,
                    nx: -dy / len,
                    ny: dx / len,
                    env: Math.sin(Math.PI * u),
                });
            }
            if (pts.length < 2) return;
            // 中心線の左右に halfWidth ぶん張り出したテーパーポリゴンを 1 回で
            // 塗る。重ね塗りしないのでアルファが累積せず、色は fillStyle の
            // カテゴリ色を超えない（＝白飛びしない）。
            const fillBand = (scale, alpha) => {
                ctx.beginPath();
                pts.forEach((p, i) => {
                    const hw = w * scale * p.env;
                    if (i === 0) ctx.moveTo(p.x + p.nx * hw, p.y + p.ny * hw);
                    else ctx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
                });
                for (let i = pts.length - 1; i >= 0; i -= 1) {
                    const p = pts[i];
                    const hw = w * scale * p.env;
                    ctx.lineTo(p.x - p.nx * hw, p.y - p.ny * hw);
                }
                ctx.closePath();
                ctx.globalAlpha = alpha;
                ctx.fill();
            };
            ctx.save();
            ctx.fillStyle = color;
            // ホバー強調中、関係しない弧は薄く描く（0.18 倍）
            const k = dim ? 0.18 : 1;
            fillBand(2.4, 0.18 * k); // 太く淡い同色グロー（柔らかい輪郭）
            fillBand(1.0, 0.9 * k); // 締まった芯
            ctx.restore();
        };

        const frame = (now) => {
            const st = stateRef.current;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, st.width, st.height);
            if (st.duration > 0 && st.arcs.length > 0) {
                if (!start) start = now;
                // 全弧で位相を共有（同時に出発・到達）。帯の先頭は 0→1 を周回。
                // 帯の末尾が終点を過ぎてから次周が始点に入るよう、1+FLOW_LEN 周期で
                // 動かして「到達 → 一瞬消える → 再出発」を途切れなくループさせる。
                const phase = ((now - start) / (st.duration * 1000)) % 1;
                const head = phase * (1 + FLOW_LEN);
                st.arcs.forEach((a) =>
                    drawFlow(a, head, st.hoverKey ? a.srcKey !== st.hoverKey && a.dstKey !== st.hoverKey : false)
                );
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [width, height]);

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 1,
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// 表示ステート
// ---------------------------------------------------------------------------
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function MessageState({ message }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <Paragraph>{message}</Paragraph>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// マップ本体
// ---------------------------------------------------------------------------
function ThreatMap({ threats, hasCount, mode, categoryList, categoryColors, explicit, customBg, customLand, opts }) {
    const [categoryFilter, setCategoryFilter] = useState('all');
    // ホバー中の地点キー（"x,y"）。その地点に繋がる弧だけを強調する
    const [hoverKey, setHoverKey] = useState(null);
    // カスタムツールチップ（ブラウザ標準の <title> は表示が遅くスタイルも
    // 当たらないため自前で描く）。内容は state で持ち（表示/非表示の切替のみ
    // 再レンダリング）、カーソル追従は ref への直接書き込みで行う
    // （mousemove のたびに SVG 全体を再レンダリングしない）。
    const [tooltip, setTooltip] = useState(null); // { lines: string[] }
    const tooltipRef = useRef(null);
    const tooltipPosRef = useRef({ x: 0, y: 0 });
    const [containerRef, size] = useContainerSize();
    const palette = MAP_PALETTES[mode] || MAP_PALETTES.dark;

    // --- カメラ状態 -------------------------------------------------------
    // オプションで与えられた中心・ズームを初期値とし、以降はユーザーの
    // ホイール / ドラッグ操作で上書きする（地図アプリと同じ挙動）。
    // オプション側が変わったらカメラをそれに追従させる（編集画面で経度を
    // 入力した結果が即座に地図へ反映されるように）。
    const [camera, setCamera] = useState(() => ({
        lon: opts.centerLon,
        lat: opts.centerLat,
        zoom: opts.initialZoom,
    }));

    // 編集画面でオプションを変えたときはカメラをリセットする。
    // 手動操作した後でもオプション変更が確実に効くよう、オプション値の
    // 変化だけを依存にする（camera 自体を依存に入れるとループする）。
    useEffect(() => {
        setCamera({ lon: opts.centerLon, lat: opts.centerLat, zoom: opts.initialZoom });
    }, [opts.centerLon, opts.centerLat, opts.initialZoom]);

    // 「操作が落ち着いたカメラ」。ドラッグ / ホイール操作中は camera が毎フレーム
    // 変わるため、重い処理（地名ラベルの選定・50m 国境への切替）はこちらに
    // 追従させる。camera が LABEL_SETTLE_MS 動かなかったら同期する。
    const LABEL_SETTLE_MS = 150;
    const [settledCamera, setSettledCamera] = useState(camera);
    useEffect(() => {
        const id = setTimeout(() => setSettledCamera(camera), LABEL_SETTLE_MS);
        return () => clearTimeout(id);
    }, [camera]);

    // アニメーション: animDuration=0 で停止（静的表示）
    const animOn = opts.animDuration > 0;

    // サーチ結果が変わってフィルタ中のカテゴリが消えた場合は全件表示に戻す
    const effectiveFilter =
        categoryFilter === 'all' || categoryList.includes(categoryFilter)
            ? categoryFilter
            : 'all';

    // カテゴリ → 表示順index（グラデーションIDとホットスポットの代表色選びに使う）
    const catIndex = useMemo(
        () => Object.fromEntries(categoryList.map((s, i) => [s, i])),
        [categoryList]
    );

    // 背景: カスタム背景色が有効なら、その色からグラデーションを生成して
    // テーマ配色を上書きする（中心をやや明るく・外周をやや暗く）
    // 完全透過（transparent / アルファ0）の場合はグラデーションを描かず、
    // ダッシュボードのパネル背景をそのまま透かす
    const background = useMemo(() => {
        if (!customBg) {
            return { containerBg: palette.containerBg, bgStops: palette.bgStops };
        }
        if (customBg.a === 0) {
            return { containerBg: 'transparent', bgStops: null };
        }
        return {
            containerBg: toCss(shade(customBg, 0.4)),
            bgStops: [
                { offset: '0%', color: toCss(tint(customBg, 0.12)) },
                { offset: '60%', color: toCss(customBg) },
                { offset: '100%', color: toCss(shade(customBg, 0.4)) },
            ],
        };
    }, [customBg, palette]);

    // 陸地: カスタム陸地色が有効なら、縁取りとグローもその色から導出する。
    // 完全透過の場合は陸地を描画しない
    const land = useMemo(() => {
        if (!customLand) {
            return {
                visible: true,
                glow: palette.landGlow,
                glowOpacity: palette.landGlowOpacity,
                fill: palette.landFill,
                stroke: palette.landStroke,
                strokeOpacity: palette.landStrokeOpacity,
            };
        }
        if (customLand.a === 0) {
            return { visible: false };
        }
        return {
            visible: true,
            glow: toCss(tint(customLand, 0.25)),
            glowOpacity: palette.landGlowOpacity,
            fill: toCss(customLand),
            stroke: toCss(tint(customLand, 0.4)),
            strokeOpacity: 0.5,
        };
    }, [customLand, palette]);

    // 線の色から導出する派生色（ホットスポットの中心点・グロー・コメット先端）
    const derived = useMemo(() => {
        const out = {};
        categoryList.forEach((sev) => {
            const base = categoryColors[sev];
            out[sev] = {
                css: toCss(base),
                core: toCss(tint(base, 0.72)),
                glowInner: toCss(tint(base, 0.55)),
                glowMid: toCss(tint(base, 0.2)),
            };
        });
        return out;
    }, [categoryList, categoryColors]);

    // パネルの実サイズとカメラに合わせて投影を計算。
    //
    // 従来は fitExtent + preserveAspectRatio="none" で「引き伸ばして全面に敷く」
    // 実装だったが、それではズームしても地理的に正しい拡大にならない。
    // ここでは:
    //   1. 一度 fitSize で「世界全体がちょうど収まる」基準スケールを求める
    //   2. そのスケールに zoom を掛け、rotate で中心経度、translate で中心緯度を寄せる
    // これで地図アプリと同じ「中心を保ったまま拡大縮小」が成立する。
    // 描画に使う国境データ。mapDetail='high'（常に50m）/'low'（常に110m）/
    // 'auto'（ズームに応じて切替。上げ=4倍・下げ=3倍のヒステリシス付き）。
    //
    // 【v1.8.1】操作中（ドラッグ・ズーム）も詳細度を落とさない。
    // v1.8.0 では「操作中は110m・静止後に50m」の段階的描画にしていたが、
    // 操作のたびに国境が粗くなるのは操作感が悪いという指摘を受けて廃止した。
    // 代わりに、50m のコスト問題（全242国のパス生成で約60ms/フレーム）は
    // 「画面に映っている国だけをパス生成する」ビューポート絞り込みで解決している
    // （geo memo 内。zoom6 実測で 15/242 件・約13ms/フレーム）。
    const detailRef = useRef(false);
    if (opts.mapDetail === 'high') {
        detailRef.current = true;
    } else if (opts.mapDetail === 'low') {
        detailRef.current = false;
    } else {
        detailRef.current = detailRef.current
            ? camera.zoom >= DETAIL_ZOOM_OUT
            : camera.zoom >= DETAIL_ZOOM_IN;
    }
    const activeWorld = detailRef.current ? getWorld50() : WORLD;

    const geo = useMemo(() => {
        const projection = makeProjection(size, camera);
        if (!projection) return null;
        try {
            const path = geoPath(projection);
            // ズーム中は画面外の国をパス生成から除外する（50m を常用するための
            // 最適化。110m でも無害に効く）。広域表示（zoom<2）では画面枠の
            // 逆投影が世界全体を覆って絞り込めないため、全件描画する。
            let features = activeWorld.features;
            if (camera.zoom >= 2) {
                ensureFeatureBounds(activeWorld);
                const vb = viewportGeoBounds(projection, size, camera.lon);
                if (vb) {
                    features = features.filter((f) => featureInView(f, vb, camera.lon));
                }
            }
            return {
                projection,
                path,
                landPath: features.map((f) => path(f)).join(' '),
            };
        } catch (e) {
            return null;
        }
    }, [size, camera, activeWorld]);

    // --- ホイールズーム / ドラッグパン -------------------------------------
    // カーソル位置を固定点として拡大する（地図アプリの標準挙動）。
    // wheel は passive:false でないと preventDefault できないため、
    // React の onWheel ではなくネイティブリスナーで張る。
    const cameraRef = useRef(camera);
    cameraRef.current = camera;
    const geoRef = useRef(geo);
    geoRef.current = geo;
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const zoomEnabledRef = useRef(opts.enableZoom);
    zoomEnabledRef.current = opts.enableZoom;

    // ズーム後も「カーソルが指していた地点」がカーソル位置に留まるように中心を補正する。
    //   1. 拡大前にカーソルが指していた地理座標 anchor を得る
    //   2. 新ズームの投影を作り、そこで anchor がどこに来るかを見る
    //   3. ズレたぶんだけ中心をずらす（＝ずらした後の中心が指す地理座標を新しい中心にする）
    const recenterFrom = useCallback((screenX, screenY, nextZoom) => {
        const g = geoRef.current;
        const s = sizeRef.current;
        if (!g || !s || !g.projection.invert) return;
        const anchor = g.projection.invert([screenX, screenY]);
        if (!anchor || !anchor.every(Number.isFinite)) return;

        const cur = cameraRef.current;
        const zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
        // 中心は据え置きのままズームだけ変えた投影を作る
        const probe = makeProjection(s, { lon: cur.lon, lat: cur.lat, zoom });
        if (!probe || !probe.invert) {
            setCamera((c) => ({ ...c, zoom }));
            return;
        }
        const after = probe(anchor);
        if (!after || !after.every(Number.isFinite)) {
            setCamera((c) => ({ ...c, zoom }));
            return;
        }
        // anchor がカーソルからズレた量だけ、画面中心を逆向きに動かす
        const target = probe.invert([
            s.w / 2 + (after[0] - screenX),
            s.h / 2 + (after[1] - screenY),
        ]);
        if (target && target.every(Number.isFinite)) {
            setCamera({ lon: wrapLon(target[0]), lat: clamp(target[1], -85, 85), zoom });
        } else {
            setCamera((c) => ({ ...c, zoom }));
        }
    }, []);

    // wheel はネイティブリスナー（passive:false）で登録し、ページスクロールを止める
    const wheelElRef = useRef(null);
    const attachWheel = useCallback((el) => {
        wheelElRef.current = el;
    }, []);

    useEffect(() => {
        const el = wheelElRef.current;
        if (!el || !opts.enableZoom) return undefined;
        const onWheel = (e) => {
            if (!zoomEnabledRef.current) return;
            // オーバーレイUI（ドロップダウンの選択肢リスト等）の上でのホイールは
            // 地図のズームにしない。リストのスクロールを妨げないため。
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-viz-ui="1"]')) {
                return;
            }
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const s = sizeRef.current;
            // カーソル位置を固定点にする。座標が取れない環境ではパネル中心を使う
            // （NaN のまま計算すると投影が壊れてズームが黙って効かなくなる）
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                if (!s) return;
                x = s.w / 2;
                y = s.h / 2;
            }
            const cur = cameraRef.current;
            const delta = Number.isFinite(e.deltaY) ? e.deltaY : 0;
            if (delta === 0) return;
            // deltaY>0（手前に回す）で縮小。指数変換で倍率が滑らかに変わる
            const factor = Math.exp(-delta * ZOOM_WHEEL_SENSITIVITY);
            recenterFrom(x, y, cur.zoom * factor);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [opts.enableZoom, recenterFrom, geo !== null, size !== null]);

    // ドラッグでパン（ポインタイベントでマウス/タッチ両対応）
    const dragRef = useRef(null);
    const onPointerDown = useCallback((e) => {
        if (!zoomEnabledRef.current) return;
        // 【重要】オーバーレイUI（フィルタのドロップダウン等）の上で押した場合は
        // パンを開始しない。ここで setPointerCapture すると以降のポインタイベントが
        // すべてコンテナへ横取りされ、Select が自身の pointerup / click を
        // 受け取れなくなる（＝クリックしてもドロップダウンが開かない）。
        // data-viz-ui="1" を付けた要素の内側からの操作は viz 側では扱わない。
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-viz-ui="1"]')) {
            return;
        }
        const g = geoRef.current;
        if (!g || !g.projection.invert) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;
        const origin = g.projection.invert([px, py]);
        if (!origin || !origin.every(Number.isFinite)) return;
        dragRef.current = { origin, rect, camera: cameraRef.current, moved: false };
        // ポインタ捕捉は「実際に動き始めてから」行う（onPointerMove 側）。
        // 押した瞬間に捕捉すると、単なるクリックでも下の要素がイベントを失う。
    }, []);

    const onPointerMove = useCallback((e) => {
        const drag = dragRef.current;
        const g = geoRef.current;
        if (!drag || !g || !g.projection.invert) return;
        const here = g.projection.invert([
            e.clientX - drag.rect.left,
            e.clientY - drag.rect.top,
        ]);
        if (!here || !here.every(Number.isFinite)) return;
        // 実際に動き始めた最初の1回だけポインタを捕捉する。
        // こうするとクリック（押して離すだけ）では捕捉が起きないため、
        // オーバーレイUIや将来のドリルダウンのクリックを妨げない。
        if (!drag.moved) {
            drag.moved = true;
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch (err) { /* 未対応環境では捕捉なしでも概ね動く */ }
        }
        // 掴んだ地点がカーソルに追従するよう中心をずらす
        const cur = cameraRef.current;
        setCamera({
            lon: wrapLon(cur.lon - (here[0] - drag.origin[0])),
            lat: clamp(cur.lat - (here[1] - drag.origin[1]), -85, 85),
            zoom: cur.zoom,
        });
    }, []);

    const endDrag = useCallback((e) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (!drag.moved) return; // 捕捉していないので解放も不要
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch (err) { /* noop */ }
    }, []);

    // ダブルクリックで初期表示（オプションの中心・ズーム）へ戻す
    const onDoubleClick = useCallback(() => {
        setCamera({ lon: opts.centerLon, lat: opts.centerLat, zoom: opts.initialZoom });
    }, [opts.centerLon, opts.centerLat, opts.initialZoom]);

    // ツールチップのカーソル追従（state を介さず DOM を直接動かす）
    const positionTooltip = useCallback((e) => {
        const host = containerRef.current;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        tooltipPosRef.current = { x, y };
        const el = tooltipRef.current;
        if (el) applyTooltipPos(el, x, y, rect.width || 0, rect.height || 0);
    }, [containerRef]);

    // 表示直後は要素の実サイズが確定してから位置を合わせ直す
    // （初回レンダリング時点では offsetWidth が取れないため）
    useEffect(() => {
        const el = tooltipRef.current;
        if (!el || !size) return;
        applyTooltipPos(el, tooltipPosRef.current.x, tooltipPosRef.current.y, size.w, size.h);
    }, [tooltip, size]);

    // フィルタと上限（maxArcs）は投影前のデータに適用する。
    // カメラ操作では変わらないため、地名ラベルの選定など「操作中に再計算したくない」
    // 処理の依存をここに寄せられる（投影後の visible はカメラごとに変わる）。
    const visibleData = useMemo(() => {
        const filtered =
            effectiveFilter === 'all'
                ? threats
                : threats.filter((t) => t.category === effectiveFilter);
        // 上限が設定されていれば count の多い順に絞る（0 = 無制限）。
        // 元の並び順は維持したいので、残す id の集合を作ってから filter する。
        if (opts.maxArcs > 0 && filtered.length > opts.maxArcs) {
            const keep = new Set(
                [...filtered]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, opts.maxArcs)
                    .map((t) => t.id)
            );
            return filtered.filter((t) => keep.has(t.id));
        }
        return filtered;
    }, [threats, effectiveFilter, opts.maxArcs]);

    // 座標を投影（カメラが動くたびに再計算する軽い処理だけを残す）
    const visible = useMemo(() => {
        if (!geo) return [];
        return visibleData
            .map((t) => {
                const s = geo.projection([t.srcLon, t.srcLat]);
                const d = geo.projection([t.dstLon, t.dstLat]);
                if (!s || !d || ![...s, ...d].every(Number.isFinite)) return null;
                return { ...t, sx: s[0], sy: s[1], tx: d[0], ty: d[1] };
            })
            .filter(Boolean);
    }, [geo, visibleData]);

    // 表示中の弧における count の範囲。太さの正規化に使う。
    // 固定式（sqrt(count)）だと count が 10 でも 10000 でも太さがほぼ変わらないため、
    // 「実データの最小〜最大」を基準に相対的な太さを決める。
    const countRange = useMemo(() => {
        let lo = Infinity;
        let hi = -Infinity;
        visible.forEach((t) => {
            if (t.count < lo) lo = t.count;
            if (t.count > hi) hi = t.count;
        });
        return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : { lo: 0, hi: 0 };
    }, [visible]);

    // --- 件数サマリー（v1.9.0） -------------------------------------------
    // 【なぜ必要か】maxArcs は「count 上位 N 本だけ描いて残りを捨てる」動作なので、
    // 捨てられた分の存在が画面上どこにも出ず「全体で何件あるのか」が分からなかった。
    // ここでは **絞り込み前の全件（threats）** と **実際に描いた分（visibleData）** の
    // 両方を数え、凡例に「表示 N / 全 M」として出す。
    //
    // 数える対象は count 列の有無で変える:
    //   - count 列あり … 合計イベント数（単位「件」）。データの実量を表す
    //   - count 列なし … 弧の本数（単位「本」）。count は 1 固定なので本数と一致する
    // hasCount は「count 列が解決できたか」＝ parseThreats が付けた印を見る。
    const totals = useMemo(() => {
        // 1行あたりの寄与。count 列が無ければ「1本」として数える。
        // 現状 parseThreats が count を必ず有限値にしているが、非有限が紛れ込むと
        // 凡例に NaN が出てしまうため、合計・内訳の両方で同じガードを通す。
        const weigh = (t) => {
            if (!hasCount) return 1;
            return Number.isFinite(t.count) ? t.count : 0;
        };
        const sum = (list) => list.reduce((acc, t) => acc + weigh(t), 0);
        // カテゴリ別の内訳は **絞り込み前の全件** で数える。
        // 【重要】visibleData（描画中の分）で数えてはいけない。凡例クリックで
        // 絞り込むと他カテゴリが全て 0 になり、「medium のデータが無い」と
        // 誤読させてしまう（実際は隠れているだけ）。凡例は「どのカテゴリに
        // どれだけあるか」の一覧なので、フィルタ状態に依存させない。
        // maxArcs による上限も同様に無視する（捨てた分は総数側で示す）。
        const byCategory = {};
        threats.forEach((t) => {
            byCategory[t.category] = (byCategory[t.category] || 0) + weigh(t);
        });
        return {
            shown: sum(visibleData),
            all: sum(threats),
            // 絞り込み（凡例クリック）や maxArcs で実際に減っているか
            truncated: visibleData.length < threats.length,
            unit: hasCount ? '件' : '本',
            byCategory,
        };
    }, [threats, visibleData, hasCount]);

    // ホバー強調が有効なときだけ実際に適用する
    const activeHoverKey = opts.highlightOnHover ? hoverKey : null;

    // --- ドリルダウン（インタラクション） ---------------------------------
    // 発火するのは addDrilldownListener に登録した DOM ノードのクリックだけ。
    // triggerDrilldown() を自前の onClick から呼んでも効かない（サイレントに無視される）。
    // そのため「要素1つずつ」に、その要素専用の payload を閉じ込めて登録する。
    // payloadCallback を使い回して行番号を固定すると、どこを押しても同じ行が飛ぶ。
    const arcRefs = useRef(new Map());
    const spotRefs = useRef(new Map());

    // 起点・終点のホットスポット
    // 重複除去 + 同一地点に複数カテゴリの線が集まる場合は「表示順が先の」色を採用する。
    // 表示順はユーザーの categoryOrder（未指定なら登場順）なので、
    // **どのカテゴリを代表色にするかもユーザーの指定に従う**ことになる。
    // 「深刻度が高い方を優先」のような意味的な判断は viz では行わない。
    // 表示名は最初に見つかった非空のものを使う。
    // 【v1.9.0】集約は「画面距離が clusterRadius 以内」で行う（従来は 0.1px 完全一致）。
    // 併せて、各弧がどのクラスタに属するかを引ける対応表（arcEnds）も作る。
    // 弧の始点・終点をクラスタ代表点へ吸着させることで、束ねられた地点から
    // 弧が伸びる見た目になり、終端が数十本に割れて潰れるのを防ぐ。
    const { sources, targets, arcEnds } = useMemo(() => {
        // 1点1レコードに展開してから集約する（集約前の粒度を保つ）
        const srcPts = visible.map((t) => ({
            x: t.sx, y: t.sy, count: t.count, category: t.category, name: t.srcName, id: t.id,
        }));
        const dstPts = visible.map((t) => ({
            x: t.tx, y: t.ty, count: t.count, category: t.category, name: t.dstName, id: t.id,
        }));

        // クラスタ（またはキー完全一致）を「表示用の地点」へ畳む。
        // 代表カテゴリ・代表名の決め方は従来の merge と同じ規則を踏襲する:
        //   - カテゴリ: 表示順（categoryOrder → 登場順）が先のものを採用
        //   - 表示名  : 最初に見つかった非空のもの
        //   - count   : 合算
        const fold = (pts) => {
            const spots = [];
            const byId = new Map(); // 弧の id → 所属スポット（弧の端点吸着に使う）
            const groups = clusterPoints(pts, opts.clusterRadius);
            const buckets = groups
                ? groups.map((c) => ({ x: c.x, y: c.y, members: c.members }))
                : (() => {
                      // 集約無効時は従来どおり 0.1px 完全一致でまとめる
                      const m = new Map();
                      pts.forEach((p) => {
                          const k = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
                          if (!m.has(k)) m.set(k, { x: p.x, y: p.y, members: [] });
                          m.get(k).members.push(p);
                      });
                      return [...m.values()];
                  })();

            buckets.forEach((b) => {
                let count = 0;
                let category;
                let name = '';
                b.members.forEach((p) => {
                    count += p.count;
                    if (!name && p.name) name = p.name;
                    if (category === undefined || (catIndex[p.category] ?? 0) < (catIndex[category] ?? 0)) {
                        category = p.category;
                    }
                });
                const spot = {
                    x: b.x,
                    y: b.y,
                    count,
                    category,
                    name,
                    // 集約された元地点の数（1 なら単独地点）。ツールチップに出す
                    size: b.members.length,
                };
                spots.push(spot);
                b.members.forEach((p) => byId.set(p.id, spot));
            });
            return { spots, byId };
        };

        const s = fold(srcPts);
        const d = fold(dstPts);
        return {
            sources: s.spots,
            targets: d.spots,
            arcEnds: { src: s.byId, dst: d.byId },
        };
    }, [visible, catIndex, opts.clusterRadius]);

    // 弧の端点をクラスタ代表点へ吸着させた描画用データ。
    // 集約が無効（clusterRadius=0）なら元の座標と一致するので見た目は変わらない。
    const arcs = useMemo(
        () =>
            visible.map((t) => {
                const s = arcEnds.src.get(t.id);
                const d = arcEnds.dst.get(t.id);
                return {
                    ...t,
                    sx: s ? s.x : t.sx,
                    sy: s ? s.y : t.sy,
                    tx: d ? d.x : t.tx,
                    ty: d ? d.y : t.ty,
                };
            }),
        [visible, arcEnds]
    );

    // count → 線幅。widthScale=0 なら一律。データが全て同値なら中庸の太さ。
    const arcWidth = useCallback(
        (count) => {
            const BASE = 0.9;
            if (opts.widthScale <= 0) return BASE;
            const { lo, hi } = countRange;
            // sqrt で圧縮してから 0..1 に正規化（極端な外れ値に引っ張られにくい）
            const norm =
                hi > lo
                    ? (Math.sqrt(Math.max(count, 0)) - Math.sqrt(Math.max(lo, 0))) /
                      (Math.sqrt(Math.max(hi, 0)) - Math.sqrt(Math.max(lo, 0)))
                    : 0.5;
            return BASE + clamp(norm, 0, 1) * 3.2 * opts.widthScale;
        },
        [countRange, opts.widthScale]
    );

    // Canvas の光の帯用の弧データ（制御点・色・線幅を事前計算して rAF から使う）
    const flowArcs = useMemo(
        () =>
            arcs.map((t) => {
                const { cx, cy } = arcControl(t.sx, t.sy, t.tx, t.ty);
                return {
                    sx: t.sx,
                    sy: t.sy,
                    cx,
                    cy,
                    tx: t.tx,
                    ty: t.ty,
                    color: derived[t.category]?.css || 'rgb(56, 166, 255)',
                    w: arcWidth(t.count),
                    // ホバー強調時に「関係ない弧」を薄くするための識別子
                    id: t.id,
                    srcKey: `${t.sx.toFixed(1)},${t.sy.toFixed(1)}`,
                    dstKey: `${t.tx.toFixed(1)},${t.ty.toFixed(1)}`,
                };
            }),
        [arcs, derived, arcWidth]
    );

    // --- 地名ラベル（ズーム段階で国名 → 都市名が現れる） -------------------
    // 画面外は捨て、重なるものは重要度の高い方を残す（地図アプリの間引きと同じ）。
    // 始点/終点の都市ラベルを優先したいので、そちらが先に場所を確保する。
    //
    // 【パフォーマンス】この選定は全都市（約7,300件）の走査＋重なり判定を伴い重い。
    // ドラッグ / ホイールの毎フレーム実行すると低スペック環境でカクつくため、
    // **選定は settledCamera（操作が150ms止まったカメラ）基準**で行い、
    // 操作中は「選定済みラベルを現在のカメラで投影し直すだけ」（次の placeLabels memo）
    // にする。操作中のラベルは一瞬古い選定のまま流れるが、止まると確定する。
    const labelSelection = useMemo(() => {
        if (!size || !opts.showPlaceLabels) return [];
        const projection = makeProjection(size, settledCamera);
        if (!projection) return [];
        const { w, h } = size;
        const fs = opts.placeLabelSize;
        const budget = labelBudget(settledCamera.zoom, opts.labelDensity);
        // 地図由来の地名の表示名（labelLang='ja' なら日本語名。無ければ英語名のまま）
        const displayName = (entry) =>
            opts.labelLang === 'ja' && entry.ja ? entry.ja : entry.name;
        // 占有済み矩形。ラベル同士が重ならないかの判定に使う
        const taken = [];
        // 表示量に応じてラベル同士の間隔を変える（＝重なり判定の厳しさを変える）。
        // 件数の上限だけ動かしても、判定が固定だと実際の表示数はほとんど変わらないため、
        // 「候補数」と「間隔」の両方を連動させる。
        //   density>1 … 間隔を詰めて多く出す（下限 0.45）
        //   density<1 … 間隔を広げて厳選する（上限 2.0）
        const pad = clamp(1 / (opts.labelDensity || 1), 0.45, 2);
        const fits = (x, y, text) => {
            // SVG に measureText は無いため推定幅（CJK は全角、他は約0.6em）
            let wEst = 0;
            for (const ch of text) {
                wEst += ch.codePointAt(0) > 0x2e7f ? fs : fs * 0.6;
            }
            wEst *= pad;
            const box = { x0: x - wEst / 2, x1: x + wEst / 2, y0: y - fs * pad, y1: y + fs * 0.4 * pad };
            if (box.x0 < 2 || box.x1 > w - 2 || box.y0 < 2 || box.y1 > h - 2) return null;
            for (const t of taken) {
                if (box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0) return null;
            }
            return box;
        };
        const out = [];
        const place = (name, lon, lat, kind) => {
            const p = projection([lon, lat]);
            if (!p || !p.every(Number.isFinite)) return;
            const box = fits(p[0], p[1], name);
            if (!box) return;
            taken.push(box);
            // 位置は経緯度で持ち、描画時に「現在の」カメラで投影し直す
            out.push({ name, lon, lat, kind });
        };

        // 1. 始点/終点の都市名は最優先で確保する（ユーザーのデータそのもの）。
        //    カメラ操作中に依存が変わらないよう、投影前の visibleData から経緯度で集める
        if (opts.showEndpointLabels) {
            const endpoints = new Map();
            visibleData.forEach((t) => {
                if (t.srcName) endpoints.set(`${t.srcLon},${t.srcLat}`, { n: t.srcName, lon: t.srcLon, lat: t.srcLat });
                if (t.dstName) endpoints.set(`${t.dstLon},${t.dstLat}`, { n: t.dstName, lon: t.dstLon, lat: t.dstLat });
            });
            endpoints.forEach((e) => place(e.n, e.lon, e.lat, 'endpoint'));
        }

        // 2. 国名（面積の大きい順に budget 件まで）
        COUNTRY_LABELS.slice(0, budget.countries).forEach((c) => place(displayName(c), c.lon, c.lat, 'country'));

        // 3. 都市名（重要度順に budget 件まで。ズームが浅いうちは 0 件）
        //
        // 【重要】「上位N件を取ってから画面内かを見る」のは誤り。
        // 拡大すると世界の主要都市はほとんど画面外になるため、
        // 上位N件がまるごと捨てられ「ズームするほど地名が減る」症状になっていた
        // （zoom40 で budget=600 件なのに実際は3件しか出ない、という実測値）。
        // 正しくは **先に画面内へ絞り、そのうえで重要度順に budget 件** を採る。
        if (budget.cities > 0) {
            const inView = [];
            for (let i = 0; i < CITY_LABELS.length; i += 1) {
                const c = CITY_LABELS[i];
                const p = projection([c.lon, c.lat]);
                if (!p || !p.every(Number.isFinite)) continue;
                if (p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > h) continue;
                // CITY_LABELS は重要度順に並んでいるので、この順序がそのまま優先度になる
                inView.push({ c, p });
                if (inView.length >= budget.cities) break;
            }
            inView.forEach(({ c }) => place(displayName(c), c.lon, c.lat, 'city'));
        }
        return out;
    }, [size, settledCamera, opts.showPlaceLabels, opts.showEndpointLabels, opts.placeLabelSize, opts.labelDensity, opts.labelLang, visibleData]);

    // 選定済みラベルを現在のカメラで投影する（軽い処理。毎フレーム実行してよい）。
    // 操作中に画面外へ流れたラベルはここで落ちる
    const placeLabels = useMemo(() => {
        if (!geo || !size) return [];
        const out = [];
        labelSelection.forEach((l) => {
            const p = geo.projection([l.lon, l.lat]);
            if (!p || !p.every(Number.isFinite)) return;
            if (p[0] < -40 || p[0] > size.w + 40 || p[1] < -40 || p[1] > size.h + 40) return;
            out.push({ name: l.name, kind: l.kind, x: p[0], y: p[1] });
        });
        return out;
    }, [geo, size, labelSelection]);

    // 弧とホットスポットをドリルダウン対象として登録する。
    // 要素は再描画で作り直されるため、データが変わるたびに登録し直す。
    // 登録に失敗しても描画は続行する（ホスト API 未提供の環境で落とさない）。
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        try {
            arcs.forEach((t) => {
                const node = arcRefs.current.get(t.id);
                if (!node) return;
                addDrilldownListener({
                    node,
                    action: 'link.click',
                    // この要素専用の payload（固定でよい）。
                    // row.<フィールド名>.value 形式にすると
                    // 編集画面「インタラクション」からフィールド名で参照できる。
                    payloadCallback: () => ({
                        'row.src_name.value': t.srcName,
                        'row.dst_name.value': t.dstName,
                        'row.src_lat.value': t.srcLat,
                        'row.src_lon.value': t.srcLon,
                        'row.dst_lat.value': t.dstLat,
                        'row.dst_lon.value': t.dstLon,
                        'row.category.value': t.category,
                        'row.count.value': t.count,
                        name: 'src_name',
                        value: t.srcName || `${t.srcLat},${t.srcLon}`,
                    }),
                });
            });
            [...sources.map((s) => ({ s, kind: 'src' })), ...targets.map((s) => ({ s, kind: 'dst' }))]
                .forEach(({ s, kind }) => {
                    const key = `${kind}:${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                    const node = spotRefs.current.get(key);
                    if (!node) return;
                    addDrilldownListener({
                        node,
                        action: 'point.click',
                        payloadCallback: () => ({
                            'row.name.value': s.name,
                            'row.category.value': s.category,
                            'row.count.value': s.count,
                            'row.role.value': kind === 'src' ? 'source' : 'target',
                            name: kind === 'src' ? 'src_name' : 'dst_name',
                            value: s.name || `${s.x.toFixed(1)},${s.y.toFixed(1)}`,
                        }),
                    });
                });
        } catch (e) {
            /* ドリルダウン未対応環境でも描画は続ける */
        }
    }, [arcs, sources, targets]);

    // パネル実サイズに応じたオーバーレイのレイアウト計算
    // （小パネルで文字がはみ出したり要素同士が重ならないよう、
    //   サイズに合わせて縮小・非表示・コンパクト化する）
    const overlay = useMemo(() => {
        // size 未計測時は通常サイズ相当のフォールバックを使う
        const w = size ? size.w : 900;
        const h = size ? size.h : 500;

        // フィルタは右上に出るので、狭幅では非表示にしてタイトルと衝突させない
        const showFilter = opts.showFilter && w >= 220;
        // タイトルは幅が狭い / フィルタと重なる恐れがある場合に隠す
        //  - w<260 では横幅不足で隠す
        //  - フィルタ表示中かつ w<420 では上部バンドで重なるため隠す
        // 文字列が空ならタイトル枠自体を出さない（空欄＝タイトル無しの指定）
        const showTitle =
            opts.showTitle && opts.titleText.trim() !== '' && w >= 260 && !(showFilter && w < 420);
        // 凡例は極端に小さいパネルでは隠す。中間サイズでは横並びのコンパクト表示
        const showLegend = opts.showLegend && w >= 200 && h >= 140;
        const legendCompact = w < 360 || h < 240;

        // タイトルのフォントは幅に応じて 22px→12px にクランプ
        const titleFont = Math.max(12, Math.min(22, Math.round(w * 0.028)));
        // タイトルの最大横幅（パネル幅から左右余白と右側フィルタ分を差し引く）
        const titleMaxW = Math.max(60, w - 40 - (showFilter ? 120 : 0));

        // 凡例のスケール（コンパクト時は詰める）
        const legPad = legendCompact ? '5px 8px' : '10px 16px';
        const legGap = legendCompact ? 6 : 8;
        const legRowGap = legendCompact ? 4 : 8;
        const legFont = legendCompact ? 11 : 14;
        const legSwatchW = legendCompact ? 14 : 22;
        const legSwatchH = legendCompact ? 4 : 5;
        // 幅が狭いときは凡例内の各行も横並びに（縦積みだと縦に長くなり地図に被る）
        const legDir = w < 300 ? 'row' : 'column';

        // 件数表示は凡例の中に出す。コンパクト表示（極小パネル）では
        // 桁数で凡例が横に膨らんで地図を覆うため出さない。
        const showTotals = opts.showTotals && !legendCompact;
        const showCategoryCounts = opts.showCategoryCounts && !legendCompact;

        return {
            showFilter,
            showTitle,
            showLegend,
            showTotals,
            showCategoryCounts,
            titleFont,
            titleMaxW,
            legPad,
            legGap,
            legRowGap,
            legFont,
            legSwatchW,
            legSwatchH,
            legDir,
        };
    }, [size, opts.showTitle, opts.titleText, opts.showFilter, opts.showLegend,
        opts.showTotals, opts.showCategoryCounts]);

    return (
        <div
            ref={(el) => {
                containerRef.current = el;
                attachWheel(el);
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                minHeight: 200,
                background: background.containerBg,
                overflow: 'hidden',
                // ズーム有効時は掴めることを示す。ドラッグ中は握った形に変える
                cursor: opts.enableZoom ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
                // ドラッグ中にテキスト選択やブラウザのパンが割り込まないようにする
                userSelect: 'none',
                touchAction: opts.enableZoom ? 'none' : 'auto',
                fontFamily:
                    'Splunk Platform Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
            }}
        >
            {geo && size && (
                <svg
                    viewBox={`0 0 ${size.w} ${size.h}`}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                >
                    <defs>
                        {background.bgStops && (
                            <radialGradient id="gtm-bg" cx="50%" cy="42%" r="75%">
                                {background.bgStops.map((s) => (
                                    <stop key={s.offset} offset={s.offset} stopColor={s.color} />
                                ))}
                            </radialGradient>
                        )}
                        {/* カテゴリ別のホットスポットグロー（線の色から導出・動的） */}
                        {categoryList.map((sev, i) => (
                            <radialGradient key={sev} id={`gtm-hot-${i}`}>
                                <stop
                                    offset="0%"
                                    stopColor={derived[sev].glowInner}
                                    stopOpacity="0.95"
                                />
                                <stop
                                    offset="30%"
                                    stopColor={derived[sev].glowMid}
                                    stopOpacity="0.5"
                                />
                                <stop
                                    offset="70%"
                                    stopColor={derived[sev].css}
                                    stopOpacity="0.17"
                                />
                                <stop offset="100%" stopColor={derived[sev].css} stopOpacity="0" />
                            </radialGradient>
                        ))}
                        <filter id="gtm-land-blur" x="-10%" y="-10%" width="120%" height="120%">
                            <feGaussianBlur stdDeviation="7" />
                        </filter>
                        <filter id="gtm-soft-blur" x="-20%" y="-20%" width="140%" height="140%">
                            <feGaussianBlur stdDeviation="2.5" />
                        </filter>
                        {/* 弧の発光: ベース軌道をにじませてネオンの熱量を出す */}
                        <filter id="gtm-arc-glow" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="3.2" />
                        </filter>
                    </defs>

                    {/* 背景（完全透過時は描画しない） */}
                    {background.bgStops && (
                        <rect width={size.w} height={size.h} fill="url(#gtm-bg)" />
                    )}

                    {/* 大陸（グロー層 + 本体。完全透過時は描画しない） */}
                    {land.visible && (
                        <>
                            <path
                                d={geo.landPath}
                                fill={land.glow}
                                opacity={land.glowOpacity}
                                filter="url(#gtm-land-blur)"
                            />
                            <path
                                d={geo.landPath}
                                fill={land.fill}
                                stroke={land.stroke}
                                strokeWidth="0.5"
                                strokeOpacity={land.strokeOpacity}
                            />
                        </>
                    )}

                    {/* 攻撃元ホットスポット（脈動アニメーション付き・線の色に対応） */}
                    {sources.map((s, i) => {
                        const base = Math.min(26 + Math.sqrt(s.count) * 1.5, 44);
                        // 集約された地点は「代表名 ほか N 地点」と示す（何が畳まれたか分かるように）
                        const tipHead = `Source: ${s.name || 'unknown'}${s.size > 1 ? ` ほか ${s.size - 1} 地点` : ''}`;
                        const tipSub = `${describeCategory(s.category)}count ${s.count}`;
                        return (
                            <g key={`src-${i}`}>
                                <circle
                                    cx={s.x}
                                    cy={s.y}
                                    r={base}
                                    fill={`url(#gtm-hot-${catIndex[s.category] ?? 0})`}
                                >
                                    {animOn && (
                                        <animate
                                            attributeName="r"
                                            values={`${base};${base * 1.3};${base}`}
                                            dur="3s"
                                            begin={`${(i % 5) * 0.5}s`}
                                            repeatCount="indefinite"
                                        />
                                    )}
                                    {animOn && (
                                        <animate
                                            attributeName="opacity"
                                            values="1;0.6;1"
                                            dur="3s"
                                            begin={`${(i % 5) * 0.5}s`}
                                            repeatCount="indefinite"
                                        />
                                    )}
                                </circle>
                                <circle
                                    cx={s.x}
                                    cy={s.y}
                                    r="3"
                                    fill={derived[s.category]?.core}
                                />
                                {/* 透明な当たり判定。ホバー強調とドリルダウンの受け口。 */}
                                <circle
                                    ref={(el) => {
                                        const k = `src:${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                                        if (el) spotRefs.current.set(k, el);
                                        else spotRefs.current.delete(k);
                                    }}
                                    cx={s.x}
                                    cy={s.y}
                                    r="12"
                                    fill="transparent"
                                    style={{ cursor: 'pointer' }}
                                    aria-label={`${tipHead} (${tipSub})`}
                                    onMouseEnter={(e) => {
                                        setHoverKey(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
                                        setTooltip({ lines: [tipHead, tipSub] });
                                        positionTooltip(e);
                                    }}
                                    onMouseMove={positionTooltip}
                                    onMouseLeave={() => {
                                        setHoverKey(null);
                                        setTooltip(null);
                                    }}
                                />
                            </g>
                        );
                    })}

                    {/* 攻撃先（線の色に対応） */}
                    {targets.map((t, i) => {
                        const tipHead = `Target: ${t.name || 'unknown'}${t.size > 1 ? ` ほか ${t.size - 1} 地点` : ''}`;
                        const tipSub = `${describeCategory(t.category)}count ${t.count}`;
                        return (
                        <g key={`dst-${i}`}>
                            <circle
                                cx={t.x}
                                cy={t.y}
                                r="20"
                                fill={`url(#gtm-hot-${catIndex[t.category] ?? 0})`}
                                opacity="0.85"
                            />
                            <circle
                                cx={t.x}
                                cy={t.y}
                                r="2.5"
                                fill={derived[t.category]?.core}
                            />
                            <circle
                                ref={(el) => {
                                    const k = `dst:${t.x.toFixed(1)},${t.y.toFixed(1)}`;
                                    if (el) spotRefs.current.set(k, el);
                                    else spotRefs.current.delete(k);
                                }}
                                cx={t.x}
                                cy={t.y}
                                r="12"
                                fill="transparent"
                                style={{ cursor: 'pointer' }}
                                aria-label={`${tipHead} (${tipSub})`}
                                onMouseEnter={(e) => {
                                    setHoverKey(`${t.x.toFixed(1)},${t.y.toFixed(1)}`);
                                    setTooltip({ lines: [tipHead, tipSub] });
                                    positionTooltip(e);
                                }}
                                onMouseMove={positionTooltip}
                                onMouseLeave={() => {
                                    setHoverKey(null);
                                    setTooltip(null);
                                }}
                            />
                        </g>
                        );
                    })}

                    {/* 攻撃の弧のベース軌道（SVG）。流れる彗星は上に重ねた Canvas が担当。
                        ツールチップ(title)はここに置き、常にホバー可能にする。
                          軌道1: 太く柔らかい発光ハロー（熱をにじませる）
                          軌道2: 細い芯線（弧の存在を常に示す薄い実線）
                        animOn 時は軌道を控えめにして彗星を主役に、静的時は芯線を濃くする。 */}
                    {arcs.map((t) => {
                        const color = derived[t.category]?.css || 'rgb(56, 166, 255)';
                        const d = arcPath(t.sx, t.sy, t.tx, t.ty);
                        const width = arcWidth(t.count);
                        const srcKey = `${t.sx.toFixed(1)},${t.sy.toFixed(1)}`;
                        const dstKey = `${t.tx.toFixed(1)},${t.ty.toFixed(1)}`;
                        // ホバー強調中、その地点に繋がらない弧は薄くする
                        const dim =
                            activeHoverKey !== null &&
                            srcKey !== activeHoverKey &&
                            dstKey !== activeHoverKey;
                        const k = dim ? 0.22 : 1;
                        const tipHead = `${pointLabel(t.srcName, t.srcLat, t.srcLon)} → ${pointLabel(t.dstName, t.dstLat, t.dstLon)}`;
                        const tipSub = `${describeCategory(t.category)}count ${t.count}`;
                        return (
                            <g key={`arc-${t.id}`}>
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 2.4}
                                    strokeLinecap="round"
                                    opacity={(animOn ? 0.14 : 0.28) * k}
                                    filter="url(#gtm-arc-glow)"
                                />
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 0.7}
                                    strokeLinecap="round"
                                    opacity={(animOn ? 0.3 : 0.75) * k}
                                />
                                {/* 透明な太い当たり判定。細い線でもホバー/クリックしやすくする。
                                    ドリルダウンはこの要素に登録する（addDrilldownListener）。 */}
                                <path
                                    ref={(el) => {
                                        if (el) arcRefs.current.set(t.id, el);
                                        else arcRefs.current.delete(t.id);
                                    }}
                                    d={d}
                                    fill="none"
                                    stroke="transparent"
                                    strokeWidth={Math.max(width * 3, 10)}
                                    strokeLinecap="round"
                                    style={{ cursor: 'pointer' }}
                                    aria-label={`${tipHead} (${tipSub})`}
                                    onMouseEnter={(e) => {
                                        setHoverKey(srcKey);
                                        setTooltip({ lines: [tipHead, tipSub] });
                                        positionTooltip(e);
                                    }}
                                    onMouseMove={positionTooltip}
                                    onMouseLeave={() => {
                                        setHoverKey(null);
                                        setTooltip(null);
                                    }}
                                />
                            </g>
                        );
                    })}

                    {/* 地名ラベル。ズームに応じて国名 → 都市名の順に現れる。
                        始点/終点の都市名は最優先で場所を確保し、地図の地名より
                        目立つ配色にする（データが主役であることを崩さないため）。
                        縁取り(paint-order: stroke)で地図の上でも読めるようにする。 */}
                    {placeLabels.map((l) => {
                        const isEndpoint = l.kind === 'endpoint';
                        const isCountry = l.kind === 'country';
                        return (
                            <text
                                key={`lbl-${l.kind}-${l.name}-${Math.round(l.x)}-${Math.round(l.y)}`}
                                x={l.x}
                                y={l.y - (isEndpoint ? 9 : 0)}
                                textAnchor="middle"
                                fontSize={
                                    isEndpoint
                                        ? opts.placeLabelSize + 1
                                        : isCountry
                                          ? opts.placeLabelSize
                                          : opts.placeLabelSize - 1
                                }
                                fontWeight={isEndpoint ? 700 : isCountry ? 600 : 400}
                                fill={isEndpoint ? palette.endpointLabel : palette.placeLabel}
                                opacity={isEndpoint ? 1 : isCountry ? 0.9 : 0.75}
                                stroke={palette.labelHalo}
                                strokeWidth={isEndpoint ? 3.5 : 2.5}
                                strokeOpacity={0.85}
                                paintOrder="stroke"
                                strokeLinejoin="round"
                                style={{ pointerEvents: 'none' }}
                            >
                                {l.name}
                            </text>
                        );
                    })}
                </svg>
            )}

            {/* 流れる光の帯（Canvas オーバーレイ）。地図 SVG の上・オーバーレイ UI の下。
                animDuration=0 のときは rAF を回さず何も描かない（静的表示・CPU 0）。 */}
            {geo && size && (
                <ArcFlowCanvas
                    arcs={flowArcs}
                    width={size.w}
                    height={size.h}
                    duration={opts.animDuration}
                    hoverKey={opts.highlightOnHover ? hoverKey : null}
                />
            )}

            {/* カスタムツールチップ（弧・地点のホバーで表示。カーソルに追従）。
                pointerEvents:none でホバー対象のイベントを妨げない */}
            {tooltip && size && (
                <div
                    ref={tooltipRef}
                    style={{
                        position: 'absolute',
                        left: Math.max(6, Math.min(tooltipPosRef.current.x + 14, size.w - 180)),
                        top: Math.max(6, Math.min(tooltipPosRef.current.y + 16, size.h - 60)),
                        maxWidth: Math.max(120, Math.min(340, size.w - 24)),
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: 8,
                        padding: '6px 10px',
                        color: palette.legendText,
                        fontSize: 12,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        zIndex: 5,
                    }}
                >
                    {tooltip.lines.map((line, i) => (
                        <div
                            key={i}
                            style={{
                                fontWeight: i === 0 ? 700 : 400,
                                opacity: i === 0 ? 1 : 0.85,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {line}
                        </div>
                    ))}
                </div>
            )}

            {/* タイトル（左上・地図の内側）
                幅に応じてフォントを縮小し、はみ出す場合は省略記号で切り詰め */}
            {overlay.showTitle && (
                <div
                    style={{
                        position: 'absolute',
                        top: 16,
                        left: 20,
                        maxWidth: overlay.titleMaxW,
                        color: palette.titleColor,
                        fontSize: overlay.titleFont,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        textShadow: palette.titleShadow,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        pointerEvents: 'none',
                        zIndex: 2,
                    }}
                >
                    {opts.titleText}
                </div>
            )}

            {/* カテゴリフィルタ（右上・地図の内側。サーチ結果から動的生成）
                狭幅パネルではタイトルとの衝突を避けるため非表示 */}
            {overlay.showFilter && (
                <div
                    // data-viz-ui: この内側で押しても地図のパンを開始しない
                    // （ポインタ捕捉に奪われて Select が開かなくなるのを防ぐ）
                    data-viz-ui="1"
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 16,
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: 8,
                        padding: 4,
                        zIndex: 4,
                    }}
                >
                    <Select
                        value={effectiveFilter}
                        onChange={(e, { value }) => setCategoryFilter(value)}
                        appearance="subtle"
                    >
                        <Select.Option label={opts.categoryLabel ? `すべての${opts.categoryLabel}` : 'すべて'} value="all" />
                        {categoryList.map((cat) => (
                            <Select.Option key={cat} label={cat} value={cat} />
                        ))}
                    </Select>
                </div>
            )}

            {/* ズーム倍率の表示とリセット（右下）。
                ズーム中だけ出し、押すと初期表示（オプションの中心・ズーム）へ戻る。
                編集モードでは iframe への入力が遮断されるため表示モードでのみ機能する。 */}
            {opts.enableZoom && Math.abs(camera.zoom - opts.initialZoom) > 0.01 && size && size.w >= 200 && (
                <div
                    data-viz-ui="1"
                    onClick={onDoubleClick}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title="初期表示に戻す"
                    style={{
                        position: 'absolute',
                        right: 16,
                        bottom: 14,
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: 8,
                        padding: '4px 10px',
                        color: palette.legendText,
                        fontSize: 12,
                        cursor: 'pointer',
                        zIndex: 3,
                    }}
                >
                    {`×${camera.zoom.toFixed(1)}　⟲`}
                </div>
            )}

            {/* 凡例（左下・地図の内側。サーチ結果から動的生成）
                小パネルではフォント / 余白 / スウォッチを縮小し、
                さらに狭い場合は各行も横並びにして縦方向のかさばりを抑える */}
            {overlay.showLegend && (
                <div
                    data-viz-ui="1"
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'absolute',
                        left: 16,
                        bottom: 14,
                        maxWidth: '80%',
                        background: palette.legendBg,
                        border: palette.legendBorder,
                        borderRadius: 10,
                        padding: overlay.legPad,
                        display: 'flex',
                        flexDirection: overlay.legDir,
                        flexWrap: overlay.legDir === 'row' ? 'wrap' : 'nowrap',
                        gap: overlay.legRowGap,
                        columnGap: overlay.legDir === 'row' ? overlay.legGap + 2 : overlay.legRowGap,
                        zIndex: 4,
                    }}
                >
                    {/* 見出し（色分けの基準列の呼び名）。categoryLabel 未設定なら出さない */}
                    {opts.categoryLabel && overlay.legDir === 'column' && (
                        <div
                            style={{
                                color: palette.legendText,
                                fontSize: overlay.legFont,
                                fontWeight: 700,
                                opacity: 0.8,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {opts.categoryLabel}
                        </div>
                    )}
                    {/* 件数サマリー（表示中 / 全体）。maxArcs や凡例フィルタで
                        描画対象が減っているとき、捨てられた分の存在を示す。
                        全件描いているときは「全 N 件」とだけ出す（冗長を避ける）。
                        横並び（狭幅）では場所が無いので出さない。 */}
                    {overlay.showTotals && overlay.legDir === 'column' && (
                        <div
                            style={{
                                color: palette.legendText,
                                fontSize: Math.max(10, overlay.legFont - 2),
                                opacity: 0.75,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {totals.truncated
                                ? `表示 ${formatCount(totals.shown)} / 全 ${formatCount(totals.all)} ${totals.unit}`
                                : `全 ${formatCount(totals.all)} ${totals.unit}`}
                        </div>
                    )}
                    {categoryList.map((cat) => {
                        // 凡例クリックで絞り込み（もう一度押すと解除）。
                        // 絞り込み中は対象外のカテゴリを薄く表示して現在の状態を示す。
                        const isActive = effectiveFilter === cat;
                        const isDimmed = effectiveFilter !== 'all' && !isActive;
                        const hint = explicit?.[cat]
                            ? ''
                            : opts.colorMode === 'count'
                              ? '（どのしきい値範囲にも入らない件数のため既定色）'
                              : `（色が未設定のため既定色。編集画面の「色分け」で「${cat}|#RRGGBB」を追加すると色が付きます）`;
                        return (
                        <div
                            key={cat}
                            onClick={() => setCategoryFilter(isActive ? 'all' : cat)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: overlay.legGap,
                                cursor: 'pointer',
                                opacity: isDimmed ? 0.4 : 1,
                            }}
                            title={`${cat}${hint}（クリックで${isActive ? '絞り込みを解除' : 'このカテゴリだけ表示'}）`}
                        >
                            <span
                                style={{
                                    width: overlay.legSwatchW,
                                    height: overlay.legSwatchH,
                                    borderRadius: 3,
                                    flexShrink: 0,
                                    background: derived[cat].css,
                                    boxShadow: `0 0 8px ${derived[cat].css}`,
                                    // 未設定は輪郭を破線にして「既定色である」ことを視覚的に示す
                                    outline: explicit?.[cat] ? 'none' : `1px dashed ${palette.legendText}`,
                                    outlineOffset: 1,
                                }}
                            />
                            <span
                                style={{
                                    color: palette.legendText,
                                    fontSize: overlay.legFont,
                                    whiteSpace: 'nowrap',
                                    opacity: explicit?.[cat] ? 1 : 0.75,
                                    fontWeight: isActive ? 700 : 400,
                                    textDecoration: isActive ? 'underline' : 'none',
                                }}
                            >
                                {cat}
                            </span>
                            {/* カテゴリ別の件数（実際に描いている分）。
                                縦積みのときだけ右端に寄せて数字の桁を揃える。 */}
                            {overlay.showCategoryCounts && (
                                <span
                                    style={{
                                        color: palette.legendText,
                                        fontSize: Math.max(10, overlay.legFont - 1),
                                        opacity: 0.7,
                                        whiteSpace: 'nowrap',
                                        marginLeft: overlay.legDir === 'column' ? 'auto' : 4,
                                        paddingLeft: 8,
                                        fontVariantNumeric: 'tabular-nums',
                                    }}
                                >
                                    {formatCount(totals.byCategory[cat] || 0)}
                                </span>
                            )}
                        </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function ThreatMapVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f.name || f), [data]);
    const { threats: parsedThreats, missingFields, hasCount } = useMemo(
        () => parseThreats(fieldNames, rows, opts),
        [fieldNames, rows, opts]
    );

    // colorMode='count' では、しきい値バンドの表示名を「擬似カテゴリ」として各行へ
    // 割り当てる。以降の凡例・フィルタ・ホットスポット・ドリルダウンは
    // カテゴリ色分けと同じ機構がそのまま働く（count 専用の分岐を増やさない）。
    // どのバンドにも入らない count は (未分類) → fallbackColor で描かれる。
    const threats = useMemo(() => {
        if (opts.colorMode !== 'count') return parsedThreats;
        return parsedThreats.map((t) => {
            const band = opts.countThresholds.find((b) => t.count >= b.from && t.count < b.to);
            return { ...t, category: band ? bandLabel(band) : UNCATEGORIZED };
        });
    }, [parsedThreats, opts.colorMode, opts.countThresholds]);

    // サーチ結果に登場したカテゴリ一覧と、オプションで設定された色の割り当て。
    // 正規化済みの opts を渡す（生の options ではなく）。
    // count モードでは一覧も色もしきい値バンドから決める
    // （categoryColors / categoryOrder はカテゴリモード専用の設定なので参照しない）。
    const { categoryList, categoryColors, explicit } = useMemo(() => {
        if (opts.colorMode !== 'count') return buildCategoryModel(threats, opts);
        const fallback = parseColor(opts.fallbackColor) || parseColor(DEFAULT_CATEGORY_COLOR);
        const list = [];
        const colors = {};
        const exp = {};
        opts.countThresholds.forEach((b) => {
            const label = bandLabel(b);
            if (list.includes(label)) return;
            list.push(label);
            colors[label] = parseColor(b.value) || fallback;
            exp[label] = true;
        });
        if (threats.some((t) => t.category === UNCATEGORIZED)) {
            list.push(UNCATEGORIZED);
            colors[UNCATEGORIZED] = fallback;
            exp[UNCATEGORIZED] = false;
        }
        return { categoryList: list, categoryColors: colors, explicit: exp };
    }, [threats, opts]);

    // カスタム背景色・陸地色（各チェックボックスON時のみ有効。OFFならテーマ配色）
    const customBg = useMemo(
        () => (options?.useBgColor ? parseColor(options?.bgColor) : null),
        [options]
    );
    const customLand = useMemo(
        () => (options?.useLandColor ? parseColor(options?.landColor) : null),
        [options]
    );

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <MessageState message="データがありません。サーチ結果を確認してください。" />;
    if (missingFields) {
        return (
            <MessageState message="必須フィールドが見つかりません: src_lat, src_lon, dst_lat, dst_lon（編集画面の「データフィールド」で列を指定することもできます。任意: 色分けカテゴリ, count, src_name, dst_name）" />
        );
    }
    if (threats.length === 0) {
        return <MessageState message="No valid coordinates in the search results" />;
    }

    return (
        <ThreatMap
            threats={threats}
            hasCount={hasCount}
            mode={mode}
            categoryList={categoryList}
            categoryColors={categoryColors}
            explicit={explicit}
            customBg={customBg}
            customLand={customLand}
            opts={opts}
        />
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きApp
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// ---------------------------------------------------------------------------
function App() {
    const themeContext = useTheme();
    const theme = themeContext?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    const colorScheme = theme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <ThreatMapVisualization mode={colorScheme} />
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
