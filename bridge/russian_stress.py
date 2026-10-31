"""Stress marks for the Russian PocketTTS model (docs/POCKET_TTS_RUNTIME.md, "Russian").

The Russian model (xVibePocketTTS, a fine-tune of Kyutai's pocket-tts) reads a stressed vowel as the vowel followed by U+0301 (COMBINING ACUTE
ACCENT). Written Russian has no marks, so before a line goes to the model this module

  1. turns a written "+" before a vowel into that vowel followed by U+0301 (sl+ovo is slovo with the mark, a way for a character or a prompt to force a stress);
     "+" before the letter yo is dropped and yo stays unmarked (yo is always stressed);
  2. adds the mark to every word that has none, from a table of plain word -> stressed vowel. A word with a mark, a word with yo, a word with one vowel and a
     word the table does not know (or knows with two different stresses, such as "goroda") goes through as written.

The table is one file (stress-ru.bin, built by packaging/build-russian-stress.py from the openrussian.org data, CC BY-SA 4.0). It is loaded when the
Russian model becomes resident and dropped when another model replaces it, so nothing of it stays in memory for a player who does not speak Russian.
A lookup is a binary search in one bytes object: no Python dict of a million words, about 4 MB while loaded. Pure Python, no Torch.

File format (version 1), little endian:
    8 bytes   b"AINPCRS1"
    32 bytes  SHA-256 of the payload below (after zlib)
    4 bytes   length of the payload
    zlib(payload)
payload:
    uint8     group count
    per group (ascending letter count): uint8 letters L, uint32 entries
    per group, in the same order: entries * (L + 1) bytes, sorted by the first L bytes
a record is the word in Windows-1251 (one byte per letter) and one byte: the 0-based index of the stressed letter.
"""
from __future__ import annotations

import hashlib
import re
import struct
import zlib

MAGIC = b"AINPCRS1"
ACUTE = "́"
VOWELS = "аеёиоуыэюя"
ENCODING = "cp1251"
MAX_PAYLOAD = 64 * 1024 * 1024
MAX_LETTERS = 64
# A word shorter than this cannot have two vowels, so the table has nothing for it.
MIN_LETTERS = 2

_PLUS = re.compile("\\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])")
# A run of Russian letters (and marks). Next to a Latin letter or a digit it is not a Russian word and is left alone.
_WORD = re.compile("(?<![A-Za-z0-9_])[А-Яа-яЁё́]+(?![A-Za-z0-9_])")
_CYRILLIC = re.compile("[А-Яа-яЁё]")


def encode_dictionary(entries):
    """The file bytes of {plain word: index of the stressed letter}. Every word is lowercase Russian letters without yo, has two or more vowels, and the
    index points at a vowel; anything else raises ValueError (the build script filters before it gets here)."""
    groups = {}
    for word, index in entries.items():
        if (not isinstance(word, str) or not MIN_LETTERS <= len(word) <= MAX_LETTERS or word != word.lower() or "ё" in word
                or not re.fullmatch("[а-я]+", word) or type(index) is not int or not 0 <= index < len(word) or word[index] not in VOWELS
                or sum(letter in VOWELS for letter in word) < 2):
            raise ValueError(f"not a stressed word: {word!r} {index!r}")
        groups.setdefault(len(word), []).append((word.encode(ENCODING), index))
    ordered = sorted(groups)
    header = bytearray([len(ordered)])
    body = bytearray()
    for letters in ordered:
        records = sorted(groups[letters])
        header += struct.pack("<BI", letters, len(records))
        for key, index in records:
            body += key + bytes([index])
    payload = bytes(header) + bytes(body)
    return MAGIC + hashlib.sha256(payload).digest() + struct.pack("<I", len(payload)) + zlib.compress(payload, 9)


def payload_digest(data):
    """The SHA-256 of the uncompressed payload (what the file stores in its header): the same words and stresses give the same value on any zlib."""
    if data[:8] != MAGIC:
        raise ValueError("Not a Russian stress dictionary")
    return data[8:40].hex()


