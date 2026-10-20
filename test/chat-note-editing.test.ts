import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { noteEditHistory } from "../src/note-edit-history";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView, type TFile, type WorkspaceLeaf } from "obsidian";
import { setLanguage, t } from "../src/i18n";
import { setup, json, call } from "./helpers/chat-note-actions";
import { deferred, flushPromises } from "./helpers/obsidian";

vi.mock("obsidian", async () => ({ ...await import("./helpers/obsidian"), parseYaml: (text: string) => {
	if (["null", "~"].includes(text.trim())) return null;
	if (text.trim() === "2026-10-19") return new Date("2026-10-19");
	if (text.includes("[ошибка")) throw new Error("Неверный YAML");
	if (text.startsWith("- ")) return [text];
	return Object.fromEntries(text.split("\n").filter(Boolean).map(line => line.split(":").map(part => part.trim())));
} }));
afterEach(() => { vi.restoreAllMocks(); });
type Setup = Awaited<ReturnType<typeof setup>>;
const original = "---\nстатус: черновик\n---\n# План\nЕдем на поезде.";
function editor(s: Setup, file: TFile, initial = s.texts.get(file.path)!) {
	// Host adapter: run the plugin's registered extension in a real CodeMirror history.
	// Obsidian's view integration still requires the prepared manual check.
	let state = EditorState.create({ doc: initial, extensions: [history(), noteEditHistory, EditorState.lineSeparator.of(initial.includes("\r\n") ? "\r\n" : "\n")] });
	const dispatch = (transaction: import("@codemirror/state").Transaction) => { state = transaction.state; s.texts.set(file.path, state.sliceDoc()); };
	const transaction = vi.fn((tx: any, origin: string) => dispatch(state.update({
		changes: tx.changes.map((change: any) => ({ from: state.doc.line(change.from.line + 1).from + change.from.ch,
			to: state.doc.line(change.to.line + 1).from + change.to.ch, insert: change.text })), userEvent: origin,
	})));
	const view = Object.assign(new MarkdownView({} as WorkspaceLeaf), { file, getMode: () => "source", getViewData: () => state.sliceDoc(),
		editor: { getValue: () => state.sliceDoc(), lastLine: () => state.doc.lines - 1, getLine: (line: number) => state.doc.line(line + 1).text, transaction,
			undo: () => undo({ state, dispatch }), redo: () => redo({ state, dispatch }) } });
	return { view, transaction, get text() { return state.sliceDoc(); }, change(value: string) { dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: value }, userEvent: "input.type" })); } };
}
function attach(s: Setup, prompt = "Сократи прикреплённую заметку @План") {
	s.input.value = prompt;
	s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
}
function target(s: Setup, index = 0) {
	const message = s.requests[index].messages.findLast((m: any) => m.role === "user").content;
	return JSON.parse(message.split("Note attachments (context data):\n")[1])[0];
}
function edit(target: { targetId: string; version: string }, content = "# План\nЕдем поездом.", kind = "body") {
	return call({ targetId: target.targetId, expectedVersion: target.version, kind, content }, "правка-1", "edit_note");
}
async function start(responses: Array<Response | Promise<Response>>, initial = original) {
	const s = await setup(responses);
	const file = s.add("План.md", initial), e = editor(s, file);
	s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	return { ...s, file, e };
}

it("правит полный несохранённый снимок одной транзакцией, сохраняя исходный YAML", async () => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	s.e.change(original.replace("на поезде", "быстрым поездом"));
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	expect(target(s).markdown).toContain("быстрым поездом");
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nЕдем поездом.");
	expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.create).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain("Изменена заметка: [[План.md]]");
	expect(JSON.parse(s.requests[1].messages.at(-1).content)).toMatchObject({ status: "completed", targetId: expect.any(String), version: expect.any(String) });
	await s.view.onClose();
});

