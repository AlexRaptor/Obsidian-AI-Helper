import { afterEach, expect, it, vi } from "vitest";
import type { App, Menu as ObsidianMenu, PluginManifest, WorkspaceLeaf } from "obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { ChatView } from "../src/chat-view";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";
import { setLanguage, t } from "../src/i18n";
import { Notice, TestElement } from "./helpers/obsidian";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { setLanguage("en"); vi.restoreAllMocks(); });

function setup(embeddingServerUrl = "", embeddingModel = "") {
	setLanguage("ru");
	Notice.messages.length = 0;
	const read = vi.fn(async () => "Поезд отправляется вечером.");
	const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const app = { vault: { getMarkdownFiles: () => [], getFileByPath: () => null }, workspace: {} } as unknown as App;
	const plugin = new AiHelperPlugin(app, { id: "obsidian-ai-helper" } as PluginManifest);
	plugin.settings = { ...DEFAULT_SETTINGS, embeddingServerUrl, embeddingModel };
	plugin.serverClient = createServerClient(fetcher);
	plugin.noteSearch = createNoteSearch({ client: plugin.serverClient, factory: new IDBFactory(), vaultPath: "/доступность", list: () => ["Поезд.md"], read, open: async () => {} });
	plugin.noteSearch.configure(plugin.settings);
	return { plugin, read, fetcher };
}

