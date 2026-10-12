import { mkdir, writeFile, copyFile, readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node test/fixtures/manual-folder-descriptions/create-vault.mjs /absolute/new/vault");
const vault = resolve(destination);
try { await access(vault); throw new Error("Destination already exists; choose a new directory to preserve previous results."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const files = {
	"New/Note.md": "# Ordinary note\nThis file must remain unchanged.\n",
	"Existing/_folder.md": "## Назначение\nСохранить этот текст без изменений.\n",
	"Private/_folder.md": "## Purpose\nExcluded folder description.\n",
	"Private/Note.md": "# Excluded note\nDo not index this note.\n",
	"Empty/_folder.md": "## Purpose\n<!-- What this folder is for -->\n\n## Belongs here\n<!-- Which notes to keep here -->\n\n## Does not belong here\n<!-- What to keep in other folders -->\n",
	".obsidian/app.json": JSON.stringify({ livePreview: false }),
	".obsidian/community-plugins.json": JSON.stringify(["obsidian-ai-helper"]),
	".obsidian/plugins/obsidian-ai-helper/data.json": JSON.stringify({ language: "ru", excludedFolders: ["Private"], autoUpdateNotes: false }),
};
for (const [path, text] of Object.entries(files)) {
	await mkdir(join(vault, path, ".."), { recursive: true });
	await writeFile(join(vault, path), text);
}
await mkdir(join(vault, "English"), { recursive: true });
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.id !== "obsidian-ai-helper") throw new Error("Update fixture plugin folder to match manifest.id");
for (const path of ["main.js", "manifest.json", "styles.css"]) await copyFile(path, join(vault, ".obsidian/plugins", manifest.id, path));
console.log(vault);
