const crypto = require("crypto");
const config = require("./config");
const { pool } = require("./db");
const { permissionGranted } = require("./domain");

const COOKIE_NAME = "sample_session";
const ERP_TOKEN_COOKIE_NAME = "sample_erp_token";
const DEFAULT_SAMPLE_PERMISSIONS = ["sample:view", "sample:edit"];

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((result, part) => {
    const index = part.indexOf("=");
    if (index < 0) return result;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return result;
  }, {});
}

function readCookie(req, name) {
  return parseCookies(req)[name] || "";
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function samplePermissions(permissions) {
  const values = Array.isArray(permissions) ? permissions.map(String) : [];
  return Array.from(new Set([...values, ...DEFAULT_SAMPLE_PERMISSIONS]));
}

function authError(message, status) {
  return Object.assign(new Error(message), { status });
}

function cookie(value, maxAgeSeconds) {
  const path = config.basePath || "/";
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function erpCookie(value, maxAgeSeconds) {
  const path = config.basePath || "/";
  return `${ERP_TOKEN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

async function exchangeUpstreamToken(upstreamToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.ssoUserInfoUrl, {
      headers: { Authorization: `Bearer ${upstreamToken}`, Accept: "application/json" },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200 || !payload.user) throw authError("统一登录凭证无效或已过期", 401);
    const user = {
      id: String(payload.user.userId),
      username: String(payload.user.userName || ""),
      displayName: String(payload.user.nickName || payload.user.userName || ""),
      phone: String(payload.user.phonenumber || ""),
      roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
      permissions: samplePermissions(payload.permissions)
    };
    if (!user.id || !user.username) throw authError("统一登录返回的用户信息不完整", 502);
    return user;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchShopPage(upstreamToken, page, pageSize = 100) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.erpShopUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${upstreamToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ page, pageSize, shopCode: null, shopNames: null, thirdStoreId: null, merchName: null, alipayAuthStatus: null }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200 || !payload.data || !Array.isArray(payload.data.records)) {
      throw new Error("ERP 店铺接口调用失败");
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllErpShops(upstreamToken) {
  const first = await fetchShopPage(upstreamToken, 1);
  const records = [...first.records];
  const pages = Math.min(20, Math.max(1, Number(first.pages) || Math.ceil(Number(first.total || records.length) / 100)));
  for (let page = 2; page <= pages; page += 1) records.push(...(await fetchShopPage(upstreamToken, page)).records);
  return records;
}

async function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await pool.execute(
    `INSERT INTO sso_sessions
      (token_hash,user_id,username,display_name,roles_json,permissions_json,expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [tokenHash(token), user.id, user.username, user.displayName, JSON.stringify({ values: user.roles, phone: user.phone }), JSON.stringify(user.permissions), expiresAt]
  );
  return { token, expiresAt };
}

async function currentUser(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const [rows] = await pool.execute(
    `SELECT user_id,username,display_name,roles_json,permissions_json,expires_at
       FROM sso_sessions WHERE token_hash=? AND expires_at>NOW(3)`,
    [tokenHash(raw)]
  );
  if (!rows.length) return null;
  await pool.execute("UPDATE sso_sessions SET last_seen_at=NOW(3) WHERE token_hash=?", [tokenHash(raw)]);
  const row = rows[0];
  const rolesPayload = typeof row.roles_json === "string" ? JSON.parse(row.roles_json) : row.roles_json;
  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    phone: Array.isArray(rolesPayload) ? "" : String(rolesPayload?.phone || ""),
    roles: Array.isArray(rolesPayload) ? rolesPayload : (rolesPayload?.values || []),
    permissions: samplePermissions(typeof row.permissions_json === "string" ? JSON.parse(row.permissions_json) : row.permissions_json)
  };
}

async function deleteSession(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (raw) await pool.execute("DELETE FROM sso_sessions WHERE token_hash=?", [tokenHash(raw)]);
}

function currentErpToken(req) {
  return readCookie(req, ERP_TOKEN_COOKIE_NAME);
}

function loginRedirect(req) {
  const host = req.headers.host;
  const protocol = config.trustProxy ? String(req.headers["x-forwarded-proto"] || "https").split(",")[0] : "https";
  const current = new URL(req.url, `${protocol}://${host}`);
  current.searchParams.delete("token");
  const login = new URL(config.ssoLoginUrl);
  login.searchParams.set("return_to", current.href);
  return login.href;
}

function hasPermission(user, permission) {
  return Boolean(user && permissionGranted(user.permissions, permission));
}

module.exports = {
  COOKIE_NAME,
  ERP_TOKEN_COOKIE_NAME,
  cookie,
  erpCookie,
  exchangeUpstreamToken,
  fetchAllErpShops,
  createSession,
  currentUser,
  currentErpToken,
  deleteSession,
  loginRedirect,
  hasPermission
};
