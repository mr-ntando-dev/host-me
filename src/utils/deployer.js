const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const { dbHelper, saveDatabase } = require('./database');

const APPS_DIR = path.join(__dirname, '..', '..', 'deployments');

// Ensure deployments directory exists
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

class Deployer {
  static getAppDir(userId, appName) {
    return path.join(APPS_DIR, `user_${userId}`, appName);
  }

  static async cloneRepo(app, gitToken) {
    const appDir = this.getAppDir(app.user_id, app.name);

    // Clean existing directory
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
    fs.mkdirSync(appDir, { recursive: true });

    // Inject token into URL for private repos
    let repoUrl = app.repo_url;
    if (gitToken && repoUrl.includes('github.com')) {
      repoUrl = repoUrl.replace('https://', `https://${gitToken}@`);
    } else if (gitToken && repoUrl.includes('gitlab.com')) {
      repoUrl = repoUrl.replace('https://', `https://oauth2:${gitToken}@`);
    }

    const git = simpleGit();
    await git.clone(repoUrl, appDir, ['--branch', app.branch || 'main', '--depth', '1']);

    return appDir;
  }

  static installDependencies(appDir) {
    const packageJson = path.join(appDir, 'package.json');
    if (fs.existsSync(packageJson)) {
      execSync('npm install --production', { cwd: appDir, timeout: 120000 });
      return true;
    }
    return false;
  }

  static async startApp(app) {
    const appDir = this.getAppDir(app.user_id, app.name);
    const pm2Name = `speceify_${app.user_id}_${app.name}`;
    const entryFile = path.join(appDir, app.entry_file || 'index.js');

    if (!fs.existsSync(entryFile)) {
      throw new Error(`Entry file not found: ${app.entry_file}`);
    }

    // Parse env vars
    let envVars = {};
    try {
      envVars = JSON.parse(app.env_vars || '{}');
    } catch (e) {
      envVars = {};
    }

    // Add PORT to env
    envVars.PORT = String(app.port);

    // Write .env file so apps using dotenv can read it
    const envFileContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(path.join(appDir, '.env'), envFileContent);

    // Build PM2 ecosystem config
    const ecosystem = {
      name: pm2Name,
      script: entryFile,
      cwd: appDir,
      env: envVars,
      max_memory_restart: `${app.ram_limit_mb || 256}M`,
      autorestart: app.auto_restart === 1,
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    };

    // Write ecosystem file
    const ecoPath = path.join(appDir, 'ecosystem.config.js');
    fs.writeFileSync(ecoPath, `module.exports = { apps: [${JSON.stringify(ecosystem)}] };`);

    // Start with PM2
    try {
      execSync(`npx pm2 delete ${pm2Name} 2>/dev/null || true`, { cwd: appDir });
    } catch (e) { }

    execSync(`npx pm2 start ecosystem.config.js`, { cwd: appDir, timeout: 30000 });

    // Update database
    dbHelper.prepare('UPDATE apps SET status = ?, pm2_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('running', pm2Name, app.id);

    return pm2Name;
  }

  static stopApp(app) {
    const pm2Name = app.pm2_name || `speceify_${app.user_id}_${app.name}`;
    try {
      execSync(`npx pm2 stop ${pm2Name}`, { timeout: 10000 });
    } catch (e) { }

    dbHelper.prepare('UPDATE apps SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('stopped', app.id);
  }

  static restartApp(app) {
    const pm2Name = app.pm2_name || `speceify_${app.user_id}_${app.name}`;
    try {
      execSync(`npx pm2 restart ${pm2Name}`, { timeout: 10000 });
    } catch (e) {
      throw new Error('Failed to restart app');
    }

    dbHelper.prepare('UPDATE apps SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('running', app.id);
  }

  static deleteApp(app) {
    const pm2Name = app.pm2_name || `speceify_${app.user_id}_${app.name}`;
    const appDir = this.getAppDir(app.user_id, app.name);

    // Stop and delete from PM2
    try {
      execSync(`npx pm2 delete ${pm2Name} 2>/dev/null || true`, { timeout: 10000 });
    } catch (e) { }

    // Remove files
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    // Remove from database
    dbHelper.prepare('DELETE FROM deploy_logs WHERE app_id = ?').run(app.id);
    dbHelper.prepare('DELETE FROM apps WHERE id = ?').run(app.id);
  }

  static getLogs(app, lines = 100) {
    const pm2Name = app.pm2_name || `speceify_${app.user_id}_${app.name}`;
    try {
      const output = execSync(`npx pm2 logs ${pm2Name} --nostream --lines ${lines} 2>&1`, {
        timeout: 10000,
        encoding: 'utf8'
      });
      return output;
    } catch (e) {
      return 'No logs available';
    }
  }

  static getAppInfo(app) {
    const pm2Name = app.pm2_name || `speceify_${app.user_id}_${app.name}`;
    try {
      const output = execSync(`npx pm2 jlist 2>/dev/null`, { timeout: 10000, encoding: 'utf8' });
      const processes = JSON.parse(output);
      const proc = processes.find(p => p.name === pm2Name);
      if (proc) {
        return {
          status: proc.pm2_env.status,
          memory: Math.round((proc.monit?.memory || 0) / 1024 / 1024),
          cpu: proc.monit?.cpu || 0,
          uptime: proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0,
          restarts: proc.pm2_env.restart_time || 0
        };
      }
    } catch (e) { }
    return null;
  }

  static getNextPort() {
    const lastApp = dbHelper.prepare('SELECT port FROM apps ORDER BY port DESC LIMIT 1').get();
    return lastApp ? lastApp.port + 1 : 4000;
  }

  static getUserStorageUsage(userId) {
    const userDir = path.join(APPS_DIR, `user_${userId}`);
    if (!fs.existsSync(userDir)) return 0;
    try {
      const output = execSync(`du -sm "${userDir}" 2>/dev/null`, { encoding: 'utf8' });
      return parseInt(output.split('\t')[0]) || 0;
    } catch (e) {
      return 0;
    }
  }
}

module.exports = Deployer;
