import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, type WorkspaceLeaf, FileSystemAdapter, MarkdownView, TFile, TFolder } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { ChatView } from "../src/chat-view";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Menu, Notice, deferred, type TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
const plugins: AiHelperPlugin[] = [];
afterEach(() => { plugins.forEach(plugin => plugin.onunload()); plugins.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); Notice.messages.length = 0; });
async function setup(options: { source?: string; notes?: Record<string, string>; settings?: Record<string, unknown>; index?: boolean; metadata?: () => Promise<Response>; completion?: (body: any) => Promise<Response> } = {}) {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const files = new Map(Object.entries({ "Заметки/Мысль.md": "Сохранённая версия.", "Примеры/Практика.md": "# Практика\nИнтервальное повторение: проверяйте знания через день и через неделю.", ...options.notes }));
	const entries = new Map([...files.keys()].map(path => [path, Object.assign(new TFile(), { path, basename: path.split('/').at(-1)!.slice(0, -3), extension: "md" })]));
	const file = entries.get("Заметки/Мысль.md")!;
	let text = options.source ?? "# Обучение\nАктивное вспоминание помогает удерживать знания.";
	const editor = Object.assign(Object.create(MarkdownView.prototype), { file, getMode: () => "source", editor: { getValue: () => text } });
	const events = new Map<string, (...args: any[]) => void>();
	const commands = new Map<string, () => void>(); const requests: any[] = []; const embeddings: string[][] = [];
	const network = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith('/embeddings')) { const body = JSON.parse(String(init?.body)); embeddings.push(body.input); return Response.json({ data: body.input.map((_text: string, index: number) => ({ index, embedding: _text.includes('Активное') ? [1, 0] : [0.1, 1] })) }); }
		if (!url.endsWith('/chat/completions')) return options.metadata?.() ?? Response.json({ data: [] });
		const body = JSON.parse(String(init?.body)); requests.push(body);
		return options.completion ? options.completion(body) : answer(JSON.parse(body.messages.at(-1).content).candidate.id);
	});
	vi.stubGlobal('fetch', network);
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => '/связи';
	let chat: ChatView;
	const app = { fileManager: { generateMarkdownLink: (file: TFile) => '[[' + file.path.replace(/\.md$/, '') + ']]' }, vault: { adapter, on: () => ({}), offref() {}, getMarkdownFiles: () => [...entries.values()], getFiles: () => [...entries.values()], getFileByPath: (path: string) => entries.get(path) ?? null, read: vi.fn(async (file: TFile) => files.get(file.path)!), process: vi.fn(async (file: TFile, update: (text: string) => string) => { const next = update(files.get(file.path)!); files.set(file.path, next); if (editor.file === file) text = next; return next; }) }, metadataCache: { getFirstLinkpathDest: (name: string, from: string) => {
		const parts = from.split('/').slice(0, -1);
		for (const part of name.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
		const local = parts.join('/');
		return entries.get(local) ?? entries.get(local + '.md') ?? entries.get(name) ?? entries.get(name + '.md') ?? [...entries.values()].find(file => file.basename === name);
	} }, workspace: { getActiveViewOfType: (type: unknown) => type === MarkdownView ? editor : null, getLeavesOfType: (type: string) => type === 'markdown' ? [{ view: editor }] : type === 'ai-helper-chat' && chat ? [{ view: chat }] : [], on: (name: string, callback: (...args: any[]) => void) => { events.set(name, callback); return {}; }, onLayoutReady() {}, detachLeavesOfType() {}, ensureSideLeaf: async () => ({ view: chat }), revealLeaf: async () => {}, openLinkText: vi.fn(async () => {}) } } as unknown as App;
	const plugin = new AiHelperPlugin(app, { id: 'obsidian-ai-helper' } as PluginManifest); plugins.push(plugin);
	vi.spyOn(plugin, 'loadData').mockResolvedValue({ ...DEFAULT_SETTINGS, language: 'ru', serverUrl: 'http://server/v1', model: 'диалог', embeddingServerUrl: 'http://server/v1', embeddingModel: 'смысл', contextWindow: '32000', autoUpdateNotes: false, systemPrompt: 'СЕКРЕТ ОБЫЧНОГО ДИАЛОГА', ...options.settings });
	vi.spyOn(plugin, 'addCommand').mockImplementation((command: any) => { commands.set(command.id, command.callback); return command; });
	await plugin.onload();
	chat = new ChatView({} as WorkspaceLeaf, plugin); Object.assign(chat, { app }); await chat.onOpen();
	if (options.index !== false) for (const path of files.keys()) { try { await plugin.noteSearch.index(path); } catch {} }
	requests.length = 0; embeddings.length = 0; vi.mocked(app.vault.read).mockClear();
	const root = chat.contentEl as unknown as TestElement;
	return { plugin, chat, root, events, requests, embeddings, files, entries, app, editor, commands, setText: (value: string) => { text = value; }, run: async () => { expect(commands.has('find-note-connections')).toBe(true); commands.get('find-note-connections')!(); await vi.waitFor(() => expect(root.getText()).toContain('Сходство фрагмента')); } };
}
function answer(id: string, explanation = 'Практика дополняет активное вспоминание расписанием повторений через день и неделю.', finish = 'stop') { return Response.json({ choices: [{ message: { content: JSON.stringify({ candidate: id, explanation }) }, finish_reason: finish }] }); }

it('команда анализирует текущий текст и показывает проверенную связь отдельно от диалога', async () => {
	const env = await setup(); await env.run();
	expect(env.root.getText()).toContain('Мысль'); expect(env.root.getText()).toContain('Практика');
	expect(env.root.getText()).toContain('через день и неделю');
	expect(env.root.getText()).toContain('Интервальное повторение');
	const sent = JSON.stringify(env.requests); expect(sent).toContain('Активное вспоминание'); expect(sent).toContain('Интервальное повторение');
	expect(sent).not.toContain('Сохранённая версия'); expect(sent).not.toContain('СЕКРЕТ ОБЫЧНОГО');
	expect(env.chat.getMessages()).toEqual([]); expect(env.files.get('Заметки/Мысль.md')).toBe('Сохранённая версия.');
	env.root.find('ai-helper-connection-link').click(); await vi.waitFor(() => expect(env.app.workspace.openLinkText).toHaveBeenCalled());
	await env.chat.onClose();
});

