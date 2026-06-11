const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

let cachedWasm = null;

async function findCurrentWasmUrl() {
    try {
        const rootResp = await fetch('https://chat.deepseek.com/', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        const html = await rootResp.text();
        
        // Look for main JS bundles that might contain the WASM reference
        const jsMatches = html.match(/\/assets\/index-[a-z0-9]+\.js/g) || [];
        for (const jsPath of jsMatches) {
            const jsResp = await fetch('https://chat.deepseek.com' + jsPath);
            const jsCode = await jsResp.text();
            const wasmMatch = jsCode.match(/sha3_wasm_bg\.[a-z0-9]+\.wasm/);
            if (wasmMatch) {
                return `https://fe-static.deepseek.com/chat/static/${wasmMatch[0]}`;
            }
        }
    } catch (e) {
        console.error(`[POW-Discovery] Error: ${e.message}`);
    }
    return 'https://chat.deepseek.com/static/wasm/pro/pow.wasm'; // Fallback to old known URL
}

parentPort.on('message', async (data) => {
    const { challenge, wasmUrl, accountId, headers, localPath } = data;
    const tag = `[POW-${accountId || 'unknown'}]`;
    
    try {
        if (!cachedWasm) {
            // 1. Try local file
            if (localPath && fs.existsSync(localPath)) {
                const buffer = fs.readFileSync(localPath);
                if (buffer.length > 10000 && buffer[0] === 0x00 && buffer[1] === 0x61 && buffer[2] === 0x73 && buffer[3] === 0x6d) {
                    cachedWasm = buffer;
                }
            }

            // 2. Try to discover and download if missing
            if (!cachedWasm) {
                const activeWasmUrl = await findCurrentWasmUrl();
                console.log(`${tag} WASM missing. Attempting to download from: ${activeWasmUrl}`);
                
                try {
                    const resp = await fetch(activeWasmUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
                    });
                    const buf = await resp.arrayBuffer();
                    const nodeBuf = Buffer.from(buf);
                    
                    if (nodeBuf.length > 10000 && nodeBuf[0] === 0x00) {
                        cachedWasm = nodeBuf;
                        if (localPath) {
                            if (!fs.existsSync(path.dirname(localPath))) fs.mkdirSync(path.dirname(localPath), { recursive: true });
                            fs.writeFileSync(localPath, cachedWasm);
                            console.log(`${tag} Successfully downloaded and cached WASM.`);
                        }
                    }
                } catch (e) {}
                
                if (!cachedWasm) {
                    const absolutePath = path.resolve(localPath);
                    throw new Error(`
[!] POW WASM missing or blocked. 
DeepSeek has prevented the automatic download.

STEPS TO FIX:
1. Open this link in your browser: ${activeWasmUrl}
2. Save the file to this EXACT location:
   ${absolutePath}

(Alternative: Run "node scripts/auth.js" and it will be captured automatically)
                    `);
                }
            }
        }

        const mod = await WebAssembly.instantiate(cachedWasm, { wbg: {} });
        const e = mod.instance.exports;
        const encoder = new TextEncoder();
        const prefix = challenge.salt + '_' + challenge.expire_at + '_';
        const cBytes = encoder.encode(challenge.challenge);
        const pBytes = encoder.encode(prefix);
        const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
        const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
        new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
        new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
        const sp = e.__wbindgen_add_to_stack_pointer(-16);
        e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
        const dv = new DataView(e.memory.buffer);
        const code = dv.getInt32(sp, true);
        const ans = dv.getFloat64(sp + 8, true);
        e.__wbindgen_add_to_stack_pointer(16);
        if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
        
        parentPort.postMessage({ success: true, answer: Math.floor(ans) });
    } catch (err) {
        console.error(`[POW-Worker] FATAL: ${err.message}`);
        parentPort.postMessage({ success: false, error: err.message });
    }
});
