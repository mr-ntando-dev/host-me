const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'speceify.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db;

async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      max_apps INTEGER DEFAULT 3,
      max_ram_mb INTEGER DEFAULT 512,
      max_storage_mb INTEGER DEFAULT 1024,
      git_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      repo_url TEXT,
      branch TEXT DEFAULT 'main',
      port INTEGER,
      status TEXT DEFAULT 'stopped',
      pm2_name TEXT,
      entry_file TEXT DEFAULT 'index.js',
      env_vars TEXT DEFAULT '{}',
      domain TEXT,
      auto_restart INTEGER DEFAULT 1,
      ram_limit_mb INTEGER DEFAULT 256,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS deploy_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      output TEXT,
      status TEXT DEFAULT 'success',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (app_id) REFERENCES apps(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Create default admin
  const adminExists = db.exec("SELECT id FROM users WHERE role = 'admin'");
  if (!adminExists.length || !adminExists[0].values.length) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT INTO users (username, email, password, role, max_apps, max_ram_mb, max_storage_mb) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['admin', 'admin@speceify.eu', hashedPassword, 'admin', 100, 3072, 10240]);
    console.log('✅ Default admin created: admin / admin123');
  }

  saveDatabase();
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// Auto-save every 30 seconds
setInterval(saveDatabase, 30000);

// Helper methods to match better-sqlite3 API style
const dbHelper = {
  prepare(sql) {
    return {
      get(...params) {
        const result = db.exec(sql, params);
        if (!result.length || !result[0].values.length) return undefined;
        const columns = result[0].columns;
        const values = result[0].values[0];
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        return row;
      },
      all(...params) {
        const result = db.exec(sql, params);
        if (!result.length) return [];
        const columns = result[0].columns;
        return result[0].values.map(values => {
          const row = {};
          columns.forEach((col, i) => { row[col] = values[i]; });
          return row;
        });
      },
      run(...params) {
        db.run(sql, params);
        saveDatabase();
        return {
          lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0].values[0][0],
          changes: db.getRowsModified()
        };
      }
    };
  },
  exec(sql) {
    db.run(sql);
    saveDatabase();
  }
};

module.exports = { initDatabase, dbHelper, saveDatabase };