it('не читает исключённые заметки и описания папок, а связанные цели различает по пути', async () => {
	const env = await setup({ source: 'Активное вспоминание.\n[[Архив/Практика#Раздел|подпись]]\n![Вложение](<../Материалы/Схема.md#^блок>)\n[Ссылка][расписание]\n\n[расписание]: ../Материалы/План.md\n\n`[[Примеры/Практика]]`\n```md\n[[Примеры/Практика]]\n```\nОбычное упоминание Практика.', notes: {
		'Архив/Практика.md': 'Уже связанная заметка.', 'Материалы/Схема.md': 'Уже встроенная заметка.', 'Материалы/План.md': 'Уже связанный план.',
		'Личное/Секрет.md': 'НЕ ПЕРЕДАВАТЬ СЕКРЕТ', 'Описание.md': 'НЕ ПЕРЕДАВАТЬ ОПИСАНИЕ',
	}, settings: { excludedFolders: ['Личное'], folderDescriptionName: 'Описание.md' } });
	await env.run();
	const sent = JSON.stringify(env.requests); expect(env.requests).toHaveLength(1);
	expect(sent).not.toContain('Уже связанная'); expect(sent).not.toContain('Уже встроенная'); expect(sent).not.toContain('Уже связанный план');
	expect(sent).not.toContain('НЕ ПЕРЕДАВАТЬ');
	expect(vi.mocked(env.app.vault.read).mock.calls.every(([file]) => file.path !== 'Личное/Секрет.md' && file.path !== 'Описание.md')).toBe(true);
	expect(env.root.getText()).toContain('Примеры/Практика.md'); await env.chat.onClose();
});

it('удаляет все корректные блоки обеих сторон из анализа, сохраняя их ссылки для дедупликации', async () => {
	const block = '<!-- ai-helper:related-notes:start -->\n## Связанные заметки\n- [[Материалы/План]] — СТАРОЕ ОБЪЯСНЕНИЕ\n<!-- ai-helper:related-notes:end -->\n';
	const env = await setup({ source: block + '\nАктивное вспоминание.\n\n' + block, notes: { 'Примеры/Практика.md': '# Практика\nИнтервальное повторение через неделю.\n\n' + block + '\nКонец содержательного текста.', 'Материалы/План.md': 'УЖЕ СВЯЗАННЫЙ ПЛАН' } });
	await env.run();
	const sent = JSON.stringify(env.requests); expect(sent).not.toContain('СТАРОЕ ОБЪЯСНЕНИЕ'); expect(sent).not.toContain('ai-helper:related-notes');
	expect(sent).not.toContain('УЖЕ СВЯЗАННЫЙ ПЛАН'); expect(sent).toContain('Конец содержательного текста');
	expect(JSON.stringify(env.embeddings)).not.toContain('СТАРОЕ ОБЪЯСНЕНИЕ');
	expect(env.root.getText()).not.toContain('СТАРОЕ ОБЪЯСНЕНИЕ'); await env.chat.onClose();
});

it.each([
	{ source: '  \n', settings: {}, index: true, expected: 'В исходной заметке нет текста' },
	{ source: '<!-- ai-helper:related-notes:start -->\n## Связанные заметки\n[[Примеры/Практика]]\n<!-- ai-helper:related-notes:end -->', settings: {}, index: true, expected: 'В исходной заметке нет текста' },
	{ source: 'Активное вспоминание.', settings: { excludedFolders: ['Заметки'] }, index: true, expected: 'исключ' },
	{ source: 'Активное вспоминание.', settings: { folderDescriptionName: 'Мысль.md' }, index: true, expected: 'исключ' },
	{ source: 'Активное вспоминание.', settings: {}, index: false, expected: 'индекс' },
	{ source: 'Активное вспоминание. '.repeat(1000), settings: { contextWindow: '4000' }, index: true, expected: 'текст не сокращался' },
])('отказывает до запроса модели диалога: $expected', async options => {
	const env = await setup(options); env.commands.get('find-note-connections')!();
	await vi.waitFor(() => expect(env.root.getText().toLowerCase()).toContain(options.expected.toLowerCase()));
	expect(env.requests).toHaveLength(0); expect(env.chat.getMessages()).toEqual([]); await env.chat.onClose();
});

it.each(['unknown', 'links', 'marker', 'empty', 'incomplete', 'malformed', 'duplicate'])(
	'не публикует некорректную порцию: %s', async kind => {
		const env = await setup({ notes: { 'Примеры/Продолжение.md': 'Продолжение мысли о повторении.' }, completion: async body => {
			const id = JSON.parse(body.messages.at(-1).content).candidate.id;
			if (kind === 'unknown') return answer('несуществующая-цель');
			if (kind === 'links') return answer(id, 'Смотрите [[Секрет]] и [дополнение](https://example.org).');
			if (kind === 'marker') return answer(id, '<!-- ai-helper:related-notes:start -->');
			if (kind === 'empty') return answer(id, '');
			if (kind === 'incomplete') return answer(id, undefined, 'length');
			const content = kind === 'duplicate' ? JSON.stringify([{ candidate: id, explanation: 'Объяснение первой связи.' }, { candidate: id, explanation: 'Объяснение повтора.' }]) : '{';
			return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
		} });
		env.commands.get('find-note-connections')!();
		await vi.waitFor(() => expect(env.root.getText()).toContain('Предложения не опубликованы'));
		expect(() => env.root.find('ai-helper-connection')).toThrow('Element not found');
		expect(env.chat.getMessages()).toEqual([]); await env.chat.onClose();
	});

