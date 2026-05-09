const express = require('express');
const https = require('https');
const { dbHelper } = require('../utils/database');
const Deployer = require('../utils/deployer');
const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper: call OpenAI chat completions
async function callOpenAI(messages, { temperature = 0.4, max_tokens = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST /ai/analyze-logs — analyze app logs and deploy history
router.post('/analyze-logs', async (req, res) => {
  try {
    const { app_id } = req.body;
    const db = dbHelper;

    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
      .get(app_id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    // Get PM2 logs
    let pm2Logs = '';
    try {
      pm2Logs = Deployer.getAppLogs(app);
    } catch (e) {
      pm2Logs = 'Logs unavailable';
    }

    // Get deploy history
    const history = db.prepare('SELECT * FROM deploy_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 10').all(app.id);
    const historyText = history.map(h => `[${h.created_at}] ${h.action} (${h.status}): ${h.output}`).join('\n');

    // Get runtime info
    const info = Deployer.getAppInfo(app);
    const runtimeText = info
      ? `Status: ${info.status}, Memory: ${info.memory}MB/${app.ram_limit_mb}MB, CPU: ${info.cpu}%, Restarts: ${info.restarts}`
      : 'Runtime info unavailable';

    const response = await callOpenAI([
      {
        role: 'system',
        content: `You are an expert Node.js DevOps engineer and deployment assistant for the Speceify hosting panel.
Analyze the provided app information and give a concise, actionable diagnosis.
Format your response with clear sections using markdown. Be specific - reference actual error messages or metrics.
Keep it under 400 words. Be direct.`
      },
      {
        role: 'user',
        content: `App: ${app.name}
Repo: ${app.repo_url} (branch: ${app.branch})
Entry file: ${app.entry_file}
RAM limit: ${app.ram_limit_mb}MB
Auto-restart: ${app.auto_restart ? 'yes' : 'no'}

Runtime: ${runtimeText}

Recent PM2 logs:
${pm2Logs.slice(-3000) || 'None available'}

Deploy history:
${historyText || 'No history'}

Analyze this app's health. Identify any errors, warn about resource usage, and provide specific next steps if there are issues.`
      }
    ], { max_tokens: 600 });

    res.json({ success: true, analysis: response });
  } catch (err) {
    console.error('AI analyze-logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/detect-config — auto-detect app config from repo URL
router.post('/detect-config', async (req, res) => {
  try {
    const { repo_url } = req.body;
    if (!repo_url) return res.status(400).json({ error: 'repo_url required' });

    // Try to fetch package.json from GitHub
    let packageJsonContent = null;
    let readmeContent = null;

    const githubMatch = repo_url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (githubMatch) {
      const [, owner, repoRaw] = githubMatch;
      const repo = repoRaw.replace(/\.git$/, '');

      // Fetch package.json
      try {
        packageJsonContent = await fetchGitHubFile(owner, repo, 'package.json');
      } catch (e) { }

      // Fetch README
      try {
        readmeContent = await fetchGitHubFile(owner, repo, 'README.md');
        if (readmeContent) readmeContent = readmeContent.slice(0, 2000);
      } catch (e) { }
    }

    const response = await callOpenAI([
      {
        role: 'system',
        content: `You are a Node.js deployment configuration expert for the Speceify hosting panel.
Analyze the provided repository information and return ONLY a valid JSON object — no markdown, no explanation.
The JSON must have exactly these fields:
{
  "name": "suggested-app-name (lowercase, hyphens, max 30 chars)",
  "branch": "main",
  "entry_file": "index.js",
  "ram_limit": 256,
  "env_vars": {},
  "notes": "brief explanation of what you detected"
}
For ram_limit: simple apps=128, express API=256, heavy apps=512.
For env_vars: include keys the app likely needs (leave values empty string "").
For entry_file: check scripts.start in package.json first.`
      },
      {
        role: 'user',
        content: `Repository URL: ${repo_url}

${packageJsonContent ? `package.json:\n${packageJsonContent.slice(0, 3000)}` : 'package.json: not found'}

${readmeContent ? `README (first 2000 chars):\n${readmeContent}` : 'README: not found'}

Detect the optimal deployment configuration for this Node.js app.`
      }
    ], { temperature: 0.2, max_tokens: 500 });

    // Parse JSON from response
    let config;
    try {
      // Strip markdown code blocks if present
      const clean = response.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
      config = JSON.parse(clean);
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: response });
    }

    res.json({ success: true, config });
  } catch (err) {
    console.error('AI detect-config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/chat — general app assistant chat
router.post('/chat', async (req, res) => {
  try {
    const { message, context, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const messages = [
      {
        role: 'system',
        content: `You are an expert DevOps and Node.js deployment assistant embedded inside Speceify, a self-hosted Node.js deployment panel.
You help users deploy, debug, configure, and optimize their Node.js applications.
Be concise, technical, and actionable. Use markdown formatting.
${context ? `\nCurrent context:\n${context}` : ''}`
      }
    ];

    // Add conversation history (last 6 messages)
    if (history && Array.isArray(history)) {
      const recent = history.slice(-6);
      recent.forEach(h => messages.push({ role: h.role, content: h.content }));
    }

    messages.push({ role: 'user', content: message });

    const response = await callOpenAI(messages, { temperature: 0.5, max_tokens: 700 });
    res.json({ success: true, reply: response });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/admin-chat — admin assistant with full server context
router.post('/admin-chat', async (req, res) => {
  try {
    if (!req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const db = dbHelper;
    const stats = {
      totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      totalApps: db.prepare('SELECT COUNT(*) as c FROM apps').get().c,
      runningApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='running'").get().c,
      stoppedApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='stopped'").get().c,
      errorApps: db.prepare("SELECT COUNT(*) as c FROM apps WHERE status='error'").get().c,
    };

    const users = db.prepare('SELECT id, username, email, role, max_apps, max_ram_mb, created_at FROM users').all();
    const apps = db.prepare('SELECT a.name, a.status, a.ram_limit_mb, a.port, u.username FROM apps a JOIN users u ON a.user_id = u.id').all();
    const recentLogs = db.prepare("SELECT u.username, dl.action, dl.status, dl.output, dl.created_at FROM deploy_logs dl JOIN users u ON dl.user_id = u.id ORDER BY dl.created_at DESC LIMIT 20").all();

    const serverContext = `
Server Stats: ${JSON.stringify(stats)}
Users (${users.length}): ${users.map(u => `${u.username}(${u.role}, ${u.max_apps} apps, ${u.max_ram_mb}MB RAM)`).join(', ')}
Apps (${apps.length}): ${apps.map(a => `${a.name}[${a.username}] ${a.status} port:${a.port} ${a.ram_limit_mb}MB`).join(', ')}
Recent activity: ${recentLogs.map(l => `${l.username}: ${l.action} ${l.status}`).join(', ')}
`;

    const messages = [
      {
        role: 'system',
        content: `You are an intelligent server administrator AI for the Speceify deployment panel.
You have full context of the server state. Help the admin with:
- User and resource management decisions
- Identifying problematic apps or users  
- Capacity planning recommendations
- Security and operational best practices
Be direct, technical, and concise. Use markdown. Reference specific users/apps from context when relevant.

Current server state:
${serverContext}`
      }
    ];

    if (history && Array.isArray(history)) {
      history.slice(-6).forEach(h => messages.push({ role: h.role, content: h.content }));
    }

    messages.push({ role: 'user', content: message });

    const response = await callOpenAI(messages, { temperature: 0.4, max_tokens: 800 });
    res.json({ success: true, reply: response });
  } catch (err) {
    console.error('AI admin-chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/suggest-env — suggest env vars for an app
router.post('/suggest-env', async (req, res) => {
  try {
    const { app_id } = req.body;
    const db = dbHelper;
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?')
      .get(app_id, req.session.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    let packageJsonContent = null;
    const githubMatch = app.repo_url && app.repo_url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (githubMatch) {
      const [, owner, repoRaw] = githubMatch;
      const repo = repoRaw.replace(/\.git$/, '');
      try {
        packageJsonContent = await fetchGitHubFile(owner, repo, 'package.json');
      } catch (e) { }
      // Also check .env.example
      try {
        const envExample = await fetchGitHubFile(owner, repo, '.env.example');
        if (envExample) {
          return res.json({
            success: true,
            suggestions: parseEnvExample(envExample),
            source: '.env.example from repo'
          });
        }
      } catch (e) { }
    }

    const response = await callOpenAI([
      {
        role: 'system',
        content: `You are a Node.js environment variable expert. Return ONLY a valid JSON object mapping env var names to empty strings.
Example: {"DATABASE_URL": "", "JWT_SECRET": "", "PORT": "3000"}
No explanation, no markdown, just the JSON object.`
      },
      {
        role: 'user',
        content: `App: ${app.name}
Repo: ${app.repo_url}
Entry: ${app.entry_file}
${packageJsonContent ? `package.json: ${packageJsonContent.slice(0, 2000)}` : ''}

What environment variables does this app likely need? Return JSON object with keys and empty string values.`
      }
    ], { temperature: 0.2, max_tokens: 300 });

    let suggestions = {};
    try {
      const clean = response.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch (e) {
      suggestions = {};
    }

    res.json({ success: true, suggestions, source: 'AI suggestion' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: fetch a file from GitHub
function fetchGitHubFile(owner, repo, filename) {
  return new Promise((resolve, reject) => {
    const path = `/repos/${owner}/${repo}/contents/${filename}`;
    const options = {
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Speceify-Panel/1.0',
        'Accept': 'application/vnd.github.v3.raw'
      }
    };

    if (process.env.GITHUB_TOKEN) {
      options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    const req = https.request(options, (res) => {
      if (res.statusCode === 404) return reject(new Error('Not found'));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper: parse .env.example file
function parseEnvExample(content) {
  const result = {};
  content.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx).trim();
      result[key] = '';
    }
  });
  return result;
}

module.exports = router;
