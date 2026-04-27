$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#registerForm').on('submit', function (e) {
    e.preventDefault();
    $('#error').text('');

    const username = String($('#username').val() || '').trim();
    const password = String($('#password').val() || '');

    NI.apiJson('POST', '/api/auth/register', { username, password })
      .done(function () {
        window.location = '/login';
      })
      .fail(function (xhr) {
        $('#error').text(NI.formatError(xhr));
      });
  });
});
