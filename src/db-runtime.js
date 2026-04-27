const fs = require('fs');
const path = require('path');

const sqliteModule = require('./db');
const { createMysqlAdapter } = require('./db-mysql-adapter');

const dataDir = path.join(__dirname, '..', 'data');
const dbConfigFile = path.join(dataDir, 'database-config.json');
const sqliteFile = path.join(dataDir, 'nodeinstruct.sqlite');

let activeAdapter = null;
let activeConfig = null;
const settingsCache = new Map();

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function defaultDbConfig() {
  return {
    engine: 'sqlite',
    locked: false,
    mysql: null,
    migratedAt: null,
  };
}

function cloneSafeConfig(config) {
  const current = config || defaultDbConfig();
  const mysql = current.mysql || null;
  return {
    engine: current.engine,
    locked: !!current.locked,
    migratedAt: current.migratedAt || null,
    mysql: mysql ? {
      engine: mysql.engine,
      host: mysql.host,
      port: mysql.port,
      username: mysql.username,
      database: mysql.database,
      password: mysql.password,
    } : null,
  };
}

function safeDbStatus() {
  const current = cloneSafeConfig(activeConfig || defaultDbConfig());
  const mysql = current.mysql;
  return {
    engine: current.engine,
    locked: !!current.locked,
    migratedAt: current.migratedAt || null,
    canMigrate: current.engine === 'sqlite' && !current.locked,
    mysql: mysql ? {
      engine: mysql.engine,
      host: mysql.host,
      port: mysql.port,
      username: mysql.username,
      database: mysql.database,
      hasPassword: !!mysql.password,
    } : null,
  };
}

function readDbConfig() {
  ensureDir(dataDir);
  if (!fs.existsSync(dbConfigFile)) return defaultDbConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'));
    const engine = ['sqlite', 'mysql', 'mariadb'].includes(String(raw.engine || '').toLowerCase())
      ? String(raw.engine || '').toLowerCase()
      : 'sqlite';
    return {
      engine,
      locked: !!raw.locked,
      migratedAt: raw.migratedAt || null,
      mysql: raw.mysql && typeof raw.mysql === 'object' ? {
        engine: ['mysql', 'mariadb'].includes(String(raw.mysql.engine || '').toLowerCase()) ? String(raw.mysql.engine).toLowerCase() : 'mysql',
        host: String(raw.mysql.host || '').trim(),
        port: parseInt(String(raw.mysql.port || '3306'), 10) || 3306,
        username: String(raw.mysql.username || '').trim(),
        database: String(raw.mysql.database || '').trim(),
        password: String(raw.mysql.password || ''),
      } : null,
    };
  } catch {
    return defaultDbConfig();
  }
}

function writeDbConfig(config) {
  ensureDir(dataDir);
  fs.writeFileSync(dbConfigFile, JSON.stringify(config, null, 2), 'utf8');
  try {
    fs.chmodSync(dbConfigFile, 0o600);
  } catch {}
  activeConfig = cloneSafeConfig(config);
}

function requireAdapter() {
  if (!activeAdapter) {
    throw new Error('Database adapter not initialized');
  }
  return activeAdapter;
}

function loadSettingsIntoCache(items) {
  settingsCache.clear();
  (items || []).forEach((item) => {
    settingsCache.set(String(item.key), String(item.value));
  });
}

function getSetting(key, fallback) {
  const cacheKey = String(key || '');
  if (settingsCache.has(cacheKey)) return settingsCache.get(cacheKey);
  return fallback;
}

function normalizeRole(role) {
  return sqliteModule.normalizeRole(role);
}

