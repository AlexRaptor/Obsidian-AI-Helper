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
        self.notes = self.root / 'исходные заметки'
        (self.notes / 'Раздел').mkdir(parents=True)
        (self.notes / 'Раздел' / 'Пример.md').write_text('# Проверка\n\nТестовая заметка.\n', encoding='utf-8')
        (self.notes / 'Вложения').mkdir()
        (self.notes / 'Вложения' / 'Пример.bin').write_bytes(bytes(range(256)))
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
            return generator.main(['--source', str(self.notes), '--dest', str(self.vault)])

    def assert_notes(self):
        expected = {str(path.relative_to(self.notes)): path.read_bytes() for path in self.notes.rglob('*') if path.is_file()}
        actual = {name: data[0] for name, data in self.snapshot(self.vault).items() if not name.startswith('.obsidian/')}
        self.assertEqual(actual, expected)

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
                generator.main(['--source', str(self.notes), '--dest', str(destination)])
        self.assertEqual(file.read_text(encoding='utf-8'), 'Сохранить.')
        self.build.assert_not_called()

    def test_no_arguments_print_instructions_without_changes(self):
        self.populate()
        before = self.snapshot(self.root)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch('builtins.input') as prompt:
            self.assertEqual(generator.main([]), 0)
        self.assertIn('--source', output.getvalue())
        self.assertIn('--dest', output.getvalue())
        self.assertIn('Пример', output.getvalue())
        self.assertEqual(self.snapshot(self.root), before)
        prompt.assert_not_called()
        self.build.assert_not_called()

    def test_source_is_required_when_other_arguments_are_given(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            generator.main(['--dest', str(self.vault)])
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.vault.exists())
        self.build.assert_not_called()

    def test_default_destination_is_next_to_source(self):
        self.vault = self.notes.with_name(self.notes.name + '-vault')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(generator.main(['--source', str(self.notes)]), 0)
        self.assert_notes()

    def test_rejects_missing_or_file_source_without_changing_destination(self):
        self.populate()
        before = self.snapshot(self.vault)
        for source in (self.root / 'нет папки', self.notes / 'Раздел' / 'Пример.md'):
            with self.subTest(source=source), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                generator.main(['--source', str(source), '--dest', str(self.vault)])
        self.assertEqual(self.snapshot(self.vault), before)
        self.build.assert_not_called()

    def test_rejects_overlapping_paths_in_both_directions(self):
        for source, destination in ((self.notes, self.notes), (self.notes, self.notes / 'внутри'), (self.notes / 'Раздел', self.notes)):
            before = self.snapshot(self.root)
            with self.subTest(source=source, destination=destination), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                generator.main(['--source', str(source), '--dest', str(destination)])
            self.assertEqual(self.snapshot(self.root), before)
        self.build.assert_not_called()

    def test_rejects_overlap_through_symlink(self):
        alias = self.root / 'псевдоним'
        alias.symlink_to(self.notes, target_is_directory=True)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            generator.main(['--source', str(alias), '--dest', str(self.notes)])
        self.build.assert_not_called()

    def test_rejects_obsidian_settings_in_source(self):
        self.populate()
        before = self.snapshot(self.vault)
        (self.notes / '.obsidian').mkdir()
        (self.notes / '.obsidian' / 'app.json').write_text('{}')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_generator(['1'])
        self.assertEqual(self.snapshot(self.vault), before)
        self.build.assert_not_called()

    def test_rejects_symlinks_in_source(self):
        self.populate()
        before = self.snapshot(self.vault)
        (self.notes / 'ссылка.md').symlink_to(self.vault / 'Старая заметка.md')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_generator(['1'])
        self.assertEqual(self.snapshot(self.vault), before)
        self.build.assert_not_called()

    def test_source_copy_failure_preserves_existing_vault(self):
        self.populate()
        before = self.snapshot(self.vault)
        with patch.object(generator.shutil, 'copytree', side_effect=OSError('Ошибка чтения исходника')):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.run_generator(['2'])
        self.assertEqual(self.snapshot(self.vault), before)


if __name__ == '__main__':
    unittest.main()
