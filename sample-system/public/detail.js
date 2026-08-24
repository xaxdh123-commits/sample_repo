const base = location.pathname.slice(0, location.pathname.lastIndexOf("/"));
const apiBase = base;
const $ = (id) => document.getElementById(id);
const labels = { draft: "草稿", printed: "打印", claimed: "领用", sent: "寄出", completed: "入库", void: "作废" };
const actionLabels = { create: "创建", update: "修改", status_change: "状态变更", print: "打印", reprint: "补打", image_add: "添加图片", image_delete: "删除图片", legacy_import: "历史导入" };
let sample = null; let samples = []; let claiming = false; let autoClaimTimer = null;
let currentUser = null;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(message) { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => $("toast").classList.remove("show"), 2800); }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }
async function api(path, options = {}) {
  const response = await fetch(`${apiBase}/api${path}`, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.href = `https://auth.qiyinbz.com/?return_to=${encodeURIComponent(location.href)}`; throw new Error("登录已失效"); }
  if (!response.ok) throw new Error(data.error || "请求失败"); return data;
}
async function initializeAuth() {
  const url = new URL(location.href); const token = url.searchParams.get("token") || url.searchParams.get("Admin-Token");
  if (token) { await api("/auth/exchange", { method: "POST", body: JSON.stringify({ token }) }); url.searchParams.delete("token"); url.searchParams.delete("Admin-Token"); history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); }
  const { user } = await api("/me"); currentUser = user; $("userName").textContent = `${user.displayName}（${user.username}）`;
  loadCurrentHoldingCount().catch(() => {});
}
async function loadCurrentHoldingCount() {
  const { holdings } = await api("/sample-holdings");
  const mine = holdings.find((item) => item.userId === currentUser.id);
  $("currentHoldingCount").textContent = mine ? mine.total : 0;
  $("currentHoldingCount").hidden = false;
}
function setClaimState() {
  const disabled = !sample || ["sent", "completed", "void"].includes(sample.status);
  $("claimAndReturn").disabled = disabled;
  $("claimAndReturn").textContent = sample && disabled ? `${labels[sample.status]}状态不可领用` : "领用";
}
function renderTabs() {
  $("sampleTabs").hidden = samples.length <= 1;
  $("sampleTabs").innerHTML = samples.map((item) => `<button type="button" class="${sample?.id === item.id ? "active" : ""}" data-sample-id="${escapeHtml(item.id)}">${escapeHtml(item.sampleCode)}</button>`).join("");
}
async function renderOperations() {
  if (!sample) { $("detailTimeline").innerHTML = ""; return; }
  const { operations } = await api(`/samples/${sample.id}/operations`);
  $("detailTimeline").innerHTML = operations.map((op) => `<div><b>${actionLabels[op.action] || op.action}</b><span>${escapeHtml(op.operatorName)} · ${formatTime(op.operatedAt)}</span><small>${labels[op.fromStatus] || ""}${op.toStatus && op.toStatus !== op.fromStatus ? ` → ${labels[op.toStatus]}` : ""}</small></div>`).join("");
}
async function selectSample(nextSample) {
  sample = nextSample || null;
  renderTabs();
  if (!sample) {
    $("detailTitle").textContent = "未找到样品";
    $("detailSubtitle").textContent = "请输入关键字继续查询";
    $("detailStatus").innerHTML = "";
    $("detailContent").innerHTML = "";
    $("detailImages").innerHTML = "";
    await renderOperations();
    setClaimState();
    return;
  }
  const changes = [[sample.contentChanged, "内容"], [sample.colorChanged, "颜色"], [sample.specificationChanged, "规格"], [sample.boxTypeChanged, "盒型"]].filter(([yes]) => yes).map(([, label]) => label).join("、") || "无";
  $("detailTitle").textContent = `${sample.sampleCode} · ${sample.customerName}`;
  $("detailSubtitle").textContent = sample.sampleType === "packaging" ? "包装样品" : "标签样品";
  $("detailStatus").innerHTML = `<span class="badge ${sample.status}">${labels[sample.status]}</span>`;
  $("detailContent").innerHTML = `<dl><dt>版号</dt><dd>${escapeHtml(sample.plateNumber || "-")}</dd><dt>客户名/ID</dt><dd>${escapeHtml(sample.customerName || "-")}</dd><dt>订单编号</dt><dd>${escapeHtml(sample.orderNumber || "-")}</dd><dt>店铺</dt><dd>${escapeHtml(sample.storeName)}</dd><dt>店铺管理员</dt><dd>${escapeHtml(sample.ownerName)} ${escapeHtml(sample.ownerPhone)}</dd><dt>样品类别</dt><dd>${escapeHtml(sample.sampleCategories.join("、") || "-")}</dd><dt>改动项目</dt><dd>${escapeHtml(changes)}</dd><dt>内容</dt><dd>${escapeHtml(sample.sampleContent || "-")}</dd><dt>规格</dt><dd>${escapeHtml(sample.sampleSpecification || "-")}</dd><dt>颜色</dt><dd>${escapeHtml(sample.sampleColor || "-")}</dd><dt>备注</dt><dd>${escapeHtml(sample.note || "-")}</dd><dt>创建人</dt><dd>${escapeHtml(sample.createdByName)} ${escapeHtml(sample.createdByPhone || "")}</dd><dt>创建时间</dt><dd>${formatTime(sample.createdAt)}</dd><dt>最后更新</dt><dd>${escapeHtml(sample.updatedByName)} · ${formatTime(sample.updatedAt)}</dd></dl>`;
  $("detailImages").innerHTML = sample.imageIds.map((id) => `<a href="${apiBase}/api/images/${id}" target="_blank"><img src="${apiBase}/api/images/${id}" alt="样品图片"></a>`).join("") || `<span class="muted">暂无图片</span>`;
  setClaimState();
  await renderOperations();
}
function closeDetailPage() {
  if (window.uni?.navigateBack) { window.uni.navigateBack({ delta: 1 }); return; }
  if (window.wx?.miniProgram?.navigateBack) { window.wx.miniProgram.navigateBack({ delta: 1 }); return; }
  document.addEventListener("UniAppJSBridgeReady", () => {
    if (window.uni?.navigateBack) window.uni.navigateBack({ delta: 1 });
  }, { once: true });
  window.close();
  setTimeout(() => {
    if (history.length > 1) history.back();
    else location.href = "./";
  }, 400);
}