it.each([
	["", ""], ["https://сервер.example/v1", "  "], ["", "модель"],
	["ftp://server/v1", "модель"], ["http://user:password@server/v1", "модель"],
	["https://server/v1?secret=ключ", "модель"], ["https://server/v1#часть", "модель"],
])("автоматически выбирает папки и блокирует индексацию при конфигурации %s / %s", async (url, model) => {
	const s = setup(url, model);
	const view = new ChatView({} as WorkspaceLeaf, s.plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	try {
		expect(root.find("ai-helper-search-type").style.display).toBe("none");
		root.find("ai-helper-search-toggle").click();
		expect(root.find("ai-helper-search-toggle").attributes["aria-pressed"]).toBe("true");
		expect(root.find("ai-helper-search-type").value).toBe("folders");
		expect(Notice.messages).toEqual([]);
		expect(root.find("ai-helper-search-type").style.display).toBe("");
		await s.plugin.indexNote("Поезд.md"); await s.plugin.manageNoteIndex("index");
		await s.plugin.resumeNoteIndex(); await s.plugin.changeIndexStorage("file");
		expect(s.plugin.settings.indexStorageMode).toBe("local");
		expect(s.fetcher).not.toHaveBeenCalled(); expect(s.read).not.toHaveBeenCalled();
		expect(Notice.messages).toEqual(Array(4).fill(t("search-setup-required")));
		await s.plugin.manageNoteIndex("clear");
		expect(Notice.messages.at(-1)).toBe(t("search-cleared"));
	} finally { await view.onClose(); s.plugin.noteSearch.dispose(); }
});

it("позволяет выбрать папки без embeddings и отклоняет переход в заметки или смешанный режим", async () => {
	const s = setup();
	const view = new ChatView({} as WorkspaceLeaf, s.plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const select = root.find("ai-helper-search-type");
	try {
		root.find("ai-helper-search-toggle").click();
		expect(select.value).toBe("folders");
		expect(root.find("ai-helper-search-toggle").attributes["aria-pressed"]).toBe("true");
		for (const mode of ["notes", "mixed"]) {
			select.value = mode; select.dispatchEvent({ type: "change" });
			expect(select.value).toBe("folders");
			expect(root.find("ai-helper-search-toggle").attributes["aria-pressed"]).toBe("true");
		}
		expect(Notice.messages).toEqual(Array(2).fill(t("search-setup-required")));
		expect(s.fetcher).not.toHaveBeenCalled();
	} finally { await view.onClose(); s.plugin.noteSearch.dispose(); }
});

it("разрешает непроверенное подключение, сохраняет черновик и выключает поиск после удаления модели", async () => {
	const s = setup(" https://server/v1/ ", " модель ");
	const view = new ChatView({} as WorkspaceLeaf, s.plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	try {
		expect(s.plugin.noteSearchConnection.status.state).toBe("idle");
		root.find("ai-helper-search-toggle").click();
		expect(root.find("ai-helper-search-toggle").attributes["aria-pressed"]).toBe("true");
		root.find("ai-helper-input").value = "Когда отправляется поезд?";
		s.plugin.settings.embeddingModel = "";
		root.find("ai-helper-send").click();
		expect(root.find("ai-helper-input").value).toBe("Когда отправляется поезд?");
		expect(root.find("ai-helper-messages").getText()).toBe("");
		expect(s.fetcher).not.toHaveBeenCalled();
		view.refreshSearchConfiguration();
		expect(root.find("ai-helper-search-toggle").attributes["aria-pressed"]).toBe("false");
		expect(root.find("ai-helper-input").value).toBe("Когда отправляется поезд?");
	} finally { await view.onClose(); s.plugin.noteSearch.dispose(); }
});

it.each(["folders", "mixed"])("при каждом включении выбирает заметки вместо прошлого режима %s, если embeddings настроены", async previous => {
	const s = setup("https://server/v1", "модель");
	const view = new ChatView({} as WorkspaceLeaf, s.plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	const select = root.find("ai-helper-search-type");
	try {
		root.find("ai-helper-search-toggle").click();
		expect(select.value).toBe("notes");
		select.value = previous; select.dispatchEvent({ type: "change" });
		root.find("ai-helper-search-toggle").click();
		expect(select.style.display).toBe("none");
		root.find("ai-helper-search-toggle").click();
		expect(select.style.display).toBe("");
		expect(select.value).toBe("notes");
		expect(Notice.messages).toEqual([]);
	} finally { await view.onClose(); s.plugin.noteSearch.dispose(); }
});

it("заново учитывает настройки при включении через меню панели", async () => {
	const s = setup();
	const view = new ChatView({} as WorkspaceLeaf, s.plugin); await view.onOpen();
	const root = view.contentEl as unknown as TestElement;
	try {
		const { Menu } = await import("./helpers/obsidian");
		const menu = new Menu(); view.onPaneMenu(menu as unknown as ObsidianMenu);
		menu.items.find(item => item.title === t("search-toggle"))!.callback();
		expect(root.find("ai-helper-search-type").value).toBe("folders");
		Object.assign(s.plugin.settings, { embeddingServerUrl: "https://server/v1", embeddingModel: "модель" });
		view.refreshSearchConfiguration();
		expect(root.find("ai-helper-search-type").value).toBe("folders");
		root.find("ai-helper-search-toggle").click();
		root.find("ai-helper-search-toggle").click();
		expect(root.find("ai-helper-search-type").value).toBe("notes");
		s.plugin.settings.embeddingModel = "";
		view.refreshSearchConfiguration();
		root.find("ai-helper-search-toggle").click();
		expect(root.find("ai-helper-search-type").value).toBe("folders");
	} finally { await view.onClose(); s.plugin.noteSearch.dispose(); }
});

it("защищает модуль индекса до чтения заметок и очистки данных", async () => {
	const s = setup();
	try {
		for (const action of [() => s.plugin.noteSearch.index("Поезд.md"), () => s.plugin.noteSearch.indexVault(),
			() => s.plugin.noteSearch.rebuild(), () => s.plugin.noteSearch.searchSources("Когда?"),
			() => s.plugin.noteSearch.resume(true)]) {
			await expect(action()).rejects.toMatchObject({ code: "search-setup-required" });
		}
		expect(s.read).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
		await expect(s.plugin.noteSearch.resume()).resolves.toBeUndefined();
		await expect(s.plugin.noteSearch.clear()).resolves.toBeUndefined();
	} finally { s.plugin.noteSearch.dispose(); }
});
