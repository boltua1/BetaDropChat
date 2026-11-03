// gemini-client.js — Zero-dependency client for Gemini Web Chat
// Features: StreamGenerate protocol + Exact Model Selection (innerStruct[79]/[80] + 17-elem JSPB + otAQ7b Account Model Discovery + SAPISIDHASH) + Persistent Session Binding (convId/respId/choiceId) + Image Upload + Canvas/Sandbox File Extraction + Background Cookie Rotation
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Canonical 2026 Google Gemini Web Model Specifications
// innerStruct[79] (modeCategory): 3 = PRO / 4 Argon, 2 = THINKING, 1 = FAST (3.8 Flash), 6 = FLASH_LITE (3.5 Flash-Lite)
// innerStruct[80] (expandedThinking): 2 = Expanded / High reasoning effort, 1 = Standard / Fast
// tierNum (x-goog-ext-525001261-jspb[14]): 3 = Pro/Argon, 1 = Flash, 6 = Flash-Lite
const GEMINI_CANONICAL_MODELS = {
    'gemini-4-argon': {
        canonicalId: 'gemini-4-argon',
        shortKey: 'argon',
        displayName: 'Google Gemini 4 Argon (Сложные задачи / Новинка)',
        defaultModeId: 'e6fa609c3fa255c0',
        modeCategory: 3,
        expandedThinking: 2,
        tierNum: 3,
    },
    'gemini-3.1-pro': {
        canonicalId: 'gemini-3.1-pro',
        shortKey: 'pro',
        displayName: 'Google Gemini 3.1 Pro (Расширенные возможности рассуждения)',
        defaultModeId: 'e6fa609c3fa255c0',
        modeCategory: 3,
        expandedThinking: 2,
        tierNum: 3,
    },
    'gemini-3.8-flash': {
        canonicalId: 'gemini-3.8-flash',
        shortKey: 'flash',
        displayName: 'Google Gemini 3.8 Flash (All-around help)',
        defaultModeId: '56fdd199312815e2',
        modeCategory: 1,
        expandedThinking: 1,
        tierNum: 1,
    },
    'gemini-3.5-flash-lite': {
        canonicalId: 'gemini-3.5-flash-lite',
        shortKey: 'lite',
        displayName: 'Google Gemini 3.5 Flash-Lite (Самые быстрые ответы)',
        defaultModeId: 'cf41b0e0dd7d53e5',
        modeCategory: 6,
        expandedThinking: 1,
        tierNum: 6,
    }
};

// Map every model ID and Claude Desktop / Claude Code alias to one of the 4 canonical Gemini models.
// IMPORTANT: Never map flagship/Pro models to null or Flash!
// - Fable 5.1 / Opus 5.5 -> gemini-4-argon (4 Argon)
// - Sonnet 5.5 / Sonnet 3.7 / Sonnet 3.5 -> gemini-3.1-pro (3.1 Pro)
// - Haiku 5.5 -> gemini-3.8-flash (3.8 Flash)
// - 3.5 Flash-Lite -> gemini-3.5-flash-lite (3.5 Flash-Lite)
const GEMINI_MODEL_ALIAS_MAP = {
    // 4 Argon aliases
    'gemini-4-argon': 'gemini-4-argon',
    'gemini-argon': 'gemini-4-argon',
    'claude-gemini-4-argon': 'gemini-4-argon',
    'argon': 'gemini-4-argon',
    '4-argon': 'gemini-4-argon',
    'claude-fable-5-1': 'gemini-4-argon',
    'claude-opus-5-5': 'gemini-4-argon',
    'claude-4-8': 'gemini-4-argon',
    'claude-4-5-20251001': 'gemini-4-argon',
    'claude-3-opus-20240229': 'gemini-4-argon',

    // 3.1 Pro aliases
    'gemini-3.1-pro': 'gemini-3.1-pro',
    'gemini-pro': 'gemini-3.1-pro',
    'claude-gemini-3.1-pro': 'gemini-3.1-pro',
    'pro': 'gemini-3.1-pro',
    '3.1-pro': 'gemini-3.1-pro',
    'claude-sonnet-5-5': 'gemini-3.1-pro',
    'claude-3-7-sonnet-20250219': 'gemini-3.1-pro',
    'claude-3-5-sonnet-latest': 'gemini-3.1-pro',
    'claude-3-5-sonnet-20241022': 'gemini-3.1-pro',
    'claude-3-5-sonnet-20240620': 'gemini-3.1-pro',

    // 3.8 Flash aliases
    'gemini-3.8-flash': 'gemini-3.8-flash',
    'gemini-flash': 'gemini-3.8-flash',
    'claude-gemini-3.8-flash': 'gemini-3.8-flash',
    'flash': 'gemini-3.8-flash',
    '3.8-flash': 'gemini-3.8-flash',
    'claude-haiku-5-5': 'gemini-3.8-flash',
    'claude-3-5-haiku-20241022': 'gemini-3.8-flash',
    'claude-3-haiku-20240307': 'gemini-3.8-flash',

    // 3.5 Flash-Lite aliases
    'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-lite': 'gemini-3.5-flash-lite',
    'claude-gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
    'lite': 'gemini-3.5-flash-lite',
    'flash-lite': 'gemini-3.5-flash-lite',
    '3.5-flash-lite': 'gemini-3.5-flash-lite',
};

// Backwards-compatible map of non-null modeIds
const GEMINI_MODE_IDS = Object.fromEntries(
    Object.entries(GEMINI_MODEL_ALIAS_MAP).map(([alias, canonical]) => [
        alias,
        GEMINI_CANONICAL_MODELS[canonical].defaultModeId
    ])
);

const CANNED_ERROR_PATTERNS = [
    "i'm having a hard time fulfilling your request",
    "i am having a hard time fulfilling your request",
    "i encountered an error doing what you asked",
    "sorry, something went wrong",
    "i seem to be encountering an error",
    "i can't help with that right now",
    "i'm unable to help you with that"
];

class GeminiClient {
    constructor(options = {}) {
        this.baseDir = options.dir || path.join(__dirname, '.gemini');
        this.authFile = options.authFile || path.join(this.baseDir, 'gemini-auth.json');
        this.sessionsFile = options.sessionsFile || path.join(this.baseDir, 'gemini-sessions.json');
        this.conversationId = options.conversationId || '';
        this.responseId = '';
        this.choiceId = '';
        this.bl = 'boq_assistant-bard-web-server_20261001.00_p0';
        this.fSid = '';
        this.uploadPushId = 'feeds/mcudyrk2a4khkz';
        this.clientUuid = crypto.randomUUID ? crypto.randomUUID().toUpperCase() : '09D681E7-26F2-4A94-A465-38386B7AB93B';
        this.ephemeralMode = false;
        this.sessionInitialized = false;
        this.modelsDiscovered = false;
        this.lastRotateAt = 0;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        this.auth = this.loadAuth();
        this.sessionStore = this.loadSessionStore();
        this.startBackgroundKeepAlive();
    }

    loadAuth() {
        if (fs.existsSync(this.authFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
                if (data.bl) this.bl = data.bl;
                if (data.fSid) this.fSid = data.fSid;
                if (data.pushId) this.uploadPushId = data.pushId;
                return data;
            } catch (e) {
                console.error('[Gemini] Error reading auth file:', e.message);
            }
        }
        return {
            cookie: process.env.GEMINI_COOKIE || '',
            snlm0e: process.env.GEMINI_SNLM0E || '',
            psid: process.env.GEMINI_PSID || '',
            psidts: process.env.GEMINI_PSIDTS || ''
        };
    }