function wrapSqlite() {
  return {
    engine: 'sqlite',
    async initSchema() {
      sqliteModule.initDb();
    },
    async listSettings() {
      return sqliteModule.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    },
    async getSetting(key, fallback) {
      return sqliteModule.getSetting(key, fallback);
    },
    async setSetting(key, value) {
      sqliteModule.setSetting(key, value);
    },
    async listUsers() {
      return sqliteModule.listUsers();
    },
    async countUsers() {
      return sqliteModule.countUsers();
    },
    async getUserById(id) {
      return sqliteModule.getUserById(id);
    },
    async getUserByUsername(username) {
      return sqliteModule.getUserByUsername(username);
    },
    async createUser(user) {
      sqliteModule.createUser(user);
    },
    async updateUser(id, patch) {
      return sqliteModule.updateUser(id, patch);
    },
    async deleteUser(id) {
      return sqliteModule.deleteUser(id);
    },
    async listFlowsForOwner(ownerId) {
      return sqliteModule.listFlowsForOwner(ownerId);
    },
    async getFlowForOwner(flowId, ownerId) {
      return sqliteModule.getFlowForOwner(flowId, ownerId);
    },
    async saveFlow(input) {
      return sqliteModule.saveFlow(input);
    },
    async getPublicFlowByToken(token) {
      return sqliteModule.getPublicFlowByToken(token);
    },
    async listPublicFlows(filters) {
      return sqliteModule.listPublicFlows(filters);
    },
    async createUpload(entry) {
      sqliteModule.createUpload(entry);
    },
    async getSessionRecord(sid) {
      return sqliteModule.getSessionRecord(sid);
    },
    async upsertSessionRecord(sid, sess, expiresAt) {
      sqliteModule.upsertSessionRecord(sid, sess, expiresAt);
    },
    async deleteSessionRecord(sid) {
      sqliteModule.deleteSessionRecord(sid);
    },
    async cleanupExpiredSessions(nowMs) {
      sqliteModule.cleanupExpiredSessions(nowMs);
    },
    async consumeRateLimit(key, windowMs, max, nowMs) {
      return sqliteModule.consumeRateLimit(key, windowMs, max, nowMs);
    },
    async cleanupExpiredRateLimits(nowMs) {
      sqliteModule.cleanupExpiredRateLimits(nowMs);
    },
    async close() {},
  };
}

async function buildAdapter(config) {
  if (config.engine === 'sqlite') {
    const adapter = wrapSqlite();
    await adapter.initSchema();
    return adapter;
  }
  if ((config.engine === 'mysql' || config.engine === 'mariadb') && config.mysql) {
    const adapter = createMysqlAdapter({
      engine: config.engine,
      host: config.mysql.host,
      port: config.mysql.port,
      username: config.mysql.username,
      password: config.mysql.password,
      database: config.mysql.database,
    });
    await adapter.initSchema();
    return adapter;
  }
  throw new Error('Invalid database configuration');
}

async function initDb() {
  const config = readDbConfig();
  activeConfig = cloneSafeConfig(config);
  activeAdapter = await buildAdapter(config);
  loadSettingsIntoCache(await activeAdapter.listSettings());
}

async function reloadDb() {
  if (activeAdapter && activeAdapter.close) {
    await activeAdapter.close();
  }
  activeAdapter = null;
  await initDb();
}

async function setSettingValue(key, value) {
  const adapter = requireAdapter();
  await adapter.setSetting(key, value);
  settingsCache.set(String(key), String(value));
}

async function countUsers() {
  return requireAdapter().countUsers();
}

async function listUsers() {
  return requireAdapter().listUsers();
}

async function getUserById(id) {
  return requireAdapter().getUserById(id);
}

async function getUserByUsername(username) {
  return requireAdapter().getUserByUsername(username);
}

async function createUser(user) {
  return requireAdapter().createUser(user, normalizeRole);
}

async function updateUser(id, patch) {
  return requireAdapter().updateUser(id, patch, normalizeRole);
}

async function deleteUser(id) {
  return requireAdapter().deleteUser(id);
}

async function listFlowsForOwner(ownerId) {
  return requireAdapter().listFlowsForOwner(ownerId);
}

async function getFlowForOwner(flowId, ownerId) {
  return requireAdapter().getFlowForOwner(flowId, ownerId);
}

async function saveFlow(input) {
  return requireAdapter().saveFlow(input);
}

async function getPublicFlowByToken(token) {
  return requireAdapter().getPublicFlowByToken(token);
}

async function listPublicFlows(filters) {
  return requireAdapter().listPublicFlows(filters);
}

