"""Read CName flats (voiceTag, audioResourceName, appearanceName, ...) of Character records straight from the game's tweakdb.bin and tweakdb_ep1.bin.

    from tweakdb_read import TweakDB
    db = TweakDB(Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
    db.cname("Character.Tom", "voiceTag")        # 'tom'

The files are read only.  Layout (blob version 8, checked against the game's own tweak sources):
  header 0x20 bytes: magic, blob version, parser version, checksum, flats offset, records offset, queries offset, group tags offset (u32 each)
  at the flats offset: u32 number of flat types, then per type (20 bytes) u64 FNV-1a 64 hash of the type name, u32 value count, u32 key count, u32 absolute offset of its block
  a block: u32 value count, the values, u32 key count, then keys of 12 bytes: u32 CRC-32 of the flat name `Record.flat`, u32 length of that name, u32 index of the value.
  CName and String values are strings with REDengine's variable length prefix (bit 7 utf-8, bit 6 more bytes, 6 low bits then 7 bits each).
Only the CName block is read here, which is all the voice mapping needs.  The value `None` means the flat is set but empty.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

FILES = ("tweakdb.bin", "tweakdb_ep1.bin")


def fnv1a64(text: str) -> int:
    value = 0xCBF29CE484222325
    for byte in text.encode():
        value = ((value ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


class Blob:
    def __init__(self, path: Path):
        self.data = path.read_bytes()
        flats = struct.unpack_from("<I", self.data, 16)[0]
        count = struct.unpack_from("<I", self.data, flats)[0]
        self.types = {}
        for i in range(count):
            type_hash, values, keys, offset = struct.unpack_from("<QIII", self.data, flats + 4 + i * 20)
            self.types[type_hash] = (values, keys, offset)
        self._strings: dict[str, tuple[list[str], dict]] = {}

    def strings(self, type_name: str):
        """(values, {(crc, length): index}) of the CName or String block."""
        if type_name not in self._strings:
            _values, _keys, offset = self.types[fnv1a64(type_name)]
            data = self.data
            n = struct.unpack_from("<I", data, offset)[0]
            pos = offset + 4
            values = []
            for _ in range(n):
                first = data[pos]
                pos += 1
                length, more, shift = first & 0x3F, bool(first & 0x40), 6
                while more:
                    nxt = data[pos]
                    pos += 1
                    length |= (nxt & 0x7F) << shift
                    shift += 7
                    more = bool(nxt & 0x80)
                values.append(data[pos:pos + length].decode("utf-8", "replace"))
                pos += length
            key_count = struct.unpack_from("<I", data, pos)[0]
            pos += 4
            keys = {}
            for i in range(key_count):
                crc, length, index = struct.unpack_from("<III", data, pos + i * 12)
                keys[(crc, length)] = index
            self._strings[type_name] = (values, keys)
        return self._strings[type_name]


class TweakDB:
    def __init__(self, game: Path):
        self.blobs = [Blob(game / "r6/cache" / name) for name in FILES if (game / "r6/cache" / name).is_file()]

    def cname(self, record: str, flat: str) -> str | None:
        """Value of `record.flat` as a CName (the later blob, Phantom Liberty, wins), or None when the flat is not there."""
        name = f"{record}.{flat}".encode("ascii")
        key = (zlib.crc32(name) & 0xFFFFFFFF, len(name))
        found = None
        for blob in self.blobs:
            values, keys = blob.strings("CName")
            if key in keys:
                found = values[keys[key]]
        return found
