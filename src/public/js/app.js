// ── Toast Notifications ────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── App Actions (deploy/start/stop/restart) ─────────────────────────────────
async function appAction(id, action) {
  const labels = { deploy: 'Deploying', start: 'Starting', stop: 'Stopping', restart: 'Restarting' };
  showToast(`${labels[action] || action}...`, 'info');
  try {
    const r = await fetch(`/apps/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.success || data.message) {
      showToast(data.message || `${action} successful`, 'success');
      setTimeout(() => location.reload(), 1500);
    } else {
      showToast(data.error || `${action} failed`, 'error');
    }
  } catch (e) {
    showToast(`Network error: ${e.message}`, 'error');
  }
}

// ── Delete App ──────────────────────────────────────────────────────────────
async function deleteApp(id) {
  if (!confirm('Delete this app? This removes all files and cannot be undone.')) return;
  try {
    const r = await fetch(`/apps/${id}/delete`, { method: 'POST' });
    const data = await r.json();
    if (data.success) {
      showToast('App deleted', 'success');
      setTimeout(() => window.location.href = '/dashboard', 1000);
    } else {
      showToast(data.error || 'Delete failed', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Auto-dismiss alerts ─────────────────────────────────────────────────────
document.querySelectorAll('.alert').forEach(el => {
  setTimeout(() => {
    el.style.transition = 'opacity 0.4s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, 5000);
});

// ── Animate stat numbers ────────────────────────────────────────────────────
function animateNumber(el) {
  const target = parseInt(el.textContent.replace(/[^0-9]/g, ''), 10);
  if (isNaN(target) || target === 0) return;
  let start = 0;
  const dur = 600;
  const step = Math.ceil(target / (dur / 16));
  const timer = setInterval(() => {
    start = Math.min(start + step, target);
    el.textContent = el.dataset.suffix ? start + el.dataset.suffix : start;
    if (start >= target) clearInterval(timer);
  }, 16);
}
document.querySelectorAll('.stat-value').forEach(el => {
  // Only animate pure numbers
  if (/^\d+$/.test(el.textContent.trim())) animateNumber(el);
});

// ── Navbar active state ─────────────────────────────────────────────────────
const path = window.location.pathname;
document.querySelectorAll('.nav-links a').forEach(a => {
  if (a.getAttribute('href') === path) {
    a.style.background = 'rgba(124,58,237,0.12)';
    a.style.color = '#c4b5fd';
  }
});
