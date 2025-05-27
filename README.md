# 🚀 Simple GitHub Webhook

A lightweight, zero-dependency GitHub webhook server that triggers deployments using [Just](https://github.com/casey/just). Perfect for simple CI/CD workflows without the complexity of full-featured solutions.

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org/)
[![Just](https://img.shields.io/badge/Just-Required-blue.svg)](https://github.com/casey/just)

## ✨ Features

- **🔐 Secure** - HMAC signature verification for webhook authenticity
- **📊 GitHub Integration** - Sets commit statuses and adds error comments
- **🔄 Smart Deploy Logic** - Only deploys `main`/`master` branches
- **🚫 Double-spawn Protection** - Prevents concurrent deploys on force pushes
- **📁 Symlink Friendly** - Works seamlessly with symlinked repository directories
- **📋 Rich Logging** - Real-time deploy output with rolling buffers
- **📝 Persistent Logs** - Optional deployment log storage and HTTP access
- **⚡ Zero Dependencies** - Pure Node.js with no external packages
- **🛠️ Just Integration** - Uses `just github-deploy {hash}` for deployment commands

## 🏗️ How It Works

1. **Webhook receives GitHub push event** → Validates signature
2. **Checks branch** → Only processes `main`/`master` branches  
3. **Prevents double-spawning** → Guards against concurrent deploys
4. **Verifies repository** → Ensures `repos/{repo_name}` directory exists
5. **Sets GitHub status** → Marks deploy as "pending"
6. **Runs deployment** → Executes `just github-deploy {git_hash}` in repo directory
7. **Reports results** → Updates GitHub status and adds comments on failure

## 📦 Installation

### Prerequisites

- **Node.js 18+** 
- **[Just](https://github.com/casey/just)** - Command runner
- **Git repositories** with `justfile` containing `github-deploy` recipe

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-username/simple-github-webhook.git
cd simple-github-webhook

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Create repository symlinks
mkdir repos
ln -s /path/to/your/actual/repo repos/your-repo-name

# Setup and start
just setup
just start-daemon
```

## ⚙️ Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Server Configuration
PORT=3000

# GitHub Webhook Security (required for production)
WEBHOOK_SECRET=your_webhook_secret_here

# GitHub API Access (optional but recommended)
GITHUB_TOKEN=ghp_your_github_token_here

# Deployment Logging (optional)
LOG_DIR=/path/to/logs  # Store and serve deployment logs
```

### GitHub Webhook Setup

1. **Generate webhook secret**: `openssl rand -hex 32`
2. **Create GitHub Personal Access Token** with `repo:status` permission
3. **Add webhook to your repository**:
   - URL: `https://your-domain.com/webhook`
   - Content type: `application/json`
   - Secret: Your generated webhook secret
   - Events: `push`

### Repository Structure

```
your-webhook-server/
├── github-webhook.js           # Main webhook server
├── justfile            # Server management commands
├── .env                # Your configuration
├── repos/              # Repository symlinks
│   ├── repo1 -> /path/to/actual/repo1
│   ├── repo2 -> /path/to/actual/repo2
│   └── ...
└── logs/               # Server logs
    └── webhook.log     # Server logs
```

### Deployment Logs

When `LOG_DIR` is configured:

- Deployment logs are stored in `{LOG_DIR}/{reponame}/{githash}.txt`
- Logs are available via HTTP at `/{reponame}/{githash}.txt`
- Logs are created and updated in real-time during deployment
- 404 responses for non-existent logs

### Repository Requirements

Each repository must have a `justfile` with a `github-deploy` recipe:

```just
set dotenv-load

# Example justfile in your repository
github-deploy hash:
    @echo "Deploying {{hash}}..."
    git fetch origin {{hash}}
    git checkout FETCH_HEAD
    npm ci
    npm run build
    systemctl reload your-app
    @echo "Deploy complete!"
```

## 🚀 Usage

### Server Management

```bash
# Start in foreground (development)
just start

# Start in background (production)
just start-daemon

# Check status
just status

# View logs
just logs
just logs-follow

# Stop server
just stop

# Restart server
just restart
```

### Development

```bash
# Development mode with auto-restart
just dev

# Test webhook endpoint
just test

# View configuration
just config

# Setup development environment
just setup
```

## 🔧 Advanced Configuration

### Custom Repository Base Directory

```bash
# In .env
REPO_BASE_DIR=/var/deployments/repos
```

### Webhook Security

The webhook supports HMAC-SHA256 signature verification:

- **With secret**: Validates `X-Hub-Signature-256` header
- **Without secret**: Accepts all requests (not recommended for production)

### GitHub Integration Features

When `GITHUB_TOKEN` is configured:

- ✅ **Commit statuses**: `pending` → `success`/`failure`/`error`
- 💬 **Error comments**: Automatic comments with deploy failure details
- 📊 **Deploy context**: All statuses use `github-deploy` context

## 🛡️ Security Best Practices

1. **Always use HTTPS** in production
2. **Set a strong webhook secret** (32+ random characters)
3. **Limit GitHub token permissions** to `repo:status` only
4. **Run behind a reverse proxy** (nginx, Cloudflare, etc.)
5. **Regularly rotate secrets and tokens**
6. **Monitor logs** for suspicious activity

## 🐛 Troubleshooting

### Common Issues

**Webhook not triggering deploys:**
```bash
# Check server status
just status

# View recent logs
just logs

# Test endpoint
just test
```

**Repository directory not found:**
```bash
# Verify symlink exists and points to valid directory
ls -la repos/
readlink repos/your-repo-name
```

**GitHub status updates not working:**
```bash
# Check token permissions and validity
just config
```

**Deploy command failing:**
```bash
# Test deploy command manually
cd repos/your-repo-name
just github-deploy main
```

### Debug Mode

Enable verbose logging by modifying `webhook.js` temporarily:

```javascript
// Add at the top of webhook.js for debugging
const DEBUG = true;
if (DEBUG) console.log('Debug:', ...args);
```

## 📝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup

```bash
git clone https://github.com/your-username/simple-github-webhook.git
cd simple-github-webhook
cp .env.example .env
just setup
just dev
```

### Guidelines

- Keep it simple - this is meant to be the "world's simplest" webhook
- No external dependencies - vanilla Node.js only
- Add tests for new features
- Update documentation

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Inspired by the need for simple, reliable GitHub webhooks
- Built with ❤️ for the developer community
- Thanks to the [Just](https://github.com/casey/just) project for the excellent command runner

