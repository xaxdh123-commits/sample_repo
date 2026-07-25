const base = location.pathname.replace(/\/$/, "");
const apiBase = base.endsWith(".html") ? base.slice(0, base.lastIndexOf("/")) : base;
const $ = (id) => document.getElementById(id);
const labels = { draft: "草稿", printed: "打印", claimed: "领用", sent: "寄出", completed: "入库", void: "作废" };
const actionLabels = { create: "创建", update: "修改", status_change: "状态变更", print: "打印", reprint: "补打", image_add: "添加图片", image_delete: "删除图片", legacy_import: "历史导入" };
let state = { user: null, samples: [], shops: [], pendingFiles: [], listMode: "library", listSampleType: "label", page: 1, pageSize: 20, pages: 1, total: 0, canEdit: false };

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(message) { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => $("toast").classList.remove("show"), 2800); }
function has(permission) { const p = state.user?.permissions || []; return p.includes("*:*:*") || p.includes(permission) || (permission === "sample:view" && (p.includes("sample:edit") || p.includes("sample:admin"))) || (permission === "sample:edit" && p.includes("sample:admin")); }

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}/api${path}`, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.href = `https://auth.qiyinbz.com/?return_to=${encodeURIComponent(location.href.split("?")[0])}`; throw new Error("登录已失效"); }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function initializeAuth() {
  const url = new URL(location.href);
  const token = url.searchParams.get("token") || url.searchParams.get("Admin-Token");
  if (token) {
    await api("/auth/exchange", { method: "POST", body: JSON.stringify({ token }) });
    url.searchParams.delete("token"); url.searchParams.delete("Admin-Token");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const { user } = await api("/me");
  state.user = user; state.canEdit = has("sample:edit");
  $("userName").textContent = `${user.displayName}（${user.username}）`;
  $("creatorName").textContent = user.displayName || user.username || "";
  $("creatorPhone").textContent = user.phone || "-";
  document.querySelectorAll(".editor-only").forEach((element) => element.hidden = !state.canEdit);
  loadCurrentHoldingCount().catch(() => {});
}

async function loadCurrentHoldingCount() {
  const { holdings } = await api("/sample-holdings");
  const mine = holdings.find((item) => item.userId === state.user.id);
  $("currentHoldingCount").textContent = mine ? mine.total : 0;
  $("currentHoldingCount").hidden = false;
}

function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }
function switchSampleType(type) {
  const packaging = type === "packaging"; $("sampleType").value = packaging ? "packaging" : "label";
  document.querySelectorAll(".packaging-field").forEach((item) => { item.hidden = !packaging; });
  document.querySelectorAll(".label-fields").forEach((item) => { item.hidden = packaging; });
  document.querySelectorAll(".sample-tab").forEach((item) => item.classList.toggle("active", item.dataset.sampleType === type));
  $("customerFieldLabel").textContent = packaging ? "客人 ID" : "客户名";
}
function imageThumb(sample) { return sample.imageIds.length ? `<button class="thumb" data-image="${sample.imageIds[0]}"><img src="${apiBase}/api/images/${sample.imageIds[0]}" alt="样品图片"></button><small>${sample.imageCount} 张</small>` : `<span class="muted">无</span>`; }
function nextAction(sample) {
  if (!state.canEdit || ["void", "completed"].includes(sample.status)) return "";
  const next = sample.nextStatus;
  const send = sample.status === "printed" ? `<button data-status="${sample.id}" data-next="sent">寄出</button>` : "";
  return `${next && next !== "printed" ? `<button data-status="${sample.id}" data-next="${next}">${labels[next]}</button>` : ""}${send}<button class="danger" data-status="${sample.id}" data-next="void">作废</button>`;
}

