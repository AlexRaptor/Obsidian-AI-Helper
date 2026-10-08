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
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/obsidian-ai-helper/`
4. Reload Obsidian (Cmd/Ctrl+R)

## Usage

- Ribbon icon or command palette (`Toggle AI Helper chat`) opens the chat in the right sidebar.
- Settings → Obsidian AI Helper: model server URL, optional API key, model name, UI language.
- Enter a message and click Send or press Enter; Shift+Enter inserts a newline. Model messages render as Markdown.
- Each request includes the successful conversation history and optional system prompt. Generation parameters and the context window indicator are configured in settings.
- Clear conversation resets the history and cancels the active request. Closing the chat also cancels its active request.
- Failed messages can be retried without duplicating request history. Changing the UI language preserves the current draft and active request.
- Model lists load in the background with a 15-second timeout. Chat requests have a 120-second timeout, including response body loading.
- Conversations are kept in memory and are not saved between chat views or Obsidian restarts.
