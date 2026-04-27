function isApiRequest(req) {
  return String(req.originalUrl || '').startsWith('/api');
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (isApiRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  if (isApiRequest(req)) return res.status(403).json({ error: 'Forbidden' });
  return res.status(403).send('Forbidden');
}

function requireEditor(req, res, next) {
  const role = req.session && req.session.user && req.session.user.role;
  if (role === 'admin' || role === 'editor') return next();
  if (isApiRequest(req)) return res.status(403).json({ error: 'Read-only user' });
  return res.status(403).send('Forbidden');
}

function canEditRole(role) {
  return role === 'admin' || role === 'editor';
}

function requirePasswordChange(req, res, next) {
  if (req.session && req.session.user && !req.session.user.forcePasswordChange) return next();
  if (isApiRequest(req)) return res.status(423).json({ error: 'Password change required' });
  return res.redirect('/force-password-change');
}

function buildUserSession(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    forcePasswordChange: !!user.forcePasswordChange,
  };
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireEditor,
  requirePasswordChange,
  canEditRole,
  buildUserSession,
};
