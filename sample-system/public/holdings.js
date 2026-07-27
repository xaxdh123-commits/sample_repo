const base = location.pathname.replace(/\/[^/]*$/, "");
const apiBase = base === "/" ? "" : base;
const $ = (id) => document.getElementById(id);
const labels = { draft: "草稿", printed: "打印", claimed: "领用", sent: "寄出", completed: "入库", void: "作废" };
let holdingUsers = [];
let currentUser = null;
let activeHoldingList = { userId: "", status: "" };

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
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}

function sampleActions(sample) {
  const send = ["printed", "claimed"].includes(sample.status) ? `<button type="button" data-sample-status="${sample.id}" data-next="sent">寄出</button>` : "";
  const voidButton = !["void", "completed"].includes(sample.status) ? `<button type="button" class="danger" data-sample-status="${sample.id}" data-next="void">作废</button>` : "";
  const options = [`<option value="">操作</option>`, `<option value="detail:${sample.id}">详情</option>`];
  if (["printed", "claimed"].includes(sample.status)) options.push(`<option value="status:${sample.id}:sent">寄出</option>`);
  if (!["void", "completed"].includes(sample.status)) options.push(`<option value="status:${sample.id}:void">作废</option>`);
  return `<div class="row-actions"><a class="top-link holding-detail-link" href="./detail.html?id=${encodeURIComponent(sample.id)}">详情</a>${send}${voidButton}</div><select class="mobile-action-select" data-mobile-action>${options.join("")}</select>`;
}

async function loadHoldings() {
  const { holdings } = await api("/sample-holdings");
  holdingUsers = holdings;
  const mine = holdings.find((item) => item.userId === currentUser?.id);
  $("currentHoldingCount").textContent = mine ? mine.total : 0;
  $("currentHoldingCount").hidden = false;
  $("holdingGrid").innerHTML = holdings.length ? holdings.map((item) => `
    <article class="holding-card" data-user-id="${escapeHtml(item.userId)}">
      <div class="holding-card-head">
        <div><h3>${escapeHtml(item.displayName || item.username)}</h3><span class="muted">${escapeHtml(item.username)}</span></div>
        <button type="button" class="holding-total" data-holding-status="">${item.total}<small> 个</small></button>
      </div>
      <div class="holding-breakdown">
        <button type="button" data-holding-status="printed"><b>${item.printed}</b>打印</button>
        <button type="button" data-holding-status="claimed"><b>${item.claimed}</b>领用</button>
      </div>
      <p class="holding-updated">最近更新：${formatTime(item.lastUpdatedAt)}</p>
    </article>`).join("") : `<p class="muted">当前没有人员持有样品</p>`;
}

async function showHoldingSamples(userId, status) {
  const user = holdingUsers.find((item) => item.userId === userId) || (currentUser?.id === userId ? { userId: currentUser.id, username: currentUser.username, displayName: currentUser.displayName } : null);
  if (!user) return;
  activeHoldingList = { userId, status };
  const params = new URLSearchParams({ userId });
  if (status) params.set("status", status);
  const { samples } = await api(`/sample-holdings/samples?${params}`);
  $("holdingSamplesTitle").textContent = `${user.displayName || user.username} · ${status ? labels[status] : "领用"}（${samples.length}）`;
  $("holdingSamplesRows").innerHTML = samples.length ? samples.map((sample) => `
    <tr>
      <td><strong>${escapeHtml(sample.sampleCode)}</strong><br><span class="muted">${sample.sampleType === "packaging" ? "包装" : "标签"}</span></td>
      <td>${escapeHtml(sample.plateNumber || "-")}<br><span class="muted">${escapeHtml(sample.customerName || "-")}</span></td>
      <td>${escapeHtml(sample.orderNumber || "-")}</td>
      <td>${escapeHtml(sample.storeName || "-")}</td>
      <td><span class="badge ${sample.status}">${labels[sample.status] || sample.status}</span></td>
      <td>${escapeHtml(sample.updatedByName || "")}<br><span class="muted">${formatTime(sample.updatedAt)}</span></td>
      <td class="sticky-action">${sampleActions(sample)}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">没有样品</td></tr>`;
  $("holdingSamplesDialog").showModal();
}

async function changeSampleStatus(id, target) {
  const reason = target === "void" ? prompt("请输入作废原因") : "";
  if (target === "void" && !reason) return;
  await api(`/samples/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: target, reason }) });
  toast(`状态已更新为${labels[target]}`);
  await loadHoldings();
  if (activeHoldingList.userId && $("holdingSamplesDialog").open) await showHoldingSamples(activeHoldingList.userId, activeHoldingList.status);
}

$("refresh").onclick = () => loadHoldings().catch((error) => toast(error.message));
$("logout").onclick = async () => { await api("/logout", { method: "POST", body: "{}" }); location.reload(); };
$("closeHoldingSamples").onclick = () => $("holdingSamplesDialog").close();
$("holdingSamplesRows").onclick = (event) => {
  const button = event.target.closest("[data-sample-status]");
  if (!button) return;
  changeSampleStatus(button.dataset.sampleStatus, button.dataset.next).catch((error) => toast(error.message));
};
$("holdingSamplesRows").addEventListener("change", (event) => {
  const select = event.target.closest("[data-mobile-action]");
  if (!select) return;
  const [type, id, target] = String(select.value || "").split(":");
  select.value = "";
  if (type === "detail" && id) location.href = `./detail.html?id=${encodeURIComponent(id)}`;
  if (type === "status" && id && target) changeSampleStatus(id, target).catch((error) => toast(error.message));
});
$("currentHoldingCount").onclick = (event) => {
  event.preventDefault();
  if (currentUser) showHoldingSamples(currentUser.id, "").catch((error) => toast(error.message));
};
$("holdingGrid").onclick = (event) => {
  const button = event.target.closest("[data-holding-status]");
  if (!button) return;
  const card = event.target.closest("[data-user-id]");
  if (!card) return;
  showHoldingSamples(card.dataset.userId, button.dataset.holdingStatus).catch((error) => toast(error.message));
};

(async () => {
  try {
    await initializeAuth(); await loadHoldings();
    if (new URLSearchParams(location.search).get("mine") === "1" && currentUser) await showHoldingSamples(currentUser.id, "");
  }
  catch (error) { toast(error.message); }
})();