it('проверяет расширенный фиксированный набор, пропускает слабые связи и показывает не более пяти заметок', async () => {
	const notes = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`Примеры/Материал-${String(i).padStart(2, '0')}.md`, '# Пример\nПрактический приём закрепления знаний.\n\n## Подробности\nПроверка изученного через неделю.']));
	const seen: string[] = [];
	const env = await setup({ notes, settings: { noteSourceBudget: '1', noteSearchMinSimilarity: 1 }, completion: async body => {
		const candidate = JSON.parse(body.messages.at(-1).content).candidate; seen.push(candidate.path);
		return Response.json({ choices: [{ message: { content: JSON.stringify({ candidate: candidate.id, explanation: seen.length <= 7 ? null : 'Пример дополняет активное вспоминание проверкой изученного через неделю.' }) }, finish_reason: 'stop' }] });
	} });
	await env.run();
	expect(seen).toHaveLength(12); expect(new Set(seen).size).toBe(12);
	const collect = (element: TestElement): TestElement[] => [...(element.classes.has('ai-helper-connection') ? [element] : []), ...element.children.flatMap(collect)];
	expect(collect(env.root)).toHaveLength(5);
	expect(env.requests.every(body => JSON.parse(body.messages.at(-1).content).candidate.fragments.every((fragment: any) => fragment.headings.length > 0))).toBe(true);
	await env.chat.onClose();
});

it('не помечает полный индекс неполным из-за исключения самой исходной заметки', async () => {
	const env = await setup(); await env.plugin.noteSearch.indexVault(); await env.run();
	expect(env.root.getText()).not.toContain('Индекс неполный'); await env.chat.onClose();
});

it('сообщает об отсутствии новых связей, когда все кандидаты уже связаны', async () => {
	const env = await setup({ source: 'Активное вспоминание. [[Примеры/Практика]]' });
	env.commands.get('find-note-connections')!();
	await vi.waitFor(() => expect(env.root.getText()).toContain('полезных связей не найдено'));
	expect(env.requests).toHaveLength(0); await env.chat.onClose();
});

it('использует только актуальную часть индекса и предупреждает о неполном охвате', async () => {
	const env = await setup({ notes: { 'Примеры/Устаревшая.md': 'СТАРЫЙ МАТЕРИАЛ' } });
	env.files.set('Примеры/Устаревшая.md', 'НОВЫЙ НЕПРОИНДЕКСИРОВАННЫЙ МАТЕРИАЛ'); await env.run();
	expect(env.root.getText()).toContain('Индекс неполный'); expect(JSON.stringify(env.requests)).not.toContain('МАТЕРИАЛ');
	await env.chat.onClose();
});

it('отмена освобождает общую занятость и игнорирует поздний ответ после смены редактора', async () => {
	const pending = deferred<Response>();
	const env = await setup({ completion: () => pending.promise });
	env.commands.get('find-note-connections')!(); await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	Object.assign(env.editor, { file: Object.assign(new TFile(), { path: 'Другая.md', extension: 'md' }) });
	expect(env.root.getText()).toContain('Заметки/Мысль.md'); expect(env.plugin.conversationModel.tryAcquire()).toBeUndefined();
	env.root.find('ai-helper-connections-cancel').click();
	const next = env.plugin.conversationModel.tryAcquire(); expect(next).toBeDefined(); next!.release();
	pending.resolve(answer('c1')); await new Promise(resolve => setTimeout(resolve, 25));
	expect(env.root.getText()).toContain('Поиск связей отменён'); expect(env.root.getText()).not.toContain('Сходство фрагмента'); expect(env.chat.getMessages()).toEqual([]);
	await env.chat.onClose();
});

it.each(['clear', 'close', 'new'])( 'не возвращает поздний результат после действия %s', async action => {
	const pending = deferred<Response>(); let count = 0;
	const env = await setup({ completion: async body => ++count === 1 ? pending.promise : answer(JSON.parse(body.messages.at(-1).content).candidate.id, 'Новое объяснение: повторение закрепляет результаты активного вспоминания.') });
	env.commands.get('find-note-connections')!(); await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	if (action === 'clear') env.chat.clearConversation();
	else if (action === 'close') await env.chat.onClose();
	else await env.run();
	pending.resolve(answer('c1', 'Старое объяснение не должно появиться в панели.')); await new Promise(resolve => setTimeout(resolve, 25));
	expect(env.root.getText()).not.toContain('Старое объяснение');
	const lease = env.plugin.conversationModel.tryAcquire(); expect(lease).toBeDefined(); lease!.release();
	if (action !== 'close') await env.chat.onClose();
});

it('ошибка модель-сервера не меняет модель и освобождает занятость без пустых карточек', async () => {
	const env = await setup({ completion: async () => Response.json({ error: { message: 'Недоступно' } }, { status: 503 }) });
	env.commands.get('find-note-connections')!();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Модель диалога недоступна'));
	expect(env.requests).toHaveLength(1); expect(env.requests[0].model).toBe('диалог'); expect(env.chat.getMessages()).toEqual([]);
	const lease = env.plugin.conversationModel.tryAcquire(); expect(lease).toBeDefined(); lease!.release(); await env.chat.onClose();
});

it('обычный вопрос после поиска не получает материалы предложений, а история не попадает в поиск', async () => {
	let ordinary = false;
	const env = await setup({ completion: async body => ordinary ? Response.json({ choices: [{ message: { content: 'Ответ обычного диалога.' }, finish_reason: 'stop' }] }) : answer(JSON.parse(body.messages.at(-1).content).candidate.id) });
	env.chat.conversation.addMessage({ role: 'user', content: 'ПРЕЖНЯЯ ИСТОРИЯ' });
	await env.run(); expect(JSON.stringify(env.requests)).not.toContain('ПРЕЖНЯЯ ИСТОРИЯ');
	ordinary = true; env.requests.length = 0;
	env.root.find('ai-helper-input').value = 'Объясни другое понятие'; env.root.find('ai-helper-send').click();
	await vi.waitFor(() => expect(env.chat.getMessages()).toHaveLength(3));
	const sent = JSON.stringify(env.requests); expect(sent).not.toContain('Активное вспоминание'); expect(sent).not.toContain('Интервальное повторение');
	expect(sent).toContain('ПРЕЖНЯЯ ИСТОРИЯ'); await env.chat.onClose();
});

it('конкурирующий обычный диалог не отправляется во время поиска', async () => {
	const pending = deferred<Response>(); const env = await setup({ completion: () => pending.promise });
	env.commands.get('find-note-connections')!(); await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.root.find('ai-helper-input').value = 'Конкурирующий вопрос'; env.root.find('ai-helper-send').click();
	expect(env.chat.getMessages()).toEqual([]); expect(env.requests).toHaveLength(1); expect(Notice.messages.at(-1)).toContain('Дождитесь завершения');
	env.chat.stopGeneration(); pending.resolve(answer('c1')); await env.chat.onClose();
});

