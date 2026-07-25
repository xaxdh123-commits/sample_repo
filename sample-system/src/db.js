const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
  queueLimit: 0,
  dateStrings: false
});

pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { pool, transaction };
