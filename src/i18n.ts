export type Locale = "en" | "ru";

export const LOCALES: readonly Locale[] = ["en", "ru"];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	ru: "Русский",
};

export const en = {
	"chat-copy-message": "Copy message",
	"chat-message-copied": "Message copied",
	"chat-copy-failed": "Could not copy message",
	"chat-invalid-stream": "Model server returned an invalid stream event.",
	"chat-stream-error": "Model server returned a stream error.",
	"setting-response-wait": "Response wait time",
	"setting-response-wait-desc": "Seconds to wait for the first text and each pause between text parts. New text restarts the wait; active generation can last longer. Leave empty to wait indefinitely. Changes apply to the next request.",
	"setting-response-wait-invalid": "Enter a positive whole number of seconds, or leave empty. The last valid value is kept.",
	"chat-response-timeout": "The wait for model text expired. The request was cancelled.",
	"view-title": "AI Helper",
	"command": "Toggle AI Helper chat",
	"ribbon": "Toggle AI Helper chat",
	"input-placeholder": "Ask the model…",
	"send": "Send",
	"stop": "Stop",
	"chat-stopped": "Stopped",
	"thinking": "Thinking…",
	"clear-conversation": "Clear conversation",
	"settings-title": "Obsidian AI Helper",
	"settings-group-general": "General",
	"settings-group-connection": "Model server",
	"settings-group-model": "Model",
	"settings-group-generation": "Model responses",
	"setting-language": "Language",
	"setting-language-desc": "Interface language.",
	"setting-server-url": "Model server URL",
	"setting-server-url-desc":
		"Address of the OpenAI-compatible model server, including the /v1 suffix.",
	"setting-server-url-placeholder": "http://localhost:1234/v1",
	"setting-api-key": "API key",
	"setting-api-key-desc": "Optional. Sent as a Bearer token when set.",
	"setting-api-key-placeholder": "sk-…",
	"setting-model": "Model",
	"setting-model-desc": "Name of the model to chat with.",
	"setting-model-placeholder": "gpt-4o-mini",
	"setting-refresh-models": "Refresh models",
	"setting-refresh-models-desc": "Fetch the model list from the model server.",
	"setting-models-load-error":
		"Could not fetch the model list. Enter the model name manually.",
	"setting-models-empty":
		"The server returned no models. Enter the model name manually.",
	"setting-system-prompt": "System prompt",
	"setting-system-prompt-desc":
		"Optional. Prepended to the conversation to steer the model.",
	"setting-system-prompt-placeholder": "You are a helpful assistant.",
	"setting-temperature": "Temperature",
	"setting-temperature-desc": "Sampling randomness. Lower is more deterministic.",
	"setting-temperature-placeholder": "0.7",
	"setting-max-tokens": "Max tokens",
	"setting-max-tokens-desc": "Maximum length of the answer, in tokens.",
	"setting-max-tokens-placeholder": "1024",
	"setting-top-p": "Top P",
	"setting-top-p-desc": "Nucleus sampling: only consider tokens within this probability mass.",
	"setting-top-p-placeholder": "0.9",
	"setting-context-window": "Context window",
	"setting-context-window-desc":
		"Model context window size, in tokens. Used for the usage indicator in the chat header. Leave empty if unknown.",
	"setting-context-window-placeholder": "254000",
	"chat-error-prefix": "Request failed",
	"chat-invalid-params":
		"Generation parameters must be numbers. Correct the settings and try again.",
	"header-context": "Context window",
	"header-context-empty": "0 / 0 tokens",
	"header-context-unavailable": "No data",
	"chat-empty-response": "Model server returned an empty message.",
	"chat-incomplete-response": "Connection closed before the model finished.",
} as const;

