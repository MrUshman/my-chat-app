'use strict';

/**
 * auth.js — Login & Registration Page Logic
 */

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

const tabLoginBtn = document.getElementById('tabLoginBtn');
const tabRegisterBtn = document.getElementById('tabRegisterBtn');

const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const loginSpinner = document.getElementById('loginSpinner');
const loginError = document.getElementById('loginError');

const regDisplayName = document.getElementById('regDisplayName');
const regUsername = document.getElementById('regUsername');
const regPassword = document.getElementById('regPassword');
const regBtn = document.getElementById('regBtn');
const regBtnText = document.getElementById('regBtnText');
const regSpinner = document.getElementById('regSpinner');
const regError = document.getElementById('regError');

// Check if already authenticated
(async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      window.location.replace('/index.html');
    }
  } catch {
    // Not logged in
  }
})();

// Password toggles
document.querySelectorAll('.toggle-password-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    if (!input) return;
    const isPwd = input.type === 'password';
    input.type = isPwd ? 'text' : 'password';
    btn.classList.toggle('active', isPwd);
  });
});

// Tab Switchers
tabLoginBtn?.addEventListener('click', () => {
  tabLoginBtn.classList.add('active');
  tabRegisterBtn.classList.remove('active');
  loginForm.style.display = 'block';
  registerForm.style.display = 'none';
  hideErrors();
});

tabRegisterBtn?.addEventListener('click', () => {
  tabRegisterBtn.classList.add('active');
  tabLoginBtn.classList.remove('active');
  registerForm.style.display = 'block';
  loginForm.style.display = 'none';
  hideErrors();
});

function hideErrors() {
  if (loginError) loginError.classList.remove('visible');
  if (regError) regError.classList.remove('visible');
}

function showLoginError(msg) {
  if (loginError) {
    loginError.textContent = msg;
    loginError.classList.add('visible');
  }
}

function showRegError(msg) {
  if (regError) {
    regError.textContent = msg;
    regError.classList.add('visible');
  }
}

// Login Submission
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErrors();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showLoginError('Please enter your username and password.');
    return;
  }

  loginBtn.disabled = true;
  loginBtnText.style.display = 'none';
  loginSpinner.style.display = 'inline-block';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });

    const data = await res.json();
    if (!res.ok) {
      showLoginError(data.error || 'Invalid username or password.');
      return;
    }

    window.location.replace('/index.html');
  } catch {
    showLoginError('Cannot connect to server. Please try again.');
  } finally {
    loginBtn.disabled = false;
    loginBtnText.style.display = 'inline';
    loginSpinner.style.display = 'none';
  }
});

// Register Submission
registerForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErrors();

  const displayName = regDisplayName.value.trim();
  const username = regUsername.value.trim();
  const password = regPassword.value;

  if (!displayName || !username || !password) {
    showRegError('All fields are required.');
    return;
  }

  regBtn.disabled = true;
  regBtnText.style.display = 'none';
  regSpinner.style.display = 'inline-block';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, username, password }),
      credentials: 'include',
    });

    const data = await res.json();
    if (!res.ok) {
      showRegError(data.error || 'Registration failed.');
      return;
    }

    window.location.replace('/index.html');
  } catch {
    showRegError('Cannot connect to server. Please try again.');
  } finally {
    regBtn.disabled = false;
    regBtnText.style.display = 'inline';
    regSpinner.style.display = 'none';
  }
});
