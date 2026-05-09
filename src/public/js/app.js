// App actions (deploy, start, stop, restart)
async function appAction(appId, action) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Working...';

  try {
    const res = await fetch(`/apps/${appId}/${action}`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast(`App ${action} successful!`, 'success');
      setTimeout(() => location.reload(), 1000);
    } else {
      showToast(data.error || `Failed to ${action}`, 'error');
      btn.disabled = false;
      btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
    }
  } catch (err) {
    showToast('Network error', 'error');
    btn.disabled = false;
    btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
  }
}

// Delete app
async function deleteApp(appId) {
  if (!confirm('Are you sure? This will stop the app and delete all files.')) return;

  try {
    const res = await fetch(`/apps/${appId}/delete`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('App deleted', 'success');
      setTimeout(() => window.location.href = '/dashboard', 1000);
    } else {
      showToast(data.error || 'Failed to delete', 'error');
    }
  } catch (err) {
    showToast('Network error', 'error');
  }
}

// Save git token
async function saveGitToken() {
  const token = document.getElementById('git-token-input').value;
  if (!token || token === '••••••••') {
    showToast('Enter a valid token', 'error');
    return;
  }

  try {
    const res = await fetch('/apps/settings/git-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_token: token })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Git token saved!', 'success');
      document.getElementById('git-token-input').value = '••••••••';
    }
  } catch (err) {
    showToast('Failed to save token', 'error');
  }
}

// Save environment variables
async function saveEnvVars(appId) {
  const envVars = document.getElementById('env-vars').value;

  try {
    JSON.parse(envVars);
  } catch (e) {
    showToast('Invalid JSON format', 'error');
    return;
  }

  try {
    const res = await fetch(`/apps/${appId}/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env_vars: envVars })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to save', 'error');
  }
}

// Refresh logs
async function refreshLogs(appId) {
  const logEl = document.getElementById('app-logs');
  logEl.textContent = 'Loading...';

  try {
    const res = await fetch(`/apps/${appId}/logs`);
    const data = await res.json();
    logEl.textContent = data.logs || 'No logs available';
  } catch (err) {
    logEl.textContent = 'Failed to load logs';
  }
}

// Admin functions
async function deleteUser(userId) {
  if (!confirm('Delete this user and all their apps?')) return;

  try {
    const res = await fetch(`/admin/users/${userId}/delete`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('User deleted', 'success');
      setTimeout(() => location.reload(), 1000);
    }
  } catch (err) {
    showToast('Failed to delete user', 'error');
  }
}

async function updateLimits(userId) {
  const maxApps = document.getElementById('max-apps').value;
  const maxRam = document.getElementById('max-ram').value;
  const maxStorage = document.getElementById('max-storage').value;

  try {
    const res = await fetch(`/admin/users/${userId}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_apps: maxApps, max_ram_mb: maxRam, max_storage_mb: maxStorage })
    });
    const data = await res.json();
    if (data.success) showToast('Limits updated', 'success');
  } catch (err) {
    showToast('Failed to update', 'error');
  }
}

async function adminForceStop(appId) {
  if (!confirm('Force stop this app?')) return;

  try {
    const res = await fetch(`/admin/apps/${appId}/force-stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('App stopped', 'success');
      setTimeout(() => location.reload(), 1000);
    }
  } catch (err) {
    showToast('Failed', 'error');
  }
}

// Toast notifications
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    border-radius: 8px;
    font-weight: 500;
    font-size: 0.9rem;
    z-index: 9999;
    animation: slideIn 0.3s ease;
    background: ${type === 'success' ? '#00b894' : '#e74c3c'};
    color: white;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
