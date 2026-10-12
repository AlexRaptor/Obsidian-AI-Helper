import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

it("lets interface timers run during ranking before validating the selected sources", async () => {
	const paths = Array.from({ length: 100 }, (_, index) => `Notes/${index}.md`);
	let queryReturned = false;
	let interfaceRan = false;
	let firstValidationSawInterface: boolean | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const client = createServerClient(async (_url, init) => {
		const { input } = JSON.parse(String(init?.body));
		if (input[0] === "PROJECT_24") {
			queryReturned = true;
			timer = setTimeout(() => { interfaceRan = true; }, 0);
		}
		return new Response(JSON.stringify({ data: input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
	});
	const search = createNoteSearch({ client, factory: new IDBFactory(), vaultPath: "/ranking-scale", list: () => paths,
		read: async path => {
			if (queryReturned && firstValidationSawInterface === undefined) firstValidationSawInterface = interfaceRan;
			return `# ${path}\n` + "PROJECT_24 Поезд отправляется с платформы четыре в половине седьмого. ".repeat(150);
		}, open: async () => {} });
	search.configure({ embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e", autoUpdateNotes: false });
	try {
		await search.indexVault();
		expect(await search.searchSources("PROJECT_24")).not.toHaveLength(0);
		expect(firstValidationSawInterface).toBe(true);
	} finally { clearTimeout(timer); search.dispose(); }
});