class StressDictionary:
    """Plain word -> index of the stressed letter, from the file. `get(word)` takes a lowercase word without yo."""

    def __init__(self, groups, entries):
        self.groups = groups        # letters -> (count, bytes)
        self.entries = entries

    @classmethod
    def from_bytes(cls, data):
        if not isinstance(data, (bytes, bytearray)) or len(data) < 45 or data[:8] != MAGIC:
            raise ValueError("Not a Russian stress dictionary")
        digest, (length,) = bytes(data[8:40]), struct.unpack_from("<I", data, 40)
        if not 1 <= length <= MAX_PAYLOAD:
            raise ValueError("Russian stress dictionary has an invalid size")
        inflater = zlib.decompressobj()
        payload = inflater.decompress(bytes(data[44:]), length + 1)
        if len(payload) != length or inflater.unconsumed_tail or inflater.unused_data or not inflater.eof or hashlib.sha256(payload).digest() != digest:
            raise ValueError("Russian stress dictionary is damaged")
        count = payload[0]
        if count > MAX_LETTERS:
            raise ValueError("Russian stress dictionary is damaged")
        at, sizes, previous = 1, [], 0
        for _ in range(count):
            if at + 5 > len(payload):
                raise ValueError("Russian stress dictionary is damaged")
            letters, entries = struct.unpack_from("<BI", payload, at)
            at += 5
            if not previous < letters <= MAX_LETTERS:
                raise ValueError("Russian stress dictionary is damaged")
            previous = letters
            sizes.append((letters, entries))
        groups, total = {}, 0
        for letters, entries in sizes:
            width = letters + 1
            end = at + entries * width
            if end > len(payload):
                raise ValueError("Russian stress dictionary is damaged")
            groups[letters] = (entries, payload[at:end])
            at, total = end, total + entries
        if at != len(payload):
            raise ValueError("Russian stress dictionary is damaged")
        return cls(groups, total)

    @classmethod
    def load(cls, path):
        with open(path, "rb") as stream:
            return cls.from_bytes(stream.read(MAX_PAYLOAD))

    def get(self, word):
        """Index of the stressed letter of `word`, or None."""
        try:
            key = word.encode(ENCODING)
        except UnicodeEncodeError:
            return None
        letters = len(key)
        group = self.groups.get(letters)
        if group is None:
            return None
        low, high = 0, group[0]
        blob, width = group[1], letters + 1
        while low < high:
            middle = (low + high) >> 1
            start = middle * width
            found = blob[start:start + letters]
            if found < key:
                low = middle + 1
            elif found > key:
                high = middle
            else:
                return blob[start + letters]
        return None

    def __len__(self):
        return self.entries


def convert_plus(text):
    """A written "+" before a vowel becomes the vowel and U+0301 (before yo: only the "+" goes). Any other "+" stays."""
    if "+" not in text:
        return text
    return _PLUS.sub(lambda match: match.group(1) if match.group(1) in "ёЁ" else match.group(1) + ACUTE, text)


def add_stress(text, dictionary):
    """The text with a mark on every word of the table that has none. A word with a mark, with yo, with one vowel, an unknown word or one with two
    stresses in the data is not changed. With no dictionary the text is returned as it is."""
    if dictionary is None or not _CYRILLIC.search(text):
        return text
    get = dictionary.get

    def mark(match):
        word = match.group(0)
        if len(word) < MIN_LETTERS or ACUTE in word or "ё" in word or "Ё" in word:
            return word
        low = word.lower()
        index = get(low)
        if index is None or index >= len(word) or low[index] not in VOWELS:
            return word
        return word[:index + 1] + ACUTE + word[index + 1:]

    return _WORD.sub(mark, text)


def prepare_text(text, dictionary=None):
    """What the Russian model is given for a line: written "+" converted, then the table's stresses added. One pass over the line for each, only when the
    line has Russian letters."""
    if not isinstance(text, str):
        return text
    return add_stress(convert_plus(text), dictionary)
