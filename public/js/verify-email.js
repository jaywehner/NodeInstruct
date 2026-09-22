$(function () {
  const params = new URLSearchParams(window.location.search);
  const token = String(params.get('token') || '');
  if (!token) {
    $('#message').text('No verification token provided.');
    return;
  }
  $('#message').text('Verifying...');
  NI.apiJson('POST', '/api/auth/verify-email', { token })
    .done(function () {
      $('#message').text('Your email has been verified. You can now log in.');
    })
    .fail(function (xhr) {
      $('#message').text(NI.formatError(xhr));
    });
});
