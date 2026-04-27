$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  const state = {
    page: 1,
    pageSize: 20,
    totalPages: 0,
    total: 0,
  };

  function setStatus(msg) {
    $('#status').text(msg || '');
  }

  function updatePager() {
    const pageText = state.total === 0
      ? 'No results'
      : 'Page ' + state.page + ' of ' + state.totalPages + ' (' + state.total + ' total)';
    $('#pageInfo').text(pageText);
    $('#prevPage').prop('disabled', state.page <= 1);
    $('#nextPage').prop('disabled', state.totalPages === 0 || state.page >= state.totalPages);
  }

  function loadPublicFlows() {
    const username = String($('#filterUsername').val() || '').trim();
    const name = String($('#filterFlowName').val() || '').trim();

    setStatus('Loading...');
    return NI.apiJson(
      'GET',
      '/api/public/flows?username=' + encodeURIComponent(username) + '&name=' + encodeURIComponent(name) + '&page=' + encodeURIComponent(state.page) + '&pageSize=' + encodeURIComponent(state.pageSize)
    )
      .done(function (resp) {
        const flows = (resp && resp.flows) || [];
        state.total = parseInt(String((resp && resp.total) || '0'), 10) || 0;
        state.page = parseInt(String((resp && resp.page) || state.page), 10) || 1;
        state.pageSize = parseInt(String((resp && resp.pageSize) || state.pageSize), 10) || 20;
        state.totalPages = parseInt(String((resp && resp.totalPages) || '0'), 10) || 0;
        const body = $('#publicFlowsBody');
        body.empty();

        flows.forEach(function (f) {
          const tr = $('<tr></tr>');
          tr.append($('<td></td>').text(f.name || 'Untitled'));
          tr.append($('<td></td>').text(f.username || ''));
          tr.append($('<td></td>').text(f.updatedAt ? new Date(f.updatedAt).toLocaleString() : ''));

          const view = $('<a class="ghost-link" style="padding:6px 8px;" target="_blank" rel="noopener noreferrer">Open</a>');
          view.attr('href', '/flow/' + encodeURIComponent(f.publicToken || ''));
          tr.append($('<td style="text-align:right;"></td>').append(view));

          body.append(tr);
        });

        if (flows.length === 0) {
          const tr = $('<tr></tr>');
          tr.append('<td colspan="4" style="color:var(--muted);">No public flows found</td>');
          body.append(tr);
        }

        updatePager();
        setStatus('');
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  }

  $('#applyFilter').on('click', function () {
    state.page = 1;
    loadPublicFlows();
  });

  $('#filterUsername,#filterFlowName').on('keydown', function (e) {
    if (e.key === 'Enter') {
      state.page = 1;
      loadPublicFlows();
    }
  });

  $('#prevPage').on('click', function () {
    if (state.page <= 1) return;
    state.page -= 1;
    loadPublicFlows();
  });

  $('#nextPage').on('click', function () {
    if (state.totalPages !== 0 && state.page >= state.totalPages) return;
    state.page += 1;
    loadPublicFlows();
  });

  loadPublicFlows();
});
