#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset when message chain > 50 messages or age > 2 hours.
 * Listens on 0.0.0.0:9655
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');

const SERVER_HOST = os.hostname();  // Dynamic hostname detection
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

const FORGETMEAI_WATERMARK = '';

// --- Settings Loading ---
const settingsPath = path.join(__dirname, 'settings.json');
let settings = {};
try {
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
} catch (e) {
    console.error(`[DS-API] Error reading settings.json: ${e.message}`);
}

const PORT = Number(process.env.PORT || settings.server_port || 9655);
const HOST = process.env.HOST || '127.0.0.1';

// --- Logging System ---
const LOG_ROOT = path.join(__dirname, 'logs');
function writeLog(accountId, agentId, type, data) {
    try {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toISOString().split('T')[1].replace('Z', '');
        
        // Structure: logs/YYYY-MM-DD/accountId/agentId.log
        const safeAccountId = String(accountId || 'default').replace(/[^a-z0-9._-]/gi, '_');
        const dir = path.join(LOG_ROOT, dateStr, safeAccountId);
        
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const safeAgentId = String(agentId || 'system').replace(/[^a-z0-9._-]/gi, '_');
        const logFile = path.join(dir, `${safeAgentId}.log`);
        const header = `[${timeStr}] [${type}] `;
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        fs.appendFileSync(logFile, header + content + '\n' + '='.repeat(50) + '\n');
    } catch (e) {
        console.error(`[DS-API] Logging error: ${e.message}`);
    }
}

// ----------------------

// === Multi-Account Pool ===
const DEEPSEEK_DIR = path.join(__dirname, '.deepseek');
const accountPool = new Map(); // id -> config

function buildBaseHeaders(config) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}

function loadAccountPool() {
    if (!fs.existsSync(DEEPSEEK_DIR)) return;
    const files = fs.readdirSync(DEEPSEEK_DIR).filter(f => f.startsWith('deepseek-auth') && f.endsWith('.json'));
    accountPool.clear();
    
    files.forEach(f => {
        try {
            const id = f === 'deepseek-auth.json' ? 'default' : f.replace('deepseek-auth-', '').replace('.json', '');
            const raw = fs.readFileSync(path.join(DEEPSEEK_DIR, f), 'utf8');
            const config = JSON.parse(raw);
            config.headers = buildBaseHeaders(config);
            config.id = id;
            accountPool.set(id, config);
            console.log(`[DS-API] Loaded account: ${id}`);
        } catch (e) {
            console.error(`[DS-API] Error loading account ${f}: ${e.message}`);
        }
    });
}

function getAccountForAgent(agentId) {
    if (accountPool.size === 0) return null;
    
    // Simple Sticky Session: hash agentId to an account index
    const accounts = Array.from(accountPool.values());
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
        hash = ((hash << 5) - hash) + agentId.charCodeAt(i);
        hash |= 0; 
    }
    const index = Math.abs(hash) % accounts.length;
    return accounts[index];
}

loadAccountPool();
// ----------------------

function formatWatermark(prefix = 'BetaDropChat') { return `${prefix}: ${FORGETMEAI_WATERMARK}`; }
function printBanner() {
    console.log(`
██████  ███████ ████████  █████  ██████  ██████   ██████  ██████  
██   ██ ██         ██    ██   ██ ██   ██ ██   ██ ██    ██ ██   ██ 
██████  █████      ██    ███████ ██   ██ ██████  ██    ██ ██████  
██   ██ ██         ██    ██   ██ ██   ██ ██   ██ ██    ██ ██      
██████  ███████    ██    ██   ██ ██████  ██   ██  ██████  ██      
                                                                  
   BetaDropChat — API-прокси для DeepSeek Web Chat (Multi-Account Edition)
   ${formatWatermark()}
`);
}
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID
const sessionCreationPromises = new Map();
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_MESSAGE_DEPTH = 100;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// === Rate Limiting ===
const RATE_LIMIT_COUNT = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const requestLogs = new Map();

function checkRateLimit(agentId) {
    const now = Date.now();
    if (!requestLogs.has(agentId)) requestLogs.set(agentId, []);
    const logs = requestLogs.get(agentId);
    while (logs.length > 0 && logs[0] < now - RATE_LIMIT_WINDOW_MS) logs.shift();
    if (logs.length >= RATE_LIMIT_COUNT) {
        return { limited: true, waitMs: Math.max(0, logs[0] + RATE_LIMIT_WINDOW_MS - now) };
    }
    logs.push(now);
    return { limited: false };
}

