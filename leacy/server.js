const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const START_NUMBER = Number(process.env.START_NUMBER || 1);
const ENVELOPE_TYPES = ["small", "large", "none"];
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "samples.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PUBLIC_DIR = path.join(__dirname, "public");
const DAILY_BACKUP_CHECK_MS = 60 * 60 * 1000;
const DAILY_BACKUP_RETENTION_DAYS = 7;

const sessions = new Map();
let lastDailyBackupDate = "";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(String(password || ""), salt, 100000, 32, "sha256")
    .toString("hex");
  return { salt, hash };
}

function defaultAdminUser() {
  const password = hashPassword(ADMIN_PASSWORD);
  return {
    id: "user-admin",
    username: "admin",
    displayName: "管理员",
    role: "admin",
    active: true,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    createdAt: new Date().toISOString()
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        {
          nextNumber: START_NUMBER,
          samples: [],
          owners: [],
          users: [defaultAdminUser()]
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  let migrated = false;

  if (!Array.isArray(db.samples)) {
    db.samples = [];
    migrated = true;
  }
  db.samples = db.samples.map((sample) => {
    const images = sampleImages(sample);
    if (
      !Array.isArray(sample.images) ||
      sample.imageData !== (images[0] || "") ||
      sample.images.length !== images.length
    ) {
      migrated = true;
    }
    return {
      ...sample,
      imageData: images[0] || "",
      images
    };
  });
  const recalculatedNextNumbers = normalizeNextNumbers(db.nextNumbers, db.samples);
  if (!sameNextNumbers(db.nextNumbers, recalculatedNextNumbers) || db.nextNumber !== recalculatedNextNumbers.small) {
    db.nextNumbers = recalculatedNextNumbers;
    db.nextNumber = recalculatedNextNumbers.small;
    migrated = true;
  }
  if (!Array.isArray(db.owners)) {
    db.owners = [];
    migrated = true;
  }
  db.owners = db.owners
    .map((owner, index) => {
      const name = normalizeText(owner.name);
      const phone = normalizeText(owner.phone);
      if (!name || !phone) {
        migrated = true;
        return null;
      }
      const stores = normalizeStores(owner.stores);
      if (!Array.isArray(owner.stores)) migrated = true;
      return {
        id: normalizeText(owner.id) || `owner-${index}-${Date.now()}`,
        name,
        phone,
        stores,
        createdAt: normalizeText(owner.createdAt) || new Date().toISOString(),
        updatedAt: normalizeText(owner.updatedAt)
      };
    })
    .filter(Boolean);
  if (!Array.isArray(db.users) || db.users.length === 0) {
    db.users = [defaultAdminUser()];
    migrated = true;
  }

  db.users = db.users
    .map((user, index) => {
      const username = normalizeText(user.username);
      if (!username || !user.passwordHash || !user.passwordSalt) {
        migrated = true;
        return null;
      }
      return {
        id: normalizeText(user.id) || `user-${index}-${Date.now()}`,
        username,
        displayName: normalizeText(user.displayName) || username,
        role: user.role === "admin" ? "admin" : "editor",
        active: user.active !== false,
        passwordHash: normalizeText(user.passwordHash),
        passwordSalt: normalizeText(user.passwordSalt),
        createdAt: normalizeText(user.createdAt) || new Date().toISOString(),
        updatedAt: normalizeText(user.updatedAt)
      };
    })
    .filter(Boolean);

  if (db.users.length === 0) {
    db.users = [defaultAdminUser()];
    migrated = true;
  }

  if (migrated) writeDb(db);
  return db;
}

function normalizeEnvelopeType(value) {
  if (value === "large") return "large";
  if (value === "small") return "small";
  if (value === "none") return "none";
  return "";
}

function envelopePrefix(type) {
  const normalized = normalizeEnvelopeType(type);
  if (normalized === "large") return "B";
  if (normalized === "small") return "A";
  if (normalized === "none") return "C";
  return "";
}

function sampleCode(number, envelopeType = "") {
  return `${envelopePrefix(envelopeType)}${String(number).padStart(4, "0")}`;
}

function sampleEnvelopeType(sample) {
  const normalized = normalizeEnvelopeType(sample?.envelopeType);
  if (normalized) return normalized;

  const code = normalizeText(sample?.sampleCode).toUpperCase();
  if (code.startsWith("B")) return "large";
  if (code.startsWith("C")) return "none";
  return "small";
}

function sampleNumberValue(sample) {
  const sampleNumber = Number(sample?.sampleNumber);
  if (Number.isInteger(sampleNumber) && sampleNumber >= 1) return sampleNumber;

  const code = normalizeText(sample?.sampleCode);
  const match = code.match(/(\d+)$/);
  const codeNumber = match ? Number(match[1]) : 0;
  return Number.isInteger(codeNumber) && codeNumber >= 1 ? codeNumber : 0;
}

function nextAvailableNumber(samples, envelopeType = "small") {
  const startNumber = Math.max(1, Number.isInteger(START_NUMBER) ? START_NUMBER : 1);
  const type = normalizeEnvelopeType(envelopeType) || "small";
  const maxNumber = (Array.isArray(samples) ? samples : []).reduce((max, sample) => {
    if (sampleEnvelopeType(sample) !== type) return max;
    const number = sampleNumberValue(sample);
    return Number.isInteger(number) && number >= startNumber && number > max ? number : max;
  }, startNumber - 1);
  return maxNumber + 1;
}

function nextNumbersFromSamples(samples) {
  return ENVELOPE_TYPES.reduce((result, type) => {
    result[type] = nextAvailableNumber(samples, type);
    return result;
  }, {});
}

function normalizeNextNumbers(savedNextNumbers, samples) {
  const calculated = nextNumbersFromSamples(samples);
  const saved = savedNextNumbers && typeof savedNextNumbers === "object" ? savedNextNumbers : {};
  return ENVELOPE_TYPES.reduce((result, type) => {
    const savedNumber = Number(saved[type]);
    result[type] =
      Number.isInteger(savedNumber) && savedNumber >= 1
        ? Math.max(calculated[type], savedNumber)
        : calculated[type];
    return result;
  }, {});
}

function sameNextNumbers(left, right) {
  return ENVELOPE_TYPES.every((type) => Number(left?.[type]) === Number(right?.[type]));
}

function refreshNextNumbers(db) {
  db.nextNumbers = normalizeNextNumbers(db.nextNumbers, db.samples);
  db.nextNumber = db.nextNumbers.small;
  return db.nextNumbers;
}

function nextCodes(nextNumbers) {
  return ENVELOPE_TYPES.reduce((result, type) => {
    result[type] = sampleCode(nextNumbers[type], type);
    return result;
  }, {});
}

function nextNumberPayload(db, envelopeType = "small") {
  const type = normalizeEnvelopeType(envelopeType) || "small";
  const numbers = refreshNextNumbers(db);
  return {
    nextNumber: numbers[type],
    nextCode: sampleCode(numbers[type], type),
    nextNumbers: numbers,
    nextCodes: nextCodes(numbers)
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeStores(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  const seen = new Set();
  return source
    .map((item) => normalizeText(item))
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function storeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeRole(value) {
  return value === "admin" ? "admin" : "editor";
}

function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const check = hashPassword(password, user.passwordSalt).hash;
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(check, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "editor",
    active: user.active !== false,
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || ""
  };
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function userFromRequest(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  const db = readDb();
  const user = db.users.find((item) => item.id === session.userId && item.active !== false);
  if (!user) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

function requireAccount(req, res) {
  const user = userFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录账号" });
    return null;
  }
  return user;
}

function requireAdminRole(req, res) {
  const user = requireAccount(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "只有管理员账号可以操作" });
    return null;
  }
  return user;
}

function requireLegacyAdmin(req, res) {
  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    sendJson(res, 401, { error: "Admin password is incorrect" });
    return false;
  }
  return true;
}

function adminPasswordMatches(password, db) {
  const value = String(password || "");
  if (!value) return false;
  if (value === ADMIN_PASSWORD) return true;
  return (db.users || []).some(
    (user) => user.active !== false && user.role === "admin" && verifyPassword(value, user)
  );
}

function normalizeImageData(value) {
  const imageData = String(value || "").trim();
  if (!imageData) return "";
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageData)) {
    throw new Error("Image format is invalid");
  }
  if (imageData.length > 2 * 1024 * 1024) {
    throw new Error("Image is too large");
  }
  return imageData;
}

