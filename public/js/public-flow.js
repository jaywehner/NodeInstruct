$(function () {
  const canvasEl = document.getElementById('canvas');
  const svgEl = document.getElementById('link-layer');
  const nodeLayer = $('#node-layer');

  const canvasWidth = 4200;
  const canvasHeight = 2800;
  svgEl.setAttribute('width', String(canvasWidth));
  svgEl.setAttribute('height', String(canvasHeight));
  svgEl.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);

  const svgNs = 'http://www.w3.org/2000/svg';
  const OUTPUT_COLOR_OPTIONS = [
    '#000000', '#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#eab308',
    '#f97316', '#8b5cf6', '#ec4899', '#374151', '#d1d5db',
  ];

  function createSvgEl(tag) {
    return document.createElementNS(svgNs, tag);
  }

  function setStatus(msg) {
    $('#flowTitle').text(msg || 'Public Flow');
  }

  function defaultOutputColorForId(id) {
    if (id === 'yes') return '#22c55e';
    if (id === 'no') return '#ef4444';
    return '#374151';
  }

  function normalizeOutputColor(color, fallback) {
    const want = String(color || '').toLowerCase();
    const found = OUTPUT_COLOR_OPTIONS.find(function (v) {
      return String(v).toLowerCase() === want;
    });
    return found || fallback || '#374151';
  }

  function portCenter(nodeId, portClass) {
    let el = null;
    if (portClass === 'in') {
      el = document.querySelector('.node-card[data-id="' + nodeId + '"] .port.in');
    } else {
      el = document.querySelector('.node-card[data-id="' + nodeId + '"] .port.out[data-port-id="' + portClass + '"]');
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cr = canvasEl.getBoundingClientRect();
    return { x: r.left - cr.left + r.width / 2, y: r.top - cr.top + r.height / 2 };
  }

  function bezierPath(a, b) {
    const dx = Math.max(80, Math.abs(b.x - a.x) * 0.5);
    const c1x = a.x + dx;
    const c2x = b.x - dx;
    return 'M' + a.x + ',' + a.y + ' C' + c1x + ',' + a.y + ' ' + c2x + ',' + b.y + ' ' + b.x + ',' + b.y;
  }

  function publicAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw || !raw.startsWith('/storage/')) return raw;
    const sep = raw.indexOf('?') === -1 ? '?' : '&';
    return raw + sep + 'publicToken=' + encodeURIComponent(token);
  }

  function nodeBodyHtml(n) {
    const captionEnabled = !!(n.content && n.content.captionEnabled);
    const captionText = n.content && n.content.captionText ? $('<div>').text(String(n.content.captionText)).html() : '';
    const captionHtml = captionEnabled ? '<div class="node-caption">' + (captionText || '(caption)') + '</div>' : '';

    if (n.type === 'start') return '<div style="font-size:12px;color:var(--muted);">Begin the process here.</div>';
    if (n.type === 'end') return '<div style="font-size:12px;color:var(--muted);">Process complete.</div>';
    if (n.type === 'text') return (n.content && n.content.html) || '<div style="font-size:12px;color:var(--muted);">(empty)</div>';
    if (n.type === 'image') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const w = Math.max(80, Math.min(900, parseInt((n.content && n.content.mediaSize && n.content.mediaSize.w) || 260, 10) || 260));
        const h = Math.max(60, Math.min(700, parseInt((n.content && n.content.mediaSize && n.content.mediaSize.h) || 180, 10) || 180));
        return captionHtml + '<div class="media-box" style="width:' + w + 'px;height:' + h + 'px;"><img src="' + publicAssetUrl(f.url) + '" alt="" /></div>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No image</div>';
    }
    if (n.type === 'file') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const name = String(f.originalName || 'file');
        const url = publicAssetUrl(f.url);
        return (
          captionHtml +
          '<div class="file-node-wrap">' +
          '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + $('<div>').text(name).html() + '</a>' +
          '<a class="ghost-link file-download" href="' + url + '" download>Download</a>' +
          '</div>'
        );
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No file</div>';
    }
    if (n.type === 'video') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const typeAttr = f.mimeType ? ' type="' + $('<div>').text(String(f.mimeType)).html() + '"' : '';
        return captionHtml + '<video controls><source src="' + publicAssetUrl(f.url) + '"' + typeAttr + ' /></video>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No video</div>';
    }
    if (n.type === 'audio') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const typeAttr = f.mimeType ? ' type="' + $('<div>').text(String(f.mimeType)).html() + '"' : '';
        return captionHtml + '<audio controls><source src="' + publicAssetUrl(f.url) + '"' + typeAttr + ' /></audio>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No audio</div>';
    }
    return '';
  }

  function normalizeOutputs(n) {
    if (!n || n.type === 'end') return [];

    if (Array.isArray(n.outputs)) {
      return n.outputs.filter(function (o) {
        return o && typeof o === 'object' && o.id && o.enabled;
      }).map(function (o) {
        return {
          id: String(o.id),
          label: String(o.label || o.id),
          color: normalizeOutputColor(o.color, defaultOutputColorForId(o.id)),
        };
      });
    }

    const yes = n.outputs && typeof n.outputs.yes === 'boolean' ? n.outputs.yes : true;
    const no = n.outputs && typeof n.outputs.no === 'boolean' ? n.outputs.no : false;
    const out = [];
    if (yes) out.push({ id: 'yes', label: 'Yes', color: defaultOutputColorForId('yes') });
    if (no) out.push({ id: 'no', label: 'No', color: defaultOutputColorForId('no') });
    return out;
  }

  function buildNodeHtml(n) {
    const safeTitle = $('<div>').text(n.title || '').html();
    const outputs = n.type === 'end' ? [] : normalizeOutputs(n);
    const hasOutputs = outputs.length > 0;

    let inPort = '';
    if (n.type !== 'start') inPort = '<div class="port-in"><div class="port in"></div></div>';

    let outPorts = '';
    if (n.type !== 'end') {
      outPorts = '<div class="node-outputs">' + outputs.map(function (o) {
        const safeLabel = $('<div>').text(o.label || o.id).html();
        const safeColor = normalizeOutputColor(o.color, defaultOutputColorForId(o.id));
        const idAttr = $('<div>').text(o.id).html();
        return '<div class="port-group dyn"><div class="port-label">' + safeLabel + '</div><div class="port out custom" style="background:' + safeColor + ';" data-port-id="' + idAttr + '"></div></div>';
      }).join('') + '</div>';
    }

    return (
      '<div class="node-card' + (hasOutputs ? '' : ' no-outputs') + '" data-id="' + n.id + '">' +
      '<div class="node-header">' +
      '<div class="node-title">' + safeTitle + '</div>' +
      '</div>' +
      '<div class="node-main">' +
      '<div class="node-body">' + nodeBodyHtml(n) + '</div>' +
      outPorts +
      '</div>' +
      inPort +
      '</div>'
    );
  }

  function render(flow) {
    const nodes = ((flow && flow.data && flow.data.nodes) || []).map(function (n) {
      const nn = Object.assign({}, n);
      if (!nn.w) nn.w = 260;
      if (!nn.h) nn.h = 150;
      if (!nn.content) nn.content = {};
      return nn;
    });

    const links = (flow && flow.data && flow.data.links) || [];

    nodeLayer.empty();
    nodes.forEach(function (n) {
      const card = $(buildNodeHtml(n));
      card.css({ left: n.x, top: n.y, width: n.w, height: n.h });
      if (card[0] && n.color) card[0].style.setProperty('--node-color', n.color);
      nodeLayer.append(card);
    });

    svgEl.innerHTML = '';
    links.forEach(function (l) {
      const a = portCenter(l.sourceId, l.sourcePort);
      const b = portCenter(l.targetId, 'in');
      if (!a || !b) return;
      const path = createSvgEl('path');
      const sourceNode = nodes.find(function (n) { return n.id === l.sourceId; });
      const sourceOutput = normalizeOutputs(sourceNode).find(function (o) { return o.id === l.sourcePort; });
      const stroke = normalizeOutputColor(sourceOutput && sourceOutput.color, defaultOutputColorForId(l.sourcePort));
      path.setAttribute('class', 'link custom');
      path.setAttribute('stroke', stroke);
      path.setAttribute('d', bezierPath(a, b));
      svgEl.appendChild(path);
    });
  }

  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  if (!token) {
    setStatus('Flow not found');
    return;
  }

  NI.apiJson('GET', '/api/public/flows/' + encodeURIComponent(token))
    .done(function (resp) {
      const flow = resp && resp.flow;
      if (!flow) {
        setStatus('Flow not found');
        return;
      }

      setStatus((flow.name || 'Public Flow') + ' by ' + (flow.ownerUsername || '')); 
      render(flow);
    })
    .fail(function () {
      setStatus('Flow not found');
    });
});