it('различает вложенные подписи Markdown-ссылок и неиспользованные определения ссылок', async () => {
	const env = await setup({ source: 'Активное вспоминание.\n[**Важная [подпись]**](<../Архив/Связанная.md#Раздел>)\n\n[неиспользованная]: ../Примеры/Практика.md', notes: { 'Архив/Связанная.md': 'СВЯЗАННЫЙ МАТЕРИАЛ С ВЛОЖЕННОЙ ПОДПИСЬЮ' } });
	await env.run(); expect(env.requests).toHaveLength(1); expect(JSON.stringify(env.requests)).not.toContain('СВЯЗАННЫЙ МАТЕРИАЛ С ВЛОЖЕННОЙ ПОДПИСЬЮ');
	expect(env.root.getText()).toContain('Примеры/Практика.md'); await env.chat.onClose();
});

it('учитывает ссылки во вложенных списках, сохраняя отличие от отступленного кода', async () => {
	const env = await setup({ source: 'Активное вспоминание.\n\n    [[Примеры/Практика]]\n\n- Раздел\n    - [[Архив/Связанная]]', notes: { 'Архив/Связанная.md': 'СВЯЗАННЫЙ ВЛОЖЕННЫЙ МАТЕРИАЛ' } });
	await env.run(); expect(env.requests).toHaveLength(1); expect(JSON.stringify(env.requests)).not.toContain('СВЯЗАННЫЙ ВЛОЖЕННЫЙ МАТЕРИАЛ');
	expect(env.root.getText()).toContain('Примеры/Практика.md'); await env.chat.onClose();
});

it('не передаёт текст исходной заметки после её исключения во время подготовки', async () => {
	const metadata = deferred<Response>(); const env = await setup({ metadata: () => metadata.promise });
	env.commands.get('find-note-connections')!(); await vi.waitFor(() => expect(env.chat.isGenerating()).toBe(true));
	env.plugin.noteSearch.configure({ ...env.plugin.settings, excludedFolders: ['Заметки'] });
	metadata.resolve(Response.json({ data: [{ id: 'диалог', max_model_len: 32000 }] }));
	await vi.waitFor(() => expect(env.chat.isGenerating()).toBe(false));
	expect(env.embeddings).toHaveLength(0); expect(env.requests).toHaveLength(0); expect(env.root.getText()).toContain('исключ');
	await env.chat.onClose();
});

it.each(['- ~~~md\n  [[Примеры/Практика]]\n  ~~~', '> ~~~md\n> [[Примеры/Практика]]\n> ~~~'])(
	'не принимает за связь пример кода в контейнере Markdown: %s', async example => {
		const env = await setup({ source: 'Активное вспоминание.\n\n' + example });
		await env.run(); expect(env.requests).toHaveLength(1); expect(env.root.getText()).toContain('Примеры/Практика.md'); await env.chat.onClose();
	});

it.each(['> ~~~md\n> [[Примеры/Практика]]', '- ~~~md\n  [[Примеры/Практика]]'])(
	'завершает незакрытый код на границе контейнера: %s', async example => {
		const env = await setup({ source: 'Активное вспоминание.\n\n' + example + '\n\n[[Архив/Связанная]]', notes: { 'Архив/Связанная.md': 'СВЯЗАННЫЙ МАТЕРИАЛ ПОСЛЕ КОНТЕЙНЕРА' } });
		await env.run(); expect(env.requests).toHaveLength(1); expect(JSON.stringify(env.requests)).not.toContain('СВЯЗАННЫЙ МАТЕРИАЛ ПОСЛЕ КОНТЕЙНЕРА'); await env.chat.onClose();
	});

const sourceText = '# Обучение\nАктивное вспоминание помогает удерживать знания.';
const explanation = 'Практика дополняет активное вспоминание расписанием повторений через день и неделю.';
it('добавляет только выбранную связь обычным Markdown и не меняет другие заметки', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText, 'Примеры/Продолжение.md': 'Пример продолжения активного вспоминания.' } }); await env.run();
	const before = new Map(env.files);
	env.root.find('ai-helper-connection-select').click();
	env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	const path = env.root.find('ai-helper-connection-link').getText().replace(/\.md$/, '');
	expect(env.files.get('Заметки/Мысль.md')).toBe(sourceText + '\n\n<!-- ai-helper:related-notes:start -->\n## Связанные заметки\n- [[' + path + ']] — ' + explanation + '\n<!-- ai-helper:related-notes:end -->\n');
	for (const [path, text] of before) if (path !== 'Заметки/Мысль.md') expect(env.files.get(path)).toBe(text);
	expect(env.root.getText()).toContain('Добавлено'); await env.chat.onClose();
});

it.each(['clear', 'new', 'close'])('сохраняет несохранённый выбор при действии %s', async action => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run();
	env.root.find('ai-helper-connection-select').click();
	const count = env.requests.length;
	if (action === 'clear') env.root.find('ai-helper-clear-btn').click();
	else if (action === 'new') env.commands.get('find-note-connections')!();
	else { await env.chat.onClose(); const reopened = new ChatView({} as WorkspaceLeaf, env.plugin); Object.assign(reopened, { app: env.app }); await reopened.onOpen(); expect((reopened.contentEl as unknown as TestElement).getText()).toContain('Снять выбор'); await reopened.onClose(); return; }
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сначала добавьте выбранные связи или снимите выбор'));
	expect(env.root.getText()).toContain('Снять выбор'); expect(env.requests).toHaveLength(count);
	await env.chat.onClose();
});

it('после изменения исходника требует новый поиск даже при восстановлении прежнего текста', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	env.setText(sourceText + '\nРучная правка.'); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Запустите новый поиск'));
	env.setText(sourceText); env.root.find('ai-helper-connections-add').click();
	await new Promise(resolve => setTimeout(resolve, 30));
	expect(env.files.get('Заметки/Мысль.md')).toBe(sourceText); expect(env.root.getText()).toContain('Снять выбор'); await env.chat.onClose();
});

