"""Собрать тестовое хранилище для ручной проверки поиска связей (#60)."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

REPOSITORY = Path(__file__).resolve().parents[3]
DEFAULT_DEST = Path(__file__).resolve().parent / 'native-panel-vault'
NOTES = {
    'Обучение.md': '# Обучение\n\nАктивное вспоминание помогает удерживать знания. Нужно определить расписание повторений.\n',
    'Расписание.md': '# Расписание\n\nПовторяйте изученное через день и через неделю. Проверяйте себя без подсказок.\n',
}


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


def prepare(vault, mode):
    plugin_id = None
    if mode != '3':
        subprocess.run(['npm', 'run', 'build'], cwd=REPOSITORY, check=True)
        manifest = json.loads((REPOSITORY / 'manifest.json').read_text(encoding='utf-8'))
        plugin_id = manifest['id']
        if not isinstance(plugin_id, str) or not plugin_id or plugin_id in ('.', '..') or '/' in plugin_id or '\\' in plugin_id:
            raise ValueError('Недопустимый id плагина в manifest.json.')
    vault.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.note-connections-vault-', dir=vault.parent) as staging:
        prepared = Path(staging) / 'vault'
        prepared.mkdir()
        if mode == '2' and (vault / '.obsidian').exists():
            shutil.copytree(vault / '.obsidian', prepared / '.obsidian')
        if mode != '3':
            plugin_directory = prepared / '.obsidian' / 'plugins' / plugin_id
            plugin_directory.mkdir(parents=True, exist_ok=True)
            for artifact in ('main.js', 'manifest.json', 'styles.css'):
                shutil.copy2(REPOSITORY / artifact, plugin_directory / artifact)
        for name, content in NOTES.items():
            (prepared / name).write_text(content, encoding='utf-8')
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, default=DEFAULT_DEST)
    args = parser.parse_args(argv)
    vault = args.dest.expanduser().resolve()
    if vault == REPOSITORY or vault in REPOSITORY.parents:
        parser.error('Хранилище нельзя создавать вместо репозитория или его родительской папки.')
    script = Path(__file__).resolve()
    if vault == script.parent or vault in script.parents:
        parser.error('Папка назначения не должна содержать сам генератор.')
    if vault.exists() and not vault.is_dir():
        parser.error('Путь назначения занят файлом, а не папкой.')
    mode = choose_mode(vault)
    if mode == '4':
        print('Перезапись отменена. Хранилище не изменено.')
        return 0
    try:
        prepare(vault, mode)
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        parser.exit(1, f'Не удалось подготовить хранилище: {error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
