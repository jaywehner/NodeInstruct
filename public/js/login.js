$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  NI.apiJson('GET', '/api/auth/config')
    .done(function (resp) {
      if (resp && resp.allowSelfRegister) {
        $('#registerLink').show();
      }
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
