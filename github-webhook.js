// webhook.js
// "World's simplest GitHub webhook" – vanilla Node, no frameworks

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const { spawn } = require('child_process');

const PORT   = process.env.PORT || 3000;           // where to listen
const SECRET = process.env.WEBHOOK_SECRET || '';   // HMAC secret (may be empty)
const TOKEN  = process.env.GITHUB_TOKEN;           // PAT with repo:status + repo:public_repo

// track running deploys to prevent double-spawning
const runningDeploys = new Set();

// ---------- helpers ----------------------------------------------------------

function verify(sigHeader, raw) {
  if (!SECRET) return true;                        // nothing to verify
  if (!sigHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {                                       // mismatched length → false
    return false;
  }
}

function callGitHub(method, path, body = {}) {
  return new Promise(res => {
    if (!TOKEN) return res();                     // silently skip if no token
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
      r.on('data', () => {});  // consume response data
      r.on('end', res);
    });
    req.on('error', err => {
      console.error('GitHub API error:', err.message);
      res(); // resolve anyway to prevent hanging
    });
    req.write(data);
    req.end();
  });
}

async function setStatus(repo, sha, state, desc) {
  if (!repo || !sha) return;
  await callGitHub(
    'POST',
    `/repos/${repo}/statuses/${sha}`,
    { state, description: desc.slice(0, 140), context: 'github-deploy' }
  );
}

async function addComment(repo, sha, body) {
  if (!repo || !sha) return;
  await callGitHub(
    'POST',
    `/repos/${repo}/commits/${sha}/comments`,
    { body: body.slice(0, 65536) }  // GitHub comment limit
  );
}

// ---------- main server ------------------------------------------------------

http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    return res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method Not Allowed');
  }
  
  let raw = [];
  req.on('data', chunk => raw.push(chunk));
  req.on('end', async () => {
    try {
      raw = Buffer.concat(raw);
      
      // verify authenticity
      if (!verify(req.headers['x-hub-signature-256'], raw)) {
        console.error('⚠︎  signature mismatch');
        return res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
      }
      
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

      // ------------------------------------------------------------------------
      // everything below runs async – errors are swallowed & logged
      // ------------------------------------------------------------------------
      
      const event = JSON.parse(raw.toString('utf8'));
      
      // only handle push events, skip deletions (force-push cleanup)
      if (!event.ref || !event.after || !event.repository || event.deleted) {
        console.log('Ignoring non-push event, incomplete payload, or deletion event');
        return;
      }
      
      const ref   = event.ref;                    // e.g. refs/heads/main
      const sha   = event.after;
      const repo  = event.repository.full_name;   // owner/repo
      const repoName = event.repository.name;
      const branch = ref.split('/').pop();

      console.log(`📦 Push to ${repo}:${branch} (${sha.slice(0, 7)})`);

      // only deploy main/master branches
      if (branch !== 'main' && branch !== 'master') {
        console.log(`Ignoring branch: ${branch}`);
        return;
      }

      // prevent double-spawning (force pushes can fire deletion + creation events)
      const deployKey = `${repo}:${branch}`;
      if (runningDeploys.has(deployKey)) {
        console.log(`Deploy already running for ${deployKey}, skipping`);
        return;
      }
      runningDeploys.add(deployKey);

      // guard against missing repo directory
      const cwd = `repos/${repoName}`;
      try {
        fs.accessSync(cwd, fs.constants.F_OK);
      } catch (err) {
        console.error(`Repository directory not found: ${cwd}`);
        runningDeploys.delete(deployKey);
        await setStatus(repo, sha, 'error', 'Repository directory not found');
        return;
      }
      await setStatus(repo, sha, 'pending', 'Deploy started');
      
      console.log(`🚀 Starting deploy: just github-deploy ${sha} (in ${cwd})`);
      
      const proc = spawn('just', ['github-deploy', sha], { 
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      const lines = [];
      const saveLines = data => {
        data.toString().split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed) {
            lines.push(trimmed);
            console.log(`[deploy] ${trimmed}`);
            if (lines.length > 50) lines.shift();   // rolling buffer
          }
        });
      };
      
      proc.stdout.on('data', saveLines);
      proc.stderr.on('data', saveLines);

      proc.on('close', async code => {
        runningDeploys.delete(deployKey); // cleanup
        
        const success = code === 0;
        const status = success ? 'success' : 'failure';
        const desc = success ? 'Deploy complete' : 'Deploy failed';
        
        console.log(`✅ Deploy ${success ? 'succeeded' : 'failed'} (exit code: ${code})`);
        
        await setStatus(repo, sha, status, desc);
        
        if (!success) {
          const errorOutput = lines.slice(-20).join('\n');
          await addComment(repo, sha, 
            `🚨 Deploy failed (exit code: ${code})\n\n` +
            '```\n' + errorOutput + '\n```'
          );
        }
      });

      proc.on('error', async err => {
        runningDeploys.delete(deployKey); // cleanup
        
        console.error('Deploy process error:', err.message);
        await setStatus(repo, sha, 'error', 'Deploy process failed to start');
        await addComment(repo, sha,
          `🚨 Deploy process failed to start:\n\n` +
          '```\n' + err.message + '\n```'
        );
      });

    } catch (err) {
      console.error('Webhook error:', err);
      
      // try to extract repo info for status update
      let repo = 'unknown/unknown';
      let sha = 'unknown';
      try {
        const event = JSON.parse(raw.toString('utf8'));
        if (event.repository?.full_name) repo = event.repository.full_name;
        if (event.after) sha = event.after;
      } catch {}

      await setStatus(repo, sha, 'error', 'Webhook internal error');
      await addComment(repo, sha,
        `🚨 Webhook internal error:\n\n` +
        '```\n' + (err.stack || err.message) + '\n```'
      );
    }
  });

  req.on('error', err => {
    console.error('Request error:', err.message);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad Request');
  });

}).listen(PORT, () => {
  console.log(`🚀 GitHub webhook server listening on port ${PORT}`);
  console.log(`🔐 Signature verification: ${SECRET ? 'enabled' : 'disabled'}`);
  console.log(`📊 GitHub status updates: ${TOKEN ? 'enabled' : 'disabled'}`);
});