it("продолжает править цель из истории от своей новой версии, не меняя прежний снимок", async () => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([json({ content: "Обсудим план." }), first.promise, json({ content: "Готово." }), second.promise]);
	attach(s, "Обсудим @План"); s.send.click(); await s.settle();
	const initialSnapshot = { ...s.view.getMessages()[0].snapshots![0] };
	s.input.value = "Сократи ту заметку из истории"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	first.resolve(json({ tool_calls: [edit(target(s, 0))] }, "tool_calls")); await s.settle();
	const result = JSON.parse(s.requests[2].messages.at(-1).content);
	s.input.value = "Добавь в неё строку: Купить билеты"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(4));
	second.resolve(json({ tool_calls: [edit(result, "# План\nЕдем поездом.\nКупить билеты.")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nЕдем поездом.\nКупить билеты.");
	expect(s.e.transaction).toHaveBeenCalledTimes(2);
	expect(s.view.getMessages()[0].snapshots![0]).toEqual(initialSnapshot);
	expect(initialSnapshot.markdown).toBe(original);
	await s.view.onClose();
});

it("расходящиеся редакторы останавливают запись и позволяют новое явное поручение взять актуальную версию", async () => {
	const conflictResponse = deferred<Response>(), readResponse = deferred<Response>(), editResponse = deferred<Response>();
	const s = await start([conflictResponse.promise, readResponse.promise, editResponse.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const other = editor(s, s.file, original + "\nДругой редактор");
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }, { view: other.view }]) as any;
	conflictResponse.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).not.toHaveBeenCalled(); expect(other.transaction).not.toHaveBeenCalled();
	expect(s.root.getText()).toContain(t("action-editors-conflict"));
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }]) as any;
	s.e.change(original + "\nАктуальная версия");
	s.input.value = "Возьми актуальную целую заметку и сократи её"; s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	expect(s.requests[1].tools.map((x: any) => x.function.name)).toContain("read_note");
	readResponse.resolve(json({ tool_calls: [call({ targetId: target(s).targetId }, "чтение", "read_note")] }, "tool_calls"));
	await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	const current = JSON.parse(s.requests[2].messages.at(-1).content);
	expect(current.markdown).toContain("Актуальная версия");
	editResponse.resolve(json({ tool_calls: [edit(current)] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.view.getMessages()[0].snapshots![0].markdown).toBe(original);
	await s.view.onClose();
});

it.each(["основной текст", "свойства"])("изменение: %s во время генерации вызывает конфликт без автоматического перечитывания", async part => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const current = part === "свойства" ? original.replace("черновик", "готово") : original + "\nРучная правка";
	s.e.change(current);
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(current); expect(s.e.transaction).not.toHaveBeenCalled();
	expect(s.requests).toHaveLength(1); expect(s.root.getText()).toContain(t("action-conflict"));
	expect(s.view.getMessages()[1].toolMessages?.at(-1)?.content).toContain('"status":"conflict"');
	await s.view.onClose();
});

it.each(["переименование", "перемещение"])("%s без изменения текста сохраняет идентичность и обновляет ссылку", async variant => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const newPath = variant === "перемещение" ? "Проекты/План.md" : "Поездка.md";
	s.entries.delete(s.file.path); s.file.path = newPath; s.file.basename = newPath.split("/").pop()!.slice(0, -3); s.entries.set(newPath, s.file);
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(1); expect(s.root.getText()).toContain(`[[${newPath}]]`);
	expect(JSON.parse(s.requests[1].messages.at(-1).content).path).toBe(newPath);
	await s.view.onClose();
});

it.each(["удаление", "подмена по старому пути"])("%s не переносит цель на другой файл", async variant => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	s.entries.delete(s.file.path); if (variant === "подмена по старому пути") s.add("План.md", original);
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).not.toHaveBeenCalled(); expect(s.root.getText()).toContain(t("action-target-unavailable"));
	await s.view.onClose();
});

