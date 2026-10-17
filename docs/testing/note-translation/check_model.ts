import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { TFile, MarkdownView, type App } from 'obsidian';
import { NoteTranslation } from '../../../src/note-translation';
import { createServerClient } from '../../../src/server-client';
import { conservativePromptTokens } from '../../../src/prompt-tokens';
import { t, setLanguage } from '../../../src/i18n';
import type { AiHelperPlugin } from '../../../src/main';

const argument = (key: string) => { const at = process.argv.indexOf(key); return at < 0 ? undefined : process.argv[at + 1]; };
const settingsPath = argument('--settings');
const outputPath = argument('--out');
if (!settingsPath || !outputPath) throw Error('Usage: node check_model.mjs --settings PATH --out PATH [--context 65536] [--runs 3] [--sample phrases|article|plain]');
const runs = Number(argument('--runs') ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw Error('runs must be 1..10');
const repository = resolve(dirname(process.argv[1]), '../../..');
const fixtures = join(repository, 'docs/testing/note-translation');
const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
const required = ['serverUrl', 'model', 'translationLanguage', 'translationPrompt', 'translationSuffix', 'translationNameMode', 'translationFolderMode', 'translationFolder', 'temperature', 'topP', 'maxTokens', 'responseWait'];
if (required.some(key => typeof saved[key] !== 'string')) throw Error('Settings file is incomplete: save the plugin settings first.');
const settings = { ...saved, contextWindow: argument('--context') ?? saved.contextWindow };
setLanguage(settings.language === 'en' ? 'en' : 'ru');
const output = resolve(outputPath); await mkdir(output, { recursive: true });
const phrases = await readFile(join(fixtures, 'issue58-phrases.md'), 'utf8');
const samples = [
  { id: 'phrases', path: 'Статьи/Сложные фразы.md', text: phrases },
  { id: 'article', path: 'Статьи/How to take notes.md', text: await readFile(join(fixtures, 'issue58-source.md'), 'utf8') },
  { id: 'plain', path: 'Статьи/Фразы без оформления.md', text: phrases.replace(/\[([^\]]+)\]\(https:\/\/example.org\)/g, '$1').replaceAll('*', '') },
].filter(sample => !argument('--sample') || sample.id === argument('--sample'));
if (!samples.length) throw Error('Unknown sample');
const results: unknown[] = [];
const safeSettings = { model: settings.model, temperature: settings.temperature || 'server default', topP: settings.topP || 'server default', maxTokens: settings.maxTokens || 'operation budget', contextWindow: settings.contextWindow || 'discovery', responseWait: settings.responseWait || 'unlimited', translationLanguage: settings.translationLanguage, promptSha256: createHash('sha256').update(settings.translationPrompt).digest('hex'), protocolSha256: createHash('sha256').update(await readFile(join(repository, 'src/translation-protocol.ts'))).digest('hex') };
await writeFile(join(output, 'parameters.json'), JSON.stringify(safeSettings, null, 2));
evaluation: for (const sample of samples) for (let run = 1; run <= runs; run++) {
  const started = Date.now(); const tag = `${sample.id}-${run}`;
  const files = new Map([[sample.path, sample.text], ['Справка/Метод.md', '# Метод\n\nВстроенная заметка не переводится.'], ['Вложения/Схема.svg', '<svg/>']]);
  const folders = new Set(['Статьи', 'Справка', 'Вложения']);
  const entries = new Map<string, TFile>();
  const file = (path: string) => { if (!entries.has(path)) entries.set(path, Object.assign(new TFile(), { path, basename: path.split('/').at(-1)!.replace(/\.md$/, ''), extension: path.split('.').at(-1) })); return entries.get(path)!; };
  const original = file(sample.path);
  const view = Object.assign(Object.create(MarkdownView.prototype), { file: original, getMode: () => 'source', editor: { getValue: () => sample.text } });
  const leaves: any[] = [];
  const newLeaf = () => { const leaf = { view: {}, openFile: async () => {} }; leaves.push(leaf); return leaf; };
  const leaf = newLeaf(); leaf.view = view;
  const app = {
    vault: {
      adapter: { exists: async (path: string) => files.has(path) || folders.has(path) },
      getFiles: () => [...files.keys()].map(file), getFileByPath: (path: string) => files.has(path) ? file(path) : null,
      getAbstractFileByPath: (path: string) => files.has(path) ? file(path) : folders.has(path) ? { path, children: [] } : null,
      read: async (entry: TFile) => files.get(entry.path)!, createFolder: async (path: string) => { folders.add(path); },
      create: async (path: string, text: string) => { if (files.has(path)) throw Error('occupied'); files.set(path, text); return file(path); },
      process: async () => { throw Error('Fixture must never overwrite'); },
    },
    metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    workspace: { activeLeaf: leaf, getActiveViewOfType: () => view, getLeavesOfType: () => [leaf], iterateAllLeaves: (visit: (leaf: unknown) => void) => leaves.forEach(visit), getLeaf: () => newLeaf(), createLeafBySplit: () => newLeaf(), setActiveLeaf: () => {} },
  } as unknown as App;
  const wireRequests: unknown[] = [];
  const client = createServerClient(async (url, init) => {
    const body = url.endsWith('/chat/completions') ? JSON.parse(String(init?.body)) : undefined;
    const response = await fetch(url, init);
    if (body) wireRequests.push({ status: response.status, structured: !!body.response_format, stream: body.stream, maxTokens: body.max_tokens });
    return response;
  });
  const replay = argument('--replay');
  if (replay) client.countPromptTokens = async (_url, _model, messages) => conservativePromptTokens(messages);
  let requests = 0;
  const requestParameters: unknown[] = [];
  const chat = client.chat;
  client.chat = async (...args) => {
    const request = ++requests; requestParameters.push({ request, jsonResponse: !!args[3]?.responseSchema, maxTokens: args[3]?.maxTokens, temperature: args[3]?.temperature || "server default", topP: args[3]?.topP || "server default" }); console.log(`${tag}: model request ${request}`);
    const result = replay
      ? { ok: true as const, value: JSON.parse(await readFile(join(resolve(replay), `${tag}-response-${request}.json`), 'utf8')) }
      : await chat(...args);
    // Sources are fixed public fixtures; responses contain no settings, headers, or full requests.
    if (result.ok) await writeFile(join(output, `${tag}-response-${request}.json`), JSON.stringify(result.value, null, 2));
    else await writeFile(join(output, `${tag}-response-${request}.json`), JSON.stringify({ ok: false, code: result.error.code }));
    return result;
  };
  const plugin = { app, settings, serverClient: client, t, conversationModel: { tryAcquire: () => ({ ready: Promise.resolve(), release: () => {} }) } } as unknown as AiHelperPlugin;
  const operation = new NoteTranslation(plugin);
  const watchdog = setTimeout(() => operation.stop(), 600_000);
  operation.start(original);
  try { while (operation.busy) await new Promise(resolve => setTimeout(resolve, 50)); }
  finally { clearTimeout(watchdog); }
  const translated = operation.savedPath ? files.get(operation.savedPath)! : '';
  const fixtureChecks = {
    originalUnchanged: files.get(sample.path) === sample.text,
    noServiceMarkers: !/⟦AIH/.test(translated),
    noProtocolDescriptions: !/inline code|mathematical expression|block identifier|footnote reference/.test(translated),
    ...(sample.id === 'article' ? {
      frontmatter: translated.startsWith(sample.text.slice(0, sample.text.indexOf('# How to take notes'))),
      code: translated.includes('const original = "Do not translate this string";') && translated.includes('// Этот комментарий сохраняется дословно.'),
      formula: translated.includes('$E = mc^2$'), inlineCode: translated.includes('`npm run build`'),
      footnote: translated.includes('[^reference]:') && translated.includes('[^reference]'), block: translated.includes('^stable-block'), embed: translated.includes('Справка/Метод.md]]'),
      alreadyRussian: translated.includes('Этот абзац уже написан на русском языке и должен остаться без изменений.'),
    } : {
      code: translated.includes('`cache.get(key)`'), formula: translated.includes('$E = mc^2$'),
      foreignSpanTranslated: !translated.includes('this useful reference'),
      russianPrefix: translated.includes('Это русский текст, а '), russianEnding: translated.includes(' требует перевода.'),
      links: sample.id === 'plain' || (translated.match(/\]\(https:\/\/example.org\)/g) ?? []).length === 3,
    }),
  };
  const result = { sample: sample.id, run, replayed: !!replay, success: operation.stage === 'translation-saved' && !!operation.savedPath && Object.values(fixtureChecks).every(Boolean), stage: operation.stage, detail: operation.detail, protocolDetail: operation.protocolDetail, progress: operation.progress, requests, requestParameters, wireRequests, fixtureChecks, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
  if (operation.savedPath) await writeFile(join(output, `${tag}.md`), files.get(operation.savedPath)!);
  results.push(result);
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${tag}: ${result.success ? 'saved' : 'FAILED'}; ${result.protocolDetail || result.detail || (result.success ? result.stage : 'fixture: ' + Object.entries(fixtureChecks).filter(([, ok]) => !ok).map(([key]) => key).join(', '))}; ${result.elapsedSeconds}s`);
  operation.dispose();
  if (!result.success && !process.argv.includes("--keep-going")) break evaluation;
}
if ((results as { success: boolean }[]).some(result => !result.success)) process.exitCode = 1;
