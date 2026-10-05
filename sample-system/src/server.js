const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const config = require("./config");
const { pool, transaction } = require("./db");
const auth = require("./auth");
const { STATUS_LABELS, NEXT_STATUS, canTransition, sampleCode, packagingSampleCode } = require("./domain");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_BODY = 30 * 1024 * 1024;
const IMAGE_TYPES = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/jpg", ".jpg"], ["image/webp", ".webp"]]);

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function createSessionFromUpstreamCookie(req) {
  const upstream = auth.currentUpstreamToken(req);
  if (!upstream) return null;
  try {
    const user = await auth.exchangeUpstreamToken(upstream);
    const session = await auth.createSession(user);
    const maxAge = Math.floor(config.sessionTtlMs / 1000);
    return {
      user,
      cookies: [auth.cookie(session.token, maxAge), auth.erpCookie(upstream, maxAge)]
    };
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求内容过大"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("JSON 格式无效"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function text(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function actorFields(user) {
  return [user.id, user.username, user.displayName];
}

function booleanValue(value) {
  return value === true || value === 1 || value === "1" || value === "on";
}

function normalizeCategory(value) {
  const item = text(value, 50);
  return item === "十五懂印刷厂" ? "十五栋印刷厂" : item;
}

function categoriesValue(value) {
  const allowed = new Set(["彩盒类", "纸卡类", "十五栋印刷厂", "纸袋", "色样", "礼盒", "内衬", "迈高礼盒厂"]);
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(normalizeCategory).filter((item) => allowed.has(item)))];
}

function sampleLookupFields(source) {
  return {
    orderNumber: text(source.orderNumber ?? source.order_number, 100),
    plateNumber: text(source.plateNumber ?? source.plate_number, 1000)
  };
}

function assertSampleLookupFields(fields) {
  if (!fields.orderNumber && !fields.plateNumber) {
    throw Object.assign(new Error("请填写订单号或版号"), { status: 400 });
  }
}

function publicSample(row) {
  return {
    id: String(row.id), sampleNumber: row.sample_number, sampleCode: row.sample_code,
    sampleType: row.sample_type || "label", envelopeType: row.envelope_type, plateNumber: row.plate_number, customerName: row.customer_name,
    storeName: row.store_name, erpShopId: row.erp_shop_id ? String(row.erp_shop_id) : "",
    erpShopCode: row.erp_shop_code || "", ownerName: row.owner_name, ownerPhone: row.owner_phone,
    customerId: row.customer_id || "", orderNumber: row.order_number || "",
    sampleCategories: (Array.isArray(row.sample_categories) ? row.sample_categories : JSON.parse(row.sample_categories || "[]")).map(normalizeCategory),
    contentChanged: Boolean(row.content_changed), colorChanged: Boolean(row.color_changed),
    specificationChanged: Boolean(row.specification_changed), boxTypeChanged: Boolean(row.box_type_changed),
    sampleContent: row.sample_content || "", sampleSpecification: row.sample_specification || "", sampleColor: row.sample_color || "",
    reservedField1: row.reserved_field_1 || "", reservedField2: row.reserved_field_2 || "", reservedField3: row.reserved_field_3 || "",
    note: row.note, status: row.status, statusLabel: STATUS_LABELS[row.status], voidReason: row.void_reason,
    createdByUserId: row.created_by_id, createdByUsername: row.created_by_username,
    createdByName: row.created_by_name, createdAt: row.created_at,
    createdByPhone: row.created_by_phone || "",
    updatedByUserId: row.updated_by_id, updatedByUsername: row.updated_by_username,
    updatedByName: row.updated_by_name, updatedAt: row.updated_at,
    imageCount: Number(row.image_count || 0), imageIds: row.image_ids ? String(row.image_ids).split(",").filter(Boolean) : [],
    nextStatus: NEXT_STATUS[row.status] || null
  };
}

async function logOperation(connection, sampleId, action, user, fromStatus, toStatus, summary) {
  await connection.execute(
    `INSERT INTO sample_operation_logs
      (sample_id,action,from_status,to_status,change_summary,operator_id,operator_username,operator_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sampleId, action, fromStatus || null, toStatus || null, summary ? JSON.stringify(summary) : null, ...actorFields(user)]
  );
}

async function requireUser(req, res, permission = "sample:view") {
  const user = await auth.currentUser(req);
  if (!user) { sendError(res, 401, "登录已失效"); return null; }
  if (!auth.hasPermission(user, permission)) { sendError(res, 403, "没有执行此操作的权限"); return null; }
  return user;
}

function verifyOrigin(req) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin || origin === config.appOrigin) return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "qiyinbz.com" || hostname.endsWith(".qiyinbz.com");
  } catch {
    return false;
  }
}

function chinaTodayRange(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000;
  return [new Date(start), new Date(start + 24 * 60 * 60 * 1000)];
}

async function listSamples(url, res) {
  const q = text(url.searchParams.get("q"), 255);
  const status = text(url.searchParams.get("status"), 20);
  const createdDate = text(url.searchParams.get("createdDate"), 10);
  const scope = text(url.searchParams.get("scope"), 20);
  const sampleType = text(url.searchParams.get("sampleType"), 20);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
  const clauses = [];
  const params = [];
  if (q) {
    clauses.push(`(s.sample_code LIKE ? OR s.plate_number LIKE ? OR s.customer_name LIKE ? OR s.store_name LIKE ? OR s.owner_name LIKE ? OR s.owner_phone LIKE ? OR s.customer_id LIKE ? OR s.order_number LIKE ?)`);
    for (let i = 0; i < 8; i += 1) params.push(`%${q}%`);
  }
  if (scope === "draft") clauses.push("s.status='draft'");
  else if (scope === "library") clauses.push("s.status<>'draft'");
  if (["label", "packaging"].includes(sampleType)) { clauses.push("s.sample_type=?"); params.push(sampleType); }
  if (STATUS_LABELS[status] && scope !== "draft") { clauses.push("s.status=?"); params.push(status); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(createdDate)) {
    const start = new Date(`${createdDate}T00:00:00+08:00`);
    if (!Number.isNaN(start.getTime())) { clauses.push("s.created_at>=? AND s.created_at<?"); params.push(start, new Date(start.getTime() + 86400000)); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [[count]] = await pool.query(`SELECT COUNT(*) total FROM samples s ${where}`, params);
  const [rows] = await pool.query(
    `SELECT s.*,
            COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(l.change_summary,'$.createdByPhone'))
                        FROM sample_operation_logs l
                       WHERE l.sample_id=s.id AND l.action='create'
                       ORDER BY l.id ASC LIMIT 1),'') created_by_phone,
            COUNT(i.id) image_count,GROUP_CONCAT(i.id ORDER BY i.sort_order) image_ids
       FROM samples s LEFT JOIN sample_images i ON i.sample_id=s.id
       ${where} GROUP BY s.id ORDER BY s.sample_number DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  sendJson(res, 200, { samples: rows.map(publicSample), total: Number(count.total), page, pageSize, statuses: STATUS_LABELS });
}