function renderSamples() {
  $("rows").innerHTML = state.samples.length ? state.samples.map((sample) => `<tr class="status-${sample.status}">
    <td class="sticky-col code-col"><strong>${escapeHtml(sample.sampleCode)}</strong></td><td class="sticky-col image-col">${imageThumb(sample)}</td>
    <td>${escapeHtml(sample.plateNumber)}<br><span class="muted">${escapeHtml(sample.customerName)}</span></td>
    <td>${escapeHtml(sample.storeName)}<br><span class="muted">管理员：${escapeHtml(sample.ownerName)} ${escapeHtml(sample.ownerPhone)}</span></td>
    <td>${sample.sampleType === "packaging" ? "包装样品" : "标签样品"}</td>
    <td><span class="badge ${sample.status}">${labels[sample.status]}</span></td>
    <td>${escapeHtml(sample.updatedByName)}<br><span class="muted">${formatTime(sample.updatedAt)}</span></td>
    <td class="action-cell sticky-action"><div class="row-actions"><button class="ghost" data-detail="${sample.id}">详情</button>${state.canEdit && sample.status !== "void" ? `<button class="ghost" data-print="${sample.id}">${sample.status === "draft" ? "打印" : "补打"}</button>` : ""}${nextAction(sample)}</div></td>
  </tr>`).join("") : `<tr><td colspan="8" class="empty">没有找到样品</td></tr>`;
  state.pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("pageInfo").textContent = `第 ${state.page} / ${state.pages} 页，共 ${state.total} 条`;
  $("jumpPage").max = state.pages; $("jumpPage").value = state.page;
  $("first").disabled = $("prev").disabled = state.page <= 1; $("next").disabled = $("last").disabled = state.page >= state.pages;
}

async function loadSamples() {
  const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize, scope: state.listMode });
  if (state.listMode === "library") params.set("sampleType", state.listSampleType);
  if ($("query").value.trim()) params.set("q", $("query").value.trim());
  if ($("status").value) params.set("status", $("status").value);
  if ($("createdDate").value) params.set("createdDate", $("createdDate").value);
  const data = await api(`/samples?${params}`);
  Object.assign(state, { samples: data.samples, total: data.total }); renderSamples(); loadSampleCounts().catch(() => {});
}

async function loadSampleCounts() {
  const params = new URLSearchParams();
  if ($("query").value.trim()) params.set("q", $("query").value.trim());
  if ($("status").value) params.set("status", $("status").value);
  if ($("createdDate").value) params.set("createdDate", $("createdDate").value);
  const counts = await api(`/sample-counts?${params}`);
  $("draftCount").textContent = counts.draft;
  $("labelLibraryCount").textContent = counts.labelLibrary ?? 0;
  $("packagingLibraryCount").textContent = counts.packagingLibrary ?? 0;
  return counts;
}

async function applyDefaultDateFallback() {
  const params = new URLSearchParams({ fallback: "previousNonEmpty" });
  if ($("createdDate").value) params.set("createdDate", $("createdDate").value);
  const counts = await api(`/sample-counts?${params}`);
  if (counts.effectiveDate && counts.effectiveDate !== $("createdDate").value && Number(counts.total || 0) > 0) {
    $("createdDate").value = counts.effectiveDate;
    toast(`当天无数据，已切换到 ${counts.effectiveDate}`);
  }
  $("draftCount").textContent = counts.draft;
  $("labelLibraryCount").textContent = counts.labelLibrary ?? 0;
  $("packagingLibraryCount").textContent = counts.packagingLibrary ?? 0;
  return counts;
}

async function loadShops() {
  if (!state.canEdit) return;
  const data = await api("/shops");
  state.shops = data.shops;
  $("shopSuggestions").innerHTML = data.shops.map((shop) => `<option value="${escapeHtml(shop.shopName)}（${escapeHtml(shop.shopCode)}）">管理员：${escapeHtml(shop.storeManagerName || "未设置")}</option>`).join("");
}

async function loadNextCode() {
  if ($("sampleType").value === "packaging") {
    const data = await api("/next-code?sampleType=packaging");
    $("nextSampleCode").textContent = data.nextCode;
    return;
  }
  const selected = document.querySelector('input[name="envelopeType"]:checked');
  const data = await api(`/next-code?sampleType=label&envelopeType=${encodeURIComponent(selected?.value || "small")}`);
  $("nextSampleCode").textContent = data.nextCode;
}

