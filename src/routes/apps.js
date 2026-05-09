const express = require('express');
const { dbHelper } = require('../utils/database');
const Deployer = require('../utils/deployer');
const router = express.Router();

// Create new app page
router.get('/create', (req, res) => {
  const db = dbHelper;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const appCount = db.prepare('SELECT COUNT(*) as count FROM apps WHERE user_id = ?').get(req.session.user.id);

  if (appCount && appCount.count >= user.max_apps) {
    return res.render('error', { message: `You've reached your app limit (${user.max_apps}). Contact admin to upgrade.` });
  }

  res.render('apps/create', { error: null });
});

// Create new app handler
router.post('/create', async (req, res) => {
  try {
    const { name, repo_url, branch, entry_file, ram_limit } = req.body;
    const userId = req.session.user.id;
    const db = dbHelper;

    // Validate app name
    const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (cleanName.length < 2 || cleanName.length > 30) {
      return res.render('apps/create', { error: 'App name must be 2-30 characters (letters, numbers, hyphens)' });
    }

    // Check duplicate name
    const existing = db.prepare('SELECT id FROM apps WHERE user_id = ? AND name = ?').get(userId, cleanName);
    if (existing) {
      return res.render('apps/create', { error: 'You already have an app with this name' });
    }

    // Check limits
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const appCount = db.prepare('SELECT COUNT(*) as count FROM apps WHERE user_id = ?').get(userId);
    if (appCount && appCount.count >= user.max_apps) {
      return res.render('apps/create', { error: 'App limit reached' });
    }

    const port = Deployer.getNextPort();
    const ramLimit = Math.min(parseInt(ram_limit) || 256, user.max_ram_mb);

    // Insert app record
    const result = db.prepare('INSERT INTO apps (user_id, name, repo_url, branch, port, entry_file, ram_limit_mb) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, cleanName, repo_url, branch || 'main', port, entry_file || 'index.js', ramLimit);

    const appId = result.lastInsertRowid;

    // Log creation
    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output) VALUES (?, ?, ?, ?)')
      .run(appId, userId, 'create', `App created: ${cleanName}`);

    res.redirect(`/apps/${appId}`);
  } catch (err) {
    console.error(err);
    res.render('apps/create', { error: err.message });
  }
});

// App detail page
router.get('/:id', (req, res) => {
  const db = dbHelper;
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!app) return res.status(404).render('error', { message: 'App not found' });

  const logs = db.prepare('SELECT * FROM deploy_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 20').all(app.id);
  const info = Deployer.getAppInfo(app);

  res.render('apps/detail', { app, logs, info });
});

// Deploy app
router.post('/:id/deploy', async (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

    // Check storage
    const storageUsed = Deployer.getUserStorageUsage(req.session.user.id);
    if (storageUsed >= user.max_storage_mb) {
      return res.status(400).json({ error: 'Storage limit exceeded' });
    }

    // Clone repo
    db.prepare('UPDATE apps SET status = ? WHERE id = ?').run('deploying', app.id);
    await Deployer.cloneRepo(app, user.git_token);

    // Install dependencies
    const appDir = Deployer.getAppDir(app.user_id, app.name);
    Deployer.installDependencies(appDir);

    // Start app
    await Deployer.startApp(app);

    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output, status) VALUES (?, ?, ?, ?, ?)')
      .run(app.id, req.session.user.id, 'deploy', 'Deployed successfully', 'success');

    res.json({ success: true, message: 'App deployed successfully' });
  } catch (err) {
    console.error(err);
    const db = dbHelper;
    db.prepare('UPDATE apps SET status = ? WHERE id = ?').run('error', req.params.id);
    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, req.session.user.id, 'deploy', err.message, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Start app
router.post('/:id/start', async (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    await Deployer.startApp(app);
    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output) VALUES (?, ?, ?, ?)')
      .run(app.id, req.session.user.id, 'start', 'App started');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop app
router.post('/:id/stop', (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    Deployer.stopApp(app);
    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output) VALUES (?, ?, ?, ?)')
      .run(app.id, req.session.user.id, 'stop', 'App stopped');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart app
router.post('/:id/restart', (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    Deployer.restartApp(app);
    db.prepare('INSERT INTO deploy_logs (app_id, user_id, action, output) VALUES (?, ?, ?, ?)')
      .run(app.id, req.session.user.id, 'restart', 'App restarted');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete app
router.post('/:id/delete', (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    Deployer.deleteApp(app);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs
router.get('/:id/logs', (req, res) => {
  const db = dbHelper;
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!app) return res.status(404).json({ error: 'App not found' });

  const logs = Deployer.getLogs(app);
  res.json({ logs });
});

// Update env vars
router.post('/:id/env', (req, res) => {
  try {
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const { env_vars } = req.body;
    JSON.parse(env_vars); // Validate JSON

    db.prepare('UPDATE apps SET env_vars = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(env_vars, app.id);

    res.json({ success: true, message: 'Environment variables updated. Redeploy to apply.' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON format for environment variables' });
  }
});

// Update git token
router.post('/settings/git-token', (req, res) => {
  const db = dbHelper;
  const { git_token } = req.body;
  db.prepare('UPDATE users SET git_token = ? WHERE id = ?').run(git_token, req.session.user.id);
  res.json({ success: true, message: 'Git token saved' });
});

module.exports = router;