it('отказывает, если найденная заметка меняется, пока запись ожидает блокировку файла', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	vi.mocked(env.app.vault.process).mockImplementationOnce(async (file, update) => {
		const target = env.app.vault.getFileByPath('Примеры/Практика.md')!;
		env.files.set(target.path, 'Содержимое изменилось перед записью.'); Object.assign(target, { stat: { mtime: 2, size: 100 } });
		const next = update(env.files.get(file.path)!); env.files.set(file.path, next); return next;
	});
	env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('выбор сохранён'));
	expect(env.files.get('Заметки/Мысль.md')).toBe(sourceText); expect(env.root.getText()).toContain('Снять выбор'); await env.chat.onClose();
});

it('ошибка записи сохраняет выбор, повтор очищает ошибку и добавляет связь ровно один раз', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	vi.mocked(env.app.vault.process).mockRejectedValueOnce(new Error('Нет доступа'));
	env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Не удалось добавить связи'));
	expect(env.files.get('Заметки/Мысль.md')).toBe(sourceText); expect(env.root.getText()).toContain('Снять выбор');
	env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	expect(env.root.getText()).not.toContain('Не удалось добавить связи');
	expect(env.files.get('Заметки/Мысль.md')!.match(/\[\[Примеры\/Практика\]\]/g)).toHaveLength(1); await env.chat.onClose();
});

it.each([
	{ suffix: '\n', tail: true },
	{ suffix: '\n  \n\t', tail: true },
	{ suffix: '\n\nТекст после старого блока.', tail: false },
])('сохраняет заголовок и ручные правки, дополняя только конечный блок: $suffix', async ({ suffix, tail }) => {
	const old = '<!-- ai-helper:related-notes:start -->\n## My heading\n- Ручная строка со своим объяснением.\n<!-- ai-helper:related-notes:end -->';
	const source = sourceText + '\n\n' + old + suffix;
	const env = await setup({ source, notes: { 'Заметки/Мысль.md': source } }); await env.run();
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	const line = '- [[Примеры/Практика]] — ' + explanation + '\n';
	expect(env.files.get('Заметки/Мысль.md')).toBe(tail ? source.replace('<!-- ai-helper:related-notes:end -->', line + '<!-- ai-helper:related-notes:end -->') : source + '\n\n<!-- ai-helper:related-notes:start -->\n## Связанные заметки\n' + line + '<!-- ai-helper:related-notes:end -->\n');
	await env.chat.onClose();
});

it.each([
	'<!-- ai-helper:related-notes:start -->\nРучное объяснение без конца.',
	'<!-- ai-helper:related-notes:end -->',
	'<!-- ai-helper:related-notes:start -->\n<!-- ai-helper:related-notes:start -->\n<!-- ai-helper:related-notes:end -->\n<!-- ai-helper:related-notes:end -->',
	'Текст <!-- ai-helper:related-notes:start --> внутри строки.',
])('отказывает при повреждённых границах, сохраняя исходник и выбор: %s', async block => {
	const source = sourceText + '\n\n' + block;
	const env = await setup({ source, notes: { 'Заметки/Мысль.md': source } }); await env.run();
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Границы блока'));
	expect(env.files.get('Заметки/Мысль.md')).toBe(source); expect(env.root.getText()).toContain('Снять выбор'); await env.chat.onClose();
});

it('позволяет добавить следующую связь в том же поиске, отклонить и вернуть карточку', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText, 'Примеры/Продолжение.md': 'Пример продолжения активного вспоминания.' } }); await env.run();
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	env.root.find('ai-helper-connection-reject').click(); expect(env.root.getText()).toContain('Вернуть');
	expect(env.root.find('ai-helper-connections-add').disabled).toBe(true);
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.files.get('Заметки/Мысль.md')).toContain('[[Примеры/Продолжение]]'));
	const text = env.files.get('Заметки/Мысль.md')!;
	expect(text.match(/ai-helper:related-notes:start/g)).toHaveLength(1);
	expect(text.match(/\[\[Примеры\/Практика\]\]/g)).toHaveLength(1); expect(text.match(/\[\[Примеры\/Продолжение\]\]/g)).toHaveLength(1);
	expect(env.requests).toHaveLength(2); await env.chat.onClose();
});

it.each(['исходник', 'цель', 'редактор', 'удаление', 'перемещение'])('проверяет актуальность перед сохранением: %s', async kind => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	if (kind === 'исходник') env.files.set('Заметки/Мысль.md', sourceText + '\nПравка на диске.');
	if (kind === 'цель') env.files.set('Примеры/Практика.md', 'Изменённая практика.');
	if (kind === 'редактор') env.setText(sourceText + '\nНесохранённая правка.');
	if (kind === 'удаление') env.entries.delete('Заметки/Мысль.md');
	if (kind === 'перемещение') Object.assign(env.editor.file, { path: 'Перемещена.md' });
	const before = new Map(env.files); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('выбор сохранён'));
	expect(env.files).toEqual(before); expect(env.root.getText()).toContain('Снять выбор'); await env.chat.onClose();
});

it('повторное нажатие во время записи не запускает вторую запись', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	const pending = deferred<void>(); const process = vi.mocked(env.app.vault.process).getMockImplementation()!;
	vi.mocked(env.app.vault.process).mockImplementationOnce(async (file, update) => { await pending.promise; return process(file, update); });
	const button = env.root.find('ai-helper-connections-add'); button.click(); button.click();
	await vi.waitFor(() => expect(env.app.vault.process).toHaveBeenCalledTimes(1));
	expect(env.root.find('ai-helper-connections-add').disabled).toBe(true);
	pending.resolve(); await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	expect(env.files.get('Заметки/Мысль.md')!.match(/\[\[Примеры\/Практика\]\]/g)).toHaveLength(1); await env.chat.onClose();
});

it('проверяет исходный текст внутри атомарной записи и не берёт текст другого редактора', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run(); env.root.find('ai-helper-connection-select').click();
	const file = env.editor.file;
	Object.assign(env.editor, { file: env.app.vault.getFileByPath('Примеры/Практика.md') }); env.setText(env.files.get('Примеры/Практика.md')!);
	vi.mocked(env.app.vault.process).mockImplementationOnce(async (_file, update) => {
		env.files.set(file.path, sourceText + '\nКонкурирующая запись.');
		const next = update(env.files.get(file.path)!); env.files.set(file.path, next); return next;
	});
	env.root.find('ai-helper-connections-add').click(); await vi.waitFor(() => expect(env.root.getText()).toContain('Запустите новый поиск'));
	expect(env.files.get(file.path)).toBe(sourceText + '\nКонкурирующая запись.'); await env.chat.onClose();
});

