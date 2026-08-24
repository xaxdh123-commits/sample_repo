const base = location.pathname.replace(/\/[^/]*$/, "");
const apiBase = base === "/" ? "" : base;
const $ = (id) => document.getElementById(id);
const labels = { draft: "草稿", printed: "打印", claimed: "领用", sent: "寄出", completed: "入库", void: "作废" };
let currentUser = null;
let claiming = false;
let scanTimer = null;
let records = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}/api${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = `https://auth.qiyinbz.com/?return_to=${encodeURIComponent(location.href.split("?")[0])}`;
    throw new Error("登录已失效");
  }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function initializeAuth() {
  const url = new URL(location.href);
  const token = url.searchParams.get("token") || url.searchParams.get("Admin-Token");
  if (token) {
    await api("/auth/exchange", { method: "POST", body: JSON.stringify({ token }) });
    url.searchParams.delete("token");
    url.searchParams.delete("Admin-Token");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const { user } = await api("/me");
  currentUser = user;
  $("userName").textContent = `${user.displayName}（${user.username}）`;
  await loadCurrentHoldingCount();
}

async function loadCurrentHoldingCount() {
  const { holdings } = await api("/sample-holdings");
  const mine = holdings.find((item) => item.userId === currentUser.id);
  $("currentHoldingCount").textContent = mine ? mine.total : 0;
  $("currentHoldingCount").hidden = false;
}

async function loadClaimRecords() {
  const data = await api("/claim-records/today");
  records = data.records || [];
  renderRecords();
}

function focusInput() {
  const input = $("scanInput");
  if (document.activeElement !== input) input.focus();
}

function sampleIdFromScan(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  try {
    const url = new URL(raw, location.origin);
    const id = url.searchParams.get("id") || (url.pathname.match(/\/q\/(\d+)$/) || [])[1];
    return /^\d+$/.test(id || "") ? id : "";
  } catch {
    const match = raw.match(/(?:^|[?&/])(?:id=)?(\d+)(?:$|[&#?])/);
    return match ? match[1] : "";
  }
}

function looksLikeSampleCode(value) {
  return /^[A-Za-z]{1,3}\d{3,}$/.test(String(value || "").trim());
}

async function resolveSampleId(value) {
  const raw = String(value || "").trim();
  const id = sampleIdFromScan(raw);
  if (id) return id;
  if (!raw) return "";
  const params = new URLSearchParams({ q: raw });
  const { samples } = await api(`/samples/lookup?${params}`);
  const exact = (samples || []).find((sample) => sample.sampleCode.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.id;
  if ((samples || []).length === 1) return samples[0].id;
  if ((samples || []).length > 1) throw new Error(`匹配到 ${samples.length} 条，请扫描完整样品号`);
  return "";
}

function renderRecords() {
  $("scanRecords").innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(formatTime(record.operatedAt))}</td>
      <td><span class="badge claimed">领用</span></td>
      <td><a href="./detail.html?id=${encodeURIComponent(record.sample.id)}">${escapeHtml(record.sample.sampleCode)}</a></td>
      <td>${escapeHtml(record.sample.customerName || "-")}<br><span class="muted">${escapeHtml(record.sample.storeName || "")}</span></td>
      <td>${escapeHtml(labels[record.sample.status] || record.sample.status || "-")}</td>
      <td>${escapeHtml(record.fromStatus === "claimed" ? "转领/重复领用" : "领用")}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty">暂无领用记录</td></tr>`;
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}

async function claimByScan(value) {
  if (claiming) return;
  const raw = String(value || "").trim();
  $("scanInput").value = "";
  focusInput();
  claiming = true;
  $("scanMessage").textContent = `正在识别 ${raw || "-"}…`;
  try {
    const sampleId = await resolveSampleId(raw);
    if (!sampleId) throw new Error(`未找到样品：${raw || "-"}`);
    $("scanMessage").textContent = `正在领用 ${sampleId}…`;
    await api(`/samples/${sampleId}/claim`, { method: "POST", body: "{}" });
    const { sample } = await api(`/samples/${sampleId}`);
    $("scanMessage").textContent = `${sample.sampleCode} 已领用`;
    await loadCurrentHoldingCount();
    await loadClaimRecords();
  } catch (error) {
    $("scanMessage").textContent = error.message;
    toast(error.message);
  } finally {
    claiming = false;
    $("scanInput").value = "";
    focusInput();
  }
}

$("scanForm").onsubmit = (event) => {
  event.preventDefault();
  clearTimeout(scanTimer);
  claimByScan($("scanInput").value);
};

$("scanInput").addEventListener("input", () => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    const value = $("scanInput").value.trim();
    if (sampleIdFromScan(value) || looksLikeSampleCode(value)) claimByScan(value);
  }, 250);
});

$("refreshRecords").onclick = () => {
  loadClaimRecords().catch((error) => toast(error.message));
  focusInput();
};

document.addEventListener("click", () => setTimeout(focusInput, 0));
window.addEventListener("focus", focusInput);

initializeAuth().then(() => loadClaimRecords()).then(focusInput).catch((error) => {
  toast(error.message);
  $("scanMessage").textContent = error.message;
});
