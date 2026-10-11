import { AbstractInputSuggest, App, TFolder, type SearchComponent } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: SearchComponent, private select: (path: string) => void) {
		super(app, input.inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder =>
			file instanceof TFolder && file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void { el.setText(folder.path); }

	selectSuggestion(folder: TFolder): void {
		const path = folder.path === "/" ? "/" : folder.path;
		this.input.setValue(path);
		this.select(path);
		this.close();
	}
}
