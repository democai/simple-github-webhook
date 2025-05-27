// github-webhook.js
// "Simplest GitHub webhook" – vanilla Node, no frameworks

// --- Module imports ---
const http   = require('http');           // HTTP server
const https  = require('https');          // For GitHub API calls
const crypto = require('crypto');         // For HMAC signature verification
const fs     = require('fs');             // For filesystem access
const { spawn } = require('child_process'); // For running shell commands
const path   = require('path');           // For path manipulation

// --- Configuration ---
const PORT   = process.env.PORT || 3000;           // Port to listen on
const SECRET = process.env.WEBHOOK_SECRET || '';   // HMAC secret for signature verification
const TOKEN  = process.env.GITHUB_TOKEN;           // GitHub token for status/comments
const LOG_DIR = process.env.LOG_DIR;               // Directory for deployment logs

// Track running deploys to prevent concurrent deploys for the same repo/branch
const runningDeploys = new Set();

// ---------- helpers ----------------------------------------------------------

// Verify the GitHub webhook signature (if SECRET is set)
function verify(sigHeader, raw) {
  if (!SECRET) return true;                        // If no secret, skip verification
  if (!sigHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

// Make a call to the GitHub API (if TOKEN is set)
function callGitHub(method, path, body = {}) {
  return new Promise(res => {
    if (!TOKEN) return res();
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'worlds-simplest-webhook',
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, r => {
      r.on('data', () => {}); // Ignore response body
      r.on('end', res);
    });
    req.on('error', err => {
      console.error('GitHub API error:', err.message);
      res();
    });
    req.write(data);
    req.end();
  });
}

// Set the commit status on GitHub (pending, success, failure, error)
async function setStatus(repo, sha, state, desc) {
  if (!repo || !sha) return;
  await callGitHub(
    'POST',
    `/repos/${repo}/statuses/${sha}`,
    { state, description: desc.slice(0, 140), context: 'github-deploy' }
  );
}

// Add a comment to a commit on GitHub
async function addComment(repo, sha, body) {
  if (!repo || !sha) return;
  await callGitHub(
    'POST',
    `/repos/${repo}/commits/${sha}/comments`,
    { body: body.slice(0, 65536) }
  );
}

// Run a git command in a given directory, capturing output
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const gitProc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    gitProc.stdout.on('data', d => output += d.toString());
    gitProc.stderr.on('data', d => output += d.toString());
    gitProc.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
    gitProc.on('error', reject);
  });
}

// Report an error: log, set GitHub status, and optionally add a comment
async function reportErrorAndCleanup({repo, sha, errorMsg, commentBody, deployKey}) {
  if (deployKey) runningDeploys.delete(deployKey);
  console.error(errorMsg);
  await setStatus(repo, sha, 'error', errorMsg);
  if (commentBody) {
    await addComment(repo, sha, commentBody);
  }
}

// Ensure only one deploy runs per repo/branch at a time
function withDeployLock(deployKey, fn) {
  if (runningDeploys.has(deployKey)) {
    console.log(`Deploy already running for ${deployKey}, skipping`);
    return false;
  }
  runningDeploys.add(deployKey);
  return fn().finally(() => runningDeploys.delete(deployKey));
}

// ---------- main server ------------------------------------------------------

