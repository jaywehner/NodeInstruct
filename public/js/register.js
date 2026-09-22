$(function () {
  $('#themeToggle').on('click', function () {
    NI.toggleTheme();
  });

  function validatePassword(password) {
    const errors = [];
    if (password.length < 8) errors.push('Password must be at least 8 characters long.');
    if (!/[a-z]/.test(password)) errors.push('Password must include at least one lowercase letter.');
    if (!/[A-Z]/.test(password)) errors.push('Password must include at least one uppercase letter.');
    if (!/[0-9]/.test(password)) errors.push('Password must include at least one number.');
    return errors;
  }

  $('#registerForm').on('submit', function (e) {
    e.preventDefault();
    $('#error').text('');

    const username = String($('#username').val() || '').trim();
    const password = String($('#password').val() || '');
    const confirmPassword = String($('#confirmPassword').val() || '');

    if (!username) {
      $('#error').text('Please enter your email address.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      $('#error').text('Please enter a valid email address.');
      return;
    }

    if (!password) {
      $('#error').text('Please enter a password.');
      return;
    }

    const passwordErrors = validatePassword(password);
    if (passwordErrors.length) {
      $('#error').text(passwordErrors.join(' '));
      return;
    }

    if (password !== confirmPassword) {
      $('#error').text('Passwords do not match.');
      return;
    }

    NI.apiJson('POST', '/api/auth/register', { username, password, confirmPassword })
      .done(function (resp) {
        $('#registerForm').hide();
        $('#registrationSuccess').text((resp && resp.message) || 'Account created. Check your email for a verification link.').show();
      })
      .fail(function (xhr) {
        $('#error').text(NI.formatError(xhr));
      });
  });
});
