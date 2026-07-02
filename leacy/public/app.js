const PRINT_SETTINGS_KEY = "samplePrintSettingsV1";
const DEFAULT_PRINT_SETTINGS = {
  width: 60,
  height: 40,
  scale: 1.5
};
const PRINT_DETAIL_ROWS = 3;
const PRINT_FONT_BOOST = 2;
const ENVELOPE_PREFIXES = {
  small: "A",
  large: "B",
  none: "C"
};
const LIBRARY_PAGE_SIZE = 20;

const state = {
  samples: [],
  libraryPage: 1,
  libraryPageSize: LIBRARY_PAGE_SIZE,
  libraryPageCount: 1,
  libraryTotal: 0,
  libraryRequestId: 0,
  adminSamples: [],
  owners: [],
  users: [],
  token: sessionStorage.getItem("sampleAuthToken") || "",
  user: null,
  pendingView: "",
  nextNumber: null,
  nextNumbers: {},
  images: [],
  imageUploadSampleId: "",
  selectedPrintIds: new Set(),
  editingOwnerId: "",
  printSettings: readPrintSettings()
};

const $ = (id) => document.getElementById(id);

const fields = {
  plateNumber: $("plateNumber"),
  customerName: $("customerName"),
  storeName: $("storeName"),
  storeList: $("storeList"),
  ownerName: $("ownerName"),
  ownerPhone: $("ownerPhone"),
  note: $("note"),
  searchInput: $("searchInput"),
  adminDate: $("adminDate"),
  backupFile: $("backupFile"),
  loginUsername: $("loginUsername"),
  entryPassword: $("entryPassword"),
  sampleImage: $("sampleImage"),
  recordImageFile: $("recordImageFile"),
  newOwnerName: $("newOwnerName"),
  newOwnerPhone: $("newOwnerPhone"),
  newOwnerStores: $("newOwnerStores"),
  accountUsername: $("accountUsername"),
  accountDisplayName: $("accountDisplayName"),
  accountPassword: $("accountPassword"),
  accountRole: $("accountRole"),
  printWidth: $("printWidth"),
  printHeight: $("printHeight"),
  printScale: $("printScale")
};

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayDateValue() {
  return formatDate(new Date());
}

function normalizeEnvelopeType(value) {
  if (value === "large") return "large";
  if (value === "none") return "none";
  return "small";
}

function currentEnvelopeType() {
  const checked = document.querySelector('input[name="envelopeType"]:checked');
  return normalizeEnvelopeType(checked ? checked.value : "small");
}

function envelopePrefix(type) {
  return ENVELOPE_PREFIXES[normalizeEnvelopeType(type)] || "A";
}

function formatEnvelopeCode(number, type = currentEnvelopeType()) {
  return `${envelopePrefix(type)}${String(number).padStart(4, "0")}`;
}

function formatSampleCode(sample) {
  return sample.sampleCode || formatEnvelopeCode(sample.sampleNumber, sample.envelopeType);
}

function renderNextNumber() {
  const type = currentEnvelopeType();
  const nextNumber = state.nextNumbers[type] ?? state.nextNumber;
  $("nextNumber").textContent = Number.isInteger(Number(nextNumber))
    ? formatEnvelopeCode(Number(nextNumber), type)
    : "----";
}

function setNextNumber(data) {
  if (data?.nextNumbers && typeof data.nextNumbers === "object") {
    ["small", "large", "none"].forEach((type) => {
      if (Number.isInteger(Number(data.nextNumbers[type]))) {
        state.nextNumbers[type] = Number(data.nextNumbers[type]);
      }
    });
  }

  if (Number.isInteger(Number(data?.nextNumber))) {
    state.nextNumber = Number(data.nextNumber);
    const type = normalizeEnvelopeType(data.envelopeType || currentEnvelopeType());
    if (!Number.isInteger(Number(state.nextNumbers[type]))) {
      state.nextNumbers[type] = state.nextNumber;
    }
  }
  renderNextNumber();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number * 10) / 10));
}

function normalizePrintSettings(settings = {}) {
  return {
    width: clampNumber(settings.width, 20, 200, DEFAULT_PRINT_SETTINGS.width),
    height: clampNumber(settings.height, 15, 150, DEFAULT_PRINT_SETTINGS.height),
    scale: clampNumber(settings.scale, 1, 2.5, DEFAULT_PRINT_SETTINGS.scale)
  };
}

function readPrintSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRINT_SETTINGS_KEY) || "{}");
    return normalizePrintSettings(saved);
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

function savePrintSettings(settings) {
  state.printSettings = normalizePrintSettings(settings);
  localStorage.setItem(PRINT_SETTINGS_KEY, JSON.stringify(state.printSettings));
  applyPrintSettings();
  renderPrintSettings();
}

function printMetrics(settings, detailRows = PRINT_DETAIL_ROWS, fontBoost = 1) {
  const width = settings.width;
  const height = settings.height;
  const scale = settings.scale;
  const rows = Math.max(1, detailRows);
  const boost = Math.max(1, Number(fontBoost) || 1);
  const padX = clampNumber(width * (0.03 / scale), 0.8, 3.2, 1.5);
  const padY = clampNumber(height * (0.04 / scale), 0.6, 2.2, 1.1);
  const usableHeight = Math.max(10, height - padY * 2);
  const detailTop = clampNumber(height * (0.025 / scale), 0.6, 1.4, 0.8);
  const detailGap = clampNumber(height * (0.02 / scale), 0.45, 1, 0.7);
  const rowPenalty = Math.max(0, rows - PRINT_DETAIL_ROWS) * 0.06;
  const numberShare = clampNumber(0.5 + (scale - 1) * 0.08 - rowPenalty, 0.3, 0.62, 0.54);
  const numberLine = clampNumber(usableHeight * numberShare, 9, usableHeight * 0.66, 20);
  const detailHeight = Math.max(8, usableHeight - numberLine - detailTop);
  const lineHeight = clampNumber((detailHeight - detailGap * (rows - 1)) / rows, 3.2, 8.8, 7.2);
  const lineFont = clampNumber(lineHeight * (0.88 + (scale - 1) * 0.02), 3.2, 8.2, 6.8);
  const numberSize = clampNumber(Math.min(width * 0.42, numberLine * 1.18), 10, 42, 23);
  return {
    padX,
    padY,
    detailTop: detailTop * boost,
    detailGap: detailGap * boost,
    numberSize: numberSize * boost,
    numberLine: numberLine * boost,
    lineHeight: lineHeight * boost,
    lineFont: lineFont * boost
  };
}

