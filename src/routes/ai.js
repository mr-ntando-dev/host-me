const express = require('express');
const https = require('https');
const { dbHelper } = require('../utils/database');
const Deployer = require('../utils/deployer');
const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: call Pollinations.ai text API - completely free, no API key needed
// Endpoint: https://text.pollinations.ai/openai  (OpenAI-compatible)
// ---------------------------------------------------------------------------
async function callAI(messages, opts) {
  const temperature = (opts && opts.temperature !== undefined) ? opts.temperature : 0.4;
  const max_tokens = (opts && opts.max_tokens !== undefined) ? opts.max_tokens : 800;

  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      model: 'openai',
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      private: true
    });

    const req = https.request({
      hostname: 'text.pollinations.ai',
      path: '/openai',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          if (!parsed.choices || !parsed.choices[0]) return reject(new Error('Empty response from AI'));
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(new Error('Failed to parse AI response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function() {
      req.destroy();
      reject(new Error('AI request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// POST /ai/analyze-logs
// ---------------------------------------------------------------------------
router.post('/analyze-logs', async function(req, res) {
  try {
    const app_id = req.body.app_id;
    const db = dbHelper;

    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
      .get(app_id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    // Fixed: was incorrectly calling Deployer.getAppLogs which does not exist
    let pm2Logs = '';
    try { pm2Logs = Deployer.getLogs(app); } catch (e) { pm2Logs = 'Logs unavailable'; }

    const history = db.prepare('SELECT * FROM deploy_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 10').all(app.id);
    const historyText = history.map(function(h) { return '[' + h.created_at + '] ' + h.action + ' (' + h.status + '): ' + h.output; }).join('\n');

    const info = Deployer.getAppInfo(app);
    const runtimeText = info
      ? 'Status: ' + info.status + ', Memory: ' + info.memory + 'MB/' + app.ram_limit_mb + 'MB, CPU: ' + info.cpu + '%, Restarts: ' + info.restarts
      : 'Runtime info unavailable';

    const response = await callAI([
      { role: 'system', content: 'You are an expert Node.js DevOps engineer for the Speceify hosting panel.\nAnalyze the provided app info and give a concise actionable diagnosis.\nUse markdown. Reference actual errors or metrics. Under 400 words. Be direct.' },
      { role: 'user', content: 'App: ' + app.name + '\nRepo: ' + app.repo_url + ' (branch: ' + app.branch + ')\nEntry: ' + app.entry_file + '\nRAM limit: ' + app.ram_limit_mb + 'MB\nAuto-restart: ' + (app.auto_restart ? 'yes' : 'no') + '\n\nRuntime: ' + runtimeText + '\n\nPM2 logs:\n' + (pm2Logs.slice(-3000) || 'None') + '\n\nDeploy history:\n' + (historyText || 'None') + '\n\nAnalyze health, identify errors, warn on resource usage, give next steps.' }
    ], { max_tokens: 600 });

    res.json({ success: true, analysis: response });
  } catch (err) {
    console.error('AI analyze-logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/detect-config
// ---------------------------------------------------------------------------
router.post('/detect-config', async function(req, res) {
  try {
    const repo_url = req.body.repo_url;
    if (!repo_url) return res.status(400).json({ error: 'repo_url required' });

    let packageJsonContent = null;
    let readmeContent = null;

    const githubMatch = repo_url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (githubMatch) {
      const owner = githubMatch[1];
      const repoName = githubMatch[2].replace(/\.git$/, '');
      try { packageJsonContent = await fetchGitHubFile(owner, repoName, 'package.json'); } catch (e) {}
      try { readmeContent = await fetchGitHubFile(owner, repoName, 'README.md'); if (readmeContent) readmeContent = readmeContent.slice(0, 2000); } catch (e) {}
      try { const env = await fetchGitHubFile(owner, repoName, '.env.example'); if (env) readmeContent = (readmeContent || '') + '\n\n.env.example:\n' + env.slice(0, 500); } catch (e) {}
    }

    const response = await callAI([
      { role: 'system', content: 'You are a Node.js deployment config expert for Speceify.\nReturn ONLY a valid JSON object, no markdown, no explanation:\n{"name":"app-name","branch":"main","entry_file":"index.js","ram_limit":256,"env_vars":{},"notes":"what you detected"}\nram_limit: simple=128, express=256, heavy=512. entry_file from scripts.start in package.json.' },
      { role: 'user', content: 'Repo: ' + repo_url + '\n\n' + (packageJsonContent ? 'package.json:\n' + packageJsonContent.slice(0, 3000) : 'package.json: not found') + '\n\n' + (readmeContent ? 'README:\n' + readmeContent : 'README: not found') + '\n\nDetect optimal deployment config.' }
    ], { temperature: 0.2, max_tokens: 500 });

    let config;
    try {
      config = JSON.parse(response.replace(/```json?\n?/gi, '').replace(/```/g, '').trim());
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: response });
    }

    res.json({ success: true, config: config });
  } catch (err) {
    console.error('AI detect-config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/chat
// ---------------------------------------------------------------------------
router.post('/chat', async function(req, res) {
  try {
    const message = req.body.message;
    const context = req.body.context;
    const history = req.body.history;
    if (!message) return res.status(400).json({ error: 'message required' });

    const messages = [
      { role: 'system', content: 'You are an expert DevOps and Node.js deployment assistant inside Speceify.\nHelp users deploy, debug, configure and optimize Node.js apps.\nBe concise, technical, actionable. Use markdown.\n' + (context ? '\nContext:\n' + context : '') }
    ];

    if (history && Array.isArray(history)) {
      history.slice(-6).forEach(function(h) { messages.push({ role: h.role, content: h.content }); });
    }
    messages.push({ role: 'user', content: message });

    const response = await callAI(messages, { temperature: 0.5, max_tokens: 700 });
    res.json({ success: true, reply: response });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/admin-chat
// ---------------------------------------------------------------------------
router.post('/admin-chat', async function(req, res) {
  try {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const message = req.body.message;
    const history = req.body.history;
    if (!message) return res.status(400).json({ error: 'message required' });

    const db = dbHelper;
    const stats = {
      totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      totalApps: db.prepare('SELECT COUNT(*) as c FROM apps').get().c,
      runningApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='running'").get().c,
      stoppedApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='stopped'").get().c,
      errorApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='error'").get().c
    };
    const users = db.prepare('SELECT id, username, email, role, max_apps, max_ram_mb FROM users').all();
    const apps = db.prepare('SELECT a.name, a.status, a.ram_limit_mb, a.port, u.username FROM apps a JOIN users u ON a.user_id = u.id').all();
    const recentLogs = db.prepare("SELECT u.username, dl.action, dl.status FROM deploy_logs dl JOIN users u ON dl.user_id = u.id ORDER BY dl.created_at DESC LIMIT 20").all();

    const serverCtx = 'Stats: ' + JSON.stringify(stats) + ' | Users: ' + users.map(function(u) { return u.username + '(' + u.role + ')'; }).join(', ') + ' | Apps: ' + apps.map(function(a) { return a.name + '[' + a.username + '] ' + a.status; }).join(', ') + ' | Recent: ' + recentLogs.map(function(l) { return l.username + ':' + l.action + ' ' + l.status; }).join(', ');

    const messages = [
      { role: 'system', content: 'You are the admin AI for Speceify deployment panel. Server state:\n' + serverCtx + '\n\nHelp the admin manage users, apps, capacity, security. Be direct and concise. Use markdown.' }
    ];
    if (history && Array.isArray(history)) {
      history.slice(-6).forEach(function(h) { messages.push({ role: h.role, content: h.content }); });
    }
    messages.push({ role: 'user', content: message });

    const response = await callAI(messages, { temperature: 0.4, max_tokens: 800 });
    res.json({ success: true, reply: response });
  } catch (err) {
    console.error('AI admin-chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/suggest-env
// ---------------------------------------------------------------------------
router.post('/suggest-env', async function(req, res) {
  try {
    const app_id = req.body.app_id;
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(app_id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    let packageJsonContent = null;
    let envExampleContent = null;

    const githubMatch = app.repo_url && app.repo_url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (githubMatch) {
      const owner = githubMatch[1];
      const repoName = githubMatch[2].replace(/\.git$/, '');
      try { packageJsonContent = await fetchGitHubFile(owner, repoName, 'package.json'); } catch (e) {}
      try { envExampleContent = await fetchGitHubFile(owner, repoName, '.env.example'); } catch (e) {}
    }

    if (envExampleContent) {
      return res.json({ success: true, env_vars: parseEnvExample(envExampleContent), source: '.env.example from repo' });
    }

    const response = await callAI([
      { role: 'system', content: 'Return ONLY a JSON object mapping env var names to empty strings. Example: {"PORT":"","DATABASE_URL":""}. No markdown, no explanation.' },
      { role: 'user', content: 'App: ' + app.name + '\nRepo: ' + app.repo_url + '\nEntry: ' + app.entry_file + '\n' + (packageJsonContent ? 'package.json:\n' + packageJsonContent.slice(0, 2000) : '') + '\n\nWhat env vars does this app need?' }
    ], { temperature: 0.2, max_tokens: 300 });

    let env_vars = {};
    try { env_vars = JSON.parse(response.replace(/```json?\n?/gi, '').replace(/```/g, '').trim()); } catch (e) {}

    res.json({ success: true, env_vars: env_vars, source: 'AI suggestion' });
  } catch (err) {
    console.error('AI suggest-env error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helper: fetch raw file from GitHub
// ---------------------------------------------------------------------------
function fetchGitHubFile(owner, repo, filename) {
  return new Promise(function(resolve, reject) {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/' + owner + '/' + repo + '/contents/' + filename,
      method: 'GET',
      headers: { 'User-Agent': 'Speceify-Panel/1.0', 'Accept': 'application/vnd.github.v3.raw' }
    };
    if (process.env.GITHUB_TOKEN) options.headers['Authorization'] = 'token ' + process.env.GITHUB_TOKEN;
    const req = https.request(options, function(res) {
      if (res.statusCode === 404) return reject(new Error('Not found'));
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: parse .env.example into key -> "" map
// ---------------------------------------------------------------------------
function parseEnvExample(content) {
  const result = {};
  content.split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) result[line.slice(0, eqIdx).trim()] = '';
  });
  return result;
}

module.exports = router;