async function sampleCounts(url, res) {
  const q = text(url.searchParams.get("q"), 255);
  const status = text(url.searchParams.get("status"), 20);
  const createdDate = text(url.searchParams.get("createdDate"), 10);
  const fallback = url.searchParams.get("fallback") === "previousNonEmpty";
  const validStatus = STATUS_LABELS[status] ? status : "";

  const countForDate = async (dateValue) => {
    const clauses = [];
    const params = [];
    if (q) {
      clauses.push(`(s.sample_code LIKE ? OR s.plate_number LIKE ? OR s.customer_name LIKE ? OR s.store_name LIKE ? OR s.owner_name LIKE ? OR s.owner_phone LIKE ? OR s.customer_id LIKE ? OR s.order_number LIKE ?)`);
      for (let i = 0; i < 8; i += 1) params.push(`%${q}%`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue || "")) {
      const start = new Date(`${dateValue}T00:00:00+08:00`);
      if (!Number.isNaN(start.getTime())) {
        clauses.push("s.created_at>=? AND s.created_at<?");
        params.push(start, new Date(start.getTime() + 86400000));
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const libraryStatusSql = validStatus ? " AND s.status=?" : "";
    const statusParams = validStatus ? [validStatus, validStatus, validStatus] : [];
    const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(status='draft'),0) draft_count,
            COALESCE(SUM(status<>'draft' AND sample_type='label'${libraryStatusSql}),0) label_library_count,
            COALESCE(SUM(status<>'draft' AND sample_type='packaging'${libraryStatusSql}),0) packaging_library_count,
            COALESCE(SUM(status<>'draft'${libraryStatusSql}),0) library_count
       FROM samples s ${where}`,
      [...statusParams, ...params]
    );
    return row;
  };

  let effectiveDate = createdDate;
  let row = await countForDate(effectiveDate);
  let total = Number(row.draft_count) + Number(row.library_count);

  if (fallback && /^\d{4}-\d{2}-\d{2}$/.test(createdDate) && total <= 0) {
    const clauses = [];
    const params = [];
    if (q) {
      clauses.push(`(s.sample_code LIKE ? OR s.plate_number LIKE ? OR s.customer_name LIKE ? OR s.store_name LIKE ? OR s.owner_name LIKE ? OR s.owner_phone LIKE ? OR s.customer_id LIKE ? OR s.order_number LIKE ?)`);
      for (let i = 0; i < 8; i += 1) params.push(`%${q}%`);
    }
    clauses.push("DATE(s.created_at)<=?");
    params.push(createdDate);
    if (validStatus) clauses.push("(s.status='draft' OR (s.status<>'draft' AND s.status=?))"), params.push(validStatus);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const [[latest]] = await pool.query(`SELECT DATE_FORMAT(MAX(DATE(s.created_at)),'%Y-%m-%d') effective_date FROM samples s ${where}`, params);
    if (latest?.effective_date) {
      effectiveDate = latest.effective_date;
      row = await countForDate(effectiveDate);
      total = Number(row.draft_count) + Number(row.library_count);
    }
  }

  sendJson(res, 200, {
    draft: Number(row.draft_count),
    library: Number(row.library_count),
    labelLibrary: Number(row.label_library_count),
    packagingLibrary: Number(row.packaging_library_count),
    total,
    effectiveDate
  });
}

async function getSampleRowByWhere(where, params) {
  const [rows] = await pool.execute(
    `SELECT s.*,
            COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(l.change_summary,'$.createdByPhone')) FROM sample_operation_logs l WHERE l.sample_id=s.id AND l.action='create' ORDER BY l.id ASC LIMIT 1),'') created_by_phone,
            (SELECT COUNT(*) FROM sample_images i WHERE i.sample_id=s.id) image_count,
            (SELECT GROUP_CONCAT(i.id ORDER BY i.sort_order) FROM sample_images i WHERE i.sample_id=s.id) image_ids
       FROM samples s WHERE ${where}`, params
  );
  return rows[0] || null;
}

async function getSample(res, id) {
  const row = await getSampleRowByWhere("s.id=?", [id]);
  if (!row) return sendError(res, 404, "样品不存在");
  sendJson(res, 200, { sample: publicSample(row) });
}

async function lookupSample(url, res) {
  const q = text(url.searchParams.get("q"), 255);
  const fields = sampleLookupFields({
    orderNumber: url.searchParams.get("orderNumber") ?? url.searchParams.get("order"),
    plateNumber: url.searchParams.get("plateNumber") ?? url.searchParams.get("plate")
  });
  const clauses = [];
  const params = [];
  if (q) {
    clauses.push(`(CAST(s.id AS CHAR) LIKE ? OR CAST(s.sample_number AS CHAR) LIKE ? OR s.sample_code LIKE ? OR s.plate_number LIKE ? OR s.customer_name LIKE ? OR s.store_name LIKE ? OR s.owner_name LIKE ? OR s.owner_phone LIKE ? OR s.customer_id LIKE ? OR s.order_number LIKE ?)`);
    for (let i = 0; i < 10; i += 1) params.push(`%${q}%`);
  } else {
    assertSampleLookupFields(fields);
    if (fields.orderNumber) { clauses.push("s.order_number LIKE ?"); params.push(`%${fields.orderNumber}%`); }
    if (fields.plateNumber) { clauses.push("s.plate_number LIKE ?"); params.push(`%${fields.plateNumber}%`); }
  }
  const [rows] = await pool.execute(
    `SELECT s.*,
            COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(l.change_summary,'$.createdByPhone')) FROM sample_operation_logs l WHERE l.sample_id=s.id AND l.action='create' ORDER BY l.id ASC LIMIT 1),'') created_by_phone,
            (SELECT COUNT(*) FROM sample_images i WHERE i.sample_id=s.id) image_count,
            (SELECT GROUP_CONCAT(i.id ORDER BY i.sort_order) FROM sample_images i WHERE i.sample_id=s.id) image_ids
       FROM samples s
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.updated_at DESC,s.sample_number DESC
      LIMIT 50`,
    params
  );
  sendJson(res, 200, { samples: rows.map(publicSample) });
}

async function serveSampleQr(res, id, autoClaim) {
  const [rows] = await pool.execute("SELECT id FROM samples WHERE id=?", [id]);
  if (!rows.length) return sendError(res, 404, "样品不存在");
  const target = new URL(`${config.basePath}/detail.html`, config.appOrigin);
  target.searchParams.set("id", id);
  if (autoClaim) target.searchParams.set("autoClaim", "true");
  const png = await QRCode.toBuffer(target.href, { type: "png", errorCorrectionLevel: "M", margin: 4, width: 512 });
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "private, max-age=3600" });
  res.end(png);
}

async function nextSampleCode(url, res) {
  const sampleType = url.searchParams.get("sampleType") === "packaging" ? "packaging" : "label";
  if (sampleType === "packaging") {
    const [rows] = await pool.execute("SELECT next_number FROM sample_code_sequences WHERE sequence_key='packaging'");
    if (!rows.length) throw Object.assign(new Error("包装编号序列未初始化，请先执行迁移"), { status: 500 });
    return sendJson(res, 200, { sampleType, nextNumber: Number(rows[0].next_number), nextCode: packagingSampleCode(rows[0].next_number) });
  }
  const envelopeType = ["small", "large", "none"].includes(url.searchParams.get("envelopeType")) ? url.searchParams.get("envelopeType") : "small";
  const [rows] = await pool.execute("SELECT next_number FROM number_sequences WHERE envelope_type=?", [envelopeType]);
  if (!rows.length) throw Object.assign(new Error("编号序列未初始化"), { status: 500 });
  sendJson(res, 200, { sampleType, envelopeType, nextNumber: Number(rows[0].next_number), nextCode: sampleCode(rows[0].next_number, envelopeType) });
}

async function createSample(req, res, user) {
  const body = await bodyJson(req);
  const envelopeType = ["small", "large", "none"].includes(body.envelopeType) ? body.envelopeType : "small";
  const sampleType = body.sampleType === "packaging" ? "packaging" : "label";
  const lookup = sampleLookupFields(body);
  const plateNumber = lookup.plateNumber;
  const customerName = text(body.customerName, 255);
  let storeName = text(body.storeName, 255);
  let ownerName = text(body.ownerName, 100);
  let ownerPhone = text(body.ownerPhone, 50);
  const erpShopId = Number(body.erpShopId);
  const sampleCategories = categoriesValue(body.sampleCategories);
  let erpShopCode = "";
  const upstreamToken = auth.currentErpToken(req);
  assertSampleLookupFields(lookup);
  if (!customerName) throw Object.assign(new Error("请填写客户名"), { status: 400 });
  let selectedShop = null;
  if (Number.isInteger(erpShopId) && erpShopId > 0) {
    if (!upstreamToken) throw Object.assign(new Error("店铺凭证已失效，请重新登录"), { status: 401 });
    const shops = await auth.fetchAllErpShops(upstreamToken);
    selectedShop = shops.find((item) => Number(item.id) === erpShopId) || null;
    if (!selectedShop) throw Object.assign(new Error("所选 ERP 店铺不存在，请刷新店铺列表"), { status: 400 });
  }

  const result = await transaction(async (connection) => {
    if (selectedShop) {
      storeName = selectedShop.shopName;
      erpShopCode = selectedShop.shopCode;
      ownerName = selectedShop.storeManagerName || "未设置管理员";
      ownerPhone = selectedShop.mobile;
    } else if (storeName) {
      const [owners] = await connection.execute(
        `SELECT o.name,o.phone FROM owner_stores os JOIN owners o ON o.id=os.owner_id WHERE os.store_key=?`,
        [storeName.toLowerCase()]
      );
      if (owners.length) { ownerName = owners[0].name; ownerPhone = owners[0].phone; }
    }
    if (!storeName || !ownerName || !ownerPhone) throw Object.assign(new Error("请选择包含店铺管理员和联系电话的 ERP 店铺"), { status: 400 });
    const [sequences] = sampleType === "packaging"
      ? await connection.execute("SELECT next_number FROM sample_code_sequences WHERE sequence_key='packaging' FOR UPDATE")
      : await connection.execute("SELECT next_number FROM number_sequences WHERE envelope_type=? FOR UPDATE", [envelopeType]);
    if (!sequences.length) throw new Error(sampleType === "packaging" ? "包装编号序列未初始化，请先执行迁移" : "编号序列未初始化，请先执行迁移");
    const number = sequences[0].next_number;
    if (sampleType === "packaging") await connection.execute("UPDATE sample_code_sequences SET next_number=next_number+1 WHERE sequence_key='packaging'");
    else await connection.execute("UPDATE number_sequences SET next_number=next_number+1 WHERE envelope_type=?", [envelopeType]);
    const code = sampleType === "packaging" ? packagingSampleCode(number) : sampleCode(number, envelopeType);
    const [insert] = await connection.execute(
      `INSERT INTO samples
       (sample_number,sample_code,sample_type,envelope_type,plate_number,customer_name,store_name,erp_shop_id,erp_shop_code,owner_name,owner_phone,
        customer_id,order_number,sample_categories,content_changed,color_changed,specification_changed,box_type_changed,
        sample_content,sample_specification,sample_color,reserved_field_1,reserved_field_2,reserved_field_3,note,status,
        created_by_id,created_by_username,created_by_name,updated_by_id,updated_by_username,updated_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`,
      [number, code, sampleType, envelopeType, plateNumber, customerName, storeName,
        Number.isInteger(erpShopId) && erpShopId > 0 ? erpShopId : null, erpShopCode,
        ownerName, ownerPhone, customerName, lookup.orderNumber, JSON.stringify(sampleCategories),
        booleanValue(body.contentChanged), booleanValue(body.colorChanged), booleanValue(body.specificationChanged), booleanValue(body.boxTypeChanged),
        text(body.sampleContent, 5000), text(body.sampleSpecification, 5000), text(body.sampleColor, 5000),
        text(body.reservedField1, 500), text(body.reservedField2, 500), text(body.reservedField3, 500), text(body.note || body.packagingNote, 5000),
        ...actorFields(user), ...actorFields(user)]
    );
    await logOperation(connection, insert.insertId, "create", user, null, "draft", { sampleCode: code, createdByPhone: user.phone || "" });
    return { id: insert.insertId, code };
  });
  sendJson(res, 201, result);
}

async function updateSample(req, res, user, id) {
  const body = await bodyJson(req);
  const result = await transaction(async (connection) => {
    const [rows] = await connection.execute("SELECT * FROM samples WHERE id=? FOR UPDATE", [id]);
    if (!rows.length) throw Object.assign(new Error("样品不存在"), { status: 404 });
    const old = rows[0];
    if (["void", "completed"].includes(old.status)) throw Object.assign(new Error("终态样品不能修改"), { status: 409 });
    if ("orderNumber" in body || "plateNumber" in body) {
      assertSampleLookupFields(sampleLookupFields({
        orderNumber: "orderNumber" in body ? body.orderNumber : old.order_number,
        plateNumber: "plateNumber" in body ? body.plateNumber : old.plate_number
      }));
    }
    const changes = {};
    const mapping = { plateNumber: ["plate_number", 1000], customerName: ["customer_name", 255], storeName: ["store_name", 255], ownerName: ["owner_name", 100], ownerPhone: ["owner_phone", 50], customerId: ["customer_id", 100], orderNumber: ["order_number", 100], sampleContent: ["sample_content", 5000], sampleSpecification: ["sample_specification", 5000], sampleColor: ["sample_color", 5000], reservedField1: ["reserved_field_1", 500], reservedField2: ["reserved_field_2", 500], reservedField3: ["reserved_field_3", 500], note: ["note", 5000] };
    const sets = [];
    const params = [];
    for (const [key, [column, max]] of Object.entries(mapping)) {
      if (!(key in body)) continue;
      const value = text(body[key], max);
      if (value !== old[column]) { sets.push(`${column}=?`); params.push(value); changes[key] = { from: old[column], to: value }; }
    }
    if ("erpShopId" in body) {
      const erpShopId = Number(body.erpShopId);
      const value = Number.isInteger(erpShopId) && erpShopId > 0 ? erpShopId : null;
      if (value !== old.erp_shop_id) { sets.push("erp_shop_id=?"); params.push(value); changes.erpShopId = { from: old.erp_shop_id, to: value }; }
    }
    if ("erpShopCode" in body) {
      const value = text(body.erpShopCode, 100);
      if (value !== old.erp_shop_code) { sets.push("erp_shop_code=?"); params.push(value); changes.erpShopCode = { from: old.erp_shop_code, to: value }; }
    }
    if ("sampleCategories" in body) {
      const value = JSON.stringify(categoriesValue(body.sampleCategories));
      const oldCategories = Array.isArray(old.sample_categories) ? old.sample_categories : JSON.parse(old.sample_categories || "[]");
      if (value !== JSON.stringify(oldCategories.map(normalizeCategory))) { sets.push("sample_categories=?"); params.push(value); changes.sampleCategories = true; }
    }
    for (const [key, column] of Object.entries({ contentChanged: "content_changed", colorChanged: "color_changed", specificationChanged: "specification_changed", boxTypeChanged: "box_type_changed" })) {
      if (!(key in body)) continue;
      const value = booleanValue(body[key]) ? 1 : 0;
      if (value !== Number(old[column])) { sets.push(`${column}=?`); params.push(value); changes[key] = { from: Boolean(old[column]), to: Boolean(value) }; }
    }
    if (!sets.length) return { unchanged: true };
    sets.push("updated_by_id=?", "updated_by_username=?", "updated_by_name=?", "updated_at=NOW(3)");
    params.push(...actorFields(user), id);
    await connection.execute(`UPDATE samples SET ${sets.join(",")} WHERE id=?`, params);
    await logOperation(connection, id, "update", user, old.status, old.status, changes);
    return { updated: true };
  });
  sendJson(res, 200, result);
}

async function transitionSample(req, res, user, id) {
  const body = await bodyJson(req);
  const target = text(body.status, 20);
  const result = await transaction(async (connection) => {
    const [rows] = await connection.execute("SELECT status FROM samples WHERE id=? FOR UPDATE", [id]);
    if (!rows.length) throw Object.assign(new Error("样品不存在"), { status: 404 });
    const from = rows[0].status;
    if (!canTransition(from, target)) throw Object.assign(new Error(`不允许从“${STATUS_LABELS[from]}”转为“${STATUS_LABELS[target] || target}”`), { status: 409 });
    const reason = target === "void" ? text(body.reason, 1000) : "";
    if (target === "void" && !reason) throw Object.assign(new Error("作废必须填写原因"), { status: 400 });
    await connection.execute(
      `UPDATE samples SET status=?,void_reason=?,updated_by_id=?,updated_by_username=?,updated_by_name=?,updated_at=NOW(3) WHERE id=?`,
      [target, reason, ...actorFields(user), id]
    );
    await logOperation(connection, id, "status_change", user, from, target, reason ? { reason } : null);
    return { status: target, statusLabel: STATUS_LABELS[target] };
  });
  sendJson(res, 200, result);
}

async function claimSample(res, user, id) {
  const result = await transaction(async (connection) => {
    const [rows] = await connection.execute("SELECT status,updated_by_id,updated_by_name FROM samples WHERE id=? FOR UPDATE", [id]);
    if (!rows.length) throw Object.assign(new Error("样品不存在"), { status: 404 });
    const from = rows[0].status;
    if (!["printed", "claimed"].includes(from)) throw Object.assign(new Error(`“${STATUS_LABELS[from]}”状态不能领用`), { status: 409 });
    if (from === "claimed" && rows[0].updated_by_id === user.id) {
      await logOperation(connection, id, "status_change", user, "claimed", "claimed", { repeatedClaim: true });
      return { status: "claimed", statusLabel: STATUS_LABELS.claimed, transferred: false };
    }
    await connection.execute("UPDATE samples SET status='claimed',updated_by_id=?,updated_by_username=?,updated_by_name=?,updated_at=NOW(3) WHERE id=?", [...actorFields(user), id]);
    await logOperation(connection, id, "status_change", user, from, "claimed", { transfer: from === "claimed", previousHolder: rows[0].updated_by_name || "" });
    return { status: "claimed", statusLabel: STATUS_LABELS.claimed, transferred: from === "claimed" };
  });
  sendJson(res, 200, result);
}

function decodeImage(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || !IMAGE_TYPES.has(match[1].toLowerCase())) throw Object.assign(new Error("图片格式无效"), { status: 400 });
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw Object.assign(new Error("单张图片不能超过 2MB"), { status: 400 });
  return { mime: match[1].toLowerCase().replace("image/jpg", "image/jpeg"), buffer };
}

async function addImage(req, res, user, sampleId) {
  const body = await bodyJson(req);
  const image = decodeImage(body.imageData);
  await fsp.mkdir(config.uploadDir, { recursive: true, mode: 0o750 });
  const filename = `${crypto.randomUUID()}${IMAGE_TYPES.get(image.mime)}`;
  const finalPath = path.join(config.uploadDir, filename);
  const tempPath = `${finalPath}.tmp`;
  await fsp.writeFile(tempPath, image.buffer, { mode: 0o640 });
  try {
    const imageId = await transaction(async (connection) => {
      const [samples] = await connection.execute("SELECT status FROM samples WHERE id=? FOR UPDATE", [sampleId]);
      if (!samples.length) throw Object.assign(new Error("样品不存在"), { status: 404 });
      if (["void", "completed"].includes(samples[0].status)) throw Object.assign(new Error("终态样品不能增加图片"), { status: 409 });
      const [[count]] = await connection.execute("SELECT COUNT(*) total,COALESCE(MAX(sort_order),-1) max_order FROM sample_images WHERE sample_id=?", [sampleId]);
      if (Number(count.total) >= 12) throw Object.assign(new Error("每条样品最多 12 张图片"), { status: 409 });
      await fsp.rename(tempPath, finalPath);
      const [insert] = await connection.execute(
        "INSERT INTO sample_images (sample_id,storage_path,mime_type,byte_size,sort_order,created_by_id) VALUES (?,?,?,?,?,?)",
        [sampleId, filename, image.mime, image.buffer.length, Number(count.max_order) + 1, user.id]
      );
      await logOperation(connection, sampleId, "image_add", user, samples[0].status, samples[0].status, { imageId: String(insert.insertId) });
      return insert.insertId;
    });
    sendJson(res, 201, { id: String(imageId) });
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    await fsp.rm(finalPath, { force: true });
    throw error;
  }
}

async function deleteImage(res, user, imageId) {
  const result = await transaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT i.sample_id,i.storage_path,s.status FROM sample_images i
       JOIN samples s ON s.id=i.sample_id WHERE i.id=? FOR UPDATE`, [imageId]
    );
    if (!rows.length) throw Object.assign(new Error("图片不存在"), { status: 404 });
    if (["void", "completed"].includes(rows[0].status)) throw Object.assign(new Error("终态样品不能删除图片"), { status: 409 });
    await connection.execute("DELETE FROM sample_images WHERE id=?", [imageId]);
    await logOperation(connection, rows[0].sample_id, "image_delete", user, rows[0].status, rows[0].status, { imageId: String(imageId) });
    return rows[0];
  });
  await fsp.rm(path.join(config.uploadDir, result.storage_path), { force: true });
  sendJson(res, 200, { ok: true });
}

