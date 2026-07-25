const fs = require("fs");
const path = require("path");

const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function intEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const basePath = String(process.env.APP_BASE_PATH || "").replace(/\/$/, "");

module.exports = {
  port: intEnv("PORT", 8080),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:8080",
  basePath,
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: intEnv("MYSQL_PORT", 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "sample_management",
    connectionLimit: intEnv("MYSQL_CONNECTION_LIMIT", 10),
    charset: "utf8mb4"
  },
  ssoLoginUrl: process.env.SSO_LOGIN_URL || "https://auth.qiyinbz.com/",
  ssoUserInfoUrl: process.env.SSO_USERINFO_URL || "https://private.qiyinbz.com:41287/permission-api/getInfoV2",
  erpShopUrl: process.env.ERP_SHOP_URL || "https://private.qiyinbz.com:41287/erp-api/shop/getErpShopList",
  sessionTtlMs: intEnv("SESSION_TTL_HOURS", 8) * 60 * 60 * 1000,
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || "uploads"),
  trustProxy: process.env.TRUST_PROXY === "true"
};
