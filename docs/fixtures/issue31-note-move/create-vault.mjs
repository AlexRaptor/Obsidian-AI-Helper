import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node docs/fixtures/issue31-note-move/create-vault.mjs <new-directory>");
const vault = resolve(destination);
try { await access(vault); throw new Error("Destination already exists; choose a new directory."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const files = {
	"Inbox/Метод.md": "---\nстатус: справка\n---\n# Еженедельный обзор\nСправка о методе GTD: каждую пятницу проверять календарь и список следующих действий. [[Связи/Обзор]]\n",
	"Inbox/Конфликт.md": "# Конфликт\nСправочное описание еженедельного обзора GTD и организации списков действий.\n",
	"Справка/Конфликт.md": "# Существующая заметка\nЭТОТ ТЕКСТ НЕЛЬЗЯ ПЕРЕЗАПИСЫВАТЬ.\n",
	"Связи/Обзор.md": "# Ссылки\n[[Inbox/Метод]]\n[Обзор метода](../Inbox/Метод.md)\n![[Inbox/Метод]]\n",
	"Справка/_folder.md": "## Назначение\nСправочные материалы о методах продуктивности, GTD и еженедельном обзоре.\n## Не относятся\nЛичные дневники и планы активных проектов.\n",
	"Дневник/_folder.md": "## Назначение\nЛичные дневниковые записи о чувствах и впечатлениях. Справочные материалы здесь не хранятся.\n",
	"Дневник/Сегодня.md": "# Сегодня\nЛичная дневниковая запись о впечатлениях за день.\n",
	"Inbox/Нет папки.md": "# Наблюдение\nПолевой отчёт о миграции птиц, без отношения к продуктивности и личному дневнику.\n",
	".obsidian/app.json": JSON.stringify({ alwaysUpdateLinks: true, newLinkFormat: "absolute" }, null, 2),
	".obsidian/community-plugins.json": JSON.stringify([manifest.id]),
	[`.obsidian/plugins/${manifest.id}/data.json`]: JSON.stringify({ language: "ru", folderDescriptionName: "_folder.md", contextWindow: "32768", excludedFolders: ["Inbox"], autoUpdateNotes: false, serverUrl: "", model: "", embeddingServerUrl: "", embeddingModel: "" }, null, 2),
};
const assets = await Promise.all(["main.js", "manifest.json", "styles.css"].map(path => readFile(path)));
for (const [path, text] of Object.entries(files)) {
	await mkdir(join(vault, path, ".."), { recursive: true });
	await writeFile(join(vault, path), text);
}
for (const [index, path] of ["main.js", "manifest.json", "styles.css"].entries()) await writeFile(join(vault, ".obsidian/plugins", manifest.id, path), assets[index]);
console.log(vault);