it('сохраняет Markdown-ссылку, выбранную нативным генератором Obsidian', async () => {
	const env = await setup({ notes: { 'Заметки/Мысль.md': sourceText } }); await env.run();
	Object.assign(env.app.fileManager, { generateMarkdownLink: () => '[Практика](../Примеры/Практика.md)' });
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	expect(env.files.get('Заметки/Мысль.md')).toContain('- [Практика](../Примеры/Практика.md) — ' + explanation); await env.chat.onClose();
});

it('заново разрешает существующие ссылки перед записью и сообщает причину пропуска', async () => {
	const source = sourceText + '\n[[Примеры/Практика#Раздел|подпись]]';
	const env = await setup({ source, notes: { 'Заметки/Мысль.md': source } });
	const resolve = env.app.metadataCache.getFirstLinkpathDest;
	vi.spyOn(env.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(null);
	await env.run();
	vi.mocked(env.app.metadataCache.getFirstLinkpathDest).mockImplementation(resolve);
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 0'));
	expect(env.root.getText()).toContain('ссылка уже существует'); expect(env.files.get('Заметки/Мысль.md')).toBe(source);
	expect(env.app.vault.process).not.toHaveBeenCalled(); await env.chat.onClose();
});

it.each(['```text\nНезакрытый пример.', '~~~md\nНезакрытый пример.'])('не сообщает об успехе, если добавленный блок оказался бы внутри кода: %s', async code => {
	const source = sourceText + '\n\n' + code;
	const env = await setup({ source, notes: { 'Заметки/Мысль.md': source } }); await env.run();
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Границы блока'));
	expect(env.files.get('Заметки/Мысль.md')).toBe(source); expect(env.root.getText()).toContain('Снять выбор');
	expect(env.root.getText()).not.toContain('Добавлено связей: 1'); await env.chat.onClose();
});

it.skipIf(!process.env.AI_HELPER_LAYOUT_BROWSER).each([1, 5])('предложения и раскрытые фрагменты прокручиваются до низа области чата: %s карточек', async count => {
	const env = await setup({ notes: Object.fromEntries(Array.from({ length: count }, (_, index) => [index === 0 ? 'Примеры/Практика.md' : `Примеры/Повторение-${index}.md`, '# Проверка знаний\nВспомните изученное самостоятельно.\n\n## Через день\nПроверьте знания на следующий день.\n\n## Через неделю\nВернитесь к материалу через неделю.'])) });
	await env.run();
	const { checkChatLayout } = await import('./helpers/browser-layout');
	checkChatLayout(env.root);
	await env.chat.onClose();
}, 20000);

it('показывает новый поиск над прежним диалогом и сохраняет прокрутку при выборе карточки', async () => {
	let ordinary = true;
	const env = await setup({ completion: async body => ordinary ? Response.json({ choices: [{ message: { content: 'Предыдущий длинный ответ.\n'.repeat(100) }, finish_reason: 'stop' }] }) : answer(JSON.parse(body.messages.at(-1).content).candidate.id) });
	env.root.find('ai-helper-input').value = 'Объясни повторение'; env.root.find('ai-helper-send').click();
	await vi.waitFor(() => expect(env.chat.getMessages()).toHaveLength(2)); ordinary = false;
	const viewport = env.root.find('ai-helper-messages');
	viewport.clientHeight = 400; viewport.scrollHeight = 2000; viewport.scrollTop = 1600; viewport.dispatchEvent({ type: 'scroll' });
	await env.run(); expect(viewport.scrollTop).toBe(0);
	viewport.scrollTop = 120; env.root.find('ai-helper-connection-select').click(); expect(viewport.scrollTop).toBe(120);
	await env.chat.onClose();
});

const folder = (path: string) => Object.assign(new TFolder(), { path });
function connectionMenu(env: Awaited<ReturnType<typeof setup>>, selection: (TFile | TFolder)[], multiple = true) {
	const menu = new Menu();
	env.events.get(multiple ? 'files-menu' : 'file-menu')!(menu, multiple ? selection : selection[0], 'file-explorer');
	return menu.items.find(item => item.title === 'Найти связи для текущей заметки в выбранных папках');
}

it('меню одной папки ограничивает кандидатов рекурсивно, сохраняя текущую заметку вне области', async () => {
	const env = await setup({ notes: { 'Примеры/Вложенная/Повторение.md': 'Дополнительная проверка знаний.', 'Примеры-другие/Секрет.md': 'НЕЛЬЗЯ ПЕРЕДАВАТЬ' } });
	const item = connectionMenu(env, [folder('Примеры')], false); expect(item).toBeDefined(); item!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сходство фрагмента'));
	expect(env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path).sort()).toEqual(['Примеры/Вложенная/Повторение.md', 'Примеры/Практика.md']);
	expect(env.requests.every(body => JSON.parse(body.messages.at(-1).content).source.path === 'Заметки/Мысль.md')).toBe(true);
	expect(env.root.getText()).toContain('Заметки/Мысль.md');
	expect(env.root.getText()).toContain('Примеры/Вложенная/Повторение.md');
	expect(env.root.getText()).not.toContain('Секрет');
	expect(vi.mocked(env.app.vault.read).mock.calls.map(([file]) => file.path)).not.toContain('Примеры-другие/Секрет.md');
	expect(JSON.stringify(env.embeddings)).not.toContain('НЕЛЬЗЯ ПЕРЕДАВАТЬ');
	await env.chat.onClose();
});


