# BetaDropChat v2.0 (Multi-Provider Edition)

<p align="center">
  <strong>Универсальный OpenAI & Anthropic API прокси для DeepSeek Web и Google Gemini Pro (Google One AI Premium)</strong>
</p>

## 🌟 Ключевые возможности

- 🚀 **Два флагманских провайдера в одном шлюзе**:
  - **Google Gemini Pro** (Gemini 2.5 Pro с контекстом подписки Google One AI Premium).
  - **DeepSeek Web** (актуальные модели: `deepseek-flash` с поддержкой vision и кодинга, `deepseek-v4-pro` 1.6T флагман, `deepseek-reasoner` с reasoning).
- 🖥️ **Поддержка Claude Desktop & Claude Code**: шлюз на `127.0.0.1:9655` принимает запросы Anthropic Messages API (`/v1/messages`) и OpenAI API (`/v1/chat/completions`).
- 📁 **Изоляция сессий и ключей**:
  - `.gemini/` — профили и cookie Google.
  - `.deepseek/` — профили и WASM DeepSeek.
- 📦 **Zero Dependencies**: чистый Node.js 18+ без сторонних npm-библиотек.

---

## ⚡ Быстрый старт

### 1. Авторизация
Запустите единое меню управления:
```bash
node scripts/auth.js
```
- Нажмите **1** для входа в **Google Gemini Pro**.
- Нажмите **2** для входа в **DeepSeek**.

### 2. Запуск через лаунчер (Windows)
Запустите `run-claude.bat`:
- Выберите провайдера (Gemini или DeepSeek).
- Выберите модель (`gemini-4-argon`, `deepseek-flash`, `deepseek-v4-pro`, `deepseek-reasoner`).
- Лаунчер автоматически запустит сервер на порту 9655 и подключит Claude Code!

### 3. Подключение к Claude Desktop (GUI)
1. Откройте **Settings** -> **Inference** (или Developer -> Configure third-party inference).
2. Выберите **Gateway**.
3. Параметры:
   - **Gateway base URL**: `http://127.0.0.1:9655`
   - **Gateway API key**: любая строка (например, `sk-ant-free`)
   - **Gateway auth scheme**: `bearer`
4. Нажмите **Test connection**!