function applyPrintMetricVars(metrics) {
  const root = document.documentElement;
  root.style.setProperty("--print-pad-x", `${metrics.padX}mm`);
  root.style.setProperty("--print-pad-y", `${metrics.padY}mm`);
  root.style.setProperty("--print-detail-top", `${metrics.detailTop}mm`);
  root.style.setProperty("--print-detail-gap", `${metrics.detailGap}mm`);
  root.style.setProperty("--print-number-size", `${metrics.numberSize}mm`);
  root.style.setProperty("--print-number-line", `${metrics.numberLine}mm`);
  root.style.setProperty("--print-line-height", `${metrics.lineHeight}mm`);
  root.style.setProperty("--print-line-font", `${metrics.lineFont}mm`);
}

function applyPrintSettings() {
  const settings = normalizePrintSettings(state.printSettings);
  const root = document.documentElement;
  root.style.setProperty("--print-width", `${settings.width}mm`);
  root.style.setProperty("--print-height", `${settings.height}mm`);
  applyPrintMetricVars(printMetrics(settings));
  root.style.setProperty("--print-content-scale", settings.scale);

  let style = document.getElementById("dynamicPrintSize");
  if (!style) {
    style = document.createElement("style");
    style.id = "dynamicPrintSize";
    document.head.appendChild(style);
  }
  style.textContent = `
    @media print {
      @page { margin: 0 !important; }
      html, body {
        width: 100vw !important;
        min-height: 100vh !important;
        height: auto !important;
        overflow: visible !important;
      }
      #printArea {
        width: 100vw !important;
        min-height: 100vh !important;
        height: auto !important;
        overflow: visible !important;
      }
      .label {
        width: 100vw !important;
        height: 100vh !important;
      }
    }
  `;
}

function renderPrintSettings() {
  const settings = normalizePrintSettings(state.printSettings);
  fields.printWidth.value = settings.width;
  fields.printHeight.value = settings.height;
  fields.printScale.value = settings.scale;
  $("printSizeSummary").textContent = `当前规格 ${settings.width} x ${settings.height} mm，内容 ${settings.scale}x`;
}

function savePrintSettingsFromInputs(showMessage = true) {
  const nextSettings = normalizePrintSettings({
    width: fields.printWidth.value,
    height: fields.printHeight.value,
    scale: fields.printScale.value
  });
  savePrintSettings(nextSettings);
  if (showMessage) {
    showToast(`打印规格已保存：${nextSettings.width} x ${nextSettings.height} mm，内容 ${nextSettings.scale}x`);
  }
}

function roleText(role) {
  return role === "admin" ? "管理员" : "编辑账号";
}

function statusText(sample) {
  return sample.status === "void" ? "作废" : "有效";
}

function registrarText(sample) {
  return sample.registrarName || sample.createdByName || sample.createdByUsername || "未记录";
}

function isLoggedIn() {
  return Boolean(state.token && state.user);
}

function isAdmin() {
  return state.user && state.user.role === "admin";
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function refreshAuthUi() {
  $("currentUser").textContent = state.user
    ? `${state.user.displayName || state.user.username}（${roleText(state.user.role)}）`
    : "游客查询";
  $("logoutButton").hidden = !state.user;
  $("config").hidden = !isAdmin();
  document.querySelectorAll("[data-admin-only]").forEach((element) => {
    element.hidden = !isAdmin();
  });
}

function showPasswordModal() {
  $("passwordModal").hidden = false;
  if (!fields.loginUsername.value) fields.loginUsername.value = "admin";
  fields.entryPassword.value = "";
  window.setTimeout(() => fields.loginUsername.focus(), 0);
}

function hidePasswordModal() {
  $("passwordModal").hidden = true;
  fields.entryPassword.value = "";
}

function showView(view) {
  document.querySelectorAll("[data-view]").forEach((section) => {
    section.classList.toggle("active", section.dataset.view === view);
  });
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    const active = link.dataset.viewLink === view;
    link.classList.toggle("active", active);
    link.setAttribute("aria-current", active ? "page" : "false");
  });
  const subtitles = {
    entry: "已登录账号可以录入样品、打印标签、补打或作废编号。",
    config: "管理员可以维护系统配置、账号权限和密码。",
    library: "默认进入样品库查询，游客无需账号，只能查看和检索。"
  };
  $("pageSubtitle").textContent = subtitles[view] || subtitles.library;

  if (view === "library") {
    fields.searchInput.focus();
  } else if (view === "entry") {
    fields.plateNumber.focus();
  } else if (view === "config") {
    fields.accountUsername.focus();
  }
}

