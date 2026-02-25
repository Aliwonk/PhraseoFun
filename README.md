# PhraseoFun — JS PWA

Это кроссплатформенное PWA (Android/iOS/desktop) на чистом HTML/CSS/JavaScript:
- устанавливается на телефон (Add to Home Screen / Install App)
- работает офлайн (service worker)
- хранит прогресс в localStorage

## Запуск локально (важно: НЕ file://)
Service Worker работает только на http(s), поэтому нужен локальный сервер.

### Вариант 1 — Python
```bash
python -m http.server 5173
```
Открой: http://localhost:5173

### Вариант 2 — Node (без установки глобально)
```bash
npx http-server -c-1 -p 5173 .
```

## Структура
- index.html — оболочка приложения
- app.js — роутинг + экраны + логика квиза
- data.js — контент модулей и фраз (сгенерировано из DOCX)
- sw.js — service worker
- manifest.webmanifest — манифест PWA
- icons/ — иконки
