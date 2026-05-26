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
    const hc = it.hc, z = it.zones;
    return [
      '<div class="border-l-2 border-emerald-400 pl-2 py-1">',
      '<div class="flex items-center justify-between">',
      '<span class="text-xs font-medium">', badge("matched"),
      ' ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at),
      ' ', escapeHtml(hc.activity_name || "—"), '</span>',
      '<span class="text-[10px] text-slate-500">overlap ', fmtDur(it.overlap_sec), '</span>',
      '</div>',
      '<div class="text-[11px] text-slate-600 grid grid-cols-2 gap-x-2">',
      '<span>HC: ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec), '</span>',
      '<span>Zones: ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"), '</span>',
      '</div>',
      '</div>',
    ].join("");
  }
  if (it.type === "hc_only") {
    const hc = it.hc;
    return [
      '<div class="border-l-2 border-sky-300 pl-2 py-1">',
      '<div class="text-xs font-medium">', badge("hc_only"),
      ' ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at),
      ' ', escapeHtml(hc.activity_name || "—"), '</div>',
      '<div class="text-[11px] text-slate-600">HC: ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec), '</div>',
      '</div>',
    ].join("");
  }
  const z = it.zones;
  return [
    '<div class="border-l-2 border-amber-300 pl-2 py-1">',
    '<div class="text-xs font-medium">', badge("zones_only"),
    ' ', fmtTime(z.start_at), '–', fmtTime(z.end_at),
    ' ', escapeHtml(z.activity_name || "—"), '</div>',
    '<div class="text-[11px] text-slate-600">Zones: ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"), '</div>',
    '</div>',
  ].join("");
}
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
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
  refreshHistory().catch(() => {});
  refreshZonesList().catch(() => {});
  refreshWorkouts().catch(() => {});
});
</script>
</body>
</html>`;
