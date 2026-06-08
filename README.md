# BetaDropChat

<p align="center">
  <strong>Универсальный OpenAI/Anthropic API прокси для DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/boltua1/BetaDropChat/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-быстрый-старт">Быстрый старт</a> •
  <a href="#-возможности">Возможности</a> •
  <a href="#-интеграция-с-claude-code">Claude Code</a> •
  <a href="#-настройки">Настройки</a> •
  <a href="#-модели">Модели</a>
</p>

**BetaDropChat** — это мощный инструмент, который превращает бесплатный **DeepSeek Web Chat** (`chat.deepseek.com`) в полноценный локальный API-сервер. Он позволяет использовать DeepSeek Web в любых профессиональных инструментах разработки: **Claude Code**, **Open WebUI**, **Cursor**, **Continue** и других OpenAI-compatible клиентах.

Проект разработан с фокусом на стабильность, кроссплатформенность и максимальную простоту настройки.

---

## 🌟 Что делает BetaDropChat особенным?

- **Полная поддержка Claude Code**: Специальный лаунчер для Windows (`run-claude.bat`) запускает сервер и клиент в одном окне, автоматически настраивая окружение.
- **Умная кроссплатформенность**: Надежный поиск Chrome и управление процессами адаптированы под Windows, macOS и Linux.
- **Организация данных**: Все служебные файлы (авторизация, профиль браузера) хранятся в скрытой папке `.deepseek/`, не засоряя корень проекта.
- **Централизованные настройки**: Настраивайте порты и пути к файлам через удобный `settings.json`.
- **Защита сессий**: Механизм блокировки предотвращает создание дубликатов чатов при параллельных запросах.

## 🚀 Возможности

- **OpenAI Chat Completions API**: Эндпоинт `v1/chat/completions`.
- **Anthropic Messages API**: Прямая совместимость с Claude Code через `v1/messages`.
- **Поддержка R1 (Reasoner)**: Полноценная работа с моделями рассуждения и передача `reasoning_content`.
- **Инструменты (Tool Calling)**: Парсинг и передача инструментов (functions) прямо в DeepSeek Web.
- **Zero Dependencies**: Работает на чистом Node.js (18+), не требуя установки сотен npm-пакетов.

---

## ⚡ Быстрый старт

### 1. Установка
```bash
git clone https://github.com/boltua1/BetaDropChat.git
cd BetaDropChat
### 2. Авторизация

Для работы прокси необходимы данные вашей сессии DeepSeek. Есть два способа их получить:

#### Вариант 1: Автоматический (Рекомендуемый)
Запустите скрипт и выберите пункт **1**:
```bash
node scripts/auth.js
```
Войдите в свой аккаунт DeepSeek в открывшемся окне Chrome и отправьте любое сообщение (например, "привет"), чтобы сохранить сессию.

#### Вариант 2: Ручной (Через Chrome-расширение)
Если автоматический скрипт не работает, используйте расширение из папки `chrome-extension`:
1. Откройте в Chrome: `chrome://extensions/`
2. Включите **"Режим разработчика"** (Developer mode).
3. Нажмите **"Загрузить распакованное расширение"** (Load unpacked) и выберите папку `chrome-extension` в проекте.
4. Зайдите на [chat.deepseek.com](https://chat.deepseek.com/) под своим аккаунтом.
5. Нажмите на иконку расширения, затем кнопку **"Collect from Tab"**.
6. Нажмите **"Download File"** и сохраните файл как `deepseek-auth.json` в папку `.deepseek/` вашего проекта.

---

### 3. Запуск сервера
```bash
node server.js
```
Выберите пункт **3** для запуска прокси-сервера. По умолчанию он будет доступен на `http://127.0.0.1:9655`.

---

## 🛠 Интеграция с Claude Code (Windows)

Для пользователей Windows реализован скрипт `run-claude.bat`, который максимально упрощает использование DeepSeek в качестве бэкенда для Claude Code.

### Что делает скрипт:
1. **Выбор модели**: Предлагает выбрать между `deepseek-chat` (V3) и `deepseek-reasoner` (R1).
2. **Фоновый запуск**: Автоматически запускает сервер `server.js` в отдельном скрытом процессе.
3. **Настройка окружения**: Устанавливает необходимые переменные `ANTHROPIC_BASE_URL` (указывая на локальный прокси) и `ANTHROPIC_API_KEY` (фиктивный ключ, так как прокси использует ваш веб-токен).
4. **Запуск клиента**: Запускает `claude` (Claude Code) с правильными параметрами.
5. **Авто-выключение**: После завершения работы с Claude Code скрипт автоматически завершает процесс прокси-сервера.

### Как запустить:
Просто запустите файл двойным кликом или из терминала:
```bash
run-claude.bat
```
*Убедитесь, что вы предварительно прошли авторизацию через `node scripts/auth.js`.*

---

## ⚙️ Настройки (`settings.json`)

Вы можете изменить конфигурацию в файле `settings.json`:
```json
{
  "auth_path": "./.deepseek/deepseek-auth.json",
  "chrome_profile_dir": "./.deepseek/chrome-profile",
  "server_port": 9655,
  "chrome_debug_port": 9334,
  "primaryModel": "deepseek-chat",
  "anthropicBaseUrl": "http://127.0.0.1:9655/v1",
  "anthropicApiKey": "sk-ant-api03-betadrop-chat-key-7777777777777777777777777777777777777777777777777777777777777777777777"
}
```

---

## 🧠 Поддерживаемые модели

| Модель | Режим Web | Reasoning | Поиск |
| --- | --- | --- | --- |
| `deepseek-chat` | Быстрый (V3/V4) | Нет | Нет |
| `deepseek-reasoner` | Быстрый (R1) | Да | Нет |
| `claude-3-5-sonnet` | Псевдоним для V3 | Нет | Нет |
| `claude-4-5 / 4.8` | Псевдоним для R1 | Да | Нет |
| `deepseek-expert` | Эксперт | Нет | Нет |
| `deepseek-v4-pro` | Эксперт + R1 | Да | Нет |

---

## 🔐 Безопасность и приватность

BetaDropChat хранит ваши данные локально в папке `.deepseek/`. Эти файлы автоматически добавлены в `.gitignore` и никогда не попадут в репозиторий.

> ⚠️ **Примечание**: Это экспериментальный прокси-сервер. Для критически важных бизнес-задач рекомендуется использовать официальный платный API DeepSeek.

<p align="center">
  <strong>BetaDropChat</strong>
</p>
>