it.each(["чужой идентификатор", "произвольный путь", "старая версия", "фрагмент", "чтение до конфликта"])("отклоняет: %s", async variant => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	s.add("Другая.md", "Не изменять");
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const args = { targetId: target(s).targetId, expectedVersion: target(s).version, kind: "body", content: "Новый текст" };
	const invalid = variant === "чужой идентификатор" ? { ...args, targetId: "Другая.md" }
		: variant === "произвольный путь" ? { ...args, path: "Другая.md" }
		: variant === "старая версия" ? { ...args, expectedVersion: "старая-версия" }
		: variant === "фрагмент" ? { ...args, kind: "fragment" } : { targetId: args.targetId };
	response.resolve(json({ tool_calls: [call(invalid, "проверка", variant === "чтение до конфликта" ? "read_note" : "edit_note")] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).not.toHaveBeenCalled(); expect(s.texts.get("Другая.md")).toBe("Не изменять");
	expect(s.requests).toHaveLength(1);
	await s.view.onClose();
});

it.each([
	["валидный YAML", "---\nстатус: готово\n---\n# План\nЕдем поездом.", true],
	["неверный YAML", "---\nстатус: [ошибка\n---\n# План", false],
	["массив свойств", "---\n- поездка\n---\n# План", false],
	["null вместо объекта", "---\nnull\n---\n# План", false],
	["дата вместо объекта", "---\n2026-10-19\n---\n# План", false],
	["пустой блок свойств", "---\n# комментарий\n---\n# План", true],
	["незакрытый YAML", "---\nстатус: готово\n# План", false],
] as const)("явная правка свойств: %s", async (_label, content, valid) => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s, "Измени статус в свойствах на готово в @План"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s), content, "properties")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(valid ? content : original);
	expect(s.e.transaction).toHaveBeenCalledTimes(valid ? 1 : 0);
	if (!valid) expect(s.root.getText()).toContain(t("action-properties-invalid"));
	await s.view.onClose();
});

it("основной текст не может подменить YAML; исходный блок сохраняется побайтово", async () => {
	const response = deferred<Response>();
	const crlf = "\uFEFF---\r\nстатус: 'черновик' # комментарий\r\n...\r\nИсходный текст"; const s = await start([response.promise], crlf);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s), "Новый текст")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("\uFEFF---\r\nстатус: 'черновик' # комментарий\r\n...\r\nНовый текст");
	await s.view.onClose();
});

it.each(["stop", "clear", "close", "unload"])("%s запрещает позднюю правку по ответу модели", async mode => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const write = edit(target(s));
	if (mode === "stop") s.send.click();
	if (mode === "clear") s.root.find("ai-helper-clear-btn").click();
	if (mode === "close") await s.view.onClose();
	if (mode === "unload") Object.assign(s.plugin, { isUnloading: true });
	response.resolve(json({ tool_calls: [write] }, "tool_calls")); await flushPromises();
	expect(s.e.text).toBe(original); expect(s.e.transaction).not.toHaveBeenCalled();
	if (mode !== "close") await s.view.onClose();
});

