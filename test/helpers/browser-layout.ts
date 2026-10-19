import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestElement } from "./obsidian";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function html(element: TestElement): string {
	const attributes = { ...element.attributes, class: [...element.classes, element.className].join(" "), style: Object.entries(element.style).map(([key, value]) => `${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}:${value}`).join(';') };
	const hidden = (element as TestElement & { hidden?: boolean }).hidden ? ' hidden' : '';
	return `<${element.tagName}${hidden} ${Object.entries(attributes).map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}>${escape(element.text)}${element.children.map(html).join('')}</${element.tagName}>`;
}

/** Render the actual ChatView DOM and production CSS in an isolated headless browser. */
export function checkChatLayout(root: TestElement): void {
	const directory = mkdtempSync(join(tmpdir(), 'ai-helper-layout-'));
	try {
		const path = join(directory, 'chat.html');
		writeFileSync(path, `<!doctype html><meta charset="utf-8"><style>
			:root { --input-height: 28px; --font-ui-small: 12px; }
			* { box-sizing: border-box; } body { margin: 0; font: 14px sans-serif; }
			.host { height: 700px; width: 360px; overflow: hidden; }
			${readFileSync('styles.css', 'utf8')}
		</style><div class="host">${html(root)}</div><script>
		const errors = [];
		const connections = document.querySelector('.ai-helper-connections');
		const input = document.querySelector('.ai-helper-input-row');
		const messages = document.querySelector('.ai-helper-messages');
		const host = document.querySelector('.host');
		for (const [width, height] of [[360, 700], [260, 480], [800, 800]]) {
			host.style.width = width + 'px'; host.style.height = height + 'px';
		for (const expanded of [false, true]) {
			connections.querySelectorAll('details').forEach(details => details.open = expanded);
			let viewport = connections;
			while (viewport && !['auto', 'scroll'].includes(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
			if (!viewport) { errors.push('No scroll viewport'); continue; }
			const bounds = viewport.getBoundingClientRect();
			if (input.getBoundingClientRect().top - bounds.bottom > 20) errors.push('Suggestions stop above the input: gap=' + Math.round(input.getBoundingClientRect().top - bounds.bottom));
			if (!viewport.contains(messages)) errors.push('Suggestions and chat use separate scroll viewports');
			const last = connections.querySelector('.ai-helper-connection:last-child details:last-child ' + (expanded ? 'pre' : 'summary'));
			last.scrollIntoView({ block: 'end' });
			if (last.getBoundingClientRect().bottom > viewport.getBoundingClientRect().bottom + 1) errors.push('Last fragment is clipped after scrolling');
			if (input.getBoundingClientRect().bottom > document.querySelector('.host').getBoundingClientRect().bottom + 1) errors.push('Input is outside the panel');
		}
		}
		document.body.innerHTML = '<pre id="result">' + (errors.length ? errors.join('; ') : 'PASS') + '</pre>';
		</script>`);
		const output = execFileSync(process.env.AI_HELPER_LAYOUT_BROWSER!, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', `--user-data-dir=${join(directory, 'profile')}`, '--dump-dom', `file://${path}`], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
		if (!output.includes('<pre id="result">PASS</pre>')) throw new Error(output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] ?? 'Browser did not produce a layout result');
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
