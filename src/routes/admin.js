const express = require('express');
const { dbHelper } = require('../utils/database');
const Deployer = require('../utils/deployer');
const { isAdmin } = require('../middleware/auth');
const router = express.Router();

// Admin dashboard
router.get('/', isAdmin, (req, res) => {
  const db = dbHelper;
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  const apps = db.prepare('SELECT apps.*, users.username FROM apps JOIN users ON apps.user_id = users.id ORDER BY apps.created_at DESC').all();

  const stats = {
    totalUsers: users.length,
    totalApps: apps.length,
    runningApps: apps.filter(a => a.status === 'running').length,
    stoppedApps: apps.filter(a => a.status === 'stopped').length
  };

  res.render('admin/index', { users, apps, stats });
});

// Manage user
router.get('/users/:id', isAdmin, (req, res) => {
  const db = dbHelper;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { message: 'User not found' });

  const apps = db.prepare('SELECT * FROM apps WHERE user_id = ?').all(user.id);
  res.render('admin/user', { targetUser: user, apps });
});

// Update user limits
router.post('/users/:id/limits', isAdmin, (req, res) => {
  const db = dbHelper;
  const { max_apps, max_ram_mb, max_storage_mb } = req.body;
  db.prepare('UPDATE users SET max_apps = ?, max_ram_mb = ?, max_storage_mb = ? WHERE id = ?')
    .run(parseInt(max_apps), parseInt(max_ram_mb), parseInt(max_storage_mb), req.params.id);
  res.json({ success: true });
});

// Delete user
router.post('/users/:id/delete', isAdmin, (req, res) => {
  const db = dbHelper;
  const userId = parseInt(req.params.id);
  if (userId === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  // Stop and delete all user apps
  const apps = db.prepare('SELECT * FROM apps WHERE user_id = ?').all(userId);
  apps.forEach(app => {
    try { Deployer.deleteApp(app); } catch (e) { }
  });

  db.prepare('DELETE FROM deploy_logs WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ success: true });
});

// Force stop app (admin)
router.post('/apps/:id/force-stop', isAdmin, (req, res) => {
  const db = dbHelper;
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  Deployer.stopApp(app);
  res.json({ success: true });
});

module.exports = router;
