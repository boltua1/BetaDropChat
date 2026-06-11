#!/usr/bin/env node
/*
  Opens/reuses a separate Chrome for Testing profile for DeepSeek Web login and extracts
  the minimum auth metadata into deepseek-auth.json.

  Usage:
    node scripts/deepseek_chrome_auth.js
    # optional override: CHROME_PATH="/path/to/browser" node scripts/deepseek_chrome_auth.js
    # optional reuse: DEEPSEEK_REUSE_CHROME=1 DEEPSEEK_KEEP_CHROME_PROFILE=1 node scripts/deepseek_chrome_auth.js

  Default auth starts a clean disposable Chrome for Testing profile and uses
  --use-mock-keychain to avoid macOS Keychain prompts.

  Flow:
    1. Log in at chat.deepseek.com in the opened Chrome profile.
    2. Send one short prompt (for example: ok) so the frontend initializes state.
    3. Return to terminal and press Enter.
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const qwenRepoRoot = path.resolve(repoRoot, '..', 'FreeQwenApi');

// --- Settings Loading ---
const settingsPath = path.join(repoRoot, 'settings.json');
let settings = {};
try {
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  console.error(`[auth] Error reading settings.json: ${e.message}`);
}

const outSuffix = process.env.DEEPSEEK_AUTH_SUFFIX || '';

// If a suffix is provided, we ignore hardcoded paths from settings.json to ensure multi-account separation
const profileDir = process.env.DEEPSEEK_CHROME_PROFILE ||
  ((settings.chrome_profile_dir && !outSuffix) ? path.resolve(repoRoot, settings.chrome_profile_dir) : path.join(repoRoot, '.deepseek', outSuffix ? `chrome-profile-${outSuffix}` : 'chrome-profile'));

const port = Number(process.env.DEEPSEEK_CHROME_PORT || settings.chrome_debug_port || 9334);
const outName = outSuffix ? `deepseek-auth-${outSuffix}.json` : 'deepseek-auth.json';

const outPath = process.env.DEEPSEEK_AUTH_PATH || 
  ((settings.auth_path && !outSuffix) ? path.resolve(repoRoot, settings.auth_path) : path.join(repoRoot, '.deepseek', outName));
// ------------------------

const url = 'https://chat.deepseek.com/';
const reuseChrome = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_REUSE_CHROME || '');
const keepProfile = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_KEEP_CHROME_PROFILE || '');

function shellPatternSafe(s) {
  return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function killExistingTestingChrome() {
  const isWin = process.platform === 'win32';
  if (!isWin && process.platform !== 'darwin') return;

  if (isWin) {
    try {
      // Find PID using the port
      const out = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${port}`], { encoding: 'utf8' });
      const lines = out.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].endsWith(`:${port}`)) {
          const pid = parts[4];
          if (pid && pid !== '0') {
            try { execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' }); } catch {}
          }
        }
      }
    } catch {}
  } else {
    const patterns = [
      `--remote-debugging-port=${port}`,
      profileDir,
    ].map(shellPatternSafe);
    for (const pattern of patterns) {
      try { execFileSync('/usr/bin/pkill', ['-f', pattern], { stdio: 'ignore' }); } catch {}
    }
  }
  sleepSync(800);
}

function removeProfileSafely(dir) {
  if (!fs.existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      if (!fs.existsSync(dir)) return;
    } catch (e) {
      if (i === 4) {
        const staleDir = `${dir}.stale-${Date.now()}`;
        try { fs.renameSync(dir, staleDir); } catch { /* ignore rename error */ }
        try { fs.rmSync(staleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch {}
        console.log(`[auth] Old profile was busy; moved it aside: ${staleDir}`);
        return;
      }
    }
    sleepSync(300);
  }
}

