#!/usr/bin/env node
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

const repoRoot = path.resolve(__dirname, '..');
const outSuffix = process.env.GEMINI_AUTH_SUFFIX || '';

const geminiDir = path.join(repoRoot, '.gemini');
if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });

const profileDir = process.env.GEMINI_CHROME_PROFILE || path.join(geminiDir, outSuffix ? `chrome-profile-${outSuffix}` : 'chrome-profile');
const outName = outSuffix ? `gemini-auth-${outSuffix}.json` : 'gemini-auth.json';
const outPath = process.env.GEMINI_AUTH_PATH || path.join(geminiDir, outName);
const port = Number(process.env.GEMINI_CHROME_PORT || 9335);

const url = 'https://gemini.google.com/app';

function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const isWin = process.platform === 'win32';
  if (isWin) {
    const winPaths = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LocalAppData'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of winPaths) { if (p && fs.existsSync(p)) return p; }
  }
  return 'chrome.exe';
}

const chromePath = resolveChromePath();
let chromeProcess = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function fetchJson(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
  return await r.json();
}

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const v = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint не запустился');
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find(t => t.type === 'page' && /gemini\.google\.com/.test(t.url)) || targets.find(t => t.type === 'page');
    if (page?.webSocketDebuggerUrl) return page;
    await sleep(250);
  }
  throw new Error('Вкладка Gemini не найдена');
}

class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.emit(msg.method, msg.params);
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

function cleanup() {
  if (chromeProcess) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', chromeProcess.pid], { stdio: 'ignore' });
      } else {
        chromeProcess.kill();
      }
    } catch {}
    chromeProcess = null;
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

async function main() {
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  console.log(`[Gemini-Auth] Запуск Chrome для авторизации в Google: ${profileDir}`);
  chromeProcess = spawn(chromePath, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    url
  ], { stdio: 'ignore', detached: true });
  chromeProcess.unref();

  await waitDevtools();
  const target = await getPageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  console.log('\n======================================================');
  console.log('   АВТОРИЗАЦИЯ GOOGLE GEMINI (PRO / ADVANCED)');
  console.log('======================================================');
  console.log('1. В открывшемся окне Chrome войди в свой Google-аккаунт с Pro-подпиской.');
  console.log('2. Отправь в Gemini любое тестовое сообщение (например, "привет").');
  await ask('3. Когда ответ получен — нажми ENTER здесь: ');

  const cookieRes = await cdp.send('Network.getCookies', {
    urls: ['https://gemini.google.com/app', 'https://gemini.google.com/', 'https://accounts.google.com/', 'https://www.google.com/']
  });
  const googleCookies = (cookieRes.cookies || []).filter(c => /google\.com$/.test(c.domain));
  const cookieObj = {};
  googleCookies.forEach(c => { cookieObj[c.name] = c.value; });
  const cookieString = Object.entries(cookieObj).map(([k, v]) => `${k}=${v}`).join('; ');

  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const wiz = window.WIZ_global_data || {};
      return {
        snlm0e: wiz.SNlM0e || '',
        bl: wiz.cfb2h || '',
        fSid: wiz.FdrFJe ? String(wiz.FdrFJe) : '',
        pushId: wiz.qKIAYe || '',
        userAgent: navigator.userAgent || '',
        href: location.href
      };
    })()`,
    returnByValue: true
  });

  let snlm0e = evalRes.result?.value?.snlm0e || '';
  let bl = evalRes.result?.value?.bl || '';
  let fSid = evalRes.result?.value?.fSid || '';
  let pushId = evalRes.result?.value?.pushId || '';

  if (!snlm0e || !bl) {
    const htmlRes = await cdp.send('Runtime.evaluate', {
      expression: `document.documentElement.innerHTML`,
      returnByValue: true
    });
    const html = htmlRes.result?.value || '';
    if (!snlm0e) {
      const m = html.match(/"SNlM0e":"([^"]+)"/);
      if (m) snlm0e = m[1];
    }
    if (!bl) {
      const m = html.match(/"cfb2h":"([^"]+)"/) || html.match(/(boq_assistant-bard-web-server_[A-Za-z0-9_.-]+)/);
      if (m) bl = m[1];
    }
    if (!fSid) {
      const m = html.match(/"FdrFJe":"([\d-]+)"/);
      if (m) fSid = m[1];
    }
    if (!pushId) {
      const m = html.match(/"qKIAYe":"([^"]+)"/);
      if (m) pushId = m[1];
    }
  }

  const authData = {
    cookie: cookieString,
    psid: cookieObj['__Secure-1PSID'] || '',
    psidts: cookieObj['__Secure-1PSIDTS'] || '',
    snlm0e: snlm0e,
    bl: bl || 'boq_assistant-bard-web-server_20261001.00_p0',
    fSid: fSid || '',
    pushId: pushId || 'feeds/mcudyrk2a4khkz',
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(outPath, JSON.stringify(authData, null, 2));
  console.log(`\n[Gemini-Auth] ✅ Конфиг сохранен в: ${outPath}`);
  console.log(`[Gemini-Auth] __Secure-1PSID: ${authData.psid ? '✅ OK' : '❌ MISSING'}`);
  console.log(`[Gemini-Auth] __Secure-1PSIDTS: ${authData.psidts ? '✅ OK' : '❌ MISSING'}`);
  console.log(`[Gemini-Auth] SNlM0e: ${authData.snlm0e ? '✅ OK (' + authData.snlm0e.length + ' chars)' : '⚠️ Будет получен при старте'}`);
  console.log(`[Gemini-Auth] BL: ${authData.bl}`);
  console.log(`[Gemini-Auth] f.sid: ${authData.fSid || 'none'}`);

  cdp.close();
  cleanup();
}

main().catch(err => {
  console.error('[Gemini-Auth] Ошибка:', err.message);
  cleanup();
  process.exit(1);
});
