# Obsidian AI Helper

A chat with an LLM in your Obsidian vault, served by any OpenAI-compatible model server.

Requires Obsidian 1.13.0 or later. Supports desktop Obsidian only. Mobile Obsidian is not supported.

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
- Settings → Obsidian AI Helper: language and native sub-pages for Connection and conversation, Note search, and Advanced settings. The default language follows Obsidian; existing explicit English/Russian preferences are preserved.
- Chat header actions and the pane menu clear the conversation and toggle note search. New conversation, Stop generation, and Note search are also available in the command palette; assign shortcuts in Obsidian’s Hotkeys settings.
- Excluded folders use a native folder list with suggestions. Missing paths remain excluded; `/` excludes the vault root.
- Source citations open verified notes, support a new tab with Obsidian modifiers or the middle mouse button, and offer Page preview when that core plugin is enabled. Search answers remain plain text; model-generated links are not activated.
- Source similarity and top P have sliders alongside exact text input. Enable the model server default for top P to omit it from requests.
- Enter a message and click Send or press Enter; Shift+Enter inserts a newline. Model messages render as Markdown.
- Each request includes the successful conversation history and optional system prompt. Generation parameters and the context window indicator are configured in settings.
- Leave Context window empty for automatic detection from LM Studio, Ollama, vLLM, or llama.cpp. The detected size and server source appear below the field. A positive integer overrides detection; clearing it restores automatic mode. Existing saved values remain manual overrides.
- Detection refreshes at startup, when changing the server/key/model, when refreshing models, and after a successful completion or model check. Use the context refresh button after changing the server's load configuration. LM Studio and Ollama must have the model loaded to report its active window. Unsupported or unavailable metadata leaves the window unknown; enter a size manually. The effective size also controls the note-search source budget (8192-token fallback when unknown).
- Check model still sends a short completion: context metadata does not confirm that generation works. Automatic detection only reads metadata and does not send a test prompt.
- Clear conversation resets the history and cancels the active request. Closing the chat also cancels its active request.
- Failed messages can be retried without duplicating request history. Changing the UI language preserves the current draft and active request.
- Model lists load in the background with a 15-second timeout. Chat requests have a 120-second timeout, including response body loading.
- Conversations are kept in memory and are not saved between chat views or Obsidian restarts.
