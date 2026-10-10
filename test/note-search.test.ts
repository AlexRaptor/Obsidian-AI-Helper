import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createNoteSearchStorageProbe, PROBE_LIMIT_BYTES } from "../src/note-search";

describe("note search local storage probe", () => {
	it("restores synthetic data in a new instance and isolates vaults with the same name", async () => {
		const indexedDB = new IDBFactory();
		const first = await createNoteSearchStorageProbe("/first/Notes", indexedDB);
		await first.write(128 * 1024);
		const restored = await createNoteSearchStorageProbe("/first/Notes", indexedDB);
		expect(await restored.read()).toEqual({ bytes: 131072, blocks: 2 });
		const other = await createNoteSearchStorageProbe("/second/Notes", indexedDB);
		expect(await other.read()).toBeNull();
		await other.write(65536);
		await first.clear();
		expect(await restored.read()).toBeNull();
		expect(await other.read()).toEqual({ bytes: 65536, blocks: 1 });
		await other.clear();
	});

	it("reports unavailable storage without creating a file fallback", async () => {
		const probe = await createNoteSearchStorageProbe("/Notes", undefined);
		await expect(probe.write()).rejects.toMatchObject({ code: "unavailable" });
	});

	it("rejects oversized writes and aborted writes while retaining complete data", async () => {
		const probe = await createNoteSearchStorageProbe("/Notes", new IDBFactory());
		await probe.write(65536);
		await expect(probe.write(PROBE_LIMIT_BYTES + 1)).rejects.toMatchObject({ code: "limit" });
		await expect(probe.testAbortedWrite()).rejects.toMatchObject({ code: "write" });
		expect(await probe.read()).toEqual({ bytes: 65536, blocks: 1 });
	});
});
