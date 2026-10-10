# Автоматическое определение окна контекста

Проверено 10 октября 2026 года по документации и исходникам поставщиков.

## Вывод

Для LM Studio автоматическое определение возможно. Для произвольного OpenAI-совместимого сервера единого стандартного поля нет: стандартный объект OpenAI Model содержит `id`, `created`, `object`, `owned_by`, без размера контекста. Нужны адаптеры сервера и ручное значение при недоступности метаданных. [Схема OpenAI SDK](https://github.com/openai/openai-python/blob/main/src/openai/types/model.py).

## LM Studio

- `GET /api/v1/models` возвращает `models[].loaded_instances[].config.context_length`: конфигурацию загруженного экземпляра. Именно это значение подходит для знаменателя прогресс-бара.
- `models[].max_context_length` — поддерживаемый максимум модели; он может значительно превышать выбранное при загрузке окно. В официальном примере это 262144 против 4096.
- Для выбранного экземпляра нужно сопоставлять `loaded_instances[].id` с идентификатором, отправляемым в чат; при выборе по `key` учитывать возможность нескольких экземпляров. При пустом `loaded_instances` действующее окно ещё неизвестно.

Источник: [GET /api/v1/models](https://lmstudio.ai/docs/developer/rest/list).

Старый API `GET /api/v0/models` и `GET /api/v0/models/{model}` документирует `max_context_length`, но не `loaded_context_length`. Ответ `POST /api/v0/chat/completions` содержит `model_info.context_length`. Поэтому `loaded_context_length` нельзя обещать как документированный контракт v0. [REST API v0](https://lmstudio.ai/docs/developer/rest/endpoints).

## Другие серверы

| Сервер | Откуда читать | Ограничение |
| --- | --- | --- |
| Ollama | `GET /api/ps`, `models[].context_length` | Только для уже загруженной модели. [Документация](https://docs.ollama.com/api/ps) |
| llama.cpp | `GET /props`, `default_generation_settings.n_ctx` | Размер контекста слота; учитывать конфигурацию параллельных запросов. [API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [реализация слотов](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp) |
| vLLM | `GET /v1/models`, `data[].max_model_len` | Расширение стандартного Model; берётся из конфигурации обслуживаемой модели. [Реализация](https://docs.vllm.ai/en/v0.20.0/api/vllm/entrypoints/openai/models/serving/), [смысл max_model_len](https://docs.vllm.ai/en/latest/api/vllm/config/model/) |
| OpenRouter | `GET /api/v1/models`, `context_length` и `top_provider.context_length` | Метаданные модели/провайдера; нельзя автоматически приравнивать к конфигурации локального загруженного экземпляра. [API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) |

## Предложение для плагина

Автоматически получать действующее окно для выбранных сервера и модели; показывать источник значения и сохранять возможность ручного ввода. Обновлять данные после смены модели/сервера и загрузки модели. Ошибка запроса, отсутствующее поле или неоднозначный экземпляр не должны затирать ручную настройку. Для LM Studio начать с `/api/v1/models`; не подменять действующее окно максимумом модели без явного обозначения этой неточности.

## Реализация и проверка

Реализовано автоопределение для LM Studio, Ollama, vLLM и llama.cpp. Пустое поле включает автоматический режим, положительное целое число задаёт ручное переопределение. Определённый размер используется в индикаторе чата и бюджете источников. Проверка модели остаётся отдельным запросом генерации: метаданные не подтверждают её работоспособность. OpenRouter исследован, но адаптер для него не реализован.

Сборка `npm run build` и 276 тестов Vitest прошли успешно. Пользователь подтвердил успешную ручную проверку в Obsidian 10 октября 2026 года; версии приложений и результаты отдельных сценариев не сообщены.