function createSession() {
    return { id: null, parentMessageId: null, createdAt: null, messageCount: 0, history: [] };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) sessions.set(agentId, createSession());
    return sessions.get(agentId);
}

async function ensureAgentSession(agentId, account) {
    const session = getOrCreateAgentSession(agentId);
    if (session.id) return session;

    if (!sessionCreationPromises.has(agentId)) {
        const createPromise = (async () => {
            const agentTag = `[${agentId}] [Acc:${account.id}]`;
            try {
                const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                    method: 'POST', headers: account.headers, body: '{}'
                });
                const srText = await sr.text();
                if (sr.status === 202 || !srText.trim()) {
                    throw new Error(`Session creation failed (Status ${sr.status}). DeepSeek returned an empty response. This usually means your session/cookie has expired or is being challenged. Please re-run: node scripts/auth.js`);
                }
                let sessionData;
                try {
                    sessionData = JSON.parse(srText);
                } catch (e) {
                    throw new Error(`Failed to parse session creation JSON: ${e.message}. Status: ${sr.status}`);
                }
                const newId = sessionData.data.biz_data.chat_session?.id || sessionData.data.biz_data.id;
                session.id = newId;
                session.parentMessageId = null;
                session.createdAt = Date.now();
                session.messageCount = 0;
                console.log(`${agentTag} Created new session: ${newId}`);
                writeLog(account.id, agentId, 'SESSION-CREATED', { sessionId: newId });
                return session;
            } catch (err) {
                writeLog(account.id, agentId, 'ERROR-SESSION-CREATE', { error: err.message });
                throw err;
            }
        })();
        sessionCreationPromises.set(agentId, createPromise);
        try {
            return await createPromise;
        } finally {
            sessionCreationPromises.delete(agentId);
        }
    } else {
        console.log(`[${agentId}] Waiting for session creation...`);
        return await sessionCreationPromises.get(agentId);
    }
}

// === Worker-based POW solver ===
function solvePOWAsync(challenge, wasmUrl, accountId, headers) {
    return new Promise((resolve, reject) => {
        const localPath = path.join(DEEPSEEK_DIR, 'pow.wasm');
        const worker = new Worker(path.join(__dirname, 'pow-worker.js'));
        worker.postMessage({ challenge, wasmUrl, accountId, headers, localPath });
        worker.on('message', (msg) => {
            if (msg.success) resolve(msg.answer);
            else reject(new Error(msg.error));
            worker.terminate();
        });
        worker.on('error', (err) => {
            reject(err);
            worker.terminate();
        });
        // Safety timeout
        setTimeout(() => {
            worker.terminate();
            reject(new Error('POW solver timeout'));
        }, 30000);
    });
}

