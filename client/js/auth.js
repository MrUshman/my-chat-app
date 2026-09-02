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
    const token = localStorage.getItem('chatToken');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/auth/me', { credentials: 'include', headers });
    if (res.ok) {
      window.location.replace('/index.html');
    }
  } catch {
    // Not logged in
  }
})();

// Password toggles with event delegation (handles SVG child touch/clicks on mobile)
document.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('.toggle-password-btn');
  if (toggleBtn) {
    e.preventDefault();
    e.stopPropagation();
    const targetId = toggleBtn.dataset.target;
    const input = document.getElementById(targetId);
    if (input) {
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      toggleBtn.classList.toggle('active', isPwd);
    }
  }
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

// Login & Register Submission Setup
function setupAuthForms() {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const usernameEl = document.getElementById('username');
      const passwordEl = document.getElementById('password');
      const btnEl = document.getElementById('loginBtn');
      const textEl = document.getElementById('loginBtnText');
      const spinnerEl = document.getElementById('loginSpinner');
      const errorEl = document.getElementById('loginError');

      if (errorEl) errorEl.classList.remove('visible');

      const username = usernameEl ? usernameEl.value.trim() : '';
      const password = passwordEl ? passwordEl.value : '';

      if (!username || !password) {
        if (errorEl) {
          errorEl.textContent = 'Please enter your username and password.';
          errorEl.classList.add('visible');
        }
        return;
      }

      if (btnEl) btnEl.disabled = true;
      if (textEl) textEl.style.display = 'none';
      if (spinnerEl) spinnerEl.style.display = 'inline-block';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          credentials: 'include',
        });

        const data = await res.json();
        if (!res.ok) {
          if (errorEl) {
            errorEl.textContent = data.error || 'Invalid username or password.';
            errorEl.classList.add('visible');
          }
          return;
        }

        if (data.token) {
          localStorage.setItem('chatToken', data.token);
          document.cookie = `chatToken=${data.token}; path=/; max-age=1296000; SameSite=Lax`;
        }

        window.location.href = '/index.html';
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = 'Cannot connect to server: ' + err.message;
          errorEl.classList.add('visible');
        }
      } finally {
        if (btnEl) btnEl.disabled = false;
        if (textEl) textEl.style.display = 'inline';
        if (spinnerEl) spinnerEl.style.display = 'none';
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const nameEl = document.getElementById('regDisplayName');
      const userEl = document.getElementById('regUsername');
      const passEl = document.getElementById('regPassword');
      const btnEl = document.getElementById('regBtn');
      const textEl = document.getElementById('regBtnText');
      const spinnerEl = document.getElementById('regSpinner');
      const errorEl = document.getElementById('regError');

      if (errorEl) errorEl.classList.remove('visible');

      const displayName = nameEl ? nameEl.value.trim() : '';
      const username = userEl ? userEl.value.trim() : '';
      const password = passEl ? passEl.value : '';

      if (!displayName || !username || !password) {
        if (errorEl) {
          errorEl.textContent = 'All fields are required.';
          errorEl.classList.add('visible');
        }
        return;
      }

      if (btnEl) btnEl.disabled = true;
      if (textEl) textEl.style.display = 'none';
      if (spinnerEl) spinnerEl.style.display = 'inline-block';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, username, password }),
          credentials: 'include',
        });

        const data = await res.json();
        if (!res.ok) {
          if (errorEl) {
            errorEl.textContent = data.error || 'Registration failed.';
            errorEl.classList.add('visible');
          }
          return;
        }

        if (data.token) {
          localStorage.setItem('chatToken', data.token);
          document.cookie = `chatToken=${data.token}; path=/; max-age=1296000; SameSite=Lax`;
        }

        window.location.href = '/index.html';
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = 'Cannot connect to server: ' + err.message;
          errorEl.classList.add('visible');
        }
      } finally {
        if (btnEl) btnEl.disabled = false;
        if (textEl) textEl.style.display = 'inline';
        if (spinnerEl) spinnerEl.style.display = 'none';
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAuthForms);
} else {
  setupAuthForms();
}
