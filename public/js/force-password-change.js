$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#changeForm').on('submit', function (e) {
    e.preventDefault();
    $('#error').text('');

    const newPassword = String($('#newPassword').val() || '');
    const confirm = String($('#confirmPassword').val() || '');

    if (newPassword !== confirm) {
      $('#error').text('Passwords do not match');
      return;
    }

    NI.apiJson('POST', '/api/auth/change-password', { newPassword })
      .done(function () {
        window.location = '/app';
      })
      .fail(function (xhr) {
        $('#error').text(NI.formatError(xhr));
      });
  });
});
