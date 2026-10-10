# Задачи поиска по заметкам хранилища

Разбиение согласовано пользователем и опубликовано в GitHub через навык to-tickets. Спецификация: [#12](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/12).

Все задачи имеют метку `ready-for-agent`; зависимости заданы нативными связями блокировки GitHub и продублированы в описаниях. Спецификация #12 не изменялась при публикации задач.

| Задача | Результат | Блокируется |
| --- | --- | --- |
| [#13](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/13) | Проверить локальное хранение индекса в настольном Obsidian | Нет |
| [#14](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/14) | Подключить и проверить независимую embedding-модель | Нет |
| [#15](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/15) | Получить первый ответ в чате по одной проиндексированной заметке | #13, #14 |
| [#16](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/16) | Искать по фрагментам длинных Markdown-заметок | #15 |
| [#17](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/17) | Построить индекс хранилища с исключениями папок | #16 |
| [#18](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/18) | Обновлять индекс при правках, удалении и переименовании заметок | #17 |
| [#19](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/19) | Приостанавливать и восстанавливать индексацию с сохранённого прогресса | #17 |
| [#20](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/20) | Совместить смысловой поиск с точными совпадениями | #17 |
| [#21](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/21) | Учитывать контекст диалога и бюджет источников | #15 |
| [#22](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/22) | Давать чату приоритет перед фоновой индексацией | #19 |
| [#23](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/23) | Выбирать файловое хранение индекса и перестраивать при переключении | #19 |
| [#24](https://github.com/AlexRaptor/Obsidian-AI-Helper/issues/24) | Провести приёмку поиска по заметкам и проверить большие хранилища | #18, #20, #21, #22, #23 |

Начальная очередь: #13 и #14. Далее берётся задача, все блокирующие задачи которой завершены. Закрытие проверки хранения само по себе не означает готовности зависимых задач, если результат проверки требует пересмотра архитектурного решения.

