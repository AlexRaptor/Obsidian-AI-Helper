type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string> };

export class TestElement {
	children: TestElement[] = [];
	private parent: TestElement | null = null;
	className = "";
	remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
	appendChild(child: TestElement): TestElement { child.remove(); child.parent = this; this.children.push(child); return child; }
	classes = new Set<string>();
	attributes: Record<string, string> = {};
	style: Record<string, string> = {};
	value = "";
	disabled = false;
	text = "";
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	private listeners = new Map<string, Array<(event: any) => void>>();

	empty(): void { this.children = []; this.text = ""; }
	addClass(...values: string[]): void { values.flatMap(value => value.split(" ")).forEach((cls) => this.classes.add(cls)); }
	setText(value: string): void { this.text = value; }
	setAttribute(name: string, value: string): void { this.attributes[name] = value; }
	createEl(_tag: string, options: ElementOptions = {}): TestElement {
		const child = new TestElement();
		if (options.cls) child.addClass(options.cls);
		child.text = options.text ?? "";
		child.attributes = { ...options.attr };
		child.parent = this;
		this.children.push(child);
		return child;
	}
	createDiv(options?: ElementOptions): TestElement { return this.createEl("div", options); }
	createSpan(options?: ElementOptions): TestElement { return this.createEl("span", options); }
	addEventListener(name: string, callback: (event: any) => void): void {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
	}
	dispatchEvent(event: { type: string }): void {
		this.listeners.get(event.type)?.forEach((callback) => callback(event));
	}
	click(): void {
		if (!this.disabled) this.listeners.get("click")?.forEach((callback) => callback({ preventDefault() {}, stopPropagation() {} }));
	}
	keydown(key: string, shiftKey = false): void {
		this.listeners.get("keydown")?.forEach((callback) => callback({ key, shiftKey, preventDefault() {} }));
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
	registerDomEvent(el: TestElement, event: string, callback: (evt: any) => void): void { el.addEventListener(event, callback); }
	load(): void {}
	addChild<T>(child: T): T { return child; }
	removeChild<T>(child: T): T { return child; }
}

export class ItemView extends Component {
	contentEl = new TestElement();
	app = {};
	addAction(icon: string, title: string, callback: () => void): TestElement {
		const action = this.contentEl.createEl("button", { attr: { "aria-label": title } });
		setIcon(action, icon); setTooltip(action, title); action.addEventListener("click", callback); return action;
	}
}

export const MarkdownRenderer = {
	async render(_app: unknown, content: string, el: TestElement): Promise<void> {
		el.setText(content);
	},
};

export function setIcon(el: TestElement, icon: string): void {
	el.setAttribute("data-icon", icon);
}

export class Notice {
	static messages: string[] = [];
	constructor(message: string) { Notice.messages.push(message); }
}

export class Plugin extends Component {
	constructor(public app: unknown, public manifest: any) {
		super();
		const testApp = app as { workspace?: { getLeavesOfType?: () => unknown[] } };
		testApp.workspace ??= {};
		testApp.workspace.getLeavesOfType ??= () => [];
	}
	register(_callback: () => void): void {}
	registerEvent(_event: unknown): void {}
	async loadData(): Promise<unknown> { return {}; }
	registerHoverLinkSource(): void {}
	registerView(): void {}
	addRibbonIcon(): void {}
	addCommand(): void {}
	addSettingTab(): void {}
}

export class PluginSettingTab {
	containerEl = new TestElement();
	private cleanups: Array<() => void> = [];
	private displayed = false;
	constructor(public app: unknown, public plugin: any) {}
	getControlValue(key: string): unknown { return this.plugin.settings[key]; }
	getSettingDefinitions(): any[] { return []; }
	createSetting(_parent: TestElement): any { throw new Error("Provide a Setting test adapter"); }
	update(): void { if (this.displayed) this.display(); else this.getSettingDefinitions(); }
	refreshDomState(): void {}
	hide(): void { this.displayed = false; this.cleanups.splice(0).forEach(cleanup => cleanup()); }
	display(): void {
		this.displayed = true;
		this.cleanups.splice(0).forEach(cleanup => cleanup()); this.containerEl.empty();
		// Behavioral tests render every sub-page to exercise its controls. Real navigation
		// and search indexing are checked separately through the definitions and in Obsidian.
		const render = (definitions: any[]) => {
			for (const definition of definitions) {
				if (definition.items) { render(definition.items); continue; }
				const setting = this.createSetting(this.containerEl).setName(definition.name).setDesc(definition.desc ?? "");
				if (definition.render) {
					const cleanup = definition.render(setting, new SettingGroup(this.containerEl));
					if (cleanup) this.cleanups.push(cleanup);
					continue;
				}
				const control = definition.control;
				if (!control) continue;
				const value = this.getControlValue(control.key) ?? control.defaultValue ?? "";
				const change = async (next: any, input?: TestElement) => {
					const error = await control.validate?.(next);
					input?.setAttribute("aria-invalid", String(!!error));
					setting.setDesc((definition.desc ?? "") + (error ? ` ${error}` : ""));
					if (!error) await (this as any).setControlValue(control.key, next);
				};
				if (control.type === "dropdown") setting.addDropdown((dropdown: any) => {
					Object.entries(control.options).forEach(([key, name]) => dropdown.addOption(key, name));
					dropdown.setValue(value).onChange((next: string) => change(next));
				});
				else if (control.type === "toggle") setting.addToggle((toggle: any) => toggle.setValue(value).onChange((next: boolean) => change(next)));
				else {
					const method = control.type === "textarea" ? "addTextArea" : "addText";
					setting[method]((input: any) => input.setValue(value).onChange((next: string) => change(next, input.inputEl)));
				}
			}
		};
		render(this.getSettingDefinitions());
	}
}

export class Modal {
	static opened: Modal[] = [];
	contentEl = new TestElement();
	constructor(public app: unknown) {}
	open(): void { Modal.opened.push(this); this.onOpen(); }
	close(): void { this.onClose(); Modal.opened = Modal.opened.filter(modal => modal !== this); }
	onOpen(): void {}
	onClose(): void { this.contentEl.empty(); }
}

export class FileSystemAdapter {}
export class TFile {}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

export async function flushPromises(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

export class SettingGroup {
	listEl: TestElement;
	constructor(parent: TestElement) { this.listEl = parent.createDiv(); }
	setHeading(_text: string): this { return this; }
	addClass(cls: string): this { this.listEl.addClass(cls); return this; }
}

export class Menu {
	static last?: Menu;
	items: Array<{ title: string; callback: () => void }> = [];
	addItem(build: (item: any) => void): this {
		const item = { title: "", callback: () => {}, setTitle(title: string) { this.title = title; return this; }, setIcon() { return this; }, setChecked() { return this; }, onClick(callback: () => void) { this.callback = callback; return this; } };
		build(item); this.items.push(item); return this;
	}
	showAtMouseEvent(): void { Menu.last = this; }
}
export function setTooltip(el: TestElement, text: string): void { el.setAttribute("data-tooltip", text); }

export class TFolder {}
export class AbstractInputSuggest<T> { constructor(public app: unknown, _input: unknown) {} close(): void {} }

export function getLanguage(): string { return "en"; }

export class ProgressBarComponent {
	private fill: TestElement;
	constructor(parent: TestElement) { this.fill = parent.createDiv({ cls: "progress-bar" }); }
	setValue(value: number): this { this.fill.style.width = `${value}%`; return this; }
}

export class Keymap { static isModEvent(evt: { button?: number; ctrlKey?: boolean; metaKey?: boolean }): boolean { return evt.button === 1 || !!evt.ctrlKey || !!evt.metaKey; } }

export class ButtonComponent {
	buttonEl: TestElement;
	constructor(parent: TestElement) { this.buttonEl = parent.createEl("button"); }
	setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
	setTooltip(text: string): this { setTooltip(this.buttonEl, text); return this; }
	onClick(callback: () => void): this { this.buttonEl.addEventListener("click", callback); return this; }
}
