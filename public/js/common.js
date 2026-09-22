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
    updateThemeButton();
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ni_theme', next);
    applyTheme(next);
    updateThemeButton();
    return next;
  }

  function updateThemeButton() {
    const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
    const label = current === 'dark' ? 'Light' : 'Dark';
    $('#themeToggle').text(label);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  }

  async function exportElementToImage(elementId, filename) {
    if (typeof htmlToImage === 'undefined') {
      window.alert('Image export is not available.');
      return;
    }
    const el = document.getElementById(elementId);
    if (!el) {
      window.alert('Nothing to export.');
      return;
    }

    const clone = el.cloneNode(true);
    clone.id = el.id;
    clone.style.zoom = '1';
    clone.style.transform = 'none';
    clone.style.position = 'fixed';
    clone.style.left = '-9999px';
    clone.style.top = '0';
    clone.style.width = '4200px';
    clone.style.height = '2800px';
    clone.style.maxWidth = 'none';
    clone.style.maxHeight = 'none';
    document.body.appendChild(clone);

    try {
      const dataUrl = await htmlToImage.toPng(clone, { cacheBust: true, pixelRatio: 1 });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      downloadBlob(blob, filename || 'flow.png');
    } catch (err) {
      console.error(err);
      window.alert('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      clone.remove();
    }
  }

  function printFlow() {
    window.print();
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
          if (window.location.pathname !== '/force-password-change') {
            window.location = '/force-password-change';
          }
        },
        401: function () {
          if (window.location.pathname !== '/login') {
            window.location = '/login';
          }
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
          if (window.location.pathname !== '/force-password-change') {
            window.location = '/force-password-change';
          }
        },
        401: function () {
          if (window.location.pathname !== '/login') {
            window.location = '/login';
          }
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
    exportElementToImage,
    printFlow,
  };
})();

$(function () {
  NI.initTheme();
});