async function claimSample(options = {}) {
  const closeAfterClaim = Boolean(options?.closeAfterClaim);
  if (claiming || !sample || ["sent", "completed", "void"].includes(sample.status)) return; claiming = true; $("claimAndReturn").disabled = true;
  try {
    if (sample.status === "draft") await api(`/samples/${sample.id}/print`, { method: "POST", body: "{}" });
    await api(`/samples/${sample.id}/claim`, { method: "POST", body: "{}" });
    sample.status = "claimed"; claiming = false; setClaimState(); $("detailStatus").innerHTML = `<span class="badge claimed">领用</span>`; $("autoClaimMessage").textContent = "已领用";
    const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete("autoClaim"); history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    if (closeAfterClaim) setTimeout(closeDetailPage, 250);
  } catch (error) { claiming = false; setClaimState(); toast(error.message); }
}
function queryFromInputs() {
  return $("detailSearchInput").value.trim();
}
function queryFromUrl(params) {
  return (params.get("q") || params.get("keyword") || params.get("sampleCode") || params.get("code") || params.get("sampleId") || params.get("orderNumber") || params.get("order") || params.get("plateNumber") || params.get("plate") || "").trim();
}
function afterRender() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function lookupByQuery(q, replaceUrl) {
  if (!q) {
    samples = [];
    $("detailSearchPanel").hidden = false;
    $("detailSearchMessage").textContent = "请输入样品 ID、样品号、订单号、版号、客户或店铺";
    await selectSample(null);
    return;
  }
  $("detailSearchPanel").hidden = true;
  $("detailSearchMessage").textContent = "";
  const params = new URLSearchParams({ q });
  const data = await api(`/samples/lookup?${params}`);
  samples = data.samples || [];
  if (replaceUrl) history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  if (!samples.length) {
    $("detailSearchPanel").hidden = false;
    $("detailSearchMessage").textContent = "没有找到匹配样品，请调整关键字继续查询";
    await selectSample(null);
    return;
  }
  $("detailSearchMessage").textContent = samples.length > 1 ? `找到 ${samples.length} 条样品，请选择样品号查看` : "";
  await selectSample(samples[0]);
}
async function load() {
  await initializeAuth(); const params = new URLSearchParams(location.search); const id = params.get("id");
  $("detailSearchInput").value = queryFromUrl(params);
  if (/^\d+$/.test(id || "")) {
    const data = await api(`/samples/${id}`); samples = [data.sample]; await selectSample(data.sample);
  } else {
    await lookupByQuery(queryFromInputs(), false);
  }
  if (params.get("autoClaim") === "true" && sample && !["sent", "completed", "void"].includes(sample.status)) { await afterRender(); $("stayHere").hidden = false; $("autoClaimMessage").textContent = "1.5 秒后自动领用并关闭"; autoClaimTimer = setTimeout(() => { autoClaimTimer = null; $("stayHere").hidden = true; $("autoClaimMessage").textContent = "正在自动领用…"; claimSample({ closeAfterClaim: true }); }, 1500); }
}
$("claimAndReturn").onclick = claimSample;
$("stayHere").onclick = () => {
  if (autoClaimTimer) clearTimeout(autoClaimTimer);
  autoClaimTimer = null;
  $("stayHere").hidden = true;
  $("autoClaimMessage").textContent = "已停留当前页";
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("autoClaim");
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
};
$("sampleTabs").onclick = (event) => {
  const tab = event.target.closest("[data-sample-id]");
  if (!tab) return;
  const next = samples.find((item) => item.id === tab.dataset.sampleId);
  selectSample(next).catch((error) => toast(error.message));
};
$("detailSearchForm").onsubmit = (event) => {
  event.preventDefault();
  lookupByQuery(queryFromInputs(), true).catch((error) => toast(error.message));
};
load().catch((error) => { toast(error.message); $("detailSearchPanel").hidden = false; $("detailTitle").textContent = error.message; setClaimState(); });
