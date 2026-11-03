#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEEPSEEK_DIR = path.join(ROOT, '.deepseek');
const GEMINI_DIR = path.join(ROOT, '.gemini');

if (!fs.existsSync(DEEPSEEK_DIR)) fs.mkdirSync(DEEPSEEK_DIR, { recursive: true });
if (!fs.existsSync(GEMINI_DIR)) fs.mkdirSync(GEMINI_DIR, { recursive: true });

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }

function printStatus() {
  console.log('\n[Текущий статус авторизации]');
  const dsFiles = fs.readdirSync(DEEPSEEK_DIR).filter(f => f.startsWith('deepseek-auth') && f.endsWith('.json'));
  console.log(`  DeepSeek: ${dsFiles.length > 0 ? `✅ Аккаунтов: ${dsFiles.length}` : '❌ Не авторизован'}`);
  
  const gmFiles = fs.readdirSync(GEMINI_DIR).filter(f => f.startsWith('gemini-auth') && f.endsWith('.json'));
  console.log(`  Gemini:   ${gmFiles.length > 0 ? `✅ Аккаунтов: ${gmFiles.length}` : '❌ Не авторизован'}`);
}

async function runDeepSeekAuth(id = 'default') {
  const isDefault = id === 'default';
  const env = {
    ...process.env,
    DEEPSEEK_AUTH_PATH: path.join(DEEPSEEK_DIR, isDefault ? 'deepseek-auth.json' : `deepseek-auth-${id}.json`),
    DEEPSEEK_CHROME_PROFILE: path.join(DEEPSEEK_DIR, isDefault ? 'chrome-profile' : `chrome-profile-${id}`),
    DEEPSEEK_CHROME_PORT: '9334'
  };
  spawnSync(process.execPath, [path.join(__dirname, 'deepseek_chrome_auth.js')], { stdio: 'inherit', env });
}

async function runGeminiAuth(id = 'default') {
  const isDefault = id === 'default';
  const env = {
    ...process.env,
    GEMINI_AUTH_PATH: path.join(GEMINI_DIR, isDefault ? 'gemini-auth.json' : `gemini-auth-${id}.json`),
    GEMINI_CHROME_PROFILE: path.join(GEMINI_DIR, isDefault ? 'chrome-profile' : `chrome-profile-${id}`),
    GEMINI_CHROME_PORT: '9335'
  };
  spawnSync(process.execPath, [path.join(__dirname, 'gemini_chrome_auth.js')], { stdio: 'inherit', env });
}

async function menu() {
  while (true) {
    divider();
    console.log('   BetaDropChat v2.0: Multi-Provider Account Manager');
    printStatus();
    divider();
    console.log('1 - Авторизовать / обновить Google Gemini Pro (.gemini)');
    console.log('2 - Авторизовать / обновить DeepSeek (.deepseek)');
    console.log('3 - Очистить ключи Gemini');
    console.log('4 - Очистить ключи DeepSeek');
    console.log('5 - Выход');
    const choice = (await prompt('Ваш выбор: ')) || '5';

    if (choice === '1') {
      const id = await prompt('ID аккаунта Gemini (Enter = default): ') || 'default';
      await runGeminiAuth(id);
    } else if (choice === '2') {
      const id = await prompt('ID аккаунта DeepSeek (Enter = default): ') || 'default';
      await runDeepSeekAuth(id);
    } else if (choice === '3') {
      fs.readdirSync(GEMINI_DIR).filter(f => f.endsWith('.json')).forEach(f => fs.unlinkSync(path.join(GEMINI_DIR, f)));
      console.log('Ключи Gemini удалены.');
    } else if (choice === '4') {
      fs.readdirSync(DEEPSEEK_DIR).filter(f => f.endsWith('.json')).forEach(f => fs.unlinkSync(path.join(DEEPSEEK_DIR, f)));
      console.log('Ключи DeepSeek удалены.');
    } else if (choice === '5') {
      break;
    }
  }
}

menu();
