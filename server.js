const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sanitizeHtml = require('sanitize-html');

const {
  ensureDataDir,
  getStorageRoot,
  ensureUserStorageDir,
  createStoredFilename,
  removeStoredUrlFile,
  isDisallowedFile,
  ALLOWED_UPLOAD_EXTENSIONS,
} = require('./src/storage');

const nodemailer = require('nodemailer');

const {
  initDb,
  normalizeRole,
  getSetting,
  setSetting,
  getDatabaseStatus,
  isDbReady,
  migrateSqliteToExternal,
  testExternalConnection,
  testDatabaseConnection,
  createAndInitDatabase,
  reloadDb,
  countUsers,
  listUsers,
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
} = require('./src/db-runtime');

const {
  requireAuth,
  requireAdmin,
  requireEditor,
  requirePasswordChange,
  buildUserSession,
} = require('./src/auth');

ensureDataDir();

const app = express();
const PORT = process.env.PORT || 3000;
const ROLE_VALUES = ['admin', 'editor', 'view_only'];
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ALLOW_SELF_REGISTER = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_SELF_REGISTER || '').toLowerCase());
const BOOTSTRAP_ADMIN_USERNAME = String(process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').trim() || 'admin';
const BOOTSTRAP_ADMIN_PASSWORD = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const memorySessions = new Map();

class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    (async () => {
      if (!isDbReady()) {
        const entry = memorySessions.get(sid);
        if (!entry) return cb(null, null);
        if (entry.expiresAt <= Date.now()) {
          memorySessions.delete(sid);
          return cb(null, null);
        }
        return cb(null, JSON.parse(entry.sess || '{}'));
      }
      await cleanupExpiredSessions(Date.now());
      const row = await getSessionRecord(sid);
      if (!row) return cb(null, null);
      if (row.expiresAt <= Date.now()) {
        await deleteSessionRecord(sid);
        return cb(null, null);
      }
      const data = JSON.parse(row.sess || '{}');
      return cb(null, data);
    })().catch((err) => {
      return cb(err);
    });
  }

  set(sid, sess, cb) {
    (async () => {
      const expiresAt = sess && sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + SESSION_TTL_MS;
      if (!isDbReady()) {
        memorySessions.set(sid, { expiresAt, sess: JSON.stringify(sess || {}) });
        return cb && cb(null);
      }
      await upsertSessionRecord(sid, JSON.stringify(sess || {}), expiresAt);
      return cb && cb(null);
    })().catch((err) => {
      return cb && cb(err);
    });
  }

  destroy(sid, cb) {
    (async () => {
      if (!isDbReady()) {
        memorySessions.delete(sid);
        return cb && cb(null);
      }
      await deleteSessionRecord(sid);
      return cb && cb(null);
    })().catch((err) => {
      return cb && cb(err);
    });
  }

  touch(sid, sess, cb) {
    return this.set(sid, sess, cb);
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'nodeinstruct-dev-secret';
if (IS_PROD && SESSION_SECRET === 'nodeinstruct-dev-secret') {
  throw new Error('SESSION_SECRET must be set in production');
}

function validatePasswordRules(password) {
  const value = String(password || '');
  const errors = [];
  if (value.length < 8) errors.push('Password must be at least 8 characters long.');
  if (!/[a-z]/.test(value)) errors.push('Password must include at least one lowercase letter.');
  if (!/[A-Z]/.test(value)) errors.push('Password must include at least one uppercase letter.');
  if (!/[0-9]/.test(value)) errors.push('Password must include at least one number.');
  return errors;
}

async function getProtectedAdminUserId() {
  const users = await listUsers();
  const admins = users
    .filter((user) => user.role === 'admin')
    .slice()
    .sort((a, b) => {
      const createdA = String(a.createdAt || '9999-12-31T23:59:59.999Z');
      const createdB = String(b.createdAt || '9999-12-31T23:59:59.999Z');
      if (createdA !== createdB) return createdA.localeCompare(createdB);
      const usernameA = String(a.username || '').toLowerCase();
      const usernameB = String(b.username || '').toLowerCase();
      if (usernameA !== usernameB) return usernameA.localeCompare(usernameB);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  return admins[0] ? admins[0].id : null;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(
  session({
    name: 'ni.sid',
    secret: SESSION_SECRET,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: SESSION_TTL_MS,
    },
  })
);

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.cookie('ni_csrf', req.session.csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure: IS_PROD,
    path: '/',
  });
  next();
});

