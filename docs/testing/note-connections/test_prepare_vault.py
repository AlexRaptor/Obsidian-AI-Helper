"""Проверки контракта генератора во временных хранилищах."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import prepare_vault as generator


class PrepareVaultTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / 'репозиторий'
        self.repository.mkdir()
        self.vault = self.root / 'хранилище с пробелами'
        for name, content in {'manifest.json': json.dumps({'id': 'test-plugin'}), 'main.js': 'новая сборка', 'styles.css': 'новые стили'}.items():
            (self.repository / name).write_text(content, encoding='utf-8')
        self.patch_repository = patch.object(generator, 'REPOSITORY', self.repository)
        self.patch_repository.start()
        self.addCleanup(self.patch_repository.stop)
        build_patch = patch.object(generator.subprocess, 'run')
        self.build = build_patch.start()
        self.addCleanup(build_patch.stop)

    def populate(self):
        plugin = self.vault / '.obsidian' / 'plugins' / 'test-plugin'
        plugin.mkdir(parents=True)
        (plugin / 'data.json').write_bytes(b' { "example": "unchanged" }\r\n')
        (plugin / 'main.js').write_text('старая сборка', encoding='utf-8')
        (self.vault / '.obsidian' / 'app.json').write_bytes(b'{"test": true}\n')
        other = self.vault / '.obsidian' / 'plugins' / 'other-plugin'
        other.mkdir()
        (other / 'main.js').write_text('другой плагин', encoding='utf-8')
        (self.vault / 'Старая заметка.md').write_text('Старый текст.', encoding='utf-8')
        (self.vault / 'Вложения').mkdir()
        (self.vault / 'Вложения' / 'Пример.bin').write_bytes(b'old')

    def snapshot(self, directory):
        return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in directory.rglob('*') if path.is_file()}

    def run_generator(self, answers=()):
        with patch('builtins.input', side_effect=answers), contextlib.redirect_stdout(io.StringIO()):
            return generator.main(['--dest', str(self.vault)])

    def assert_notes(self):
        self.assertEqual({path.name for path in self.vault.iterdir() if path.name != '.obsidian'}, set(generator.NOTES))
        for name, text in generator.NOTES.items():
            self.assertEqual((self.vault / name).read_text(encoding='utf-8'), text)

    def test_new_and_empty_vault_build_install_and_use_manifest_id(self):
        for empty in (False, True):
            with self.subTest(empty=empty):
                if empty:
                    self.vault = self.root / 'пустое хранилище'
                    self.vault.mkdir()
                self.assertEqual(self.run_generator(), 0)
                self.assert_notes()
                plugin = self.vault / '.obsidian' / 'plugins' / 'test-plugin'
                for artifact in ('main.js', 'manifest.json', 'styles.css'):
                    self.assertEqual((plugin / artifact).read_bytes(), (self.repository / artifact).read_bytes())
                self.assertFalse((plugin / 'data.json').exists())
        self.build.assert_called_with(['npm', 'run', 'build'], cwd=self.repository, check=True)
        self.assertEqual(self.build.call_count, 2)

    def test_mode_one_resets_settings_and_installs_new_build(self):
        self.populate()
        self.run_generator(['1'])
        self.assert_notes()
        self.assertFalse((self.vault / '.obsidian' / 'app.json').exists())
        self.assertFalse((self.vault / '.obsidian' / 'plugins' / 'test-plugin' / 'data.json').exists())
        self.assertEqual((self.vault / '.obsidian' / 'plugins' / 'test-plugin' / 'main.js').read_text(encoding='utf-8'), 'новая сборка')

    def test_mode_two_preserves_settings_bytes_and_other_plugins(self):
        self.populate()
        obsidian = self.vault / '.obsidian'
        before = self.snapshot(obsidian)
        self.run_generator(['2'])
        self.assert_notes()
        for name in ('app.json', 'plugins/test-plugin/data.json', 'plugins/other-plugin/main.js'):
            self.assertEqual((obsidian / name).read_bytes(), before[name][0])
        self.assertEqual((obsidian / 'plugins/test-plugin/main.js').read_text(encoding='utf-8'), 'новая сборка')
        self.build.assert_called_once()

    def test_mode_three_leaves_obsidian_unchanged_without_build(self):
        self.populate()
        obsidian = self.vault / '.obsidian'
        before = self.snapshot(obsidian)
        self.run_generator(['3'])
        self.assert_notes()
        self.assertEqual(self.snapshot(obsidian), before)
        self.build.assert_not_called()

    def test_cancel_empty_eof_interrupt_and_invalid_number(self):
        self.populate()
        before = self.snapshot(self.vault)
        for answers in (['4'], [''], [EOFError()], [KeyboardInterrupt()], ['нет', '9', '4']):
            with self.subTest(answers=answers):
                self.assertEqual(self.run_generator(answers), 0)
                self.assertEqual(self.snapshot(self.vault), before)
        self.build.assert_not_called()

    def test_invalid_number_repeats_prompt_before_valid_selection(self):
        self.populate()
        self.run_generator(['не число', '3'])
        self.assert_notes()
        self.build.assert_not_called()

    def test_build_failure_preserves_existing_vault(self):
        self.populate()
        before = self.snapshot(self.vault)
        self.build.side_effect = subprocess.CalledProcessError(1, ['npm', 'run', 'build'])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            self.run_generator(['2'])
        self.assertEqual(error.exception.code, 1)
        self.assertEqual(self.snapshot(self.vault), before)

    def test_preparation_failure_preserves_existing_vault(self):
        self.populate()
        before = self.snapshot(self.vault)
        (self.repository / 'main.js').unlink()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_generator(['1'])
        self.assertEqual(self.snapshot(self.vault), before)

    def test_rejects_repository_ancestors_and_file_destination(self):
        file = self.root / 'обычный файл'
        file.write_text('Сохранить.', encoding='utf-8')
        for destination in (self.repository, self.repository.parent, file):
            with self.subTest(destination=destination), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                generator.main(['--dest', str(destination)])
        self.assertEqual(file.read_text(encoding='utf-8'), 'Сохранить.')
        self.build.assert_not_called()


if __name__ == '__main__':
    unittest.main()
