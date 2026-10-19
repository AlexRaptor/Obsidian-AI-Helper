# Задачи поиска смысловых связей

Разбиение согласовано и опубликовано 2026-10-18. Родительская спецификация — [#59](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/59); при публикации задач она не изменялась.

Все задачи имеют метку `ready-for-agent`. Блокирующие связи установлены через нативные зависимости GitHub; ссылка на родительскую спецификацию указана в описании каждой задачи. Отношения sub-issue не добавлялись, чтобы не изменять родительскую Issue.

| Задача | Название | Заблокирована | Локальная копия |
| --- | --- | --- | --- |
| [#60](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/60) | Поиск связей: первая порция предложений в чате | Нет | [Текст задачи](semantic-note-links-tickets/01-first-suggestions.md) |
| [#61](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/61) | Поиск связей: выбор и безопасное добавление в заметку | #60 | [Текст задачи](semantic-note-links-tickets/02-save-connections.md) |
| [#62](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/62) | Поиск связей: область одной или нескольких папок | #60 | [Текст задачи](semantic-note-links-tickets/03-folder-scope.md) |
| [#63](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/63) | Поиск связей: настраиваемые порции и продолжение поиска | #61 | [Текст задачи](semantic-note-links-tickets/04-more-suggestions.md) |
| [#64](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/64) | Поиск связей: анализ больших заметок по фрагментам | #60 | [Текст задачи](semantic-note-links-tickets/05-large-notes.md) |
| [#65](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/65) | Поиск связей: продолжение после изменений файлов | #61 | [Текст задачи](semantic-note-links-tickets/06-file-changes.md) |
| [#66](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/66) | Поиск связей: сохранение выбора и жизненный цикл чата | #63 | [Текст задачи](semantic-note-links-tickets/07-chat-lifecycle.md) |

Первой доступна #60. После неё доступны #61, #62 и #64; после #61 — #63 и #65; после #63 — #66. Зависимости означают завершение блокирующей задачи, а не только начало работы над ней.

Каждая задача включает пользовательский результат, локализацию и проверки на согласованной интеграционной границе. Защита данных обязательна в первых рабочих сценариях; поздние задачи расширяют доступные сценарии и проверяют их сочетания.