it('меню нескольких папок объединяет вложенные области без повторов и соблюдает исключения', async () => {
	const env = await setup({ notes: { 'Примеры/Вложенная/Повторение.md': 'Проверка знаний через неделю.', 'Примеры/Закрыто/Секрет.md': 'ИСКЛЮЧЁННЫЙ ТЕКСТ', 'Дополнения/План.md': 'Расписание закрепления изученного.', 'Закрыто/Секрет.md': 'ИСКЛЮЧЁННЫЙ ТЕКСТ' }, settings: { excludedFolders: ['Примеры/Закрыто', 'Закрыто'] } });
	const item = connectionMenu(env, [folder('Примеры'), folder('Примеры/Вложенная'), folder('Дополнения'), folder('Закрыто')]);
	expect(item).toBeDefined(); item!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сходство фрагмента'));
	expect(env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path).sort()).toEqual(['Дополнения/План.md', 'Примеры/Вложенная/Повторение.md', 'Примеры/Практика.md']);
	expect(env.root.getText()).toContain('Дополнения/План.md'); expect(env.root.getText()).not.toContain('Секрет');
	expect(vi.mocked(env.app.vault.read).mock.calls.some(([file]) => file.path.includes('Закрыто'))).toBe(false);
	expect(JSON.stringify([env.requests, env.embeddings])).not.toContain('ИСКЛЮЧЁННЫЙ ТЕКСТ');
	await env.chat.onClose();
});

it.each(['Пустая', 'Закрыто', 'Заметки'])('пустая допустимая область %s объясняется до обращений к модели', async path => {
	const env = await setup({ notes: { 'Закрыто/Секрет.md': 'Исключённый материал.' }, settings: { excludedFolders: ['Закрыто'] } });
	connectionMenu(env, [folder(path)])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('нет допустимых заметок-кандидатов'));
	expect(env.requests).toHaveLength(0); expect(env.embeddings).toHaveLength(0);
	expect(env.app.vault.read).not.toHaveBeenCalled(); await env.chat.onClose();
});

it('не предлагает действие для смешанного выбора, одних файлов и пустого выбора', async () => {
	const env = await setup();
	for (const selection of [[folder('Примеры'), env.entries.get('Заметки/Мысль.md')!], [env.entries.get('Заметки/Мысль.md')!], []]) expect(connectionMenu(env, selection)).toBeUndefined();
	await env.chat.onClose();
});

it('область с непроиндексированной заметкой не выдаётся за полный поиск при полном сохранённом индексе', async () => {
	const env = await setup(); await env.plugin.noteSearch.indexVault();
	env.files.set('Примеры/Новая.md', 'Новый материал вне индекса.');
	env.entries.set('Примеры/Новая.md', Object.assign(new TFile(), { path: 'Примеры/Новая.md', extension: 'md' }));
	connectionMenu(env, [folder('Примеры')])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сходство фрагмента'));
	expect(env.root.getText()).toContain('Индекс неполный');
	expect(env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path)).toEqual(['Примеры/Практика.md']);
	await env.chat.onClose();
});

it('после поиска в папке команда снова ищет по всему хранилищу', async () => {
	const env = await setup({ notes: { 'Другие/План.md': 'Расписание повторений.' } });
	connectionMenu(env, [folder('Примеры')])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сходство фрагмента'));
	expect(env.requests).toHaveLength(1); env.requests.length = 0;
	env.commands.get('find-note-connections')!();
	await vi.waitFor(() => expect(env.requests).toHaveLength(2));
	await vi.waitFor(() => expect(env.chat.isGenerating()).toBe(false));
	expect(env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path).sort()).toEqual(['Другие/План.md', 'Примеры/Практика.md']);
	await env.chat.onClose();
});

it('запуск из проводника использует запомненный редактор и сохраняет связь в исходную заметку', async () => {
	const source = '# Обучение\nАктивное вспоминание помогает запоминать.';
	const env = await setup({ source, notes: { 'Заметки/Мысль.md': source } });
	vi.spyOn(env.app.workspace, 'getActiveViewOfType').mockReturnValue(null);
	connectionMenu(env, [folder('Примеры')])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Сходство фрагмента'));
	env.root.find('ai-helper-connection-select').click(); env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 1'));
	expect(env.files.get('Заметки/Мысль.md')).toContain('[[Примеры/Практика]]');
	expect(env.files.get('Примеры/Практика.md')).not.toContain('ai-helper:related-notes');
	await env.chat.onClose();
});

it('при отсутствии индекса в выбранной области не анализирует индекс других папок', async () => {
	const env = await setup();
	env.files.set('Новая/Кандидат.md', 'Неиндексированное дополнение.');
	env.entries.set('Новая/Кандидат.md', Object.assign(new TFile(), { path: 'Новая/Кандидат.md', extension: 'md' }));
	connectionMenu(env, [folder('Новая')])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain(env.plugin.t('search-rebuild')));
	expect(env.requests).toHaveLength(0); expect(env.embeddings).toHaveLength(0);
	expect(env.app.vault.read).not.toHaveBeenCalled(); await env.chat.onClose();
});

it('пустые индексированные заметки не скрывают отсутствие индекса остальных кандидатов области', async () => {
	const env = await setup({ notes: { 'Область/Пустая.md': '' } }); await env.plugin.noteSearch.indexVault();
	env.files.set('Область/Новая.md', 'Новый материал вне индекса.');
	env.entries.set('Область/Новая.md', Object.assign(new TFile(), { path: 'Область/Новая.md', extension: 'md' }));
	connectionMenu(env, [folder('Область')])!.callback();
	await vi.waitFor(() => expect(env.root.getText()).toContain(env.plugin.t('connections-none')));
	expect(env.root.getText()).toContain('Индекс неполный');
	expect(env.requests).toHaveLength(0); await env.chat.onClose();
});

function cards(root: TestElement): TestElement[] {
	return [...(root.classes.has('ai-helper-connection') ? [root] : []), ...root.children.flatMap(cards)];
}
it('продолжает фиксированный поиск порциями полезных связей и сохраняет накопленный выбор', async () => {
	const notes = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`Примеры/Приём-${i}.md`, 'Проверяйте знания через неделю.']));
	let count = 0;
	const env = await setup({ source: sourceText, notes: { ...notes, 'Заметки/Мысль.md': sourceText }, settings: { connectionSuggestionCount: '2' }, completion: async body => {
		const id = JSON.parse(body.messages.at(-1).content).candidate.id;
		return ++count === 2 ? Response.json({ choices: [{ message: { content: JSON.stringify({ candidate: id, explanation: null }) }, finish_reason: 'stop' }] }) : answer(id);
	} });
	await env.run(); expect(cards(env.root)).toHaveLength(2); expect(env.requests).toHaveLength(3);
	cards(env.root)[0].find('ai-helper-connection-select').click();
	cards(env.root)[1].find('ai-helper-connection-reject').click();
	env.plugin.settings.connectionSuggestionCount = '20';
	const embeddingCount = env.embeddings.length;
	env.root.find('ai-helper-connections-more').click();
	await vi.waitFor(() => expect(cards(env.root)).toHaveLength(4));
	expect(cards(env.root)[0].getText()).toContain('Снять выбор'); expect(cards(env.root)[1].getText()).toContain('Вернуть');
	cards(env.root)[2].find('ai-helper-connection-select').click();
	env.root.find('ai-helper-connections-add').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Добавлено связей: 2'));
	expect(env.files.get('Заметки/Мысль.md')!.match(/^- \[\[/gm)).toHaveLength(2);
	env.root.find('ai-helper-connections-more').click();
	await vi.waitFor(() => expect(cards(env.root)).toHaveLength(5));
	expect(env.root.getText()).toContain('Больше предложений в этом поиске нет');
	expect(env.embeddings).toHaveLength(embeddingCount);
	expect(new Set(env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path)).size).toBe(6);
	expect(env.root.getText()).toContain('Добавлено'); await env.chat.onClose();
});

