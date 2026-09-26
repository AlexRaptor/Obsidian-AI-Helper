# AGENTS.md

Obsidian AI Helper — an Obsidian plugin (TypeScript, esbuild). Repo is currently empty (title-only README); code follows the standard `obsidian-sample-plugin` scaffold layout.

## Commands (standard scaffold — verify against package.json once it lands)

- `npm install`
- `npm run dev` — esbuild watch mode; rebuilds `main.js` on save
- `npm run build` — production bundle + `tsc` typecheck (run this as the gate before committing)
- If `test` script exists: `npm test`; run a single test with `npx vitest run <file>`

## How to test the plugin

There is no standalone runtime. To run:

1. `npm run build` (produces `main.js`, `manifest.json`, `styles.css` at repo root)
2. In an Obsidian vault: Settings → Community plugins → turn on Restricted mode off
3. Copy/zip `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/<manifest id>/`
4. Reload Obsidian (Ctrl/Cmd+R); check the console for errors

## Conventions

- Import the Obsidian API as `import { ... } from "obsidian"` and `app`-typed services via `this.app` — never `require`/Node builtins; the bundle runs in the Obsidian renderer.
- `@types/node` and `obsidian` are dev/prod deps of the scaffold; don't add Node-only libraries (fs, path, child_process) — use Obsidian APIs (`App.vault`, `DataAdapter`) instead.
- `manifest.json` `id` must match the plugin folder name in the vault; the `id` is the source of truth.
- No linter/formatter config exists yet; follow existing code style once files land.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