    /**
     * Load persistent mapping between Claude Code/Desktop sessions and Gemini Web conversations
     * so chat context (`c_...`, `r_...`, `rc_...`) survives server restarts and session ID changes.
     */
    loadSessionStore() {
        const empty = { byAgentId: {}, byFingerprint: {}, byConvId: {}, lastActiveConvId: null };
        if (fs.existsSync(this.sessionsFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
                return {
                    byAgentId: parsed.byAgentId || {},
                    byFingerprint: parsed.byFingerprint || {},
                    byConvId: parsed.byConvId || {},
                    lastActiveConvId: parsed.lastActiveConvId || null
                };
            } catch (e) {
                console.warn('[Gemini] Could not parse gemini-sessions.json, starting fresh:', e.message);
            }
        }
        return empty;
    }

    saveSessionStore() {
        try {
            if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
            fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessionStore, null, 2));
        } catch (e) {
            console.warn('[Gemini] Could not save gemini-sessions.json:', e.message);
        }
    }

    /**
     * Normalize a user-supplied Gemini chat URL or ID (e.g. "https://gemini.google.com/app/30c7811b8519553d"
     * or "30c7811b8519553d" or "c_30c7811b8519553d") into the RPC format "c_30c7811b8519553d".
     */
    static normalizeConvId(input) {
        if (!input || typeof input !== 'string') return '';
        const trimmed = input.trim();
        const urlMatch = trimmed.match(/gemini\.google\.com\/(?:u\/\d+\/)?app\/([a-zA-Z0-9_-]+)/i);
        const raw = urlMatch ? urlMatch[1] : trimmed;
        if (!raw) return '';
        return raw.startsWith('c_') ? raw : `c_${raw}`;
    }

    static formatConvUrl(convId) {
        if (!convId || typeof convId !== 'string') return '';
        const cleanId = convId.replace(/^c_/, '');
        return `https://gemini.google.com/app/${cleanId}`;
    }

    static computeConversationFingerprint(firstUserMessage = '') {
        const clean = String(firstUserMessage || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
        if (!clean) return '';
        return crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16);
    }

    /**
     * Resolve an existing Gemini Web conversation binding for a given Claude session (`agentId`)
     * or conversation fingerprint (first user message hash), or pinned `preferredChatId`.
     */
    getSessionBinding(agentId, fingerprint = '', preferredChatId = null) {
        this.sessionStore = this.loadSessionStore();

        if (preferredChatId) {
            const normPref = GeminiClient.normalizeConvId(preferredChatId);
            if (normPref) {
                const known = this.sessionStore.byConvId[normPref];
                return known || { convId: normPref, respId: '', choiceId: '', turnCount: 1, pinned: true };
            }
        }

        if (agentId && this.sessionStore.byAgentId[agentId]) {
            const entry = this.sessionStore.byAgentId[agentId];
            if (entry && entry.convId) {
                // If fingerprint is provided and belongs to a completely different new chat ("New Chat" in UI with same agentId), check mismatch
                if (fingerprint && entry.fingerprint && entry.fingerprint !== fingerprint && entry.turnCount > 0 && !entry.manualBind) {
                    // User clicked "New Chat" while reusing the same agentId
                    return null;
                }
                return entry;
            }
        }

        if (fingerprint && this.sessionStore.byFingerprint[fingerprint]) {
            const entry = this.sessionStore.byFingerprint[fingerprint];
            if (entry && entry.convId) {
                if (agentId) {
                    this.sessionStore.byAgentId[agentId] = entry;
                    this.saveSessionStore();
                }
                return entry;
            }
        }

        return null;
    }

    /**
     * Save or update the binding between a Claude session and a Gemini Web conversation.
     */
    saveSessionBinding(agentId, fingerprint, { convId, respId, choiceId, model, manualBind = false }) {
        if (!convId) return null;
        const normConvId = GeminiClient.normalizeConvId(convId);
        const prev = (agentId && this.sessionStore.byAgentId[agentId]) || this.sessionStore.byConvId[normConvId] || {};
        const record = {
            convId: normConvId,
            respId: respId !== undefined ? respId : (prev.respId || ''),
            choiceId: choiceId !== undefined ? choiceId : (prev.choiceId || ''),
            model: model || prev.model || 'gemini-4-argon',
            fingerprint: fingerprint || prev.fingerprint || '',
            turnCount: (prev.convId === normConvId ? (prev.turnCount || 0) : 0) + 1,
            manualBind: Boolean(manualBind || prev.manualBind),
            url: GeminiClient.formatConvUrl(normConvId),
            updatedAt: new Date().toISOString()
        };

        if (agentId) this.sessionStore.byAgentId[agentId] = record;
        if (record.fingerprint) this.sessionStore.byFingerprint[record.fingerprint] = record;
        this.sessionStore.byConvId[normConvId] = record;
        this.sessionStore.lastActiveConvId = normConvId;
        this.saveSessionStore();
        return record;
    }

    clearSessionBinding(agentId, fingerprint = '') {
        if (agentId && this.sessionStore.byAgentId[agentId]) {
            const oldFp = this.sessionStore.byAgentId[agentId].fingerprint;
            delete this.sessionStore.byAgentId[agentId];
            if (oldFp && this.sessionStore.byFingerprint[oldFp]) {
                delete this.sessionStore.byFingerprint[oldFp];
            }
        }
        if (fingerprint && this.sessionStore.byFingerprint[fingerprint]) {
            delete this.sessionStore.byFingerprint[fingerprint];
        }
        this.saveSessionStore();
    }

    bindSessionToConv(agentId, fingerprint, rawConvIdOrUrl) {
        const normConvId = GeminiClient.normalizeConvId(rawConvIdOrUrl);
        if (!normConvId) return null;
        const existing = this.sessionStore.byConvId[normConvId] || {};
        return this.saveSessionBinding(agentId, fingerprint, {
            convId: normConvId,
            respId: existing.respId || '',
            choiceId: existing.choiceId || '',
            model: existing.model || 'gemini-4-argon',
            manualBind: true
        });
    }

    /**
     * Background keep-alive: rotates `__Secure-1PSIDTS` every 10 minutes and refreshes SNlM0e
     * so the Google Web session doesn't expire during idle periods.
     */
    startBackgroundKeepAlive(intervalMs = 10 * 60 * 1000) {
        if (this._keepAliveTimer) return;
        this._keepAliveTimer = setInterval(async () => {
            if (!this.isReady()) return;
            try {
                await this.rotateCookies();
            } catch {}
        }, intervalMs);
        if (typeof this._keepAliveTimer.unref === 'function') {
            this._keepAliveTimer.unref();
        }
    }

    isReady() {
        this.auth = this.loadAuth();
        return Boolean(this.auth.cookie || this.auth.psid);
    }

    getCookieMap() {
        const map = new Map();
        if (this.auth.cookie && this.auth.cookie.trim().length > 0) {
            for (const part of this.auth.cookie.split(';')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const k = trimmed.substring(0, eqIdx).trim();
                    const v = trimmed.substring(eqIdx + 1).trim();
                    map.set(k, v);
                }
            }
        }
        if (this.auth.psid) map.set('__Secure-1PSID', this.auth.psid);
        if (this.auth.psidts) map.set('__Secure-1PSIDTS', this.auth.psidts);
        return map;
    }

    getCookieHeader() {
        const map = this.getCookieMap();
        if (map.size === 0) return '';
        return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    updateCookiesFromResponse(resHeaders) {
        const setCookie = resHeaders && resHeaders['set-cookie'];
        if (!Array.isArray(setCookie) || setCookie.length === 0) return;
        const map = this.getCookieMap();
        let changed = false;
        for (const sc of setCookie) {
            const m = String(sc).match(/^([^=;\s]+)=([^;]*)/);
            if (!m) continue;
            const [, name, val] = m;
            if (!val || val === 'deleted') continue;
            if (map.get(name) !== val) {
                map.set(name, val);
                changed = true;
            }
            if (name === '__Secure-1PSID') {
                this.auth.psid = val;
                changed = true;
            } else if (name === '__Secure-1PSIDTS') {
                this.auth.psidts = val;
                changed = true;
            }
        }
        if (changed) {
            this.auth.cookie = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
            try {
                if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
                fs.writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2));
            } catch {}
        }
    }

    async rotateCookies() {
        if (Date.now() - this.lastRotateAt < 55000) return false;
        this.lastRotateAt = Date.now();
        return new Promise((resolve) => {
            const body = '[000,"-0000000000000000000"]';
            const req = https.request({
                hostname: 'accounts.google.com',
                path: '/RotateCookies',
                method: 'POST',
                maxHeaderSize: 262144,
                headers: {
                    'User-Agent': this.userAgent,
                    'Cookie': this.getCookieHeader(),
                    'Content-Type': 'application/json',
                    'Origin': 'https://gemini.google.com',
                    'Referer': 'https://gemini.google.com/',
                    'Content-Length': String(Buffer.byteLength(body))
                }
            }, (res) => {
                this.updateCookiesFromResponse(res.headers);
                res.on('data', () => {});
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        console.log('[Gemini] 🔄 Rotated Google session cookies (__Secure-1PSIDTS)');
                    }
                    resolve(res.statusCode === 200);
                });
            });
            req.on('error', () => resolve(false));
            req.write(body);
            req.end();
        });
    }

    isCannedError(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.trim().toLowerCase();
        if (lower.length > 220) return false;
        return CANNED_ERROR_PATTERNS.some(pat => lower.includes(pat));
    }

    /**
     * Extract files generated inside Gemini Web's internal Python runner (`python?code_reference`)
     * before stripping internal code_reference blocks.
     */
    extractFilesFromPythonRunner(rawText = '') {
        const files = [];
        if (!rawText || typeof rawText !== 'string') return files;

        const mentionedFileMatch = rawText.match(/`([a-zA-Z0-9_.-]+\.(?:html|htm|jsx|tsx|js|ts|css|py|svg|json|md))`/i)
            || rawText.match(/\b([a-zA-Z0-9_-]+\.(?:html|htm|jsx|tsx|js|ts|css|py|svg|json|md))\b/i);
        const fallbackFileName = mentionedFileMatch ? mentionedFileMatch[1] : 'index.html';

        const pyBlockRe = /```(?:python|javascript|text)\?code_reference&code_event_index=\d+\n([\s\S]*?)```/gi;
        let match;
        while ((match = pyBlockRe.exec(rawText)) !== null) {
            const pyCode = match[1] || '';
            if (pyCode.length < 200 && /(?:google_search|browsing|workspace|concierge|extensions)\./i.test(pyCode)) {
                continue;
            }

            const openMatch = pyCode.match(/open\(\s*['"]([^'"]+\.[a-zA-Z0-9]{1,8})['"]\s*,\s*['"]w/i)
                || pyCode.match(/Path\(\s*['"]([^'"]+\.[a-zA-Z0-9]{1,8})['"]\s*\)/i)
                || pyCode.match(/filename\s*=\s*['"]([^'"]+\.[a-zA-Z0-9]{1,8})['"]/i);
            const fileName = openMatch ? path.basename(openMatch[1]) : fallbackFileName;

            let bestBody = '';
            const tripleDoubleRe = /"""([\s\S]*?)"""/g;
            let td;
            while ((td = tripleDoubleRe.exec(pyCode)) !== null) {
                if (td[1] && td[1].length > bestBody.length) bestBody = td[1];
            }
            const tripleSingleRe = /'''([\s\S]*?)'''/g;
            let ts;
            while ((ts = tripleSingleRe.exec(pyCode)) !== null) {
                if (ts[1] && ts[1].length > bestBody.length) bestBody = ts[1];
            }

            if (!bestBody || bestBody.length < 60) {
                const b64Match = pyCode.match(/b64decode\(\s*['"]([A-Za-z0-9+/=\s]{80,})['"]\s*\)/);
                if (b64Match) {
                    try {
                        bestBody = Buffer.from(b64Match[1].replace(/\s+/g, ''), 'base64').toString('utf8');
                    } catch {}
                }
            }

            if (bestBody && bestBody.trim().length >= 60) {
                files.push({
                    name: fileName,
                    content: bestBody.trim(),
                    source: 'python_code_reference'
                });
            }
        }
        return files;
    }

    /**
     * Extract `<file_write path="...">...</file_write>` or `<artifact_code filename="...">...</artifact_code>`
     * or `<immersive ...>...</immersive>` blocks from text.
     */
    extractTaggedFilesFromText(rawText = '') {
        const files = [];
        if (!rawText || typeof rawText !== 'string') return files;

        const tagPatterns = [
            /<file_write\b[^>]*?\b(?:path|name|filename)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/file_write>/gi,
            /<artifact_code\b[^>]*?\b(?:filename|name|path)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/artifact_code>/gi,
            /<immersive\b[^>]*?\b(?:id|title)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/immersive>/gi
        ];

        for (const re of tagPatterns) {
            let m;
            while ((m = re.exec(rawText)) !== null) {
                let rawName = (m[1] || 'index.html').trim();
                let body = (m[2] || '').trim();
                const innerFence = body.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)```$/);
                if (innerFence) body = innerFence[1].trim();
                if (body.length >= 60) {
                    if (!/\.[a-z0-9]{1,6}$/i.test(rawName)) {
                        const isHtml = /<!DOCTYPE\s+html|<html[\s>]/i.test(body);
                        const isReact = /import\s+React|export\s+default\s+function/i.test(body);
                        rawName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() + (isHtml ? '.html' : (isReact ? '.jsx' : '.html'));
                    }
                    files.push({
                        name: path.basename(rawName),
                        content: body,
                        source: 'xml_tag'
                    });
                }
            }
        }
        return files;
    }

    /**
     * Clean internal Gemini Web virtual URIs (such as http://googleusercontent.com/lmdx_content/...
     * or immersive_entry_chip/image_generation_content), inline <ctrl94>thought...<ctrl95> blocks,
     * [file-tag: code-generated-file-...], [cite: ...], and wrapped Google redirect links.
     */
    cleanGeminiResponse(rawText = '', rawReasoning = '', extractedFiles = []) {
        let text = String(rawText || '');
        let reasoning = String(rawReasoning || '');

        const inlineThoughtRe = /<ctrl94>(?:thought\s*)?([\s\S]*?)<ctrl95>/gi;
        let match;
        while ((match = inlineThoughtRe.exec(text)) !== null) {
            const thoughtChunk = (match[1] || '').trim();
            if (thoughtChunk && !reasoning.includes(thoughtChunk)) {
                reasoning = reasoning ? `${reasoning}\n${thoughtChunk}` : thoughtChunk;
            }
        }
        text = text.replace(inlineThoughtRe, '');

        text = text.replace(/<(?:file_write|artifact_code|immersive)\b[^>]*>([\s\S]*?)<\/(?:file_write|artifact_code|immersive)>/gi, (_, inner) => {
            const trimmed = String(inner || '').trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('```')) return `\n\n${trimmed}\n\n`;
            const lang = /<!DOCTYPE\s+html|<html[\s>]/i.test(trimmed) ? 'html' : (/import\s+React|export\s+default/i.test(trimmed) ? 'jsx' : 'html');
            return `\n\n\`\`\`${lang}\n${trimmed}\n\`\`\`\n\n`;
        });

        text = text.replace(/https?:\/\/googleusercontent\.com\/(?:lmdx_content|immersive_entry_chip|image_generation_content|youtube_content|map_content|tool_content|[a-z0-9_]+)\/[^\s)\]>"]+/gi, '');
        text = text.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/gi, '');
        text = text.replace(/(?:Your [A-Za-z0-9_ -]+ file is ready\s*\n?)?\[file-tag:\s*code-generated-file-[^\]]+\]\s*\n?/gi, '');
        text = text.replace(/\[cite:\s*[\d,\s]+\]/gi, '');
        text = text.replace(/<!--\s*end list\s*-->/gi, '');

        text = text.replace(/\(https:\/\/www\.google\.com\/(?:search\?q=|url\?sa=E&source=gmail&q=)(https?:\/\/[^)\s]+)\)/gi, (_, innerUrl) => {
            try {
                return `(${decodeURIComponent(innerUrl)})`;
            } catch {
                return `(${innerUrl})`;
            }
        });

        if (Array.isArray(extractedFiles) && extractedFiles.length > 0 && !/```|"tool_call"/i.test(text)) {
            for (const f of extractedFiles) {
                const ext = path.extname(f.name || '').replace(/^\./, '').toLowerCase() || 'html';
                text += `\n\n\`\`\`${ext}\n${f.content}\n\`\`\``;
            }
        }

        text = text.replace(/\n{3,}/g, '\n\n').trim();
        reasoning = reasoning
            .replace(/https?:\/\/googleusercontent\.com\/[^\s)\]>"]+/gi, '')
            .replace(/\[cite:\s*[\d,\s]+\]/gi, '')
            .trim();

        return { text, reasoning };
    }

    /**
     * Resolve any requested model name or Claude alias to its full Gemini specification,
     * incorporating any account-specific modeId hashes discovered via batchexecute (otAQ7b) or /app.
     */
    resolveModelSpec(model = 'gemini-4-argon') {
        const key = String(model || 'gemini-4-argon').trim().toLowerCase();
        const canonicalId = GEMINI_MODEL_ALIAS_MAP[key]
            || (key.includes('argon') || key.includes('opus') || key.includes('fable') ? 'gemini-4-argon'
                : (key.includes('pro') || key.includes('sonnet') ? 'gemini-3.1-pro'
                    : (key.includes('lite') ? 'gemini-3.5-flash-lite' : 'gemini-3.8-flash')));
        const baseSpec = GEMINI_CANONICAL_MODELS[canonicalId] || GEMINI_CANONICAL_MODELS['gemini-4-argon'];
        const discovered = (this.auth && this.auth.discoveredModels) || {};
        const customEntry = discovered[canonicalId];
        const modeId = (customEntry && customEntry.modeId) || baseSpec.defaultModeId;
        const modeCategory = (customEntry && typeof customEntry.modeCategory === 'number')
            ? customEntry.modeCategory
            : baseSpec.modeCategory;
        const expandedThinking = (customEntry && typeof customEntry.expandedThinking === 'number')
            ? customEntry.expandedThinking
            : baseSpec.expandedThinking;
        const tierNum = (customEntry && typeof customEntry.tierNum === 'number')
            ? customEntry.tierNum
            : baseSpec.tierNum;

        return {
            ...baseSpec,
            requestedModel: key,
            modeId,
            modeCategory,
            expandedThinking,
            tierNum,
        };
    }

    /**
     * Build the 17-element x-goog-ext-525001261-jspb header required by 2026 Google Gemini Web
     * to actually switch the active backend model (4 Argon, 3.1 Pro, 3.8 Flash, 3.5 Flash-Lite)
     * instead of falling back to the default Fast model.
     */
    getModelHeader(model = 'gemini-4-argon', retryStage = 0, hasImages = false) {
        const spec = this.resolveModelSpec(model);
        const uuid = this.clientUuid || '09D681E7-26F2-4A94-A465-38386B7AB93B';

        if (retryStage === 0) {
            return JSON.stringify([
                1,
                null,
                null,
                null,
                spec.modeId,
                null,
                null,
                0,
                [4, 5, 6, 8],
                null,
                null,
                2,
                null,
                null,
                spec.tierNum,
                1,
                uuid
            ]);
        }

        if (retryStage === 1) {
            // Stage 1: Compact 5-element JSPB header, still preserving the EXACT requested modeId!
            return JSON.stringify([1, null, null, null, spec.modeId]);
        }

        // Stage 2 (last-resort emergency retry if account rejects the modeId): keep compact header for Flash/Lite or omit if restricted
        return spec.modeId ? JSON.stringify([1, null, null, null, spec.modeId]) : null;
    }

    /**
     * Generate SAPISIDHASH Authorization header from __Secure-1PAPISID or SAPISID cookie when available.
     * Used by gemini.google.com first-party web client when authenticating Pro / Argon model requests.
     */
    getSapisidHashHeader() {
        const map = this.getCookieMap();
        const sapisid = map.get('__Secure-1PAPISID') || map.get('SAPISID') || map.get('__Secure-3PAPISID');
        if (!sapisid) return null;
        const ts = Math.floor(Date.now() / 1000);
        const origin = 'https://gemini.google.com';
        const sha1 = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex');
        return `SAPISIDHASH ${ts}_${sha1}`;
    }

    resolveTargetGeminiName(model = 'gemini-4-argon') {
        const spec = this.resolveModelSpec(model);
        return `${spec.canonicalId} (${spec.displayName} | mode=${spec.modeCategory}, tier=${spec.tierNum}, id=${spec.modeId})`;
    }

    /**
     * Parse raw text (from batchexecute otAQ7b or /app HTML) to discover account-specific 16-char hex modeIds
     * for 4 Argon, 3.1 Pro, 3.8 Flash, and 3.5 Flash-Lite.
     */
    parseDiscoveredModelsFromPayload(rawText = '') {
        if (!rawText || typeof rawText !== 'string') return {};
        const found = {};
        const unescaped = rawText.replace(/\\"/g, '"').replace(/\\u0026/g, '&');

        // Look for 16-char hex IDs near model display names in serialized JSON arrays
        const regex = /"([0-9a-f]{16})"[^\[\]\n]{0,160}?"([^"]{2,60})"/gi;
        let m;
        while ((m = regex.exec(unescaped)) !== null) {
            const hexId = m[1].toLowerCase();
            const label = m[2].trim();
            this._classifyDiscoveredModel(hexId, label, found);
        }

        // Also check reverse order: ["Label", ..., "16hex"]
        const revRegex = /"([^"]{2,60})"[^\[\]\n]{0,160}?"([0-9a-f]{16})"/gi;
        while ((m = revRegex.exec(unescaped)) !== null) {
            const label = m[1].trim();
            const hexId = m[2].toLowerCase();
            this._classifyDiscoveredModel(hexId, label, found);
        }

        return found;
    }

    _classifyDiscoveredModel(hexId, label, found) {
        if (!/^[0-9a-f]{16}$/.test(hexId) || !label) return;
        const lower = label.toLowerCase();
        if (lower.includes('argon') || lower.includes('4 argon')) {
            found['gemini-4-argon'] = { modeId: hexId, label, modeCategory: 3, expandedThinking: 2, tierNum: 3 };
        } else if (lower.includes('3.1 pro') || (lower.includes('pro') && !lower.includes('flash'))) {
            found['gemini-3.1-pro'] = { modeId: hexId, label, modeCategory: 3, expandedThinking: 2, tierNum: 3 };
        } else if (lower.includes('flash-lite') || lower.includes('flash lite') || lower.includes('3.5')) {
            found['gemini-3.5-flash-lite'] = { modeId: hexId, label, modeCategory: 6, expandedThinking: 1, tierNum: 6 };
        } else if (lower.includes('3.8 flash') || (lower.includes('flash') && !lower.includes('lite'))) {
            found['gemini-3.8-flash'] = { modeId: hexId, label, modeCategory: 1, expandedThinking: 1, tierNum: 1 };
        }
    }

    /**
     * Query Google Gemini Web's `otAQ7b` RPC (batchexecute) to discover exact model IDs enabled on the account.
     */
    async fetchAccountModelsOnce() {
        if (!this.auth.snlm0e) return null;
        return new Promise((resolve) => {
            const rpcReq = JSON.stringify([[['otAQ7b', '[]', null, 'generic']]]);
            const postData = new URLSearchParams({
                'f.req': rpcReq,
                'at': this.auth.snlm0e
            }).toString();

            const reqId = Math.floor(100000 + Math.random() * 900000);
            const queryObj = {
                'rpcids': 'otAQ7b',
                'source-path': '/app',
                'bl': this.bl,
                'hl': 'ru',
                '_reqid': String(reqId),
                'rt': 'c'
            };
            if (this.fSid) queryObj['f.sid'] = this.fSid;

            const headers = {
                'User-Agent': this.userAgent,
                'Cookie': this.getCookieHeader(),
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'Origin': 'https://gemini.google.com',
                'Referer': 'https://gemini.google.com/app',
                'X-Same-Domain': '1',
                'x-goog-ext-525001261-jspb': '[1,null,null,null,null,null,null,null,[4]]',
                'Content-Length': String(Buffer.byteLength(postData))
            };
            const sapisidHdr = this.getSapisidHashHeader();
            if (sapisidHdr) headers['Authorization'] = sapisidHdr;

            const req = https.request({
                hostname: 'gemini.google.com',
                path: `/_/BardChatUi/data/batchexecute?${new URLSearchParams(queryObj).toString()}`,
                method: 'POST',
                maxHeaderSize: 262144,
                headers
            }, (res) => {
                this.updateCookiesFromResponse(res.headers);
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const discovered = this.parseDiscoveredModelsFromPayload(body);
                        this.modelsDiscovered = true;
                        if (Object.keys(discovered).length > 0) {
                            this.auth.discoveredModels = { ...(this.auth.discoveredModels || {}), ...discovered };
                            if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
                            fs.writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2));
                            console.log('[Gemini] 🎯 Discovered account model IDs (otAQ7b):', JSON.stringify(this.auth.discoveredModels));
                        }
                        resolve(this.auth.discoveredModels || {});
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.write(postData);
            req.end();
        });
    }

    async fetchAppTokensOnce() {
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'gemini.google.com',
                path: '/app',
                method: 'GET',
                maxHeaderSize: 262144,
                headers: {
                    'User-Agent': this.userAgent,
                    'Cookie': this.getCookieHeader(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            }, (res) => {
                this.updateCookiesFromResponse(res.headers);
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', async () => {
                    const blMatch = data.match(/"cfb2h":"([^"]+)"/) || data.match(/(boq_assistant-bard-web-server_[A-Za-z0-9_.-]+)/);
                    if (blMatch && blMatch[1]) {
                        this.bl = blMatch[1];
                        this.auth.bl = this.bl;
                    }
                    const sidMatch = data.match(/"FdrFJe":"([\d-]+)"/);
                    if (sidMatch && sidMatch[1]) {
                        this.fSid = sidMatch[1];
                        this.auth.fSid = this.fSid;
                    }
                    const pushMatch = data.match(/"qKIAYe":"([^"]+)"/);
                    if (pushMatch && pushMatch[1]) {
                        this.uploadPushId = pushMatch[1];
                        this.auth.pushId = this.uploadPushId;
                    }
                    // Also check /app HTML for any embedded model IDs
                    const htmlModels = this.parseDiscoveredModelsFromPayload(data);
                    if (Object.keys(htmlModels).length > 0) {
                        this.auth.discoveredModels = { ...(this.auth.discoveredModels || {}), ...htmlModels };
                    }
                    const match = data.match(/"SNlM0e":"([^"]+)"/);
                    if (match && match[1]) {
                        this.auth.snlm0e = match[1];
                        this.sessionInitialized = true;
                        try {
                            if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
                            fs.writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2));
                        } catch {}
                        console.log(`[Gemini] ✅ Refreshed SNlM0e token (${this.auth.snlm0e.length} chars), bl=${this.bl}, f.sid=${this.fSid ? 'OK' : 'none'}`);
                        try {
                            await this.fetchAccountModelsOnce();
                        } catch {}
                        resolve(this.auth.snlm0e);
                    } else {
                        resolve(null);
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    async refreshSNlM0e() {
        let token = await this.fetchAppTokensOnce();
        if (!token) {
            const rotated = await this.rotateCookies();
            if (rotated) {
                token = await this.fetchAppTokensOnce();
            }
        }
        if (token) return token;
        console.warn('[Gemini] ⚠️ Не удалось получить токен SNlM0e (сессия Google могла истечь и перейти в гостевой режим). Для работы с картинками выполните: node scripts/auth.js');
        return this.auth.snlm0e || '';
    }

    // Upload a single image to Google Gemini Web storage (content-push.googleapis.com/upload/)
    async uploadImage(imageObj, index = 0, includeCookies = false) {
        const mediaType = imageObj.mediaType || 'image/png';
        const ext = (mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const fileName = imageObj.name || `image_${index + 1}.${ext}`;
        const imgBuffer = Buffer.isBuffer(imageObj.data)
            ? imageObj.data
            : Buffer.from(String(imageObj.data || ''), 'base64');

        if (!imgBuffer || imgBuffer.length === 0) {
            throw new Error('Empty image buffer');
        }

        const pushId = this.auth.pushId || this.uploadPushId || 'feeds/mcudyrk2a4khkz';
        const commonHeaders = {
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.7',
            'Authorization': 'Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Origin': 'https://gemini.google.com',
            'Referer': 'https://gemini.google.com/',
            'Push-ID': pushId,
            'X-Goog-Upload-Header-Content-Length': String(imgBuffer.length),
            'X-Goog-Upload-Header-Content-Type': mediaType,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Tenant-Id': 'bard-storage',
            'User-Agent': this.userAgent
        };
        if (includeCookies) {
            const cookieHdr = this.getCookieHeader();
            if (cookieHdr) commonHeaders['Cookie'] = cookieHdr;
        }

        const startBody = `File name: ${fileName}`;
        const uploadUrl = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'content-push.googleapis.com',
                path: '/upload/',
                method: 'POST',
                maxHeaderSize: 262144,
                headers: {
                    ...commonHeaders,
                    'size': String(imgBuffer.length),
                    'X-Goog-Upload-Command': 'start',
                    'Content-Length': String(Buffer.byteLength(startBody))
                }
            }, (res) => {
                let respData = '';
                res.on('data', c => respData += c);
                res.on('end', () => {
                    const headerUrl = res.headers['x-goog-upload-url'];
                    if (headerUrl) {
                        resolve(Array.isArray(headerUrl) ? headerUrl[0] : headerUrl);
                    } else {
                        reject(new Error(`Gemini image upload init failed (HTTP ${res.statusCode}): ${respData.substring(0, 150)}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(startBody);
            req.end();
        });

        const parsedUploadUrl = new URL(uploadUrl);
        const identifier = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: parsedUploadUrl.hostname,
                path: parsedUploadUrl.pathname + parsedUploadUrl.search,
                method: 'POST',
                maxHeaderSize: 262144,
                headers: {
                    ...commonHeaders,
                    'size': String(imgBuffer.length),
                    'X-Goog-Upload-Command': 'upload, finalize',
                    'X-Goog-Upload-Offset': '0',
                    'Content-Length': String(imgBuffer.length)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const trimmed = body.trim();
                    if (res.statusCode >= 200 && res.statusCode < 300 && trimmed) {
                        resolve(trimmed);
                    } else {
                        reject(new Error(`Gemini image upload finalize failed (HTTP ${res.statusCode}): ${trimmed.substring(0, 150)}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(imgBuffer);
            req.end();
        });

        console.log(`[Gemini] 🖼️ Uploaded image "${fileName}" (${Math.round(imgBuffer.length / 1024)} KB, ${mediaType}) -> ${identifier.substring(0, 48)}...`);
        return { identifier, name: fileName, mediaType };
    }

    async uploadImages(images = [], includeCookies = false) {
        if (!Array.isArray(images) || images.length === 0) return [];
        const uploaded = [];
        for (let i = 0; i < images.length; i++) {
            try {
                const res = await this.uploadImage(images[i], i, includeCookies);
                if (res && res.identifier) uploaded.push(res);
            } catch (err) {
                console.error(`[Gemini] ⚠️ Failed to upload image #${i + 1}:`, err.message);
            }
        }
        return uploaded;
    }

    /**
     * Recursively scan a wrb.fr payload (outside candidate[1] main text and candidate[37] reasoning)
     * for any Gemini Canvas / immersive attachment filenames and source code strings.
     */
    scanPayloadForCanvasFiles(node, mainText, reasoningText, state = { files: [], currentName: null, depth: 0 }) {
        if (!node || state.depth > 14) return state.files;
        if (typeof node === 'string') {
            const trimmed = node.trim();
            const canvasIdMatch = trimmed.match(/^c_[0-9a-f]+_([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})$/i);
            if (canvasIdMatch) {
                state.currentName = canvasIdMatch[1];
                return state.files;
            }
            if (/^[A-Za-z0-9_-]+\.(?:jsx|tsx|html|htm|js|ts|py|css|svg)$/i.test(trimmed)) {
                state.currentName = trimmed;
                return state.files;
            }
            if (trimmed.length > 40 && ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) && !trimmed.includes('\nfunction ') && !trimmed.includes('import React')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    this.scanPayloadForCanvasFiles(parsed, mainText, reasoningText, { ...state, depth: state.depth + 1 });
                    return state.files;
                } catch {}
            }
            if (
                node.length >= 100 &&
                node !== mainText &&
                node !== reasoningText &&
                node.includes('\n') &&
                !/^https?:\/\/\S+$/i.test(trimmed) &&
                /(?:<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<div[\s>]|<canvas[\s>]|<svg[\s>]|<script[\s>]|<style[\s>]|\bimport\s+[\w{*]|\bexport\s+default\b|\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|\buseEffect\s*\(|\buseState\s*\(|\brequestAnimationFrame\s*\(|\bclassName=)/i.test(node)
            ) {
                const isHtml = /<!DOCTYPE\s+html|<html[\s>]/i.test(node);
                const isReact = /\bimport\s+React\b|\bfrom\s+['"]react['"]|\bexport\s+default\s+function\b/i.test(node);
                const defaultName = isHtml ? 'index.html' : (isReact ? 'App.jsx' : 'app.js');
                const fileName = state.currentName || defaultName;
                state.files.push({
                    name: fileName,
                    content: node.trim(),
                    source: 'wrb_canvas_payload'
                });
            }
            return state.files;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                this.scanPayloadForCanvasFiles(node[i], mainText, reasoningText, { ...state, depth: state.depth + 1 });
            }
        } else if (typeof node === 'object') {
            for (const val of Object.values(node)) {
                this.scanPayloadForCanvasFiles(val, mainText, reasoningText, { ...state, depth: state.depth + 1 });
            }
        }
        return state.files;
    }

    extractDataFromWrbLine(line) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('[[')) return null;
        try {
            const outer = JSON.parse(trimmed);
            if (!Array.isArray(outer)) return null;

            let text = null;
            let reasoning = null;
            let convId = null;
            let respId = null;
            let choiceId = null;
            const canvasFiles = [];

            for (const item of outer) {
                if (!Array.isArray(item) || item[0] !== 'wrb.fr' || typeof item[2] !== 'string') continue;
                let payload;
                try {
                    payload = JSON.parse(item[2]);
                } catch {
                    continue;
                }
                if (!Array.isArray(payload)) continue;

                if (Array.isArray(payload[1])) {
                    if (typeof payload[1][0] === 'string' && payload[1][0]) convId = payload[1][0];
                    if (typeof payload[1][1] === 'string' && payload[1][1]) respId = payload[1][1];
                }

                const candidate = payload[4]?.[0];
                if (Array.isArray(candidate)) {
                    if (typeof candidate[0] === 'string' && candidate[0]) {
                        choiceId = candidate[0];
                    }
                    const textArr = candidate[1];
                    if (Array.isArray(textArr) && typeof textArr[0] === 'string') {
                        text = textArr[0];
                    } else if (typeof textArr === 'string') {
                        text = textArr;
                    }

                    const thoughtNode = candidate[37]?.[0]?.[0];
                    if (typeof thoughtNode === 'string' && thoughtNode.trim()) {
                        reasoning = thoughtNode.trim();
                    }

                    const state = { files: [], currentName: null, depth: 0 };
                    for (let idx = 0; idx < candidate.length; idx++) {
                        if (idx === 1 || idx === 37) continue;
                        this.scanPayloadForCanvasFiles(candidate[idx], text, reasoning, state);
                    }
                    for (let pIdx = 0; pIdx < payload.length; pIdx++) {
                        if (pIdx === 1 || pIdx === 4) continue;
                        this.scanPayloadForCanvasFiles(payload[pIdx], text, reasoning, state);
                    }
                    if (state.files.length > 0) {
                        canvasFiles.push(...state.files);
                    }
                } else {
                    const state = { files: [], currentName: null, depth: 0 };
                    this.scanPayloadForCanvasFiles(payload, text, reasoning, state);
                    if (state.files.length > 0) {
                        canvasFiles.push(...state.files);
                    }
                }
            }

            if (text !== null || reasoning !== null || canvasFiles.length > 0 || convId !== null) {
                return { text, reasoning, convId, respId, choiceId, canvasFiles };
            }
        } catch (_) {}
        return null;
    }

    extractTextFromWrbLine(line) {
        const extracted = this.extractDataFromWrbLine(line);
        return extracted ? extracted.text : null;
    }

    async sendPrompt(
        promptText,
        onChunk,
        targetConvId = null,
        requestedModel = 'gemini-4-argon',
        retryStage = 0,
        fallbackPlainPrompt = null,
        images = [],
        preUploadedImages = null,
        turnContext = null,
        fullHistoryFallbackPrompt = null,
        fullHistoryFallbackImages = null
    ) {
        this.auth = this.loadAuth();
        const hasImages = Array.isArray(images) && images.length > 0;

        if (!this.auth.snlm0e || !this.sessionInitialized) {
            try {
                await this.refreshSNlM0e();
            } catch (e) {
                console.warn('[Gemini] Initial token refresh warning:', e.message);
            }
        } else if (!this.modelsDiscovered) {
            try {
                await this.fetchAccountModelsOnce();
            } catch {}
        }

        let uploadedImages = preUploadedImages;
        if (!uploadedImages && hasImages) {
            uploadedImages = await this.uploadImages(images, retryStage > 0);
        }

        const modelSpec = this.resolveModelSpec(requestedModel);
        const effectivePrompt = (retryStage >= 2 && fallbackPlainPrompt) ? fallbackPlainPrompt : promptText;
        const convId = turnContext?.convId || ((retryStage === 0 && targetConvId) ? GeminiClient.normalizeConvId(targetConvId) : '');
        const respId = turnContext?.respId || '';
        const choiceId = turnContext?.choiceId || '';

        const imageList = (uploadedImages && uploadedImages.length > 0)
            ? uploadedImages.map((img, idx) => {
                const safeName = (retryStage >= 1 && String(img.name || '').endsWith('.webp'))
                    ? `image_${idx + 1}.jpg`
                    : img.name;
                return [[img.identifier, 1], safeName];
            })
            : null;

        // Build innerStruct with 2026 BardChatUi model-selection slots:
        // innerStruct[79] = modelSpec.modeCategory (3 = Pro/Argon, 1 = Flash, 6 = Flash-Lite)
        // innerStruct[80] = modelSpec.expandedThinking (2 = Expanded reasoning, 1 = Standard)
        // innerStruct[41] = [2] (Persist chat in gemini.google.com/app history unless ephemeralMode is true)
        let innerStruct;
        if (retryStage === 0) {
            innerStruct = new Array(97).fill(null);
            innerStruct[0] = imageList
                ? [effectivePrompt, 0, null, imageList, null, null, 0]
                : [effectivePrompt, 0, null, null, null, null, 0];
            innerStruct[1] = ['ru'];
            innerStruct[2] = [convId || '', respId || '', choiceId || '', null, null, []];
            innerStruct[6] = imageList ? [1] : [0];
            innerStruct[7] = imageList ? 0 : 1;
            if (imageList) {
                innerStruct[8] = [];
                innerStruct[9] = [];
                innerStruct[10] = 1;
                innerStruct[11] = 0;
            }
            if (!this.ephemeralMode) {
                innerStruct[41] = [2];
            }
            innerStruct[79] = modelSpec.modeCategory;
            innerStruct[80] = modelSpec.expandedThinking;
        } else if (imageList) {
            innerStruct = [
                [effectivePrompt, 0, null, imageList, null, null, 0],
                ['ru'],
                [convId || null, respId || null, choiceId || null, null, null, []],
                null,
                null,
                null,
                [1],
                0,
                [],
                [],
                1,
                0
            ];
        } else {
            innerStruct = [
                [effectivePrompt],
                ['ru'],
                [convId, respId, choiceId]
            ];
        }

        const reqPayload = JSON.stringify([null, JSON.stringify(innerStruct)]);
        const postData = new URLSearchParams({
            'f.req': reqPayload,
            'at': this.auth.snlm0e || ''
        }).toString();

        const reqId = Math.floor(100000 + Math.random() * 900000);
        const queryObj = {
            'bl': this.bl,
            'hl': 'ru',
            '_reqid': String(reqId),
            'rt': 'c'
        };
        if (this.fSid) {
            queryObj['f.sid'] = this.fSid;
        }
        const queryParams = new URLSearchParams(queryObj).toString();

        const reqPath = `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${queryParams}`;

        const headers = {
            'User-Agent': this.userAgent,
            'Cookie': this.getCookieHeader(),
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Origin': 'https://gemini.google.com',
            'Referer': 'https://gemini.google.com/app',
            'X-Same-Domain': '1',
            'x-goog-ext-73010989-jspb': '[0]',
            'x-goog-ext-525005358-jspb': JSON.stringify([this.clientUuid || '09D681E7-26F2-4A94-A465-38386B7AB93B', 1]),
            'Content-Length': Buffer.byteLength(postData)
        };

        const sapisidHdr = this.getSapisidHashHeader();
        if (sapisidHdr) {
            headers['Authorization'] = sapisidHdr;
        }

        const modelHdr = this.getModelHeader(requestedModel, retryStage, Boolean(imageList));
        if (modelHdr) {
            headers['x-goog-ext-525001261-jspb'] = modelHdr;
        }

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'gemini.google.com',
                path: reqPath,
                method: 'POST',
                maxHeaderSize: 262144,
                headers
            }, (res) => {
                this.updateCookiesFromResponse(res.headers);
                let rawResponse = '';
                let fullText = '';
                let fullReasoning = '';
                let buffer = '';
                let lastConvId = convId;
                let lastRespId = respId;
                let lastChoiceId = choiceId;
                const canvasFileMap = new Map();
                let longestStreamedTextWithCode = '';

                const processExtracted = (extracted) => {
                    if (!extracted) return;
                    if (extracted.convId) lastConvId = extracted.convId;
                    if (extracted.respId) lastRespId = extracted.respId;
                    if (extracted.choiceId) lastChoiceId = extracted.choiceId;
                    if (typeof extracted.text === 'string' && extracted.text.length > 0) {
                        fullText = extracted.text;
                        if (
                            (extracted.text.includes('<immersive') || extracted.text.includes('<file_write') || extracted.text.includes('```html') || extracted.text.includes('```jsx')) &&
                            extracted.text.length > longestStreamedTextWithCode.length
                        ) {
                            longestStreamedTextWithCode = extracted.text;
                        }
                    }
                    if (typeof extracted.reasoning === 'string' && extracted.reasoning.length > 0) {
                        fullReasoning = extracted.reasoning;
                    }
                    if (Array.isArray(extracted.canvasFiles)) {
                        for (const cf of extracted.canvasFiles) {
                            const prev = canvasFileMap.get(cf.name);
                            if (!prev || cf.content.length >= prev.content.length) {
                                canvasFileMap.set(cf.name, cf);
                            }
                        }
                    }
                };

                res.on('data', chunk => {
                    const str = chunk.toString();
                    rawResponse += str;
                    buffer += str;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        processExtracted(this.extractDataFromWrbLine(line));
                    }
                });

                res.on('end', async () => {
                    if (buffer.trim()) {
                        processExtracted(this.extractDataFromWrbLine(buffer));
                    }

                    if (longestStreamedTextWithCode.length > fullText.length + 100 && fullText.includes('immersive_entry_chip')) {
                        fullText = longestStreamedTextWithCode;
                    }

                    const allFiles = [];
                    for (const cf of canvasFileMap.values()) {
                        allFiles.push(cf);
                    }
                    const pyFiles = this.extractFilesFromPythonRunner(fullText);
                    for (const pf of pyFiles) {
                        if (!allFiles.some(f => f.name === pf.name && f.content.length >= pf.content.length)) {
                            allFiles.push(pf);
                        }
                    }
                    const tagFiles = this.extractTaggedFilesFromText(fullText);
                    for (const tf of tagFiles) {
                        if (!allFiles.some(f => f.name === tf.name && f.content.length >= tf.content.length)) {
                            allFiles.push(tf);
                        }
                    }

                    const hasImmersiveChip = rawResponse.includes('immersive_entry_chip');
                    const hasGeneratedFileTag = rawResponse.includes('code-generated-file-');

                    if (
                        (hasImmersiveChip || hasGeneratedFileTag) &&
                        allFiles.length === 0 &&
                        !/```(?:html|jsx|tsx|javascript|js|react)|"tool_call"/i.test(fullText) &&
                        !turnContext?._isCanvasFollowUp &&
                        lastConvId &&
                        lastRespId
                    ) {
                        console.log(`[Gemini] 🔄 Canvas/Sandbox chip detected in conversation ${lastConvId}. Fetching full code inline...`);
                        try {
                            const followUpPrompt = [
                                'ВНИМАНИЕ: Внешний интерфейс Claude Desktop не имеет доступа к внутреннему виджету Gemini Canvas (immersive_entry_chip) и внутренним ссылкам [file-tag: code-generated-file-...].',
                                'Выведи ПОЛНЫЙ, готовый к запуску код только что созданного приложения (одним самодостаточным HTML-файлом со встроенным CSS, JS, Canvas/React CDN без сокращений) прямо в тексте ответа внутри тегов:',
                                '<file_write path="finsmith_craft_koi.html">',
                                '<!DOCTYPE html>',
                                '...',
                                '</file_write>',
                                'КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать теги <immersive> и запрещено вызывать Python!'
                            ].join('\n');
                            const followUpRes = await this.sendPrompt(
                                followUpPrompt,
                                null,
                                lastConvId,
                                requestedModel,
                                0,
                                null,
                                [],
                                null,
                                { convId: lastConvId, respId: lastRespId, choiceId: lastChoiceId, _isCanvasFollowUp: true }
                            );
                            if (followUpRes && followUpRes.text) {
                                fullText = `${fullText}\n\n${followUpRes.text}`;
                                if (followUpRes.responseId) lastRespId = followUpRes.responseId;
                                if (followUpRes.choiceId) lastChoiceId = followUpRes.choiceId;
                                if (Array.isArray(followUpRes.files) && followUpRes.files.length > 0) {
                                    allFiles.push(...followUpRes.files);
                                }
                            }
                        } catch (fuErr) {
                            console.warn('[Gemini] Canvas follow-up warning:', fuErr.message);
                        }
                    }

                    const cleaned = this.cleanGeminiResponse(fullText, fullReasoning, allFiles);
                    fullText = cleaned.text;
                    fullReasoning = cleaned.reasoning;

                    if (allFiles.length > 0) {
                        console.log(`[Gemini] 📦 Extracted ${allFiles.length} file(s) from Gemini response: ${allFiles.map(f => `${f.name} (${Math.round(f.content.length / 1024)} KB, ${f.source})`).join(', ')}`);
                    }

                    const isRefusal = this.isCannedError(fullText);
                    const hasBardError = rawResponse.includes('BardErrorInfo');

                    if ((!fullText || isRefusal) && retryStage < 2 && !turnContext?._isCanvasFollowUp) {
                        console.log(`[Gemini] Stage ${retryStage} returned ${isRefusal ? 'canned error: "' + fullText.substring(0, 60) + '..."' : (hasBardError ? 'BardErrorInfo' : '0 chars')}. Retrying with fallback model/prompt (stage ${retryStage + 1})...`);
                        if (retryStage === 0 && !fullText) {
                            try {
                                await this.refreshSNlM0e();
                            } catch (refreshErr) {
                                console.warn('[Gemini] Refresh token warning during retry:', refreshErr.message);
                            }
                        }
                        try {
                            // If Stage 0 was a continuation of an existing convId and it failed (e.g. chat was deleted in browser),
                            // fall back to fullHistoryFallbackPrompt in a fresh Gemini chat!
                            const nextPrompt = (turnContext && fullHistoryFallbackPrompt) ? fullHistoryFallbackPrompt : promptText;
                            const nextImages = (turnContext && fullHistoryFallbackImages) ? fullHistoryFallbackImages : images;
                            const nextUploaded = (hasBardError && hasImages && retryStage === 0) || (turnContext && fullHistoryFallbackImages) ? null : uploadedImages;
                            const retryRes = await this.sendPrompt(
                                nextPrompt,
                                onChunk,
                                null,
                                requestedModel,
                                retryStage + 1,
                                fallbackPlainPrompt,
                                nextImages,
                                nextUploaded,
                                null,
                                fullHistoryFallbackPrompt,
                                fullHistoryFallbackImages
                            );
                            return resolve(retryRes);
                        } catch (retryErr) {
                            console.error('[Gemini] Retry error:', retryErr.message);
                        }
                    }

                    if (!fullText && hasImages && rawResponse.includes('BardErrorInfo')) {
                        fullText = '⚠️ Веб-сессия Google Gemini отклонила чтение прикреплённого изображения (BardErrorInfo 1100 — возможно, истёк токен авторизации куки `__Secure-1PSIDTS`, и сессия перешла в гостевой режим без поддержки загрузки файлов). Пожалуйста, обновите авторизацию командой `node scripts/auth.js` (пункт 1) и перезапустите сервер.';
                    }

                    if (fullText && onChunk) {
                        onChunk(fullText);
                    }

                    if (!fullText) {
                        console.log(`[Gemini] ⚠️ 0 chars returned after retries. HTTP ${res.statusCode}. Raw preview:`, rawResponse.substring(0, 300).replace(/\s+/g, ' '));
                    }

                    if (fullText) {
                        console.log(`[Gemini] 🎯 Model active: ${modelSpec.canonicalId} (mode=${modelSpec.modeCategory}, effort=${modelSpec.expandedThinking}, id=${modelSpec.modeId}) | Thinking: ${fullReasoning.length} chars | Answer: ${fullText.length} chars`);
                    }

                    resolve({
                        text: fullText,
                        reasoning: fullReasoning,
                        files: allFiles,
                        conversationId: lastConvId || convId,
                        responseId: lastRespId,
                        choiceId: lastChoiceId,
                        activeModel: modelSpec.canonicalId,
                        modelSpec
                    });
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
}

module.exports = GeminiClient;