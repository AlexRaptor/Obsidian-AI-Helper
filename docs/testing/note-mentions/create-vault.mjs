import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node docs/testing/note-mentions/create-vault.mjs <new-directory>");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const assets = await Promise.all(["main.js", "manifest.json", "styles.css"].map(path => readFile(join(root, path))));
const vault = resolve(destination);
// Создаём только новое хранилище; существующее не перезаписываем.
await mkdir(vault);
const files = {
	"1.Projects/Monexa.md": "---\nстатус: активный\n---\n# Проект Monexa\nКонтрольная метка: MONEXA-11.\nПлан: обсудить бюджет и сроки проекта.\n[[Знания/План]]\n![[Личное/План]]\n",
	"Docs/ProjectDescriptionMonexa/README.md": "# Описание проекта Monexa\nКонтрольная метка: ОПИСАНИЕ-23.\nЗдесь описаны цели проекта и ограничения бюджета.\n",
	"Monexa/Project.md": "# Архив проекта\nКонтрольная метка: АРХИВ-31.\nСправка о прошлой версии проекта.\n",
	"Projects/Another.md": "# Другой проект\nКонтрольная метка: ДРУГОЙ-47.\nМатериалы о другом проекте, без искомого имени в пути.\n",
	"Личное/План.md": "# Личный план\nКонтрольная метка: ЛИЧНОЕ-17.\nВ субботу посетить библиотеку.\n",
	"Знания/План.md": "# План обучения\nКонтрольная метка: ЗНАНИЯ-29.\nИзучить основы статистики.\n",
	"Проверка/Для удаления.md": "# Заметка для проверки удаления\nКонтрольная метка: УДАЛЕНИЕ-43.\nЭтот файл предназначен только для удаления в тестовом хранилище.\n",
	"Проверка/Новый путь/Справка.md": "# Справка\nПапка используется для проверки перемещения заметок.\n",
	".obsidian/app.json": JSON.stringify({ alwaysUpdateLinks: true, newLinkFormat: "absolute" }, null, 2),
	".obsidian/community-plugins.json": JSON.stringify([manifest.id]),
	[`.obsidian/plugins/${manifest.id}/data.json`]: JSON.stringify({ language: "ru", serverUrl: "", model: "", contextWindow: "", excludedFolders: ["Личное"], autoUpdateNotes: false, embeddingServerUrl: "", embeddingModel: "" }, null, 2),
};
for (const [path, text] of Object.entries(files)) {
	await mkdir(join(vault, path, ".."), { recursive: true });
	await writeFile(join(vault, path), text);
}
for (const [index, path] of ["main.js", "manifest.json", "styles.css"].entries()) {
	await writeFile(join(vault, ".obsidian/plugins", manifest.id, path), assets[index]);
}
console.log(vault);
