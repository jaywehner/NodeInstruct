$(function () {
  const token = String(new URLSearchParams(window.location.search).get('token') || '');

  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  if (!token) {
    $('#resetPasswordForm :input').prop('disabled', true);
    $('#message').text('This password reset link is invalid.');
    return;
  }

  $('#resetPasswordForm').on('submit', function (e) {
    e.preventDefault();
    const password = String($('#password').val() || '');
    const confirmPassword = String($('#confirmPassword').val() || '');
    $('#message').removeClass('success-message').text('');
    NI.apiJson('POST', '/api/auth/reset-password', { token, password, confirmPassword })
      .done(function (resp) {
        $('#resetPasswordForm :input').prop('disabled', true);
        $('#message').addClass('success-message').text(resp.message || 'Your password has been reset. You can now sign in.');
      })
      .fail(function (xhr) {
        $('#message').text(NI.formatError(xhr));
      });
  });
});
