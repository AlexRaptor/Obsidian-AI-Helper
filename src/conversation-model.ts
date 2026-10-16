import type { NoteSearch } from "./note-index";

/** A model operation owns one lease, including the priority over background work. */
export class ConversationModel {
	private current?: { ready: Promise<void>; release(): void };
	private disposed = false;
	constructor(private noteSearch: () => NoteSearch | undefined) {}

	tryAcquire(): { ready: Promise<void>; release(): void } | undefined {
		if (this.disposed || this.current) return undefined;
		// Reserve before notifying index subscribers: they may synchronously start work.
		const lease = {
			ready: Promise.resolve(),
			release: () => {
				if (this.current !== lease) return;
				this.current = undefined;
				priority?.release();
			},
		};
		let priority: ReturnType<NoteSearch["acquireChatPriority"]> | undefined;
		this.current = lease;
		try {
			priority = this.noteSearch()?.acquireChatPriority();
			if (this.current !== lease) { priority?.release(); return undefined; }
			lease.ready = priority?.ready ?? Promise.resolve();
			return lease;
		} catch (error) { lease.release(); throw error; }
	}

	dispose(): void { this.disposed = true; this.current?.release(); }
}