function sameOriginRequest(req) {
  const host = String(req.get('host') || '').toLowerCase();
  const originHeader = String(req.get('origin') || '').trim();
  const refererHeader = String(req.get('referer') || '').trim();

  const candidate = originHeader || refererHeader;
  if (!candidate || !host) return false;

  try {
    const parsed = new URL(candidate);
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  if (!sameOriginRequest(req)) {
    return res.status(403).json({ error: 'Invalid request origin' });
  }

  const headerToken = String(req.get('x-csrf-token') || '').trim();
  if (!headerToken || headerToken !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  return next();
}

function makeRateLimiter(options) {
  const windowMs = options.windowMs;
  const max = options.max;
  let lastCleanupAt = 0;

  return async function rateLimit(req, res, next) {
    if (!isDbReady()) return next();
    const now = Date.now();
    const key = `${options.keyPrefix || 'rl'}:${req.ip || 'unknown'}`;
    try {
      if (now - lastCleanupAt >= windowMs) {
        await cleanupExpiredRateLimits(now);
        lastCleanupAt = now;
      }

      const result = await consumeRateLimit(key, windowMs, max, now);
      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil((result.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many requests' });
      }

      return next();
    } catch {
      return res.status(500).json({ error: 'Rate limit check failed' });
    }
  };
}

const writeRateLimit = makeRateLimiter({ keyPrefix: 'write', windowMs: 60 * 1000, max: 120 });
const authRateLimit = makeRateLimiter({ keyPrefix: 'auth', windowMs: 15 * 60 * 1000, max: 20 });

app.use('/api', requireCsrf);
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return writeRateLimit(req, res, next);
});
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/register', authRateLimit);
app.use('/api/auth/change-password', authRateLimit);

app.use('/static', express.static(path.join(__dirname, 'public')));

app.use('/vendor/d3', express.static(path.join(__dirname, 'node_modules', 'd3', 'dist')));
app.use('/vendor/jquery', express.static(path.join(__dirname, 'node_modules', 'jquery', 'dist')));
app.use('/vendor/jquery-ui', express.static(path.join(__dirname, 'node_modules', 'jquery-ui-dist')));
app.use('/vendor/html-to-image', express.static(path.join(__dirname, 'node_modules', 'html-to-image', 'dist')));

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(String(password || ''), 10, (err, hash) => {
      if (err) return reject(err);
      return resolve(hash);
    });
  });
}

function comparePassword(password, passwordHash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(String(password || ''), String(passwordHash || ''), (err, same) => {
      if (err) return reject(err);
      return resolve(!!same);
    });
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getSmtpSettings() {
  return {
    host: String(getSetting('smtp_host', '') || '').trim(),
    port: parseInt(String(getSetting('smtp_port', '587') || ''), 10) || 587,
    user: String(getSetting('smtp_user', '') || '').trim(),
    pass: String(getSetting('smtp_pass', '') || ''),
    from: String(getSetting('smtp_from', '') || '').trim(),
    secure: String(getSetting('smtp_secure', '0')).toLowerCase() === '1',
  };
}

function createSmtpTransport(settings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
  });
}