async function recordPrint(res, user, sampleId, reprint) {
  const result = await transaction(async (connection) => {
    const [rows] = await connection.execute("SELECT status,updated_by_id,updated_by_name FROM samples WHERE id=? FOR UPDATE", [sampleId]);
    if (!rows.length) throw Object.assign(new Error("样品不存在"), { status: 404 });
    if (rows[0].status === "void") throw Object.assign(new Error("作废样品不能打印"), { status: 409 });
    const from = rows[0].status;
    await connection.execute(
      "UPDATE samples SET status='claimed',updated_by_id=?,updated_by_username=?,updated_by_name=?,updated_at=NOW(3) WHERE id=?",
      [...actorFields(user), sampleId]
    );
    await logOperation(connection, sampleId, reprint || from !== "draft" ? "reprint" : "print", user, from, from === "draft" ? "printed" : from, null);
    await logOperation(connection, sampleId, "status_change", user, from === "draft" ? "printed" : from, "claimed", { byPrint: true, transfer: from === "claimed" && rows[0].updated_by_id !== user.id, previousHolder: rows[0].updated_by_name || "" });
    return { status: "claimed", statusLabel: STATUS_LABELS.claimed };
  });
  sendJson(res, 200, result);
}

async function listOperations(res, sampleId) {
  const [rows] = await pool.execute(
    `SELECT id,action,from_status,to_status,change_summary,operator_id,operator_username,operator_name,operated_at
       FROM sample_operation_logs WHERE sample_id=? ORDER BY operated_at DESC,id DESC`, [sampleId]
  );
  sendJson(res, 200, { operations: rows.map((row) => ({
    id: String(row.id), action: row.action, fromStatus: row.from_status, toStatus: row.to_status,
    summary: row.change_summary, operatorId: row.operator_id, operatorUsername: row.operator_username,
    operatorName: row.operator_name, operatedAt: row.operated_at
  })) });
}