function selectShopFromInput() {
  const value = $("shopSearch").value.trim();
  const shop = state.shops.find((item) => value === `${item.shopName}（${item.shopCode}）` || value === item.shopName || value === item.shopCode);
  $("erpShopId").value = shop?.id || "";
  $("ownerName").value = shop ? (shop.storeManagerName || "未设置管理员") : "";
  $("ownerPhone").value = shop ? `ID ${shop.storeManagerId || "-"} / ${shop.mobile || "无联系电话"}` : "";
  return shop;
}

async function showDetail(sample) {
  $("detailTitle").textContent = `${sample.sampleCode} · ${sample.customerName}`;
  const imageList = sample.imageIds.length ? `<div class="detail-images">${sample.imageIds.map((id) => `<span><button class="thumb" data-dialog-image="${id}"><img src="${apiBase}/api/images/${id}" alt="样品图片"></button>${state.canEdit && !["void", "completed"].includes(sample.status) ? `<button class="image-delete" data-delete-image="${id}">删除</button>` : ""}</span>`).join("")}</div>` : `<p class="muted">暂无图片</p>`;
  const changes = [[sample.contentChanged, "内容"], [sample.colorChanged, "颜色"], [sample.specificationChanged, "规格"], [sample.boxTypeChanged, "盒型"]].filter(([checked]) => checked).map(([, name]) => name).join("、") || "无";
  $("detailBody").innerHTML = `<dl><dt>样品类型</dt><dd>${sample.sampleType === "packaging" ? "包装样品" : "标签样品"}</dd><dt>版号</dt><dd>${escapeHtml(sample.plateNumber)}</dd><dt>客户名/ID</dt><dd>${escapeHtml(sample.customerName || "-")}</dd><dt>订单编号</dt><dd>${escapeHtml(sample.orderNumber || "-")}</dd><dt>店铺</dt><dd>${escapeHtml(sample.storeName)}</dd><dt>客服</dt><dd>${escapeHtml(sample.ownerName)} ${escapeHtml(sample.ownerPhone)}</dd><dt>样品类别</dt><dd>${escapeHtml(sample.sampleCategories.join("、") || "-")}</dd><dt>改动项目</dt><dd>${escapeHtml(changes)}</dd><dt>内容</dt><dd>${escapeHtml(sample.sampleContent || "-")}</dd><dt>规格</dt><dd>${escapeHtml(sample.sampleSpecification || "-")}</dd><dt>颜色</dt><dd>${escapeHtml(sample.sampleColor || "-")}</dd><dt>预留字段</dt><dd>${escapeHtml([sample.reservedField1, sample.reservedField2, sample.reservedField3].filter(Boolean).join(" / ") || "-")}</dd><dt>备注</dt><dd>${escapeHtml(sample.note)}</dd><dt>创建人</dt><dd>${escapeHtml(sample.createdByName)} ${escapeHtml(sample.createdByPhone || "")}</dd><dt>创建时间</dt><dd>${formatTime(sample.createdAt)}</dd><dt>最后更新</dt><dd>${escapeHtml(sample.updatedByName)} · ${formatTime(sample.updatedAt)}</dd></dl>${imageList}${state.canEdit && !["void", "completed"].includes(sample.status) ? `<label class="upload">添加图片<input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp"></label>` : ""}`;
  const data = await api(`/samples/${sample.id}/operations`);
  $("timeline").innerHTML = data.operations.map((op) => `<div><b>${actionLabels[op.action] || op.action}</b><span>${escapeHtml(op.operatorName)} · ${formatTime(op.operatedAt)}</span>${op.fromStatus || op.toStatus ? `<small>${labels[op.fromStatus] || ""}${op.toStatus && op.toStatus !== op.fromStatus ? ` → ${labels[op.toStatus]}` : ""}</small>` : ""}</div>`).join("");
  $("detailDialog").showModal();
  $("imageInput")?.addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast("图片不能超过 2MB");
    const imageData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    await api(`/samples/${sample.id}/images`, { method: "POST", body: JSON.stringify({ imageData }) });
    toast("图片已添加"); $("detailDialog").close(); await loadSamples();
  });
  $("detailBody").onclick = async (event) => {
    const preview = event.target.closest("[data-dialog-image]");
    if (preview) { $("largeImage").src = `${apiBase}/api/images/${preview.dataset.dialogImage}`; return $("imageDialog").showModal(); }
    const remove = event.target.closest("[data-delete-image]");
    if (remove && confirm("确定删除这张图片？")) {
      await api(`/images/${remove.dataset.deleteImage}`, { method: "DELETE", body: "{}" });
      toast("图片已删除"); $("detailDialog").close(); await loadSamples();
    }
  };
}

