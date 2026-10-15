"""Create a fresh desktop Obsidian vault for note-translation visual checks."""
from pathlib import Path
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dest', type=Path, default=Path(__file__).resolve().parent / 'translation-vault')
args = parser.parse_args()
vault = args.dest.expanduser().resolve()
if vault.exists() and any(vault.iterdir()):
    parser.error('Папка назначения не пуста. Для восстановления используйте новую пустую папку.')

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
for name, content in files.items():
    target = vault / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')
print(f'Подготовлено хранилище: {vault}')
