$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#registerLink').on('click', function () {
    window.location = '/register';
  });

  $('#resendVerification').on('click', function () {
    const email = String($('#username').val() || '').trim();
    $('#error').text('');
    if (!email) {
      $('#error').text('Enter your email address first.');
      return;
    }
    NI.apiJson('POST', '/api/auth/resend-verification', { email })
      .done(function (resp) {
        $('#registerStatus').text((resp && resp.message) || 'If the account requires verification, a new email has been sent.');
      })
      .fail(function (xhr) {
        $('#error').text(NI.formatError(xhr));
      });
  });

  NI.apiJson('GET', '/api/auth/config')
    .done(function (resp) {
      const enabled = !!(resp && resp.allowSelfRegister);
      $('#registerLink').prop('disabled', !enabled);
      $('#registerStatus').text(enabled ? 'A verification link will be sent to your email address.' : 'New account registration is currently disabled.');
    });

  $('#loginForm').on('submit', function (e) {
    e.preventDefault();
    $('#error').text('');

    const username = String($('#username').val() || '').trim();
    const password = String($('#password').val() || '');

    NI.apiJson('POST', '/api/auth/login', { username, password })
      .done(function (resp) {
        if (resp && resp.user && resp.user.forcePasswordChange) {
          window.location = '/force-password-change';
          return;
        }
        window.location = '/app';
      })
      .fail(function (xhr) {
        $('#error').text(NI.formatError(xhr));
      });
  });
});
