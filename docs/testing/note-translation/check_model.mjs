// Bundle the production operation with the test Vault adapter; never open or change a vault.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'translation-model-'));
try {
  const outfile = join(temporary, 'check.mjs');
  await build({ entryPoints: [join(repository, 'docs/testing/note-translation/check_model.ts')], bundle: true, platform: 'node', format: 'esm', outfile, alias: { obsidian: join(repository, 'test/helpers/obsidian.ts') } });
  await import(pathToFileURL(outfile).href);
} finally { await rm(temporary, { recursive: true, force: true }); }