async function listOwners(res) {
  const [rows] = await pool.query(
    `SELECT o.id,o.name,o.phone,o.created_at,o.updated_at,GROUP_CONCAT(os.store_name ORDER BY os.store_name SEPARATOR '\n') stores
       FROM owners o LEFT JOIN owner_stores os ON os.owner_id=o.id GROUP BY o.id ORDER BY o.name`
  );
  sendJson(res, 200, { owners: rows.map((row) => ({ id: String(row.id), name: row.name, phone: row.phone, stores: row.stores ? row.stores.split("\n") : [], createdAt: row.created_at, updatedAt: row.updated_at })) });
}

async function listSampleHoldings(res) {
  const [rows] = await pool.query(
    `SELECT user_id,user_username,user_name,
            SUM(claimed_count) claimed_count,
            SUM(printed_count) printed_count,
            MAX(last_updated_at) last_updated_at
       FROM (
             SELECT updated_by_id user_id,updated_by_username user_username,updated_by_name user_name,
                    COUNT(*) claimed_count,0 printed_count,MAX(updated_at) last_updated_at
               FROM samples
              WHERE status='claimed'
              GROUP BY updated_by_id,updated_by_username,updated_by_name
             UNION ALL
             SELECT operator_id user_id,operator_username user_username,operator_name user_name,
                    0 claimed_count,COUNT(DISTINCT sample_id) printed_count,MAX(operated_at) last_updated_at
               FROM sample_operation_logs
              WHERE action IN ('print','reprint')
              GROUP BY operator_id,operator_username,operator_name
            ) holdings
      GROUP BY user_id,user_username,user_name
     HAVING claimed_count > 0 OR printed_count > 0
      ORDER BY claimed_count DESC,printed_count DESC,last_updated_at DESC`
  );
  sendJson(res, 200, { holdings: rows.map((row) => ({
    userId: row.user_id,
    username: row.user_username,
    displayName: row.user_name,
    total: Number(row.claimed_count),
    draft: 0,
    printed: Number(row.printed_count),
    claimed: Number(row.claimed_count),
    sent: 0,
    lastUpdatedAt: row.last_updated_at
  })) });
}

