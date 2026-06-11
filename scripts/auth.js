#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// --- Settings Loading ---
const settingsPath = path.join(ROOT, 'settings.json');
let settings = {};
try {
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  console.error(`[auth-menu] Error reading settings.json: ${e.message}`);
}

const DEEPSEEK_DIR = path.join(ROOT, '.deepseek');
if (!fs.existsSync(DEEPSEEK_DIR)) fs.mkdirSync(DEEPSEEK_DIR, { recursive: true });

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }
function watermark(prefix = 'BetaDropChat') { return `BetaDropChat: Multi-Account Management`; }

function listAccounts() {
    const files = fs.readdirSync(DEEPSEEK_DIR).filter(f => f.startsWith('deepseek-auth') && f.endsWith('.json'));
    return files.map(f => {
        const id = f === 'deepseek-auth.json' ? 'default' : f.replace('deepseek-auth-', '').replace('.json', '');
        return { id, file: f, path: path.join(DEEPSEEK_DIR, f) };
    });
}

function status() {
  const accounts = listAccounts();
  console.log('\nУстановленные аккаунты DeepSeek:');
  if (accounts.length === 0) {
    console.log('  ❌ Аккаунты не найдены');
  } else {
    accounts.forEach(acc => {
        try {
            const data = JSON.parse(fs.readFileSync(acc.path, 'utf8'));
            const profileDir = path.join(DEEPSEEK_DIR, acc.id === 'default' ? 'chrome-profile' : `chrome-profile-${acc.id}`);
            console.log(`  [${acc.id}]`);
            console.log(`    Файл: ${acc.file}`);
            console.log(`    Token: ${data.token ? '✅ OK' : '❌ MISSING'}`);
            console.log(`    Profile: ${fs.existsSync(profileDir) ? '✅ OK' : '⚠️ NOT FOUND'}`);
        } catch (e) {
            console.log(`  [${acc.id}] ❌ Ошибка чтения файла: ${acc.file}`);
        }
    });
  }
}

async function runAuthForAccount(id) {
    const isDefault = id === 'default';
    const authFileName = isDefault ? 'deepseek-auth.json' : `deepseek-auth-${id}.json`;
    const profileDirName = isDefault ? 'chrome-profile' : `chrome-profile-${id}`;
    const debugPort = isDefault ? (settings.chrome_debug_port || 9334) : (settings.chrome_debug_port || 9334) + Math.floor(Math.random() * 1000) + 1;

    console.log(`\n[Auth] Запуск авторизации для аккаунта: ${id}`);
    
    const env = { 
        ...process.env, 
        DEEPSEEK_AUTH_PATH: path.join(DEEPSEEK_DIR, authFileName),
        DEEPSEEK_CHROME_PROFILE: path.join(DEEPSEEK_DIR, profileDirName),
        CHROME_DEBUG_PORT: String(debugPort)
    };

    const script = path.join(__dirname, 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
    return result.status === 0;
}

async function menu() {
  while (true) {
    divider();
    console.log(watermark());
    status();
    divider();
    console.log('Меню:');
    console.log('1 - Добавить / обновить аккаунт (введите ID)');
    console.log('2 - Удалить аккаунт');
    console.log('3 - Выход');
    const choice = (await prompt('Ваш выбор: ')) || '3';
    
    if (choice === '1') {
        const id = await prompt('Введите ID аккаунта (например: "2" или "work", Enter для "default"): ') || 'default';
        await runAuthForAccount(id);
    } else if (choice === '2') {
        const id = await prompt('Введите ID аккаунта для удаления: ');
        if (!id) continue;
        const fileName = id === 'default' ? 'deepseek-auth.json' : `deepseek-auth-${id}.json`;
        const filePath = path.join(DEEPSEEK_DIR, fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Аккаунт ${id} удален.`);
        } else {
            console.log(`Файл ${fileName} не найден.`);
        }
    } else if (choice === '3') break;
  }
}

menu();