async function changeStatus(id, target) {
  const reason = target === "void" ? prompt("请输入作废原因") : "";
  if (target === "void" && !reason) return;
  await api(`/samples/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: target, reason }) });
  toast(`状态已更新为${labels[target]}`); await loadSamples();
}

async function renderPrint(sample) {
  const packaging = sample.sampleType === "packaging"; const width = packaging ? 75 : (Number($("printWidth").value) || 60); const height = packaging ? 124 : (Number($("printHeight").value) || 40); const scale = packaging ? 1 : (Number($("printScale").value) || 1);
  document.documentElement.style.setProperty("--print-width", `${width}mm`); document.documentElement.style.setProperty("--print-height", `${height}mm`); document.documentElement.style.setProperty("--print-scale", scale);
  const qr = `<img id="printQr" class="label-qr" src="${apiBase}/api/samples/${sample.id}/qrcode?autoClaim=true" alt="领用二维码">`;
  if (packaging) {
    const checkBox = (checked) => `<span class="print-check">${checked ? "☑" : "□"}</span>`;
    const category = (name, aliases = []) => `${checkBox([name, ...aliases].some((item) => sample.sampleCategories.includes(item)))}${name}`;
    const yesNo = (yes) => `${checkBox(yes)}是　${checkBox(!yes)}否`;
    const categories = [["彩盒类"], ["纸卡类"], ["十五栋印刷厂", ["十五懂印刷厂"]], ["纸袋"], ["色样"], ["礼盒"], ["内衬"], ["迈高礼盒厂"]];
    $("printArea").innerHTML = `<article class="label packaging-label print-full-packaging"><div class="packaging-head"><strong>包装样品单 · <span>${escapeHtml(sample.sampleCode)}</span></strong>${qr}</div><div class="form-line top-qr-line"><b>客人 ID：</b><span>${escapeHtml(sample.customerName)}</span></div><div class="form-line top-qr-line"><b>订单编号：</b><span>${escapeHtml(sample.orderNumber || "")}</span></div><div class="form-line"><b>店铺名称：</b><span>${escapeHtml(sample.storeName)}</span></div><div class="form-line"><b>管理员：</b><span>${escapeHtml(sample.ownerName)}　${escapeHtml(sample.ownerPhone)}</span></div><div class="form-line"><b>创建人：</b><span>${escapeHtml(sample.createdByName)}　${escapeHtml(sample.createdByPhone || "")}</span></div><div class="package-options">${categories.map(([name, aliases]) => `<span>${category(name, aliases)}</span>`).join("")}</div><div class="change-options"><span>内容改动 ${yesNo(sample.contentChanged)}</span><span>颜色改动 ${yesNo(sample.colorChanged)}</span><span>规格改动 ${yesNo(sample.specificationChanged)}</span><span>盒型改动 ${yesNo(sample.boxTypeChanged)}</span></div><div class="writing-block"><b>内容：</b><span>${escapeHtml(sample.sampleContent || "")}</span></div><div class="writing-block"><b>规格：</b><span>${escapeHtml(sample.sampleSpecification || "")}</span></div><div class="writing-block"><b>颜色：</b><span>${escapeHtml(sample.sampleColor || "")}</span></div><div class="writing-block"><b>备注：</b><span>${escapeHtml(sample.note || "")}</span></div></article>`;
  } else {
    $("printArea").innerHTML = `<article class="label print-full-label"><div class="label-number-row"><div class="label-number">${escapeHtml(sample.sampleCode)}</div>${qr}</div><div class="label-details"><div class="label-line label-line-plate"><b>版号：</b><span>${escapeHtml(sample.plateNumber)}</span></div><div class="label-line"><b>客户：</b><span>${escapeHtml(sample.customerName)}</span></div><div class="label-line"><b>店铺：</b><span>${escapeHtml(sample.storeName)}</span></div><div class="label-line"><b>管理员：</b><span>${escapeHtml(sample.ownerName)}</span></div><div class="label-line label-phone"><b>电话：</b><span>${escapeHtml(sample.ownerPhone)}</span></div><div class="label-line"><b>日期：</b><span>${new Date().toLocaleDateString("zh-CN")}</span></div><div class="label-line label-note wide"><b>备注：</b><span>${escapeHtml(sample.note || "-")}</span></div></div></article>`;
  }
  applyPrintTextFit();
  await new Promise((resolve) => { const image = $("printQr"); if (image.complete) resolve(); else { image.onload = resolve; image.onerror = resolve; } });
  window.print();
}

function fitFontValue(length, wide) {
  const limit = wide ? 18 : 8;
  if (length <= limit) return "";
  if (!wide) {
    if (length <= limit + 3) return "min(5.1vw,5.3vh)";
    if (length <= limit + 7) return "min(4.1vw,4.3vh)";
    if (length <= limit + 13) return "min(3vw,3.2vh)";
    if (length <= limit + 24) return "min(2.25vw,2.45vh)";
    return "min(1.75vw,1.95vh)";
  }
  if (length <= limit + 6) return "min(5.5vw,5.7vh)";
  if (length <= limit + 14) return "min(4.4vw,4.6vh)";
  if (length <= limit + 26) return "min(3.4vw,3.6vh)";
  return "min(2.9vw,3.1vh)";
}

function phoneFitFontValue(length) {
  if (length <= 14) return "";
  if (length <= 20) return "min(5.1vw,5.3vh)";
  if (length <= 28) return "min(3.65vw,3.85vh)";
  if (length <= 38) return "min(3vw,3.2vh)";
  return "min(2.45vw,2.65vh)";
}

function packagingFitFontValue(length, base = 5) {
  if (length <= 18) return "";
  if (length <= 28) return `${Math.min(base, 2.7)}mm`;
  if (length <= 42) return `${Math.min(base, 2.35)}mm`;
  if (length <= 64) return `${Math.min(base, 2)}mm`;
  return `${Math.min(base, 1.75)}mm`;
}

function setPrintFit(element, fontSize, lineHeight = "1.08") {
  if (!fontSize) return;
  element.style.setProperty("--fit-print-font-size", fontSize);
  element.style.setProperty("--fit-print-line-height", lineHeight);
  element.setAttribute("data-fit-font", "true");
}

function applyPrintTextFit() {
  const packaging = Boolean(document.querySelector("#printArea .print-full-packaging"));
  document.querySelectorAll("#printArea .label-line").forEach((line) => {
    if (line.classList.contains("label-note")) return;
    const text = (line.querySelector("span")?.textContent || "").trim();
    setPrintFit(line, line.classList.contains("label-phone") ? phoneFitFontValue(text.length) : fitFontValue(text.length, line.classList.contains("wide")));
  });
  document.querySelectorAll("#printArea .form-line").forEach((line) => {
    const text = (line.querySelector("span")?.textContent || "").trim();
    setPrintFit(line, packaging ? packagingFitFontValue(text.length, 3.25) : fitFontValue(text.length, true), "1.05");
  });
  document.querySelectorAll("#printArea .writing-block").forEach((block) => {
    const text = (block.querySelector("span")?.textContent || "").trim();
    if (text.length > 28) setPrintFit(block, packaging ? packagingFitFontValue(text.length, 2.95) : (text.length > 60 ? "min(2.8vw,3vh)" : "min(3.5vw,3.7vh)"), "1.12");
  });
}

function fileDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
function renderPendingImages() { $("imagePreview").className = state.pendingFiles.length ? "image-preview-list" : "muted"; $("imagePreview").innerHTML = state.pendingFiles.length ? state.pendingFiles.map((file) => `<span title="${escapeHtml(file.name)}"><img src="${URL.createObjectURL(file)}" alt="待上传图片"></span>`).join("") : "选择、拖入或粘贴图片（最多 12 张）"; }
function addPendingFiles(files) { const images = [...files].filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type)); for (const file of images) { if (state.pendingFiles.length >= 12) break; if (file.size > 2 * 1024 * 1024) { toast(`${file.name} 超过 2MB`); continue; } state.pendingFiles.push(file); } renderPendingImages(); }
function resetSampleForm() { const type = $("sampleType").value; const print = { width: $("printWidth").value, height: $("printHeight").value, scale: $("printScale").value }; $("sampleForm").reset(); $("sampleType").value = type; $("printWidth").value = print.width; $("printHeight").value = print.height; $("printScale").value = print.scale; state.pendingFiles = []; renderPendingImages(); switchSampleType(type); loadNextCode().catch((e) => toast(e.message)); }
async function submitSample(printAfter) {
  const form = $("sampleForm"); if (!selectShopFromInput()) { toast("请从联想列表中选择店铺"); $("shopSearch").focus(); return; } if (!form.reportValidity()) return;
  const data = new FormData(form); const body = Object.fromEntries(data); body.sampleCategories = data.getAll("sampleCategories");
  if (!String(body.orderNumber || "").trim() && !String(body.plateNumber || "").trim()) { toast("请填写订单号或版号"); form.elements.plateNumber.focus(); return; }
  const files = [...state.pendingFiles];
  try {
    const result = await api("/samples", { method: "POST", body: JSON.stringify(body) });
    for (const file of files) { if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} 超过 2MB`); await api(`/samples/${result.id}/images`, { method: "POST", body: JSON.stringify({ imageData: await fileDataUrl(file) }) }); }
    if (printAfter) { const { sample } = await api(`/samples/${result.id}`); await api(`/samples/${result.id}/print`, { method: "POST", body: "{}" }); await renderPrint(sample); }
    await loadSamples();
    resetSampleForm(); toast(`已创建 ${result.code}`);
  } catch (e) { toast(e.message); }
}
$("sampleForm").addEventListener("submit", (event) => { event.preventDefault(); submitSample(false); });
$("shopSearch").addEventListener("input", selectShopFromInput);
$("shopSearch").addEventListener("change", selectShopFromInput);
document.querySelectorAll(".sample-tab").forEach((tab) => tab.addEventListener("click", () => {
  switchSampleType(tab.dataset.sampleType);
  loadNextCode().catch((e) => toast(e.message));
}));
document.querySelectorAll(".library-tab").forEach((tab) => tab.addEventListener("click", () => {
  state.listMode = tab.dataset.listMode;
  if (tab.dataset.listSampleType) state.listSampleType = tab.dataset.listSampleType;
  state.page = 1;
  document.querySelectorAll(".library-tab").forEach((item) => item.classList.toggle("active", item === tab));
  $("status").value = "";
  $("status").disabled = state.listMode === "draft";
  loadSamples().catch((e) => toast(e.message));
}));
document.querySelectorAll('input[name="envelopeType"]').forEach((checkbox) => checkbox.addEventListener("change", () => { if (checkbox.checked) document.querySelectorAll('input[name="envelopeType"]').forEach((other) => { if (other !== checkbox) other.checked = false; }); else checkbox.checked = true; loadNextCode().catch((e) => toast(e.message)); }));
$("sampleImages").addEventListener("change", () => { addPendingFiles($("sampleImages").files); $("sampleImages").value = ""; });
const dropZone = $("imageDropZone");
["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); }));
["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); }));
dropZone.addEventListener("drop", (event) => addPendingFiles(event.dataTransfer.files));
document.addEventListener("paste", (event) => { if ($("sampleForm").hidden) return; const files = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); addPendingFiles(files); } });
$("pasteImages").onclick = async () => { try { if (!navigator.clipboard?.read) throw new Error(); const items = await navigator.clipboard.read(); const files = []; for (const item of items) for (const type of item.types.filter((value) => value.startsWith("image/"))) files.push(new File([await item.getType(type)], `粘贴图片-${Date.now()}.${type.split("/")[1]}`, { type })); addPendingFiles(files); } catch { toast("请复制图片后按 Ctrl+V 粘贴"); } };
$("clearImages").onclick = () => { state.pendingFiles = []; $("sampleImages").value = ""; renderPendingImages(); };
$("clearForm").onclick = resetSampleForm;
$("saveAndPrint").onclick = () => submitSample(true);
$("savePrintSize").onclick = () => { localStorage.setItem("samplePrintSettings", JSON.stringify({ width: $("printWidth").value, height: $("printHeight").value, scale: $("printScale").value })); toast("打印规格已保存"); };
$("rows").addEventListener("click", async (event) => { try { const image = event.target.closest("[data-image]"); if (image) { $("largeImage").src = `${apiBase}/api/images/${image.dataset.image}`; return $("imageDialog").showModal(); } const detail = event.target.closest("[data-detail]"); if (detail) { location.href = `./detail.html?id=${encodeURIComponent(detail.dataset.detail)}`; return; } const status = event.target.closest("[data-status]"); if (status) return changeStatus(status.dataset.status, status.dataset.next); const print = event.target.closest("[data-print]"); if (print) { const sample = state.samples.find((s) => s.id === print.dataset.print); await api(`/samples/${sample.id}/${sample.status === "draft" ? "print" : "reprint"}`, { method: "POST", body: "{}" }); await renderPrint(sample); await loadSamples(); } } catch (e) { toast(e.message); } });
$("search").onclick = () => { state.page = 1; loadSamples().catch((e) => toast(e.message)); }; $("refresh").onclick = () => loadSamples().catch((e) => toast(e.message));
$("query").addEventListener("keydown", (e) => { if (e.key === "Enter") $("search").click(); });
$("first").onclick = () => { state.page = 1; loadSamples(); }; $("prev").onclick = () => { state.page = Math.max(1, state.page - 1); loadSamples(); }; $("next").onclick = () => { state.page = Math.min(state.pages, state.page + 1); loadSamples(); }; $("last").onclick = () => { state.page = state.pages; loadSamples(); };
$("pageSize").onchange = () => { state.pageSize = Number($("pageSize").value); state.page = 1; loadSamples().catch((e) => toast(e.message)); };
$("jump").onclick = () => { state.page = Math.min(state.pages, Math.max(1, Number($("jumpPage").value) || 1)); loadSamples().catch((e) => toast(e.message)); };
$("jumpPage").addEventListener("keydown", (event) => { if (event.key === "Enter") $("jump").click(); });
$("closeDetail").onclick = () => $("detailDialog").close(); $("closeImage").onclick = () => $("imageDialog").close();
$("openGuide").onclick = () => $("guideDialog").showModal(); $("closeGuide").onclick = () => $("guideDialog").close();
function setFormCollapsed(collapsed) { $("sampleForm").hidden = collapsed; $("createPanel").classList.toggle("collapsed", collapsed); $("toggleForm").textContent = collapsed ? "展开" : "收起"; }
$("toggleForm").onclick = (event) => { event.stopPropagation(); setFormCollapsed(!$("sampleForm").hidden); };
$("createPanel").addEventListener("click", () => { if ($("sampleForm").hidden) setFormCollapsed(false); });
$("logout").onclick = async () => { await api("/logout", { method: "POST", body: "{}" }); location.reload(); };

(async () => { try { $("createdDate").value = new Date().toLocaleDateString("sv-SE"); const saved = JSON.parse(localStorage.getItem("samplePrintSettings") || "null"); if (saved) { $("printWidth").value = saved.width || 60; $("printHeight").value = saved.height || 40; $("printScale").value = saved.scale || 1; } switchSampleType("label"); renderPendingImages(); await initializeAuth(); await applyDefaultDateFallback(); await Promise.all([loadSamples(), loadShops(), loadNextCode()]); } catch (error) { toast(error.message); } })();