async function testSmtpSettings(settings, testEmail) {
  const transport = createSmtpTransport(settings);
  try {
    await transport.verify();
    if (testEmail) {
      await transport.sendMail({
        from: settings.from || settings.user,
        to: testEmail,
        subject: 'NodeInstruct SMTP test',
        text: 'This is a test email from NodeInstruct.',
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendVerificationEmail(email, token) {
  const settings = getSmtpSettings();
  if (!settings.host || !settings.from) return Promise.resolve(false);
  const transport = createSmtpTransport(settings);
  const link = `${process.env.BASE_URL || `http://localhost:${PORT}`}/verify-email?token=${encodeURIComponent(token)}`;
  return transport.sendMail({
    from: settings.from,
    to: email,
    subject: 'Verify your NodeInstruct account',
    text: `Click the link to verify your email: ${link}`,
    html: `<p>Click the link to verify your email:</p><p><a href="${link}">${link}</a></p>`,
  }).then(() => true).catch(() => false);
}

function sendPasswordResetEmail(email, token) {
  const settings = getSmtpSettings();
  if (!settings.host || !settings.from) return Promise.resolve(false);
  const transport = createSmtpTransport(settings);
  const link = `${process.env.BASE_URL || `http://localhost:${PORT}`}/reset-password?token=${encodeURIComponent(token)}`;
  return transport.sendMail({
    from: settings.from,
    to: email,
    subject: 'Reset your NodeInstruct password',
    text: `Use this link to reset your password. It expires in one hour: ${link}`,
    html: `<p>Use the link below to reset your NodeInstruct password. This link expires in one hour.</p><p><a href="${link}">${link}</a></p>`,
  }).then(() => true).catch(() => false);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function initDefaultAdmin() {
  if (await countUsers() > 0) return;
  const setupComplete = getSetting('setup_complete') === '1';
  if (!setupComplete && !BOOTSTRAP_ADMIN_PASSWORD) return;

  const bootstrapPassword = BOOTSTRAP_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(bootstrapPassword);
  await createUser({
    id: uuidv4(),
    username: BOOTSTRAP_ADMIN_USERNAME,
    passwordHash,
    role: 'admin',
    forcePasswordChange: true,
    emailVerified: true,
    verificationToken: null,
    createdAt: new Date().toISOString(),
  });

  console.log(`Bootstrap admin created: ${BOOTSTRAP_ADMIN_USERNAME}`);
  console.log(`Bootstrap admin temporary password: ${bootstrapPassword}`);
}

function getMaxUploadMb() {
  const val = parseInt(String(getSetting('max_upload_mb', '250')), 10);
  if (Number.isNaN(val)) return 250;
  return Math.max(1, Math.min(2048, val));
}

function isSelfRegisterEnabled() {
  const fallback = ALLOW_SELF_REGISTER ? '1' : '0';
  const value = String(getSetting('allow_self_register', fallback) || fallback).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function safeStorageName(value) {
  return String(value || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveStorageRequest(requestPath) {
  const segments = String(requestPath || '').split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const decoded = [];
  for (let i = 0; i < segments.length; i += 1) {
    try {
      const part = decodeURIComponent(segments[i]);
      if (!part || part === '.' || part === '..' || part.includes('\0')) return null;
      decoded.push(part);
    } catch {
      return null;
    }
  }

  const root = getStorageRoot();
  const relativePath = path.join(...decoded);
  const absolutePath = path.join(root, relativePath);
  if (!absolutePath.startsWith(root + path.sep) && absolutePath !== root) return null;

  return {
    absolutePath,
    urlPath: '/storage/' + decoded.join('/'),
  };
}

function publicFlowAllowsStorageUrl(publicToken, urlPath) {
  const token = String(publicToken || '').trim();
  if (!token) return false;

  return getPublicFlowByToken(token).then((flow) => {
    if (!flow || !flow.data || !Array.isArray(flow.data.nodes)) return false;

    return flow.data.nodes.some((node) => {
      return !!(node && node.content && node.content.file && node.content.file.url === urlPath);
    });
  });
}

async function canAccessStorageUrl(req, urlPath) {
  const sessionUser = req.session && req.session.user;
  if (sessionUser) {
    if (sessionUser.role === 'admin') return true;
    const ownPrefix = '/storage/' + safeStorageName(sessionUser.username) + '/';
    if (urlPath.startsWith(ownPrefix)) return true;
  }

  return publicFlowAllowsStorageUrl(req.query.publicToken, urlPath);
}

app.use('/storage', asyncRoute(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end();
  }

  const resolved = resolveStorageRequest(req.path);
  if (!resolved) return res.status(400).send('Invalid file path');
  if (!await canAccessStorageUrl(req, resolved.urlPath)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(resolved.absolutePath)) return res.status(404).send('Not found');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(resolved.absolutePath);
}));

function outputSettingsForNode(n) {
  if (!n || n.type === 'end') return [];

  const maxOutputs = 6;
  const allowedColors = new Set([
    '#000000', '#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#eab308',
    '#f97316', '#8b5cf6', '#ec4899', '#374151', '#d1d5db',
  ]);

  function defaultColorForId(id) {
    if (id === 'yes') return '#22c55e';
    if (id === 'no') return '#ef4444';
    return '#374151';
  }

  function normalizeColor(color, fallback) {
    const c = String(color || '').toLowerCase();
    if (allowedColors.has(c)) return c;
    return fallback;
  }

  const out = [];

  if (Array.isArray(n.outputs)) {
    for (let i = 0; i < n.outputs.length && out.length < maxOutputs; i += 1) {
      const o = n.outputs[i];
      if (!o || typeof o !== 'object') continue;
      const id = String(o.id || `out_${i}`).trim().slice(0, 40);
      if (!id) continue;
      out.push({
        id,
        label: String(o.label || `Output ${i + 1}`).trim().slice(0, 32) || `Output ${i + 1}`,
        enabled: !!o.enabled,
        color: normalizeColor(o.color, defaultColorForId(id)),
      });
    }
  } else {
    const yes = n.outputs && typeof n.outputs.yes === 'boolean' ? n.outputs.yes : true;
    const no = n.outputs && typeof n.outputs.no === 'boolean' ? n.outputs.no : false;
    out.push({ id: 'yes', label: 'Yes', enabled: yes, color: defaultColorForId('yes') });
    out.push({ id: 'no', label: 'No', enabled: no, color: defaultColorForId('no') });
  }

  if (out.length === 0) {
    out.push({ id: 'yes', label: 'Yes', enabled: true, color: defaultColorForId('yes') });
  }

  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < out.length && normalized.length < maxOutputs; i += 1) {
    const o = out[i];
    let id = String(o.id || `out_${i}`).trim();
    if (!id || seen.has(id)) id = `out_${i}`;
    seen.add(id);
    normalized.push({
      id,
      label: String(o.label || `Output ${i + 1}`).trim().slice(0, 32) || `Output ${i + 1}`,
      enabled: !!o.enabled,
      color: normalizeColor(o.color, defaultColorForId(id)),
    });
  }

  return normalized;
}

function cleanFlowData(data) {
  if (!data || typeof data !== 'object') return { meta: { version: 1 }, nodes: [], links: [] };

  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const links = Array.isArray(data.links) ? data.links : [];
  const nodeById = new Map();

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'text' && n.content && typeof n.content.html === 'string') {
      n.content.html = sanitizeHtml(n.content.html, {
        allowedTags: [
          'b', 'i', 'u', 'strong', 'em', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'a',
        ],
        allowedAttributes: { a: ['href', 'target', 'rel'] },
        allowedSchemes: ['http', 'https', 'mailto'],
      });
    }
    if (typeof n.title === 'string') {
      n.title = String(n.title).slice(0, 200);
    }
    n.outputs = outputSettingsForNode(n);
    nodeById.set(n.id, n);
  }

  const cleanedLinks = links.filter((l) => {
    if (!l || !l.sourceId || !l.targetId || !l.sourcePort) return false;
    const source = nodeById.get(l.sourceId);
    const target = nodeById.get(l.targetId);
    if (!source || !target) return false;
    if (target.type === 'start') return false;
    if (source.type === 'end') return false;
    const sourcePort = String(l.sourcePort || '');
    if (!sourcePort) return false;
    return source.outputs.some((o) => o.id === sourcePort && o.enabled);
  });

  return {
    meta: { version: 1 },
    nodes,
    links: cleanedLinks,
  };
}

function uploadMiddleware(req, res, next) {
  const imageAllowed = new Set(['.png', '.jpg', '.jpeg', '.gif', '.tiff']);
  const videoAllowed = new Set(['.mp4', '.mpeg', '.avi', '.webm', '.wmv', '.ogg', '.mov', '.m4v']);
  const audioAllowed = new Set(['.mp3', '.wav', '.ogg', '.flac']);

  const mw = multer({
    storage: multer.diskStorage({
      destination: (req2, file, cb) => {
        const username = req2.session && req2.session.user && req2.session.user.username;
        cb(null, ensureUserStorageDir(username));
      },
      filename: (req2, file, cb) => {
        cb(null, createStoredFilename(file.originalname));
      },
    }),
    limits: { fileSize: getMaxUploadMb() * 1024 * 1024 },
    fileFilter: (req2, file, cb) => {
      if (isDisallowedFile(file.originalname)) {
        const supported = Array.from(ALLOWED_UPLOAD_EXTENSIONS).sort().join(', ');
        return cb(new Error('File type not allowed. Supported: ' + supported));
      }

      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      const kind = String(req2.query.kind || 'file').toLowerCase();

      if (kind === 'image') {
        if (!imageAllowed.has(ext)) return cb(new Error('Image type not allowed'));
      }

      if (kind === 'video') {
        if (!videoAllowed.has(ext)) {
          return cb(new Error('Video type not allowed'));
        }
      }

      if (kind === 'audio') {
        if (!audioAllowed.has(ext)) {
          return cb(new Error('Audio type not allowed'));
        }
      }

      return cb(null, true);
    },
  }).single('file');

  mw(req, res, next);
}

async function isSetupRequired() {
  try {
    if (!isDbReady()) return true;
    return getSetting('setup_complete') !== '1' && await countUsers() === 0;
  } catch {
    return true;
  }
}

app.get('/', async (req, res) => {
  if (await isSetupRequired()) return res.redirect('/setup');
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.forcePasswordChange) return res.redirect('/force-password-change');
  return res.redirect('/app');
});

app.get('/setup', async (req, res) => {
  if (!(await isSetupRequired())) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/verify-email', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify-email.html'));
});

app.get('/login', async (req, res) => {
  if (await isSetupRequired()) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', async (req, res) => {
  if (await isSetupRequired()) return res.redirect('/setup');
  if (!isSelfRegisterEnabled()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/forgot-password', async (req, res) => {
  if (await isSetupRequired()) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/reset-password', async (req, res) => {
  if (await isSetupRequired()) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/force-password-change', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'force-password-change.html'));
});

app.get('/app', requireAuth, requirePasswordChange, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/admin', requireAuth, requirePasswordChange, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/public-flows', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public-flows.html'));
});

app.get('/flow/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public-flow.html'));
});

