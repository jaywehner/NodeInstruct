$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#backBtn').on('click', function () {
    window.location = '/app';
  });

  $('#logoutBtn').on('click', function () {
    NI.apiJson('POST', '/api/auth/logout')
      .always(function () {
        window.location = '/login';
      });
  });

  function setStatus(msg) {
    $('#status').text(msg || '');
  }

  function roleOptionsHtml() {
    return '<option value="admin">Admin</option><option value="editor">Editor</option><option value="view_only">View Only</option>';
  }

  function roleLabel(role) {
    if (role === 'admin') return 'Admin';
    if (role === 'view_only') return 'View Only';
    return 'Editor';
  }

  function databaseLabel(engine) {
    if (engine === 'mysql') return 'MySQL';
    if (engine === 'mariadb') return 'MariaDB';
    return 'SQLite';
  }

  let databaseStatus = { engine: 'sqlite', locked: false, mysql: null, canMigrate: true, migratedAt: null };

  function getDatabaseFormValues() {
    return {
      engine: String($('#dbEngine').val() || 'sqlite'),
      host: String($('#dbHost').val() || '').trim(),
      port: parseInt(String($('#dbPort').val() || '3306'), 10) || 3306,
      username: String($('#dbUsername').val() || '').trim(),
      password: String($('#dbPassword').val() || ''),
      database: String($('#dbName').val() || '').trim(),
      useStoredPassword: !!$('#dbUseSavedPassword').prop('checked'),
    };
  }

  function setDatabaseFormValues(database) {
    const db = database || { engine: 'sqlite', mysql: null };
    const mysql = db.mysql || {};
    $('#dbEngine').val(db.engine === 'sqlite' ? 'sqlite' : (mysql.engine || db.engine || 'mysql'));
    $('#dbHost').val(mysql.host || '');
    $('#dbPort').val(mysql.port || 3306);
    $('#dbUsername').val(mysql.username || '');
    $('#dbName').val(mysql.database || '');
    $('#dbPassword').val('');
    $('#dbUseSavedPassword').prop('checked', !!mysql.hasPassword);
  }

  function refreshDatabaseUi() {
    const db = databaseStatus || { engine: 'sqlite', locked: false, mysql: null, canMigrate: true };
    const form = getDatabaseFormValues();
    const currentLabel = databaseLabel(db.engine);
    $('#dbCurrentBackend').text(currentLabel + (db.locked ? ' (locked)' : ''));

    const locked = !!db.locked || (db.engine !== 'sqlite');
    const targetIsSqlite = form.engine === 'sqlite';
    const hasStoredPassword = !!(db.mysql && db.mysql.hasPassword);
    const allowStoredPasswordToggle = hasStoredPassword && !targetIsSqlite;
    const useStoredPassword = allowStoredPasswordToggle && !!$('#dbUseSavedPassword').prop('checked');

    $('#dbEngine').prop('disabled', locked);
    $('#dbHost').prop('disabled', locked || targetIsSqlite);
    $('#dbPort').prop('disabled', locked || targetIsSqlite);
    $('#dbUsername').prop('disabled', locked || targetIsSqlite);
    $('#dbPassword').prop('disabled', locked || targetIsSqlite || useStoredPassword);
    $('#dbName').prop('disabled', locked || targetIsSqlite);
    $('#dbUseSavedPasswordWrap').css('display', allowStoredPasswordToggle ? 'inline-flex' : 'none');
    $('#dbUseSavedPassword').prop('disabled', locked || !allowStoredPasswordToggle);
    $('#testDatabaseConnection').prop('disabled', targetIsSqlite);
    $('#migrateDatabase').prop('disabled', locked || targetIsSqlite);

    if (allowStoredPasswordToggle) {
      $('#dbPasswordHint').text(useStoredPassword ? 'Using the saved password stored on the server. Enter a new password only if you want to test with different credentials.' : 'A password is already stored on the server. Leave this blank only if the database account has no password.');
      $('#dbPassword').attr('placeholder', useStoredPassword ? 'Using saved password' : 'Enter new password to override saved password');
    } else if (targetIsSqlite) {
      $('#dbPasswordHint').text('Select MySQL or MariaDB to enter external database credentials.');
      $('#dbPassword').attr('placeholder', '');
    } else {
      $('#dbPasswordHint').text('The password is never sent back to the browser after it is saved.');
      $('#dbPassword').attr('placeholder', 'Enter database password');
    }

    if (locked) {
      $('#dbLockedMessage').text('This instance is using ' + currentLabel + '. Switching back to SQLite is disabled after migration.');
    } else {
      $('#dbLockedMessage').text('You can migrate from SQLite to MySQL or MariaDB once. Reverting to SQLite is not allowed after migration.');
    }

    if (db.migratedAt) {
      $('#dbStatusMessage').text('Migrated at ' + new Date(db.migratedAt).toLocaleString());
    } else {
      $('#dbStatusMessage').text('');
    }
  }

  function applyDatabaseSettings(database) {
    databaseStatus = database || { engine: 'sqlite', locked: false, mysql: null, canMigrate: true, migratedAt: null };
    setDatabaseFormValues(databaseStatus);
    refreshDatabaseUi();
  }

  function buildDatabasePayload() {
    const values = getDatabaseFormValues();
    return {
      engine: values.engine,
      host: values.host,
      port: values.port,
      username: values.username,
      password: values.useStoredPassword ? '' : values.password,
      database: values.database,
      useStoredPassword: values.useStoredPassword,
    };
  }

  function loadSettings() {
    return NI.apiJson('GET', '/api/admin/settings')
      .done(function (resp) {
        $('#maxUploadMb').val((resp && resp.maxUploadMb) || 250);
        $('#allowSelfRegister').prop('checked', !!(resp && resp.allowSelfRegister));
        applyDatabaseSettings(resp && resp.database);
      });
  }

  function loadUsers() {
    setStatus('Loading...');
    return NI.apiJson('GET', '/api/admin/users')
      .done(function (resp) {
        renderUsers((resp && resp.users) || []);
        setStatus('');
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  }

  function renderUsers(users) {
    const body = $('#usersBody');
    body.empty();

    users.forEach(function (u) {
      const tr = $('<tr></tr>');
      tr.append($('<td></td>').text(u.username));
      tr.append($('<td></td>').text(roleLabel(u.role)));
      tr.append($('<td></td>').text(u.forcePasswordChange ? 'Yes' : 'No'));
      tr.append($('<td></td>').text(u.createdAt ? new Date(u.createdAt).toLocaleString() : ''));

      const actions = $('<td style="text-align:right;"></td>');

      const editBtn = $('<button type="button" class="ghost" style="width:auto;">Edit</button>');
      editBtn.on('click', function () {
        openEditDialog(u);
      });

      const delBtn = $('<button type="button" class="ghost" style="width:auto;margin-left:8px;">Delete</button>');
      if (u.isProtectedAdmin) {
        delBtn.prop('disabled', true);
        delBtn.attr('title', 'The first admin account cannot be deleted');
      }
      delBtn.on('click', function () {
        if (u.isProtectedAdmin) return;
        if (!confirm('Delete this user?')) return;
        setStatus('Deleting...');
        NI.apiJson('DELETE', '/api/admin/users/' + encodeURIComponent(u.id))
          .done(function () {
            loadUsers();
          })
          .fail(function (xhr) {
            setStatus(NI.formatError(xhr));
          });
      });

      actions.append(editBtn).append(delBtn);
      tr.append(actions);
      body.append(tr);
    });
  }

  function openAddDialog() {
    const dlg = $('<div title="Add User"></div>');

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Username</label>')
        .append('<input id="au_username" type="text" />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Password</label>')
        .append('<input id="au_password" type="password" />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Role</label>')
        .append('<select id="au_role">' + roleOptionsHtml() + '</select>')
    );

    dlg.dialog({
      modal: true,
      width: 420,
      open: function () {
        $('#au_role').val('editor');
      },
      buttons: {
        Create: function () {
          const username = String($('#au_username').val() || '').trim();
          const password = String($('#au_password').val() || '');
          const role = String($('#au_role').val() || 'editor');

          setStatus('Creating...');
          NI.apiJson('POST', '/api/admin/users', { username, password, role })
            .done(function () {
              dlg.dialog('close');
              loadUsers();
            })
            .fail(function (xhr) {
              setStatus(NI.formatError(xhr));
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

  function openEditDialog(user) {
    const dlg = $('<div title="Edit User"></div>');

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Username</label>')
        .append('<input id="eu_username" type="text" disabled />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>New password (optional)</label>')
        .append('<input id="eu_password" type="password" />')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label>Role</label>')
        .append('<select id="eu_role">' + roleOptionsHtml() + '</select>')
    );

    dlg.append(
      $('<div class="dialog-field"></div>')
        .append('<label><input id="eu_force" type="checkbox" /> Force password change</label>')
    );

    dlg.on('dialogopen', function () {
      $('#eu_username').val(user.username);
      $('#eu_role').val(user.role);
      $('#eu_force').prop('checked', !!user.forcePasswordChange);
    });

    dlg.dialog({
      modal: true,
      width: 420,
      buttons: {
        Save: function () {
          const password = String($('#eu_password').val() || '');
          const role = String($('#eu_role').val() || user.role);
          const forcePasswordChange = !!$('#eu_force').prop('checked');

          const body = { role, forcePasswordChange };
          if (password) body.password = password;

          setStatus('Saving...');
          NI.apiJson('PUT', '/api/admin/users/' + encodeURIComponent(user.id), body)
            .done(function () {
              dlg.dialog('close');
              loadUsers();
            })
            .fail(function (xhr) {
              setStatus(NI.formatError(xhr));
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

  $('#addUser').on('click', function () {
    openAddDialog();
  });

  $('#saveSettings').on('click', function () {
    const maxUploadMb = parseInt(String($('#maxUploadMb').val() || ''), 10);
    const allowSelfRegister = !!$('#allowSelfRegister').prop('checked');
    setStatus('Saving settings...');
    NI.apiJson('PUT', '/api/admin/settings', { maxUploadMb: maxUploadMb, allowSelfRegister: allowSelfRegister })
      .done(function () {
        setStatus('Settings saved');
        loadSettings();
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  });

  $('#dbEngine').on('change', function () {
    if (String($('#dbEngine').val() || 'sqlite') === 'sqlite') {
      $('#dbUseSavedPassword').prop('checked', false);
    }
    refreshDatabaseUi();
  });

  $('#dbUseSavedPassword').on('change', function () {
    if ($(this).prop('checked')) {
      $('#dbPassword').val('');
    }
    refreshDatabaseUi();
  });

  $('#dbHost, #dbPort, #dbUsername, #dbPassword, #dbName').on('input', function () {
    refreshDatabaseUi();
  });

  $('#testDatabaseConnection').on('click', function () {
    const payload = buildDatabasePayload();
    if (payload.engine === 'sqlite') {
      setStatus('Select MySQL or MariaDB to test');
      return;
    }

    setStatus('Testing database connection...');
    NI.apiJson('POST', '/api/admin/database/test', payload)
      .done(function (resp) {
        setStatus('Connection successful: ' + databaseLabel(resp && resp.engine) + ' at ' + (resp && resp.host) + ':' + (resp && resp.port) + ' / ' + (resp && resp.database));
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  });

  $('#migrateDatabase').on('click', function () {
    const payload = buildDatabasePayload();
    const engine = payload.engine;
    if (engine === 'sqlite') {
      setStatus('Select MySQL or MariaDB to migrate');
      return;
    }

    if (!confirm('Migrate the current SQLite database to ' + databaseLabel(engine) + '? This cannot be reversed back to SQLite.')) return;

    setStatus('Migrating database...');
    NI.apiJson('POST', '/api/admin/database/migrate', payload)
      .done(function (resp) {
        applyDatabaseSettings(resp && resp.database);
        setStatus('Database migration complete');
      })
      .fail(function (xhr) {
        setStatus(NI.formatError(xhr));
      });
  });

  loadSettings();
  loadUsers();
});
