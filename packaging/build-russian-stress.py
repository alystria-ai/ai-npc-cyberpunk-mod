#!/usr/bin/env python3
"""Builds stress-ru.bin, the Russian stress table the Pocket worker loads when the Russian model is resident (bridge/russian_stress.py has the format).

Source: the openrussian.org dictionary data, published on GitHub as Badestrand/russian-dictionary (licence CC BY-SA 4.0), at the pinned commit below:
four tab-separated files (nouns, verbs, adjectives, others) with every word form and a "'" after the stressed vowel. The table keeps the plain word
(lowercase, no yo) and the index of its stressed letter. What it leaves out on purpose, because a wrong mark is worse than none:
  * a word with yo (yo is always stressed, the model reads it as it is) and a word with one vowel (nothing to choose);
  * a word with two different stresses in the data (goroda is gorodA as a plural and gOroda as a genitive; the table cannot know which one the line means).
    `--ambiguous first` keeps the first one in the data instead (the more frequent lemmas come first in the files);
  * a form with a secondary stress, Latin look-alike letters, digits, hyphens or notes ("_ustar._"): not a plain Russian word.

    python packaging/build-russian-stress.py --download <cache folder> --out packaging/russian-stress/stress-ru.bin [--ambiguous skip|first] [--source-info <json>]
    python packaging/build-russian-stress.py --source <folder with the four csv files> --out <file>
    python packaging/build-russian-stress.py --download <cache folder> --check packaging/russian-stress/stress-ru.bin

`--download` fetches the four files (and the licence text) from the pinned commit into the cache folder when they are not there yet, and checks each
against the SHA-256 pinned below. `--check <file>` rebuilds the table and compares the words and stresses (the digest of the uncompressed payload) with
the file, so a different zlib cannot make a false difference; it exits 1 when they differ. The output is deterministic.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from russian_stress import VOWELS, StressDictionary, encode_dictionary, payload_digest  # noqa: E402

SOURCE = {
    "name": "openrussian.org dictionary data",
    "repository": "https://github.com/Badestrand/russian-dictionary",
    "commit": "50e210c4803237779cb562bc1abcea529066031c",
    "license": "CC-BY-SA-4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
    "website": "https://en.openrussian.org",
    "files": {
        "nouns.csv": "c388f9e6dde51932832be8d7e9afdbe9f0acee72fcf70677f0fe25ea61293c84",
        "verbs.csv": "8659de6799b949fb35f080b08088fb7d347ed300490954ebb380a31642646e1d",
        "adjectives.csv": "89ab5d10dcd2f21f6b485de704aef372f32251468e3aa96f18b21e259f26b80a",
        "others.csv": "9f22a16b17fc9a564298112168b667fced11aafb254ccebf5b7544fc37cdaa92",
        "LICENSE": "7abe19ec9bb73b36141b999b861d24ad855e808bafe0f81e84cce28556f6c297",
    },
}
RAW = "https://raw.githubusercontent.com/Badestrand/russian-dictionary/{commit}/{name}"
# Columns that are not Russian word forms.
NOT_FORMS = {"bare", "translations_en", "translations_de", "gender", "partner", "animate", "indeclinable", "sg_only", "pl_only", "aspect"}
SEPARATORS = re.compile(r"[,;/\s]+")
STRESSED = re.compile(r"[а-яё]+'?[а-яё]*")


def stressed_forms(field):
    """(plain word, index of the stressed letter) for each usable word form in one field. A field holds one or several forms ("ра'за, ра'зу",
    "жи'ло,жило'", "уда'лось//удало'сь") and an optional leading "*"."""
    if not field:
        return
    for token in SEPARATORS.split(field.strip().lower()):
        token = token.strip("*")
        if token.count("'") != 1 or not re.fullmatch("[а-яё']+", token):
            continue
        mark = token.index("'")
        word = token.replace("'", "")
        if "ё" in word or mark < 1 or word[mark - 1] not in VOWELS or sum(letter in VOWELS for letter in word) < 2:
            continue
        yield word, mark - 1


def read_rows(path):
    csv.field_size_limit(1 << 30)
    with open(path, encoding="utf-8", newline="") as stream:
        yield from csv.DictReader(stream, delimiter="\t", quoting=csv.QUOTE_NONE)


def collect(folder, ambiguous="skip"):
    """{word: index} from the four files in `folder`, and the counts the source record keeps."""
    if ambiguous not in ("skip", "first"):
        raise ValueError("ambiguous is skip or first")
    first, conflicts, forms = {}, set(), 0
    for name in ("nouns.csv", "verbs.csv", "adjectives.csv", "others.csv"):
        for row in read_rows(Path(folder) / name):
            for column, field in row.items():
                if column is None or column in NOT_FORMS:
                    continue
                for word, index in stressed_forms(field):
                    forms += 1
                    if word not in first:
                        first[word] = index
                    elif first[word] != index:
                        conflicts.add(word)
    entries = dict(first)
    if ambiguous == "skip":
        for word in conflicts:
            del entries[word]
    return entries, {"forms": forms, "words": len(first), "ambiguous": len(conflicts), "entries": len(entries), "ambiguousPolicy": ambiguous}


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def download(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for name, expected in SOURCE["files"].items():
        target = folder / name
        if target.is_file() and sha256_of(target) == expected:
            continue
        url = RAW.format(commit=SOURCE["commit"], name=name)
        with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 - a fixed https URL at a pinned commit
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit(f"{name} from {url} is not the pinned file")
        target.write_bytes(data)


def verify_sources(folder):
    for name, expected in SOURCE["files"].items():
        path = Path(folder) / name
        if not path.is_file():
            raise SystemExit(f"{path} is missing (use --download)")
        if sha256_of(path) != expected:
            raise SystemExit(f"{path} is not the pinned file (SHA-256 differs)")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--source", help="a folder with nouns.csv, verbs.csv, adjectives.csv, others.csv and LICENSE of the pinned commit")
    parser.add_argument("--download", help="a cache folder: the pinned files are fetched into it when missing, and it is used as the source")
    parser.add_argument("--out", help="the table file to write")
    parser.add_argument("--check", help="compare a freshly built table with this file")
    parser.add_argument("--ambiguous", choices=("skip", "first"), default="skip")
    parser.add_argument("--source-info", help="write the source record (commit, licence, hashes, counts) to this JSON file")
    options = parser.parse_args(argv)
    if bool(options.source) == bool(options.download):
        parser.error("give exactly one of --source and --download")
    if not (options.out or options.check):
        parser.error("give --out or --check")
    folder = Path(options.download or options.source)
    if options.download:
        download(folder)
    verify_sources(folder)
    entries, counts = collect(folder, options.ambiguous)
    data = encode_dictionary(entries)
    digest = payload_digest(data)
    record = {"version": 1, "format": "AINPCRS1", "source": {key: SOURCE[key] for key in ("name", "repository", "commit", "license", "licenseUrl", "website", "files")},
              "counts": counts, "payloadSha256": digest, "bytes": len(data), "file": "stress-ru.bin"}
    if options.check:
        current = StressDictionary.from_bytes(Path(options.check).read_bytes())
        same = payload_digest(Path(options.check).read_bytes()) == digest and len(current) == len(entries)
        print(("same words and stresses as " if same else "DIFFERENT from ") + options.check)
        if not same:
            return 1
    if options.out:
        out = Path(options.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"{out}: {len(entries)} words, {len(data)} bytes, payload sha256 {digest}")
    if options.source_info:
        Path(options.source_info).write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