async function listHoldingSamples(url, res) {
  const userId = text(url.searchParams.get("userId"), 64);
  const status = text(url.searchParams.get("status"), 20);
  if (!userId) return sendError(res, 400, "缺少人员 ID");
  if (status === "printed") {
    const [rows] = await pool.execute(
      `SELECT s.*,
              COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(cl.change_summary,'$.createdByPhone'))
                          FROM sample_operation_logs cl
                         WHERE cl.sample_id=s.id AND cl.action='create'
                         ORDER BY cl.id ASC LIMIT 1),'') created_by_phone,
              (SELECT COUNT(*) FROM sample_images i WHERE i.sample_id=s.id) image_count,
              (SELECT GROUP_CONCAT(i.id ORDER BY i.sort_order) FROM sample_images i WHERE i.sample_id=s.id) image_ids
         FROM samples s
         JOIN (
               SELECT sample_id,MAX(operated_at) printed_at
                 FROM sample_operation_logs
                WHERE operator_id=? AND action IN ('print','reprint')
                GROUP BY sample_id
              ) p ON p.sample_id=s.id
        ORDER BY p.printed_at DESC,s.sample_number DESC
        LIMIT 200`,
      [userId]
    );
    return sendJson(res, 200, { samples: rows.map(publicSample) });
  }
  const clauses = ["s.updated_by_id=?", "s.status='claimed'"];
  const params = [userId];
  if (status && status !== "claimed") return sendJson(res, 200, { samples: [] });
  const [rows] = await pool.execute(
    `SELECT s.*,
            COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(l.change_summary,'$.createdByPhone'))
                        FROM sample_operation_logs l
                       WHERE l.sample_id=s.id AND l.action='create'
                       ORDER BY l.id ASC LIMIT 1),'') created_by_phone,
            (SELECT COUNT(*) FROM sample_images i WHERE i.sample_id=s.id) image_count,
            (SELECT GROUP_CONCAT(i.id ORDER BY i.sort_order) FROM sample_images i WHERE i.sample_id=s.id) image_ids
       FROM samples s
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.updated_at DESC,s.sample_number DESC
      LIMIT 200`,
    params
  );
  sendJson(res, 200, { samples: rows.map(publicSample) });
}

