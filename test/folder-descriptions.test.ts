import { afterEach, expect, it, vi } from "vitest";
import { type App, type PluginManifest, TFile, TFolder } from "obsidian";
import { Menu } from "./helpers/obsidian";
import { IDBFactory } from "fake-indexeddb";
import { AiHelperPlugin } from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { setLanguage, t } from "../src/i18n";
vi.mock("obsidian", async () => import("./helpers/obsidian"));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setLanguage("en"); });

async function setup(locale: "en" | "ru" = "en") {
	vi.stubGlobal("indexedDB", new IDBFactory());
	const files = new Map<string, { file: TFile; text: string }>();
	const handlers = new Map<string, (...args: any[]) => void>();
	const on = (event: string, callback: (...args: any[]) => void) => { handlers.set(event, callback); return {}; };
	const openFile = vi.fn(async () => {});
	const app = { vault: {
		on, adapter: {}, getMarkdownFiles: () => [...files.values()].map(entry => entry.file),
		getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
		getFileByPath: (path: string) => files.get(path)?.file ?? null,
		create: async (path: string, text: string) => {
			if (files.has(path)) throw new Error("File exists");
			const file = Object.assign(new TFile(), { path, name: path.split("/").at(-1), extension: "md", parent: Object.assign(new TFolder(), { path: path.split("/").slice(0, -1).join("/") || "/" }) });
			files.set(path, { file, text }); handlers.get("create")?.(file); return file;
		},
	}, workspace: { on, onLayoutReady: () => {}, getLeaf: () => ({ openFile }), detachLeavesOfType: () => {} } } as unknown as App;
	const plugin = new AiHelperPlugin(app, {} as PluginManifest);
	vi.spyOn(plugin, "loadData").mockResolvedValue({ ...DEFAULT_SETTINGS, language: locale, excludedFolders: ["Private"] });
	await plugin.onload();
	const menu = (file: TFile | TFolder) => { const menu = new Menu(); handlers.get("file-menu")!(menu, file); return menu; };
	return { plugin, files, app, openFile, menu };
}

it.each(["en", "ru"] as const)("creates and opens a localized description in an excluded folder without indexing notes (%s)", async locale => {
	const env = await setup(locale);
	try {
		
		const folder = Object.assign(new TFolder(), { path: "Private" });
		const action = env.menu(folder).items.find(item => item.title === t("folder-description-create"));
		expect(action).toBeDefined(); action!.callback();
		await vi.waitFor(() => expect(env.openFile).toHaveBeenCalled());
		const entry = env.files.get("Private/_folder.md")!;
		expect(entry.text).toBe(locale === "ru" ? "## Назначение\n<!-- Для чего нужна папка -->\n\n## Сюда относятся\n<!-- Какие заметки хранить здесь -->\n\n## Не относятся\n<!-- Что хранить в других папках -->\n" : "## Purpose\n<!-- What this folder is for -->\n\n## Belongs here\n<!-- Which notes to keep here -->\n\n## Does not belong here\n<!-- What to keep in other folders -->\n");
		expect(env.openFile).toHaveBeenCalledWith(entry.file);
		expect(env.plugin.noteSearch.progress).toMatchObject({ completed: 0, total: 0 });
	} finally { env.plugin.onunload(); }
});

it("opens existing content unchanged after switching language, supports root, and offers no action on files", async () => {
	const env = await setup();
	try {
		const existing = await env.app.vault.create("_folder.md", "## Назначение\nМои правила\n");
		setLanguage("ru");
		expect(env.menu(existing).items.some(item => item.title === t("folder-description-create"))).toBe(false);
		env.menu(Object.assign(new TFolder(), { path: "/" })).items.find(item => item.title === t("folder-description-create"))!.callback();
		await vi.waitFor(() => expect(env.openFile).toHaveBeenCalledWith(existing));
		expect(env.files.get("_folder.md")!.text).toBe("## Назначение\nМои правила\n");
		expect(env.files.size).toBe(1);
		expect(env.plugin.settings.folderDescriptionName).toBe("_folder.md");
	} finally { env.plugin.onunload(); }
});

it("uses a saved custom name and preserves the old description", async () => {
	const env = await setup();
	try {
		await env.app.vault.create("Private/_folder.md", "Old description\n");
		env.plugin.settings.folderDescriptionName = "Об этой папке.md";
		env.menu(Object.assign(new TFolder(), { path: "Private" })).items.find(item => item.title === t("folder-description-create"))!.callback();
		await vi.waitFor(() => expect(env.openFile).toHaveBeenCalled());
		expect(env.files.get("Private/_folder.md")!.text).toBe("Old description\n");
		expect(env.files.get("Private/Об этой папке.md")!.text).toContain("## Purpose");
		expect(env.openFile).toHaveBeenCalledWith(env.files.get("Private/Об этой папке.md")!.file);
	} finally { env.plugin.onunload(); }
});
