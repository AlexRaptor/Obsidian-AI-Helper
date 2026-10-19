# AGENTS.md

Obsidian AI Helper — an Obsidian plugin (TypeScript, esbuild) with a chat view, settings, English/Russian localization, and an OpenAI-compatible model-server client. Source is in `src/`; tests are in `test/`.

## Commands

- `npm install`
- `npm run dev` — esbuild watch mode; rebuilds `main.js` on save
- `npm run build` — production bundle + `tsc` typecheck (run this as the gate before committing)
- `npm test` — Vitest; run a single test with `npx vitest run <file>`

## How to test the plugin

There is no standalone runtime. To run:

1. `npm run build` (bundles `main.js` and synchronizes the version in `manifest.json`; `styles.css` is a separate source file)
2. In an Obsidian vault: Settings → Community plugins → disable Restricted mode
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/<manifest id>/`
4. Reload Obsidian (Ctrl/Cmd+R); check the console for errors

## Computer Use

- Использовать Computer Use только по прямому запросу пользователя или при явной необходимости, когда задача требует взаимодействия с интерфейсом и доступные файловые операции, CLI или API не позволяют её выполнить.
- При необходимости Computer Use сначала простым языком подробно объяснить пользователю, что нужно сделать в интерфейсе, зачем это нужно, почему других средств недостаточно и какие приложения или данные будут затронуты; запросить согласие и дождаться ответа.

## Manual testing

- Ручную проверку требовать только для поведения, которое нельзя достаточно подтвердить автоматическими проверками; в задаче указывать, почему она нужна. Если ручная проверка не нужна, приёмку выполнять автоматическими проверками без требования ручных тест-кейсов, отчёта или подтверждения пользователя.
- Описания ручных тест-кейсов и инструкции группировать по задаче или эпику в `docs/testing/<task-or-epic>/`. Тестовые хранилища для них, исходные данные и генераторы размещать в этой же папке, рядом с файлами тест-кейсов.
- Если задача требует ручного тестирования, агент обязан создать или адаптировать Python-скрипт сборки тестового хранилища с исходными данными сценариев и установкой актуальной версии плагина. Генератор должен поддерживать `--dest` и стандартное меню из четырёх режимов; перед его созданием или изменением прочитать и выполнить [обязательный контракт](docs/agents/test-vaults.md).
- Если сценариям нужны разные хранилища, именовать их по сценарию: например, `current-note.md` и `current-note-vault/`, `multiple-notes.md` и `multiple-notes-vault/`. Совместимые сценарии могут использовать общее хранилище. Генератор может быть общим или отдельным для каждого набора; в каждом тест-кейсе указывать точный путь хранилища, способ подготовки и восстановления исходного состояния.
- Агент выполняет автоматические проверки; если нужна ручная проверка, подготавливает её файлы и сообщает пользователю точные пути. Ручную проверку выполняет пользователь; Computer Use для неё применять только по его явной просьбе.

## Conventions

- Тестовые данные для автоматических и ручных проверок по возможности писать на русском языке. Другие языки использовать, когда это необходимо для проверки локализации, смешанного содержимого или конкретного языкового сценария.
- Все сообщения коммитов (заголовок и тело) пишите на русском языке.
- Если коммит выполняется в рамках тикета, начинайте его заголовок с номера тикета в формате `#НОМЕР: СООБЩЕНИЕ`, например `#123: Реализован поиск`.
- Import the Obsidian API as `import { ... } from "obsidian"` and `app`-typed services via `this.app` — never `require`/Node builtins; the bundle runs in the Obsidian renderer.
- `@types/node` and `obsidian` are dev/prod deps of the scaffold; don't add Node-only libraries (fs, path, child_process) — use Obsidian APIs (`App.vault`, `DataAdapter`) instead.
- `manifest.json` `id` must match the plugin folder name in the vault; the `id` is the source of truth.
- No linter/formatter config exists yet; follow existing code style once files land.
- Максимально соблюдать Obsidian-нативность интерфейса: использовать публичные компоненты и API Obsidian, переменные темы и стандартное поведение элементов; собственный CSS ограничивать необходимой компоновкой.
- Цвета интерфейса выбирать из палитры активной темы Obsidian по роли элемента: ошибки — `--text-error`, предупреждения и ограничения — `--text-warning`, успешное завершение — `--text-success`, информация — `--color-blue`, второстепенный текст — `--text-muted`; основной текст и ссылки наследуют нативное оформление. Фиксированные цвета допустимы для явно настраиваемой пользователем шкалы.
- Для фонов, выделения, границ и интерактивных состояний использовать соответствующие семантические переменные Obsidian (`--background-*`, `--text-selection`, `--text-highlight-bg`, `--interactive-*`). Кнопки оформлять публичными компонентами и нативными классами (`mod-cta`, `mod-warning`), сохраняя оформление темы для наведения, фокуса и отключённого состояния. При собственном CSS учитывать пару фон/текст и роль состояния; цвет дополняет текст или значок, объясняющий действие или результат.
- Для всех полей, предполагающих длинный ввод (например, пути папок и системный промпт), задавать ширину минимум 50% контейнера строки настройки. На узких экранах разрешать перенос элементов, сохраняя доступность поля и соседних действий.
- Vitest maps `obsidian` to `test/helpers/obsidian.ts` because the npm package provides type definitions only. Test view behavior through its input and buttons; the helper does not replace validation inside Obsidian.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