const MODEL_CONFIGS = {
    // DeepSeek Web real model_type: default / UI name: "Быстрый".
    // Public model family: DeepSeek-V3.2-Exp chat mode (fast, no visible reasoning).
    'deepseek-chat': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-v3': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-default': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    // Same DeepSeek Web default model, but with thinking_enabled=true. UI exposes it as thinking/reasoning mode.
    'deepseek-reasoner': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode (DeepSeek Web “Быстрый” + thinking_enabled)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-r1': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode; R1-compatible alias, not a separate R1 model_type in current Web API',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-chat-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-default-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-reasoner-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    'deepseek-r1-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search; R1-compatible alias',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    // DeepSeek Web UI name: “Эксперт”. Requires current web client headers (x-client-version=2.0.0).
    'deepseek-expert': {
        model_type: 'expert', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” (limited resources)',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: true,
    },
    'deepseek-v4-pro': {
        model_type: 'expert', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” + thinking mode (exposed as deepseek-v4-pro alias)',
        capabilities: { reasoning: true, web_search: false, files: false },
        supported: true,
    },
    'deepseek-expert-search': {
        model_type: 'expert', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek Web “Эксперт” + search requested, but Expert has search_feature=null in remote config',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: false,
        unavailable_reason: 'Expert mode is rejected; remote config says search is not available for Expert.',
    },
    'deepseek-vision': {
        model_type: 'vision', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Распознавание” / image understanding beta',
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
        supported: false,
        unavailable_reason: 'Current Web API returns: Vision is temporarily unavailable (backend_err_by_model).',
    },

    // --- Anthropic Model Aliases (for Claude Code / Claude Desktop compatibility) ---
    'claude-3-5-sonnet-20240620': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Sonnet alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-3-5-sonnet-20241022': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Sonnet alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-3-5-sonnet-latest': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Sonnet alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-3-7-sonnet-20250219': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Sonnet 3.7 alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-3-opus-20240229': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-R1 (Anthropic Opus alias)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'claude-3-haiku-20240307': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Haiku alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-3-5-haiku-20241022': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V3 (Anthropic Haiku 3.5 alias)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'claude-4-5-20251001': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-R1 (Anthropic Claude 4.5 alias)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'claude-4-8': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-R1 (Anthropic Claude 4.8 alias)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-chat').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-chat'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default') {
    const modelCfg = resolveModelConfig(model);
    const session = getOrCreateAgentSession(agentId);
    const account = getAccountForAgent(agentId);
    
    if (!account) {
        throw new Error('No available accounts in accountPool. Please run node scripts/auth.js');
    }

    const agentTag = `[${agentId}] [Acc:${account.id}]`;

    // Auto-reset on deep message chain
    if (session.id && session.messageCount >= MAX_MESSAGE_DEPTH) {
        console.log(`${agentTag} Session hit depth limit. Auto-resetting.`);
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
    }

    // Reset expired sessions
    if (session.id && session.createdAt && (Date.now() - session.createdAt > SESSION_TTL_MS)) {
        console.log(`${agentTag} Session expired. Creating new...`);
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
    }

    const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', 
        headers: account.headers,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    const crText = await cr.text();
    let chalJson;
    try {
        chalJson = JSON.parse(crText);
    } catch (e) {
        writeLog(account.id, agentId, 'ERROR-POW-JSON', { status: cr.status, text: crText, error: e.message });
        throw new Error(`Failed to parse POW challenge JSON: ${e.message}. Status: ${cr.status}`);
    }
    const challenge = chalJson.data.biz_data.challenge;
    const answer = await solvePOWAsync(challenge, 'https://chat.deepseek.com/static/wasm/pro/pow.wasm', account.id, account.headers);

    await ensureAgentSession(agentId, account);

    const powB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: '/api/v0/chat/completion'
    })).toString('base64');
    
    writeLog(account.id, agentId, 'DS-REQUEST', {
        sessionId: session.id,
        parentMessageId: session.parentMessageId,
        model: modelCfg.real_model,
        prompt: prompt.substring(0, 500) + (prompt.length > 500 ? '...' : '')
    });

    const resp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...account.headers, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: session.id,
            parent_message_id: session.parentMessageId,
            model_type: modelCfg.model_type,
            prompt: prompt, ref_file_ids: [],
            thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
            action: null, preempt: false,
        })
    });

    // If session expired, reset and retry once
    if (resp.status !== 200) {
        const errText = await resp.text();
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            session.id = null;
            session.parentMessageId = null;
            session.createdAt = null;
            session.messageCount = 0;

            const sr2 = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: account.headers, body: '{}'
            });
            const sr2Text = await sr2.text();
            if (sr2.status === 202 || !sr2Text.trim()) {
                const msg = `Session creation failed (Status ${sr2.status}) for account ${account.id}. DeepSeek returned an empty response. This usually means your session/cookie has expired or is being challenged. Please re-run: node scripts/auth.js`;
                writeLog(account.id, agentId, 'ERROR-SESSION-RETRY-202', { status: sr2.status, text: sr2Text });
                throw new Error(msg);
            }
            let sessionData2;
            try {
                sessionData2 = JSON.parse(sr2Text);
            } catch (e) {
                writeLog(account.id, agentId, 'ERROR-SESSION-RETRY-JSON', { status: sr2.status, text: sr2Text, error: e.message });
                throw new Error(`Failed to parse retry session JSON: ${e.message}. Status: ${sr2.status}`);
            }
            session.id = sessionData2.data.biz_data.chat_session?.id || sessionData2.data.biz_data.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            console.log(`${agentTag} Created new session: ${session.id}`);

            const newPowB64 = Buffer.from(JSON.stringify({
                algorithm: challenge.algorithm, challenge: challenge.challenge,
                salt: challenge.salt, answer: answer,
                signature: challenge.signature, target_path: '/api/v0/chat/completion'
            })).toString('base64');
            const resp2 = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
                method: 'POST',
                headers: { ...account.headers, 'X-DS-PoW-Response': newPowB64 },
                body: JSON.stringify({
                    chat_session_id: session.id,
                    parent_message_id: null,
                    model_type: modelCfg.model_type,
                    prompt: prompt, ref_file_ids: [],
                    thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
                    action: null, preempt: false,
                })
            });
            return { resp: resp2, agentId, accountId: account.id };
        }
    }

    return { resp, agentId, accountId: account.id };
}

