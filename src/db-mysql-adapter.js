const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');

function nowIso() {
  return new Date().toISOString();
}

function createMysqlAdapter(config) {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  });

  async function query(sql, params) {
    const [rows] = await pool.execute(sql, params || []);
    return rows;
  }

  async function testConnection() {
    await query('SELECT 1 AS ok');
  }

  async function tableExists(name) {
    const rows = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [name]
    );
    return rows && rows.length > 0;
  }

  async function columnExists(table, column) {
    const rows = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
      [table, column]
    );
    return rows && rows.length > 0;
  }

  async function safeCreateTable(name, sql) {
    try {
      await query(sql);
    } catch (err) {
      if (err && err.code === 'ER_TABLE_EXISTS_ERROR') {
        if (!(await tableExists(name))) {
          await query(`DROP TABLE IF EXISTS \`${String(name).replace(/`/g, '``')}\``);
          await query(sql);
        }
        return;
      }
      throw err;
    }
  }

  async function initSchema() {
    await query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    await safeCreateTable('users', `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(191) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role ENUM('admin', 'editor', 'view_only') NOT NULL,
        force_password_change TINYINT(1) NOT NULL DEFAULT 0,
        email_verified TINYINT(1) NOT NULL DEFAULT 0,
        verification_token VARCHAR(191) NULL,
        created_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const userColumns = [
      { name: 'username', def: 'VARCHAR(191) NOT NULL UNIQUE' },
      { name: 'password_hash', def: 'TEXT NOT NULL' },
      { name: 'role', def: "ENUM('admin', 'editor', 'view_only') NOT NULL" },
      { name: 'force_password_change', def: 'TINYINT(1) NOT NULL DEFAULT 0' },
      { name: 'email_verified', def: 'TINYINT(1) NOT NULL DEFAULT 0' },
      { name: 'verification_token', def: 'VARCHAR(191) NULL' },
      { name: 'created_at', def: 'VARCHAR(40) NOT NULL' },
    ];
    let addedEmailVerified = false;
    for (const col of userColumns) {
      if (!(await columnExists('users', col.name))) {
        await query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
        if (col.name === 'email_verified') addedEmailVerified = true;
      }
    }
    if (addedEmailVerified) await query('UPDATE users SET email_verified = 1');
    await safeCreateTable('password_reset_tokens', `
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        user_id VARCHAR(64) PRIMARY KEY,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await safeCreateTable('flows', `
      CREATE TABLE IF NOT EXISTS flows (
        id VARCHAR(64) PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        data_json LONGTEXT NOT NULL,
        is_public TINYINT(1) NOT NULL DEFAULT 0,
        public_token VARCHAR(191) NOT NULL UNIQUE,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        INDEX idx_flows_owner (owner_id),
        INDEX idx_flows_public (is_public),
        CONSTRAINT fk_flows_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await safeCreateTable('uploads', `
      CREATE TABLE IF NOT EXISTS uploads (
        id VARCHAR(64) PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL,
        username VARCHAR(191) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        original_name TEXT NOT NULL,
        mime_type VARCHAR(255) NULL,
        size BIGINT NOT NULL,
        url TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        replaced_at VARCHAR(40) NULL,
        INDEX idx_uploads_owner (owner_id),
        CONSTRAINT fk_uploads_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await safeCreateTable('settings', `
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(191) PRIMARY KEY,
        \`value\` LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await safeCreateTable('sessions', `
      CREATE TABLE IF NOT EXISTS sessions (
        sid VARCHAR(191) PRIMARY KEY,
        sess LONGTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        INDEX idx_sessions_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await safeCreateTable('rate_limits', `
      CREATE TABLE IF NOT EXISTS rate_limits (
        \`key\` VARCHAR(191) PRIMARY KEY,
        count INT NOT NULL,
        reset_at BIGINT NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        INDEX idx_rate_limits_reset (reset_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await query('INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)', ['max_upload_mb', '250']);
    await query('INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)', ['allow_self_register', '1']);
  }

  async function testServerConnection() {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
    });
    try {
      await conn.execute('SELECT 1');
    } finally {
      await conn.end();
    }
  }

  async function createDatabase() {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
    });
    try {
      const safeDb = String(config.database || '').replace(/`/g, '``');
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${safeDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await conn.end();
    }
  }

  async function listSettings() {
    const rows = await query('SELECT `key`, `value` FROM settings');
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async function getSetting(key, fallback) {
    const rows = await query('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  async function setSetting(key, value) {
    await query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [key, String(value)]
    );
  }

  async function listUsers() {
    const rows = await query(
      'SELECT id, username, role, force_password_change AS forcePasswordChange, email_verified AS emailVerified, verification_token AS verificationToken, created_at AS createdAt FROM users ORDER BY username ASC'
    );
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      forcePasswordChange: !!row.forcePasswordChange,
      emailVerified: !!row.emailVerified,
      verificationToken: row.verificationToken || null,
      createdAt: row.createdAt,
    }));
  }

  async function countUsers() {
    const rows = await query('SELECT COUNT(*) AS c FROM users');
    return rows[0] ? Number(rows[0].c) : 0;
  }

  async function getUserById(id) {
    const rows = await query(
      'SELECT id, username, password_hash AS passwordHash, role, force_password_change AS forcePasswordChange, email_verified AS emailVerified, verification_token AS verificationToken, created_at AS createdAt FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      username: rows[0].username,
      passwordHash: rows[0].passwordHash,
      role: rows[0].role,
      forcePasswordChange: !!rows[0].forcePasswordChange,
      emailVerified: !!rows[0].emailVerified,
      verificationToken: rows[0].verificationToken || null,
      createdAt: rows[0].createdAt,
    };
  }

  async function getUserByUsername(username) {
    const rows = await query(
      'SELECT id, username, password_hash AS passwordHash, role, force_password_change AS forcePasswordChange, email_verified AS emailVerified, verification_token AS verificationToken, created_at AS createdAt FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [username]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      username: rows[0].username,
      passwordHash: rows[0].passwordHash,
      role: rows[0].role,
      forcePasswordChange: !!rows[0].forcePasswordChange,
      emailVerified: !!rows[0].emailVerified,
      verificationToken: rows[0].verificationToken || null,
      createdAt: rows[0].createdAt,
    };
  }

  async function getUserByVerificationToken(token) {
    const rows = await query(
      'SELECT id, username, password_hash AS passwordHash, role, force_password_change AS forcePasswordChange, email_verified AS emailVerified, verification_token AS verificationToken, created_at AS createdAt FROM users WHERE verification_token = ? LIMIT 1',
      [token]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      username: rows[0].username,
      passwordHash: rows[0].passwordHash,
      role: rows[0].role,
      forcePasswordChange: !!rows[0].forcePasswordChange,
      emailVerified: !!rows[0].emailVerified,
      verificationToken: rows[0].verificationToken || null,
      createdAt: rows[0].createdAt,
    };
  }

  async function createUser(user, normalizeRole) {
    await query(
      `INSERT INTO users (id, username, password_hash, role, force_password_change, email_verified, verification_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.username,
        user.passwordHash,
        normalizeRole(user.role),
        user.forcePasswordChange ? 1 : 0,
        user.emailVerified ? 1 : 0,
        user.verificationToken || null,
        user.createdAt || nowIso(),
      ]
    );
  }

  async function updateUser(id, patch, normalizeRole) {
    const current = await getUserById(id);
    if (!current) return false;
    await query(
      `UPDATE users
       SET password_hash = ?, role = ?, force_password_change = ?, email_verified = ?, verification_token = ?
       WHERE id = ?`,
      [
        patch.passwordHash || current.passwordHash,
        patch.role ? normalizeRole(patch.role) : current.role,
        typeof patch.forcePasswordChange === 'boolean' ? (patch.forcePasswordChange ? 1 : 0) : (current.forcePasswordChange ? 1 : 0),
        typeof patch.emailVerified === 'boolean' ? (patch.emailVerified ? 1 : 0) : (current.emailVerified ? 1 : 0),
        patch.verificationToken !== undefined ? (patch.verificationToken || null) : (current.verificationToken || null),
        id,
      ]
    );
    return true;
  }

  async function deleteUser(id) {
    const result = await query('DELETE FROM users WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async function setPasswordResetToken(userId, tokenHash, expiresAt) {
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), created_at = VALUES(created_at)`,
      [userId, tokenHash, expiresAt, nowIso()]
    );
  }

  async function getUserByPasswordResetTokenHash(tokenHash) {
    const rows = await query(
      `SELECT u.id, u.username, u.password_hash AS passwordHash, u.role,
              u.force_password_change AS forcePasswordChange, u.email_verified AS emailVerified,
              u.verification_token AS verificationToken, u.created_at AS createdAt,
              p.expires_at AS resetExpiresAt
       FROM password_reset_tokens p JOIN users u ON u.id = p.user_id
       WHERE p.token_hash = ? LIMIT 1`,
      [tokenHash]
    );
    if (!rows.length) return null;
    const user = rows[0];
    user.forcePasswordChange = !!user.forcePasswordChange;
    user.emailVerified = !!user.emailVerified;
    return user;
  }

  async function clearPasswordResetToken(userId) {
    await query('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
  }

  async function listFlowsForOwner(ownerId) {
    const rows = await query(
      `SELECT id, name, updated_at AS updatedAt, is_public AS isPublic, public_token AS publicToken
       FROM flows
       WHERE owner_id = ?
       ORDER BY updated_at DESC`,
      [ownerId]
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
      isPublic: !!row.isPublic,
      publicToken: row.publicToken,
    }));
  }

  async function getFlowForOwner(flowId, ownerId) {
    const rows = await query(
      `SELECT id, owner_id AS ownerId, name, data_json AS dataJson, is_public AS isPublic,
              public_token AS publicToken, created_at AS createdAt, updated_at AS updatedAt
       FROM flows
       WHERE id = ? AND owner_id = ?
       LIMIT 1`,
      [flowId, ownerId]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      ownerId: rows[0].ownerId,
      name: rows[0].name,
      data: JSON.parse(rows[0].dataJson || '{}'),
      isPublic: !!rows[0].isPublic,
      publicToken: rows[0].publicToken,
      createdAt: rows[0].createdAt,
      updatedAt: rows[0].updatedAt,
    };
  }

  async function saveFlow(input) {
    const now = nowIso();
    const existingRows = input.id
      ? await query('SELECT id, public_token AS publicToken FROM flows WHERE id = ? AND owner_id = ? LIMIT 1', [input.id, input.ownerId])
      : [];
    const existing = existingRows[0] || null;
    if (existing) {
      await query(
        `UPDATE flows
         SET name = ?, data_json = ?, is_public = ?, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
        [input.name, JSON.stringify(input.data || {}), input.isPublic ? 1 : 0, now, existing.id, input.ownerId]
      );
      return { id: existing.id, publicToken: existing.publicToken };
    }

    const id = uuidv4();
    const publicToken = uuidv4();
    await query(
      `INSERT INTO flows (id, owner_id, name, data_json, is_public, public_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.ownerId, input.name, JSON.stringify(input.data || {}), input.isPublic ? 1 : 0, publicToken, now, now]
    );
    return { id, publicToken };
  }

  async function getPublicFlowByToken(token) {
    const rows = await query(
      `SELECT f.id, f.owner_id AS ownerId, f.name, f.data_json AS dataJson, f.public_token AS publicToken,
              f.updated_at AS updatedAt, u.username AS ownerUsername
       FROM flows f
       JOIN users u ON u.id = f.owner_id
       WHERE f.public_token = ? AND f.is_public = 1
       LIMIT 1`,
      [token]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].id,
      ownerId: rows[0].ownerId,
      ownerUsername: rows[0].ownerUsername,
      name: rows[0].name,
      data: JSON.parse(rows[0].dataJson || '{}'),
      publicToken: rows[0].publicToken,
      updatedAt: rows[0].updatedAt,
    };
  }

  async function listPublicFlows(filters) {
    const username = String((filters && filters.username) || '').trim();
    const name = String((filters && filters.name) || '').trim();
    const requestedPage = parseInt(String((filters && filters.page) || '1'), 10);
    const requestedPageSize = parseInt(String((filters && filters.pageSize) || '20'), 10);
    const page = Number.isNaN(requestedPage) ? 1 : Math.max(1, requestedPage);
    const pageSize = Number.isNaN(requestedPageSize) ? 20 : Math.max(1, Math.min(100, requestedPageSize));

    let whereSql = ' WHERE f.is_public = 1';
    const params = [];
    if (username) {
      whereSql += ' AND LOWER(u.username) LIKE LOWER(?)';
      params.push(`%${username}%`);
    }
    if (name) {
      whereSql += ' AND LOWER(f.name) LIKE LOWER(?)';
      params.push(`%${name}%`);
    }

    const totalRows = await query(
      `SELECT COUNT(*) AS c FROM flows f JOIN users u ON u.id = f.owner_id${whereSql}`,
      params
    );
    const total = totalRows[0] ? Number(totalRows[0].c) : 0;
    const offset = (page - 1) * pageSize;
    const items = await query(
      `SELECT f.id, f.name, f.public_token AS publicToken, f.updated_at AS updatedAt, u.username
       FROM flows f
       JOIN users u ON u.id = f.owner_id${whereSql}
       ORDER BY f.updated_at DESC
       LIMIT ? OFFSET ?`,
      params.concat([pageSize, offset])
    );

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }

  async function createUpload(entry) {
    await query(
      `INSERT INTO uploads (id, owner_id, username, kind, original_name, mime_type, size, url, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        entry.ownerId,
        entry.username,
        entry.kind,
        entry.originalName,
        entry.mimeType,
        entry.size,
        entry.url,
        entry.storagePath,
        nowIso(),
      ]
    );
  }

  async function getSessionRecord(sid) {
    const rows = await query(
      'SELECT sid, sess, expires_at AS expiresAt FROM sessions WHERE sid = ? LIMIT 1',
      [sid]
    );
    return rows.length ? { sid: rows[0].sid, sess: rows[0].sess, expiresAt: Number(rows[0].expiresAt) } : null;
  }

  async function upsertSessionRecord(sid, sess, expiresAt) {
    const now = nowIso();
    await query(
      `INSERT INTO sessions (sid, sess, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sess = VALUES(sess), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)`,
      [sid, sess, expiresAt, now, now]
    );
  }

  async function deleteSessionRecord(sid) {
    await query('DELETE FROM sessions WHERE sid = ?', [sid]);
  }

  async function cleanupExpiredSessions(nowMs) {
    await query('DELETE FROM sessions WHERE expires_at <= ?', [nowMs]);
  }

  async function consumeRateLimit(key, windowMs, max, nowMs) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT `key`, count, reset_at AS resetAt FROM rate_limits WHERE `key` = ? FOR UPDATE',
        [key]
      );
      const row = rows[0];
      if (!row || Number(row.resetAt) <= nowMs) {
        const resetAt = nowMs + windowMs;
        await conn.execute(
          `INSERT INTO rate_limits (\`key\`, count, reset_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE count = VALUES(count), reset_at = VALUES(reset_at), updated_at = VALUES(updated_at)`,
          [key, 1, resetAt, nowIso()]
        );
        await conn.commit();
        return { allowed: true, count: 1, resetAt };
      }

      const count = Number(row.count) + 1;
      await conn.execute('UPDATE rate_limits SET count = ?, updated_at = ? WHERE `key` = ?', [count, nowIso(), key]);
      await conn.commit();
      return { allowed: count <= max, count, resetAt: Number(row.resetAt) };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async function cleanupExpiredRateLimits(nowMs) {
    await query('DELETE FROM rate_limits WHERE reset_at <= ?', [nowMs]);
  }

  async function ensureEmptyForMigration() {
    const tables = ['users', 'flows', 'uploads', 'sessions', 'rate_limits'];
    for (const table of tables) {
      const rows = await query(`SELECT COUNT(*) AS c FROM ${table}`);
      if (rows[0] && Number(rows[0].c) > 0) {
        throw new Error(`Target database is not empty (${table})`);
      }
    }
  }

  async function importData(data) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const row of data.settings || []) {
        await conn.execute(
          'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
          [row.key, String(row.value)]
        );
      }

      for (const row of data.users || []) {
        await conn.execute(
          `INSERT INTO users (id, username, password_hash, role, force_password_change, email_verified, verification_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.username, row.password_hash, row.role, row.force_password_change ? 1 : 0, row.email_verified ? 1 : 0, row.verification_token || null, row.created_at]
        );
      }

      for (const row of data.flows || []) {
        await conn.execute(
          `INSERT INTO flows (id, owner_id, name, data_json, is_public, public_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.owner_id, row.name, row.data_json, row.is_public ? 1 : 0, row.public_token, row.created_at, row.updated_at]
        );
      }

      for (const row of data.uploads || []) {
        await conn.execute(
          `INSERT INTO uploads (id, owner_id, username, kind, original_name, mime_type, size, url, storage_path, created_at, replaced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.owner_id, row.username, row.kind, row.original_name, row.mime_type, row.size, row.url, row.storage_path, row.created_at, row.replaced_at || null]
        );
      }

      for (const row of data.sessions || []) {
        await conn.execute(
          `INSERT INTO sessions (sid, sess, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [row.sid, row.sess, row.expires_at, row.created_at, row.updated_at]
        );
      }

      for (const row of data.rateLimits || []) {
        await conn.execute(
          'INSERT INTO rate_limits (`key`, count, reset_at, updated_at) VALUES (?, ?, ?, ?)',
          [row.key, row.count, row.reset_at, row.updated_at]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return {
    engine: config.engine,
    testConnection,
    testServerConnection,
    createDatabase,
    initSchema,
    listSettings,
    getSetting,
    setSetting,
    listUsers,
    countUsers,
    getUserById,
    getUserByUsername,
    getUserByVerificationToken,
    createUser,
    updateUser,
    deleteUser,
    setPasswordResetToken,
    getUserByPasswordResetTokenHash,
    clearPasswordResetToken,
    listFlowsForOwner,
    getFlowForOwner,
    saveFlow,
    getPublicFlowByToken,
    listPublicFlows,
    createUpload,
    getSessionRecord,
    upsertSessionRecord,
    deleteSessionRecord,
    cleanupExpiredSessions,
    consumeRateLimit,
    cleanupExpiredRateLimits,
    ensureEmptyForMigration,
    importData,
    close,
  };
}

module.exports = {
  createMysqlAdapter,
};