it.each(["обсуждение", "неясная цель"])("%s при прикреплении не разрешает запись", async variant => {
	const s = await start([json({ content: variant === "обсуждение" ? "Можно сократить." : "Какую заметку изменить: План или Материал?" })]);
	s.add("Материал.md", "Вспомогательный материал");
	attach(s, variant === "обсуждение" ? "Что улучшить в @План" : "Приведи заметки в порядок @План");
	if (variant === "неясная цель") { s.input.createSpan({ text: " и @Материал" }); s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab"); }
	s.send.click(); await s.settle();
	expect(s.e.transaction).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
	await s.view.onClose();
});

it.each(["успех", "текст", "YAML", "удаление", "подмена", "другой редактор", "расходящиеся редакторы", "stop", "clear", "unload"])("повторная проверка закрытой цели после открытия: %s", async variant => {
	const response = deferred<Response>(), opening = deferred<void>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	let leaves: Array<{ view: MarkdownView }> = [];
	s.view.app.workspace.getLeavesOfType = (() => leaves) as any;
	const leaf = { view: s.e.view, openFile: vi.fn(async (file: TFile) => { expect(file).toBe(s.file); await opening.promise; leaves = [{ view: s.e.view }];
		if (variant === "расходящиеся редакторы") leaves.push({ view: editor(s, s.file, original + "\nДругая версия").view }); }) };
	s.view.app.workspace.getLeaf = vi.fn(() => leaf) as any;
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls"));
	await vi.waitFor(() => expect(leaf.openFile).toHaveBeenCalledTimes(1));
	expect(s.e.transaction).not.toHaveBeenCalled();
	if (variant === "текст") s.e.change(original + "\nРучная правка при открытии");
	if (variant === "YAML") s.e.change(original.replace("черновик", "готово"));
	if (variant === "удаление" || variant === "подмена") { s.entries.delete("План.md"); if (variant === "подмена") s.add("План.md", original); }
	if (variant === "другой редактор") s.e.view.file = s.add("Другая.md", original);
	if (variant === "stop") s.send.click();
	if (variant === "clear") s.root.find("ai-helper-clear-btn").click();
	if (variant === "unload") Object.assign(s.plugin, { isUnloading: true });
	opening.resolve(); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(variant === "успех" ? 1 : 0);
	expect(s.create).not.toHaveBeenCalled();
	await s.view.onClose();
});

it("следующее поручение правит созданную в этом диалоге заметку без повторного прикрепления", async () => {
	const response = deferred<Response>();
	const s = await setup([json({ tool_calls: [call({ title: "План", content: original })] }, "tool_calls"), json({ content: "Создано." }), response.promise]);
	await s.ask("Создай заметку План");
	const created = JSON.parse(s.requests[1].messages.at(-1).content), file = s.entries.get(created.path) as TFile;
	const e = editor(s, file); s.view.app.workspace.getLeavesOfType = (() => [{ view: e.view }]) as any;
	s.input.value = "Сократи созданную заметку"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	response.resolve(json({ tool_calls: [edit(created)] }, "tool_calls")); await s.settle();
	expect(e.text).toBe("---\nстатус: черновик\n---\n# План\nЕдем поездом.");
	expect(s.create).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("ручная отмена собственной правки вызывает конфликт следующего поручения", async () => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([first.promise, json({ content: "Готово." }), second.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	first.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	const result = JSON.parse(s.requests[1].messages.at(-1).content); s.e.change(original);
	s.input.value = "Ещё сократи её"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [edit(result, "Едем.")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(original); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.root.getText()).toContain(t("action-conflict"));
	await s.view.onClose();
});

it("повторная доставка завершённой правки не создаёт ещё одну транзакцию", async () => {
	const response = deferred<Response>(), repeated = deferred<Response>(); const s = await start([response.promise, repeated.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1)); const write = edit(target(s));
	response.resolve(json({ tool_calls: [write] }, "tool_calls")); await vi.waitFor(() => expect(s.requests).toHaveLength(2));
	repeated.resolve(json({ tool_calls: [write] }, "tool_calls")); await s.settle();
	expect(s.e.transaction).toHaveBeenCalledTimes(1);
	expect(s.view.getMessages().filter(message => message.content.startsWith(t("action-edited")))).toHaveLength(1);
	await s.view.onClose();
});

it("сохраняет фактическую правку и новую версию при ошибке последующего ответа", async () => {
	const response = deferred<Response>(); const s = await start([response.promise, new Response("ошибка", { status: 500 })]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	const result = JSON.parse(s.requests[1].messages.at(-1).content);
	expect(result.version).not.toBe(target(s).version);
	expect(s.root.getText()).toContain("Изменена заметка: [[План.md]]");
	await s.ask("Что было выполнено?");
	expect(s.requests[2].messages.some((m: any) => m.role === "tool" && JSON.parse(m.content).version === result.version)).toBe(true);
	expect(s.e.transaction).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it.each([
	["пустой YAML", "---\n---\nСтарый текст", "Новый текст", "---\n---\nНовый текст"],
	["свойства без завершающего перевода строки", "---\nстатус: черновик\n---", "Новый текст", "---\nстатус: черновик\n---\nНовый текст"],
	["очистка основного текста", original, "", "---\nстатус: черновик\n---\n"],
] as const)("замена основного текста: %s", async (_label, before, content, after) => {
	const response = deferred<Response>(); const s = await start([response.promise]); s.e.change(before);
	attach(s, "Замени весь основной текст по поручению в @План"); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s), content)] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe(after); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("правка через чат отменяется и повторяется отдельно от соседнего ручного ввода в истории CodeMirror", async () => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	const before = original + "\nРучная метка до правки"; s.e.change(before);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s), "# План\nЕдем поездом.\nРучная метка до правки")] }, "tool_calls")); await s.settle();
	const after = s.e.text; s.e.change(after + "\nРучная метка после правки");
	s.e.view.editor.undo(); expect(s.e.text).toBe(after);
	s.e.view.editor.undo(); expect(s.e.text).toBe(before);
	s.e.view.editor.undo(); expect(s.e.text).toBe(original);
	s.e.view.editor.redo(); expect(s.e.text).toBe(before);
	s.e.view.editor.redo(); expect(s.e.text).toBe(after);
	s.e.view.editor.redo(); expect(s.e.text).toBe(after + "\nРучная метка после правки");
	await s.view.onClose();
});

