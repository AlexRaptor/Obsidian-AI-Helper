export type Locale = "en" | "ru";

export const LOCALES: readonly Locale[] = ["en", "ru"];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	ru: "Русский",
};

export const en = {
	"view-title": "AI Helper",
	"command": "Toggle AI Helper chat",
	"ribbon": "Toggle AI Helper chat",
	"input-placeholder": "Ask the model…",
	"send": "Send",
	"thinking": "Thinking…",
	"clear-conversation": "Clear conversation",
	"settings-title": "Obsidian AI Helper",
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
	"setting-generation": "Generation parameters",
	"setting-generation-desc":
		"Optional. Leave blank to use the server's defaults.",
	"setting-temperature": "Temperature",
	"setting-max-tokens": "Max tokens",
	"setting-top-p": "Top P",
	"chat-error-prefix": "Request failed",
} as const;

export const ru = {
	"view-title": "AI-ассистент",
	"command": "Показать/скрыть чат с ИИ",
	"ribbon": "Показать/скрыть чат с ИИ",
	"input-placeholder": "Спросите модель…",
	"send": "Отправить",
	"thinking": "Думаю…",
	"clear-conversation": "Очистить диалог",
	"settings-title": "Obsidian AI Helper",
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
	"setting-generation": "Параметры генерации",
	"setting-generation-desc":
		"Необязательно. Оставьте пустым, чтобы использовать значения по умолчанию сервера.",
	"setting-temperature": "Температура",
	"setting-max-tokens": "Макс. токенов",
	"setting-top-p": "Top P",
	"chat-error-prefix": "Ошибка запроса",
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