async function listTodayClaimRecords(res, user) {
  const [start, end] = chinaTodayRange();
  const [rows] = await pool.execute(
    `SELECT l.id,l.from_status,l.to_status,l.change_summary,l.operated_at,s.*
       FROM sample_operation_logs l
       JOIN samples s ON s.id=l.sample_id
      WHERE l.operator_id=? AND l.action='status_change' AND l.to_status='claimed'
        AND l.operated_at>=? AND l.operated_at<?
      ORDER BY l.operated_at DESC,l.id DESC
      LIMIT 300`,
    [user.id, start, end]
  );
  sendJson(res, 200, { records: rows.map((row) => ({
    id: String(row.id),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    operatedAt: row.operated_at,
    summary: row.change_summary,
    sample: publicSample(row)
  })) });
}

async function createOwner(req, res) {
  const body = await bodyJson(req);
  const name = text(body.name, 100), phone = text(body.phone, 50);
  const stores = [...new Set((Array.isArray(body.stores) ? body.stores : String(body.stores || "").split(/[\n,，;；]+/)).map((v) => text(v, 255)).filter(Boolean))];
  if (!name || !phone) throw Object.assign(new Error("请填写负责人姓名和电话"), { status: 400 });
  const id = await transaction(async (connection) => {
    const [insert] = await connection.execute("INSERT INTO owners (name,phone) VALUES (?,?)", [name, phone]);
    for (const store of stores) await connection.execute("INSERT INTO owner_stores (owner_id,store_name,store_key) VALUES (?,?,?)", [insert.insertId, store, store.toLowerCase()]);
    return insert.insertId;
  });
  sendJson(res, 201, { id: String(id) });
}

