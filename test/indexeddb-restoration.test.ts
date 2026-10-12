import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createNoteSearch } from "../src/note-index";
import { createServerClient } from "../src/server-client";

afterEach(() => { vi.restoreAllMocks(); });

it("restores a saved index when the bulk key request finishes after the metadata request", async () => {
	const factory = new IDBFactory();
	const client = createServerClient(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })));
	const environment = { factory, vaultPath: "/idb-restore", client, list: () => ["Train.md"], read: async () => "Train leaves at 18:30.", open: async () => {} };
	const settings = { embeddingServerUrl: "http://s/v1", embeddingApiKey: "", embeddingModel: "e" };
	const saved = createNoteSearch(environment); saved.configure(settings); await saved.indexVault(); saved.dispose();

	// Browser boundary: reproduce a bulk request whose result is still pending
	// when a separately completed metadata request delivers its success event.
	const getAllKeys = IDBObjectStore.prototype.getAllKeys;
	const get = IDBObjectStore.prototype.get;
	let finishKeys: (() => void) | undefined;
	const pendingReads: string[] = [];
	vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementation(function (...args) {
		const request = getAllKeys.apply(this, args);
		let ready = false;
		let success: ((event: Event) => void) | null = null;
		const delayed = new Proxy(request, {
			get(target, key) {
				if (key === "result" && !ready) {
					pendingReads.push("InvalidStateError: The request has not finished.");
					throw new DOMException("The request has not finished.", "InvalidStateError");
				}
				return Reflect.get(target, key, target);
			},
			set(target, key, value) {
				if (key === "onsuccess") { success = value; return true; }
				return Reflect.set(target, key, value, target);
			},
		});
		finishKeys = () => { ready = true; success?.call(delayed, new Event("success")); };
		return delayed;
	});
	vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (...args) {
		const request = get.apply(this, args);
		if (args[0] === "updates") request.addEventListener("success", () => queueMicrotask(() => finishKeys?.()));
		return request;
	});
	const restored = createNoteSearch(environment); restored.configure(settings);
	try {
		const error = await restored.restore().then(() => null, error => error);
		expect(pendingReads).toEqual([]);
		expect(error).toBeNull();
		expect(restored.progress).toMatchObject({ state: "complete", completed: 1, total: 1 });
		expect(await restored.search("Departure time?")).toMatchObject({ path: "Train.md" });
	} finally { restored.dispose(); }
});