function routeFromHash() {
  const requestedHash = location.hash.replace("#", "");
  const requestedView = ["entry", "config"].includes(requestedHash) ? requestedHash : "library";
  if (requestedView !== "library" && !isLoggedIn()) {
    state.pendingView = requestedView;
    history.replaceState(null, "", "#library");
    showView("library");
    showPasswordModal();
    return;
  }
  if (requestedView === "config" && !isAdmin()) {
    history.replaceState(null, "", "#library");
    showView("library");
    showToast("只有管理员账号可以进入配置页");
    return;
  }
  showView(requestedView);
  if (requestedView === "entry") {
    refreshEntryData().catch((error) => showToast(error.message));
  } else if (requestedView === "config") {
    loadUsers().catch((error) => showToast(error.message));
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function restoreSession() {
  if (!state.token) {
    refreshAuthUi();
    return;
  }

  try {
    const data = await api("/api/me", { headers: authHeaders() });
    state.user = data.user;
  } catch {
    state.token = "";
    state.user = null;
    sessionStorage.removeItem("sampleAuthToken");
  }
  refreshAuthUi();
}

async function loginAccount() {
  const username = fields.loginUsername.value.trim();
  const password = fields.entryPassword.value;
  if (!username || !password) {
    showToast("请输入账号和密码");
    return;
  }

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    state.token = data.token;
    state.user = data.user;
    sessionStorage.setItem("sampleAuthToken", state.token);
    refreshAuthUi();
    hidePasswordModal();
    let nextView = state.pendingView || "entry";
    state.pendingView = "";
    if (nextView === "config" && !isAdmin()) {
      nextView = "library";
      showToast("只有管理员账号可以进入配置页");
    }
    if (nextView === "entry") {
      await refreshEntryData();
    } else if (nextView === "config") {
      await loadUsers();
    }
    location.hash = `#${nextView}`;
    showView(nextView);
  } catch (error) {
    state.token = "";
    state.user = null;
    sessionStorage.removeItem("sampleAuthToken");
    showToast(error.message || "账号或密码不正确");
    fields.entryPassword.focus();
  }
}

async function logoutAccount() {
  if (state.token) {
    await fetch("/api/logout", {
      method: "POST",
      headers: authHeaders()
    }).catch(() => {});
  }
  state.token = "";
  state.user = null;
  state.pendingView = "";
  state.owners = [];
  state.users = [];
  sessionStorage.removeItem("sampleAuthToken");
  refreshAuthUi();
  history.replaceState(null, "", "#library");
  showView("library");
}

async function refreshEntryData() {
  if (!isLoggedIn()) return;
  await Promise.all([
    loadOwners(),
    refreshNextNumber(),
    loadAdminSamples(),
    isAdmin() ? loadUsers() : Promise.resolve()
  ]);
}

async function refreshNextNumber() {
  const data = await api("/api/next-number", { headers: authHeaders() });
  setNextNumber(data);
}

function splitStores(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  const seen = new Set();
  return source
    .map((item) => String(item || "").trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function ownerStores(owner) {
  return splitStores(owner?.stores || []);
}

function allStoreNames() {
  const seen = new Set();
  return state.owners
    .flatMap(ownerStores)
    .filter((store) => {
      const key = store.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function findOwnerByStoreName(storeName) {
  const key = String(storeName || "").trim().toLowerCase();
  if (!key) return null;
  return state.owners.find((owner) => ownerStores(owner).some((store) => store.toLowerCase() === key)) || null;
}

function renderStoreOptions() {
  if (!fields.storeList) return;
  fields.storeList.innerHTML = allStoreNames()
    .map((store) => `<option value="${escapeHtml(store)}"></option>`)
    .join("");
}

function syncOwnerFromStore() {
  const owner = findOwnerByStoreName(fields.storeName.value);
  if (!owner) return false;
  fields.ownerName.value = owner.id;
  syncOwnerPhone();
  return true;
}

async function loadOwners() {
  const data = await api("/api/owners", { headers: authHeaders() });
  state.owners = data.owners || [];
  renderOwnerOptions();
  renderOwnerRows();
  renderStoreOptions();
}

function renderOwnerOptions(selectedId = fields.ownerName.value) {
  const options = [
    `<option value="">请选择店铺负责人</option>`,
    ...state.owners.map((owner) => (
      `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)}</option>`
    )),
    `<option value="__add__">新增店铺负责人...</option>`
  ];
  fields.ownerName.innerHTML = options.join("");
  fields.ownerName.value = selectedId && state.owners.some((owner) => owner.id === selectedId) ? selectedId : "";
  syncOwnerPhone();
}

function renderOwnerRows() {
  const rows = $("ownerRows");
  if (!rows) return;
  if (!state.owners.length) {
    rows.innerHTML = `<div class="owner-empty muted">暂无店铺负责人</div>`;
    return;
  }
  rows.innerHTML = state.owners
    .map(
      (owner) => {
        const stores = ownerStores(owner);
        const storeTags = stores.length
          ? stores.map((store) => `<span class="owner-store-tag">${escapeHtml(store)}</span>`).join("")
          : `<span class="owner-store-empty">未绑定店铺</span>`;
        return `
        <div class="owner-row">
          <div>
            <strong>${escapeHtml(owner.name)}</strong>
            <span class="owner-phone">${escapeHtml(owner.phone)}</span>
            <div class="owner-store-tags">${storeTags}</div>
          </div>
          <div class="owner-row-actions">
            <button type="button" class="secondary owner-edit" data-owner-edit="${escapeHtml(owner.id)}">编辑</button>
            <button type="button" class="danger owner-delete" data-owner-delete="${escapeHtml(owner.id)}">删除</button>
          </div>
        </div>
      `;
      }
    )
    .join("");
}

function selectedOwner() {
  return state.owners.find((owner) => owner.id === fields.ownerName.value);
}

function syncOwnerPhone() {
  const owner = selectedOwner();
  fields.ownerPhone.value = owner ? owner.phone : "";
}

function showOwnerModal(ownerId = "") {
  const owner = state.owners.find((item) => item.id === ownerId);
  state.editingOwnerId = owner ? owner.id : "";
  $("ownerModal").hidden = false;
  $("ownerTitle").textContent = owner ? "编辑店铺负责人" : "新增店铺负责人";
  $("saveOwner").textContent = owner ? "保存修改" : "保存";
  fields.newOwnerName.value = owner ? owner.name : "";
  fields.newOwnerPhone.value = owner ? owner.phone : "";
  fields.newOwnerStores.value = owner ? ownerStores(owner).join("\n") : "";
  renderOwnerRows();
  window.setTimeout(() => fields.newOwnerName.focus(), 0);
}

function hideOwnerModal() {
  $("ownerModal").hidden = true;
  state.editingOwnerId = "";
  $("ownerTitle").textContent = "新增店铺负责人";
  $("saveOwner").textContent = "保存";
  fields.newOwnerName.value = "";
  fields.newOwnerPhone.value = "";
  fields.newOwnerStores.value = "";
}

async function saveNewOwner() {
  const name = fields.newOwnerName.value.trim();
  const phone = fields.newOwnerPhone.value.trim();
  const stores = splitStores(fields.newOwnerStores.value);
  if (!name || !phone) {
    showToast("请填写店铺负责人姓名和号码");
    return;
  }

  const ownerId = state.editingOwnerId;
  const data = await api(ownerId ? `/api/owners/${encodeURIComponent(ownerId)}` : "/api/owners", {
    method: ownerId ? "PATCH" : "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, phone, stores })
  });
  state.owners = data.owners || [];
  renderOwnerOptions(data.owner.id);
  renderOwnerRows();
  renderStoreOptions();
  hideOwnerModal();
  showToast(`${ownerId ? "已更新" : "已保存"}店铺负责人 ${data.owner.name}`);
}

async function deleteOwner(ownerId) {
  const owner = state.owners.find((item) => item.id === ownerId);
  if (!owner) return;
  const adminPassword = window.prompt(`删除店铺负责人「${owner.name}」需要输入管理员密码：`);
  if (adminPassword === null) return;
  if (!adminPassword.trim()) {
    showToast("请输入管理员密码");
    return;
  }

  const data = await api(`/api/owners/${encodeURIComponent(ownerId)}`, {
    method: "DELETE",
    headers: authHeaders(),
    body: JSON.stringify({ adminPassword })
  });
  state.owners = data.owners || [];
  renderOwnerOptions(fields.ownerName.value === ownerId ? "" : fields.ownerName.value);
  renderOwnerRows();
  renderStoreOptions();
  showToast(`已删除店铺负责人 ${owner.name}`);
}

async function loadSamples({ page = state.libraryPage } = {}) {
  const requestId = ++state.libraryRequestId;
  const params = new URLSearchParams({
    q: fields.searchInput.value.trim(),
    page: String(page),
    pageSize: String(LIBRARY_PAGE_SIZE)
  });
  const data = await api(`/api/samples?${params.toString()}`);
  if (requestId !== state.libraryRequestId) return;
  state.samples = data.samples || [];
  state.libraryPage = Number(data.page) || 1;
  state.libraryPageSize = Number(data.pageSize) || LIBRARY_PAGE_SIZE;
  state.libraryPageCount = Number(data.pageCount) || 1;
  state.libraryTotal = Number(data.total) || 0;
  renderLibraryRows();
  renderLibraryPagination();
  if (!isLoggedIn()) renderAdminRows();
}

async function loadAdminSamples() {
  if (!isLoggedIn()) return;
  if (!fields.adminDate.value) fields.adminDate.value = todayDateValue();
  const params = new URLSearchParams({ limit: "5000" });
  params.set("date", fields.adminDate.value);
  const data = await api(`/api/samples?${params.toString()}`);
  state.adminSamples = data.samples;
  renderAdminRows();
}

function sampleImages(sample) {
  if (!sample) return [];
  const source = Array.isArray(sample.images) && sample.images.length
    ? sample.images
    : [sample.imageData];
  return source.filter(Boolean);
}

function printableSamples(samples = state.adminSamples) {
  return samples.filter((sample) => sample.status !== "void");
}

function selectedPrintIdsFromDom() {
  return new Set(
    Array.from(document.querySelectorAll("#adminRows [data-select-print]:checked"))
      .map((checkbox) => checkbox.dataset.selectPrint)
      .filter(Boolean)
  );
}

function selectedPrintSamples() {
  const ids = new Set(state.selectedPrintIds);
  selectedPrintIdsFromDom().forEach((id) => ids.add(id));
  return printableSamples(state.adminSamples).filter((sample) => ids.has(sample.id));
}

function syncPrintSelection() {
  const visiblePrintableIds = new Set(printableSamples(state.adminSamples).map((sample) => sample.id));
  state.selectedPrintIds.forEach((id) => {
    if (!visiblePrintableIds.has(id)) state.selectedPrintIds.delete(id);
  });
}

function renderBatchPrintState() {
  const selectedCount = selectedPrintSamples().length;
  const printableCount = printableSamples(state.adminSamples).length;
  const batchButton = $("batchPrint");
  const summary = $("batchPrintSummary");
  const selectAll = $("selectAllPrint");
  if (batchButton) batchButton.disabled = selectedCount === 0;
  if (summary) summary.textContent = selectedCount ? `已选 ${selectedCount} 条` : "未选择";
  if (selectAll) {
    selectAll.checked = printableCount > 0 && selectedCount === printableCount;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < printableCount;
    selectAll.disabled = printableCount === 0;
  }
}

function imageCell(sample, options = {}) {
  const images = sampleImages(sample);
  if (!images.length) {
    if (options.allowImageUpload && sample.status !== "void") {
      return `<button type="button" class="secondary" data-upload-image="${escapeHtml(sample.id)}">补图</button>`;
    }
    return `<span class="muted">无</span>`;
  }
  return `
    <button type="button" class="thumb-button" data-image="${escapeHtml(sample.id)}" title="查看图片">
      <img src="${escapeHtml(images[0])}" alt="样品图片" />
      ${images.length > 1 ? `<span>${images.length}</span>` : ""}
    </button>
  `;
}

function sampleCells(sample, options = {}) {
  return `
    <td class="sample-code-cell">${escapeHtml(formatSampleCode(sample))}</td>
    <td>${imageCell(sample, options)}</td>
    <td>${escapeHtml(sample.plateNumber)}</td>
    <td>${escapeHtml(sample.customerName)}</td>
    <td>${escapeHtml(sample.storeName || "")}</td>
    <td>${escapeHtml(sample.ownerName)}</td>
    <td>${escapeHtml(sample.ownerPhone)}</td>
    <td>${escapeHtml(formatDate(sample.createdAt))}</td>
    <td>${escapeHtml(sample.note || sample.voidReason || "")}</td>
    <td><span class="status ${sample.status === "void" ? "status-void" : "status-active"}">${statusText(sample)}</span></td>
  `;
}

function renderRows() {
  renderLibraryRows();
  renderAdminRows();
}

function renderLibraryRows() {
  const libraryRows = $("libraryRows");

  if (!state.samples.length) {
    libraryRows.innerHTML = `<tr><td colspan="10" class="muted">没有找到记录</td></tr>`;
    return;
  }

  libraryRows.innerHTML = state.samples
    .map((sample) => `<tr class="${sample.status === "void" ? "void-row" : ""}">${sampleCells(sample)}</tr>`)
    .join("");
}

function renderLibraryPagination() {
  const total = state.libraryTotal;
  const page = state.libraryPage;
  const pageSize = state.libraryPageSize;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(page * pageSize, total) : 0;
  $("libraryPageSummary").textContent = total
    ? `共 ${total} 条，当前显示 ${start}-${end} 条`
    : "共 0 条";
  $("libraryPageLabel").textContent = `第 ${page} / ${state.libraryPageCount} 页`;
  $("libraryPrevPage").disabled = page <= 1;
  $("libraryNextPage").disabled = page >= state.libraryPageCount;
}

function renderAdminRows() {
  const adminRows = $("adminRows");
  const adminSamples = isLoggedIn() ? state.adminSamples : state.samples;
  syncPrintSelection();
  renderBatchPrintState();

  if (!adminSamples.length) {
    adminRows.innerHTML = `<tr><td colspan="13" class="muted">没有找到记录</td></tr>`;
    return;
  }

  adminRows.innerHTML = adminSamples
    .map(
      (sample) => `
        <tr class="${sample.status === "void" ? "void-row" : ""}">
          <td class="select-column">
            <input
              type="checkbox"
              data-select-print="${escapeHtml(sample.id)}"
              aria-label="选择补打 ${escapeHtml(formatSampleCode(sample))}"
              ${state.selectedPrintIds.has(sample.id) ? "checked" : ""}
              ${sample.status === "void" ? "disabled" : ""}
            />
          </td>
          ${sampleCells(sample, { allowImageUpload: isLoggedIn() })}
          <td>${escapeHtml(registrarText(sample))}</td>
          <td>
            <button type="button" class="secondary" data-print="${escapeHtml(sample.id)}" ${sample.status === "void" ? "disabled" : ""}>补打</button>
            <button type="button" class="danger" data-void="${escapeHtml(sample.id)}" ${sample.status === "void" ? "disabled" : ""}>作废</button>
            ${isAdmin() && sample.status === "void" ? `<button type="button" class="danger" data-delete-void="${escapeHtml(sample.id)}">删除</button>` : ""}
          </td>
        </tr>
      `
    )
    .join("");
}

function findSampleById(id) {
  return [...state.samples, ...state.adminSamples].find((item) => item.id === id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件"));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式不支持"));
      img.onload = () => {
        const maxSize = 720;
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.76));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addImageFromFile(file) {
  const imageData = await resizeImage(file);
  if (!state.images.includes(imageData)) state.images.push(imageData);
}

async function imageListFromFiles(files, maxCount = 12) {
  const list = Array.from(files || []).filter(Boolean).slice(0, maxCount);
  const images = [];
  for (const file of list) {
    const imageData = await resizeImage(file);
    if (!images.includes(imageData)) images.push(imageData);
  }
  return images;
}

async function addImagesFromFiles(files, successMessage) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  const remaining = Math.max(0, 12 - state.images.length);
  const selected = list.slice(0, remaining);
  if (!selected.length) {
    showToast("最多保留 12 张样品图片");
    return;
  }

  for (const file of selected) {
    await addImageFromFile(file);
  }
  fields.sampleImage.value = "";
  renderImagePreview();
  if (successMessage) {
    const suffix = list.length > selected.length ? "，已达到 12 张上限" : "";
    showToast(`${successMessage}${selected.length} 张图片${suffix}`);
  }
}

async function uploadImagesToRecord(sampleId, files) {
  const sample = findSampleById(sampleId);
  if (!sample) throw new Error("记录不存在");
  if (sample.status === "void") throw new Error("作废记录不能补图");
  if (sampleImages(sample).length) throw new Error("这条记录已经有图片");

  const images = await imageListFromFiles(files);
  fields.recordImageFile.value = "";
  if (!images.length) throw new Error("请选择图片");

  const data = await api(`/api/samples/${encodeURIComponent(sampleId)}/images`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ images })
  });

  showToast(`已为编号 ${formatSampleCode(data.sample)} 补上传图片`);
  await Promise.all([loadSamples(), loadAdminSamples()]);
}

function imageFileFromPasteEvent(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  return imageItem ? imageItem.getAsFile() : null;
}

function canPasteImageIntoEntry(event) {
  if (!isLoggedIn() || location.hash !== "#entry") return false;
  if (!$("entry").classList.contains("active")) return false;
  if (!$("passwordModal").hidden || !$("ownerModal").hidden || !$("imageModal").hidden) return false;
  if (event.target?.closest?.("#config")) return false;
  return true;
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    showToast("当前浏览器不支持按钮粘贴，请直接 Ctrl+V 粘贴图片");
    return;
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    await addImagesFromFiles([blob], "已粘贴 ");
    return;
  }
  showToast("剪贴板里没有图片");
}

