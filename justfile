set dotenv-load

# Default recipe that shows available commands
default:
    @just --list

# Start the webhook server in the foreground
start:
    @echo "🚀 Starting GitHub webhook server in foreground..."
    @echo "   Port: ${PORT:-3000}"
    @echo "   Press Ctrl+C to stop"
    @echo ""
    node github-webhook.js

# Start the webhook server in the background with logging
start-daemon:
    @echo "🚀 Starting GitHub webhook server in background..."
    @echo "   Port: ${PORT:-3000}"
    @echo "   Logs: webhook.log"
    @echo "   PID file: webhook.pid"
    @mkdir -p logs
    nohup node github-webhook.js > logs/webhook.log 2>&1 & echo $! > webhook.pid
    @echo "✅ Webhook server started with PID: $(cat webhook.pid)"
    @echo "   View logs: just logs"
    @echo "   Stop server: just stop"

# Stop the background webhook server
stop:
    @if [ -f webhook.pid ]; then \
        PID=$(cat webhook.pid); \
        echo "🛑 Stopping webhook server (PID: $PID)..."; \
        kill $PID && rm webhook.pid && echo "✅ Server stopped"; \
    else \
        echo "❌ No PID file found. Server may not be running."; \
    fi

# Restart the background webhook server
restart: stop start-daemon

# Show the status of the webhook server
status:
    @if [ -f webhook.pid ]; then \
        PID=$(cat webhook.pid); \
        if kill -0 $PID 2>/dev/null; then \
            echo "✅ Webhook server is running (PID: $PID)"; \
            echo "   Port: ${PORT:-3000}"; \
            echo "   Uptime: $(ps -o etime= -p $PID | tr -d ' ')"; \
        else \
            echo "❌ PID file exists but process is not running"; \
            rm webhook.pid; \
        fi; \
    else \
        echo "❌ Webhook server is not running"; \
    fi

# Show recent logs
logs:
    @if [ -f logs/webhook.log ]; then \
        echo "📋 Recent webhook logs:"; \
        echo "=========================================="; \
        tail -n 50 logs/webhook.log; \
    else \
        echo "❌ No log file found"; \
    fi

# Follow logs in real-time
logs-follow:
    @if [ -f logs/webhook.log ]; then \
        echo "📋 Following webhook logs (Ctrl+C to stop):"; \
        echo "============================================"; \
        tail -f logs/webhook.log; \
    else \
        echo "❌ No log file found"; \
    fi

# Clear all logs
logs-clear:
    @echo "🗑️  Clearing webhook logs..."
    @if [ -f logs/webhook.log ]; then \
        > logs/webhook.log && echo "✅ Logs cleared"; \
    else \
        echo "ℹ️  No logs to clear"; \
    fi

# Show environment configuration
config:
    @echo "⚙️  Webhook Configuration:"
    @echo "=========================="
    @echo "Port: ${PORT:-3000 (default)}"
    @echo "Webhook Secret: $${WEBHOOK_SECRET:+***SET***}$${WEBHOOK_SECRET:-❌ NOT SET}"
    @echo "GitHub Token: $${GITHUB_TOKEN:+***SET***}$${GITHUB_TOKEN:-❌ NOT SET}"
    @echo "Node.js Version: $(node --version)"
    @echo ""
    @echo "📁 Repository Directory Structure:"
    @if [ -d repos ]; then \
        echo "   repos/"; \
        find repos -maxdepth 1 -type l -exec basename {} \; 2>/dev/null | sed 's/^/   ├── /' || echo "   └── (no symlinks found)"; \
    else \
        echo "   ❌ repos/ directory not found"; \
    fi

# Test the webhook endpoint
test:
    @echo "🧪 Testing webhook endpoint..."
    @echo "Sending test request to http://localhost:${PORT:-3000}"
    @curl -s -X POST http://localhost:${PORT:-3000} \
        -H "Content-Type: application/json" \
        -d '{"test": true}' && echo "" && echo "✅ Webhook is responding" || echo "❌ Webhook is not responding"

# Setup the webhook server (create directories, check dependencies)
setup:
    @echo "🔧 Setting up GitHub webhook server..."
    @echo ""
    @echo "📁 Creating directories..."
    @mkdir -p repos logs
    @echo "✅ Created repos/ and logs/ directories"
    @echo ""
    @echo "🔍 Checking dependencies..."
    @node --version > /dev/null && echo "✅ Node.js is installed" || (echo "❌ Node.js not found" && exit 1)
    @echo ""
    @echo "📋 Checking configuration..."
    @if [ ! -f .env ]; then \
        echo "⚠️  .env file not found"; \
        if [ -f .env.example ]; then \
            echo "   Copy .env.example to .env and configure your settings"; \
        fi; \
    else \
        echo "✅ .env file found"; \
    fi
    @echo ""
    @echo "✅ Setup complete! Next steps:"
    @echo "   1. Configure .env file if not already done"
    @echo "   2. Create repository symlinks: ln -s /path/to/repo repos/repo-name"
    @echo "   3. Start the server: just start-daemon"

# Development mode with auto-restart (requires nodemon)
dev:
    @echo "🔧 Starting webhook server in development mode..."
    @echo "   Auto-restart on file changes"
    @echo "   Press Ctrl+C to stop"
    @if command -v nodemon >/dev/null 2>&1; then \
        nodemon github-webhook.js; \
    else \
        echo "❌ nodemon not found. Install with: npm install -g nodemon"; \
        echo "   Falling back to normal start..."; \
        just start; \
    fi

# Show webhook server information
info:
    @echo "ℹ️  GitHub Webhook Server"
    @echo "========================"
    @echo "Script: github-webhook.js"
    @echo "Description: Lightweight GitHub webhook for triggering deploys"
    @echo ""
    @echo "📚 Available Commands:"
    @just --list
    @echo ""
    @echo "🔗 Useful Links:"
    @echo "   GitHub Webhooks: https://docs.github.com/en/webhooks"
    @echo "   Personal Access Tokens: https://github.com/settings/tokens"
