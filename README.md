# ⚡ Speceify - Node.js Deployment Panel

A lightweight, self-hosted Node.js app deployment platform. Deploy apps from Git repos with one click.

## Features

- 🚀 One-click deploy from GitHub/GitLab
- 👥 Multi-user with resource limits
- 📊 Live monitoring (RAM, CPU, uptime)
- ⚙️ Environment variable management
- 📜 Real-time log viewer
- 🔄 Auto-restart on crash/memory overflow
- 🛡️ Admin panel for user management
- 💾 SQLite database (no external dependencies)
- 🔒 Rate limiting & security headers

## Requirements

- Node.js 18+ 
- PM2 (included as dependency)
- Nginx (for reverse proxy)
- 3GB RAM minimum
- 10GB storage minimum

## Quick Install

```bash
# Clone the repo
git clone https://github.com/YOUR_USER/speceify.git
cd speceify

# Install dependencies
npm install

# Copy and edit config
cp .env.example .env
nano .env

# Start the panel
npm start

# Or use PM2 for production
npx pm2 start src/index.js --name speceify
npx pm2 save
npx pm2 startup
```

## Default Admin Login

- **Username:** admin
- **Password:** admin123

⚠️ Change the admin password immediately after first login!

## Server Setup (Ubuntu/Debian)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Nginx
sudo apt install -y nginx

# Install PM2 globally
sudo npm install -g pm2

# Setup Nginx (copy nginx.conf.example to /etc/nginx/sites-available/)
sudo cp nginx.conf.example /etc/nginx/sites-available/speceify
sudo ln -s /etc/nginx/sites-available/speceify /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL with Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d speceify.eu -d www.speceify.eu
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Panel port |
| SESSION_SECRET | (random) | Session encryption key |
| NODE_ENV | production | Environment |

## Architecture

```
speceify/
├── src/
│   ├── index.js          # Express app entry
│   ├── routes/
│   │   ├── auth.js       # Login/register
│   │   ├── apps.js       # App CRUD & deploy
│   │   └── admin.js      # Admin panel
│   ├── middleware/
│   │   └── auth.js       # Auth guards
│   ├── utils/
│   │   ├── database.js   # SQLite setup
│   │   └── deployer.js   # Git clone, PM2 management
│   ├── views/            # EJS templates
│   └── public/           # CSS & JS
├── data/                 # SQLite databases
├── deployments/          # Cloned app files
└── package.json
```

## Resource Limits (per user, configurable by admin)

- Default: 3 apps, 512MB RAM, 1GB storage
- Admin can adjust per-user from the admin panel

## License

MIT
