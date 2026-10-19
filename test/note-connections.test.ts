import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, type WorkspaceLeaf, FileSystemAdapter, MarkdownView, TFile } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { ChatView } from "../src/chat-view";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Notice, deferred, type TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
const plugins: AiHelperPlugin[] = [];
afterEach(() => { plugins.forEach(plugin => plugin.onunload()); plugins.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); Notice.messages.length = 0; });
async function setup(options: { source?: string; notes?: Record<string, string>; settings?: Record<string, unknown>; index?: boolean; completion?: (body: any) => Promise<Response> } = {}) {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const files = new Map(Object.entries({ "Заметки/Мысль.md": "Сохранённая версия.", "Примеры/Практика.md": "# Практика\nИнтервальное повторение: проверяйте знания через день и через неделю.", ...options.notes }));
	const entries = new Map([...files.keys()].map(path => [path, Object.assign(new TFile(), { path, basename: path.split('/').at(-1)!.slice(0, -3), extension: "md" })]));
	const file = entries.get("Заметки/Мысль.md")!;
	let text = options.source ?? "# Обучение\nАктивное вспоминание помогает удерживать знания.";
	const editor = Object.assign(Object.create(MarkdownView.prototype), { file, getMode: () => "source", editor: { getValue: () => text } });
	const commands = new Map<string, () => void>(); const requests: any[] = []; const embeddings: string[][] = [];
	const network = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith('/embeddings')) { const body = JSON.parse(String(init?.body)); embeddings.push(body.input); return Response.json({ data: body.input.map((_text: string, index: number) => ({ index, embedding: _text.includes('Активное') ? [1, 0] : [0.1, 1] })) }); }
		if (!url.endsWith('/chat/completions')) return Response.json({ data: [] });
		const body = JSON.parse(String(init?.body)); requests.push(body);
		return options.completion ? options.completion(body) : answer(JSON.parse(body.messages.at(-1).content).candidate.id);
	});
	vi.stubGlobal('fetch', network);
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => '/связи';
	let chat: ChatView;
	const app = { vault: { adapter, on: () => ({}), offref() {}, getMarkdownFiles: () => [...entries.values()], getFiles: () => [...entries.values()], getFileByPath: (path: string) => entries.get(path) ?? null, read: vi.fn(async (file: TFile) => files.get(file.path)!) }, metadataCache: { getFirstLinkpathDest: (name: string, from: string) => {
		const parts = from.split('/').slice(0, -1);
		for (const part of name.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
		const local = parts.join('/');
		return entries.get(local) ?? entries.get(local + '.md') ?? entries.get(name) ?? entries.get(name + '.md') ?? [...entries.values()].find(file => file.basename === name);
	} }, workspace: { getActiveViewOfType: (type: unknown) => type === MarkdownView ? editor : null, getLeavesOfType: (type: string) => type === 'ai-helper-chat' && chat ? [{ view: chat }] : [], on: () => ({}), onLayoutReady() {}, detachLeavesOfType() {}, ensureSideLeaf: async () => ({ view: chat }), revealLeaf: async () => {}, openLinkText: vi.fn(async () => {}) } } as unknown as App;
	const plugin = new AiHelperPlugin(app, { id: 'obsidian-ai-helper' } as PluginManifest); plugins.push(plugin);
	vi.spyOn(plugin, 'loadData').mockResolvedValue({ ...DEFAULT_SETTINGS, language: 'ru', serverUrl: 'http://server/v1', model: 'диалог', embeddingServerUrl: 'http://server/v1', embeddingModel: 'смысл', contextWindow: '32000', autoUpdateNotes: false, systemPrompt: 'СЕКРЕТ ОБЫЧНОГО ДИАЛОГА', ...options.settings });
	vi.spyOn(plugin, 'addCommand').mockImplementation((command: any) => { commands.set(command.id, command.callback); return command; });
	await plugin.onload();
	chat = new ChatView({} as WorkspaceLeaf, plugin); Object.assign(chat, { app }); await chat.onOpen();
	if (options.index !== false) for (const path of files.keys()) { try { await plugin.noteSearch.index(path); } catch {} }
	requests.length = 0; embeddings.length = 0; vi.mocked(app.vault.read).mockClear();
	const root = chat.contentEl as unknown as TestElement;
	return { plugin, chat, root, requests, embeddings, files, app, editor, commands, setText: (value: string) => { text = value; }, run: async () => { expect(commands.has('find-note-connections')).toBe(true); commands.get('find-note-connections')!(); await vi.waitFor(() => expect(root.getText()).toContain('Сходство фрагмента')); } };
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
		expect(env.root.children.flatMap(child => child.children).some(child => child.classes.has('ai-helper-connection'))).toBe(false);
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
