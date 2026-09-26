# Obsidian AI Helper

A chat with an LLM in your Obsidian vault, served by any OpenAI-compatible model server.

## Development

- `npm install`
- `npm run dev` — watch mode, rebuilds `main.js` on save
- `npm run build` — production bundle + typecheck
- `npm test` — vitest

## Installation into Obsidian

1. `npm run build`
2. In a vault: Settings → Community plugins → disable Restricted mode
3. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/obsidian-ai-helper/`
4. Reload Obsidian (Cmd/Ctrl+R)

## Usage

- Ribbon icon or command palette (`Toggle AI Helper chat`) opens the chat in a tab.
- Settings → Obsidian AI Helper: model server URL, optional API key, model name, UI language.
- This build (T1) ships the scaffold: chat view, settings tab, full en/ru localization. Requests land in a later ticket.
