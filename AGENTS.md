# AGENTS.md

Obsidian AI Helper — an Obsidian plugin (TypeScript, esbuild) with a chat view, settings, English/Russian localization, and an OpenAI-compatible model-server client. Source is in `src/`; tests are in `test/`.

## Commands

- `npm install`
- `npm run dev` — esbuild watch mode; rebuilds `main.js` on save
- `npm run build` — production bundle + `tsc` typecheck (run this as the gate before committing)
- `npm test` — Vitest; run a single test with `npx vitest run <file>`

## How to test the plugin

There is no standalone runtime. To run:

1. `npm run build` (bundles `main.js` and synchronizes the version in `manifest.json`; `styles.css` is a separate source file)
2. In an Obsidian vault: Settings → Community plugins → disable Restricted mode
3. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/<manifest id>/`
4. Reload Obsidian (Ctrl/Cmd+R); check the console for errors

## Conventions

- Import the Obsidian API as `import { ... } from "obsidian"` and `app`-typed services via `this.app` — never `require`/Node builtins; the bundle runs in the Obsidian renderer.
- `@types/node` and `obsidian` are dev/prod deps of the scaffold; don't add Node-only libraries (fs, path, child_process) — use Obsidian APIs (`App.vault`, `DataAdapter`) instead.
- `manifest.json` `id` must match the plugin folder name in the vault; the `id` is the source of truth.
- No linter/formatter config exists yet; follow existing code style once files land.
- Vitest maps `obsidian` to `test/helpers/obsidian.ts` because the npm package provides type definitions only. Test view behavior through its input and buttons; the helper does not replace validation inside Obsidian.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