function normalizeImageList(value) {
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  return source
    .map((item) => normalizeImageData(item))
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, 12);
}

function sampleImages(sample = {}) {
  return normalizeImageList([
    sample.imageData,
    ...(Array.isArray(sample.images) ? sample.images : [])
  ]);
}

function sampleIdentityKey(sample) {
  return [
    sample.plateNumber,
    sample.customerName,
    sample.storeName,
    sample.ownerName,
    sample.ownerPhone
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .join("\u001f");
}

function findActiveDuplicateSample(samples, sample) {
  const key = sampleIdentityKey(sample);
  return (samples || []).find((item) => (item.status || "active") !== "void" && sampleIdentityKey(item) === key);
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function dateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function dateLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function publicSample(sample) {
  const images = sampleImages(sample);
  const envelopeType = sampleEnvelopeType(sample);
  return {
    id: sample.id,
    sampleNumber: sample.sampleNumber,
    sampleCode: sample.sampleCode || sampleCode(sample.sampleNumber, envelopeType),
    envelopeType,
    plateNumber: sample.plateNumber,
    customerName: sample.customerName,
    storeName: sample.storeName || "",
    ownerName: sample.ownerName,
    ownerPhone: sample.ownerPhone,
    note: sample.note,
    imageData: images[0] || "",
    images,
    imageCount: images.length,
    createdByUserId: sample.createdByUserId || "",
    createdByUsername: sample.createdByUsername || "",
    createdByName: sample.createdByName || "",
    registrarName: sample.createdByName || sample.createdByUsername || "",
    status: sample.status || "active",
    voidReason: sample.voidReason || "",
    createdAt: sample.createdAt,
    voidedAt: sample.voidedAt || ""
  };
}

function publicOwner(owner) {
  return {
    id: owner.id,
    name: owner.name,
    phone: owner.phone,
    stores: normalizeStores(owner.stores),
    createdAt: owner.createdAt || ""
  };
}

function findOwnerByStoreName(db, storeName) {
  const key = storeKey(storeName);
  if (!key) return null;
  return (db.owners || []).find((owner) =>
    normalizeStores(owner.stores).some((store) => storeKey(store) === key)
  );
}

function findStoreBindingConflict(db, stores, ownerId = "") {
  const storeKeys = new Map(normalizeStores(stores).map((store) => [storeKey(store), store]));
  for (const owner of db.owners || []) {
    if (owner.id === ownerId) continue;
    const store = normalizeStores(owner.stores).find((item) => storeKeys.has(storeKey(item)));
    if (store) return { owner, store: storeKeys.get(storeKey(store)) || store };
  }
  return null;
}

function localDateRange(value) {
  const text = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function sampleInDateRange(sample, range) {
  if (!range) return true;
  const createdAt = new Date(sample.createdAt || "");
  if (Number.isNaN(createdAt.getTime())) return false;
  return createdAt >= range.start && createdAt < range.end;
}

function searchSamples(query) {
  const db = readDb();
  const q = normalizeText(query.get("q")).toLowerCase();
  const range = localDateRange(query.get("date"));
  const rawLimit = Math.floor(Number(query.get("limit") || 100));
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 100;
  const paginationEnabled = query.has("page") || query.has("pageSize");
  const rawPageSize = Math.floor(Number(query.get("pageSize") || 20));
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(Math.max(rawPageSize, 1), 100)
    : 20;
  const rawPage = Math.floor(Number(query.get("page") || 1));
  const requestedPage = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;
  const filteredSamples = db.samples
    .slice()
    .sort((a, b) => b.sampleNumber - a.sampleNumber)
    .filter((sample) => {
      if (!sampleInDateRange(sample, range)) return false;
      if (!q) return true;
      const visible = publicSample(sample);
      const haystack = [
        visible.sampleNumber,
        visible.sampleCode,
        visible.plateNumber,
        visible.customerName,
        visible.storeName,
        visible.ownerName,
        visible.ownerPhone,
        visible.note,
        visible.imageCount ? "has-image" : "",
        visible.imageCount,
        visible.status,
        visible.voidReason
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  const total = filteredSamples.length;
  const effectivePageSize = paginationEnabled ? pageSize : limit;
  const pageCount = Math.max(1, Math.ceil(total / effectivePageSize));
  const page = paginationEnabled ? Math.min(requestedPage, pageCount) : 1;
  const offset = paginationEnabled ? (page - 1) * effectivePageSize : 0;
  const samples = filteredSamples
    .slice(offset, offset + effectivePageSize)
    .map(publicSample);
  return {
    samples,
    total,
    page,
    pageSize: effectivePageSize,
    pageCount,
    ...nextNumberPayload(db, query.get("envelopeType"))
  };
}

function normalizeUsers(sourceUsers, fallbackUsers) {
  const users = Array.isArray(sourceUsers)
    ? sourceUsers
        .map((user, index) => ({
          id: normalizeText(user.id) || `user-${Date.now()}-${index}`,
          username: normalizeText(user.username),
          displayName: normalizeText(user.displayName) || normalizeText(user.username),
          role: normalizeRole(user.role),
          active: user.active !== false,
          passwordHash: normalizeText(user.passwordHash),
          passwordSalt: normalizeText(user.passwordSalt),
          createdAt: normalizeText(user.createdAt) || new Date().toISOString(),
          updatedAt: normalizeText(user.updatedAt)
        }))
        .filter((user) => user.username && user.passwordHash && user.passwordSalt)
    : [];

  if (users.length) return users;
  if (Array.isArray(fallbackUsers) && fallbackUsers.length) return fallbackUsers;
  return [defaultAdminUser()];
}

function normalizeBackup(payload, fallbackUsers) {
  const source = payload && payload.samples ? payload : payload && payload.backup;
  if (!source || !Array.isArray(source.samples)) {
    throw new Error("Backup file is invalid");
  }

  const samples = source.samples.map((sample, index) => {
    const sampleNumber = Number(sample.sampleNumber);
    if (!Number.isInteger(sampleNumber) || sampleNumber < 1) {
      throw new Error(`Invalid sample number at row ${index + 1}`);
    }

    const envelopeType = sampleEnvelopeType(sample);
    const images = sampleImages(sample);

    return {
      id: normalizeText(sample.id) || `${Date.now()}-${index}`,
      sampleNumber,
      sampleCode: normalizeText(sample.sampleCode) || sampleCode(sampleNumber, envelopeType),
      envelopeType,
      plateNumber: normalizeText(sample.plateNumber),
      customerName: normalizeText(sample.customerName),
      storeName: normalizeText(sample.storeName),
      ownerName: normalizeText(sample.ownerName),
      ownerPhone: normalizeText(sample.ownerPhone),
      note: normalizeText(sample.note),
      imageData: images[0] || "",
      images,
      createdByUserId: normalizeText(sample.createdByUserId),
      createdByUsername: normalizeText(sample.createdByUsername),
      createdByName: normalizeText(sample.createdByName),
      status: sample.status === "void" ? "void" : "active",
      voidReason: normalizeText(sample.voidReason),
      createdAt: normalizeText(sample.createdAt) || new Date().toISOString(),
      voidedAt: normalizeText(sample.voidedAt)
    };
  });

  const nextNumbers = normalizeNextNumbers(source.nextNumbers, samples);
  const owners = Array.isArray(source.owners)
    ? source.owners
        .map((owner, index) => ({
          id: normalizeText(owner.id) || `${Date.now()}-owner-${index}`,
          name: normalizeText(owner.name),
          phone: normalizeText(owner.phone),
          stores: normalizeStores(owner.stores),
          createdAt: normalizeText(owner.createdAt) || new Date().toISOString(),
          updatedAt: normalizeText(owner.updatedAt)
        }))
        .filter((owner) => owner.name && owner.phone)
    : [];
  const users = normalizeUsers(source.users, fallbackUsers);

  return { nextNumber: nextNumbers.small, nextNumbers, samples, owners, users };
}

function buildBackup(db, options = {}) {
  const exportedAt = options.exportedAt || new Date();
  const samples = Array.isArray(options.samples) ? options.samples : db.samples || [];
  return {
    version: 3,
    backupType: options.backupType || "manual",
    exportedAt: exportedAt.toISOString(),
    backupDate: dateLabel(exportedAt),
    sampleScope: options.sampleScope || "all",
    sampleBeforeDate: options.sampleBeforeDate || "",
    nextNumber: db.nextNumber,
    nextNumbers: normalizeNextNumbers(db.nextNumbers, samples),
    samples,
    owners: db.owners || [],
    users: db.users || []
  };
}

function sendBackup(res) {
  const db = readDb();
  const exportedAt = new Date();
  const backup = buildBackup(db, {
    exportedAt,
    backupType: "manual",
    sampleScope: "all"
  });

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="sample-backup-${timestampForFile(exportedAt)}.json"`,
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(backup, null, 2));
}

function sampleCreatedBefore(sample, cutoffDate) {
  if (!sample.createdAt) return true;
  const createdAt = new Date(sample.createdAt);
  if (Number.isNaN(createdAt.getTime())) return true;
  return createdAt.getTime() < cutoffDate.getTime();
}

function pruneDailyBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  const backupRoot = path.resolve(BACKUP_DIR);
  const folders = fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(BACKUP_DIR, entry.name)
    }))
    .sort((a, b) => b.name.localeCompare(a.name));

  const expired = folders.slice(DAILY_BACKUP_RETENTION_DAYS);
  expired.forEach((folder) => {
    const target = path.resolve(folder.path);
    if (!target.startsWith(`${backupRoot}${path.sep}`)) return;
    fs.rmSync(target, { recursive: true, force: true });
  });
  return expired.map((folder) => folder.path);
}

function ensureDailyBackup(now = new Date()) {
  const todayStamp = dateStamp(now);
  if (lastDailyBackupDate === todayStamp) return null;

  const todayStart = startOfLocalDay(now);
  const backupFolder = path.join(BACKUP_DIR, todayStamp);
  const backupFile = path.join(backupFolder, `backup-before-${todayStamp}.json`);

  if (fs.existsSync(backupFile)) {
    const removed = pruneDailyBackups();
    lastDailyBackupDate = todayStamp;
    return { skipped: true, file: backupFile, removed };
  }

  const db = readDb();
  const samples = (db.samples || []).filter((sample) => sampleCreatedBefore(sample, todayStart));
  const backup = buildBackup(db, {
    exportedAt: now,
    backupType: "daily-auto",
    sampleScope: "before-date",
    sampleBeforeDate: dateLabel(todayStart),
    samples
  });

  fs.mkdirSync(backupFolder, { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), "utf8");
  const removed = pruneDailyBackups();
  lastDailyBackupDate = todayStamp;
  return { skipped: false, file: backupFile, samples: samples.length, removed };
}

function startDailyBackupTimer() {
  try {
    const result = ensureDailyBackup();
    if (result && !result.skipped) {
      console.log(`Daily backup created: ${result.file}`);
    }
    if (result && result.removed && result.removed.length) {
      console.log(`Old daily backups removed: ${result.removed.length}`);
    }
  } catch (error) {
    console.error("Daily backup failed:", error.message || error);
  }

  setInterval(() => {
    try {
      const result = ensureDailyBackup();
      if (result && !result.skipped) {
        console.log(`Daily backup created: ${result.file}`);
      }
      if (result && result.removed && result.removed.length) {
        console.log(`Old daily backups removed: ${result.removed.length}`);
      }
    } catch (error) {
      console.error("Daily backup failed:", error.message || error);
    }
  }, DAILY_BACKUP_CHECK_MS);
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function handleLogin(req, res) {
  try {
    const body = await parseBody(req);
    const username = normalizeText(body.username).toLowerCase();
    const password = String(body.password || "");
    const db = readDb();
    const user = db.users.find((item) => item.username.toLowerCase() === username);

    if (!user || user.active === false || !verifyPassword(password, user)) {
      sendJson(res, 401, { error: "账号或密码不正确" });
      return;
    }

    const token = createSession(user);
    sendJson(res, 200, {
      token,
      user: publicUser(user),
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Login failed" });
  }
}

function handleLogout(req, res) {
  const token = tokenFromRequest(req);
  if (token) sessions.delete(token);
  sendJson(res, 200, { ok: true });
}

async function handleCreateSample(req, res) {
  const actor = requireAccount(req, res);
  if (!actor) return;

  try {
    const body = await parseBody(req);
    const plateNumber = normalizeText(body.plateNumber);
    const customerName = normalizeText(body.customerName);
    const storeName = normalizeText(body.storeName);
    let ownerName = normalizeText(body.ownerName);
    let ownerPhone = normalizeText(body.ownerPhone);
    const envelopeType = normalizeEnvelopeType(body.envelopeType) || "small";
    const note = normalizeText(body.note);
    const images = normalizeImageList([
      ...(Array.isArray(body.images) ? body.images : []),
      body.imageData
    ]);
    const db = readDb();
    const boundOwner = findOwnerByStoreName(db, storeName);

    if (boundOwner) {
      ownerName = boundOwner.name;
      ownerPhone = boundOwner.phone;
    }

    if (!plateNumber || !customerName || !ownerName || !ownerPhone) {
      sendJson(res, 400, { error: "请填写版号、客户名、店铺负责人和号码" });
      return;
    }

    const duplicate = findActiveDuplicateSample(db.samples, {
      plateNumber,
      customerName,
      storeName,
      ownerName,
      ownerPhone
    });
    if (duplicate) {
      sendJson(res, 200, {
        sample: publicSample(duplicate),
        duplicate: true,
        ...nextNumberPayload(db, envelopeType)
      });
      return;
    }

    refreshNextNumbers(db);
    const nextNumber = db.nextNumbers[envelopeType];
    const sample = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sampleNumber: nextNumber,
      sampleCode: sampleCode(nextNumber, envelopeType),
      envelopeType,
      plateNumber,
      customerName,
      storeName,
      ownerName,
      ownerPhone,
      note,
      imageData: images[0] || "",
      images,
      createdByUserId: actor.id,
      createdByUsername: actor.username,
      createdByName: actor.displayName || actor.username,
      status: "active",
      createdAt: new Date().toISOString()
    };
    db.samples.push(sample);
    refreshNextNumbers(db);
    writeDb(db);
    sendJson(res, 201, {
      sample: publicSample(sample),
      ...nextNumberPayload(db, envelopeType)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Save failed" });
  }
}

async function handleCreateOwner(req, res) {
  if (!requireAccount(req, res)) return;

  try {
    const body = await parseBody(req);
    const name = normalizeText(body.name);
    const phone = normalizeText(body.phone);
    const stores = normalizeStores(body.stores);
    if (!name || !phone) {
      sendJson(res, 400, { error: "请填写店铺负责人姓名和号码" });
      return;
    }

    const db = readDb();
    let owner = db.owners.find((item) => item.name === name);
    const existed = Boolean(owner);
    const conflict = findStoreBindingConflict(db, stores, owner ? owner.id : "");
    if (conflict) {
      sendJson(res, 409, { error: `店铺「${conflict.store}」已经绑定给「${conflict.owner.name}」` });
      return;
    }

    if (owner) {
      owner.phone = phone;
      owner.stores = stores;
      owner.updatedAt = new Date().toISOString();
    } else {
      owner = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        phone,
        stores,
        createdAt: new Date().toISOString()
      };
      db.owners.push(owner);
    }
    writeDb(db);
    sendJson(res, existed ? 200 : 201, {
      owner: publicOwner(owner),
      owners: db.owners.map(publicOwner)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Owner save failed" });
  }
}

async function handleUpdateOwner(req, res, id) {
  if (!requireAccount(req, res)) return;

  try {
    const body = await parseBody(req);
    const name = normalizeText(body.name);
    const phone = normalizeText(body.phone);
    const stores = normalizeStores(body.stores);
    if (!name || !phone) {
      sendJson(res, 400, { error: "请填写店铺负责人姓名和号码" });
      return;
    }

    const db = readDb();
    const owner = db.owners.find((item) => item.id === id);
    if (!owner) {
      sendJson(res, 404, { error: "店铺负责人不存在" });
      return;
    }

    const duplicateName = db.owners.some(
      (item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicateName) {
      sendJson(res, 409, { error: "这个店铺负责人已经存在" });
      return;
    }

    const conflict = findStoreBindingConflict(db, stores, id);
    if (conflict) {
      sendJson(res, 409, { error: `店铺「${conflict.store}」已经绑定给「${conflict.owner.name}」` });
      return;
    }

    owner.name = name;
    owner.phone = phone;
    owner.stores = stores;
    owner.updatedAt = new Date().toISOString();

    writeDb(db);
    sendJson(res, 200, {
      owner: publicOwner(owner),
      owners: db.owners.map(publicOwner)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Owner update failed" });
  }
}

async function handleDeleteOwner(req, res, id) {
  if (!requireAccount(req, res)) return;

  try {
    const body = await parseBody(req);
    const db = readDb();

    if (!adminPasswordMatches(body.adminPassword, db)) {
      sendJson(res, 401, { error: "管理员密码不正确" });
      return;
    }

    const index = db.owners.findIndex((owner) => owner.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: "店铺负责人不存在" });
      return;
    }

    const [owner] = db.owners.splice(index, 1);
    writeDb(db);
    sendJson(res, 200, {
      owner: publicOwner(owner),
      owners: db.owners.map(publicOwner)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Owner delete failed" });
  }
}

async function handleVoidSample(req, res, id) {
  if (!requireAccount(req, res)) return;

  try {
    const body = await parseBody(req);
    const db = readDb();
    const sample = db.samples.find((item) => item.id === id);
    if (!sample) {
      sendJson(res, 404, { error: "Sample not found" });
      return;
    }

    sample.status = "void";
    sample.voidReason = normalizeText(body.reason) || "录入错误";
    sample.voidedAt = new Date().toISOString();
    refreshNextNumbers(db);
    writeDb(db);
    sendJson(res, 200, { sample: publicSample(sample), ...nextNumberPayload(db, sampleEnvelopeType(sample)) });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Void failed" });
  }
}

async function handleUpdateSampleImages(req, res, id) {
  if (!requireAccount(req, res)) return;

  try {
    const body = await parseBody(req);
    const db = readDb();
    const sample = db.samples.find((item) => item.id === id);
    if (!sample) {
      sendJson(res, 404, { error: "Sample not found" });
      return;
    }

    if ((sample.status || "active") === "void") {
      sendJson(res, 400, { error: "作废记录不能补图" });
      return;
    }

    if (sampleImages(sample).length) {
      sendJson(res, 400, { error: "这条记录已经有图片" });
      return;
    }

    const images = normalizeImageList([
      ...(Array.isArray(body.images) ? body.images : []),
      body.imageData
    ]);
    if (!images.length) {
      sendJson(res, 400, { error: "请选择图片" });
      return;
    }

    sample.imageData = images[0] || "";
    sample.images = images;
    sample.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { sample: publicSample(sample) });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Image update failed" });
  }
}

async function handleDeleteVoidSample(req, res, id) {
  if (!requireAdminRole(req, res)) return;

  try {
    const db = readDb();
    const index = db.samples.findIndex((item) => item.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: "Sample not found" });
      return;
    }

    const sample = db.samples[index];
    if ((sample.status || "active") !== "void") {
      sendJson(res, 400, { error: "只能删除已经作废的记录" });
      return;
    }

    const [deleted] = db.samples.splice(index, 1);
    refreshNextNumbers(db);
    writeDb(db);
    sendJson(res, 200, {
      deleted: publicSample(deleted),
      ...nextNumberPayload(db, sampleEnvelopeType(deleted))
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Delete failed" });
  }
}

async function handleImportBackup(req, res) {
  if (!requireAdminRole(req, res)) return;

  try {
    const body = await parseBody(req);
    const currentDb = readDb();
    const nextDb = normalizeBackup(body, currentDb.users);
    ensureDb();

    if (fs.existsSync(DB_FILE)) {
      const safetyFile = path.join(DATA_DIR, `samples-before-import-${timestampForFile()}.json`);
      fs.copyFileSync(DB_FILE, safetyFile);
    }

    writeDb(nextDb);
    sendJson(res, 200, {
      imported: nextDb.samples.length,
      ...nextNumberPayload(nextDb)
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Import failed" });
  }
}

async function handleCreateUser(req, res) {
  if (!requireAdminRole(req, res)) return;

  try {
    const body = await parseBody(req);
    const username = normalizeText(body.username);
    const displayName = normalizeText(body.displayName) || username;
    const password = String(body.password || "");
    const role = normalizeRole(body.role);

    if (!username || !password) {
      sendJson(res, 400, { error: "请填写账号和密码" });
      return;
    }

    const db = readDb();
    const exists = db.users.some((user) => user.username.toLowerCase() === username.toLowerCase());
    if (exists) {
      sendJson(res, 409, { error: "这个账号已经存在" });
      return;
    }

    const passwordData = hashPassword(password);
    const user = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      username,
      displayName,
      role,
      active: body.active !== false,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeDb(db);
    sendJson(res, 201, { user: publicUser(user), users: db.users.map(publicUser) });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "User save failed" });
  }
}

async function handleUpdateUser(req, res, id) {
  const actor = requireAdminRole(req, res);
  if (!actor) return;

  try {
    const body = await parseBody(req);
    const db = readDb();
    const user = db.users.find((item) => item.id === id);
    if (!user) {
      sendJson(res, 404, { error: "账号不存在" });
      return;
    }

    const nextUsername = normalizeText(body.username) || user.username;
    const duplicate = db.users.some(
      (item) => item.id !== id && item.username.toLowerCase() === nextUsername.toLowerCase()
    );
    if (duplicate) {
      sendJson(res, 409, { error: "这个账号已经存在" });
      return;
    }

    const nextRole = normalizeRole(body.role || user.role);
    const nextActive = body.active !== false && body.active !== "false";
    const activeAdminsAfter = db.users.filter((item) => {
      if (item.id === id) return nextActive && nextRole === "admin";
      return item.active !== false && item.role === "admin";
    }).length;

    if (activeAdminsAfter === 0) {
      sendJson(res, 400, { error: "至少要保留一个启用的管理员账号" });
      return;
    }

    user.username = nextUsername;
    user.displayName = normalizeText(body.displayName) || nextUsername;
    user.role = nextRole;
    user.active = nextActive;
    if (normalizeText(body.password)) {
      const passwordData = hashPassword(body.password);
      user.passwordHash = passwordData.hash;
      user.passwordSalt = passwordData.salt;
    }
    user.updatedAt = new Date().toISOString();

    writeDb(db);
    sendJson(res, 200, { user: publicUser(user), users: db.users.map(publicUser) });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "User update failed" });
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/samples") {
    sendJson(res, 200, searchSamples(url.searchParams));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    await handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    handleLogout(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = requireAccount(req, res);
    if (!user) return;
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/owners") {
    if (!requireAccount(req, res)) return;
    const db = readDb();
    sendJson(res, 200, { owners: db.owners.map(publicOwner) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    if (!requireAdminRole(req, res)) return;
    const db = readDb();
    sendJson(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/check") {
    if (!requireLegacyAdmin(req, res)) return;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/next-number") {
    if (!requireAccount(req, res)) return;
    const db = readDb();
    sendJson(res, 200, nextNumberPayload(db, url.searchParams.get("envelopeType")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backup") {
    if (!requireAccount(req, res)) return;
    sendBackup(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/samples") {
    await handleCreateSample(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/owners") {
    await handleCreateOwner(req, res);
    return;
  }

  const ownerMatch = url.pathname.match(/^\/api\/owners\/([^/]+)$/);
  if (req.method === "PATCH" && ownerMatch) {
    await handleUpdateOwner(req, res, decodeURIComponent(ownerMatch[1]));
    return;
  }

  if (req.method === "DELETE" && ownerMatch) {
    await handleDeleteOwner(req, res, decodeURIComponent(ownerMatch[1]));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    await handleCreateUser(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/backup/import") {
    await handleImportBackup(req, res);
    return;
  }

  const voidMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/void$/);
  if (req.method === "PATCH" && voidMatch) {
    await handleVoidSample(req, res, decodeURIComponent(voidMatch[1]));
    return;
  }

  const imageMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/images$/);
  if (req.method === "PATCH" && imageMatch) {
    await handleUpdateSampleImages(req, res, decodeURIComponent(imageMatch[1]));
    return;
  }

  const sampleMatch = url.pathname.match(/^\/api\/samples\/([^/]+)$/);
  if (req.method === "DELETE" && sampleMatch) {
    await handleDeleteVoidSample(req, res, decodeURIComponent(sampleMatch[1]));
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === "PATCH" && userMatch) {
    await handleUpdateUser(req, res, decodeURIComponent(userMatch[1]));
    return;
  }

  sendJson(res, 404, { error: "API not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url.pathname);
});

ensureDb();
startDailyBackupTimer();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sample label system: http://localhost:${PORT}`);
  console.log(`Readonly library: http://localhost:${PORT}/library.html`);
  console.log("Default admin account: admin / admin");
});