it.each(['ошибка', 'отмена'] as const)('не публикует незавершённую порцию: %s, повтор не теряет кандидатов', async mode => {
	const pending = deferred<Response>(); let attempt = 0;
	const env = await setup({ settings: { connectionSuggestionCount: '2' }, notes: {
		'Примеры/А.md': 'Активное вспоминание через день.', 'Примеры/Б.md': 'Повторение через неделю.', 'Примеры/В.md': 'Проверка усвоения материала.', 'Примеры/Г.md': 'Продолжение обучения.',
	}, completion: async body => {
		const id = JSON.parse(body.messages.at(-1).content).candidate.id;
		attempt++;
		if (attempt === 4) return mode === 'отмена' ? pending.promise : Response.json({ error: 'Недоступно' }, { status: 503 });
		return answer(id);
	} });
	await env.run(); cards(env.root)[0].find('ai-helper-connection-select').click();
	const more = env.root.find('ai-helper-connections-more'); more.click(); more.click();
	await vi.waitFor(() => expect(env.requests).toHaveLength(4));
	expect(cards(env.root)).toHaveLength(2);
	if (mode === 'отмена') env.root.find('ai-helper-connections-cancel').click();
	else await vi.waitFor(() => expect(env.root.getText()).toContain('Модель диалога недоступна'));
	expect(cards(env.root)[0].getText()).toContain('Снять выбор');
	env.root.find('ai-helper-connections-more').click();
	await vi.waitFor(() => expect(cards(env.root)).toHaveLength(4));
	pending.resolve(answer('c4', 'Позднее объяснение отменённой порции не должно появиться.'));
	await new Promise(resolve => setTimeout(resolve, 25));
	expect(env.root.getText()).not.toContain('Позднее объяснение');
	expect(cards(env.root)[0].getText()).toContain('Снять выбор');
	const paths = env.requests.map(body => JSON.parse(body.messages.at(-1).content).candidate.path);
	expect(paths.slice(2, 4)).toEqual(paths.slice(4, 6));
	expect(new Set(cards(env.root).map(card => card.find('ai-helper-connection-link').getText())).size).toBe(4);
	env.root.find('ai-helper-connections-more').click();
	await vi.waitFor(() => expect(env.root.getText()).toContain('Больше предложений в этом поиске нет'));
	expect(cards(env.root)).toHaveLength(5); await env.chat.onClose();
});

it('поздний ответ отменённой порции не завершает новую попытку', async () => {
	const old = deferred<Response>(), current = deferred<Response>(); let count = 0;
	const env = await setup({ settings: { connectionSuggestionCount: '1' }, notes: { 'Примеры/А.md': 'Проверка знаний через неделю.' }, completion: async body => {
		count++; if (count === 2) return old.promise; if (count === 3) return current.promise;
		return answer(JSON.parse(body.messages.at(-1).content).candidate.id);
	} });
	await env.run(); env.root.find('ai-helper-connections-more').click();
	await vi.waitFor(() => expect(env.requests).toHaveLength(2)); env.root.find('ai-helper-connections-cancel').click();
	env.root.find('ai-helper-connections-more').click(); await vi.waitFor(() => expect(env.requests).toHaveLength(3));
	old.resolve(answer('c2', 'Старый результат отменённой попытки не должен появиться.'));
	await new Promise(resolve => setTimeout(resolve, 25));
	expect(cards(env.root)).toHaveLength(1); expect(env.root.getText()).toContain('Поиск полезных связей');
	expect(env.root.find('ai-helper-connections-more').disabled).toBe(true);
	current.resolve(answer('c2')); await vi.waitFor(() => expect(cards(env.root)).toHaveLength(2));
	expect(env.root.getText()).not.toContain('Старый результат'); await env.chat.onClose();
});

it('фиксирует размер при запуске и допускает обычный диалог между порциями', async () => {
	const first = deferred<Response>(); let count = 0;
	const env = await setup({ settings: { connectionSuggestionCount: '1' }, notes: { 'Примеры/А.md': 'Проверяйте усвоенное.' }, completion: async body => {
		if (++count === 1) return first.promise;
		if (body.messages[0].content === 'СЕКРЕТ ОБЫЧНОГО ДИАЛОГА') return Response.json({ choices: [{ message: { content: 'Можно обсудить повторение.' }, finish_reason: 'stop' }] });
		return answer(JSON.parse(body.messages.at(-1).content).candidate.id);
	} });
	env.commands.get('find-note-connections')!(); await vi.waitFor(() => expect(env.requests).toHaveLength(1));
	env.plugin.settings.connectionSuggestionCount = '20'; first.resolve(answer('c1'));
	await vi.waitFor(() => expect(cards(env.root)).toHaveLength(1));
	env.root.find('ai-helper-input').value = 'Обсудим повторение'; env.root.find('ai-helper-send').click();
	await vi.waitFor(() => expect(env.chat.getMessages().at(-1)?.content).toBe('Можно обсудить повторение.'));
	env.root.find('ai-helper-connections-more').click(); await vi.waitFor(() => expect(cards(env.root)).toHaveLength(2));
	expect(env.root.getText()).toContain('Больше предложений в этом поиске нет'); await env.chat.onClose();
});