// === Tool Calling Support ===

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server, REQUEST exactly one tool call. Prefer strict JSON:\n';
    text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n\n';
    text += 'Legacy format is also accepted: TOOL_CALL: <function_name>\narguments: <JSON arguments>\n\n';
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on ' + SERVER_HOST + ' (' + SERVER_PUBLIC_IP + '), the local server — NOT on DeepSeek\n';
    text += '4. After the tool executes, the result will be sent to you as a new user/tool message\n';
    text += '5. Never add explanation before or after the tool request when requesting a tool\n';
    text += '6. Keep arguments compact. Do not include large file contents unless the tool schema requires it.\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            text += `${fn.description || ''}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += '\nREMEMBER: Request tools only with strict JSON or TOOL_CALL legacy format. Never simulate results.';
    return text;
}

function extractBalancedJsonAt(text, startIndex) {
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

function coerceToolCallObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const candidate = obj.tool_call || obj.tool || obj.function_call || obj;
    if (!candidate || typeof candidate !== 'object') return null;
    const fn = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate;
    const name = fn.name || candidate.name || obj.name;
    let args = fn.arguments ?? candidate.arguments ?? candidate.input ?? obj.arguments ?? obj.input ?? {};
    if (!name || typeof name !== 'string') return null;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { args = { raw: args }; }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
    return { name, arguments: JSON.stringify(args) };
}

function parseJsonToolCandidate(raw, label = 'json') {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        const tc = coerceToolCallObject(parsed);
        if (tc) {
            console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
            return tc;
        }
    } catch (e) {
        console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
    }
    return null;
}

function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;

    // XML-ish wrappers used by some agent prompts.
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml');
        if (tc) return tc;
    }

    // Fenced JSON blocks.
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const tc = parseJsonToolCandidate(fence[1].trim(), 'fenced');
        if (tc) return tc;
    }

    // Legacy TOOL_CALL: name + first balanced JSON object after it.
    const match = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const afterMatch = text.substring(match.index + match[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = JSON.parse(rawJson);
                    console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                    return { name, arguments: JSON.stringify(args) };
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    // First balanced JSON object in the whole response. Supports:
    // {"tool_call":{"name":"...","arguments":{...}}}, {"name":"...","arguments":{...}}, etc.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        const rawJson = extractBalancedJsonAt(text, i);
        if (!rawJson) continue;
        const tc = parseJsonToolCandidate(rawJson, 'inline');
        if (tc) return tc;
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 */
function sanitizeContent(text) {
    return text.replace(/[\ud800-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    // Do not attach reasoning to tool-call turns. Some agent clients treat any
    // reasoning/text payload as a final assistant answer and stop their tool loop.
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '') {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`;
            return part.text || part.content || JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: normalizeMessageContent(item.content) });
        } else if (item.role) {
            messages.push({ role: item.role, content: normalizeMessageContent(item.content) });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
                    else messages.push({ role: 'user', content: normalizeMessageContent(part) });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: normalizeMessageContent(msg.content) });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
        watermark: FORGETMEAI_WATERMARK,
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const message = toAnthropicResponse(openaiResp);
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });

    // Anthropic-compatible clients expect a tool turn to be made of tool_use
    // content blocks. If we emit DeepSeek reasoning as a text block before the
    // tool_use block, some agents treat the turn as a normal text answer and do
    // not execute the tool. Keep tool streaming clean: tool_use blocks only.
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc, i) => {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: message.usage });
    } else {
        if (msg.reasoning_content) {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${msg.reasoning_content}\n[/reasoning]\n` } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        const offset = msg.reasoning_content ? 1 : 0;
        writeSse(res, 'content_block_start', { type: 'content_block_start', index: offset, content_block: { type: 'text', text: '' } });
        const text = msg.content || '';
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: offset, delta: { type: 'text_delta', text: text.substring(i, i + 80) } });
        }
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: offset });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    }
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
}

function toResponsesResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
        watermark: FORGETMEAI_WATERMARK,
    };
}

function sendResponsesStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const response = toResponsesResponse(openaiResp);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });
    let outputIndex = 0;
    if (!hasToolCalls && msg.reasoning_content) {
        const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...reasoningItem, status: 'in_progress' } });
        writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: outputIndex, summary_index: 0, delta: msg.reasoning_content });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: msg.reasoning_content }] } });
        outputIndex++;
    }
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc) => {
            const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
            writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
            writeSse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
            writeSse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
            writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
            outputIndex++;
        });
    } else {
        const text = msg.content || '';
        const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
        writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
        }
        writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
        writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    writeSse(res, 'response.completed', { type: 'response.completed', response });
    res.write('data: [DONE]\n\n');
    res.end();
}

function sendOpenAIStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const model = openaiResp.model;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    if (!hasToolCalls && msg.reasoning_content) {
        for (let i = 0; i < msg.reasoning_content.length; i += 50) {
            const chunk = msg.reasoning_content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
    }
    if (hasToolCalls) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: msg.tool_calls }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } else {
        for (let i = 0; i < (msg.content || '').length; i += 50) {
            const chunk = msg.content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    res.end();
}

function storeHistory(agentId, prompt, content, toolCall) {
    const session = getOrCreateAgentSession(agentId);
    const assistantResponse = toolCall
        ? `TOOL_CALL: ${toolCall.name}\narguments: ${toolCall.arguments}`
        : content;
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

// Extract MEDIA: paths from tool results that contain screenshot paths
function extractScreenshotPaths(messages) {
    const paths = [];
    const fs = require('fs');
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            // Look for screenshot_path or path fields in JSON tool results
            // These come DIRECTLY from browser_vision — always the real path
            const pngMatch = msg.content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch) {
                const filePath = pngMatch[2];
                if (filePath.startsWith('/') && fs.existsSync(filePath)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
            // Also catch plain MEDIA: tags
            const mediaMatch = msg.content.match(/MEDIA:(\S+)/g);
            if (mediaMatch) {
                for (const tag of mediaMatch) {
                    const extractedPath = tag.replace(/^MEDIA:/, '');
                    if (fs.existsSync(extractedPath) && !paths.includes(tag)) {
                        paths.push(tag);
                    }
                }
            }
        }
        // Check user/assistant messages for paths mentioned in conversation text
        // Only include if the file ACTUALLY EXISTS (DeepSeek hallucinates paths)
        if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) {
                const filePath = match[1];
                if (filePath.startsWith('/') && fs.existsSync(filePath) && !paths.includes(`MEDIA:${filePath}`)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
        }
    }
    return paths;
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += msg.content + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);

    // Build full conversation history for DeepSeek's context
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;  // already in systemPrompt
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // This was a tool call response from a previous turn
                for (const tc of msg.tool_calls) {
                    conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${msg.content}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            // Tool execution result — send back to DeepSeek as context
            const truncated = msg.content.length > 8000
                ? msg.content.substring(0, 8000) + '\n...[truncated]'
                : msg.content;
            conversation += `[Tool Result]\n${truncated}\n\n`;
        }
    }
    // The last user message + full conversation context
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

function hasAuthConfig() {
    return accountPool.size > 0;
}

