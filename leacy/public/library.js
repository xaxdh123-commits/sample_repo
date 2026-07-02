const $ = (id) => document.getElementById(id);
let samplesCache = [];

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatSampleCode(sample) {
  return sample.sampleCode || String(sample.sampleNumber).padStart(4, "0");
}

function statusText(sample) {
  return sample.status === "void" ? "作废" : "有效";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function imageCell(sample) {
  if (!sample.imageData) return `<span class="muted">无</span>`;
  return `
    <button type="button" class="thumb-button" data-image="${escapeHtml(sample.id)}" title="查看图片">
      <img src="${escapeHtml(sample.imageData)}" alt="样品图片" />
    </button>
  `;
}

async function loadSamples() {
  try {
    const q = encodeURIComponent($("searchInput").value.trim());
    const response = await fetch(`/api/samples?q=${q}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "查询失败");
    samplesCache = data.samples;
    renderRows(data.samples);
  } catch (error) {
    showToast(error.message);
  }
}

function renderRows(samples) {
  const rows = $("sampleRows");
  if (!samples.length) {
    rows.innerHTML = `<tr><td colspan="10" class="muted">没有找到记录</td></tr>`;
    return;
  }

  rows.innerHTML = samples
    .map(
      (sample) => `
        <tr class="${sample.status === "void" ? "void-row" : ""}">
          <td>${escapeHtml(formatSampleCode(sample))}</td>
          <td>${imageCell(sample)}</td>
          <td>${escapeHtml(sample.plateNumber)}</td>
          <td>${escapeHtml(sample.customerName)}</td>
          <td>${escapeHtml(sample.storeName || "")}</td>
          <td>${escapeHtml(sample.ownerName)}</td>
          <td>${escapeHtml(sample.ownerPhone)}</td>
          <td>${escapeHtml(formatDate(sample.createdAt))}</td>
          <td>${escapeHtml(sample.note || sample.voidReason || "")}</td>
          <td><span class="status ${sample.status === "void" ? "status-void" : "status-active"}">${statusText(sample)}</span></td>
        </tr>
      `
    )
    .join("");
}

function openImageModal(sample) {
  if (!sample || !sample.imageData) return;
  $("largeImage").src = sample.imageData;
  $("imageModal").hidden = false;
}

function closeImageModal() {
  $("imageModal").hidden = true;
  $("largeImage").removeAttribute("src");
}

$("searchButton").addEventListener("click", loadSamples);
$("searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadSamples();
});
$("sampleRows").addEventListener("click", (event) => {
  const imageButton = event.target.closest("[data-image]");
  if (!imageButton) return;
  const sample = samplesCache.find((item) => item.id === imageButton.dataset.image);
  openImageModal(sample);
});
$("closeImageModal").addEventListener("click", closeImageModal);
$("imageModal").addEventListener("click", (event) => {
  if (event.target.id === "imageModal") closeImageModal();
});

loadSamples();