app.get('/api/auth/config', (req, res) => {
  res.json({ allowSelfRegister: isSelfRegisterEnabled() });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const user = await getUserByUsername(String(username));
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.emailVerified) {
      return res.status(401).json({ error: 'Email not verified. Check your inbox or contact an administrator.' });
    }

    await regenerateSession(req);
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('ni_csrf', req.session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: IS_PROD,
      path: '/',
    });
    req.session.user = buildUserSession(user);
    return res.json({ ok: true, user: req.session.user });
  } catch {
    return res.status(500).json({ error: 'Failed to create session' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ni.sid');
    res.clearCookie('ni_csrf');
    res.json({ ok: true });
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    if (!isSelfRegisterEnabled()) return res.status(403).json({ error: 'Self-registration is disabled' });
    const { username, password, confirmPassword } = req.body;
    const email = String(username || '').trim().toLowerCase();
    if (!email || !password || !confirmPassword) return res.status(400).json({ error: 'Please fill in email, password, and confirm password.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (String(password) !== String(confirmPassword)) return res.status(400).json({ error: 'Passwords do not match.' });
    const passwordErrors = validatePasswordRules(password);
    if (passwordErrors.length) return res.status(400).json({ error: passwordErrors.join(' ') });

    const exists = await getUserByUsername(email);
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const smtp = getSmtpSettings();
    if (!smtp.host || !smtp.from) {
      return res.status(503).json({ error: 'Registration is unavailable until email delivery is configured.' });
    }
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const newUser = {
      id: uuidv4(),
      username: email,
      passwordHash: await hashPassword(password),
      role: 'editor',
      forcePasswordChange: false,
      emailVerified: false,
      verificationToken,
      createdAt: new Date().toISOString(),
    };
    await createUser(newUser);

    const sent = await sendVerificationEmail(email, verificationToken);
    if (!sent) {
      return res.status(502).json({ error: 'Account created, but the verification email could not be sent. Use Resend verification email on the login page.' });
    }

    return res.json({ ok: true, message: 'Account created. Check your email for a verification link before signing in.' });
  } catch {
    return res.status(500).json({ error: 'Failed to register user' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const user = await getUserByUsername(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await setPasswordResetToken(user.id, tokenHash, Date.now() + 60 * 60 * 1000);
      await sendPasswordResetEmail(email, token);
    }
    return res.json({ ok: true, message: 'If an account exists for that email, a password reset link has been sent.' });
  } catch {
    return res.status(500).json({ error: 'Failed to request password reset' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    if (!token) return res.status(400).json({ error: 'Missing reset token' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
    const passwordErrors = validatePasswordRules(password);
    if (passwordErrors.length) return res.status(400).json({ error: passwordErrors.join(' ') });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await getUserByPasswordResetTokenHash(tokenHash);
    if (!user || Number(user.resetExpiresAt) <= Date.now()) {
      if (user) await clearPasswordResetToken(user.id);
      return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
    }
    await updateUser(user.id, { passwordHash: await hashPassword(password), forcePasswordChange: false });
    await clearPasswordResetToken(user.id);
    return res.json({ ok: true, message: 'Your password has been reset. You can now sign in.' });
  } catch {
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const token = String(req.body.token || req.query.token || '');
    if (!token) return res.status(400).json({ error: 'Missing verification token' });
    const user = await getUserByVerificationToken(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification token' });
    await updateUser(user.id, { emailVerified: true, verificationToken: null });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Failed to verify email' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const user = await getUserByUsername(email);
    if (user && !user.emailVerified) {
      const verificationToken = crypto.randomBytes(32).toString('hex');
      await updateUser(user.id, { verificationToken });
      await sendVerificationEmail(email, verificationToken);
    }
    return res.json({ ok: true, message: 'If the account requires verification, a new email has been sent.' });
  } catch {
    return res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

app.get('/api/setup/status', async (req, res) => {
  res.json({ required: await isSetupRequired() });
});

app.post('/api/setup/database/test', asyncRoute(async (req, res) => {
  const { engine } = req.body || {};
  if (engine === 'sqlite') return res.json({ ok: true, engine: 'sqlite' });
  if (engine === 'mariadb' || engine === 'mysql') {
    const result = await testDatabaseConnection(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error || 'Connection failed' });
    return res.json({ ok: true, engine });
  }
  return res.status(400).json({ error: 'Invalid database engine' });
}));

app.post('/api/setup/database/create', asyncRoute(async (req, res) => {
  const { engine } = req.body || {};
  if (engine === 'sqlite') {
    const sqliteDbConfig = {
      engine: 'sqlite',
      locked: false,
      migratedAt: null,
      mysql: null,
    };
    fs.writeFileSync(path.join(__dirname, 'data', 'database-config.json'), JSON.stringify(sqliteDbConfig, null, 2));
    await reloadDb();
    return res.json({ ok: true, engine: 'sqlite' });
  }
  if (engine === 'mariadb' || engine === 'mysql') {
    const result = await createAndInitDatabase(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error || 'Database creation failed' });
    const dbConfig = {
      engine,
      locked: true,
      migratedAt: null,
      mysql: {
        engine,
        host: req.body.host,
        port: parseInt(String(req.body.port || '3306'), 10) || 3306,
        username: req.body.username,
        password: req.body.password,
        database: req.body.database,
      },
    };
    fs.writeFileSync(path.join(__dirname, 'data', 'database-config.json'), JSON.stringify(dbConfig, null, 2));
    await reloadDb();
    return res.json({ ok: true, engine });
  }
  return res.status(400).json({ error: 'Invalid database engine' });
}));

app.post('/api/setup/smtp', asyncRoute(async (req, res) => {
  const { host, port, user, pass, from, secure, testEmail } = req.body || {};
  const portNum = parseInt(String(port || ''), 10);
  if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'Invalid SMTP port' });
  }
  const settings = {
    host: String(host || '').trim(),
    port: portNum,
    user: String(user || '').trim(),
    pass: String(pass || ''),
    from: String(from || '').trim(),
    secure: !!secure,
  };
  if (!settings.host) {
    return res.status(400).json({ error: 'SMTP host is required' });
  }
  const result = await testSmtpSettings(settings, String(testEmail || '').trim());
  if (!result.ok) return res.status(400).json({ error: result.error });
  await setSetting('smtp_host', settings.host);
  await setSetting('smtp_port', String(settings.port));
  await setSetting('smtp_user', settings.user);
  await setSetting('smtp_from', settings.from);
  await setSetting('smtp_secure', String(settings.secure ? '1' : '0'));
  if (pass && pass !== '********') {
    await setSetting('smtp_pass', pass);
  }
  return res.json({ ok: true });
}));

app.post('/api/setup/admin', asyncRoute(async (req, res) => {
  const { email, password, confirmPassword } = req.body || {};
  if (!email || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (!isValidEmail(String(email))) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (String(password) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  const passwordErrors = validatePasswordRules(password);
  if (passwordErrors.length) return res.status(400).json({ error: passwordErrors.join(' ') });
  if (await countUsers() > 0) {
    return res.status(403).json({ error: 'An administrator already exists' });
  }
  await createUser({
    id: uuidv4(),
    username: String(email).trim().toLowerCase(),
    passwordHash: await hashPassword(password),
    role: 'admin',
    forcePasswordChange: false,
    emailVerified: true,
    verificationToken: null,
    createdAt: new Date().toISOString(),
  });
  await setSetting('setup_complete', '1');
  return res.json({ ok: true });
}));

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'Missing newPassword' });
    const passwordErrors = validatePasswordRules(newPassword);
    if (passwordErrors.length) return res.status(400).json({ error: passwordErrors.join(' ') });

    const user = await getUserById(req.session.user.id);
    if (!user) return res.status(401).json({ error: 'Not found' });

    if (req.session.user.forcePasswordChange) {
    } else {
      const ok = await comparePassword(String(currentPassword || ''), user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    }

    await updateUser(user.id, {
      passwordHash: await hashPassword(newPassword),
      forcePasswordChange: false,
    });

    req.session.user = buildUserSession(await getUserById(user.id));
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

app.get('/api/admin/users', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  const protectedAdminUserId = await getProtectedAdminUserId();
  const users = (await listUsers()).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    forcePasswordChange: !!u.forcePasswordChange,
    emailVerified: !!u.emailVerified,
    createdAt: u.createdAt,
    isProtectedAdmin: u.id === protectedAdminUserId,
  }));
  res.json({ users });
}));

app.get('/api/admin/settings', requireAuth, requirePasswordChange, requireAdmin, (req, res) => {
  const dbStatus = getDatabaseStatus();
  const smtp = getSmtpSettings();
  res.json({
    maxUploadMb: getMaxUploadMb(),
    allowSelfRegister: isSelfRegisterEnabled(),
    database: dbStatus,
    smtp: {
      host: smtp.host,
      port: smtp.port,
      user: smtp.user,
      pass: smtp.pass ? '********' : '',
      from: smtp.from,
      secure: smtp.secure,
    },
  });
});

app.put('/api/admin/settings', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  const maxUploadMb = parseInt(String(req.body.maxUploadMb || ''), 10);
  if (Number.isNaN(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 2048) {
    return res.status(400).json({ error: 'maxUploadMb must be between 1 and 2048' });
  }
  const allowSelfRegister = req.body.allowSelfRegister;
  if (allowSelfRegister !== undefined && typeof allowSelfRegister !== 'boolean') {
    return res.status(400).json({ error: 'allowSelfRegister must be true or false' });
  }
  await setSetting('max_upload_mb', String(maxUploadMb));
  if (allowSelfRegister !== undefined) {
    await setSetting('allow_self_register', allowSelfRegister ? '1' : '0');
  }
  return res.json({
    ok: true,
    maxUploadMb,
    allowSelfRegister: isSelfRegisterEnabled(),
    database: getDatabaseStatus(),
  });
}));

app.post('/api/admin/database/migrate', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const status = await migrateSqliteToExternal(req.body || {});
    return res.json({ ok: true, database: status });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Migration failed' });
  }
}));

