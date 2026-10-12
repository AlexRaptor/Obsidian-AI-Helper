import { expect, it } from "vitest";
import { prepareSearchMarkdown, visitSearchAnswerText } from "../src/search-answer-markdown";
import { TestElement } from "./helpers/obsidian";

it("hides link, embed, HTML and entity syntax without changing Markdown formatting", () => {
	const content = "AIHELPERESC * **bold** [[Note]] ![image](url) <img> &lbrack;\n```ts\narray[0] < 1 && true\n```";
	const prepared = prepareSearchMarkdown(content);
	expect(prepared.markdown).not.toMatch(/[&\[\]<>]/);
	expect(prepared.markdown).toContain("* **bold**");
	expect(prepared.restore(prepared.markdown)).toBe(content);
});

it("visits code as literal text and removes automatically generated links", () => {
	const root = new TestElement();
	root.createEl("pre").createEl("code", { text: "[1]" });
	root.createEl("p").createEl("a", { text: "https://example.com" });
	const visited: Array<[string, boolean]> = [];
	visitSearchAnswerText(root as unknown as HTMLElement, (node, _parent, inCode) => visited.push([node.textContent ?? "", inCode]));
	expect(visited).toEqual([["[1]", true], ["https://example.com", false]]);
	expect(root.children[1].children.some(child => child.tagName === "A")).toBe(false);
	expect(root.getText()).toBe("[1]https://example.com");
});
