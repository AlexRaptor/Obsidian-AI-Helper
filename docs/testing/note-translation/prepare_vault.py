"""Create a fresh desktop Obsidian vault for note-translation visual checks."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dest', type=Path, default=Path(__file__).resolve().parent / 'translation-vault')
args = parser.parse_args()
vault = args.dest.expanduser().resolve()
repository = Path(__file__).resolve().parents[3]
if vault == repository or vault in repository.parents:
    parser.error('Хранилище нельзя создавать вместо репозитория или его родительской папки.')
if vault.exists() and not vault.is_dir():
    parser.error('Путь назначения занят файлом, а не папкой.')
if vault.exists() and any(vault.iterdir()):
    try:
        answer = input(f'Хранилище {vault} не пусто. Удалить всё его содержимое, включая настройки, и создать заново? [да/НЕТ]: ')
    except (EOFError, KeyboardInterrupt):
        answer = ''
    if answer.strip().lower() not in ('да', 'д', 'yes', 'y'):
        print('Перезапись отменена. Хранилище не изменено.')
        raise SystemExit(0)

files = {
    'Статьи/Короткая статья.md': 'Good notes preserve context. A useful translation preserves the meaning of the original.\n\nЭтот абзац уже написан на русском языке и должен остаться без изменений.\n',
    'Статьи/How to take notes.md': '''---
title: How to take notes
статус: проверка
aliases:
  - Original article
---
# How to take notes

Good notes preserve context. A useful translation preserves the author's meaning and the structure of the document.

Этот абзац уже написан на русском языке и должен остаться без изменений.

Read the [next section](#A practical method), [related note](../Справка/Метод.md), and [[Справка/Метод|a useful reference]].

## A practical method

1. Read the article and identify its main argument.
2. Record **important ideas**, *examples*, and ~~outdated advice~~.
   - Keep enough context for future reading.
   - [ ] Review the result tomorrow.

> [!tip] A useful habit
> Prefer a few clear sentences over a long list of disconnected words.

| Step | Purpose |
| --- | --- |
| Read | Understand the argument |
| Write | Preserve useful details |

Keep the expression $E = mc^2$ and the command `npm run build` unchanged.

```typescript
// Этот комментарий сохраняется дословно.
const original = "Do not translate this string";
```

![Diagram of the method](../Вложения/Схема.svg)

![[Справка/Метод]]

A short reference helps the reader.[^reference]

[^reference]: Read the source before making a decision.

A stable block reference. ^stable-block

#проверка
''',
    'Справка/Метод.md': '# Метод\n\nThis embedded note must remain unchanged and must not be translated as part of the article.\n',
    'Рабочее пространство.md': '# Другая заметка\n\nОткройте эту заметку в дополнительной области, чтобы проверить сохранение существующего рабочего пространства.\n',
    'Вложения/Схема.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect x="1" y="1" width="238" height="78" fill="none" stroke="currentColor"/><text x="24" y="46" fill="currentColor">Read → Write → Review</text></svg>\n',
}
# Build and stage all files before replacing the existing vault.
try:
    subprocess.run(['npm', 'run', 'build'], cwd=repository, check=True)
    manifest = json.loads((repository / 'manifest.json').read_text(encoding='utf-8'))
    plugin_id = manifest['id']
    if not isinstance(plugin_id, str) or not plugin_id or plugin_id in ('.', '..') or '/' in plugin_id or '\\' in plugin_id:
        parser.error('Недопустимый id плагина в manifest.json.')
    vault.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.translation-vault-', dir=vault.parent) as staging:
        prepared = Path(staging) / 'vault'
        plugin_directory = prepared / '.obsidian' / 'plugins' / plugin_id
        plugin_directory.mkdir(parents=True)
        for artifact in ('main.js', 'manifest.json', 'styles.css'):
            shutil.copy2(repository / artifact, plugin_directory / artifact)
        for name, content in files.items():
            target = prepared / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        if vault.exists():
            shutil.rmtree(vault)
        prepared.rename(vault)
except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
    parser.exit(1, f'Не удалось подготовить хранилище: {error}\n')
print(f'Подготовлено хранилище: {vault}')
print(f'Собранный плагин установлен: {vault / ".obsidian" / "plugins" / plugin_id}')
