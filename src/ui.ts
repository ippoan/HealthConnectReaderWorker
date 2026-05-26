export const MANIFEST_JSON = JSON.stringify({
  name: "Health Connect Reader",
  short_name: "HC Reader",
  start_url: "/",
  display: "standalone",
  background_color: "#f8fafc",
  theme_color: "#059669",
  icons: [
    // 単色 192/512 を SVG data URI で最小同梱。専用 PNG は別 PR で差し替え可能。
    {
      src:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#059669"/><text x="96" y="120" font-family="-apple-system,system-ui,sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="white">HC</text></svg>',
        ),
      sizes: "192x192",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#059669"/><text x="256" y="320" font-family="-apple-system,system-ui,sans-serif" font-size="256" font-weight="700" text-anchor="middle" fill="white">HC</text></svg>',
        ),
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
});

// 最小 SW。fetch 介入なし (= 透過)、install 即 activate。PWA install 条件
// (manifest + SW 登録) を満たすためだけのスタブ。
export const SERVICE_WORKER_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
`;

// favicon.ico — ブラウザが自動で要求するので 404 を出さないために最小 ICO を返す。
// 16x16, 32bpp, 単色 #059669 (emerald-600) 塗りつぶし。手書きでバイト列を組む。
function buildSolidFavicon(): Uint8Array {
  const W = 16, H = 16;
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + BITMAPINFOHEADER (40) +
  // pixel data (W*H*4 BGRA) + AND mask (W*H/8 bytes)
  const pixelBytes = W * H * 4;
  const andBytes = (W * H) / 8;
  const imageSize = 40 + pixelBytes + andBytes;
  const total = 6 + 16 + imageSize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  // ICONDIR
  dv.setUint16(0, 0, true);  // reserved
  dv.setUint16(2, 1, true);  // type = icon
  dv.setUint16(4, 1, true);  // count
  // ICONDIRENTRY
  buf[6] = W;
  buf[7] = H;
  buf[8] = 0;                // palette
  buf[9] = 0;                // reserved
  dv.setUint16(10, 1, true); // planes
  dv.setUint16(12, 32, true);// bpp
  dv.setUint32(14, imageSize, true);
  dv.setUint32(18, 22, true);// offset (ICONDIR(6) + ENTRY(16))
  // BITMAPINFOHEADER (40 bytes) at offset 22
  let o = 22;
  dv.setUint32(o, 40, true); o += 4;
  dv.setInt32(o, W, true); o += 4;
  dv.setInt32(o, H * 2, true); o += 4; // height = h*2 (XOR + AND)
  dv.setUint16(o, 1, true); o += 2;
  dv.setUint16(o, 32, true); o += 2;
  dv.setUint32(o, 0, true); o += 4; // BI_RGB
  dv.setUint32(o, pixelBytes, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  // pixel data BGRA, bottom-up
  // #059669 = R 5, G 150, B 105
  const R = 5, G = 150, B = 105, A = 255;
  for (let i = 0; i < W * H; i++) {
    buf[o + i * 4 + 0] = B;
    buf[o + i * 4 + 1] = G;
    buf[o + i * 4 + 2] = R;
    buf[o + i * 4 + 3] = A;
  }
  o += pixelBytes;
  // AND mask = all 0 (= fully opaque), already zero-filled
  return buf;
}

export const FAVICON_ICO_BYTES = buildSolidFavicon();

export const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Health Connect Reader</title>
<link rel="manifest" href="/manifest.json" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="HC Reader" />
<meta name="theme-color" content="#059669" />
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
<div class="max-w-md mx-auto p-4 space-y-4">
  <header class="pt-2">
    <h1 class="text-xl font-semibold">Health Connect Reader</h1>
    <p id="env-badge" class="text-xs text-slate-500">loading…</p>
  </header>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <button id="upload-btn"
      class="w-full bg-emerald-600 text-white font-semibold py-3 rounded-xl active:bg-emerald-700">
      今すぐ Upload
    </button>
    <button id="upload-30-btn"
      class="w-full bg-slate-700 text-white font-semibold py-3 rounded-xl active:bg-slate-800">
      過去 30 日を Upload
    </button>
    <label class="flex items-center justify-between text-sm">
      <span>1日1回 自動 Upload</span>
      <input id="auto-toggle" type="checkbox" class="h-5 w-9" />
    </label>
    <p id="status" class="text-sm text-slate-600 min-h-[1.25rem]"></p>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <h2 class="font-semibold">Zones (iPhone) JSON を upload</h2>
    <p class="text-xs text-slate-500">
      Apple Watch の workout を Zones アプリで JSON export → ここで選択。
      iOS では「ファイル」アプリに保存してから選ぶか、ショートカット経由で直接送る。
    </p>
    <input id="zones-file" type="file" accept="application/json,.json"
      class="block w-full text-sm" />
    <button id="zones-upload-btn"
      class="w-full bg-indigo-600 text-white font-semibold py-3 rounded-xl active:bg-indigo-700">
      Zones JSON を送信
    </button>
    <p id="zones-status" class="text-sm text-slate-600 min-h-[1.25rem]"></p>
    <div>
      <h3 class="text-sm font-semibold text-slate-700 mt-2 mb-1">アップロード済み</h3>
      <ul id="zones-list" class="text-xs text-slate-600 divide-y divide-slate-100">
        <li class="py-1 text-slate-400">読込中…</li>
      </ul>
    </div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4">
    <h2 class="font-semibold mb-2">履歴</h2>
    <p id="history" class="text-sm text-slate-600">—</p>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold">日付別 + 突合状況</h2>
      <select id="workouts-days" class="text-xs border border-slate-300 rounded px-2 py-1">
        <option value="7">7 日</option>
        <option value="30" selected>30 日</option>
        <option value="90">90 日</option>
        <option value="365">1 年</option>
      </select>
    </div>
    <p id="workouts-summary" class="text-xs text-slate-500">読込中…</p>
    <div id="workouts-days-list" class="space-y-2"></div>
    <div class="border-t border-slate-100 pt-3 space-y-2">
      <button id="reindex-btn"
        class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium py-2 rounded-lg">
        🔄 R2 → D1 を再 index (突合し直す)
      </button>
      <p id="reindex-status" class="text-xs text-slate-500 min-h-[1.25rem]"></p>
      <p class="text-[10px] text-slate-400 leading-snug">
        R2 に直接置いたデータや、incremental skip で D1 に乗らなかった日を
        手動で同期する用。upsert なので何度叩いても重複しない。
      </p>
    </div>
  </section>
</div>

<script>
const hasNative = typeof window.HC !== "undefined";
const $ = (id) => document.getElementById(id);

// SW 登録 (PWA install 条件)。失敗は無視 (HTTP / 旧 Safari 環境)。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function setStatus(msg) { $("status").textContent = msg; }
function setZonesStatus(msg) { $("zones-status").textContent = msg; }

// PWA は auth-worker JWT cookie で API が叩ける (= credentials: 'include')。
// Android native は引き続き Bearer (HCBridge から token を取る)。
function authHeaders() {
  if (hasNative) {
    return { Authorization: "Bearer " + window.HC.getUploadToken() };
  }
  return {};
}
function authFetchInit(extra) {
  // 注意: 外側で Object.assign(target, extra) すると extra.headers が
  // target.headers を**そのまま上書き**し Authorization が消える
  // (Android WebView で 401 顕在化、PWA は cookie credentials で覆われ
  // masked) (Refs #22)。headers は再 assemble して最後に設定する。
  extra = extra || {};
  const init = Object.assign({ credentials: "include" }, extra);
  init.headers = Object.assign({}, authHeaders(), extra.headers || {});
  return init;
}

async function refreshHistory() {
  const r = await fetch("/api/history", authFetchInit());
  if (!r.ok) { $("history").textContent = "history fetch failed (" + r.status + ")"; return; }
  const j = await r.json();
  // breakdown 互換: 旧 shape (hc 無し) も一応 fallback で動かす
  const hcCount = j.hc ? j.hc.count : j.count;
  const hcLatest = j.hc ? j.hc.latest : j.latest;
  const zonesCount = j.zones ? j.zones.count : 0;
  const zonesLatest = j.zones ? j.zones.latest : null;
  $("history").textContent =
    "HC " + hcCount + " 件 (最新 " + (hcLatest ?? "なし") + ")" +
    " / Zones " + zonesCount + " 件 (最新 " + (zonesLatest ?? "なし") + ")";
}

async function refreshZonesList() {
  const list = $("zones-list");
  const r = await fetch("/api/zones", authFetchInit());
  if (!r.ok) {
    list.innerHTML = '<li class="py-1 text-rose-600">zones fetch failed (' + r.status + ")</li>";
    return;
  }
  const j = await r.json();
  if (!j.items || j.items.length === 0) {
    list.innerHTML = '<li class="py-1 text-slate-400">なし</li>';
    return;
  }
  // uploaded は ISO 8601 UTC。端末ローカルの HH:MM で表示
  const fmt = (iso) => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  };
  list.innerHTML = j.items
    .map((it) =>
      '<li class="py-1 flex justify-between gap-2"><span>' + it.date + " " + fmt(it.uploaded) +
      '</span><span class="font-mono text-slate-500">' + it.uuid.slice(0, 8) + "…</span></li>",
    )
    .join("");
}

async function uploadNow() {
  if (!hasNative) { setStatus("native bridge 不在 (browser preview)"); return; }
  setStatus("読取中…");
  let payload;
  try { payload = window.HC.readToday(); } catch (e) { setStatus("読取失敗: " + e); return; }
  setStatus("送信中…");
  const r = await fetch("/api/upload", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }));
  if (!r.ok) { setStatus("upload 失敗: " + r.status); return; }
  const j = await r.json();
  setStatus("✓ uploaded " + j.date);
  refreshHistory();
}

async function uploadPast30() {
  if (!hasNative) { setStatus("native bridge 不在 (browser preview)"); return; }
  if (typeof window.HC.readPastDays !== "function") {
    setStatus("APK が古い (HC.readPastDays 未実装)"); return;
  }
  setStatus("過去 30 日読取中…");
  let batch;
  try { batch = window.HC.readPastDays(30); } catch (e) { setStatus("読取失敗: " + e); return; }
  // bridge が error JSON (= { error, message } shape) を返したら detect (Refs #5)
  try {
    const peek = JSON.parse(batch);
    if (peek && peek.error) {
      setStatus("bridge err: " + peek.error + " / " + (peek.message || "").slice(0, 120));
      return;
    }
  } catch {
    setStatus("bridge JSON parse 失敗: " + (batch || "").slice(0, 120));
    return;
  }
  setStatus("送信中… (" + batch.length + " bytes)");
  const r = await fetch("/api/upload-batch", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: batch,
  }));
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    setStatus("upload-batch " + r.status + ": " + errText.slice(0, 200));
    return;
  }
  const j = await r.json();
  setStatus("✓ " + j.written + " 日分 upload");
  refreshHistory();
}

async function uploadZones() {
  const file = $("zones-file").files[0];
  if (!file) { setZonesStatus("ファイル未選択"); return; }
  setZonesStatus("読込中…");
  let text;
  try { text = await file.text(); } catch (e) { setZonesStatus("ファイル読込失敗: " + e); return; }
  // parse して uuid / startDate を pre-check (= サーバ往復前に明確化)
  let parsed;
  try { parsed = JSON.parse(text); } catch { setZonesStatus("JSON parse 失敗"); return; }
  if (!parsed || typeof parsed !== "object" || !parsed.uuid || !parsed.startDate) {
    setZonesStatus("uuid / startDate が JSON に無い");
    return;
  }
  setZonesStatus("送信中…");
  const r = await fetch("/api/upload-zones", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  }));
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    setZonesStatus("upload-zones " + r.status + ": " + errText.slice(0, 200));
    return;
  }
  const j = await r.json();
  setZonesStatus("✓ " + j.date + " / " + j.uuid.slice(0, 8) + "…");
  refreshHistory();
  refreshZonesList();
}

// 日付別 + 突合 view
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtDur(sec) {
  if (sec === null || sec === undefined) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h > 0 ? h + "h " : "") + m + "m";
}
function fmtKm(m) {
  if (m === null || m === undefined) return "—";
  return (m / 1000).toFixed(2) + " km";
}
function badge(type) {
  if (type === "matched") return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-100 text-emerald-800">突合</span>';
  if (type === "hc_only") return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-sky-100 text-sky-800">HC のみ</span>';
  return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-100 text-amber-800">Zones のみ</span>';
}
function renderItem(it) {
  if (it.type === "matched") {
    // 連結成分グループ: hcs[] と zoneses[] を全部並べ、合計サマリ + 解除 button。
    // 1 HC + 1 Zones の典型は従来通りに見えるが、複数だと「グループ」として
    // 表示される。
    const hcs = it.hcs || [];
    const zs = it.zoneses || [];
    const detailHc = hcs[0]; const detailZ = zs[0];
    const detailHref = (detailHc && detailZ)
      ? '/workout?hc=' + encodeURIComponent(detailHc.id) + '&zones=' + encodeURIComponent(detailZ.id)
      : null;
    const hcIdsJson = JSON.stringify(hcs.map((h) => h.id));
    const zIdsJson  = JSON.stringify(zs.map((z) => z.id));
    const manualBadge = it.has_manual
      ? '<span class="inline-block px-1.5 py-0.5 text-[10px] rounded bg-violet-100 text-violet-700">手動</span>'
      : '';
    const html = [];
    html.push('<div class="border-l-2 border-emerald-400 pl-2 py-1 space-y-1">');
    html.push('<div class="flex items-center justify-between">');
    html.push('<span class="text-xs font-medium">', badge("matched"), ' ', manualBadge,
              ' ', String(hcs.length), ' HC × ', String(zs.length), ' Zones</span>');
    html.push(
      '<span class="text-[10px]">',
      detailHref
        ? '<a class="text-emerald-700 hover:underline" href="' + detailHref + '">詳細 ›</a>'
        : '',
      ' <button class="ml-2 text-rose-600 hover:underline" '
        + 'data-action="unpair-group" '
        + 'data-hc-ids="' + escapeHtml(hcIdsJson) + '" '
        + 'data-zones-ids="' + escapeHtml(zIdsJson) + '">解除</button>',
      '</span>',
    );
    html.push('</div>');
    for (const hc of hcs) {
      html.push('<div class="text-[11px] text-sky-700 pl-1">');
      html.push('🏃 HC ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at), ' ',
                escapeHtml(hc.activity_name || "—"),
                ' · ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec));
      html.push('</div>');
    }
    for (const z of zs) {
      html.push('<div class="text-[11px] text-amber-700 pl-1">');
      html.push('⌚ Zones ', fmtTime(z.start_at), '–', fmtTime(z.end_at), ' ',
                escapeHtml(z.activity_name || "—"),
                ' · ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"));
      html.push('</div>');
    }
    html.push('</div>');
    return html.join("");
  }
  if (it.type === "hc_only") {
    const hc = it.hc;
    return [
      '<div class="border-l-2 border-sky-300 pl-2 py-1 flex items-start justify-between">',
      '<div>',
      '<div class="text-xs font-medium">', badge("hc_only"),
      ' ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at),
      ' ', escapeHtml(hc.activity_name || "—"), '</div>',
      '<div class="text-[11px] text-slate-600">HC: ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec), '</div>',
      '</div>',
      '<button class="text-[10px] text-emerald-700 hover:underline shrink-0" ',
        'data-action="link" data-side="hc" data-id="', escapeHtml(hc.id), '">Zones とリンク</button>',
      '</div>',
    ].join("");
  }
  const z = it.zones;
  return [
    '<div class="border-l-2 border-amber-300 pl-2 py-1 flex items-start justify-between">',
    '<div>',
    '<div class="text-xs font-medium">', badge("zones_only"),
    ' ', fmtTime(z.start_at), '–', fmtTime(z.end_at),
    ' ', escapeHtml(z.activity_name || "—"), '</div>',
    '<div class="text-[11px] text-slate-600">Zones: ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"), '</div>',
    '</div>',
    '<button class="text-[10px] text-emerald-700 hover:underline shrink-0" ',
      'data-action="link" data-side="zones" data-id="', escapeHtml(z.id), '">HC とリンク</button>',
    '</div>',
  ].join("");
}
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
async function reindexAll() {
  const btn = $("reindex-btn");
  const status = $("reindex-status");
  btn.disabled = true;
  status.textContent = "再 index 中… (R2 listing + D1 upsert)";
  const r = await fetch("/_admin/reindex", authFetchInit({ method: "POST" }));
  btn.disabled = false;
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    status.textContent = "失敗 " + r.status + ": " + err.slice(0, 200);
    return;
  }
  const j = await r.json();
  status.textContent =
    "✓ HC " + j.hc_files + " files / " + j.hc_rows + " rows、" +
    "Zones " + j.zones_files + " files / " + j.zones_rows + " rows" +
    (j.skipped_total > 0 ? "、skip " + j.skipped_total : "");
  // history と workouts 両方更新 (D1 が新しい行で埋まったので両方変わる)
  refreshHistory().catch(() => {});
  refreshWorkouts().catch(() => {});
}

// 最新の /api/workouts 結果を保持 (リンクモーダルが候補を引くため)
let workoutsCache = null;

async function refreshWorkouts() {
  const days = $("workouts-days").value;
  const summary = $("workouts-summary");
  const list = $("workouts-days-list");
  summary.textContent = "読込中…";
  list.innerHTML = "";
  const r = await fetch("/api/workouts?days=" + encodeURIComponent(days), authFetchInit());
  if (!r.ok) {
    summary.textContent = "fetch failed (" + r.status + ")";
    return;
  }
  const j = await r.json();
  workoutsCache = j;
  const matched = j.days.reduce((acc, d) => acc + d.matched_count, 0);
  summary.textContent = j.day_count + " 日 / 合計 " + j.total + " workout / 突合 " + matched + " 件";
  if (j.day_count === 0) {
    list.innerHTML = '<p class="text-xs text-slate-400">該当データなし</p>';
    return;
  }
  const html = [];
  for (const day of j.days) {
    html.push('<details class="border border-slate-200 rounded-lg" open>');
    html.push('<summary class="cursor-pointer select-none px-3 py-2 text-sm flex items-center justify-between">');
    html.push('<span class="font-medium">', day.date, '</span>');
    html.push('<span class="text-[11px] text-slate-500">HC ', day.hc_count, ' / Zones ', day.zones_count, ' / 突合 ', day.matched_count, '</span>');
    html.push('</summary>');
    html.push('<div class="px-3 pb-2 space-y-1">');
    for (const it of day.items) html.push(renderItem(it));
    html.push('</div></details>');
  }
  list.innerHTML = html.join("");
}

// =============================================================================
// 手動突合 (リンク / 解除) UI
// =============================================================================

// matched group をまるごと解除 (data-hc-ids / data-zones-ids JSON 経由)
async function unpairGroup(hcIds, zonesIds) {
  if (!confirm(hcIds.length + ' HC × ' + zonesIds.length + ' Zones の突合を解除しますか？')) return;
  const r = await fetch("/api/pair/delete", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hc_ids: hcIds, zones_ids: zonesIds }),
  }));
  if (!r.ok) { alert("解除失敗 " + r.status); return; }
  refreshWorkouts().catch(() => {});
}

// 候補一覧を出して 1 つ選ばせて pair 追加
function openLinkPicker(side, id) {
  // side: "hc" (= clicked on hc_only) → 候補 = Zones (zones_only + 突合中 Zones)
  // side: "zones" (= clicked on zones_only) → 候補 = HC (hc_only + 突合中 HC)
  if (!workoutsCache) return;
  const candidates = [];
  for (const day of workoutsCache.days) {
    for (const it of day.items) {
      if (it.type === "matched") {
        const arr = side === "hc" ? it.zoneses : it.hcs;
        for (const r of arr) candidates.push({ row: r, day: day.date, label: side === "hc" ? "⌚" : "🏃", group: "突合中" });
      } else if (side === "hc" && it.type === "zones_only") {
        candidates.push({ row: it.zones, day: day.date, label: "⌚", group: "未突合" });
      } else if (side === "zones" && it.type === "hc_only") {
        candidates.push({ row: it.hc, day: day.date, label: "🏃", group: "未突合" });
      }
    }
  }
  // 同じ workout 候補が近い時刻にあるはずなので、日付 desc → 時刻 asc で sort
  candidates.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    const av = a.row.start_at ?? "";
    const bv = b.row.start_at ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  if (candidates.length === 0) { alert("リンクできる候補がありません"); return; }
  // モーダル DOM 構築
  const targetLabel = side === "hc" ? "Zones (⌚)" : "HC (🏃)";
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-2";
  wrap.innerHTML = '<div class="bg-white w-full max-w-md rounded-2xl p-4 max-h-[80vh] overflow-auto">'
    + '<div class="flex items-center justify-between mb-2">'
    + '<h3 class="font-semibold">リンク先の ' + targetLabel + ' を選択</h3>'
    + '<button id="pick-cancel" class="text-sm text-slate-500">閉じる</button>'
    + '</div>'
    + '<p class="text-[10px] text-slate-500 mb-2">候補 ' + candidates.length + ' 件。タップで即リンク。突合中を選ぶとそのグループに合流します。</p>'
    + '<ul id="pick-list" class="space-y-1"></ul>'
    + '</div>';
  document.body.appendChild(wrap);
  const ul = wrap.querySelector("#pick-list");
  for (const c of candidates) {
    const li = document.createElement("li");
    // 未突合 = slate-50 背景 / 未マッチを示す。突合中 = emerald-50 背景 + ✓ icon。
    const isMatched = c.group === "突合中";
    li.className = (isMatched
      ? "border-l-4 border-emerald-400 bg-emerald-50 "
      : "border-l-4 border-slate-300 bg-white "
    ) + "border border-slate-200 rounded p-2 text-xs hover:bg-emerald-100 cursor-pointer flex items-center justify-between gap-2";
    const badge = isMatched
      ? '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-500 text-white shrink-0">✓ 突合中</span>'
      : '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-400 text-white shrink-0">未突合</span>';
    li.innerHTML = '<span>' + c.label + ' <span class="font-medium">' + c.day + '</span> '
      + fmtTime(c.row.start_at) + '–' + fmtTime(c.row.end_at) + ' '
      + escapeHtml(c.row.activity_name || "—") + '</span>'
      + badge;
    li.addEventListener("click", async () => {
      const hcId = side === "hc" ? id : c.row.id;
      const zonesId = side === "hc" ? c.row.id : id;
      const r = await fetch("/api/pair", authFetchInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hc_id: hcId, zones_id: zonesId }),
      }));
      wrap.remove();
      if (!r.ok) { alert("リンク失敗 " + r.status); return; }
      refreshWorkouts().catch(() => {});
    });
    ul.appendChild(li);
  }
  wrap.querySelector("#pick-cancel").addEventListener("click", () => wrap.remove());
}

// event delegation: workouts-days-list 内のボタンを 1 つの listener で捌く
function onWorkoutsListClick(ev) {
  const btn = ev.target.closest && ev.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  if (action === "link") {
    openLinkPicker(btn.getAttribute("data-side"), btn.getAttribute("data-id"));
  } else if (action === "unpair-group") {
    try {
      const hcIds = JSON.parse(btn.getAttribute("data-hc-ids") || "[]");
      const zIds = JSON.parse(btn.getAttribute("data-zones-ids") || "[]");
      unpairGroup(hcIds, zIds);
    } catch (e) { /* ignore */ }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("env-badge").textContent = hasNative ? "native bridge: ✓" : "PWA / preview";
  $("upload-btn").addEventListener("click", uploadNow);
  $("upload-30-btn").addEventListener("click", uploadPast30);
  $("auto-toggle").addEventListener("change", (e) => {
    if (!hasNative) return;
    if (e.target.checked) window.HC.scheduleDailyUpload();
    else window.HC.cancelDailyUpload();
  });
  if (hasNative) $("auto-toggle").checked = window.HC.isDailyUploadScheduled();
  $("zones-upload-btn").addEventListener("click", uploadZones);
  $("workouts-days").addEventListener("change", () => { refreshWorkouts().catch(() => {}); });
  $("workouts-days-list").addEventListener("click", onWorkoutsListClick);
  $("reindex-btn").addEventListener("click", reindexAll);
  refreshHistory().catch(() => {});
  refreshZonesList().catch(() => {});
  refreshWorkouts().catch(() => {});
});
</script>
</body>
</html>`;


