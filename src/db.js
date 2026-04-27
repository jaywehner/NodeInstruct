const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'nodeinstruct.sqlite');
const legacyUsersFile = path.join(dataDir, 'users.json');
const legacyFlowsFile = path.join(dataDir, 'flows.json');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(dataDir);
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');

function nowIso() {
  return new Date().toISOString();
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'view_only' || r === 'view-only' || r === 'viewer') return 'view_only';
  return 'editor';
}

function readLegacyJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'view_only')),
      force_password_change INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      public_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      username TEXT NOT NULL,
      kind TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      replaced_at TEXT,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flows_owner ON flows(owner_id);
    CREATE INDEX IF NOT EXISTS idx_flows_public ON flows(is_public);
    CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
  `);
}

function migrateLegacyData() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const flowCount = db.prepare('SELECT COUNT(*) AS c FROM flows').get().c;

  if (userCount > 0 || flowCount > 0) return;

  const users = readLegacyJson(legacyUsersFile, []);
  const flows = readLegacyJson(legacyFlowsFile, []);

  const insertUser = db.prepare(
    `INSERT INTO users (id, username, password_hash, role, force_password_change, created_at)
     VALUES (@id, @username, @password_hash, @role, @force_password_change, @created_at)`
  );

  const insertFlow = db.prepare(
    `INSERT INTO flows (id, owner_id, name, data_json, is_public, public_token, created_at, updated_at)
     VALUES (@id, @owner_id, @name, @data_json, @is_public, @public_token, @created_at, @updated_at)`
  );

  const tx = db.transaction(() => {
    const userIds = new Set();

    users.forEach((u) => {
      const id = String(u.id || uuidv4());
      const username = String(u.username || '').trim();
      if (!username) return;

      insertUser.run({
        id,
        username: String(u.username || '').trim(),
        password_hash: String(u.passwordHash || ''),
        role: normalizeRole(u.role),
        force_password_change: u.forcePasswordChange ? 1 : 0,
        created_at: String(u.createdAt || nowIso()),
      });

      userIds.add(id);
    });

    flows.forEach((f) => {
      const ownerId = String(f.ownerId || '');
      if (!userIds.has(ownerId)) return;

      insertFlow.run({
        id: String(f.id || uuidv4()),
        owner_id: ownerId,
        name: String(f.name || 'Untitled Flow'),
        data_json: JSON.stringify(f.data || {}),
        is_public: 0,
        public_token: uuidv4(),
        created_at: String(f.createdAt || nowIso()),
        updated_at: String(f.updatedAt || f.createdAt || nowIso()),
      });
    });
  });

  tx();
}

function ensureDefaultSettings() {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('max_upload_mb', '250');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('allow_self_register', '0');
}

function initDb() {
  initSchema();
  migrateLegacyData();
  ensureDefaultSettings();
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, String(value));
}

function listUsers() {
  return db.prepare(
    'SELECT id, username, role, force_password_change AS forcePasswordChange, created_at AS createdAt FROM users ORDER BY username COLLATE NOCASE ASC'
  ).all();
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function getUserById(id) {
  return db.prepare(
    'SELECT id, username, password_hash AS passwordHash, role, force_password_change AS forcePasswordChange, created_at AS createdAt FROM users WHERE id = ?'
  ).get(id);
}

function getUserByUsername(username) {
  return db.prepare(
    'SELECT id, username, password_hash AS passwordHash, role, force_password_change AS forcePasswordChange, created_at AS createdAt FROM users WHERE lower(username) = lower(?)'
  ).get(username);
}

function createUser(user) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, force_password_change, created_at)
     VALUES (@id, @username, @password_hash, @role, @force_password_change, @created_at)`
  ).run({
    id: user.id,
    username: user.username,
    password_hash: user.passwordHash,
    role: normalizeRole(user.role),
    force_password_change: user.forcePasswordChange ? 1 : 0,
    created_at: user.createdAt || nowIso(),
  });
}

function updateUser(id, patch) {
  const current = getUserById(id);
  if (!current) return false;

  db.prepare(
    `UPDATE users
     SET password_hash = @password_hash,
         role = @role,
         force_password_change = @force_password_change
     WHERE id = @id`
  ).run({
    id,
    password_hash: patch.passwordHash || current.passwordHash,
    role: patch.role ? normalizeRole(patch.role) : current.role,
    force_password_change:
      typeof patch.forcePasswordChange === 'boolean' ? (patch.forcePasswordChange ? 1 : 0) : (current.forcePasswordChange ? 1 : 0),
  });

  return true;
}

function deleteUser(id) {
  const res = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return res.changes > 0;
}

function listFlowsForOwner(ownerId) {
  return db.prepare(
    `SELECT id, name, updated_at AS updatedAt, is_public AS isPublic, public_token AS publicToken
     FROM flows
     WHERE owner_id = ?
     ORDER BY datetime(updated_at) DESC`
  ).all(ownerId);
}

