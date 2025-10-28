# OGMusicAlbum (OGMA)

OGMusicAlbum — это внутренний проект по агрегации и доставке музыки из Telegram-каналов. Репозиторий содержит полный стек: 
* асинхронный backend на FastAPI с PostgreSQL и Meilisearch,
* сервис стриминга аудио из Telegram,
* индексатор, синхронизирующий контент из каналов и Meilisearch,
* современное веб-приложение на React/Vite для пользователей,
* вспомогательные скрипты, миграции и готовую обсервабельность (Prometheus, Telegram-логирование).

Документ описывает архитектуру, требования, процесс развёртывания и ключевые сценарии работы OGMA.

## Содержание

- [Архитектура](#архитектура)
- [Основные возможности](#основные-возможности)
- [Стек технологий](#стек-технологий)
- [Структура репозитория](#структура-репозитория)
- [Подготовка окружения](#подготовка-окружения)
- [Настройка окружения (Environment)](#настройка-окружения-environment)
- [Запуск компонентов](#запуск-компонентов)
  - [Backend API](#backend-api)
  - [Stream Gateway](#stream-gateway)
  - [Telegram Indexer](#telegram-indexer)
  - [Веб-клиент](#веб-клиент)
- [Наблюдаемость и поддержка](#наблюдаемость-и-поддержка)
- [Тестирование](#тестирование)
- [Работа с данными и миграциями](#работа-с-данными-и-миграциями)
- [Полезные советы](#полезные-советы)

## Архитектура

```
┌──────────────────────┐       ┌──────────────────┐       ┌───────────────────────────┐
│ Telegram Channels    │       │  Indexer (Telethon)│----▶│ PostgreSQL + Meilisearch │
└─────────▲────────────┘       └──────────▲────────┘       └──────────┬────────────────┘
          │                                    │                       │
          │                                    │                       │
          │                             ┌──────┴──────┐          ┌─────▼──────────┐
          │                             │ Stream API  │◀────────▶│ FastAPI Backend│
          │                             └──────▲──────┘          └─────▲──────────┘
          │                                    │                     REST / WebSocket
          │                                    │                         │
          │                                    │                         │
          └────────────────────────────────────┴─────────────────────────▼────────────┐
                                                                               Web UI │
                                                                               (Vite) │
                                                                               └──────┘
```

- **Indexer** (Python + Telethon) выгружает аудио из заданных каналов Telegram, наполняет таблицы `tracks` и Meilisearch-индекс `tracks`.  [indexer/index_new.py](indexer/index_new.py)
- **Backend API** (FastAPI) предоставляет поиск, управление плейлистами, аутентификацию в Telegram WebApp и метрики здоровья. [app/api/main.py](app/api/main.py)
- **Stream Gateway** выдаёт аудио-файлы по HTTP Range и кеширует их на диске, подготавливая Telegram `file_reference` при необходимости. [stream/main.py](stream/main.py)
- **Web UI** (React + Vite) даёт пользователю интерфейс OGMA, обмениваясь данными с API и потоковым сервисом. [ogma-webapp/](ogma-webapp)
- **Observability** реализована Prometheus-метриками, live-мониторами в Telegram и опциональным логированием в чат. [app/metrics.py](app/metrics.py), [app/api/telemetry/](app/api/telemetry/).

## Основные возможности

- Поиск треков и плейлистов по полнотекстовому индексу Meilisearch с бэкапом на PostgreSQL. [app/api/main.py](app/api/main.py)
- Управление плейлистами: создание, публикация/приватность, обновление метаданных, трекинг статистики прослушивания. [app/api/playlists.py](app/api/playlists.py)
- Telegram WebApp авторизация и валидация подписей/токенов, поддержка JWT и проверка `initData`. [app/api/playlists.py](app/api/playlists.py)
- Стриминг аудио с поддержкой `Range`-запросов, кеширования и auto-refresh Telegram `file_reference`. [stream/main.py](stream/main.py)
- Метрики и health-checkи для orchestrator'ов: `/metrics`, `/health/live`, `/health/ready` с расширенной диагностикой. [app/main.py](app/main.py)
- Интеграция с Telegram логами и форумами: разметка топиков, агрегация событий, консольные логи в реальном времени. [app/api/telemetry/](app/api/telemetry/).

## Стек технологий

| Слой               | Технологии |
|--------------------|------------|
| Backend API        | FastAPI, asyncpg, httpx, Prometheus client, Starlette middleware |
| Хранилище          | PostgreSQL 15+, Meilisearch |
| Telegram-интеграции| Telethon, собственные обёртки для токенов и сессий |
| Stream Gateway     | FastAPI, Telethon, asyncpg, GZip middleware |
| Frontend           | React 19, Vite 7, Tailwind CSS 4, Zustand, SWR |
| Observability      | Prometheus, кастомные метрики, Telegram-логирование |
| Инфраструктура     | Uvicorn, dotenv, bash-скрипты, Prisma (для web), Playwright |

## Структура репозитория

```
app/                # Backend FastAPI-приложение, общие модули и API-роутеры
app/api/            # Основные эндпоинты, auth, поиск, плейлисты, телеметрия
app/indexer/        # legacy-индексатор (см. indexer/index_new.py как основной)
app/metrics.py      # Общие Prometheus-метрики и middleware
indexer/            # Производственный индексатор Telegram → PostgreSQL + Meili
stream/             # HTTP-шлюз для выдачи аудио из Telegram
ogma-webapp/        # Веб-клиент (React/Vite), Prisma-слой и e2e-тесты Playwright
sql/                # Миграции PostgreSQL (DDL)
backups/, bin/, docs/ # Утилиты, документация, скрипты
tests/              # Смоук-тесты API/stream (pytest + requests)
```

## Подготовка окружения

### Системные зависимости

- Python 3.11+
- Node.js 20+ и npm (для веб-клиента)
- PostgreSQL 15+ (таблицы `tracks`, `playlists`, `users`, журнал поиска и т.д.)
- Meilisearch 1.8+
- Redis (опционально, если используется для кэшей Live Monitor'а)
- FFmpeg (опционально для проверки аудио)

### Python окружение

Для сервисов используются отдельные virtualenv:

```bash
python3 -m venv app/api/.venv
source app/api/.venv/bin/activate
pip install -r app/api/requirements.txt

python3 -m venv stream/.venv
source stream/.venv/bin/activate
pip install fastapi uvicorn[standard] asyncpg telethon python-dotenv

python3 -m venv indexer/.venv
source indexer/.venv/bin/activate
pip install -r app/indexer/requirements.txt
```

## Настройка окружения (Environment)

Создайте единый `.env` (по умолчанию хранится в `/home/ogma/ogma/stream/.env` для stream/indexer) и/или локальные `.env` рядом с сервисами. Ключевые переменные:

| Переменная | Описание |
|------------|----------|
| `PG_DSN` | DSN PostgreSQL, например `postgresql://ogma:ogma@127.0.0.1:5433/ogma`. Используется всеми сервисами. |
| `MEILI_HOST`, `MEILI_KEY` | Хост и ключ Meilisearch. Обязательны для бэкенда и индексатора. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | API-данные Telegram (https://my.telegram.org). |
| `TELEGRAM_SESSION` | Путь к файлу сессии Telethon для стримингового сервиса. |
| `TELEGRAM_SESSION_INDEXER` | Путь к сессии индексатора. |
| `CHAT_USERNAMES` | Список Telegram-каналов через запятую, которые сканирует индексатор. |
| `TELEGRAM_BOT_TOKEN` | Токен бота для WebApp/логирования. |
| `TELEGRAM_LOG_CHAT_ID`, `TELEGRAM_LOG_BOT_TOKEN` | Чат/бот для доставки логов (опционально). |
| `API_JWT_SECRET` | Секрет для верификации JWT в API плейлистов. |
| `HOST`, `PORT` | Параметры запуска Stream Gateway. |
| `CACHE_DIR` | Директория файлового кеша аудио. |
| `PG_POOL_INIT_RETRIES`, `PG_POOL_INIT_DELAY` | Настройки мягкого старта пула Postgres. |

## Запуск компонентов

### Backend API

```bash
cd app
source api/.venv/bin/activate
export $(grep -v '^#' api/.env | xargs)   # при наличии
uvicorn app.api.main:app --host 0.0.0.0 --port 8080 --reload
```

Особенности:
- Автоматический запуск Telemetry background-задач (`start_live_monitors`, `start_log_shipper`, Prometheus middleware). [app/api/main.py](app/api/main.py)
- Health-endpoints `/health/live` и `/health/ready`. [app/main.py](app/main.py)
- Экспорт метрик Prometheus `/metrics` без включения в OpenAPI. [app/main.py](app/main.py)

### Stream Gateway

```bash
cd stream
source .venv/bin/activate
python main.py
```

Сервис держит подключение к Telegram, кеширует файлы и поддерживает возобновляемые загрузки. [stream/main.py](stream/main.py)

### Telegram Indexer

```bash
cd indexer
source .venv/bin/activate
python index_new.py
```

Индексатор использует Telethon для обхода каналов, UPSERT'ит записи в таблицу `tracks` и батчами отправляет документы в Meilisearch. [indexer/index_new.py](indexer/index_new.py)

### Веб-клиент

```bash
cd ogma-webapp
npm install
npm run dev
```

Скрипт `npm run dev` поднимает одновременно Vite (порт 5173) и локальный backend (`uvicorn`) через `concurrently`. [ogma-webapp/package.json](ogma-webapp/package.json)

Продакшен-сборка:

```bash
npm run build
npm run preview
```

## Наблюдаемость и поддержка

- **Prometheus**: middleware считает http-метрики (`ogma_http_requests_total`, `ogma_http_request_duration_seconds`, `ogma_http_errors_total`, `ogma_active_users`). [app/metrics.py](app/metrics.py)
- **Custom gauges/counters**: показатели индексатора (RPM, новые плейлисты, лаг по времени). [app/main.py](app/main.py)
- **Telegram logging**: любые WARNING/ERROR из Uvicorn могут пересылаться в Telegram-чат при наличии токена/чата. [app/main.py](app/main.py)
- **Telemetry**: модули `app/api/telemetry/*` управляют живой статистикой, форумными топиками и отправкой логов в бота. [app/api/telemetry/](app/api/telemetry/)
- **Health-checks**: `/health/live` проверяет uptime процесса, `/health/ready` — соединение с PostgreSQL. [app/main.py](app/main.py)

## Тестирование

### Backend/Stream smoke-тесты

Тесты в `tests/` рассчитаны на запущенный API/Stream (используют `requests`):

```bash
cd tests
pytest
```

Переменные `BASE`, `TEST_STREAM_ID`, `TEST_PUBLIC_PLAYLIST_QUERY` задают окружение для тестов и позволяют проверить поиск, потоковую раздачу и health-endpoints. [tests/test_health_and_stream.py](tests/test_health_and_stream.py)

### Frontend

Playwright-тесты запускаются после `npm install`:

```bash
cd ogma-webapp
npx playwright install
npm run pw
```

## Работа с данными и миграциями

Миграции PostgreSQL лежат в каталоге `sql/`. Порядок применения соответствует префиксам:

```bash
psql $PG_DSN -f sql/001_users_favorites_history.sql
psql $PG_DSN -f sql/002_user_contacts.sql
...
```

Миграции включают схемы плейлистов, индексатор, расширения `tracks`, статистику прослушиваний и т.д. [sql/](sql)

Meilisearch индекс создаётся индексатором автоматически (см. `ensure_meili_index`). [indexer/index_new.py](indexer/index_new.py)

## Полезные советы

- Перед запуском индексатора убедитесь, что Telethon-сессия авторизована (`python -m telethon.sync`).
- При сбоях авторизации удалите `*.session` и пройдите логин заново.
- Следите за ограничениями Telegram API (FloodWait). Индексатор обрабатывает их автоматически, делая паузу. [indexer/index_new.py](indexer/index_new.py)
- Для продакшена включите `PROMETHEUS_MULTIPROC_DIR` при запуске Uvicorn c несколькими воркерами, чтобы метрики корректно агрегировались. [app/metrics.py](app/metrics.py)
- В Stream Gateway настроен дисковый кеш; регулярно очищайте `CACHE_DIR`, если объём растёт.
- Скрипт `ogma-webapp/dev-up.sh` можно использовать для запуска дев-среды на сервере с корректной настройкой `.env`.

---

Если у вас остались вопросы по OGMA или нужно добавить новый сценарий, смотрите соответствующие модули в `app/api/` и открывайте issue/PR с подробным описанием задачи.