app.post('/api/admin/database/test', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const result = await testExternalConnection(req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Connection test failed' });
  }
}));

app.get('/api/admin/smtp', requireAuth, requirePasswordChange, requireAdmin, (req, res) => {
  const smtp = getSmtpSettings();
  res.json({
    host: smtp.host,
    port: smtp.port,
    user: smtp.user,
    pass: smtp.pass ? '********' : '',
    from: smtp.from,
    secure: smtp.secure,
  });
});

app.put('/api/admin/smtp', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  const { host, port, user, pass, from, secure } = req.body || {};
  const portNum = parseInt(String(port || ''), 10);
  if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'Invalid SMTP port' });
  }
  await setSetting('smtp_host', String(host || '').trim());
  await setSetting('smtp_port', String(portNum));
  await setSetting('smtp_user', String(user || '').trim());
  await setSetting('smtp_from', String(from || '').trim());
  await setSetting('smtp_secure', String(!!secure ? '1' : '0'));
  if (pass && pass !== '********') {
    await setSetting('smtp_pass', String(pass));
  }
  const smtp = getSmtpSettings();
  res.json({
    ok: true,
    host: smtp.host,
    port: smtp.port,
    user: smtp.user,
    pass: smtp.pass ? '********' : '',
    from: smtp.from,
    secure: smtp.secure,
  });
}));