function getFlowForOwner(flowId, ownerId) {
  const row = db.prepare(
    `SELECT id, owner_id AS ownerId, name, data_json AS dataJson, is_public AS isPublic,
            public_token AS publicToken, created_at AS createdAt, updated_at AS updatedAt
     FROM flows
     WHERE id = ? AND owner_id = ?`
  ).get(flowId, ownerId);

  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    data: JSON.parse(row.dataJson || '{}'),
    isPublic: !!row.isPublic,
    publicToken: row.publicToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function saveFlow(input) {
  const now = nowIso();
  const existing = input.id ? db.prepare('SELECT id, public_token FROM flows WHERE id = ? AND owner_id = ?').get(input.id, input.ownerId) : null;

  if (existing) {
    db.prepare(
      `UPDATE flows
       SET name = @name,
           data_json = @data_json,
           is_public = @is_public,
           updated_at = @updated_at
       WHERE id = @id AND owner_id = @owner_id`
    ).run({
      id: existing.id,
      owner_id: input.ownerId,
      name: input.name,
      data_json: JSON.stringify(input.data || {}),
      is_public: input.isPublic ? 1 : 0,
      updated_at: now,
    });

    return { id: existing.id, publicToken: existing.public_token };
  }

  const id = uuidv4();
  const publicToken = uuidv4();
  db.prepare(
    `INSERT INTO flows (id, owner_id, name, data_json, is_public, public_token, created_at, updated_at)
     VALUES (@id, @owner_id, @name, @data_json, @is_public, @public_token, @created_at, @updated_at)`
  ).run({
    id,
    owner_id: input.ownerId,
    name: input.name,
    data_json: JSON.stringify(input.data || {}),
    is_public: input.isPublic ? 1 : 0,
    public_token: publicToken,
    created_at: now,
    updated_at: now,
  });

  return { id, publicToken };
}

function getPublicFlowByToken(token) {
  const row = db.prepare(
    `SELECT f.id, f.owner_id AS ownerId, f.name, f.data_json AS dataJson, f.public_token AS publicToken,
            f.updated_at AS updatedAt, u.username AS ownerUsername
     FROM flows f
     JOIN users u ON u.id = f.owner_id
     WHERE f.public_token = ? AND f.is_public = 1`
  ).get(token);

  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    ownerUsername: row.ownerUsername,
    name: row.name,
    data: JSON.parse(row.dataJson || '{}'),
    publicToken: row.publicToken,
    updatedAt: row.updatedAt,
  };
}

function listPublicFlows(filters) {
  const username = String((filters && filters.username) || '').trim();
  const name = String((filters && filters.name) || '').trim();
  const requestedPage = parseInt(String((filters && filters.page) || '1'), 10);
  const requestedPageSize = parseInt(String((filters && filters.pageSize) || '20'), 10);
  const page = Number.isNaN(requestedPage) ? 1 : Math.max(1, requestedPage);
  const pageSize = Number.isNaN(requestedPageSize) ? 20 : Math.max(1, Math.min(100, requestedPageSize));

  let whereSql = ' WHERE f.is_public = 1';
  const params = [];

  if (username) {
    whereSql += ' AND lower(u.username) LIKE lower(?)';
    params.push(`%${username}%`);
  }

  if (name) {
    whereSql += ' AND lower(f.name) LIKE lower(?)';
    params.push(`%${name}%`);
  }

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS c
     FROM flows f
     JOIN users u ON u.id = f.owner_id${whereSql}`
  ).get(...params);
  const total = totalRow ? totalRow.c : 0;
  const offset = (page - 1) * pageSize;

  const items = db.prepare(
    `SELECT f.id, f.name, f.public_token AS publicToken, f.updated_at AS updatedAt, u.username
     FROM flows f
     JOIN users u ON u.id = f.owner_id${whereSql}
     ORDER BY datetime(f.updated_at) DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

function createUpload(entry) {
  db.prepare(
    `INSERT INTO uploads (id, owner_id, username, kind, original_name, mime_type, size, url, storage_path, created_at)
     VALUES (@id, @owner_id, @username, @kind, @original_name, @mime_type, @size, @url, @storage_path, @created_at)`
  ).run({
    id: uuidv4(),
    owner_id: entry.ownerId,
    username: entry.username,
    kind: entry.kind,
    original_name: entry.originalName,
    mime_type: entry.mimeType,
    size: entry.size,
    url: entry.url,
    storage_path: entry.storagePath,
    created_at: nowIso(),
  });
}

function getSessionRecord(sid) {
  return db.prepare(
    'SELECT sid, sess, expires_at AS expiresAt FROM sessions WHERE sid = ?'
  ).get(sid);
}

function upsertSessionRecord(sid, sess, expiresAt) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (sid, sess, expires_at, created_at, updated_at)
     VALUES (@sid, @sess, @expires_at, @created_at, @updated_at)
     ON CONFLICT(sid) DO UPDATE SET
       sess = excluded.sess,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  ).run({
    sid,
    sess,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  });
}

function deleteSessionRecord(sid) {
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

function cleanupExpiredSessions(nowMs) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
}

function consumeRateLimit(key, windowMs, max, nowMs) {
  const row = db.prepare(
    'SELECT key, count, reset_at AS resetAt FROM rate_limits WHERE key = ?'
  ).get(key);

  if (!row || row.resetAt <= nowMs) {
    const resetAt = nowMs + windowMs;
    db.prepare(
      `INSERT INTO rate_limits (key, count, reset_at, updated_at)
       VALUES (@key, @count, @reset_at, @updated_at)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         reset_at = excluded.reset_at,
         updated_at = excluded.updated_at`
    ).run({
      key,
      count: 1,
      reset_at: resetAt,
      updated_at: nowIso(),
    });
    return { allowed: true, count: 1, resetAt };
  }

  const count = row.count + 1;
  db.prepare(
    'UPDATE rate_limits SET count = ?, updated_at = ? WHERE key = ?'
  ).run(count, nowIso(), key);

  return {
    allowed: count <= max,
    count,
    resetAt: row.resetAt,
  };
}

function cleanupExpiredRateLimits(nowMs) {
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(nowMs);
}

module.exports = {
  db,
  initDb,
  normalizeRole,
  getSetting,
  setSetting,
  countUsers,
  listUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
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
};