function renderImagePreview() {
  const preview = $("imagePreview");
  if (!state.images.length) {
    preview.classList.add("muted");
    preview.classList.remove("has-images");
    preview.innerHTML = "未选择图片";
    return;
  }
  preview.classList.remove("muted");
  preview.classList.add("has-images");
  preview.innerHTML = state.images
    .map((image, index) => `<img src="${escapeHtml(image)}" alt="样品图片预览 ${index + 1}" />`)
    .join("");
}

function clearSelectedImage() {
  state.images = [];
  fields.sampleImage.value = "";
  renderImagePreview();
}

function openImageModal(sample) {
  const images = sampleImages(sample);
  if (!images.length) return;
  $("imageGallery").innerHTML = images
    .map((image, index) => `<img src="${escapeHtml(image)}" alt="样品图片 ${index + 1}" />`)
    .join("");
  $("imageModal").hidden = false;
}

function closeImageModal() {
  $("imageModal").hidden = true;
  $("imageGallery").innerHTML = "";
}

function backupFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `sample-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  const response = await fetch("/api/backup", {
    headers: authHeaders()
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "导出失败");
  }

  const blob = await response.blob();
  downloadBlob(blob, backupFileName());
  showToast("备份文件已导出");
}

async function importBackupFile(file) {
  if (!file) return;
  const text = await file.text();
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("备份文件格式不正确");
  }

  const ok = window.confirm(
    "导入备份会覆盖当前样品库、店铺负责人和账号信息。系统会先自动保留一份当前数据的安全副本。确认导入吗？"
  );
  if (!ok) return;

  const data = await api("/api/backup/import", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(backup)
  });

  setNextNumber(data);
  fields.backupFile.value = "";
  showToast(`已导入 ${data.imported} 条记录`);
  await Promise.all([loadSamples(), refreshEntryData()]);
}

function fillPrintLabel(sample) {
  $("printSampleNumber").textContent = formatSampleCode(sample);
  $("printPlateNumber").textContent = sample.plateNumber;
  $("printCustomerName").textContent = sample.customerName;
  $("printStoreName").textContent = sample.storeName || "";
  $("printOwnerName").textContent = sample.ownerName;
  $("printOwnerPhone").textContent = sample.ownerPhone;
  $("printCreatedAt").textContent = formatDate(sample.createdAt);
}

function printLabelHtml(sample, withIds = false) {
  const idAttr = (id) => (withIds ? ` id="${id}"` : "");
  return `
    <article class="label">
      <div class="label-number"${idAttr("printSampleNumber")}>${escapeHtml(formatSampleCode(sample))}</div>
      <div class="label-details">
        <div class="label-line label-line-plate"><b>版号：</b><span${idAttr("printPlateNumber")}>${escapeHtml(sample.plateNumber)}</span></div>
        <div class="label-line"><b>客户：</b><span${idAttr("printCustomerName")}>${escapeHtml(sample.customerName)}</span></div>
        <div class="label-line"><b>店铺：</b><span${idAttr("printStoreName")}>${escapeHtml(sample.storeName || "")}</span></div>
        <div class="label-line"><b>负责人：</b><span${idAttr("printOwnerName")}>${escapeHtml(sample.ownerName)}</span></div>
        <div class="label-line"><b>号码：</b><span${idAttr("printOwnerPhone")}>${escapeHtml(sample.ownerPhone)}</span></div>
        <div class="label-line"><b>日期：</b><span${idAttr("printCreatedAt")}>${escapeHtml(formatDate(sample.createdAt))}</span></div>
      </div>
    </article>
  `;
}

function renderPrintLabels(samples) {
  const list = Array.isArray(samples) ? samples : [samples];
  const printable = list.filter(Boolean);
  $("printArea").dataset.labelCount = String(printable.length);
  $("printArea").innerHTML = printable
    .map((sample, index) => printLabelHtml(sample, index === 0))
    .join("");
}

function printLineElements() {
  return Array.from(document.querySelectorAll("#printArea .label-line"));
}

function resetPrintLineFits(lines = printLineElements()) {
  lines.forEach((line) => {
    line.style.removeProperty("font-size");
    line.style.removeProperty("line-height");
    line.style.removeProperty("--fit-print-font-size");
    line.style.removeProperty("--fit-print-line-height");
    line.removeAttribute("data-fit-font");
  });
}

function detailRowCount(lines = printLineElements()) {
  let rows = 0;
  let pendingHalfRow = false;
  lines.forEach((line) => {
    if (line.classList.contains("wide")) {
      if (pendingHalfRow) {
        rows += 1;
        pendingHalfRow = false;
      }
      rows += 1;
      return;
    }
    if (pendingHalfRow) {
      rows += 1;
      pendingHalfRow = false;
    } else {
      pendingHalfRow = true;
    }
  });
  if (pendingHalfRow) rows += 1;
  return Math.max(1, rows);
}

function lineTextOverflows(line) {
  const value = line.querySelector("span");
  return Boolean(
    line.scrollWidth > line.clientWidth + 1 ||
      (value && value.scrollWidth > value.clientWidth + 1)
  );
}

function setLinePrintFit(line, fontSize, lineHeight = "1.12") {
  line.style.setProperty("--fit-print-font-size", fontSize);
  line.style.setProperty("--fit-print-line-height", lineHeight);
  line.setAttribute("data-fit-font", "true");
}

function applyLengthBasedPrintFit(lines = printLineElements()) {
  lines.forEach((line) => {
    const value = line.querySelector("span");
    const text = value ? value.textContent.trim() : "";
    const isPlateLine = value.id === "printPlateNumber" || line.classList.contains("label-line-plate");
    if (!text || !isPlateLine || text.length <= 18) return;

    line.classList.add("wide");
    if (text.length <= 24) {
      setLinePrintFit(line, "min(5.1vw, 5.4vh)", "1.12");
    } else if (text.length <= 32) {
      setLinePrintFit(line, "min(4vw, 4.5vh)", "1.1");
    } else if (text.length <= 44) {
      setLinePrintFit(line, "min(3.2vw, 3.8vh)", "1.08");
    } else {
      setLinePrintFit(line, "min(2.55vw, 3.1vh)", "1.06");
    }
  });
}

function printLabelOverflows() {
  const labels = Array.from(document.querySelectorAll("#printArea .label"));
  const lines = printLineElements();
  const horizontal = lines.some(lineTextOverflows);
  const vertical = labels.some((label) => {
    const details = label.querySelector(".label-details");
    return Boolean(
      details &&
        (label.scrollHeight > label.clientHeight + 1 || details.scrollHeight > details.clientHeight + 1)
    );
  });
  return horizontal || vertical;
}

function printSamples(samples) {
  const printable = (Array.isArray(samples) ? samples : [samples]).filter(
    (sample) => sample && sample.status !== "void"
  );
  if (!printable.length) {
    showToast("请先选择可以补打的记录");
    return;
  }

  savePrintSettingsFromInputs(false);
  renderPrintLabels(printable);
  preparePrintLabelLayout();
  showToast(`准备打印 ${printable.length} 张标签`);
  const oldTitle = document.title;
  let restored = false;
  const restoreTitle = () => {
    if (restored) return;
    restored = true;
    document.title = oldTitle;
  };
  window.addEventListener("afterprint", restoreTitle, { once: true });
  document.title = "";
  document.body.offsetHeight;
  window.print();
  window.setTimeout(restoreTitle, 1200);
}

function shrinkPrintMetrics(metrics, factor) {
  const lineFont = clampNumber(metrics.lineFont * factor, 2.8, metrics.lineFont, metrics.lineFont);
  const numberSize = clampNumber(metrics.numberSize * factor, 8, metrics.numberSize, metrics.numberSize);
  return {
    ...metrics,
    numberSize,
    numberLine: clampNumber(metrics.numberLine * factor, 6, metrics.numberLine, metrics.numberLine),
    lineHeight: clampNumber(metrics.lineHeight * factor, 3, metrics.lineHeight, metrics.lineHeight),
    lineFont,
    detailGap: clampNumber(metrics.detailGap * factor, 0.25, metrics.detailGap, metrics.detailGap),
    detailTop: clampNumber(metrics.detailTop * factor, 0.35, metrics.detailTop, metrics.detailTop)
  };
}

function fitWidePrintLines(lines = printLineElements()) {
  lines.forEach((line) => {
    const value = line.querySelector("span");
    if (!value || !value.textContent.trim()) return;
    if (!lineTextOverflows(line)) return;

    let fontSize = parseFloat(getComputedStyle(line).fontSize);
    if (!Number.isFinite(fontSize) || fontSize <= 0) return;

    const baseFontSize = fontSize;
    const minSize = Math.max(7, fontSize * 0.36);
    line.style.setProperty("font-size", `${fontSize}px`, "important");
    line.style.setProperty("line-height", "1.12", "important");

    for (let step = 0; step < 36 && lineTextOverflows(line) && fontSize > minSize; step += 1) {
      const needed = Math.max(1, line.scrollWidth, value.scrollWidth);
      const available = Math.max(1, line.clientWidth);
      const ratio = Math.min(0.96, available / needed);
      fontSize = Math.max(minSize, fontSize * Math.max(0.72, ratio * 0.98));
      line.style.setProperty("font-size", `${fontSize}px`, "important");
    }

    const scale = Math.max(0.36, Math.min(1, fontSize / baseFontSize));
    const baseVw = line.classList.contains("wide") ? 6.4 : 7;
    const baseVh = line.classList.contains("wide") ? 6.8 : 7.2;
    setLinePrintFit(
      line,
      `min(${(baseVw * scale).toFixed(2)}vw, ${(baseVh * scale).toFixed(2)}vh)`,
      scale < 0.56 ? "1.06" : "1.12"
    );
    line.style.removeProperty("font-size");
    line.style.removeProperty("line-height");
  });
}

function preparePrintLabelLayout() {
  const settings = normalizePrintSettings(state.printSettings);
  const lines = printLineElements();
  lines.forEach((line) => line.classList.remove("wide"));
  resetPrintLineFits(lines);
  applyPrintMetricVars(printMetrics(settings, PRINT_DETAIL_ROWS, PRINT_FONT_BOOST));
  document.body.classList.add("print-fitting");

  for (let round = 0; round < 2; round += 1) {
    lines.forEach((line) => {
      const value = line.querySelector("span");
      if (
        line.scrollWidth > line.clientWidth + 1 ||
        (value && value.scrollWidth > value.clientWidth + 1)
      ) {
        line.classList.add("wide");
      }
    });
    applyPrintMetricVars(printMetrics(settings, detailRowCount(lines), PRINT_FONT_BOOST));
  }

  let metrics = printMetrics(settings, detailRowCount(lines), PRINT_FONT_BOOST);
  applyPrintMetricVars(metrics);
  for (let step = 0; step < 28 && printLabelOverflows(); step += 1) {
    metrics = shrinkPrintMetrics(metrics, 0.94);
    applyPrintMetricVars(metrics);
  }

  if (printLabelOverflows()) {
    lines.forEach((line) => line.classList.add("wide"));
    metrics = printMetrics(settings, detailRowCount(lines), PRINT_FONT_BOOST);
    applyPrintMetricVars(metrics);
    for (let step = 0; step < 36 && printLabelOverflows(); step += 1) {
      metrics = shrinkPrintMetrics(metrics, 0.94);
      applyPrintMetricVars(metrics);
    }
  }

  fitWidePrintLines(lines);
  applyLengthBasedPrintFit(lines);
  document.body.classList.remove("print-fitting");
}

function printSample(sample) {
  printSamples([sample]);
}

function clearForm() {
  fields.plateNumber.value = "";
  fields.customerName.value = "";
  fields.storeName.value = "";
  fields.ownerName.value = "";
  fields.ownerPhone.value = "";
  fields.note.value = "";
  clearSelectedImage();
  fields.plateNumber.focus();
}

async function loadUsers() {
  if (!isAdmin()) return;
  const data = await api("/api/users", { headers: authHeaders() });
  state.users = data.users || [];
  renderUserRows();
}

function renderUserRows() {
  const rows = $("userRows");
  if (!state.users.length) {
    rows.innerHTML = `<tr><td colspan="7" class="muted">暂无账号</td></tr>`;
    return;
  }

  rows.innerHTML = state.users
    .map(
      (user) => `
        <tr data-user-row="${escapeHtml(user.id)}">
          <td><input data-user-field="username" value="${escapeHtml(user.username)}" /></td>
          <td><input data-user-field="displayName" value="${escapeHtml(user.displayName)}" /></td>
          <td>
            <select data-user-field="role">
              <option value="editor" ${user.role === "editor" ? "selected" : ""}>编辑账号</option>
              <option value="admin" ${user.role === "admin" ? "selected" : ""}>管理员</option>
            </select>
          </td>
          <td>
            <select data-user-field="active">
              <option value="true" ${user.active ? "selected" : ""}>启用</option>
              <option value="false" ${!user.active ? "selected" : ""}>停用</option>
            </select>
          </td>
          <td><input type="password" data-user-field="password" placeholder="不修改留空" autocomplete="new-password" /></td>
          <td>${escapeHtml(formatDate(user.createdAt))}</td>
          <td><button type="button" class="secondary" data-save-user="${escapeHtml(user.id)}">保存</button></td>
        </tr>
      `
    )
    .join("");
}

async function createAccount() {
  const username = fields.accountUsername.value.trim();
  const displayName = fields.accountDisplayName.value.trim();
  const password = fields.accountPassword.value;
  const role = fields.accountRole.value;
  if (!username || !password) {
    showToast("请填写账号和初始密码");
    return;
  }

  const data = await api("/api/users", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ username, displayName, password, role })
  });
  state.users = data.users || [];
  renderUserRows();
  fields.accountUsername.value = "";
  fields.accountDisplayName.value = "";
  fields.accountPassword.value = "";
  fields.accountRole.value = "editor";
  showToast(`已新增账号 ${data.user.username}`);
}

async function saveUserFromRow(userId) {
  const row = document.querySelector(`[data-user-row="${CSS.escape(userId)}"]`);
  if (!row) return;
  const field = (name) => row.querySelector(`[data-user-field="${name}"]`);
  const payload = {
    username: field("username").value.trim(),
    displayName: field("displayName").value.trim(),
    role: field("role").value,
    active: field("active").value === "true",
    password: field("password").value
  };

  const data = await api(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  state.users = data.users || [];
  if (data.user && state.user && data.user.id === state.user.id) {
    state.user = data.user;
    refreshAuthUi();
  }
  renderUserRows();
  showToast(`已保存账号 ${data.user.username}`);
}

async function saveSample(options = {}) {
  const shouldPrint = options.print !== false;
  const form = $("sampleForm");
  if (form.reportValidity && !form.reportValidity()) return;

  try {
    const boundOwner = findOwnerByStoreName(fields.storeName.value);
    if (boundOwner && fields.ownerName.value !== boundOwner.id) {
      fields.ownerName.value = boundOwner.id;
      syncOwnerPhone();
    }
    const owner = boundOwner || selectedOwner();
    if (!owner) {
      showToast("请选择店铺负责人，或先在负责人配置里绑定店铺");
      fields.ownerName.focus();
      return;
    }

    const data = await api("/api/samples", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        plateNumber: fields.plateNumber.value,
        customerName: fields.customerName.value,
        storeName: fields.storeName.value,
        ownerName: owner.name,
        ownerPhone: owner.phone,
        envelopeType: currentEnvelopeType(),
        note: fields.note.value,
        images: state.images
      })
    });

    setNextNumber(data);
    if (data.duplicate) {
      showToast(
        `已有编号 ${formatSampleCode(data.sample)}，本次未重复登记${shouldPrint ? "，已打印原有编号" : ""}`
      );
      if (shouldPrint) printSample(data.sample);
    } else {
      showToast(`已保存样品编号 ${formatSampleCode(data.sample)}${shouldPrint ? "" : "，未打印"}`);
      if (shouldPrint) printSample(data.sample);
    }
    clearForm();
    await Promise.all([loadSamples(), loadAdminSamples()]);
  } catch (error) {
    showToast(error.message);
  }
}

$("sampleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSample({ print: true });
});

document.querySelector('[data-view-link="entry"]').addEventListener("click", (event) => {
  if (isLoggedIn()) return;
  event.preventDefault();
  state.pendingView = "entry";
  showPasswordModal();
});

document.querySelector('[data-view-link="config"]').addEventListener("click", (event) => {
  if (isLoggedIn() && isAdmin()) return;
  event.preventDefault();
  if (isLoggedIn()) {
    showToast("只有管理员账号可以进入配置页");
    return;
  }
  state.pendingView = "config";
  showPasswordModal();
});

document.querySelector('[data-view-link="library"]').addEventListener("click", () => {
  state.pendingView = "";
  hidePasswordModal();
});

$("confirmPassword").addEventListener("click", loginAccount);
$("cancelPassword").addEventListener("click", () => {
  state.pendingView = "";
  hidePasswordModal();
  history.replaceState(null, "", "#library");
  showView("library");
});
fields.loginUsername.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fields.entryPassword.focus();
});
fields.entryPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loginAccount();
});
$("logoutButton").addEventListener("click", () => {
  logoutAccount().catch((error) => showToast(error.message));
});

$("clearForm").addEventListener("click", clearForm);
$("saveOnly").addEventListener("click", () => {
  saveSample({ print: false });
});
document.querySelectorAll('input[name="envelopeType"]').forEach((input) => {
  input.addEventListener("change", renderNextNumber);
});
$("clearImage").addEventListener("click", clearSelectedImage);
$("pasteImage").addEventListener("click", () => {
  pasteImageFromClipboard().catch((error) => showToast(error.message || "粘贴图片失败"));
});
$("savePrintSize").addEventListener("click", () => savePrintSettingsFromInputs(true));
$("resetPrintSize").addEventListener("click", () => {
  savePrintSettings(DEFAULT_PRINT_SETTINGS);
  showToast("已恢复默认打印规格：60 x 40 mm，内容 1.5x");
});
fields.storeName.addEventListener("input", syncOwnerFromStore);
fields.storeName.addEventListener("change", syncOwnerFromStore);
fields.ownerName.addEventListener("change", () => {
  if (fields.ownerName.value === "__add__") {
    renderOwnerOptions("");
    showOwnerModal();
    return;
  }
  syncOwnerPhone();
});
$("saveOwner").addEventListener("click", () => {
  saveNewOwner().catch((error) => showToast(error.message));
});
$("cancelOwner").addEventListener("click", () => {
  hideOwnerModal();
  renderOwnerOptions("");
});
$("ownerRows").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-owner-edit]");
  if (editButton) {
    showOwnerModal(editButton.dataset.ownerEdit);
    return;
  }

  const deleteButton = event.target.closest("[data-owner-delete]");
  if (!deleteButton) return;
  deleteOwner(deleteButton.dataset.ownerDelete).catch((error) => showToast(error.message));
});
fields.newOwnerName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fields.newOwnerPhone.focus();
});
fields.newOwnerPhone.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fields.newOwnerStores.focus();
});
fields.newOwnerStores.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter") saveNewOwner().catch((error) => showToast(error.message));
});
fields.sampleImage.addEventListener("change", async () => {
  try {
    await addImagesFromFiles(fields.sampleImage.files, "已选择 ");
  } catch (error) {
    fields.sampleImage.value = "";
    showToast(error.message);
  }
});
document.addEventListener("paste", (event) => {
  const file = imageFileFromPasteEvent(event);
  if (!file || !canPasteImageIntoEntry(event)) return;
  event.preventDefault();
  addImagesFromFiles([file], "已粘贴 ").catch((error) => {
    showToast(error.message || "粘贴图片失败");
  });
});

$("searchButton").addEventListener("click", () => {
  loadSamples({ page: 1 }).catch((error) => showToast(error.message));
});
$("libraryPrevPage").addEventListener("click", () => {
  if (state.libraryPage <= 1) return;
  loadSamples({ page: state.libraryPage - 1 }).catch((error) => showToast(error.message));
});
$("libraryNextPage").addEventListener("click", () => {
  if (state.libraryPage >= state.libraryPageCount) return;
  loadSamples({ page: state.libraryPage + 1 }).catch((error) => showToast(error.message));
});
$("clearAdminDate").addEventListener("click", () => {
  fields.adminDate.value = todayDateValue();
  loadAdminSamples().catch((error) => showToast(error.message));
});
fields.adminDate.addEventListener("change", () => {
  loadAdminSamples().catch((error) => showToast(error.message));
});
$("exportBackup").addEventListener("click", () => {
  exportBackup().catch((error) => showToast(error.message));
});
$("importBackup").addEventListener("click", () => fields.backupFile.click());
$("batchPrint").addEventListener("click", () => {
  printSamples(selectedPrintSamples());
});
$("selectAllPrint").addEventListener("change", (event) => {
  const checked = event.target.checked;
  printableSamples(state.adminSamples).forEach((sample) => {
    if (checked) {
      state.selectedPrintIds.add(sample.id);
    } else {
      state.selectedPrintIds.delete(sample.id);
    }
  });
  renderAdminRows();
});
fields.backupFile.addEventListener("change", () => {
  importBackupFile(fields.backupFile.files[0]).catch((error) => {
    fields.backupFile.value = "";
    showToast(error.message);
  });
});
fields.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadSamples({ page: 1 }).catch((error) => showToast(error.message));
  }
});

$("accountForm").addEventListener("submit", (event) => {
  event.preventDefault();
  createAccount().catch((error) => showToast(error.message));
});
$("userRows").addEventListener("click", (event) => {
  const saveButton = event.target.closest("[data-save-user]");
  if (!saveButton) return;
  saveUserFromRow(saveButton.dataset.saveUser).catch((error) => showToast(error.message));
});

function handleTableClick(event) {
  const uploadImageButton = event.target.closest("[data-upload-image]");
  if (uploadImageButton) {
    const sample = findSampleById(uploadImageButton.dataset.uploadImage);
    if (!sample || sample.status === "void" || sampleImages(sample).length) return;
    state.imageUploadSampleId = sample.id;
    fields.recordImageFile.value = "";
    fields.recordImageFile.click();
    return;
  }

  const imageButton = event.target.closest("[data-image]");
  if (imageButton) {
    const sample = findSampleById(imageButton.dataset.image);
    openImageModal(sample);
    return;
  }

  const printButton = event.target.closest("[data-print]");
  if (printButton) {
    const sample = findSampleById(printButton.dataset.print);
    const selectedSamples = selectedPrintSamples();
    if (selectedSamples.length) {
      printSamples(selectedSamples);
    } else if (sample && sample.status !== "void") {
      printSample(sample);
    }
    return;
  }

  const deleteVoidButton = event.target.closest("[data-delete-void]");
  if (deleteVoidButton) {
    const sample = findSampleById(deleteVoidButton.dataset.deleteVoid);
    if (!sample || sample.status !== "void") return;
    const ok = window.confirm(`确认彻底删除作废记录 ${formatSampleCode(sample)}？删除后无法恢复。`);
    if (!ok) return;

    api(`/api/samples/${encodeURIComponent(sample.id)}`, {
      method: "DELETE",
      headers: authHeaders()
    })
      .then((data) => {
        setNextNumber(data);
        showToast(`已删除作废记录 ${formatSampleCode(sample)}`);
        return Promise.all([loadSamples(), loadAdminSamples()]);
      })
      .catch((error) => showToast(error.message));
    return;
  }

  const voidButton = event.target.closest("[data-void]");
  if (!voidButton) return;
  const sample = findSampleById(voidButton.dataset.void);
  if (!sample) return;

  const reason = window.prompt(`确认作废编号 ${formatSampleCode(sample)}？请输入原因：`, "录入错误");
  if (reason === null) return;

  api(`/api/samples/${encodeURIComponent(sample.id)}/void`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ reason })
  })
    .then(() => {
      showToast(`编号 ${formatSampleCode(sample)} 已作废`);
      return Promise.all([loadSamples(), loadAdminSamples()]);
    })
    .catch((error) => showToast(error.message));
}

$("libraryRows").addEventListener("click", handleTableClick);
$("adminRows").addEventListener("click", handleTableClick);
$("adminRows").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-select-print]");
  if (!checkbox) return;
  if (checkbox.checked) {
    state.selectedPrintIds.add(checkbox.dataset.selectPrint);
  } else {
    state.selectedPrintIds.delete(checkbox.dataset.selectPrint);
  }
  renderBatchPrintState();
});
fields.recordImageFile.addEventListener("change", () => {
  const sampleId = state.imageUploadSampleId;
  state.imageUploadSampleId = "";
  uploadImagesToRecord(sampleId, fields.recordImageFile.files).catch((error) => {
    fields.recordImageFile.value = "";
    showToast(error.message);
  });
});
$("closeImageModal").addEventListener("click", closeImageModal);
$("imageModal").addEventListener("click", (event) => {
  if (event.target.id === "imageModal") closeImageModal();
});

if (!location.hash) {
  history.replaceState(null, "", "#library");
}

window.addEventListener("hashchange", routeFromHash);
fields.adminDate.value = todayDateValue();
applyPrintSettings();
renderPrintSettings();
renderImagePreview();
refreshAuthUi();
loadSamples().catch((error) => showToast(error.message));
restoreSession()
  .then(routeFromHash)
  .catch((error) => showToast(error.message));
