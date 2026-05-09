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

// Auto-save every 30 seconds.
// unref() prevents this timer from keeping the process alive in scripts/tests.
setInterval(saveDatabase, 30000).unref();

// Helper methods to match better-sqlite3 API style
const dbHelper = {
  prepare(sql) {
    return {
      get(...params) {
        // sql.js uses $1, $2 style or ? placeholders
        // Convert params to numbers where appropriate
        const cleanParams = params.map(p => {
          if (typeof p === 'string' && /^\d+$/.test(p)) return parseInt(p);
          return p;
        });
        try {
          const stmt = db.prepare(sql);
          stmt.bind(cleanParams);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        } catch (e) {
          console.error('DB get error:', e.message, sql, cleanParams);
          return undefined;
        }
      },
      all(...params) {
        const cleanParams = params.map(p => {
          if (typeof p === 'string' && /^\d+$/.test(p)) return parseInt(p);
          return p;
        });
        try {
          const results = [];
          const stmt = db.prepare(sql);
          stmt.bind(cleanParams);
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        } catch (e) {
          console.error('DB all error:', e.message, sql, cleanParams);
          return [];
        }
      },
      run(...params) {
        const cleanParams = params.map(p => {
          if (typeof p === 'string' && /^\d+$/.test(p)) return parseInt(p);
          return p;
        });
        try {
          db.run(sql, cleanParams);
          // IMPORTANT: read last_insert_rowid and getRowsModified BEFORE
          // calling saveDatabase() — db.export() inside saveDatabase resets
          // both values to 0.
          const lastId = db.exec("SELECT last_insert_rowid()");
          const rowsModified = db.getRowsModified();
          saveDatabase();
          return {
            lastInsertRowid: lastId.length ? lastId[0].values[0][0] : 0,
            changes: rowsModified
          };
        } catch (e) {
          console.error('DB run error:', e.message, sql, cleanParams);
          saveDatabase();
          return { lastInsertRowid: 0, changes: 0 };
        }
      }
    };
  },
  exec(sql) {
    db.run(sql);
    saveDatabase();
  }
};

module.exports = { initDatabase, dbHelper, saveDatabase };