async function updateOwner(req, res, ownerId) {
  const body = await bodyJson(req);
  const name = text(body.name, 100), phone = text(body.phone, 50);
  const stores = [...new Set((Array.isArray(body.stores) ? body.stores : String(body.stores || "").split(/[\n,，;；]+/)).map((v) => text(v, 255)).filter(Boolean))];
  if (!name || !phone) throw Object.assign(new Error("请填写负责人姓名和电话"), { status: 400 });
  await transaction(async (connection) => {
    const [result] = await connection.execute("UPDATE owners SET name=?,phone=?,updated_at=NOW(3) WHERE id=?", [name, phone, ownerId]);
    if (!result.affectedRows) throw Object.assign(new Error("负责人不存在"), { status: 404 });
    await connection.execute("DELETE FROM owner_stores WHERE owner_id=?", [ownerId]);
    for (const store of stores) await connection.execute("INSERT INTO owner_stores (owner_id,store_name,store_key) VALUES (?,?,?)", [ownerId, store, store.toLowerCase()]);
  });
  sendJson(res, 200, { ok: true });
}

async function deleteOwner(res, ownerId) {
  const [result] = await pool.execute("DELETE FROM owners WHERE id=?", [ownerId]);
  if (!result.affectedRows) return sendError(res, 404, "负责人不存在");
  sendJson(res, 200, { ok: true });
}

