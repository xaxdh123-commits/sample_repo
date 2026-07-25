const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const config = require("../src/config");
const { sampleCode } = require("../src/domain");

const LEGACY_FILE = path.resolve(process.argv[2] || process.env.LEGACY_FILE || path.resolve(__dirname, "..", "..", "leacy", "data", "samples.json"));
const SCHEMA_FILE = path.resolve(__dirname, "..", "sql", "schema.sql");

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function imageList(sample) {
  const values = [sample.imageData, ...(Array.isArray(sample.images) ? sample.images : [])];
  return [...new Set(values.filter((value) => typeof value === "string" && value.startsWith("data:image/")))].slice(0, 12);
}

function decodeImage(dataUrl) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/is);
  if (!match) return null;
  const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const extensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
  if (!extensions[mime]) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) return null;
  return { mime, extension: extensions[mime], buffer };
}

async function main() {
  if (!/^[A-Za-z0-9_]+$/.test(config.mysql.database)) throw new Error("MYSQL_DATABASE contains invalid characters");
  const admin = await mysql.createConnection({
    host: config.mysql.host, port: config.mysql.port, user: config.mysql.user,
    password: config.mysql.password, multipleStatements: true
  });
  await admin.query("SET time_zone = '+00:00'");
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.changeUser({ database: config.mysql.database });
  await admin.query(await fsp.readFile(SCHEMA_FILE, "utf8"));
  await fsp.mkdir(config.uploadDir, { recursive: true, mode: 0o750 });

  const legacy = JSON.parse(await fsp.readFile(LEGACY_FILE, "utf8"));
  const writtenFiles = [];
  await admin.beginTransaction();
  try {
    for (const owner of legacy.owners || []) {
      const [result] = await admin.execute(
        `INSERT INTO owners (legacy_id,name,phone,created_at,updated_at) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name),phone=VALUES(phone),updated_at=VALUES(updated_at)`,
        [String(owner.id || ""), String(owner.name || "").trim(), String(owner.phone || "").trim(), isoDate(owner.createdAt), isoDate(owner.updatedAt || owner.createdAt)]
      );
      let ownerId = result.insertId;
      if (!ownerId) {
        const [rows] = await admin.execute("SELECT id FROM owners WHERE legacy_id=?", [String(owner.id || "")]);
        ownerId = rows[0].id;
      }
      await admin.execute("DELETE FROM owner_stores WHERE owner_id=?", [ownerId]);
      for (const store of [...new Set((owner.stores || []).map((v) => String(v).trim()).filter(Boolean))]) {
        await admin.execute(
          `INSERT INTO owner_stores (owner_id,store_name,store_key) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE owner_id=VALUES(owner_id),store_name=VALUES(store_name)`,
          [ownerId, store, store.toLowerCase()]
        );
      }
    }

    for (const sample of legacy.samples || []) {
      const envelopeType = ["small", "large", "none"].includes(sample.envelopeType) ? sample.envelopeType : "small";
      const number = Number(sample.sampleNumber);
      const status = sample.status === "void" ? "void" : "printed";
      const createdAt = isoDate(sample.createdAt);
      const actorId = String(sample.createdByUserId || "legacy-import");
      const actorUsername = String(sample.createdByUsername || "legacy");
      const actorName = String(sample.createdByName || sample.createdByUsername || "历史导入");
      const [result] = await admin.execute(
        `INSERT INTO samples
         (legacy_id,sample_number,sample_code,sample_type,envelope_type,plate_number,customer_name,store_name,owner_name,owner_phone,note,status,void_reason,
          sample_content,sample_specification,sample_color,
          created_by_id,created_by_username,created_by_name,created_at,updated_by_id,updated_by_username,updated_by_name,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           legacy_id=IF(legacy_id IS NULL OR legacy_id='',VALUES(legacy_id),legacy_id),
           sample_type='label'`,
        [String(sample.id), number, String(sample.sampleCode || sampleCode(number, envelopeType)), "label", envelopeType,
          String(sample.plateNumber || ""), String(sample.customerName || ""), String(sample.storeName || ""),
          String(sample.ownerName || ""), String(sample.ownerPhone || ""), String(sample.note || ""), status,
          String(sample.voidReason || ""), "", "", "", actorId, actorUsername, actorName, createdAt,
          actorId, actorUsername, actorName, isoDate(sample.voidedAt || sample.createdAt)]
      );
      let sampleId = result.insertId;
      if (!sampleId) {
        const [rows] = await admin.execute("SELECT id FROM samples WHERE legacy_id=? OR sample_code=? ORDER BY legacy_id=? DESC LIMIT 1", [String(sample.id), String(sample.sampleCode || sampleCode(number, envelopeType)), String(sample.id)]);
        sampleId = rows[0].id;
      }
      const [[imageCount]] = await admin.execute("SELECT COUNT(*) total FROM sample_images WHERE sample_id=?", [sampleId]);
      if (!Number(imageCount.total)) {
        let order = 0;
        for (const dataUrl of imageList(sample)) {
          const image = decodeImage(dataUrl);
          if (!image) continue;
          const filename = `${crypto.randomUUID()}${image.extension}`;
          await fsp.writeFile(path.join(config.uploadDir, filename), image.buffer, { mode: 0o640 });
          writtenFiles.push(filename);
          await admin.execute(
            "INSERT INTO sample_images (sample_id,storage_path,mime_type,byte_size,sort_order,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)",
            [sampleId, filename, image.mime, image.buffer.length, order++, actorId, createdAt]
          );
        }
      }
      const [[logCount]] = await admin.execute("SELECT COUNT(*) total FROM sample_operation_logs WHERE sample_id=? AND action='legacy_import'", [sampleId]);
      if (!Number(logCount.total)) await admin.execute(
        `INSERT INTO sample_operation_logs
         (sample_id,action,from_status,to_status,change_summary,operator_id,operator_username,operator_name,operated_at)
         VALUES (?,'legacy_import',NULL,?,JSON_OBJECT('legacyId',?),?,?,?,?)`,
        [sampleId, status, String(sample.id), actorId, actorUsername, actorName, createdAt]
      );
    }

    for (const type of ["small", "large", "none"]) {
      const [[row]] = await admin.execute("SELECT COALESCE(MAX(sample_number),0)+1 next_number FROM samples WHERE envelope_type=?", [type]);
      await admin.execute("UPDATE number_sequences SET next_number=GREATEST(next_number,?) WHERE envelope_type=?", [row.next_number, type]);
    }
    await admin.commit();
  } catch (error) {
    await admin.rollback();
    await Promise.all(writtenFiles.map((file) => fsp.rm(path.join(config.uploadDir, file), { force: true })));
    throw error;
  } finally {
    await admin.end();
  }
  console.log(`Migration complete: ${legacy.samples?.length || 0} samples, ${legacy.owners?.length || 0} owners`);
}

main().catch((error) => { console.error(error); process.exit(1); });
