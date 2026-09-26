import { describe, expect, it } from "vitest";
import { Conversation, type Message, type Role } from "../src/conversation";

describe("conversation", () => {
	it("starts empty", () => {
		const c = new Conversation();
		expect(c.getMessages()).toEqual([]);
	});

	it("appends user and model messages in order", () => {
		const c = new Conversation();
		c.addMessage({ role: "user", content: "hi" });
		c.addMessage({ role: "model", content: "hello" });
		expect(c.getMessages()).toEqual([
			{ role: "user", content: "hi" },
			{ role: "model", content: "hello" },
		]);
	});

	it("getMessages returns a copy, not the internal array", () => {
		const c = new Conversation();
		c.addMessage({ role: "user", content: "hi" });
		const snapshot = c.getMessages();
		snapshot.push({ role: "model", content: "injected" });
		expect(c.getMessages()).toHaveLength(1);
	});

	it("clear empties the conversation", () => {
		const c = new Conversation();
		c.addMessage({ role: "user", content: "a" });
		c.addMessage({ role: "model", content: "b" });
		c.clear();
		expect(c.getMessages()).toEqual([]);
	});

	it("keeps full history so requests can carry prior turns", () => {
		const c = new Conversation();
		c.addMessage({ role: "user", content: "q1" });
		c.addMessage({ role: "model", content: "a1" });
		c.addMessage({ role: "user", content: "q2" });
		expect(c.getMessages().map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
	});
});