function loadDeepSeekConfig() {
    loadAccountPool();
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // Normalize path: handle /v1/v1/messages and ensure single /v1 prefix if needed
    let cleanPath = url.pathname.replace(/^\/v1\/v1/, '/v1');
    
    // Health check
    if (req.method === 'GET' && (cleanPath === '/' || cleanPath === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'BetaDropChat', watermark: FORGETMEAI_WATERMARK, models: SUPPORTED_MODEL_IDS, unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported), agents: sessions.size, config_ready: hasAuthConfig() }));
        return;
    }

    // Models: OpenAI-compatible list exposes only aliases verified to work through this proxy.
    if (req.method === 'GET' && cleanPath === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    // Full mapping, including Web models observed but not currently usable through the direct API.
    if (req.method === 'GET' && (cleanPath === '/v1/model-capabilities' || cleanPath === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: FORGETMEAI_WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && cleanPath === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                history_size: session.history.length,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && cleanPath === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = cleanPath === '/v1/messages'
        ? 'anthropic'
        : (cleanPath === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    
    if (req.method === 'POST') {
        console.log(`[DS-API] POST ${cleanPath} (Mode: ${apiMode})`);
    }

    if (req.method !== 'POST' || !acceptedPostPaths.includes(cleanPath)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        const remoteAddr = req.socket.remoteAddress || 'unknown';
        const isLocal = (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1');
        
        try {
            const bodyParams = JSON.parse(body || '{}');
            const requestedSession = req.headers['x-agent-session'] || bodyParams.session || bodyParams.user || (isLocal ? 'dev-agent' : remoteAddr);
            const agentId = String(requestedSession);
            const account = getAccountForAgent(agentId);
            const accountId = account ? account.id : 'no-account';
            
            writeLog(accountId, agentId, 'INCOMING-REQUEST', {
                path: cleanPath,
                headers: req.headers,
                body: bodyParams
            });

            const params = normalizeApiParams(bodyParams, apiMode);
            const messages = params.messages || [];
            const tools = params.tools || [];
            const stream = params.stream === true;
            const agentTag = `[${agentId}]`;

            // --- Rate Limiting Check ---
            const rl = checkRateLimit(agentId);
            if (rl.limited) {
                const waitSec = Math.ceil(rl.waitMs / 1000);
                console.log(`${agentTag} ⏳ Rate limit reached (3 req/min). Waiting ${waitSec}s...`);
                await new Promise(r => setTimeout(r, rl.waitMs));
                // Re-log the current request after waiting so it counts for the next window
                checkRateLimit(agentId); 
            }
            // ---------------------------
            
            let requestedModel = String(params.model || 'deepseek-chat').toLowerCase();
            
            writeLog(accountId, agentId, 'MODEL-INFO', { 
                requested_model: requestedModel,
                is_known: isKnownModel(requestedModel),
                is_supported: isKnownModel(requestedModel) ? isSupportedModel(requestedModel) : false
            });

            if (!isKnownModel(requestedModel)) {
                const fallback = 'deepseek-chat';
                console.log(`[DS-API] ${agentTag} 🔀 Model Mapping: "${requestedModel}" -> "${fallback}" (Unknown model)`);
                writeLog(accountId, agentId, 'MODEL-MAPPING', { from: requestedModel, to: fallback, reason: 'unknown' });
                requestedModel = fallback;
            } else if (!isSupportedModel(requestedModel)) {
                const fallback = 'deepseek-chat';
                const cfg = resolveModelConfig(requestedModel);
                console.log(`[DS-API] ${agentTag} ⚠️ Model "${requestedModel}" is unsupported (${cfg.unavailable_reason || 'disabled'}). Mapping to "${fallback}"`);
                writeLog(accountId, agentId, 'MODEL-MAPPING', { from: requestedModel, to: fallback, reason: 'unsupported', detail: cfg.unavailable_reason });
                requestedModel = fallback;
            }
            const { prompt, systemPrompt } = formatMessages(messages, tools);

            const session = await ensureAgentSession(agentId, account);

            // Build history prefix if starting fresh
            let historyPrefix = '';
            if (session.messageCount === 0 && session.history.length > 0) {
                historyPrefix = '[Previous conversation]\n';
                for (const exchange of session.history) {
                    historyPrefix += `User: ${exchange.user}\nAssistant: ${exchange.assistant}\n\n`;
                }
                historyPrefix += '[Continue from here]\n\n';
            }

            const fullPrompt = systemPrompt
                ? `${systemPrompt}\n\n${historyPrefix}${prompt}`
                : `${historyPrefix}${prompt}`;

            const startTime = Date.now();
            const { resp: dsResp } = await askDeepSeekStream(fullPrompt, agentId, requestedModel);

            // Process streaming response from DeepSeek — returns { content, reasoningContent, messageId, finishReason }
            async function readDeepSeekResponse(readable) {
                let buffer = '';
                let lastPath = null;
                const fragments = [];
                let fullContent = '';
                let reasoningContent = '';
                let newMessageId = null;
                let finishReason = null;
                let modelError = null;

                const rebuildFragmentText = () => {
                    const responseText = fragments
                        .filter(f => f && f.type === 'RESPONSE' && typeof f.content === 'string')
                        .map(f => f.content)
                        .join('');
                    const thinkText = fragments
                        .filter(f => f && (f.type === 'THINK' || f.type === 'REASONING') && typeof f.content === 'string')
                        .map(f => f.content)
                        .join('');
                    if (responseText) fullContent = responseText;
                    reasoningContent = thinkText;
                };

                const appendFragments = (value) => {
                    const incoming = Array.isArray(value) ? value : [value];
                    for (const fragment of incoming) {
                        if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
                    }
                    rebuildFragmentText();
                };

                for await (const chunk of readable) {
                    buffer += new TextDecoder().decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const d = JSON.parse(line.slice(6));
                                if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                                if (d.type === 'error' || d.finish_reason || d.content) {
                                    modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                                    if (d.finish_reason) finishReason = d.finish_reason;
                                    writeLog(accountId, agentId, 'DS-MODEL-ERROR-FRAGMENT', d);
                                }
                                if (d.p !== undefined) lastPath = d.p;
                                if (d.v && typeof d.v === 'object' && d.v.response) {
                                    if (d.v.response.message_id !== undefined) {
                                        newMessageId = d.v.response.message_id;
                                    }
                                    if (d.v.response.content !== undefined) {
                                        fullContent = d.v.response.content;
                                    }
                                    if (Array.isArray(d.v.response.fragments)) {
                                        fragments.length = 0;
                                        appendFragments(d.v.response.fragments);
                                    }
                                    if (d.v.response.finish_reason !== undefined) {
                                        finishReason = d.v.response.finish_reason;
                                    }
                                }
                                if (lastPath === 'response/fragments' && d.v !== undefined) {
                                    appendFragments(d.v);
                                }
                                if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                                    if (fragments.length > 0) {
                                        const lastFragment = fragments[fragments.length - 1];
                                        lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                                        rebuildFragmentText();
                                    }
                                }
                                if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                                    fullContent += d.v;
                                }
                                if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                                    finishReason = d.v;
                                }
                                if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                                    finishReason = d.v;
                                }
                            } catch (e) { }
                        }
                    }
                }

                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }

                return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError };
            }

            let { content: fullContent, reasoningContent, finishReason, modelError } = await readDeepSeekResponse(dsResp.body);
            fullContent = sanitizeContent(fullContent);
            reasoningContent = sanitizeContent(reasoningContent || '');
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            if ((!fullContent || fullContent.trim().length === 0) && modelError) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: modelError.content || 'DeepSeek returned an error without content', type: modelError.finish_reason || modelError.type || 'deepseek_model_error', model: requestedModel, real_model: resolveModelConfig(requestedModel).real_model } }));
                return;
            }

            // Empty response — retry loop with fresh sessions
            let retryAttempt = 0;
            const MAX_RETRIES = 10;
            while (!fullContent || fullContent.trim().length === 0) {
                retryAttempt++;
                if (retryAttempt > MAX_RETRIES) {
                    console.log(`${agentTag} Empty after ${MAX_RETRIES} retries. Giving up.`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: { 
                            message: `DeepSeek returned empty content after ${MAX_RETRIES} retries`, 
                            type: 'empty_response',
                            agent: agentId,
                            session_id: session.id,
                            message_count: session.messageCount,
                            history_length: session.history.length,
                            retry_attempts: retryAttempt - 1,
                        } 
                    }));
                    return;
                }
                console.log(`${agentTag} Empty response (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_RETRIES}). Resetting session...`);
                session.id = null;
                session.parentMessageId = null;
                session.createdAt = null;
                session.messageCount = 0;
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(1000 * retryAttempt, 5000)));
                const { resp: retryResp } = await askDeepSeekStream(fullPrompt, agentId, requestedModel);
                const retryResult = await readDeepSeekResponse(retryResp.body);
                const retryContent = retryResult && retryResult.content ? sanitizeContent(retryResult.content) : '';
                const retryReasoning = retryResult && retryResult.reasoningContent ? sanitizeContent(retryResult.reasoningContent) : '';
                if (retryContent && retryContent.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryContent;
                    reasoningContent = retryReasoning;
                }
            }

            // Auto-continuation: if finish_reason is 'length' or content is very long (>25000 chars),
            // send a continuation request to get the rest of the response
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while ((finishReason === 'length' || fullContent.length > 25000) && continuationRounds < MAX_CONTINUATION) {
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const { resp: contResp } = await askDeepSeekStream('continue', agentId, requestedModel);
                const contResult = await readDeepSeekResponse(contResp.body);
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += '\n' + contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            let toolCall = parseToolCall(fullContent);
            
            // Retry if TOOL_CALL was found but JSON was truncated/invalid
            if (!toolCall && /TOOL_CALL:\s*\w/i.test(fullContent)) {
                console.log(`${agentTag} TOOL_CALL detected but JSON invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                session.id = null;
                session.parentMessageId = null;
                session.createdAt = null;
                session.messageCount = 0;
                await new Promise(r => setTimeout(r, 1000));
                const strictPrompt = fullPrompt + '\n\n[STRICT INSTRUCTION] Your previous response had a TOOL_CALL but the arguments were too long and got cut off. Keep the arguments SHORT — no large file contents. Just use a minimal example or reference the file by name. Output ONLY: TOOL_CALL: <function>\narguments: <short JSON>';
                const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel);
                const retryResult2 = await readDeepSeekResponse(retryResp2.body);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = parseToolCall(retryContent2);
                    if (retryTc) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCall = retryTc;
                    } else {
                        console.log(`${agentTag} Retry still has broken JSON. Sending as text.`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }
            
            // Check if any tool results in the current conversation contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            if (!fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            storeHistory(agentId, prompt, fullContent, toolCall);

            // If we have reasoning content but the client might not support it natively (OpenAI-style),
            // prepend it to the content in a readable block if requested or by default for reasoner models.
            let finalContent = fullContent;
            if (reasoningContent && reasoningContent.trim().length > 0 && !toolCall) {
                // If it's not a tool call, we can safely prepend reasoning to the text.
                // For tool calls, we keep reasoning separate to avoid breaking JSON parsers in clients.
                finalContent = `<thought>\n${reasoningContent}\n</thought>\n\n${fullContent}`;
            }

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, fullPrompt, reasoningContent)
                : buildTextResponse(finalContent, fullPrompt, requestedModel, reasoningContent);

            if (stream) {
                if (apiMode === 'anthropic') {
                    sendAnthropicStream(res, openaiResponse);
                } else if (apiMode === 'responses') {
                    sendResponsesStream(res, openaiResponse);
                } else {
                    sendOpenAIStream(res, openaiResponse);
                }
                console.log(`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (apiMode === 'anthropic') {
                    res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
                } else if (apiMode === 'responses') {
                    res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
                } else {
                    res.end(JSON.stringify(openaiResponse));
                }
                console.log(`${agentTag} Response ${apiMode} (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
                writeLog(accountId, agentId, 'OUTGOING-RESPONSE', { mode: apiMode, tool: !!toolCall, elapsed, chars: fullContent.length });
            }
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            writeLog('system', 'system', 'SERVER-ERROR', { error: e.message, stack: e.stack });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
    });
});

async function runAuthScript(suffix = '') {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const env = { ...process.env };
    if (suffix) env.DEEPSEEK_AUTH_SUFFIX = suffix;
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
    loadDeepSeekConfig();
    return result.status === 0 && hasAuthConfig();
}

function printStatus() {
    console.log(`\n${formatWatermark()}`);
    console.log(`Аккаунтов загружено: ${accountPool.size}`);
    if (accountPool.size > 0) {
        console.log(`Список: ${Array.from(accountPool.keys()).join(', ')}`);
    } else {
        console.log(`❌ Аккаунты не найдены в ${DEEPSEEK_DIR}`);
    }
    console.log(`Рабочие модели: ${SUPPORTED_MODEL_IDS.length}`);
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        loadDeepSeekConfig();
        return hasAuthConfig();
    }
    while (true) {
        printStatus();
        console.log('1 - Добавить/обновить основной аккаунт (default)');
        console.log('2 - Добавить дополнительный аккаунт (с ID)');
        console.log('3 - Показать модели и статусы');
        console.log('4 - Запустить сервер (по умолчанию)');
        console.log('5 - Выход');
        let choice = await prompt('Ваш выбор (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') {
            await runAuthScript();
        } else if (choice === '2') {
            const id = await prompt('Введите ID для аккаунта (например, acc2): ');
            if (id) await runAuthScript(id);
        } else if (choice === '3') {
            console.log(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2));
            await prompt('\nНажмите Enter, чтобы вернуться в меню...');
        } else if (choice === '4') {
            if (!hasAuthConfig()) {
                console.log('Нужен хотя бы один аккаунт. Запустите пункт 1.');
                continue;
            }
            return true;
        } else if (choice === '5') {
            return false;
        }
    }
}

async function main() {
    printBanner();
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log(`[DS-API] ${formatWatermark()}`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
}

main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
