"""Subtitle text of a game line in any language (the transcripts of a voice language pack).

The English subtitle index (the installed game's localization lookup.sqlite3) tells which subtitle file holds a string id; the same
file in lang_<lang>_text.archive (read from the game's archive folder, read-only) holds the line in the other language. The files are
read with the project's own CR2W/archive reader (scripts/Extract-VoiceReferences.py): no WolvenKit, no hash list needed.
"""
from __future__ import annotations

import importlib.util
import re
import shutil
import sys
from pathlib import Path

import vp_common as vp

_extract = None


def extract_module():
    global _extract
    if _extract is None:
        spec = importlib.util.spec_from_file_location("voice_extract", vp.ROOT / "scripts/Extract-VoiceReferences.py")
        module = importlib.util.module_from_spec(spec)
        previous = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec.loader.exec_module(module)
        finally:
            sys.dont_write_bytecode = previous
        _extract = module
    return _extract


TAG = re.compile(r"<[^>]+>")
# A character speaks a few words of his own language inside a line: <mothertongue l="mex" m="No, mijo" b="..." a="(translation) rest of the line"/>.
# What is said is b + m + a; the parenthesised gloss at the start of a is the subtitle's translation of m, not spoken.
MOTHERTONGUE = re.compile(r"<mothertongue\s[^>]*?\bm=\"(?P<m>[^\"]*)\"\s+b=\"(?P<b>[^\"]*)\"\s+a=\"(?P<a>[^\"]*)\"\s*/?>")
GLOSS = re.compile(r"^\s*[（(][^）)]*[）)]")


def clean(text: str) -> str:
    """One line of plain text: markup tags dropped, line breaks and runs of spaces collapsed, typographic apostrophes kept."""
    text = MOTHERTONGUE.sub(lambda m: f"{m['b']}{m['m']}{GLOSS.sub('', m['a'])}", text or "")
    text = TAG.sub("", text)
    text = text.replace("\r", " ").replace("\n", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


class Subtitles:
    def __init__(self, lang: str):
        ext = extract_module()
        self.lang = lang
        self.locale = vp.LANGUAGES[lang]["locale"]
        dll = vp.WORK / "tools/oo2ext_7_win64.dll"
        if not dll.is_file():
            dll.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(vp.OODLE, dll)
        self.oodle = ext.Oodle(dll)
        archive = vp.LANGUAGES[lang]["archive"]
        self.archives = [ext.Archive(vp.GAME, f"archive/pc/{sub}/lang_{archive}_text.archive") for sub in ("content", "ep1")
                         if (vp.GAME / f"archive/pc/{sub}/lang_{archive}_text.archive").is_file()]
        self.files = {}             # depot path -> bytes | None
        self.english = {}

    def _read(self, depot: str):
        if depot not in self.files:
            self.files[depot] = None
            for archive in self.archives:
                found = archive.read(depot, self.oodle)
                if found:
                    self.files[depot] = found[0]
                    break
        return self.files[depot]

    def prefetch_english(self, string_ids: list[str]) -> None:
        todo = [s for s in string_ids if s not in self.english]
        if todo:
            self.english.update(vp.english_subtitle_files(todo))

    def text(self, string_id: str, fm: str) -> tuple[str, str]:
        """(text, note) for a string id; the female variant for an 'f' voice file, the male one for 'm' (the other when that is empty).
        note is '' when fine, else why the text is missing."""
        ext = extract_module()
        self.prefetch_english([string_id])
        rows = self.english.get(string_id)
        if not rows:
            return "", "no English subtitle row"
        order = ("femaleVariant", "maleVariant") if fm == "f" else ("maleVariant", "femaleVariant")
        for row in rows:
            depot = row["depot"].replace("en-us", self.locale)
            data = self._read(depot)
            if data is None:
                continue
            variants = {}
            for variant in order:
                try:
                    found = ext.local_subtitle(data, string_id, variant)
                except ValueError:
                    continue
                if found:
                    variants = found[1]["variants"]
                    break
            for variant in order:
                text = clean(variants.get(variant, ""))
                if text:
                    return text, ""
        return "", f"no {self.locale} subtitle for the line"
