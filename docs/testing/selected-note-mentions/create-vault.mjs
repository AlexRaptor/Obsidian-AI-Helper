import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node docs/testing/selected-note-mentions/create-vault.mjs <new-directory>");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const assets = await Promise.all(["main.js", "manifest.json", "styles.css"].map(path => readFile(join(root, path))));
const vault = resolve(destination);
// Создаём только новое хранилище; существующее не перезаписываем.
await mkdir(vault);
const files = {
	"Проекты/План.md": [
		"# План", "", "Внешний текст: НЕ ПЕРЕДАВАТЬ.", "", "## Подготовка", "Открыть редактор.",
		"Проверить режим.", "", "## Обсуждение", "Предисловие вне выделения.", "Начало следующего раздела:",
		"Предложение: **сохранить точный текст**.", "Срок: следующая неделя.", "[[Справка]]", "![[Изображение.png]]", "Последняя строка фрагмента.",
		"Хвост: НЕ ПЕРЕДАВАТЬ.", "",
	].join("\n"),
	"Справка.md": "# Справка\nЭто содержимое не должно раскрываться при выборе ссылки.\n",
	"Другая.md": "# Другая заметка\nЗдесь не выделять текст.\n",
	".obsidian/app.json": JSON.stringify({ livePreview: true, showLineNumber: true }, null, 2),
	".obsidian/community-plugins.json": JSON.stringify([manifest.id]),
	[`.obsidian/plugins/${manifest.id}/data.json`]: JSON.stringify({ language: "ru", serverUrl: "", model: "", contextWindow: "", autoUpdateNotes: false, embeddingServerUrl: "", embeddingModel: "" }, null, 2),
};
for (const [path, text] of Object.entries(files)) {
	await mkdir(join(vault, path, ".."), { recursive: true });
	await writeFile(join(vault, path), text);
}
for (const [index, path] of ["main.js", "manifest.json", "styles.css"].entries()) {
	await writeFile(join(vault, ".obsidian/plugins", manifest.id, path), assets[index]);
}
console.log(vault);
