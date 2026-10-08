type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string> };

export class TestElement {
	children: TestElement[] = [];
	classes = new Set<string>();
	attributes: Record<string, string> = {};
	style: Record<string, string> = {};
	value = "";
	disabled = false;
	text = "";
	scrollTop = 0;
	scrollHeight = 0;
	private listeners = new Map<string, Array<() => void>>();

	empty(): void { this.children = []; this.text = ""; }
	addClass(value: string): void { value.split(" ").forEach((cls) => this.classes.add(cls)); }
	setText(value: string): void { this.text = value; }
	setAttribute(name: string, value: string): void { this.attributes[name] = value; }
	createEl(_tag: string, options: ElementOptions = {}): TestElement {
		const child = new TestElement();
		if (options.cls) child.addClass(options.cls);
		child.text = options.text ?? "";
		child.attributes = { ...options.attr };
		this.children.push(child);
		return child;
	}
	createDiv(options?: ElementOptions): TestElement { return this.createEl("div", options); }
	createSpan(options?: ElementOptions): TestElement { return this.createEl("span", options); }
	addEventListener(name: string, callback: () => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
	}
	click(): void {
		if (!this.disabled) this.listeners.get("click")?.forEach((callback) => callback());
	}
	find(cls: string): TestElement {
		if (this.classes.has(cls)) return this;
		for (const child of this.children) {
			try { return child.find(cls); } catch { /* search the next child */ }
		}
		throw new Error(`Element not found: ${cls}`);
	}
	getText(): string { return this.text + this.children.map((child) => child.getText()).join(""); }
}

export class Component {
	load(): void {}
	addChild<T>(child: T): T { return child; }
	removeChild<T>(child: T): T { return child; }
}

export class ItemView extends Component {
	contentEl = new TestElement();
	app = {};
}

export const MarkdownRenderer = {
	async render(_app: unknown, content: string, el: TestElement): Promise<void> {
		el.setText(content);
	},
};

export class Plugin extends Component {
	constructor(public app: unknown, _manifest: unknown) { super(); }
	async loadData(): Promise<unknown> { return {}; }
	registerView(): void {}
	addRibbonIcon(): void {}
	addCommand(): void {}
	addSettingTab(): void {}
}

export class PluginSettingTab {
	constructor(_app: unknown, _plugin: unknown) {}
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

export async function flushPromises(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}