// Create the HTTP server to receive GitHub webhook events
http.createServer(async (req, res) => {
  // Handle log file requests
  if (req.method === 'GET' && LOG_DIR) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts.length === 2) {
      const [repoName, gitHash] = pathParts;
      const logPath = path.join(LOG_DIR, repoName, `${gitHash}.txt`);
      
      try {
        const stats = await fs.promises.stat(logPath);
        if (stats.isFile()) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          fs.createReadStream(logPath).pipe(res);
          return;
        }
      } catch (err) {
        // File doesn't exist or other error
      }
      // If we get here, the file doesn't exist or there was an error
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Log file not found');
      return;
    }
  }

  if (req.method !== 'POST') {
    // Only accept POST requests
    return res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method Not Allowed');
  }

  let raw = [];
  req.on('data', chunk => raw.push(chunk));
  req.on('end', async () => {
    try {
      raw = Buffer.concat(raw);

      // Verify the webhook signature
      if (!verify(req.headers['x-hub-signature-256'], raw)) {
        console.error('⚠︎  signature mismatch');
        return res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
      }

      // Respond immediately to GitHub
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

      // Parse the webhook event payload
      const event = JSON.parse(raw.toString('utf8'));

      // Only handle push events (ignore others, deletions, or incomplete payloads)
      if (!event.ref || !event.after || !event.repository || event.deleted) {
        console.log('Ignoring non-push event, incomplete payload, or deletion event');
        return;
      }

      const ref   = event.ref;                       // e.g. "refs/heads/main"
      const sha   = event.after;                     // commit SHA
      const repo  = event.repository.full_name;      // e.g. "user/repo"
      const repoName = event.repository.name;        // repo name only
      const branch = ref.split('/').pop();           // branch name

      console.log(`📦 Push to ${repo}:${branch} (${sha.slice(0, 7)})`);

      // Only deploy for main/master branches
      if (branch !== 'main' && branch !== 'master') {
        console.log(`Ignoring branch: ${branch}`);
        return;
      }

      const deployKey = `${repo}:${branch}`;         // Unique key for this deploy
      const cwd = `repos/${repoName}`;               // Directory for the repo

      // The deploy function (runs in a lock)
      const deployFn = async () => {
        try {
          // Ensure the repo directory exists
          fs.accessSync(cwd, fs.constants.F_OK);
        } catch (err) {
          await reportErrorAndCleanup({
            repo,
            sha,
            errorMsg: 'Repository directory not found',
            commentBody: null,
            deployKey
          });
          return;
        }
        await setStatus(repo, sha, 'pending', 'Deploy started');

        try {
          // Fetch and checkout the pushed commit
          console.log(`🔄 git fetch origin ${sha}`);
          await runGit(['fetch', 'origin', sha], cwd);
          console.log('🔄 git checkout FETCH_HEAD');
          await runGit(['checkout', 'FETCH_HEAD'], cwd);
        } catch (err) {
          await reportErrorAndCleanup({
            repo,
            sha,
            errorMsg: 'Git fetch/checkout failed',
            commentBody:
              `🚨 Git fetch/checkout failed:\n\n` +
              '```\n' + (err.message || err) + '\n```',
            deployKey
          });
          return;
        }

        // Start the deploy process (e.g. using just github-deploy)
        console.log(`🚀 Starting deploy: just github-deploy ${sha} (in ${cwd})`);

        let logStream;
        if (LOG_DIR) {
          const logDir = path.join(LOG_DIR, repoName);
          const logPath = path.join(logDir, `${sha}.txt`);
          
          // Ensure log directory exists
          await fs.promises.mkdir(logDir, { recursive: true });
          logStream = fs.createWriteStream(logPath);
        }

        const proc = spawn('just', ['github-deploy', sha], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        // Collect and log output from the deploy process
        const lines = [];
        const saveLines = data => {
          data.toString().split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
              lines.push(trimmed);
              console.log(`[deploy] ${trimmed}`);
              if (lines.length > 50) lines.shift(); // Keep last 50 lines
              if (logStream) {
                logStream.write(trimmed + '\n');
              }
            }
          });
        };

        proc.stdout.on('data', saveLines);
        proc.stderr.on('data', saveLines);

        // Handle deploy process exit
        proc.on('close', async code => {
          if (logStream) {
            logStream.end();
          }
          
          const success = code === 0;
          const status = success ? 'success' : 'failure';
          const desc = success ? 'Deploy complete' : 'Deploy failed';

          console.log(`✅ Deploy ${success ? 'succeeded' : 'failed'} (exit code: ${code})`);

          await setStatus(repo, sha, status, desc);

          if (!success) {
            // If failed, add a comment with the last 20 lines of output
            const errorOutput = lines.slice(-20).join('\n');
            await addComment(repo, sha,
              `🚨 Deploy failed (exit code: ${code})\n\n` +
              '```\n' + errorOutput + '\n```'
            );
          }
        });

        // Handle errors starting the deploy process
        proc.on('error', async err => {
          await reportErrorAndCleanup({
            repo,
            sha,
            errorMsg: 'Deploy process failed to start',
            commentBody:
              `🚨 Deploy process failed to start:\n\n` +
              '```\n' + err.message + '\n```',
            deployKey
          });
        });
      };

      // Run the deploy with a lock to prevent concurrent deploys for the same repo/branch
      withDeployLock(deployKey, deployFn);

    } catch (err) {
      // Handle unexpected errors in the webhook handler
      console.error('Webhook error:', err);
      let repo = 'unknown/unknown';
      let sha = 'unknown';
      try {
        const event = JSON.parse(raw.toString('utf8'));
        if (event.repository?.full_name) repo = event.repository.full_name;
        if (event.after) sha = event.after;
      } catch {}
      await reportErrorAndCleanup({
        repo,
        sha,
        errorMsg: 'Webhook internal error',
        commentBody:
          `🚨 Webhook internal error:\n\n` +
          '```\n' + (err.stack || err.message) + '\n```',
        deployKey: null
      });
    }
  });

  // Handle request errors
  req.on('error', err => {
    console.error('Request error:', err.message);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad Request');
  });

// Start listening for webhook events
}).listen(PORT, () => {
  console.log(`🚀 GitHub webhook server listening on port ${PORT}`);
  console.log(`🔐 Signature verification: ${SECRET ? 'enabled' : 'disabled'}`);
  console.log(`📊 GitHub status updates: ${TOKEN ? 'enabled' : 'disabled'}`);
});