export const ru = {
	"chat-copy-message": "Копировать сообщение",
	"chat-message-copied": "Сообщение скопировано",
	"chat-copy-failed": "Не удалось скопировать сообщение",
	"chat-invalid-stream": "Модель-сервер вернул некорректную часть потока.",
	"chat-stream-error": "Модель-сервер сообщил об ошибке потока.",
	"setting-response-wait": "Время ожидания ответа",
	"setting-response-wait-desc": "Секунды ожидания первого текста и каждой паузы между частями текста. Новый текст обновляет отсчёт; активная генерация может длиться дольше. Пустое поле — бесконечное ожидание. Изменения применяются к следующему запросу.",
	"setting-response-wait-invalid": "Введите целое положительное число секунд или оставьте поле пустым. Последнее корректное значение сохранено.",
	"chat-response-timeout": "Время ожидания текста модели истекло. Запрос отменён.",
	"view-title": "AI-ассистент",
	"command": "Показать/скрыть чат с ИИ",
	"ribbon": "Показать/скрыть чат с ИИ",
	"input-placeholder": "Спросите модель…",
	"send": "Отправить",
	"stop": "Остановить",
	"chat-stopped": "Остановлено",
	"thinking": "Думаю…",
	"clear-conversation": "Очистить диалог",
	"settings-title": "Obsidian AI Helper",
	"settings-group-general": "Общие",
	"settings-group-connection": "Модель-сервер",
	"settings-group-model": "Модель",
	"settings-group-generation": "Ответы модели",
	"setting-language": "Язык",
	"setting-language-desc": "Язык интерфейса.",
	"setting-server-url": "Адрес модель-сервера",
	"setting-server-url-desc":
		"Адрес OpenAI-совместимого модель-сервера, включая суффикс /v1.",
	"setting-server-url-placeholder": "http://localhost:1234/v1",
	"setting-api-key": "API-ключ",
	"setting-api-key-desc": "Необязательно. Отправляется как Bearer-токен, если задан.",
	"setting-api-key-placeholder": "sk-…",
	"setting-model": "Модель",
	"setting-model-desc": "Название модели, с которой ведётся чат.",
	"setting-model-placeholder": "gpt-4o-mini",
	"setting-refresh-models": "Обновить список моделей",
	"setting-refresh-models-desc": "Загрузить список моделей с модель-сервера.",
	"setting-models-load-error":
		"Не удалось получить список моделей. Введите название модели вручную.",
	"setting-models-empty":
		"Сервер не отдал список моделей. Введите название модели вручную.",
	"setting-system-prompt": "System-промпт",
	"setting-system-prompt-desc":
		"Необязательно. Добавляется в начало диалога, чтобы управлять моделью.",
	"setting-system-prompt-placeholder": "Ты — полезный ассистент.",
	"setting-temperature": "Температура",
	"setting-temperature-desc": "Случайность выборки. Ниже — более детерминированно.",
	"setting-temperature-placeholder": "0.7",
	"setting-max-tokens": "Макс. токенов",
	"setting-max-tokens-desc": "Максимальная длина ответа в токенах.",
	"setting-max-tokens-placeholder": "1024",
	"setting-top-p": "Top P",
	"setting-top-p-desc": "Nucleus-выборка: учитывать токены только в пределах этой массы вероятности.",
	"setting-top-p-placeholder": "0.9",
	"setting-context-window": "Окно контекста",
	"setting-context-window-desc":
		"Размер окна контекста модели в токенах. Используется для индикатора заполнения в шапке чата. Оставьте пустым, если неизвестно.",
	"setting-context-window-placeholder": "254000",
	"chat-error-prefix": "Ошибка запроса",
	"chat-invalid-params":
		"Параметры генерации должны быть числами. Исправьте настройки и повторите запрос.",
	"header-context": "Окно контекста",
	"header-context-empty": "0 / 0 токенов",
	"header-context-unavailable": "Нет данных",
	"chat-empty-response": "Модель-сервер вернул пустое сообщение.",
	"chat-incomplete-response": "Соединение закрыто до завершения сообщения модели.",
} as const;

export type LocaleKey = keyof typeof en;

const dictionaries: Record<Locale, Record<LocaleKey, string>> = { en, ru };

let current: Locale = DEFAULT_LOCALE;

export function setLanguage(locale: Locale): void {
	current = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

export function getLanguage(): Locale {
	return current;
}

export function t(key: LocaleKey): string {
	return dictionaries[current][key];
}