/**
 * 突合 detail ページ。`/workout?hc=<id>&zones=<id>` で開く。
 * `/api/workout` から D1 行 + R2 raw を取得し、Chart.js で速度推移と HR zones を描画。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export const WORKOUT_DETAIL_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Workout 詳細 — HC Reader</title>
<link rel="icon" href="/favicon.ico" sizes="any" />
<meta name="theme-color" content="#059669" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
<div class="max-w-3xl mx-auto p-4 space-y-4">
  <header class="flex items-center justify-between pt-2">
    <a href="/" class="text-sm text-emerald-700">‹ 戻る</a>
    <h1 class="text-lg font-semibold">Workout 詳細</h1>
    <span></span>
  </header>

  <section id="summary" class="bg-white rounded-2xl shadow p-4 text-sm text-slate-700">読込中…</section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">速度比較</h2>
    <p id="speed-empty" class="text-xs text-slate-500 hidden">速度データ無し</p>
    <p class="text-[10px] text-slate-400">
      HC 時系列 (端末が記録した場合のみ) + HC 平均 + Zones 平均を重ねて表示。
      下のチップ or 凡例タップで個別系列の表示/非表示を切替できます。
    </p>
    <div id="speed-toggles" class="flex flex-wrap gap-1.5"></div>
    <div class="relative h-64"><canvas id="speed-chart"></canvas></div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">心拍ゾーン (Zones zones)</h2>
    <p id="zones-empty" class="text-xs text-slate-500 hidden">zones 情報無し</p>
    <div class="relative h-64"><canvas id="zones-chart"></canvas></div>
  </section>

  <details class="bg-white rounded-2xl shadow p-4">
    <summary class="cursor-pointer text-sm font-semibold">raw payload (debug)</summary>
    <pre id="raw-dump" class="mt-2 text-[10px] text-slate-600 overflow-x-auto whitespace-pre-wrap"></pre>
  </details>
</div>

<script>
const params = new URLSearchParams(location.search);
const hcId = params.get("hc");
const zId = params.get("zones");

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtDur(sec) {
  if (sec === null || sec === undefined) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h > 0 ? h + "h " : "") + m + "m";
}
function fmtKm(m) {
  if (m === null || m === undefined) return "—";
  return (m / 1000).toFixed(2) + " km";
}
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

async function load() {
  if (!hcId && !zId) {
    document.getElementById("summary").textContent = "?hc= / ?zones= 必須";
    return;
  }
  const qs = new URLSearchParams();
  if (hcId) qs.set("hc", hcId);
  if (zId) qs.set("zones", zId);
  const r = await fetch("/api/workout?" + qs.toString(), { credentials: "include" });
  if (!r.ok) {
    document.getElementById("summary").textContent = "fetch failed (" + r.status + ")";
    return;
  }
  const j = await r.json();
  renderSummary(j);
  renderSpeedChart(j);
  renderZonesChart(j.zones && j.zones.raw);
  document.getElementById("raw-dump").textContent = JSON.stringify(j, null, 2);
}

function renderSummary(j) {
  const hc = j.hc && j.hc.row;
  const z = j.zones && j.zones.row;
  const html = [];
  if (hc) {
    html.push('<div class="mb-2">');
    html.push('<div class="text-xs text-slate-500">HC (Android Health Connect)</div>');
    html.push('<div class="font-medium">', escapeHtml(hc.activity_name || "—"), ' ',
              fmtTime(hc.start_at), '–', fmtTime(hc.end_at), '</div>');
    html.push('<div class="text-xs">距離 ', fmtKm(hc.distance_m), ' / 時間 ', fmtDur(hc.duration_sec), '</div>');
    html.push('</div>');
  }
  if (z) {
    html.push('<div>');
    html.push('<div class="text-xs text-slate-500">Zones (iOS Apple Watch)</div>');
    html.push('<div class="font-medium">', escapeHtml(z.activity_name || "—"), ' ',
              fmtTime(z.start_at), '–', fmtTime(z.end_at), '</div>');
    html.push('<div class="text-xs">距離 ', fmtKm(z.distance_m), ' / 平均心拍 ♥', (z.avg_heart_rate ?? "—"),
              ' / kcal ', (z.active_calories ?? "—"), '</div>');
    html.push('</div>');
  }
  document.getElementById("summary").innerHTML = html.join("") || "(データ無し)";
}

// 速度比較 chart: HC 時系列 (端末が記録した場合のみ) + HC 平均 + Zones 平均を
// 重ねて表示。後で「Zones 時系列」など別 source が増えても dataset を追加する
// だけで拡張できる構造にしてある。
function renderSpeedChart(j) {
  const canvas = document.getElementById("speed-chart");
  const empty = document.getElementById("speed-empty");
  const hcRaw = j.hc && j.hc.raw;
  const hcRow = j.hc && j.hc.row;
  const zRow = j.zones && j.zones.row;

  // 1. HC 時系列 samples を **source (package name) 別** に集約する。
  //    Fitbit / Google Fit / Samsung Health 等は同期遅延でズレることが多いので、
  //    どの source の系列か明示して user が判断できるようにする。
  const hcSeriesBySource = new Map(); // src -> [{x, y}]
  const speeds = hcRaw && Array.isArray(hcRaw.speeds) ? hcRaw.speeds : [];
  for (const s of speeds) {
    if (!s || !Array.isArray(s.samples)) continue;
    const src = typeof s.source === "string" && s.source ? s.source : "unknown";
    let arr = hcSeriesBySource.get(src);
    if (!arr) { arr = []; hcSeriesBySource.set(src, arr); }
    for (const sa of s.samples) {
      if (sa && typeof sa.time === "string" && typeof sa.kmh === "number") {
        arr.push({ x: new Date(sa.time).getTime(), y: sa.kmh });
      }
    }
  }
  for (const arr of hcSeriesBySource.values()) arr.sort((a, b) => a.x - b.x);
  // 全 source の最小/最大 x も計算
  let allXs = [];
  for (const arr of hcSeriesBySource.values()) for (const p of arr) allXs.push(p.x);
  const hcHasSamples = allXs.length > 0;

  // 2. HC / Zones 平均速度 (distance_m / duration_sec から)
  function avg(row) {
    if (!row || typeof row.distance_m !== "number" || typeof row.duration_sec !== "number" || row.duration_sec <= 0) return null;
    return (row.distance_m / 1000) / (row.duration_sec / 3600);
  }
  const hcAvg = avg(hcRow);
  const zAvg = avg(zRow);

  // X 軸範囲: HC 時系列が有ればそこから、無ければ workout 期間で平均線を引く
  let xMin, xMax;
  if (hcHasSamples) {
    xMin = Math.min.apply(null, allXs);
    xMax = Math.max.apply(null, allXs);
  } else {
    const row = hcRow || zRow;
    if (row && row.start_at && row.end_at) {
      xMin = Date.parse(row.start_at);
      xMax = Date.parse(row.end_at);
    }
  }

  // source ごとの色 palette。Fitbit / Google Fit / Samsung Health 等を明示。
  const SRC_COLORS = ["#059669", "#0ea5e9", "#a855f7", "#f97316", "#dc2626", "#0d9488"];
  function shortSource(src) {
    // "com.fitbit.FitbitMobile" → "Fitbit", "com.google.android.apps.fitness" → "Google Fit", 等
    if (src.includes("fitbit")) return "Fitbit";
    if (src.includes("google.android.apps.fitness") || src.includes("google.android.gms.fitness")) return "Google Fit";
    if (src.includes("samsung.health")) return "Samsung Health";
    if (src.includes("healthconnect")) return "Health Connect";
    if (src === "unknown") return "(source 不明)";
    // 末尾セグメント
    const parts = src.split(".");
    return parts[parts.length - 1] || src;
  }

  const datasets = [];
  let colorIdx = 0;
  for (const [src, pts] of hcSeriesBySource) {
    if (pts.length === 0) continue;
    const color = SRC_COLORS[colorIdx % SRC_COLORS.length];
    colorIdx++;
    datasets.push({
      label: "HC 速度 [" + shortSource(src) + "] " + pts.length + " 点",
      data: pts.map((p) => ({ x: p.x, y: p.y })),
      borderColor: color,
      backgroundColor: color + "22",
      tension: 0.2,
      pointRadius: 0,
    });
  }
  if (hcAvg !== null && xMin !== undefined) {
    datasets.push({
      label: "HC 平均 " + hcAvg.toFixed(2) + " km/h",
      data: [{ x: xMin, y: hcAvg }, { x: xMax, y: hcAvg }],
      borderColor: "#10b981",
      borderDash: [6, 4],
      pointRadius: 0,
      borderWidth: 2,
    });
  }
  if (zAvg !== null && xMin !== undefined) {
    datasets.push({
      label: "Zones 平均 " + zAvg.toFixed(2) + " km/h",
      data: [{ x: xMin, y: zAvg }, { x: xMax, y: zAvg }],
      borderColor: "#6366f1",
      borderDash: [6, 4],
      pointRadius: 0,
      borderWidth: 2,
    });
  }

  if (datasets.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    return;
  }

  // 時刻 X 軸の adapter を入れずに済むよう linear で扱い、tick callback で HH:MM 整形
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "km/h" } },
        x: {
          type: "linear",
          min: xMin, max: xMax,
          ticks: {
            maxTicksLimit: 8,
            callback: (v) => {
              const d = new Date(v);
              return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
            },
          },
        },
      },
    },
  });

  // ----- 系列トグル chip 行 (legend より大きくタップしやすい) -----
  const togglesEl = document.getElementById("speed-toggles");
  if (togglesEl) {
    togglesEl.innerHTML = "";
    datasets.forEach((ds, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "px-2 py-1 text-[11px] rounded-full border transition";
      const setStyle = (visible) => {
        btn.style.borderColor = ds.borderColor;
        btn.style.color = visible ? "#fff" : ds.borderColor;
        btn.style.backgroundColor = visible ? ds.borderColor : "#fff";
        btn.style.opacity = visible ? "1" : "0.55";
      };
      setStyle(true);
      btn.textContent = ds.label;
      btn.addEventListener("click", () => {
        const meta = chart.getDatasetMeta(idx);
        meta.hidden = !meta.hidden;
        setStyle(!meta.hidden);
        chart.update();
      });
      togglesEl.appendChild(btn);
    });
  }
}

function renderZonesChart(zRaw) {
  const canvas = document.getElementById("zones-chart");
  const empty = document.getElementById("zones-empty");
  const zones = zRaw && zRaw.zones && typeof zRaw.zones === "object" ? zRaw.zones : null;
  if (!zones) { empty.classList.remove("hidden"); canvas.classList.add("hidden"); return; }
  // 各 zone から duration (sec) を抽出。形は { duration: { value, unit } } を想定し
  // それ以外なら value プロパティをトライ
  function pickSec(z) {
    if (!z || typeof z !== "object") return 0;
    if (z.duration && typeof z.duration === "object") {
      const v = z.duration.value, u = z.duration.unit;
      if (typeof v !== "number") return 0;
      if (u === "sec" || u === "s") return v;
      if (u === "min") return v * 60;
      if (u === "hr" || u === "hour") return v * 3600;
      return v;
    }
    if (typeof z.value === "number") return z.value;
    return 0;
  }
  const labels = [];
  const data = [];
  const COLORS = ["#94a3b8", "#22d3ee", "#10b981", "#f59e0b", "#ef4444"];
  for (let i = 1; i <= 5; i++) {
    const key = "zone" + i;
    if (zones[key] !== undefined) {
      labels.push("Z" + i);
      data.push(Math.round(pickSec(zones[key]) / 60 * 10) / 10); // min
    }
  }
  if (data.length === 0) { empty.classList.remove("hidden"); canvas.classList.add("hidden"); return; }
  // 横向き bar: X 軸 = 時間 (min)、Y 軸 = Z1..Z5。
  // 各ゾーンに費やした時間を視覚的に比較しやすい (Z3 が一番長い等が一目で分かる)。
  new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets: [{
      label: "時間 (min)",
      data,
      backgroundColor: COLORS.slice(0, data.length),
    }]},
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ctx.parsed.x + " min" } },
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: "min" } },
        y: { title: { display: false } },
      },
    },
  });
}

load();
</script>
</body>
</html>`;
