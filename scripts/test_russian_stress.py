"""Stress marks for the Russian PocketTTS model (bridge/russian_stress.py) and the build script that makes its table (packaging/build-russian-stress.py).

No model, no network: a small table is built in the test, and the committed table is spot-checked."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import russian_stress as rs

spec = importlib.util.spec_from_file_location('build_russian_stress_under_test', ROOT / 'packaging/build-russian-stress.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

A = '́'
WORDS = {'привет': 4, 'молоко': 5, 'человек': 5, 'улица': 0, 'потому': 5, 'иначе': 2, 'холодно': 1, 'ау': 0}


def table(words=None):
    return rs.StressDictionary.from_bytes(rs.encode_dictionary(WORDS if words is None else words))


class PlusMarks(unittest.TestCase):
    def test_a_plus_before_a_vowel_becomes_the_vowel_and_the_acute_accent(self):
        self.assertEqual(rs.convert_plus('сл+ово'), 'сло' + A + 'во')
        self.assertEqual(rs.convert_plus('+улица и дел+о'), 'у' + A + 'лица и дело' + A)
        self.assertEqual(rs.convert_plus('+Он, +Эхо'), 'О' + A + 'н, Э' + A + 'хо', 'capital vowels too')
        for vowel in 'аеиоуыэюя':
            self.assertEqual(rs.convert_plus('+' + vowel), vowel + A)

    def test_yo_stays_unmarked_and_loses_only_the_plus(self):
        self.assertEqual(rs.convert_plus('+ёж и +Ёлка'), 'ёж и Ёлка')
        self.assertNotIn(A, rs.convert_plus('+ёж'))

    def test_a_plus_that_is_not_before_a_vowel_stays(self):
        for text in ('2+2', 'a+b', 'плюс +', '+ну', 'C++', '+7 495', '+ ', 'к+', 'Hello +a'):
            self.assertEqual(rs.convert_plus(text), text)

    def test_the_plus_works_without_a_table(self):
        self.assertEqual(rs.prepare_text('Сл+ово', None), 'Сло' + A + 'во')


class TableStress(unittest.TestCase):
    def setUp(self):
        self.table = table()

    def test_a_word_without_a_mark_gets_the_stress_of_the_table(self):
        self.assertEqual(rs.prepare_text('Привет, как дела?', self.table), 'Приве' + A + 'т, как дела?')
        self.assertEqual(rs.prepare_text('молоко', self.table), 'молоко' + A)
        self.assertEqual(rs.prepare_text('у улица', self.table), 'у у' + A + 'лица', 'a stress on the first letter')
        self.assertEqual(rs.prepare_text('ау', self.table), 'а' + A + 'у', 'two letters, two vowels')

    def test_capitals_and_punctuation_keep_their_place(self):
        self.assertEqual(rs.prepare_text('ПРИВЕТ! Человек...', self.table), 'ПРИВЕ' + A + 'Т! Челове' + A + 'к...')
        self.assertEqual(rs.prepare_text('«Холодно», — сказал.', self.table), '«Хо' + A + 'лодно», — сказал.')

    def test_a_word_that_has_a_mark_or_yo_is_left_as_it_is(self):
        marked = 'при' + A + 'вет'
        self.assertEqual(rs.prepare_text(marked, self.table), marked, 'the written stress wins over the table')
        self.assertEqual(rs.prepare_text('привет сл+ово привет', self.table), 'Приве'.lower() + A + 'т сло' + A + 'во приве' + A + 'т')
        yo = table({'желудь': 1, 'молоко': 5})                  # the table never holds a word with yo; the same word without it is another entry
        self.assertEqual(rs.prepare_text('жёлудь', yo), 'жёлудь', 'yo is always stressed: no mark')
        self.assertEqual(rs.prepare_text('желудь', yo), 'же' + A + 'лудь')

    def test_unknown_one_vowel_and_ambiguous_words_are_not_marked(self):
        self.assertEqual(rs.prepare_text('Джонни, дом, кот, мы', self.table), 'Джонни, дом, кот, мы')
        self.assertEqual(rs.prepare_text('привет-привет', self.table), 'приве' + A + 'т-приве' + A + 'т', 'a hyphenated word is two words')

    def test_latin_and_digits_next_to_letters_make_it_not_a_russian_word(self):
        for text in ('iPhoneпривет', 'привет5', 'v2привет', 'hello world', '', '123'):
            self.assertEqual(rs.prepare_text(text, self.table), text)
        self.assertEqual(rs.prepare_text('Hello привет test', self.table), 'Hello приве' + A + 'т test')

    def test_no_table_changes_nothing(self):
        self.assertEqual(rs.prepare_text('Привет, мир', None), 'Привет, мир')
        self.assertEqual(rs.add_stress('Привет', None), 'Привет')

    def test_a_table_entry_that_does_not_point_at_a_vowel_is_ignored(self):
        broken = rs.StressDictionary.from_bytes(rs.encode_dictionary({'привет': 4}))
        broken.groups[6] = (1, bytes('привет'.encode('cp1251')) + bytes([3]))      # index 3 is a consonant
        self.assertEqual(rs.prepare_text('привет', broken), 'привет')

    def test_one_line_of_fifteen_words_is_a_cheap_pass(self):
        import time
        line = 'Привет, как дела? Я иду домой, потому что на улице холодно и я устал, человек.'
        started = time.perf_counter()
        for _ in range(500):
            rs.prepare_text(line, self.table)
        per_line_ms = (time.perf_counter() - started) / 500 * 1000
        self.assertLess(per_line_ms, 5, 'a dictionary pass per line is far under what a reply costs')

    def test_non_text_is_given_back(self):
        self.assertIsNone(rs.prepare_text(None, self.table))


class Format(unittest.TestCase):
    def test_every_entry_is_found_and_a_word_that_is_not_there_is_not(self):
        words = {'привет': 4, 'приветы': 4, 'приветик': 4, 'молоко': 5, 'молоки': 1, 'ау': 0, 'эхо': 0}
        built = table(words)
        self.assertEqual(len(built), len(words))
        for word, index in words.items():
            self.assertEqual(built.get(word), index, word)
        for word in ('приве', 'приветик ', 'привет-', 'абв', 'ёжик', 'hello', 'молока', 'ауу', '', 'я'):
            self.assertIsNone(built.get(word), word)

    def test_the_file_is_small_and_the_same_words_give_the_same_payload(self):
        first, second = rs.encode_dictionary(WORDS), rs.encode_dictionary(dict(reversed(list(WORDS.items()))))
        self.assertEqual(rs.payload_digest(first), rs.payload_digest(second))
        self.assertEqual(first[:8], rs.MAGIC)
        self.assertLess(len(first), 400)

    def test_a_word_that_cannot_be_stored_is_refused_when_the_table_is_built(self):
        for word, index in (('привет', 3), ('привет', 6), ('привет', -1), ('Привет', 4), ('жёлудь', 3), ('hello', 1), ('да', 1), ('ab', 0), ('кот', 1), ('привет', True), ('привет', '4')):
            with self.assertRaises(ValueError, msg=(word, index)):
                rs.encode_dictionary({word: index})

    def test_a_damaged_or_foreign_file_is_refused(self):
        good = bytearray(rs.encode_dictionary(WORDS))
        for data in (b'', b'nothing at all', bytes(good[:10]), bytes(good[:-3]), bytes(good) + b'x'):
            with self.assertRaises(ValueError, msg=len(data)):
                rs.StressDictionary.from_bytes(data)
        flipped = bytearray(good)
        flipped[12] ^= 1                                         # a bit of the stored digest
        with self.assertRaisesRegex(ValueError, 'damaged'):
            rs.StressDictionary.from_bytes(bytes(flipped))
        zero = bytearray(good)
        zero[40:44] = (0).to_bytes(4, 'little')
        with self.assertRaisesRegex(ValueError, 'invalid size'):
            rs.StressDictionary.from_bytes(bytes(zero))

    def test_it_loads_from_a_path(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'stress-ru.bin'
            path.write_bytes(rs.encode_dictionary(WORDS))
            self.assertEqual(rs.StressDictionary.load(path).get('привет'), 4)

    def test_release_is_dropping_the_object(self):
        import gc, weakref
        loaded = table()
        reference = weakref.ref(loaded)
        loaded = None
        gc.collect()
        self.assertIsNone(reference(), 'nothing else holds the table')


class BuildScript(unittest.TestCase):
    def forms(self, field):
        return list(build.stressed_forms(field))

    def test_a_field_holds_one_or_several_forms(self):
        self.assertEqual(self.forms("ра'за, ра'зу"), [('раза', 1), ('разу', 1)])
        self.assertEqual(self.forms("жи'ло,жило'"), [('жило', 1), ('жило', 3)])
        self.assertEqual(self.forms("уда'лось//удало'сь"), [('удалось', 2), ('удалось', 4)])
        self.assertEqual(self.forms("*све'ты"), [('светы', 2)])
        self.assertEqual(self.forms("ча'са,    часа'"), [('часа', 1), ('часа', 3)])

    def test_what_a_wrong_mark_would_hurt_is_left_out(self):
        for field in ("челове'к-то", "кто'-то", "стол", "дом'", "то'т", "психо`невро'з", "псѝхонев'ро", "pa'za", "серёг=>", "_устар._", "сказа''ть", "'", "зёрна'", "ё'лка",
                      "ёлка", "мо'й", "", None):
            self.assertEqual(self.forms(field), [], field)
        self.assertEqual(self.forms("то'т"), [], 'one vowel')
        self.assertEqual(self.forms("стол"), [], 'no mark')
        self.assertEqual(self.forms("серёги'"), [], 'yo')
        self.assertEqual(self.forms("kо'мната"), [], 'a Latin look-alike letter')
        self.assertEqual(self.forms("кто'-то"), [], 'a hyphen')
        self.assertEqual(self.forms("вода'"), [('вода', 3)])
        self.assertEqual(self.forms("а'у"), [('ау', 0)])

    def test_a_mark_after_a_consonant_is_not_a_stress(self):
        self.assertEqual(self.forms("вод'а"), [])

    def source(self, folder, rows):
        for name in ('nouns', 'verbs', 'adjectives', 'others'):
            header = 'bare\taccented\ttranslations_en\ttranslations_de\tsg_nom\tsg_gen\n' if name == 'nouns' else 'bare\taccented\ttranslations_en\ttranslations_de\n'
            (Path(folder) / f'{name}.csv').write_text(header + ''.join(row + '\n' for row in rows.get(name, [])), encoding='utf-8')

    def test_the_table_keeps_what_is_unambiguous_and_skips_a_word_with_two_stresses(self):
        with tempfile.TemporaryDirectory() as folder:
            self.source(folder, {'nouns': ["город\tго'род\ttown\tStadt\tго'род\tго'рода", "город2\tгорода'\tx\ty\tгорода'\tгорода'"],
                                 'others': ["привет\tприве'т\thi\thallo"]})
            skip, counts = build.collect(folder, 'skip')
            first, counts_first = build.collect(folder, 'first')
        self.assertEqual(skip, {'город': 1, 'привет': 4})
        self.assertEqual(first, {'город': 1, 'привет': 4, 'города': 1})
        self.assertEqual((counts['ambiguous'], counts['entries'], counts['ambiguousPolicy']), (1, 2, 'skip'))
        self.assertEqual(counts_first['entries'], 3)
        with self.assertRaises(ValueError):
            build.collect('.', 'maybe')

    def test_the_table_built_from_rows_stresses_a_line(self):
        with tempfile.TemporaryDirectory() as folder:
            self.source(folder, {'others': ["привет\tприве'т\thi\thallo", "молоко\tмолоко'\tmilk\tMilch"]})
            entries, _ = build.collect(folder)
        built = rs.StressDictionary.from_bytes(rs.encode_dictionary(entries))
        self.assertEqual(rs.prepare_text('привет, молоко', built), 'приве' + A + 'т, молоко' + A)

    def test_the_pinned_source_is_a_commit_with_its_licence_and_a_hash_for_every_file(self):
        source = build.SOURCE
        self.assertRegex(source['commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(source['license'], 'CC-BY-SA-4.0')
        self.assertEqual(set(source['files']), {'nouns.csv', 'verbs.csv', 'adjectives.csv', 'others.csv', 'LICENSE'})
        for value in source['files'].values():
            self.assertRegex(value, r'^[0-9a-f]{64}$')

    def test_a_source_that_is_not_the_pinned_file_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            self.source(folder, {})
            with self.assertRaises(SystemExit) as caught:
                build.verify_sources(folder)
            self.assertIn('not the pinned file', str(caught.exception))
            with self.assertRaises(SystemExit):
                build.verify_sources(Path(folder) / 'nowhere')


class CommittedTable(unittest.TestCase):
    """The table that ships: built from the openrussian.org data at the pinned commit by packaging/build-russian-stress.py (source.json is its record)."""
    folder = ROOT / 'packaging/russian-stress'

    def test_it_matches_its_record_and_has_the_words_a_line_needs(self):
        record = json.loads((self.folder / 'source.json').read_text(encoding='utf-8'))
        data = (self.folder / 'stress-ru.bin').read_bytes()
        loaded = rs.StressDictionary.from_bytes(data)
        self.assertEqual(rs.payload_digest(data), record['payloadSha256'])
        self.assertEqual(len(loaded), record['counts']['entries'])
        self.assertEqual(len(data), record['bytes'])
        self.assertLess(len(data), 4 * 1024 * 1024, 'a few MB at most')
        self.assertEqual(record['source']['license'], 'CC-BY-SA-4.0')
        self.assertEqual(record['source']['commit'], build.SOURCE['commit'])
        self.assertEqual(record['source']['files'], build.SOURCE['files'])
        self.assertGreater(len(loaded), 400_000)
        for word, text in {'привет': 'приве' + A + 'т', 'человек': 'челове' + A + 'к', 'молоко': 'молоко' + A, 'холодно': 'хо' + A + 'лодно', 'иначе': 'ина' + A + 'че',
                           'потому': 'потому' + A, 'улица': 'у' + A + 'лица', 'устал': 'уста' + A + 'л'}.items():
            self.assertEqual(rs.prepare_text(word, loaded), text, word)
        # a word with two stresses in the data, a name and a word with yo are not guessed
        for word in ('города', 'дела', 'замок', 'джонни', 'панам', 'ёлка', 'мир'):
            self.assertEqual(rs.prepare_text(word, loaded), word, word)

    def test_every_entry_of_the_shipped_table_is_a_stress_on_a_vowel(self):
        loaded = rs.StressDictionary.load(self.folder / 'stress-ru.bin')
        for letters, (count, blob) in loaded.groups.items():
            width = letters + 1
            for at in range(0, count * width, width * 997):
                word = blob[at:at + letters].decode('cp1251')
                self.assertIn(word[blob[at + letters]], rs.VOWELS, word)
                self.assertGreaterEqual(sum(letter in rs.VOWELS for letter in word), 2, word)


if __name__ == '__main__':
    unittest.main()
