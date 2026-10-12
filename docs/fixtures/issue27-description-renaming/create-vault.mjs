import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";

const destination = process.argv[2];
const scenario = process.argv[3] ?? "clean";
if (!destination || !["clean", "conflict"].includes(scenario)) throw new Error("Usage: node docs/fixtures/issue27-description-renaming/create-vault.mjs <new-directory> [clean|conflict]");
const vault = resolve(destination);
try { await access(vault); throw new Error("Destination already exists; choose a new directory."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const files = {
	"_folder.md": "## Назначение\nОбщие правила хранилища.\n",
	"Private/_folder.md": "## Purpose\nPrivate folder rules.\n",
	"Empty/_folder.md": "## Purpose\n<!-- What this folder is for -->\n\n## Belongs here\n<!-- Which notes to keep here -->\n\n## Does not belong here\n<!-- What to keep in other folders -->\n",
	"New/Note.md": "# Обычная заметка\nСодержимое должно сохраниться.\n",
	"Private/Note.md": "# Исключённая заметка\nНе индексировать.\n",
	"Links.md": "# Ссылки на описания\n[[_folder|Общие правила]]\n[[Private/_folder|Личные правила]]\n[[Empty/_folder#Purpose]]\n[Личные правила](Private/_folder.md)\n",
	".obsidian/app.json": JSON.stringify({ livePreview: false, alwaysUpdateLinks: true, newLinkFormat: "absolute" }, null, 2),
	".obsidian/community-plugins.json": JSON.stringify([manifest.id]),
	[`.obsidian/plugins/${manifest.id}/data.json`]: JSON.stringify({ language: "ru", folderDescriptionName: "_folder.md", excludedFolders: ["Private"], autoUpdateNotes: false, serverUrl: "", model: "", embeddingServerUrl: "", embeddingModel: "" }, null, 2),
};
if (scenario === "conflict") {
	files["Private/about.md"] = "# Конфликт\nНе перезаписывать и не объединять.\n";
	files["Empty/about.md"] = "# Второй конфликт\nСохранить этот текст.\n";
}
// Read the built bundle before creating the destination to avoid leaving a half-built vault.
const assets = await Promise.all(["main.js", "manifest.json", "styles.css"].map(path => readFile(path)));
for (const [path, text] of Object.entries(files)) {
	await mkdir(join(vault, path, ".."), { recursive: true });
	await writeFile(join(vault, path), text);
}
for (const [index, path] of ["main.js", "manifest.json", "styles.css"].entries()) await writeFile(join(vault, ".obsidian/plugins", manifest.id, path), assets[index]);
console.log(`${vault} (${scenario})`);
