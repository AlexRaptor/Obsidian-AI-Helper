# Вёрстка окна чата: план переделки

Дата: 2026-10-05. Источник: сессия grilling. Термины — из `CONTEXT.md` (ветка, сообщение, диалог).

## Решения

1. **Scope**: CSS + перестройка разметки в `src/chat-view.ts`. Без виртуализации, без streaming, без copy-кнопок (отдельные тикеты).
2. **Раскладка окна**: `.ai-helper` — flex-колонка на всю высоту. Сверху — header, посередине — `.ai-helper-messages` (`flex: 1; min-height: 0; overflow-y: auto`), внизу — input-row. Input прижат к низу, не скроллится с сообщениями.
3. **Ветка**: каждое сообщение — `.message[role][kind]` = `.message-branch` (вертикальная черта 3px) + `.message-body` (отступ 8px от ветки).
   - user: черта `var(--interactive-accent)`;
   - model: черта `var(--text-muted)`;
   - error (kind): черта `var(--text-error)`.
4. **Ветка = визуальное состояние**: один visual slot на сообщение; `kind` (text/thinking/error) управляет только декором тела.
5. **Содержимое тела**:
   - user: raw-текст, `white-space: pre-wrap` (markdown не рендерится);
   - model text: `MarkdownRenderer` в `.message-markdown`;
   - thinking: нейтральная модель-ветка, italic-текст + пульс opacity, анимация гаснет при `prefers-reduced-motion`;
   - error: как model + префикс `chat-error-prefix` жирным.
6. **Sustain через `onOpen`**: диалог (`Conversation`) и display-сообщения переживают пересоздание DOM. Отделяем «построить структуру» от «наполнить данными»; `container.empty()` не чистит состояние.
7. **Не трогаем**: `getDisplayText`, header («AI-ассистент» + «Clear conversation»), i18n-контракт, `Conversation`, `server-client`.
8. **Кодовые блоки model**: только стили (`margin`, `border-radius`, фон темы). Copy-кнопка — отдельный тикет.

## Новая структура DOM

```
.ai-helper (flex column, height: 100%)
├ .ai-helper-header (авто)
├ .ai-helper-messages (flex: 1, min-height: 0, overflow-y: auto)
│  └ .message[role][kind] *
│     ├ .message-branch (3px черта, цвет по role/kind)
│     └ .message-body (padding-left 8px)
└ .ai-helper-input-row (авто, прижат к низу)
```

## Вне scope (следующие тикеты)

- Streaming-рендер ответов.
- Виртуализация длинных диалогов.
- Copy-кнопка на кодовых блоках.
- Аватары/иконки ролей, метки времени.
