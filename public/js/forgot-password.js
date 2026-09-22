$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  $('#forgotPasswordForm').on('submit', function (e) {
    e.preventDefault();
    const email = String($('#email').val() || '').trim();
    $('#message').removeClass('success-message').text('');
    NI.apiJson('POST', '/api/auth/forgot-password', { email })
      .done(function (resp) {
        $('#forgotPasswordForm button[type="submit"]').prop('disabled', true);
        $('#message').addClass('success-message').text(resp.message || 'If an account exists for that email, a password reset link has been sent.');
      })
      .fail(function (xhr) {
        $('#message').text(NI.formatError(xhr));
      });
  });
});
