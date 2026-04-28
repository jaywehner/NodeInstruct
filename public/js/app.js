$(function () {
  const canvasEl = document.getElementById('canvas');
  const svgEl = document.getElementById('link-layer');
  const layoutEl = document.getElementById('layout');
  const AUTOSAVE_DELAY_MS = 700;

  const canvasWidth = 4200;
  const canvasHeight = 2800;

  svgEl.setAttribute('width', String(canvasWidth));
  svgEl.setAttribute('height', String(canvasHeight));
  svgEl.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);

  const svgNs = 'http://www.w3.org/2000/svg';
  function createSvgEl(tag) {
    return document.createElementNS(svgNs, tag);
  }

  const linkGroupEl = createSvgEl('g');
  const tempGroupEl = createSvgEl('g');
  svgEl.appendChild(linkGroupEl);
  svgEl.appendChild(tempGroupEl);

  const state = {
    user: null,
    canEdit: true,
    flows: [],
    currentFlowId: null,
    flowName: '',
    isPublicFlow: false,
    publicToken: null,
    nodes: [],
    links: [],
    selectedNodeId: null,
    selectedLinkId: null,
    linking: null,
    zoom: 1,
    linkFrameRequested: false,
    dirty: false,
    saving: false,
    autosaveTimer: null,
    saveRequestToken: 0,
  };

  const MAX_OUTPUTS = 6;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  const OUTPUT_COLOR_OPTIONS = [
    { label: 'Black', value: '#000000' },
    { label: 'White', value: '#ffffff' },
    { label: 'Red', value: '#ef4444' },
    { label: 'Blue', value: '#3b82f6' },
    { label: 'Green', value: '#22c55e' },
    { label: 'Yellow', value: '#eab308' },
    { label: 'Orange', value: '#f97316' },
    { label: 'Purple', value: '#8b5cf6' },
    { label: 'Pink', value: '#ec4899' },
    { label: 'Dark Gray', value: '#374151' },
    { label: 'Light Gray', value: '#d1d5db' },
  ];

  function normalizeOutputColor(color, fallback) {
    const want = String(color || '').toLowerCase();
    const found = OUTPUT_COLOR_OPTIONS.find(function (c) {
      return c.value.toLowerCase() === want;
    });
    if (found) return found.value;
    return fallback || '#374151';
  }

  function defaultOutputColorForId(id) {
    if (id === 'yes') return '#22c55e';
    if (id === 'no') return '#ef4444';
    return '#374151';
  }

  function normalizeOutputs(n) {
    if (!n || n.type === 'end') return [];

    const out = [];
    if (Array.isArray(n.outputs)) {
      n.outputs.forEach(function (o, idx) {
        if (!o || typeof o !== 'object') return;
        const id = String(o.id || 'out_' + idx).trim().slice(0, 40);
        if (!id) return;
        out.push({
          id: id,
          label: String(o.label || ('Output ' + (idx + 1))).trim().slice(0, 32),
          enabled: !!o.enabled,
          color: normalizeOutputColor(o.color, defaultOutputColorForId(id)),
        });
      });
    } else {
      const yes = n.outputs && typeof n.outputs.yes === 'boolean' ? n.outputs.yes : true;
      const no = n.outputs && typeof n.outputs.no === 'boolean' ? n.outputs.no : false;
      out.push({ id: 'yes', label: 'Yes', enabled: yes, color: defaultOutputColorForId('yes') });
      out.push({ id: 'no', label: 'No', enabled: no, color: defaultOutputColorForId('no') });
    }

    if (out.length === 0) {
      out.push({ id: 'yes', label: 'Yes', enabled: true, color: defaultOutputColorForId('yes') });
    }

    const unique = [];
    const seen = new Set();
    out.slice(0, MAX_OUTPUTS).forEach(function (o, idx) {
      let id = String(o.id || 'out_' + idx).trim();
      if (!id || seen.has(id)) id = 'out_' + idx;
      seen.add(id);
      unique.push({
        id: id,
        label: String(o.label || ('Output ' + (idx + 1))).trim().slice(0, 32) || ('Output ' + (idx + 1)),
        enabled: !!o.enabled,
        color: normalizeOutputColor(o.color, defaultOutputColorForId(id)),
      });
    });

    return unique;
  }

  function enabledOutputs(n) {
    return normalizeOutputs(n).filter(function (o) {
      return o.enabled;
    });
  }

  function pruneNodeOutputLinks(nodeId, outputs) {
    const allowed = new Set((outputs || []).filter(function (o) { return !!o.enabled; }).map(function (o) { return o.id; }));
    state.links = state.links.filter(function (l) {
      if (l.sourceId !== nodeId) return true;
      return allowed.has(l.sourcePort);
    });
  }

  function applyNodeOutputs(n, nextOutputs) {
    n.outputs = normalizeOutputs({ type: n.type, outputs: nextOutputs });
    pruneNodeOutputLinks(n.id, n.outputs);
  }

  function createOutputsEditor(n) {
    const wrap = $('<div class="dialog-field"></div>');
    wrap.append('<label>Outputs</label>');
    const list = $('<div class="output-editor-list"></div>');
    const addBtn = $('<button type="button" class="ghost" style="width:auto;">Add Output</button>');
    wrap.append(list).append(addBtn);

    let outputs = normalizeOutputs(n).map(function (o) {
      return { id: o.id, label: o.label, enabled: !!o.enabled, color: o.color };
    });

    function nextCustomLabel() {
      let idx = 1;
      while (idx <= 4) {
        const want = 'Custom ' + idx;
        const exists = outputs.some(function (o) { return String(o.label).toLowerCase() === want.toLowerCase(); });
        if (!exists) return want;
        idx += 1;
      }
      return 'Output ' + (outputs.length + 1);
    }

    function render() {
      list.empty();
      outputs.forEach(function (o, idx) {
        const row = $('<div class="output-editor-row"></div>');
        const txt = $('<input type="text" maxlength="32" />').val(o.label || ('Output ' + (idx + 1)));
        txt.on('input', function () {
          outputs[idx].label = String($(this).val() || '').trim().slice(0, 32);
        });

        const enabled = $('<label><input type="checkbox" /> Enabled</label>');
        enabled.find('input').prop('checked', !!o.enabled).on('change', function () {
          outputs[idx].enabled = !!$(this).prop('checked');
        });

        const colorSel = $('<select></select>');
        OUTPUT_COLOR_OPTIONS.forEach(function (opt) {
          const option = $('<option></option>').attr('value', opt.value).text(opt.label);
          colorSel.append(option);
        });
        colorSel.val(normalizeOutputColor(o.color, defaultOutputColorForId(o.id))).on('change', function () {
          outputs[idx].color = normalizeOutputColor($(this).val(), defaultOutputColorForId(outputs[idx].id));
        });

        const remove = $('<button type="button" class="ghost" style="width:auto;">Remove</button>');
        remove.prop('disabled', outputs.length <= 1);
        remove.on('click', function () {
          if (outputs.length <= 1) return;
          outputs.splice(idx, 1);
          render();
        });

        row.append(txt).append(enabled).append(colorSel).append(remove);
        list.append(row);
      });

      addBtn.prop('disabled', !(outputs.length >= 1 && outputs.length < MAX_OUTPUTS));
    }

    addBtn.on('click', function () {
      if (outputs.length >= MAX_OUTPUTS) return;
      outputs.push({
        id: 'out_' + uid(),
        label: nextCustomLabel(),
        enabled: true,
        color: defaultOutputColorForId('custom'),
      });
      render();
    });

    render();

    return {
      el: wrap,
      getOutputs: function () {
        return outputs.map(function (o, idx) {
          return {
            id: String(o.id || ('out_' + idx)).trim().slice(0, 40),
            label: String(o.label || ('Output ' + (idx + 1))).trim().slice(0, 32) || ('Output ' + (idx + 1)),
            enabled: !!o.enabled,
            color: normalizeOutputColor(o.color, defaultOutputColorForId(o.id)),
          };
        }).slice(0, MAX_OUTPUTS);
      },
    };
  }

  function outputById(node, outputId) {
    const outputs = normalizeOutputs(node);
    return outputs.find(function (o) {
      return o.id === outputId;
    }) || null;
  }

  function outputColor(node, outputId) {
    const output = outputById(node, outputId);
    return normalizeOutputColor(output && output.color, defaultOutputColorForId(outputId));
  }

  function clampZoom(val) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, val));
  }

  function updateZoomUi() {
    const pct = Math.round(state.zoom * 100);
    $('#zoomReset').text(pct + '%');
    $('#zoomOut').prop('disabled', state.zoom <= MIN_ZOOM + 0.001);
    $('#zoomIn').prop('disabled', state.zoom >= MAX_ZOOM - 0.001);
  }

  function setCanvasZoom(nextZoom) {
    state.zoom = clampZoom(nextZoom);
    canvasEl.style.zoom = String(state.zoom);
    localStorage.setItem('ni_canvas_zoom', String(state.zoom));
    updateZoomUi();
    scheduleLinkUpdate();
  }

  function loadCanvasZoom() {
    const saved = parseFloat(localStorage.getItem('ni_canvas_zoom') || '1');
    if (!Number.isNaN(saved)) {
      state.zoom = clampZoom(saved);
    }
    setCanvasZoom(state.zoom);
  }

  function publicFlowUrl(token) {
    if (!token) return '';
    return window.location.origin + '/flow/' + encodeURIComponent(token);
  }

  function refreshFlowShareControls() {
    $('#isPublicFlow').prop('checked', !!state.isPublicFlow);
    $('#isPublicFlow').prop('disabled', !state.canEdit);
    $('#copyPublicLink').prop('disabled', !state.publicToken);
  }

  function applyEditPermissions() {
    const disabled = !state.canEdit;
    $('#newFlow').prop('disabled', disabled);
    $('#renameFlow').prop('disabled', disabled);
    $('#saveFlow').prop('disabled', disabled);
    $('#addStart').prop('disabled', disabled);
    $('#addText').prop('disabled', disabled);
    $('#addImage').prop('disabled', disabled);
    $('#addFile').prop('disabled', disabled);
    $('#addVideo').prop('disabled', disabled);
    $('#addAudio').prop('disabled', disabled);
    $('#addEnd').prop('disabled', disabled);
    $('#autoFormat').prop('disabled', disabled);
    updateSelectedButtons();
  }

  function updateSidebarToggleIcon() {
    const collapsed = layoutEl.classList.contains('sidebar-collapsed');
    $('#toggleSidebar').text(collapsed ? 'Tools>' : 'Tools<');
    $('#toggleSidebar').attr('title', collapsed ? 'Show tools' : 'Hide tools');
  }

  function setSidebarWidth(px) {
    const width = Math.max(140, Math.min(420, px));
    layoutEl.style.setProperty('--sidebar-width', width + 'px');
    localStorage.setItem('ni_sidebar_width', String(width));
  }

  function setSidebarCollapsed(collapsed) {
    layoutEl.classList.toggle('sidebar-collapsed', !!collapsed);
    localStorage.setItem('ni_sidebar_collapsed', collapsed ? '1' : '0');
    updateSidebarToggleIcon();
  }

  function loadSidebarState() {
    const savedWidth = parseInt(localStorage.getItem('ni_sidebar_width') || '', 10);
    if (!Number.isNaN(savedWidth)) {
      setSidebarWidth(savedWidth);
    }

    const collapsed = localStorage.getItem('ni_sidebar_collapsed') === '1';
    setSidebarCollapsed(collapsed);
  }

  function uid() {
    return 'n' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function setStatus(msg) {
    $('#status').text(msg || '');
  }

  function updateSaveButtonState() {
    $('#saveFlow').toggleClass('unsaved', !!state.dirty && !state.saving);
  }

  function clearAutosaveTimer() {
    if (!state.autosaveTimer) return;
    window.clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }

  function markDirty(options) {
    const opts = options || {};
    if (!state.canEdit) return;
    state.dirty = true;
    updateSaveButtonState();
    if (!opts.silentStatus) {
      setStatus('Unsaved changes');
    }
    if (opts.autoSave === false) return;
    scheduleAutosave();
  }

  function markSaved() {
    state.dirty = false;
    state.saving = false;
    updateSaveButtonState();
  }

  function scheduleAutosave() {
    if (!state.canEdit || !state.flowName) return;
    clearAutosaveTimer();
    state.autosaveTimer = window.setTimeout(function () {
      state.autosaveTimer = null;
      saveFlow({ reason: 'autosave' });
    }, AUTOSAVE_DELAY_MS);
  }

  function nodeById(id) {
    return state.nodes.find(function (n) {
      return n.id === id;
    });
  }

  function requireLiveNode(nodeId) {
    const liveNode = nodeById(nodeId);
    if (!liveNode) {
      setStatus('The selected node is no longer available');
      return null;
    }
    return liveNode;
  }

  function defaultColorForType(type) {
    if (type === 'start') return '#2563eb';
    if (type === 'end') return '#64748b';
    if (type === 'text') return '#7c3aed';
    if (type === 'image') return '#0ea5e9';
    if (type === 'file') return '#f97316';
    if (type === 'video') return '#db2777';
    if (type === 'audio') return '#0d9488';
    return '#2563eb';
  }

  function newFlowTemplate(name) {
    clearAutosaveTimer();
    const startId = uid();
    const endId = uid();

    state.currentFlowId = null;
    state.flowName = name;
    state.isPublicFlow = false;
    state.publicToken = null;
    state.nodes = [
      {
        id: startId,
        type: 'start',
        title: 'Start',
        x: 120,
        y: 200,
        w: 260,
        h: 150,
        color: defaultColorForType('start'),
        content: {},
        outputs: [
          { id: 'yes', label: 'Yes', enabled: true },
          { id: 'no', label: 'No', enabled: false },
        ],
      },
      {
        id: endId,
        type: 'end',
        title: 'End',
        x: 860,
        y: 200,
        w: 260,
        h: 150,
        color: defaultColorForType('end'),
        content: {},
        outputs: [],
      },
    ];
    state.links = [];
    state.selectedNodeId = null;
    state.selectedLinkId = null;
    state.linking = null;
    state.dirty = true;
    state.saving = false;
    renderAll();
    refreshFlowShareControls();
    setStatus('Unsaved changes');
    updateSaveButtonState();
    scheduleAutosave();
  }

  function flowData() {
    return {
      meta: { version: 1 },
      nodes: state.nodes,
      links: state.links,
    };
  }

  function saveFlow(options) {
    const opts = options || {};
    if (!state.flowName || !state.canEdit) return;
    if (state.saving) {
      if (opts.reason === 'manual') {
        scheduleAutosave();
      }
      return;
    }

    clearAutosaveTimer();
    state.saving = true;
    updateSaveButtonState();
    setStatus(opts.reason === 'autosave' ? 'Autosaving...' : 'Saving...');
    const requestToken = ++state.saveRequestToken;
    NI.apiJson('POST', '/api/flows', {
      id: state.currentFlowId,
      name: state.flowName,
      isPublic: !!state.isPublicFlow,
      data: flowData(),
    })
      .done(function (resp) {
        if (requestToken !== state.saveRequestToken) return;
        if (resp && resp.flowId) state.currentFlowId = resp.flowId;
        if (resp && resp.publicToken) state.publicToken = resp.publicToken;
        refreshFlowShareControls();
        markSaved();
        setStatus(opts.reason === 'autosave' ? 'All changes saved' : 'Saved');
        loadFlowList();
      })
      .fail(function (xhr) {
        if (requestToken !== state.saveRequestToken) return;
        state.saving = false;
        updateSaveButtonState();
        setStatus(NI.formatError(xhr));
        if (state.dirty) {
          scheduleAutosave();
        }
      });
  }

  function loadFlowList() {
    return NI.apiJson('GET', '/api/flows')
      .done(function (resp) {
        state.flows = (resp && resp.flows) || [];
        renderFlowSelect();
      })
      .fail(function () {
        renderFlowSelect();
      });
  }

  function renderFlowSelect() {
    const sel = $('#flowSelect');
    const current = state.currentFlowId;

    sel.empty();

    if (state.flows.length === 0) {
      sel.append('<option value="">(no saved flows)</option>');
      sel.val('');
      return;
    }

    state.flows.forEach(function (f) {
      const opt = $('<option></option>').attr('value', f.id).text(f.name);
      sel.append(opt);
    });

    if (current) sel.val(current);
  }

  function loadFlow(id) {
    if (!id) return;
    clearAutosaveTimer();
    setStatus('Loading...');

    NI.apiJson('GET', '/api/flows/' + encodeURIComponent(id))
      .done(function (resp) {
        const flow = resp && resp.flow;
        if (!flow) return;

        state.currentFlowId = flow.id;
        state.flowName = flow.name;
        state.isPublicFlow = !!flow.isPublic;
        state.publicToken = flow.publicToken || null;
        state.nodes = ((flow.data && flow.data.nodes) || []).map(function (n) {
          const nn = Object.assign({}, n);
          if (!nn.w) nn.w = 260;
          if (!nn.h) nn.h = 150;
          if (!nn.color) nn.color = defaultColorForType(nn.type);
          if (!nn.content) nn.content = {};
          nn.outputs = normalizeOutputs(nn);
          return nn;
        });
        state.links = (flow.data && flow.data.links) || [];
        state.selectedNodeId = null;
        state.selectedLinkId = null;
        state.linking = null;
        state.dirty = false;
        state.saving = false;

        ensureStartEnd();
        renderAll();
        refreshFlowShareControls();
        setStatus('Loaded');
        updateSaveButtonState();
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  }

  function ensureStartEnd() {
    const hasStart = state.nodes.some(function (n) {
      return n.type === 'start';
    });
    const hasEnd = state.nodes.some(function (n) {
      return n.type === 'end';
    });

    if (!hasStart) {
      state.nodes.unshift({
        id: uid(),
        type: 'start',
        title: 'Start',
        x: 120,
        y: 200,
        w: 260,
        h: 150,
        color: defaultColorForType('start'),
        content: {},
        outputs: [
          { id: 'yes', label: 'Yes', enabled: true },
          { id: 'no', label: 'No', enabled: false },
        ],
      });
      markDirty();
    }

    if (!hasEnd) {
      state.nodes.push({
        id: uid(),
        type: 'end',
        title: 'End',
        x: 860,
        y: 200,
        w: 260,
        h: 150,
        color: defaultColorForType('end'),
        content: {},
        outputs: [],
      });
      markDirty();
    }
  }

  function autoFormatFlow() {
    if (!state.canEdit || state.nodes.length === 0) return;

    const nodesById = new Map();
    const incoming = new Map();
    const outgoing = new Map();
    const incomingLinks = new Map();
    const outgoingLinks = new Map();

    state.nodes.forEach(function (n) {
      nodesById.set(n.id, n);
      incoming.set(n.id, []);
      outgoing.set(n.id, []);
      incomingLinks.set(n.id, []);
      outgoingLinks.set(n.id, []);
    });

    state.links.forEach(function (l) {
      if (!nodesById.has(l.sourceId) || !nodesById.has(l.targetId)) return;
      outgoing.get(l.sourceId).push(l.targetId);
      incoming.get(l.targetId).push(l.sourceId);
      incomingLinks.get(l.targetId).push(l);
      outgoingLinks.get(l.sourceId).push(l);
    });

    function nodeSort(a, b) {
      if (a.type === 'start' && b.type !== 'start') return -1;
      if (a.type !== 'start' && b.type === 'start') return 1;
      if (a.type === 'end' && b.type !== 'end') return 1;
      if (a.type !== 'end' && b.type === 'end') return -1;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    }

    const sortedNodes = state.nodes.slice().sort(nodeSort);
    const levelMap = new Map();
    const initialRoots = sortedNodes.filter(function (n) {
      return n.type === 'start' || (incoming.get(n.id) || []).length === 0;
    });

    const seedRoots = initialRoots.length ? initialRoots : sortedNodes.slice(0, 1);
    seedRoots.forEach(function (n) {
      levelMap.set(n.id, 0);
    });

    function relaxLevels() {
      for (let pass = 0; pass < state.nodes.length; pass += 1) {
        let changed = false;
        state.links.forEach(function (l) {
          const sourceLevel = levelMap.get(l.sourceId);
          if (sourceLevel === undefined) return;
          const nextLevel = sourceLevel + 1;
          const currentLevel = levelMap.get(l.targetId);
          if (currentLevel === undefined || nextLevel > currentLevel) {
            levelMap.set(l.targetId, nextLevel);
            changed = true;
          }
        });
        if (!changed) break;
      }
    }

    relaxLevels();

    while (levelMap.size < state.nodes.length) {
      let maxLevel = 0;
      levelMap.forEach(function (value) {
        if (value > maxLevel) maxLevel = value;
      });

      const nextSeed = sortedNodes.find(function (n) {
        return !levelMap.has(n.id);
      });
      if (!nextSeed) break;
      levelMap.set(nextSeed.id, maxLevel + 1);
      relaxLevels();
    }

    const grouped = new Map();
    state.nodes.forEach(function (n) {
      const level = levelMap.get(n.id) || 0;
      if (!grouped.has(level)) grouped.set(level, []);
      grouped.get(level).push(n);
    });

    const orderedLevels = Array.from(grouped.keys()).sort(function (a, b) {
      return a - b;
    });
    const orderIndex = new Map();
    const verticalRank = new Map();
    const positioned = new Set();

    state.nodes.forEach(function (n) {
      verticalRank.set(n.id, n.y);
    });

    function sourcePortRank(node, portId) {
      const outputs = enabledOutputs(node);
      const idx = outputs.findIndex(function (o) {
        return o.id === portId;
      });
      return idx === -1 ? outputs.length : idx;
    }

    function linkOrderForNode(parentId, childId) {
      const links = (outgoingLinks.get(parentId) || []).slice().sort(function (a, b) {
        const parentNode = nodeById(parentId);
        const aRank = parentNode ? sourcePortRank(parentNode, a.sourcePort) : 0;
        const bRank = parentNode ? sourcePortRank(parentNode, b.sourcePort) : 0;
        if (aRank !== bRank) return aRank - bRank;
        const aTarget = nodeById(a.targetId);
        const bTarget = nodeById(b.targetId);
        if (aTarget && bTarget && aTarget.y !== bTarget.y) return aTarget.y - bTarget.y;
        return String(a.targetId).localeCompare(String(b.targetId));
      });
      const idx = links.findIndex(function (l) {
        return l.targetId === childId;
      });
      return idx === -1 ? links.length : idx;
    }

    function linkSortForParent(parentId, a, b) {
      const parentNode = nodeById(parentId);
      const aRank = parentNode ? sourcePortRank(parentNode, a.sourcePort) : 0;
      const bRank = parentNode ? sourcePortRank(parentNode, b.sourcePort) : 0;
      if (aRank !== bRank) return aRank - bRank;
      const aTarget = nodeById(a.targetId);
      const bTarget = nodeById(b.targetId);
      if (aTarget && bTarget && aTarget.y !== bTarget.y) return aTarget.y - bTarget.y;
      return String(a.targetId).localeCompare(String(b.targetId));
    }

    const primaryParent = new Map();
    const primaryChildren = new Map();
    state.nodes.forEach(function (n) {
      primaryChildren.set(n.id, []);
    });

    sortedNodes.forEach(function (n) {
      const candidates = (incomingLinks.get(n.id) || []).slice().sort(function (a, b) {
        const aLevel = levelMap.get(a.sourceId) || 0;
        const bLevel = levelMap.get(b.sourceId) || 0;
        if (aLevel !== bLevel) return bLevel - aLevel;
        const sourceCmp = nodeSort(nodeById(a.sourceId), nodeById(b.sourceId));
        if (sourceCmp !== 0) return sourceCmp;
        return linkSortForParent(a.sourceId, a, b);
      });
      if (!candidates.length) return;
      const parentId = candidates[0].sourceId;
      primaryParent.set(n.id, parentId);
      primaryChildren.get(parentId).push(n.id);
    });

    primaryChildren.forEach(function (childIds, parentId) {
      childIds.sort(function (aId, bId) {
        const linkOrder = linkOrderForNode(parentId, aId) - linkOrderForNode(parentId, bId);
        if (linkOrder !== 0) return linkOrder;
        return nodeSort(nodeById(aId), nodeById(bId));
      });
    });

    const spanMemo = new Map();

    function subtreeSpan(nodeId, stack) {
      if (spanMemo.has(nodeId)) return spanMemo.get(nodeId);
      if (stack.has(nodeId)) return 1;
      stack.add(nodeId);
      const children = primaryChildren.get(nodeId) || [];
      let span = 0;
      children.forEach(function (childId) {
        span += subtreeSpan(childId, new Set(stack));
      });
      if (!span) span = 1;
      spanMemo.set(nodeId, span);
      return span;
    }

    const laneMap = new Map();
    const laneAssigned = new Set();

    function assignLaneBlock(nodeId, startLane, stack) {
      if (laneAssigned.has(nodeId)) return Math.max(startLane + 1, startLane + subtreeSpan(nodeId, new Set()));
      if (stack.has(nodeId)) {
        laneMap.set(nodeId, startLane);
        laneAssigned.add(nodeId);
        return startLane + 1;
      }

      laneMap.set(nodeId, startLane);
      laneAssigned.add(nodeId);

      const nextStack = new Set(stack);
      nextStack.add(nodeId);
      const children = primaryChildren.get(nodeId) || [];
      if (!children.length) return startLane + 1;

      let cursor = startLane;
      children.forEach(function (childId) {
        assignLaneBlock(childId, cursor, nextStack);
        cursor += subtreeSpan(childId, new Set());
      });
      return cursor;
    }

    const rootIds = [];
    const rootSeen = new Set();

    seedRoots.forEach(function (n) {
      if (rootSeen.has(n.id)) return;
      rootSeen.add(n.id);
      rootIds.push(n.id);
    });

    sortedNodes.forEach(function (n) {
      if (primaryParent.has(n.id)) return;
      if (rootSeen.has(n.id)) return;
      rootSeen.add(n.id);
      rootIds.push(n.id);
    });

    let nextLane = 0;
    rootIds.forEach(function (rootId) {
      if (laneAssigned.has(rootId)) return;
      nextLane = assignLaneBlock(rootId, nextLane, new Set());
    });

    sortedNodes.forEach(function (n) {
      if (laneAssigned.has(n.id)) return;
      nextLane = assignLaneBlock(n.id, nextLane, new Set());
    });

    const left = 120;
    const top = 120;
    const columnGap = 180;
    const rowGap = 50;
    const levelX = new Map();
    let currentX = left;
    orderedLevels.forEach(function (level) {
      const items = grouped.get(level) || [];
      let widest = 260;
      items.forEach(function (n) {
        widest = Math.max(widest, parseInt(n.w, 10) || 260);
      });
      levelX.set(level, currentX);
      currentX += widest + columnGap;
    });

    const laneHeights = [];
    state.nodes.forEach(function (n) {
      const lane = laneMap.get(n.id) || 0;
      laneHeights[lane] = Math.max(laneHeights[lane] || 0, parseInt(n.h, 10) || 150);
    });

    const laneY = [];
    let currentY = top;
    for (let lane = 0; lane < laneHeights.length; lane += 1) {
      laneY[lane] = currentY;
      currentY += (laneHeights[lane] || 150) + rowGap;
    }

    orderedLevels.forEach(function (level) {
      const items = (grouped.get(level) || []).slice().sort(function (a, b) {
        const aLane = laneMap.get(a.id) || 0;
        const bLane = laneMap.get(b.id) || 0;
        if (aLane !== bLane) return aLane - bLane;
        const aOrder = linkOrderForNode(primaryParent.get(a.id) || '', a.id);
        const bOrder = linkOrderForNode(primaryParent.get(b.id) || '', b.id);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return nodeSort(a, b);
      });

      items.forEach(function (n, idx) {
        const width = parseInt(n.w, 10) || 260;
        const height = parseInt(n.h, 10) || 150;
        const lane = laneMap.get(n.id) || 0;
        const targetX = levelX.get(level) || left;
        const targetY = laneY[lane] != null ? laneY[lane] : (top + idx * (height + rowGap));

        n.x = Math.max(20, Math.min(canvasWidth - width - 40, targetX));
        n.y = Math.max(20, Math.min(canvasHeight - height - 40, targetY));
        orderIndex.set(n.id, idx);
        verticalRank.set(n.id, n.y);
        positioned.add(n.id);
      });
    });

    renderAll();
    markDirty({ silentStatus: true });
    setStatus('Auto formatted');
  }

  function getViewportNewNodePos() {
    const ws = $('#workspace');
    const x = Math.max(20, ws.scrollLeft() / state.zoom + ws.width() / (state.zoom * 2) - 140);
    const y = Math.max(20, ws.scrollTop() / state.zoom + ws.height() / (state.zoom * 2) - 90);
    return { x: Math.min(canvasWidth - 320, x), y: Math.min(canvasHeight - 220, y) };
  }

  function addNode(type) {
    if (type === 'start') {
      if (state.nodes.some(function (n) { return n.type === 'start'; })) return;
    }

    const p = getViewportNewNodePos();
    const n = {
      id: uid(),
      type: type,
      title: type.charAt(0).toUpperCase() + type.slice(1),
      x: p.x,
      y: p.y,
      w: 280,
      h: 180,
      color: defaultColorForType(type),
      content: {},
      outputs: normalizeOutputs({ type: type }),
    };

    state.nodes.push(n);
    renderAll();
    selectNode(n.id);
    markDirty({ silentStatus: true });

    if (type === 'text') {
      openEditDialog(n.id);
    }
  }

  function canEditNode(n) {
    return !!n && state.canEdit;
  }

  function canDeleteNode(n) {
    if (!n) return false;
    if (n.type === 'start') return false;
    if (n.type === 'end') {
      const endCount = state.nodes.filter(function (x) { return x.type === 'end'; }).length;
      if (endCount <= 1) return false;
    }
    if (!state.canEdit) return false;
    return true;
  }

  function canDeleteLink(id) {
    if (!id || !state.canEdit) return false;
    return state.links.some(function (l) {
      return l.id === id;
    });
  }

  function refreshSelectionUI() {
    $('.node-card').removeClass('selected');
    $(linkGroupEl).find('path.link.custom').removeClass('selected');
    if (state.selectedNodeId) {
      $('.node-card[data-id="' + state.selectedNodeId + '"]').addClass('selected');
    }
    if (state.selectedLinkId) {
      $(linkGroupEl).find('path.link.custom[data-link-id="' + state.selectedLinkId + '"]').addClass('selected');
    }
    updateSelectedButtons();
  }

  function updateSelectedButtons() {
    const n = nodeById(state.selectedNodeId);
    $('#editNode').prop('disabled', !canEditNode(n));
    $('#colorNode').prop('disabled', !n || !state.canEdit);
    $('#deleteNode').prop('disabled', !(canDeleteNode(n) || canDeleteLink(state.selectedLinkId)));
  }

  function selectNode(id) {
    state.selectedNodeId = id || null;
    state.selectedLinkId = null;
    refreshSelectionUI();
  }

  function selectLink(id) {
    state.selectedNodeId = null;
    state.selectedLinkId = id || null;
    refreshSelectionUI();
  }

  function nodeBodyHtml(n) {
    const captionEnabled = !!(n.content && n.content.captionEnabled);
    const captionText = n.content && n.content.captionText ? $('<div>').text(String(n.content.captionText)).html() : '';
    const captionHtml = captionEnabled ? '<div class="node-caption">' + (captionText || '(caption)') + '</div>' : '';

    if (n.type === 'start') {
      return '<div style="font-size:12px;color:var(--muted);">Begin the process here.</div>';
    }
    if (n.type === 'end') {
      return '<div style="font-size:12px;color:var(--muted);">Process complete.</div>';
    }
    if (n.type === 'text') {
      const html = (n.content && n.content.html) || '';
      return html || '<div style="font-size:12px;color:var(--muted);">(empty)</div>';
    }
    if (n.type === 'image') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const w = Math.max(80, Math.min(900, parseInt((n.content && n.content.mediaSize && n.content.mediaSize.w) || 260, 10) || 260));
        const h = Math.max(60, Math.min(700, parseInt((n.content && n.content.mediaSize && n.content.mediaSize.h) || 180, 10) || 180));
        return captionHtml + '<div class="media-box media-resizable" data-node-id="' + n.id + '" style="width:' + w + 'px;height:' + h + 'px;"><img src="' + f.url + '" alt="" /></div>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No image</div>';
    }
    if (n.type === 'file') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const name = String(f.originalName || 'file');
        return (
          captionHtml +
          '<div class="file-node-wrap">' +
          '<a href="' + f.url + '" target="_blank" rel="noopener noreferrer">' + $('<div>').text(name).html() + '</a>' +
          '<a class="ghost-link file-download" href="' + f.url + '" download>Download</a>' +
          '</div>'
        );
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No file</div>';
    }
    if (n.type === 'video') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const typeAttr = f.mimeType ? ' type="' + $('<div>').text(String(f.mimeType)).html() + '"' : '';
        return captionHtml + '<video controls><source src="' + f.url + '"' + typeAttr + ' /></video>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No video</div>';
    }
    if (n.type === 'audio') {
      const f = n.content && n.content.file;
      if (f && f.url) {
        const typeAttr = f.mimeType ? ' type="' + $('<div>').text(String(f.mimeType)).html() + '"' : '';
        return captionHtml + '<audio controls><source src="' + f.url + '"' + typeAttr + ' /></audio>';
      }
      return captionHtml + '<div style="font-size:12px;color:var(--muted);">No audio</div>';
    }

    return '';
  }

  function buildNodeHtml(n) {
    const safeTitle = $('<div>').text(n.title || '').html();
    const outputs = n.type === 'end' ? [] : enabledOutputs(n);
    const hasOutputs = outputs.length > 0;

    let inPort = '';
    if (n.type !== 'start') {
      inPort = '<div class="port-in"><div class="port in" data-port="in"></div></div>';
    }

    let outPorts = '';
    if (n.type !== 'end') {
      outPorts = '<div class="node-outputs">' + outputs.map(function (o) {
        const safeLabel = $('<div>').text(o.label || o.id).html();
        const safeColor = outputColor(n, o.id);
        return '<div class="port-group dyn"><div class="port-label">' + safeLabel + '</div><div class="port out custom" style="background:' + safeColor + ';" data-port-id="' + $('<div>').text(o.id).html() + '"></div></div>';
      }).join('') + '</div>';
    }

    const buttons =
      '<button type="button" class="btnEdit">Edit</button>' +
      '<button type="button" class="btnColor">Color</button>' +
      '<button type="button" class="btnDelete">Del</button>';

    return (
      '<div class="node-card' + (hasOutputs ? '' : ' no-outputs') + '" data-id="' + n.id + '">' +
      '<div class="node-header">' +
      '<div class="node-title">' + safeTitle + '</div>' +
      '<div class="node-controls">' +
      buttons +
      '</div>' +
      '</div>' +
      '<div class="node-main">' +
      '<div class="node-body"></div>' +
      outPorts +
      '</div>' +
      inPort +
      '</div>'
    );
  }

  function renderNodes() {
    const layer = $('#node-layer');
    layer.empty();

    state.nodes.forEach(function (n) {
      layer.append(buildNodeCard(n));
    });

    updateSelectedButtons();
  }

  function buildNodeCard(n) {
    const card = $(buildNodeHtml(n));
    card.find('.node-body').html(nodeBodyHtml(n));
    card.css({ left: n.x, top: n.y, width: n.w, height: n.h });
    if (card[0]) card[0].style.setProperty('--node-color', n.color || defaultColorForType(n.type));
    initNodeInteractions(card, n);
    return card;
  }

  function updateNodeElement(n) {
    const existing = $('.node-card[data-id="' + n.id + '"]');
    if (!existing.length) {
      renderAll();
      selectNode(n.id);
      markDirty({ silentStatus: true });
      return;
    }

    const replacement = buildNodeCard(n);
    if (n.id === state.selectedNodeId) replacement.addClass('selected');
    existing.replaceWith(replacement);
    updateSelectedButtons();
    updateLinks();
    selectNode(n.id);
    markDirty({ silentStatus: true });
  }

  function initNodeInteractions(card, n) {
    card.on('mousedown', function (e) {
      if ($(e.target).closest('.port').length) return;
      selectNode(n.id);
    });

    card.find('.btnEdit').on('click', function (e) {
      e.stopPropagation();
      if (!state.canEdit) return;
      selectNode(n.id);
      openEditDialog(n.id);
    });

    card.find('.btnColor').on('click', function (e) {
      e.stopPropagation();
      if (!state.canEdit) return;
      selectNode(n.id);
      openColorDialog(n.id);
    });

    card.find('.btnDelete').on('click', function (e) {
      e.stopPropagation();
      if (!state.canEdit) return;
      selectNode(n.id);
      deleteNode(n.id);
    });

    card.find('.port.out').on('mousedown', function (e) {
      e.stopPropagation();
      if (!state.canEdit) return;
      const outputId = String($(this).data('portId') || '');
      if (!outputId) return;
      selectNode(n.id);
      startLink(n.id, outputId);
    });

    card.find('.port.in').on('mousedown', function (e) {
      e.stopPropagation();
      if (!state.canEdit) return;
      selectNode(n.id);
      completeLink(n.id);
    });

    card.draggable({
      handle: '.node-header',
      containment: '#canvas',
      disabled: !state.canEdit,
      drag: function (evt, ui) {
        n.x = ui.position.left;
        n.y = ui.position.top;
        scheduleLinkUpdate();
      },
      stop: function (evt, ui) {
        n.x = ui.position.left;
        n.y = ui.position.top;
        updateLinks();
        markDirty({ silentStatus: true });
      },
    });

    card.resizable({
      containment: '#canvas',
      minWidth: 180,
      minHeight: 120,
      disabled: !state.canEdit,
      resize: function (evt, ui) {
        n.w = ui.size.width;
        n.h = ui.size.height;
        scheduleLinkUpdate();
      },
      stop: function (evt, ui) {
        n.w = ui.size.width;
        n.h = ui.size.height;
        updateLinks();
        markDirty({ silentStatus: true });
      },
    });

    if (!canDeleteNode(n)) {
      card.find('.btnDelete').prop('disabled', true);
    }

    if (!state.canEdit) {
      card.find('.btnEdit,.btnColor').prop('disabled', true);
    }

    if (n.type === 'image') {
      const media = card.find('.media-resizable');
      media.on('mousedown', function (e) {
        e.stopPropagation();
      });

      if (media.length && state.canEdit) {
        media.resizable({
          aspectRatio: true,
          handles: 'se',
          minWidth: 80,
          minHeight: 60,
          stop: function (evt, ui) {
            n.content = n.content || {};
            n.content.mediaSize = {
              w: Math.round(ui.size.width),
              h: Math.round(ui.size.height),
            };
          },
        });
      }
    }
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
    return {
      x: (r.left - cr.left + r.width / 2) / state.zoom,
      y: (r.top - cr.top + r.height / 2) / state.zoom,
    };
  }

  function bezierPath(a, b) {
    const dx = Math.max(80, Math.abs(b.x - a.x) * 0.5);
    const c1x = a.x + dx;
    const c2x = b.x - dx;
    return 'M' + a.x + ',' + a.y + ' C' + c1x + ',' + a.y + ' ' + c2x + ',' + b.y + ' ' + b.x + ',' + b.y;
  }

  function updateLinks() {
    state.linkFrameRequested = false;
    linkGroupEl.innerHTML = '';

    state.links.forEach(function (d) {
      const a = portCenter(d.sourceId, d.sourcePort);
      const b = portCenter(d.targetId, 'in');
      if (!a || !b) return;

      const group = createSvgEl('g');
      const hitPath = createSvgEl('path');
      const path = createSvgEl('path');
      const sourceNode = nodeById(d.sourceId);
      const dAttr = bezierPath(a, b);
      group.setAttribute('data-link-id', d.id);
      hitPath.setAttribute('class', 'link-hit');
      hitPath.setAttribute('d', dAttr);
      path.setAttribute('class', 'link custom');
      path.setAttribute('data-link-id', d.id);
      path.setAttribute('stroke', outputColor(sourceNode, d.sourcePort));
      path.setAttribute('d', dAttr);
      if (state.selectedLinkId === d.id) {
        path.classList.add('selected');
      }
      hitPath.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        if (state.linking) cancelLink();
        selectLink(d.id);
      });
      group.appendChild(hitPath);
      group.appendChild(path);
      linkGroupEl.appendChild(group);
    });

    if (!state.linking) {
      tempGroupEl.innerHTML = '';
    }
  }

  function scheduleLinkUpdate() {
    if (state.linkFrameRequested) return;
    state.linkFrameRequested = true;
    window.requestAnimationFrame(function () {
      updateLinks();
    });
  }

  function startLink(sourceId, port) {
    const sourceNode = nodeById(sourceId);
    if (!sourceNode) return;
    if (sourceNode.type === 'end') return;
    if (!enabledOutputs(sourceNode).some(function (o) { return o.id === port; })) return;

    state.linking = { sourceId: sourceId, port: port };
    const a = portCenter(sourceId, port);
    if (!a) return;

    tempGroupEl.innerHTML = '';
    const path = createSvgEl('path');
    path.setAttribute('class', 'link temp');
    path.setAttribute('d', 'M' + a.x + ',' + a.y + ' L' + a.x + ',' + a.y);
    tempGroupEl.appendChild(path);
  }

  function cancelLink() {
    state.linking = null;
    tempGroupEl.innerHTML = '';
  }

  function completeLink(targetId) {
    if (!state.linking) return;

    const sourceId = state.linking.sourceId;
    const port = state.linking.port;
    const sourceNode = nodeById(sourceId);
    if (!sourceNode || !enabledOutputs(sourceNode).some(function (o) { return o.id === port; })) {
      cancelLink();
      return;
    }

    if (sourceId === targetId) {
      cancelLink();
      return;
    }

    const targetNode = nodeById(targetId);
    if (!targetNode) {
      cancelLink();
      return;
    }

    if (targetNode.type === 'start') {
      cancelLink();
      return;
    }

    state.links = state.links.filter(function (l) {
      return !(l.sourceId === sourceId && l.sourcePort === port);
    });

    state.links.push({ id: uid(), sourceId: sourceId, sourcePort: port, targetId: targetId });

    cancelLink();
    updateLinks();
    markDirty({ silentStatus: true });
  }

  function deleteNode(id) {
    const n = nodeById(id);
    if (!canDeleteNode(n)) return;

    state.nodes = state.nodes.filter(function (x) {
      return x.id !== id;
    });

    state.links = state.links.filter(function (l) {
      return l.sourceId !== id && l.targetId !== id;
    });

    if (state.selectedNodeId === id) state.selectedNodeId = null;
    if (state.selectedLinkId && !state.links.some(function (l) { return l.id === state.selectedLinkId; })) {
      state.selectedLinkId = null;
    }
    renderAll();
    markDirty({ silentStatus: true });
  }

  function deleteLink(id) {
    if (!canDeleteLink(id)) return;
    state.links = state.links.filter(function (l) {
      return l.id !== id;
    });
    if (state.selectedLinkId === id) state.selectedLinkId = null;
    renderAll();
    markDirty({ silentStatus: true });
  }

  function openColorDialog(nodeId) {
    const n = requireLiveNode(nodeId);
    if (!n) return;

    const dlg = $('<div title="Node Color"></div>');
    dlg.append('<div class="dialog-field"><label>Color</label><input id="nodeColor" type="color" /></div>');

    dlg.on('dialogopen', function () {
      const liveNode = requireLiveNode(nodeId);
      if (!liveNode) {
        dlg.dialog('close');
        return;
      }
      const c = String(liveNode.color || defaultColorForType(liveNode.type));
      $('#nodeColor').val(c);
    });

    dlg.dialog({
      modal: true,
      width: 360,
      buttons: {
        Save: function () {
          const liveNode = requireLiveNode(nodeId);
          if (!liveNode) {
            dlg.dialog('close');
            return;
          }
          liveNode.color = String($('#nodeColor').val() || defaultColorForType(liveNode.type));
          updateNodeElement(liveNode);
          dlg.dialog('close');
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  }

  function editorSelectionRange(editorEl) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editorEl || !editorEl.contains(range.commonAncestorContainer)) return null;
    return range;
  }

  function placeCaretAfter(node) {
    const sel = window.getSelection && window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertNodeInEditor(editorEl, node) {
    const range = editorSelectionRange(editorEl);
    if (!range) {
      editorEl.appendChild(node);
      placeCaretAfter(node);
      return;
    }

    range.deleteContents();
    range.insertNode(node);
    placeCaretAfter(node);
  }

  function insertCodeIntoEditor(editorEl, code) {
    const codeEl = document.createElement('code');
    codeEl.textContent = String(code || '');
    insertNodeInEditor(editorEl, codeEl);
  }

  function insertLinkIntoEditor(editorEl, url) {
    const href = String(url || '').trim();
    if (!href) return;

    const linkEl = document.createElement('a');
    linkEl.setAttribute('href', href);
    linkEl.setAttribute('target', '_blank');
    linkEl.setAttribute('rel', 'noopener noreferrer');

    const range = editorSelectionRange(editorEl);
    if (range && !range.collapsed) {
      const contents = range.extractContents();
      const hasText = String(contents.textContent || '').trim().length > 0;
      if (hasText) {
        linkEl.appendChild(contents);
      } else {
        linkEl.textContent = href;
      }
      range.insertNode(linkEl);
      placeCaretAfter(linkEl);
      return;
    }

    linkEl.textContent = href;
    insertNodeInEditor(editorEl, linkEl);
  }

  function runToolbarCommand(editorEl, cmd) {
    editorEl.focus();
    if (typeof document.execCommand === 'function') {
      return document.execCommand(cmd, false, null);
    }
    setStatus('Formatting command not supported in this browser');
    return false;
  }

  function openTextDialog(nodeId) {
    const n = requireLiveNode(nodeId);
    if (!n) return;
    const dlg = $('<div title="Text"></div>');

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Title</label>')
        .append('<input id="textTitle" type="text" />')
    );

    const toolbar = $('<div class="rich-toolbar"></div>');
    toolbar.append('<button type="button" data-cmd="bold">Bold</button>');
    toolbar.append('<button type="button" data-cmd="italic">Italic</button>');
    toolbar.append('<button type="button" data-cmd="underline">Underline</button>');
    toolbar.append('<button type="button" data-cmd="insertUnorderedList">Bullets</button>');
    toolbar.append('<button type="button" data-cmd="insertOrderedList">Numbered</button>');
    toolbar.append('<button type="button" data-cmd="insertCode">Code</button>');
    toolbar.append('<button type="button" data-cmd="createLink">Link</button>');

    const editor = $('<div id="textEditor" class="rich-editor" contenteditable="true"></div>');

    dlg.append(toolbar);
    dlg.append(editor);

    const outputsEditor = createOutputsEditor(n);
    dlg.append(outputsEditor.el);

    toolbar.on('click', 'button', function () {
      const cmd = String($(this).data('cmd') || '');
      const editorEl = document.getElementById('textEditor');
      if (!cmd) return;
      if (!editorEl) return;
      if (cmd === 'createLink') {
        const url = window.prompt('URL');
        if (url) insertLinkIntoEditor(editorEl, url);
        return;
      }
      if (cmd === 'insertCode') {
        const code = window.prompt('Code text', '');
        if (code !== null) {
          insertCodeIntoEditor(editorEl, code);
        }
        return;
      }
      runToolbarCommand(editorEl, cmd);
    });

    dlg.on('dialogopen', function () {
      const liveNode = requireLiveNode(nodeId);
      if (!liveNode) {
        dlg.dialog('close');
        return;
      }
      $('#textTitle').val(liveNode.title || 'Text');
      $('#textEditor').html((liveNode.content && liveNode.content.html) || '');
    });

    dlg.dialog({
      modal: true,
      width: 720,
      height: 520,
      buttons: {
        Save: function () {
          const liveNode = requireLiveNode(nodeId);
          if (!liveNode) {
            dlg.dialog('close');
            return;
          }
          liveNode.title = String($('#textTitle').val() || '').trim() || 'Text';
          liveNode.content = liveNode.content || {};
          liveNode.content.html = $('#textEditor').html();
          applyNodeOutputs(liveNode, outputsEditor.getOutputs());
          updateNodeElement(liveNode);
          dlg.dialog('close');
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  }

  function openUploadDialog(nodeId, kind, accept) {
    const n = requireLiveNode(nodeId);
    if (!n) return;
    const titleMap = { image: 'Image', file: 'File', video: 'Video', audio: 'Audio' };

    const dlg = $('<div title="' + (titleMap[kind] || 'Upload') + '"></div>');

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Title</label>')
        .append('<input id="upTitle" type="text" />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Select file</label>')
        .append('<input id="upFile" type="file" />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label><input id="upCaptionEnabled" type="checkbox" /> Show text above media</label>')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Text above media</label>')
        .append('<input id="upCaptionText" type="text" maxlength="200" />')
    );

    dlg.append('<div id="upError" class="error"></div>');

    const outputsEditor = createOutputsEditor(n);
    dlg.append(outputsEditor.el);

    dlg.on('dialogopen', function () {
      const liveNode = requireLiveNode(nodeId);
      if (!liveNode) {
        dlg.dialog('close');
        return;
      }
      $('#upTitle').val(liveNode.title || titleMap[kind] || 'Node');
      const input = $('#upFile');
      if (accept) input.attr('accept', accept);
      $('#upCaptionEnabled').prop('checked', !!(liveNode.content && liveNode.content.captionEnabled));
      $('#upCaptionText').val((liveNode.content && liveNode.content.captionText) || '');
    });

    dlg.dialog({
      modal: true,
      width: 520,
      buttons: {
        Save: function () {
          $('#upError').text('');
          const fileInput = document.getElementById('upFile');
          const f = fileInput && fileInput.files && fileInput.files[0];
          const liveNode = requireLiveNode(nodeId);
          if (!liveNode) {
            dlg.dialog('close');
            return;
          }
          liveNode.title = String($('#upTitle').val() || '').trim() || (titleMap[kind] || 'Node');
          liveNode.content = liveNode.content || {};
          liveNode.content.captionEnabled = !!$('#upCaptionEnabled').prop('checked');
          liveNode.content.captionText = String($('#upCaptionText').val() || '').trim().slice(0, 200);

          applyNodeOutputs(liveNode, outputsEditor.getOutputs());

          if (!f) {
            updateNodeElement(liveNode);
            dlg.dialog('close');
            return;
          }

          const fd = new FormData();
          fd.append('file', f);
          const oldUrl = liveNode.content && liveNode.content.file && liveNode.content.file.url;
          if (oldUrl) fd.append('oldUrl', oldUrl);

          setStatus('Uploading...');
          NI.apiForm('/api/upload?kind=' + encodeURIComponent(kind), fd)
            .done(function (resp) {
              const refreshedNode = requireLiveNode(nodeId);
              if (!refreshedNode) {
                dlg.dialog('close');
                setStatus('');
                return;
              }
              refreshedNode.content = refreshedNode.content || {};
              refreshedNode.content.file = (resp && resp.file) || null;
              updateNodeElement(refreshedNode);
              setStatus('');
              dlg.dialog('close');
            })
            .fail(function (xhr) {
              setStatus('');
              $('#upError').text(NI.formatError(xhr));
            });
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  }

  function openEditDialog(nodeId) {
    const n = nodeById(nodeId);
    if (!n) return;
    if (!state.canEdit) return;

    if (n.type === 'text') {
      openTextDialog(nodeId);
      return;
    }

    if (n.type === 'image') {
      openUploadDialog(nodeId, 'image', '.png,.jpg,.jpeg,.gif,.tiff');
      return;
    }

    if (n.type === 'file') {
      openUploadDialog(nodeId, 'file', '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.zip,.xml,.json,.png,.jpg,.jpeg,.gif,.tiff,.mp3,.wav,.mp4,.mpeg,.avi,.webm,.wmv,.ogg,.mov,.m4v,.flac,.pptx,.ppt,.docm,.xlsm,.dotx,.xltx,.pub,.crt,.csr');
      return;
    }

    if (n.type === 'video') {
      openUploadDialog(nodeId, 'video', '.mp4,.mpeg,.avi,.webm,.wmv,.ogg,.mov,.m4v');
      return;
    }

    if (n.type === 'audio') {
      openUploadDialog(nodeId, 'audio', '.mp3,.wav,.ogg,.flac');
      return;
    }

    const dlg = $('<div title="Node"></div>');
    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Title</label>')
        .append('<input id="basicTitle" type="text" />')
    );

    const outputsEditor = createOutputsEditor(n);
    dlg.append(outputsEditor.el);

    dlg.on('dialogopen', function () {
      const liveNode = requireLiveNode(nodeId);
      if (!liveNode) {
        dlg.dialog('close');
        return;
      }
      $('#basicTitle').val(liveNode.title || 'Node');
    });

    dlg.dialog({
      modal: true,
      width: 420,
      buttons: {
        Save: function () {
          const liveNode = requireLiveNode(nodeId);
          if (!liveNode) {
            dlg.dialog('close');
            return;
          }
          liveNode.title = String($('#basicTitle').val() || '').trim() || liveNode.title;
          applyNodeOutputs(liveNode, outputsEditor.getOutputs());
          updateNodeElement(liveNode);
          dlg.dialog('close');
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  }

  function renderAll() {
    renderNodes();
    updateLinks();
    refreshSelectionUI();
  }

  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#toggleSidebar').on('click', function () {
    const collapsed = layoutEl.classList.contains('sidebar-collapsed');
    setSidebarCollapsed(!collapsed);
  });

  (function initSidebarResize() {
    const resizer = document.getElementById('sidebarResizer');
    let dragging = false;

    $(resizer).on('mousedown', function (e) {
      if (layoutEl.classList.contains('sidebar-collapsed')) return;
      dragging = true;
      e.preventDefault();
    });

    $(document).on('mousemove', function (e) {
      if (!dragging) return;
      const rect = layoutEl.getBoundingClientRect();
      const width = e.clientX - rect.left;
      setSidebarWidth(width);
    });

    $(document).on('mouseup', function () {
      dragging = false;
    });
  })();

  $('#logoutBtn').on('click', function () {
    NI.apiJson('POST', '/api/auth/logout')
      .always(function () {
        window.location = '/login';
      });
  });

  $('#adminBtn').on('click', function () {
    window.location = '/admin';
  });

  $('#newFlow').on('click', function () {
    const dlg = $('<div title="New Flow"></div>');
    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Name</label>')
        .append('<input id="flowNameInput" type="text" />')
    );

    dlg.dialog({
      modal: true,
      width: 420,
      buttons: {
        Create: function () {
          const name = String($('#flowNameInput').val() || '').trim() || 'New Flow';
          newFlowTemplate(name);
          dlg.dialog('close');
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  });

  $('#saveFlow').on('click', function () {
    saveFlow({ reason: 'manual' });
  });

  $('#renameFlow').on('click', function () {
    if (!state.canEdit) return;

    const dlg = $('<div title="Rename Flow"></div>');
    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Name</label>')
        .append('<input id="renameFlowInput" type="text" />')
    );

    dlg.on('dialogopen', function () {
      $('#renameFlowInput').val(state.flowName || '');
    });

    dlg.dialog({
      modal: true,
      width: 420,
      buttons: {
        Save: function () {
          const nextName = String($('#renameFlowInput').val() || '').trim();
          if (!nextName) return;
          state.flowName = nextName;

          if (state.currentFlowId) {
            $('#flowSelect option[value="' + state.currentFlowId + '"]').text(nextName);
            saveFlow({ reason: 'manual' });
          } else {
            markDirty({ autoSave: false });
          }

          dlg.dialog('close');
        },
        Cancel: function () {
          dlg.dialog('close');
        },
      },
      close: function () {
        dlg.remove();
      },
    });
  });

  $('#isPublicFlow').on('change', function () {
    state.isPublicFlow = !!$(this).prop('checked');
    markDirty();
  });

  $('#copyPublicLink').on('click', function () {
    const url = publicFlowUrl(state.publicToken);
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
    }
    setStatus('Public URL copied');
  });

  $('#flowSelect').on('change', function () {
    const id = String($(this).val() || '');
    if (!id) return;
    loadFlow(id);
  });

  $('#addStart').on('click', function () {
    if (!state.canEdit) return;
    addNode('start');
  });

  $('#addText').on('click', function () {
    if (!state.canEdit) return;
    addNode('text');
  });

  $('#addImage').on('click', function () {
    if (!state.canEdit) return;
    addNode('image');
  });

  $('#addFile').on('click', function () {
    if (!state.canEdit) return;
    addNode('file');
  });

  $('#addVideo').on('click', function () {
    if (!state.canEdit) return;
    addNode('video');
  });

  $('#addAudio').on('click', function () {
    if (!state.canEdit) return;
    addNode('audio');
  });

  $('#addEnd').on('click', function () {
    if (!state.canEdit) return;
    addNode('end');
  });

  $('#autoFormat').on('click', function () {
    autoFormatFlow();
  });

  $('#editNode').on('click', function () {
    if (!state.selectedNodeId) return;
    openEditDialog(state.selectedNodeId);
  });

  $('#colorNode').on('click', function () {
    if (!state.selectedNodeId) return;
    openColorDialog(state.selectedNodeId);
  });

  $('#deleteNode').on('click', function () {
    if (state.selectedNodeId) {
      deleteNode(state.selectedNodeId);
      return;
    }
    if (state.selectedLinkId) {
      deleteLink(state.selectedLinkId);
    }
  });

  $('#canvas').on('mousemove', function (e) {
    if (!state.linking) return;

    const rect = canvasEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / state.zoom;
    const y = (e.clientY - rect.top) / state.zoom;

    const a = portCenter(state.linking.sourceId, state.linking.port);
    if (!a) return;

    const path = tempGroupEl.querySelector('path');
    if (!path) return;
    path.setAttribute('d', bezierPath(a, { x: x, y: y }));
  });

  $('#canvas').on('mousedown', function (e) {
    if ($(e.target).closest('.port').length) return;
    if ($(e.target).closest('.node-card').length) return;
    selectNode(null);
    if (state.linking) cancelLink();
  });

  $(document).on('keydown', function (e) {
    if (e.key === 'Escape') {
      if (state.linking) cancelLink();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedNodeId) {
        const n = nodeById(state.selectedNodeId);
        if (canDeleteNode(n)) {
          deleteNode(state.selectedNodeId);
        }
      } else if (state.selectedLinkId && canDeleteLink(state.selectedLinkId)) {
        deleteLink(state.selectedLinkId);
      }
    }
  });

  $('#zoomIn').on('click', function () {
    setCanvasZoom(state.zoom + 0.1);
  });

  $('#zoomOut').on('click', function () {
    setCanvasZoom(state.zoom - 0.1);
  });

  $('#zoomReset').on('click', function () {
    setCanvasZoom(1);
  });

  $('#workspace').on('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.originalEvent && e.originalEvent.deltaY ? e.originalEvent.deltaY : 0;
    const step = delta > 0 ? -0.05 : 0.05;
    setCanvasZoom(state.zoom + step);
  });

  NI.apiJson('GET', '/api/me')
    .done(function (resp) {
      state.user = resp && resp.user;
      state.canEdit = !!(state.user && (state.user.role === 'admin' || state.user.role === 'editor'));
      if (state.user && state.user.role === 'admin') {
        $('#adminBtn').show();
      }
      applyEditPermissions();
    })
    .then(function () {
      applyEditPermissions();
      loadSidebarState();
      loadCanvasZoom();

      loadFlowList().always(function () {
        if (state.flows.length > 0) {
          const first = state.flows[0];
          state.currentFlowId = first.id;
          $('#flowSelect').val(first.id);
          loadFlow(first.id);
        } else {
          newFlowTemplate('New Flow');
        }
      });
    });
});
