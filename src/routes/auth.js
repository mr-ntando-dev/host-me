const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { dbHelper } = require('../utils/database');
const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.'
});

// Login page
router.get('/login', (req, res) => {
  res.render('auth/login', { error: null });
});

// Login handler
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const db = dbHelper;

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('auth/login', { error: 'Invalid credentials' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role
  };

  res.redirect('/dashboard');
});

// Register page
router.get('/register', (req, res) => {
  res.render('auth/register', { error: null });
});

// Register handler
router.post('/register', (req, res) => {
  const { username, email, password, confirm_password } = req.body;
  const db = dbHelper;

  if (password !== confirm_password) {
    return res.render('auth/register', { error: 'Passwords do not match' });
  }

  if (username.length < 3 || username.length > 20) {
    return res.render('auth/register', { error: 'Username must be 3-20 characters' });
  }

  if (password.length < 6) {
    return res.render('auth/register', { error: 'Password must be at least 6 characters' });
  }

  // Check if user exists
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.render('auth/register', { error: 'Username or email already taken' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hashedPassword);

  req.session.user = {
    id: result.lastInsertRowid,
    username,
    email,
    role: 'user'
  };

  res.redirect('/dashboard');
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
