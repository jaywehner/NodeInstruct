window.NI = (function () {
  function getStoredTheme() {
    const t = localStorage.getItem('ni_theme');
    if (t === 'light' || t === 'dark') return t;
    return null;
  }

  function getSystemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function initTheme() {
    applyTheme(getStoredTheme() || getSystemTheme());
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ni_theme', next);
    applyTheme(next);
    return next;
  }

  function formatError(xhr) {
    if (!xhr) return 'Error';
    if (xhr.responseJSON && xhr.responseJSON.error) return String(xhr.responseJSON.error);
    if (xhr.responseText) return String(xhr.responseText);
    return 'Error';
  }

  function getCookie(name) {
    const parts = String(document.cookie || '').split(';');
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i].trim();
      if (!p) continue;
      if (p.startsWith(name + '=')) {
        return decodeURIComponent(p.slice(name.length + 1));
      }
    }
    return '';
  }

  function csrfHeaders(method) {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return {};
    const token = getCookie('ni_csrf');
    if (!token) return {};
    return { 'X-CSRF-Token': token };
  }

  function apiJson(method, url, body) {
    return $.ajax({
      method,
      url,
      data: body ? JSON.stringify(body) : undefined,
      contentType: 'application/json',
      dataType: 'json',
      headers: csrfHeaders(method),
      statusCode: {
        423: function () {
          window.location = '/force-password-change';
        },
        401: function () {
          window.location = '/login';
        },
      },
    });
  }

  function apiForm(url, formData) {
    return $.ajax({
      method: 'POST',
      url,
      data: formData,
      processData: false,
      contentType: false,
      dataType: 'json',
      headers: csrfHeaders('POST'),
      statusCode: {
        423: function () {
          window.location = '/force-password-change';
        },
        401: function () {
          window.location = '/login';
        },
      },
    });
  }

  return {
    initTheme,
    toggleTheme,
    apiJson,
    apiForm,
    formatError,
  };
})();

$(function () {
  NI.initTheme();
});