async function exportBackup(res) {
  const [samples] = await pool.query("SELECT * FROM samples ORDER BY id");
  const [images] = await pool.query("SELECT * FROM sample_images ORDER BY sample_id,sort_order");
  const [owners] = await pool.query("SELECT * FROM owners ORDER BY id");
  const [ownerStores] = await pool.query("SELECT * FROM owner_stores ORDER BY owner_id,id");
  const [operations] = await pool.query("SELECT * FROM sample_operation_logs ORDER BY id");
  const [sequences] = await pool.query("SELECT * FROM number_sequences ORDER BY envelope_type");
  const filename = `sample-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  sendJson(res, 200, { version: 1, exportedAt: new Date().toISOString(), samples, images, owners, ownerStores, operations, sequences }, {
    "Content-Disposition": `attachment; filename="${filename}"`
  });
}

async function serveImage(res, id) {
  const [rows] = await pool.execute("SELECT storage_path,mime_type,byte_size FROM sample_images WHERE id=?", [id]);
  if (!rows.length) return sendError(res, 404, "图片不存在");
  const file = path.resolve(config.uploadDir, rows[0].storage_path);
  if (!file.startsWith(`${config.uploadDir}${path.sep}`)) return sendError(res, 403, "图片路径无效");
  const stream = fs.createReadStream(file);
  stream.on("error", () => { if (!res.headersSent) sendError(res, 404, "图片文件不存在"); else res.destroy(); });
  res.writeHead(200, { "Content-Type": rows[0].mime_type, "Content-Length": rows[0].byte_size, "Cache-Control": "private, max-age=3600" });
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === `${config.basePath}/api/auth/exchange`) {
    const body = await bodyJson(req);
    const upstream = text(body.token, 10000);
    if (!upstream) return sendError(res, 400, "缺少统一登录 Token");
    const user = await auth.exchangeUpstreamToken(upstream);
    const session = await auth.createSession(user);
    const maxAge = Math.floor(config.sessionTtlMs / 1000);
    return sendJson(res, 200, { user }, {
      "Set-Cookie": [
        auth.cookie(session.token, maxAge),
        auth.erpCookie(upstream, maxAge)
      ]
    });
  }
  if (!verifyOrigin(req)) return sendError(res, 403, "请求来源无效");
  if (req.method === "POST" && url.pathname === `${config.basePath}/api/logout`) {
    await auth.deleteSession(req);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": [auth.cookie("", 0), auth.erpCookie("", 0)] });
  }
  const required = req.method === "GET" ? "sample:view" : "sample:edit";
  const user = await requireUser(req, res, required);
  if (!user) return;
  const apiPath = url.pathname.slice(config.basePath.length);
  if (req.method === "GET" && apiPath === "/api/me") return sendJson(res, 200, { user });
  if (req.method === "GET" && apiPath === "/api/samples") return listSamples(url, res);
  if (req.method === "GET" && apiPath === "/api/samples/lookup") return lookupSample(url, res);
  if (req.method === "GET" && apiPath === "/api/sample-counts") return sampleCounts(url, res);
  if (req.method === "GET" && apiPath === "/api/next-code") return nextSampleCode(url, res);
  if (req.method === "GET" && apiPath === "/api/shops") {
    const upstream = auth.currentErpToken(req);
    if (!upstream) return sendError(res, 401, "店铺凭证已失效，请重新登录");
    const shops = await auth.fetchAllErpShops(upstream);
    return sendJson(res, 200, {
      shops: shops
        .filter((row) => Number.isInteger(Number(row.id)) && String(row.shopName || "").trim())
        .map((row) => ({
          id: String(row.id),
          shopCode: String(row.shopCode || ""),
          shopName: String(row.shopName || ""),
          contacts: String(row.contacts || ""),
          mobile: String(row.mobile || ""),
          platform: String(row.platform || ""),
          storeManagerId: row.storeManager == null ? "" : String(row.storeManager),
          storeManagerName: String(row.storeManagerName || ""),
          syncedAt: null
        }))
    });
  }
  if (req.method === "GET" && apiPath === "/api/sample-holdings") return listSampleHoldings(res);
  if (req.method === "GET" && apiPath === "/api/sample-holdings/samples") return listHoldingSamples(url, res);
  if (req.method === "GET" && apiPath === "/api/claim-records/today") return listTodayClaimRecords(res, user);
  if (req.method === "POST" && apiPath === "/api/samples") return createSample(req, res, user);
  if (req.method === "GET" && apiPath === "/api/owners") return listOwners(res);
  if (req.method === "POST" && apiPath === "/api/owners") return createOwner(req, res);
  if (req.method === "GET" && apiPath === "/api/backup") {
    if (!auth.hasPermission(user, "sample:admin")) return sendError(res, 403, "只有管理员可以导出备份");
    return exportBackup(res);
  }
  let ownerMatch = apiPath.match(/^\/api\/owners\/(\d+)$/);
  if (req.method === "PATCH" && ownerMatch) return updateOwner(req, res, ownerMatch[1]);
  if (req.method === "DELETE" && ownerMatch) {
    if (!auth.hasPermission(user, "sample:admin")) return sendError(res, 403, "只有管理员可以删除负责人");
    return deleteOwner(res, ownerMatch[1]);
  }
  let match = apiPath.match(/^\/api\/samples\/(\d+)$/);
  if (req.method === "GET" && match) return getSample(res, match[1]);
  if (req.method === "PATCH" && match) return updateSample(req, res, user, match[1]);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/status$/);
  if (req.method === "PATCH" && match) return transitionSample(req, res, user, match[1]);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/claim$/);
  if (req.method === "POST" && match) return claimSample(res, user, match[1]);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/images$/);
  if (req.method === "POST" && match) return addImage(req, res, user, match[1]);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/print$/);
  if (req.method === "POST" && match) return recordPrint(res, user, match[1], false);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/reprint$/);
  if (req.method === "POST" && match) return recordPrint(res, user, match[1], true);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/operations$/);
  if (req.method === "GET" && match) return listOperations(res, match[1]);
  match = apiPath.match(/^\/api\/samples\/(\d+)\/qrcode$/);
  if (req.method === "GET" && match) return serveSampleQr(res, match[1], url.searchParams.get("autoClaim") === "true");
  match = apiPath.match(/^\/api\/images\/(\d+)$/);
  if (req.method === "GET" && match) return serveImage(res, match[1]);
  if (req.method === "DELETE" && match) return deleteImage(res, user, match[1]);
  return sendError(res, 404, "接口不存在");
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" || pathname === config.basePath || pathname === `${config.basePath}/` ? "index.html" : pathname.slice(config.basePath.length + 1);
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendError(res, 403, "禁止访问");
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  fs.readFile(file, (error, data) => {
    if (error) return sendError(res, 404, "页面不存在");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.appOrigin);
    if (!url.pathname.startsWith(config.basePath || "/")) return sendError(res, 404, "Not found");
    if (url.pathname.startsWith(`${config.basePath}/api/`)) return await handleApi(req, res, url);
    const qrRedirect = url.pathname.match(new RegExp(`^${config.basePath}/q/(\\d+)$`));
    if (req.method === "GET" && qrRedirect) {
      res.writeHead(302, { Location: `${config.basePath}/detail.html?id=${qrRedirect[1]}&autoClaim=true`, "Cache-Control": "no-store" });
      return res.end();
    }
    if (req.method !== "GET") return sendError(res, 405, "Method not allowed");
    const isAsset = /\.(?:css|js)$/.test(url.pathname);
    if (!isAsset) {
      const user = await auth.currentUser(req);
      if (!user && !url.searchParams.has("token")) {
        const session = await createSessionFromUpstreamCookie(req);
        if (session) {
          res.writeHead(302, {
            Location: `${url.pathname}${url.search}`,
            "Cache-Control": "no-store",
            "Set-Cookie": session.cookies
          });
          return res.end();
        }
        res.writeHead(302, { Location: auth.loginRedirect(req), "Cache-Control": "no-store" });
        return res.end();
      }
    }
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, error.status || (error.code === "ER_DUP_ENTRY" ? 409 : 500), error.status ? error.message : "服务器内部错误");
    else res.destroy();
  }
});

async function start() {
  await fsp.mkdir(config.uploadDir, { recursive: true, mode: 0o750 });
  await pool.query("SELECT 1");
  await pool.execute("DELETE FROM sso_sessions WHERE expires_at<=NOW(3)");
  server.listen(config.port, () => console.log(`Sample system listening on ${config.port}${config.basePath || "/"}`));
}

if (require.main === module) start().catch((error) => { console.error(error); process.exit(1); });

module.exports = { server, start };
