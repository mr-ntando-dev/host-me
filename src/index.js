require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const path = require('path');
const { initDatabase, dbHelper } = require('./utils/database');

async function start() {
  const fs = require('fs');
  // Ensure data/sessions directory exists
  const sessionsDir = path.join(__dirname, '..', 'data', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Initialize database first
  await initDatabase();

  const authRoutes = require('./routes/auth');
  const appRoutes = require('./routes/apps');
  const adminRoutes = require('./routes/admin');
  const { isAuthenticated } = require('./middleware/auth');

  const app = express();
  const PORT = process.env.SERVER_PORT || process.env.PORT || 25535;

  // Security
  app.use(helmet({ contentSecurityPolicy: false }));

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // View engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Sessions
  app.use(session({
    store: new FileStore({
      path: path.join(__dirname, '..', 'data', 'sessions'),
      ttl: 7 * 24 * 60 * 60,
      retries: 0
    }),
    secret: process.env.SESSION_SECRET || 'speceify-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));

  // Make user available to all views
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });

  // Routes
  app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('landing');
  });

  app.use('/auth', authRoutes);
  app.use('/apps', isAuthenticated, appRoutes);
  app.use('/admin', isAuthenticated, adminRoutes);

  app.get('/dashboard', isAuthenticated, (req, res) => {
    const db = dbHelper;
    const apps = db.prepare('SELECT * FROM apps WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    res.render('dashboard', { apps, user });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', { message: 'Something went wrong' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚡ Speceify panel running on port ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