app.post('/api/admin/smtp/test', requireAuth, requirePasswordChange, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const { host, port, user, pass, from, secure, testEmail } = req.body || {};
    const portNum = parseInt(String(port || ''), 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ error: 'Invalid SMTP port' });
    }
    const settings = {
      host: String(host || '').trim(),
      port: portNum,
      user: String(user || '').trim(),
      pass: String(pass || ''),
      from: String(from || '').trim(),
      secure: !!secure,
    };
    if (!settings.host || !settings.user) {
      return res.status(400).json({ error: 'SMTP host and user are required' });
    }
    const result = await testSmtpSettings(settings, String(testEmail || '').trim());
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'SMTP test failed' });
  }
}));

app.post('/api/admin/users', requireAuth, requirePasswordChange, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const email = String(username || '').trim();
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (!ROLE_VALUES.includes(normalizeRole(role))) return res.status(400).json({ error: 'Invalid role' });

    const exists = await getUserByUsername(email);
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    await createUser({
      id: uuidv4(),
      username: email,
      passwordHash: await hashPassword(password),
      role: normalizeRole(role),
      forcePasswordChange: false,
      emailVerified: true,
      verificationToken: null,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requirePasswordChange, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password, role, forcePasswordChange, emailVerified } = req.body;

    const user = await getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const patch = {};
    if (role !== undefined) {
      const normalized = normalizeRole(role);
      if (!ROLE_VALUES.includes(normalized)) return res.status(400).json({ error: 'Invalid role' });
      patch.role = normalized;
    }

    if (typeof forcePasswordChange === 'boolean') patch.forcePasswordChange = forcePasswordChange;
    if (typeof emailVerified === 'boolean') patch.emailVerified = emailVerified;

    if (password) {
      const passwordErrors = validatePasswordRules(password);
      if (passwordErrors.length) return res.status(400).json({ error: passwordErrors.join(' ') });
      patch.passwordHash = await hashPassword(password);
    }

    await updateUser(id, patch);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requirePasswordChange, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const target = await getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const protectedAdminUserId = await getProtectedAdminUserId();
  if (protectedAdminUserId && target.id === protectedAdminUserId) {
    return res.status(400).json({ error: 'Cannot delete the first admin account' });
  }

  await deleteUser(id);
  res.json({ ok: true });
});