function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  // Match FreeQwenApi: prefer Puppeteer's bundled "Google Chrome for Testing"
  for (const base of [repoRoot, qwenRepoRoot]) {
    try {
      const puppeteerPath = require.resolve('puppeteer', { paths: [base] });
      const puppeteer = require(puppeteerPath);
      if (typeof puppeteer.executablePath === 'function') {
        const p = puppeteer.executablePath();
        if (p && fs.existsSync(p)) return p;
      }
    } catch {}
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
  try {
    if (fs.existsSync(cacheRoot)) {
      const dirs = fs.readdirSync(cacheRoot);
      const candidates = [];
      for (const d of dirs) {
        if (isMac) {
          const p = path.join(cacheRoot, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
          if (fs.existsSync(p)) candidates.push(p);
          const p2 = path.join(cacheRoot, d, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
          if (fs.existsSync(p2)) candidates.push(p2);
        } else if (isWin) {
          const p = path.join(cacheRoot, d, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(p)) candidates.push(p);
          const p2 = path.join(cacheRoot, d, 'chrome-win32', 'chrome.exe');
          if (fs.existsSync(p2)) candidates.push(p2);
        }
      }
      candidates.sort().reverse();
      if (candidates[0]) return candidates[0];
    }
  } catch {}

  if (isWin) {
    const winPaths = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LocalAppData'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of winPaths) {
      if (p && fs.existsSync(p)) return p;
    }
  }

  if (isMac) {
    const macPaths = [
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return isWin ? 'chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const chromePath = resolveChromePath();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}
async function fetchJson(u, opts) {
  const r = await fetch(u, opts);
  if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
  return await r.json();
}
async function devtoolsReady() {
  try { return await fetchJson(`http://127.0.0.1:${port}/json/version`); }
  catch { return null; }
}
async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    const v = await devtoolsReady();
    if (v) return v;
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}
async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find(t => t.type === 'page' && /chat\.deepseek\.com/.test(t.url)) || targets.find(t => t.type === 'page');
    if (page?.webSocketDebuggerUrl) return page;
    await sleep(250);
  }
  throw new Error('No Chrome page target found');
}
const { EventEmitter } = require('events');

class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.emit(msg.method, msg.params);
        this.events.push(msg);
        if (this.events.length > 1000) this.events.shift();
      }
    };
  }
  ready() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch {} }
}
function parseMaybeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function normalizeToken(raw) {
  if (!raw) return '';
  const parsed = parseMaybeJson(raw);
  if (parsed && typeof parsed === 'object') return parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '';
  return String(raw).trim();
}
async function readPageAuth(cdp) {
  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
      for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
      for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
      out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
      return out;
    })()`,
    returnByValue: true,
  });
  const pageState = evalRes.result.value || {};
  const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}];
  let token = '';
  for (const store of stores) {
    for (const key of ['userToken','token','auth_token','access_token','accessToken']) {
      token = normalizeToken(store[key]);
      if (token) break;
    }
    if (token) break;
  }
  if (!token) {
    for (const store of stores) {
      for (const [k, v] of Object.entries(store)) {
        if (/token/i.test(k)) { token = normalizeToken(v); if (token) break; }
      }
      if (token) break;
    }
  }

  const cookieRes = await cdp.send('Network.getAllCookies');
  const cookies = (cookieRes.cookies || []).filter(c => /deepseek\.com$/.test(c.domain));
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let hif_dliq = '', hif_leim = '';
  for (const ev of cdp.events) {
    const headers = ev.params?.headers || ev.params?.request?.headers;
    if (!headers) continue;
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-hif-dliq') hif_dliq = String(v);
      if (lk === 'x-hif-leim') hif_leim = String(v);
      if (lk === 'authorization' && !token && /^Bearer\s+/i.test(String(v))) token = String(v).replace(/^Bearer\s+/i, '');
    }
  }

  const wasmUrl = (pageState.resources || []).find(u => /sha3.*\.wasm/.test(u)) ||
    'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  return { token, cookie, hif_dliq, hif_leim, wasmUrl, baseUrl: 'https://chat.deepseek.com', href: pageState.href, cookiesCount: cookies.length };
}
let chromeProcess = null;

function cleanup() {
  if (chromeProcess) {
    console.log('[auth] Closing browser...');
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', chromeProcess.pid], { stdio: 'ignore' });
      } else {
        chromeProcess.kill();
      }
    } catch (e) {}
    chromeProcess = null;
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

async function captureWasm(cdp) {
  try {
    const evalRes = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const resources = performance.getEntriesByType('resource');
        const wasmEntry = resources.find(r => r.name.includes('.wasm'));
        if (!wasmEntry) {
           return { error: 'no_wasm_found', found_types: resources.map(r => r.name.split('.').pop()).slice(-10) };
        }
        
        try {
          const resp = await fetch(wasmEntry.name);
          const buf = await resp.arrayBuffer();
          const arr = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
          return { url: wasmEntry.name, size: arr.length, data: btoa(binary) };
        } catch (e) {
          return { error: 'fetch_failed', message: e.message, url: wasmEntry.name };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const result = evalRes.result.value;
    if (result && result.data) {
      const buffer = Buffer.from(result.data, 'base64');
      if (buffer.length > 10000 && buffer[0] === 0x00 && buffer[1] === 0x61 && buffer[2] === 0x73 && buffer[3] === 0x6d) {
        const wasmPath = path.join(repoRoot, '.deepseek', 'pow.wasm');
        if (!fs.existsSync(path.dirname(wasmPath))) fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
        fs.writeFileSync(wasmPath, buffer);
        console.log(`[auth] ✅ Captured and saved pow.wasm from ${result.url} (${buffer.length} bytes)`);
        return true;
      }
    } else if (result?.error === 'no_wasm_found') {
        // console.log('[auth] No .wasm found in performance resources yet.');
    } else if (result?.error) {
      console.log(`[auth] WASM capture attempt failed: ${result.error} ${result.message || ''}`);
    }
  } catch (e) {
    // console.log(`[auth] CDP capture error: ${e.message}`);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome/Chrome for Testing not found: ${chromePath}. Set CHROME_PATH.`);

  if (!reuseChrome) {
    killExistingTestingChrome();
    if (!keepProfile && fs.existsSync(profileDir)) {
      removeProfileSafely(profileDir);
      console.log(`[auth] Removed old Chrome for Testing profile: ${profileDir}`);
    }
  }
  fs.mkdirSync(profileDir, { recursive: true });

  if (reuseChrome && await devtoolsReady()) {
    console.log(`[auth] Reusing Chrome DevTools on port ${port}`);
  } else {
    console.log(`[auth] Starting clean Chrome for Testing profile: ${profileDir}`);
    console.log(`[auth] Browser executable: ${chromePath}`);
    chromeProcess = spawn(chromePath, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
      '--no-first-run', '--no-default-browser-check', '--disable-infobars',
      url,
    ], { stdio: 'ignore', detached: true });
    chromeProcess.unref();
  }

  await waitDevtools();
  const target = await getPageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // FORCE DISABLE CACHE so we can capture the WASM even if it was previously cached
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  cdp.on('Network.responseReceived', async (params) => {
    const url = params.response.url;
    
    if (url.includes('.wasm')) {
      try {
        const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
        const buffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
        
        // Validation: Must be a WASM file (\0asm)
        if (buffer.length > 10000 && buffer[0] === 0x00 && buffer[1] === 0x61 && buffer[2] === 0x73 && buffer[3] === 0x6d) {
          const wasmPath = path.join(repoRoot, '.deepseek', 'pow.wasm');
          if (!fs.existsSync(path.dirname(wasmPath))) fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
          fs.writeFileSync(wasmPath, buffer);
          console.log(`[auth] ✅ Captured and saved pow.wasm from ${url} (${buffer.length} bytes)`);
        }
      } catch (e) {
        // Body might not be available if it's a cache hit or very fast, 
        // but often CDP can still get it. If it fails, we still have the backup captureWasm call on Enter.
      }
    }

    if (url.includes('/api/v0/chat/completion')) {
      console.log(`[auth] Activity detected: ${url}`);
    }
  });

  console.log(`\n[auth] Chrome открыт. Войди в DeepSeek в ЭТОМ отдельном окне.`);
  console.log('[auth] После логина отправь в DeepSeek короткое сообщение, например: ok');

  await ask('[auth] Когда залогинился и отправил тестовое сообщение — нажми ENTER здесь: ');

  // Try to capture WASM again from page context if network capture missed it (e.g. disk cache hit)
  await captureWasm(cdp);

  let auth = null;
  for (let i = 0; i < 20; i++) {
    auth = await readPageAuth(cdp);
    if (auth.token && auth.cookie) break;
    await sleep(500);
  }
  const { href, cookiesCount, ...persisted } = auth;
  fs.writeFileSync(outPath, JSON.stringify(persisted, null, 2));
  console.log(`[auth] Saved: ${outPath}`);
  console.log(`[auth] page: ${href || 'unknown'}`);
  console.log(`[auth] token: ${persisted.token ? 'OK (' + persisted.token.length + ' chars)' : 'MISSING'}`);
  console.log(`[auth] cookie: ${persisted.cookie ? 'OK (' + cookiesCount + ' cookies)' : 'MISSING'}`);
  console.log(`[auth] hif headers: ${persisted.hif_dliq || persisted.hif_leim ? 'captured' : 'not captured/optional'}`);
  
  cdp.close();
  cleanup(); // Close browser on success

  if (!persisted.token || !persisted.cookie) process.exitCode = 2;
}
main().catch(e => { console.error('[auth] ERROR:', e); process.exit(1); });
