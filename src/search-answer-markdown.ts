// Hide link/embed/HTML syntax until after Obsidian has rendered the formatting.
// Restoring it as text keeps model-supplied links from opening unverified notes.
export function prepareSearchMarkdown(content: string): { markdown: string; restore: (text: string) => string } {
	let prefix = "AIHELPERESC";
	while (content.includes(prefix)) prefix += "X";
	const characters = ["&", "[", "]", "<", ">"];
	return {
		markdown: content.replace(/[&\[\]<>]/g, character => `${prefix}${characters.indexOf(character)}END`),
		restore: text => text.replace(new RegExp(`${prefix}([0-4])END`, "g"), (_, index: string) => characters[Number(index)]),
	};
}

export function visitSearchAnswerText(element: HTMLElement, visit: (node: Text, parent: HTMLElement, inCode: boolean) => void, inCode = false): void {
	inCode ||= element.tagName === "CODE" || element.tagName === "PRE";
	// Automatic URL links are text as well; only verified citations become links.
	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === 3) visit(child as Text, element, inCode);
		else if (child.nodeType === 1) {
			const nested = child as HTMLElement;
			visitSearchAnswerText(nested, visit, inCode);
			if (nested.tagName === "A") nested.replaceWith(...Array.from(nested.childNodes));
		}
	}
}