app.get('/api/flows', requireAuth, requirePasswordChange, asyncRoute(async (req, res) => {
  const flows = (await listFlowsForOwner(req.session.user.id)).map((f) => ({
    id: f.id,
    name: f.name,
    updatedAt: f.updatedAt,
    isPublic: !!f.isPublic,
    publicToken: f.publicToken,
  }));
  res.json({ flows });
}));

app.get('/api/flows/:id', requireAuth, requirePasswordChange, asyncRoute(async (req, res) => {
  const flow = await getFlowForOwner(req.params.id, req.session.user.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  res.json({ flow });
}));

app.post('/api/flows', requireAuth, requirePasswordChange, requireEditor, asyncRoute(async (req, res) => {
  const { id, name, data, isPublic } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  if (data === undefined || data === null || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid data' });
  }

  if (id) {
    const existing = await getFlowForOwner(id, req.session.user.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
  }

  const result = await saveFlow({
    id,
    ownerId: req.session.user.id,
    name: String(name),
    data: cleanFlowData(data),
    isPublic: !!isPublic,
  });

  res.json({ ok: true, flowId: result.id, publicToken: result.publicToken });
}));

app.get('/api/public/flows', asyncRoute(async (req, res) => {
  const result = await listPublicFlows({
    username: req.query.username,
    name: req.query.name,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });
  res.json({
    flows: result.items,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
  });
}));

app.get('/api/public/flows/:token', asyncRoute(async (req, res) => {
  const flow = await getPublicFlowByToken(String(req.params.token || ''));
  if (!flow) return res.status(404).json({ error: 'Not found' });
  return res.json({ flow });
}));

app.post('/api/upload', requireAuth, requirePasswordChange, requireEditor, uploadMiddleware, asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const root = getStorageRoot();
  const relative = path.relative(root, req.file.path).split(path.sep).join('/');
  const url = '/storage/' + relative;

  const kind = String(req.query.kind || 'file').toLowerCase();
  const oldUrl = String(req.body.oldUrl || '').trim();
  if (oldUrl) removeStoredUrlFile(oldUrl, req.session.user.username);

  await createUpload({
    ownerId: req.session.user.id,
    username: req.session.user.username,
    kind,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
    url,
    storagePath: relative,
  });

  res.json({
    ok: true,
    file: {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url,
    },
  });
}));

app.use((err, req, res, next) => {
  if (!err) return next();
  if (String(err.message || '').includes('File too large')) {
    return res.status(413).json({ error: `Upload too large (max ${getMaxUploadMb()}MB)` });
  }
  return res.status(400).json({ error: err.message || 'Error' });
});

initDb()
  .then(() => initDefaultAdmin())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NodeInstruct listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed; starting in setup mode.', err.message || err);
    app.listen(PORT, () => {
      console.log(`NodeInstruct listening on http://localhost:${PORT} (setup mode)`);
    });
  });
