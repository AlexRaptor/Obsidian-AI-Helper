"""Собрать тестовое хранилище из папки заметок для ручного тестирования."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

REPOSITORY = Path(__file__).resolve().parents[2]


def choose_mode(vault):
    if not vault.exists() or not any(vault.iterdir()):
        return '1'
    print(f'Хранилище {vault} не пусто. Закройте его в Obsidian перед обновлением.')
    print('Варианты 1–3 удаляют весь прежний контент за пределами .obsidian.')
    print('1. Заменить полностью. Сбросить .obsidian, собрать и установить плагин.')
    print('2. Заменить, сохранив настройки плагина. Сохранить .obsidian, собрать и обновить плагин.')
    print('3. Заменить только контент. Сохранить .obsidian и плагин; сборку не запускать.')
    print('4. Отмена. Завершить без изменений.')
    while True:
        try:
            mode = input('Ваш выбор [1/2/3/4, по умолчанию 4]: ').strip() or '4'
        except (EOFError, KeyboardInterrupt):
            mode = '4'
        if mode in ('1', '2', '3', '4'):
            return mode
        print('Введите 1, 2, 3 или 4.')


def prepare(notes, vault, mode):
    plugin_id = None
    if mode != '3':
        subprocess.run(['npm', 'run', 'build'], cwd=REPOSITORY, check=True)
        manifest = json.loads((REPOSITORY / 'manifest.json').read_text(encoding='utf-8'))
        plugin_id = manifest['id']
        if not isinstance(plugin_id, str) or not plugin_id or plugin_id in ('.', '..') or '/' in plugin_id or '\\' in plugin_id:
            raise ValueError('Недопустимый id плагина в manifest.json.')
    vault.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.test-vault-', dir=vault.parent) as staging:
        prepared = Path(staging) / 'vault'
        shutil.copytree(notes, prepared)
        if mode == '2' and (vault / '.obsidian').exists():
            shutil.copytree(vault / '.obsidian', prepared / '.obsidian')
        if mode != '3':
            plugin_directory = prepared / '.obsidian' / 'plugins' / plugin_id
            plugin_directory.mkdir(parents=True, exist_ok=True)
            for artifact in ('main.js', 'manifest.json', 'styles.css'):
                shutil.copy2(REPOSITORY / artifact, plugin_directory / artifact)
        # Finish every build/copy before replacing existing data.
        if mode == '3':
            for entry in vault.iterdir():
                if entry.name == '.obsidian':
                    continue
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
            for entry in prepared.iterdir():
                entry.rename(vault / entry.name)
        else:
            if vault.exists():
                shutil.rmtree(vault)
            prepared.rename(vault)
    print(f'Подготовлено хранилище: {vault}')
    if mode == '3':
        print('Заменён только контент. Плагин и настройки Obsidian не изменены.')
    else:
        print(f'Собранный плагин установлен: {vault / ".obsidian" / "plugins" / plugin_id}')
        if mode == '2':
            print('Настройки плагина и Obsidian сохранены.')


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Пример из корня репозитория:\n  python3 docs/testing/prepare_vault.py '
               '--source docs/testing/note-connections/notes '
               '--dest docs/testing/note-connections/native-panel-vault',
    )
    parser.add_argument('--source', type=Path, required=True, help='Папка с тестовыми заметками и вложениями.')
    parser.add_argument('--dest', type=Path, help='Хранилище назначения; по умолчанию соседняя с исходником папка <имя>-vault.')
    arguments = sys.argv[1:] if argv is None else argv
    if not arguments:
        parser.print_help()
        return 0
    args = parser.parse_args(arguments)
    notes = args.source.expanduser().resolve()
    if not notes.is_dir():
        parser.error('Исходная папка с заметками не существует или не является папкой.')
    args.dest = args.dest if args.dest is not None else notes.with_name(notes.name + '-vault')
    vault = args.dest.expanduser().resolve()
    if vault == REPOSITORY or vault in REPOSITORY.parents:
        parser.error('Хранилище нельзя создавать вместо репозитория или его родительской папки.')
    script = Path(__file__).resolve()
    if vault == script.parent or vault in script.parents:
        parser.error('Папка назначения не должна содержать сам генератор.')
    if vault.exists() and not vault.is_dir():
        parser.error('Путь назначения занят файлом, а не папкой.')
    if notes == vault or notes in vault.parents or vault in notes.parents:
        parser.error('Исходная папка и хранилище назначения не должны пересекаться.')
    if (notes / '.obsidian').exists():
        parser.error('Исходные данные должны содержать заметки и вложения без папки .obsidian.')
    if any(path.is_symlink() for path in notes.rglob('*')):
        parser.error('Исходные данные должны содержать обычные файлы и папки без символических ссылок.')
    mode = choose_mode(vault)
    if mode == '4':
        print('Перезапись отменена. Хранилище не изменено.')
        return 0
    try:
        prepare(notes, vault, mode)
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        parser.exit(1, f'Не удалось подготовить хранилище: {error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