it("потоковая правка не применяется до получения полного подтверждённого вызова", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "text/event-stream" } });
	const s = await start([stream]); attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const args = JSON.stringify({ targetId: target(s).targetId, expectedVersion: target(s).version, kind: "body", content: "Едем поездом." });
	const event = (delta: object, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`));
	event({ tool_calls: [{ index: 0, id: "поток", type: "function", function: { name: "edit_note", arguments: args.slice(0, 25) } }] });
	await flushPromises(); expect(s.e.transaction).not.toHaveBeenCalled();
	event({ tool_calls: [{ index: 0, function: { arguments: args.slice(25) } }] });
	await flushPromises(); expect(s.e.transaction).not.toHaveBeenCalled();
	event({}, "tool_calls"); controller.close(); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\nЕдем поездом."); expect(s.e.transaction).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it("материал и цель определяются поручением: другая прикреплённая заметка остаётся прежней", async () => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	s.add("Материал.md", "Билеты покупаем до четверга.");
	attach(s, "Добавь в @План");
	s.input.createSpan({ text: " срок покупки билетов по @Материал" }); s.input.dispatchEvent({ type: "input", inputType: "insertText" } as any); s.input.keydown("Tab");
	s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	response.resolve(json({ tool_calls: [edit(target(s), "# План\nБилеты покупаем до четверга.")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toContain("Билеты покупаем до четверга."); expect(s.texts.get("Материал.md")).toBe("Билеты покупаем до четверга.");
	await s.view.onClose();
});

it("остановленное чтение вложения не заменяет основу более нового успешного поручения", async () => {
	const stale = deferred<string>();
	const createResponse = deferred<Response>(), editResponse = deferred<Response>();
	const s = await start([createResponse.promise, json({ content: "Готово." }), editResponse.promise]);
	s.view.app.workspace.getLeavesOfType = () => [];
	const reading = vi.fn(async () => stale.promise); s.view.app.vault.read = reading;
	attach(s, "Обсудим @План"); s.send.click(); await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1));
	s.send.click();
	s.view.app.workspace.getLeavesOfType = (() => [{ view: s.e.view }]) as any;
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	createResponse.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	const next = JSON.parse(s.requests[1].messages.at(-1).content);
	stale.resolve(original); await flushPromises();
	s.input.value = "Ещё сократи ту же заметку"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	editResponse.resolve(json({ tool_calls: [edit(next, "Едем.")] }, "tool_calls")); await s.settle();
	expect(s.e.text).toBe("---\nстатус: черновик\n---\nЕдем."); expect(s.e.transaction).toHaveBeenCalledTimes(2);
	await s.view.onClose();
});

it("результат правки и сообщение конфликта доступны на английском", async () => {
	const first = deferred<Response>(), second = deferred<Response>();
	const s = await start([first.promise, json({ content: "Done." }), second.promise]); setLanguage("en");
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	first.resolve(json({ tool_calls: [edit(target(s))] }, "tool_calls")); await s.settle();
	expect(s.root.getText()).toContain("Note edited: [[План.md]]");
	const next = JSON.parse(s.requests[1].messages.at(-1).content); s.e.change(s.e.text + "\nРучная правка");
	s.input.value = "Ещё сократи заметку"; s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(3));
	second.resolve(json({ tool_calls: [edit(next)] }, "tool_calls")); await s.settle();
	expect(s.root.getText()).toContain("The note changed. Nothing was written.");
	await s.view.onClose();
});


it("принимает реальный поток qwen с повторным type функции в части аргументов", async () => {
	const trace = readFileSync(new URL("./fixtures/chat-note-actions/qwen-repeated-tool-type.sse", import.meta.url), "utf8");
	const response = deferred<Response>();
	const s = await start([response.promise],
		"---\nстатус: черновик\n---\n# План\nМы собираемся отправиться в поездку на поезде.\nРучная метка до правки.");
	attach(s, "Исправь фразу про поездку, остальное сохрани в @План"); s.send.click();
	await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	// Rebind only the captured opaque IDs; preserve the server's delta structure.
	const replay = trace.split("\n").map(line => {
		if (!line.startsWith("data: {")) return line;
		const event = JSON.parse(line.slice(6));
		for (const choice of event.choices ?? []) for (const delta of choice.delta?.tool_calls ?? []) {
			if (!delta.function?.arguments) continue;
			const args = JSON.parse(delta.function.arguments);
			delta.function.arguments = JSON.stringify({ ...args, targetId: target(s).targetId, expectedVersion: target(s).version });
		}
		return `data: ${JSON.stringify(event)}`;
	}).join("\n");
	response.resolve(new Response(replay, { headers: { "Content-Type": "text/event-stream" } })); await s.settle();
	expect(s.root.getText()).not.toContain(t("chat-invalid-stream"));
	expect(s.e.text).toBe("---\nстатус: черновик\n---\n# План\nМы поедем на поезде.\nРучная метка до правки.");
	expect(s.e.transaction).toHaveBeenCalledTimes(1);
	await s.view.onClose();
});

it.each([
	["смена типа", "function", "other"],
	["склеенный тип вместо метаданных", "func", "tion"],
] as const)("отклоняет повреждённый поток: %s", async (_label, firstType, secondType) => {
	const response = deferred<Response>(); const s = await start([response.promise]);
	attach(s); s.send.click(); await vi.waitFor(() => expect(s.requests).toHaveLength(1));
	const args = JSON.stringify({ targetId: target(s).targetId, expectedVersion: target(s).version, kind: "body", content: "Новый текст" });
	const events = [
		{ delta: { tool_calls: [{ index: 0, id: "проверка", type: firstType, function: { name: "edit_note", arguments: "" } }] } },
		{ delta: { tool_calls: [{ index: 0, type: secondType, function: { arguments: args } }] } },
		{ delta: {}, finish_reason: "tool_calls" },
	];
	response.resolve(new Response(events.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }));
	await s.settle(); expect(s.e.transaction).not.toHaveBeenCalled(); expect(s.e.text).toBe(original);
	expect(s.root.getText()).toContain(t("chat-invalid-stream"));
	await s.view.onClose();
});
