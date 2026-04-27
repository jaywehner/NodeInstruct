const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const storageRoot = path.join(__dirname, '..', 'storage');
const usersFile = path.join(dataDir, 'users.json');
const flowsFile = path.join(dataDir, 'flows.json');
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.zip', '.xml', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.tiff',
  '.mp3', '.wav', '.mp4', '.mpeg', '.avi', '.webm', '.wmv', '.ogg', '.mov', '.m4v', '.flac',
  '.pptx', '.ppt', '.docm', '.xlsm', '.dotx', '.xltx', '.pub', '.crt', '.csr',
]);

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function ensureDataDir() {
  ensureDir(dataDir);
  ensureDir(storageRoot);
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]', 'utf8');
  if (!fs.existsSync(flowsFile)) fs.writeFileSync(flowsFile, '[]', 'utf8');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadUsers() {
  return readJson(usersFile, []);
}

function saveUsers(users) {
  writeJson(usersFile, users);
}

function loadFlows() {
  return readJson(flowsFile, []);
}

function saveFlows(flows) {
  writeJson(flowsFile, flows);
}

function safeName(value) {
  return String(value || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getStorageRoot() {
  ensureDir(storageRoot);
  return storageRoot;
}

function ensureUserStorageDir(username) {
  const dir = path.join(getStorageRoot(), safeName(username));
  ensureDir(dir);
  return dir;
}

function createStoredFilename(originalName) {
  const safe = String(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${Date.now()}_${Math.random().toString(16).slice(2, 8)}_${safe}`;
}

function removeStoredUrlFile(urlPath, username) {
  const rel = String(urlPath || '').trim();
  if (!rel.startsWith('/storage/')) return false;

  const userPrefix = '/storage/' + safeName(username) + '/';
  if (!rel.startsWith(userPrefix)) return false;

  const abs = path.join(getStorageRoot(), rel.replace(/^\/storage\//, ''));
  const root = getStorageRoot();
  if (!abs.startsWith(root)) return false;

  try {
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      return true;
    }
  } catch {
  }
  return false;
}

function isDisallowedFile(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return !ALLOWED_UPLOAD_EXTENSIONS.has(ext);
}

module.exports = {
  ensureDataDir,
  loadUsers,
  saveUsers,
  loadFlows,
  saveFlows,
  getStorageRoot,
  ensureUserStorageDir,
  createStoredFilename,
  removeStoredUrlFile,
  isDisallowedFile,
  ALLOWED_UPLOAD_EXTENSIONS,
};
