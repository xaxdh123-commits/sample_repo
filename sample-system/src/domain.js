const STATUS_LABELS = Object.freeze({
  draft: "草稿",
  printed: "打印",
  claimed: "领用",
  sent: "寄出",
  void: "作废",
  completed: "入库"
});

const NEXT_STATUS = Object.freeze({ draft: "printed", printed: "claimed", claimed: "sent", sent: "completed" });
const ENVELOPE_PREFIX = Object.freeze({ small: "A", large: "B", none: "C" });

function canTransition(from, to) {
  if (!STATUS_LABELS[from] || !STATUS_LABELS[to] || from === "void" || from === "completed") return false;
  return to === "void" || NEXT_STATUS[from] === to || (from === "printed" && to === "sent");
}

function sampleCode(number, envelopeType) {
  return `${ENVELOPE_PREFIX[envelopeType] || "A"}${String(number).padStart(4, "0")}`;
}

function packagingSampleCode(number) {
  return `BZ${String(number).padStart(4, "0")}`;
}

function permissionGranted(permissions, required) {
  const set = new Set(Array.isArray(permissions) ? permissions : []);
  if (set.has("*:*:*") || set.has(required)) return true;
  if (required === "sample:view" && (set.has("sample:edit") || set.has("sample:admin"))) return true;
  if (required === "sample:edit" && set.has("sample:admin")) return true;
  return false;
}

module.exports = { STATUS_LABELS, NEXT_STATUS, canTransition, sampleCode, packagingSampleCode, permissionGranted };