async function createUpload(entry) {
  return requireAdapter().createUpload(entry);
}

async function getSessionRecord(sid) {
  return requireAdapter().getSessionRecord(sid);
}

async function upsertSessionRecord(sid, sess, expiresAt) {
  return requireAdapter().upsertSessionRecord(sid, sess, expiresAt);
}

async function deleteSessionRecord(sid) {
  return requireAdapter().deleteSessionRecord(sid);
}

async function cleanupExpiredSessions(nowMs) {
  return requireAdapter().cleanupExpiredSessions(nowMs);
}

async function consumeRateLimit(key, windowMs, max, nowMs) {
  return requireAdapter().consumeRateLimit(key, windowMs, max, nowMs);
}

async function cleanupExpiredRateLimits(nowMs) {
  return requireAdapter().cleanupExpiredRateLimits(nowMs);
}

function validateExternalConfig(input) {
  const engine = ['mysql', 'mariadb'].includes(String(input.engine || '').toLowerCase()) ? String(input.engine).toLowerCase() : '';
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const database = String(input.database || '').trim();
  const password = input.password === undefined || input.password === null ? '' : String(input.password);
  const port = parseInt(String(input.port || '3306'), 10);
  if (!engine) throw new Error('engine must be mysql or mariadb');
  if (!host) throw new Error('host is required');
  if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  if (!username) throw new Error('username is required');
  if (!database) throw new Error('database is required');
  return { engine, host, port, username, password, database };
}

function resolveExternalConfig(input) {
  const current = readDbConfig();
  const validated = validateExternalConfig(input || {});
  const wantsStoredPassword = !!input.useStoredPassword;
  if (wantsStoredPassword) {
    const currentMysql = current.mysql || null;
    if (!currentMysql || !currentMysql.password) {
      throw new Error('No stored database password is available');
    }
    validated.password = currentMysql.password;
  }
  return validated;
}

function exportSqliteRows() {
  sqliteModule.initDb();
  return {
    settings: sqliteModule.db.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    users: sqliteModule.db.prepare('SELECT * FROM users ORDER BY username').all(),
    flows: sqliteModule.db.prepare('SELECT * FROM flows ORDER BY created_at').all(),
    uploads: sqliteModule.db.prepare('SELECT * FROM uploads ORDER BY created_at').all(),
    sessions: sqliteModule.db.prepare('SELECT * FROM sessions ORDER BY created_at').all(),
    rateLimits: sqliteModule.db.prepare('SELECT * FROM rate_limits ORDER BY updated_at').all(),
  };
}

async function migrateSqliteToExternal(input) {
  const current = readDbConfig();
  if (current.engine !== 'sqlite' || current.locked) {
    throw new Error('Database is already migrated and cannot switch back to SQLite');
  }

  const external = resolveExternalConfig(input || {});
  const targetConfig = {
    engine: external.engine,
    locked: true,
    migratedAt: new Date().toISOString(),
    mysql: {
      engine: external.engine,
      host: external.host,
      port: external.port,
      username: external.username,
      password: external.password,
      database: external.database,
    },
  };

  const targetAdapter = createMysqlAdapter(external);
  try {
    await targetAdapter.initSchema();
    await targetAdapter.ensureEmptyForMigration();
    const snapshot = exportSqliteRows();
    await targetAdapter.importData(snapshot);
    writeDbConfig(targetConfig);
  } finally {
    await targetAdapter.close();
  }

  await reloadDb();
  return safeDbStatus();
}

async function testExternalConnection(input) {
  const external = resolveExternalConfig(input || {});
  const adapter = createMysqlAdapter(external);
  try {
    await adapter.testConnection();
    return {
      ok: true,
      engine: external.engine,
      host: external.host,
      port: external.port,
      database: external.database,
    };
  } finally {
    await adapter.close();
  }
}

module.exports = {
  sqliteFile,
  initDb,
  reloadDb,
  normalizeRole,
  getSetting,
  setSetting: setSettingValue,
  getDatabaseStatus: safeDbStatus,
  migrateSqliteToExternal,
  testExternalConnection,
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
