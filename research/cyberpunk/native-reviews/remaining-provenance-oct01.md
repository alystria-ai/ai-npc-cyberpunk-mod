# Remaining native pack provenance audit — 1 October 2026

## Scope and initial result

This audit covers `aldecaldos`, `arasaka-heist`, `city-contacts`, `core-arcs`,
`fixers`, `heywood`, and `judy-river`. Silverhand and Phantom Liberty are
reviewed by separate owners. No runtime knowledge pack, game installation,
Convai character, player memory, or generated compiler output is changed here.

| Pack | All cited pointers | Legacy unbound pointers | Legacy file uses in pack |
| --- | ---: | ---: | ---: |
| Aldecaldos | 508 | 227 | 40 |
| Arasaka / Heist | 148 | 148 | 25 |
| City contacts | 117 | 117 | 35 |
| Core relationship arcs | 88 | 88 | 5 |
| Fixers | 955 | 955 | 68 |
| Heywood | 777 | 777 | 41 |
| Judy / River | 377 | 221 | 35 |
| Total | 2,970 | 2,533 | 249 |

Shared citations reduce the legacy source set to **215 distinct files**, with
60,639,818 raw bytes and 531,460,695 decoded JSON bytes. All 2,970 existing
pointers resolve and match their declared types and expected values in the
cached documents. That read-only result authenticates neither the old decoded
exports nor the authored narrative interpretation.

## Integrity gap found

The compiler's initial `verifyNativeEvidence` implementation checks
`expectedType` and `expectedValue`, but does not check the legacy `expected`
map of relative JSON pointers. Those maps assert **126 nested fields** in
79 references: 86 fields / 58 references in Aldecaldos, and 40 / 21 in core
relationship arcs. The separate `review_native_rules.mjs verify` command checks
them. The central compiler needs the same enforcement; merely recording a JSON
hash does not replace an asserted field check.

## Authentication method

The one-run helper is isolated at
`runtime/native-provenance-remaining/authenticate_pack.py` (ignored evidence).
For each remaining legacy source it:

1. Resolves its exact path hash against the currently installed base and EP1
   RDAR indexes, respecting the pinned serializer's first matching archive-row
   behavior and EP1 winner precedence. English localization resources use their
   corresponding language archives.
2. Checks that the previously cached raw resource has the **current winner's
   decoded byte count and archive SHA-1**, and the authored binary SHA-256.
   Copying that verified binary is recorded as a copy, not claimed as a new
   extraction from compressed archive data.
3. Freshly serializes the verified raw copy using the pinned WolvenKit CLI
   9.0.1 and contained .NET runtime. The executable's SHA-256 is checked before
   execution. Its source-file header must point to the copied raw resource.
4. Compares canonical hashes of the **entire `Data` payload** in the old and
   new exports, excluding the serializer's volatile `Header`. Any mismatch
   aborts that pack's migration. Each cited pointer, node type, exact value,
   and nested relative expected field is checked again in the fresh export.
5. Records the new exact JSON byte hash in a separate per-pack inventory at
   `cache/game/scene-evidence/<part>-authenticated-oct01/`, then updates only
   that pack's verified legacy references to the fresh path and hash.

Archive/index and serializer work use the same two-slot OS byte locks as voice
casting, with a separate `knowledge-<part>` lock for output ownership. The
helper checks that the source pack's hash has not changed before replacing it.
Previously hash-bound references are checked too. It never retroactively
declares the original JSON bytes authenticated merely because a hash can now
be calculated for them.

## Migration status

Fresh serialization resumed after the casting queue cleared, with the CPU
slot acquired and released for each individual serialization, and released
before Data/pointer checking.

All seven packs completed. **2,533 legacy references** now cite newly
authenticated exports. There are **249 per-pack fresh resources** (215 distinct
original legacy files, with shared resources independently authenticated in
their separate packs). All **2,970 cited pointers** are now JSON hash-bound.
The final independent byte-hash check covers **299 current referenced JSON
files**, including the existing hash-bound exports, with **zero legacy
pointers and zero mismatched hashes**.

| Pack | Fresh resources | All pointers rechecked | Final revision |
| --- | ---: | ---: | ---: |
| Aldecaldos | 40 | 508 | 3 |
| Arasaka / Heist | 25 | 148 | 2 |
| City contacts | 35 | 117 | 2 |
| Core relationship arcs | 5 | 88 | 2 |
| Fixers | 68 | 955 | 2 |
| Heywood | 41 | 777 | 2 |
| Judy / River | 35 | 377 | 3 |
| Total | 249 | 2,970 | — |

Every pack passes the read-only `review_native_rules.mjs verify` command. No
authored rule condition, outcome, narrative text, actor scope, or expected
field was changed by authentication. The shared strict compiler build and
runtime installation remain the root owner's responsibility. No gameplay
acceptance or complete narrative coverage is implied.

Per-pack receipts are in `cache/game/scene-evidence/<part>-authenticated-oct01/`
(`inventory.json`, `authentication-report.json`, raw binary copies, fresh
exports, and serializer logs). The ignored aggregate receipt is
`runtime/native-provenance-remaining/final-report.json`.

The central compiler's relative `expected` enforcement was fixed in local
commit `4c42f09`, with 9 focused regression checks reported by its owner.

### Large cooked journal bound

One fresh cooked journal export contains **71,517,092 JSON bytes**; absolute
source-file header paths produce small byte-count differences between packs.
The initial shared casting helper's 64 MiB document bound rejected it in City
contacts, Aldecaldos, and Fixers. Each source pack remained unchanged at that
failure. The knowledge
audit helper now uses the knowledge compiler's existing **128 MiB** artifact
limit; the independent casting tool retains its 64 MiB limit.

The failed, unbound output is preserved under each audit directory's
`failed-unbound-exports/`, with an `orphan-preservation.json` receipt. It is
excluded from the inventory's authenticated source set. Recovery generates a
new serialization of the already verified raw binary at the intended source
path, then compares full Data and records that new output's hash. The failed
file is not promoted by merely calculating a hash for it.

All three recoveries passed fresh full Data equivalence and pointer checks.

Historical native source-description `jsonPath` locators outside the evidence
references remain preserved. They are research locators, not part of the
strict cited-pointer qualification count. Executable provenance references
move to fresh authenticated exports; original cached documents are retained.
