#!/bin/bash
# Speceify - Quick Install Script for Ubuntu/Debian
# Run: curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/speceify/main/install.sh | bash

set -e

echo "⚡ Installing Speceify - Node.js Deployment Panel"
echo "================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "✅ Node.js $(node -v)"

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    sudo npm install -g pm2
fi

# Install Nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "📦 Installing Nginx..."
    sudo apt install -y nginx
fi

# Setup application
APP_DIR="/opt/speceify"
echo "📂 Setting up in $APP_DIR"

if [ -d "$APP_DIR" ]; then
    echo "⚠️  Directory exists. Updating..."
    cd $APP_DIR && git pull
else
    echo "Cloning repository..."
    sudo mkdir -p $APP_DIR
    sudo chown $USER:$USER $APP_DIR
    git clone https://github.com/YOUR_USER/speceify.git $APP_DIR
fi

cd $APP_DIR

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production

# Create data directories
mkdir -p data/sessions

# Setup environment
if [ ! -f .env ]; then
    SECRET=$(openssl rand -hex 32)
    cat > .env << EOF
PORT=3000
SESSION_SECRET=$SECRET
NODE_ENV=production
EOF
    echo "✅ Created .env with random session secret"
fi

# Start with PM2
echo "🚀 Starting Speceify..."
pm2 delete speceify 2>/dev/null || true
pm2 start src/index.js --name speceify
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

echo ""
echo "================================================="
echo "⚡ Speceify is running!"
echo "🌐 http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "Default login: admin / admin123"
echo "⚠️  CHANGE THE ADMIN PASSWORD IMMEDIATELY!"
echo ""
echo "Next steps:"
echo "  1. Setup Nginx reverse proxy (see nginx.conf.example)"
echo "  2. Get SSL: sudo certbot --nginx -d yourdomain.com"
echo "  3. Login and change admin password"
echo "  4. Add your Git token in dashboard settings"
echo "================================================="
