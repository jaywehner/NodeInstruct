$(function () {
  function showStep(n) {
    $('.setup-step').hide();
    $('#step' + n).show();
  }

  function setError(id, msg) {
    $('#' + id).text(msg || '').css('color', '');
  }

  function setSuccess(id, msg) {
    $('#' + id).text(msg || '').css('color', '#16a34a');
  }

  function getDatabasePayload() {
    const engine = String($('#dbType').val());
    const payload = { engine: engine };
    if (engine !== 'sqlite') {
      payload.host = String($('#dbHost').val() || '').trim();
      payload.port = parseInt(String($('#dbPort').val() || '3306'), 10) || 3306;
      payload.username = String($('#dbUsername').val() || '').trim();
      payload.password = String($('#dbPassword').val() || '');
      payload.database = String($('#dbName').val() || '').trim();
    }
    return payload;
  }

  function updateDbButtons() {
    const engine = String($('#dbType').val());
    if (engine === 'sqlite') {
      $('#dbTest, #dbCreate').hide();
      $('#dbContinue').show();
    } else {
      $('#dbTest').show();
      $('#dbCreate').hide();
      $('#dbContinue').hide();
    }
  }

  $('#dbType').on('change', function () {
    $('#dbExternal').toggle(String($(this).val()) !== 'sqlite');
    updateDbButtons();
  });

  $('#dbContinue').on('click', function () {
    setError('dbError', '');
    NI.apiJson('POST', '/api/setup/database/create', { engine: 'sqlite' })
      .done(function () {
        showStep(2);
      })
      .fail(function (xhr) {
        setError('dbError', NI.formatError(xhr));
      });
  });

  $('#dbTest').on('click', function () {
    setError('dbError', '');
    $('#dbCreate').hide();
    NI.apiJson('POST', '/api/setup/database/test', getDatabasePayload())
      .done(function () {
        setSuccess('dbError', 'Connection successful. You can now create the database.');
        $('#dbCreate').show();
      })
      .fail(function (xhr) {
        setError('dbError', NI.formatError(xhr));
      });
  });

  $('#dbCreate').on('click', function () {
    setError('dbError', '');
    NI.apiJson('POST', '/api/setup/database/create', getDatabasePayload())
      .done(function () {
        showStep(2);
      })
      .fail(function (xhr) {
        setError('dbError', NI.formatError(xhr));
      });
  });

  updateDbButtons();

  $('#smtpNext').on('click', function () {
    setError('smtpError', '');
    const payload = {
      host: String($('#smtpHost').val() || '').trim(),
      port: parseInt(String($('#smtpPort').val() || '587'), 10) || 587,
      user: String($('#smtpUser').val() || '').trim(),
      pass: String($('#smtpPass').val() || ''),
      from: String($('#smtpFrom').val() || '').trim(),
      secure: !!$('#smtpSecure').prop('checked'),
      testEmail: String($('#smtpTestEmail').val() || '').trim(),
    };
    NI.apiJson('POST', '/api/setup/smtp', payload)
      .done(function () {
        showStep(3);
      })
      .fail(function (xhr) {
        setError('smtpError', NI.formatError(xhr));
      });
  });

  $('#adminCreate').on('click', function () {
    setError('adminError', '');
    const email = String($('#adminEmail').val() || '').trim();
    const password = String($('#adminPassword').val() || '');
    const confirm = String($('#adminConfirm').val() || '');
    if (!email || !password || !confirm) {
      setError('adminError', 'Please fill in all fields');
      return;
    }
    if (password !== confirm) {
      setError('adminError', 'Passwords do not match');
      return;
    }
    NI.apiJson('POST', '/api/setup/admin', { email, password, confirmPassword: confirm })
      .done(function () {
        window.location = '/login';
      })
      .fail(function (xhr) {
        setError('adminError', NI.formatError(xhr));
      });
  });
});
