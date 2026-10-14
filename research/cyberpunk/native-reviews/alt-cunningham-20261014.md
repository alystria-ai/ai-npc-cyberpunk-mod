# Alt Cunningham: native claims pack and audience rules (2026-10-14)

Pack: `research/cyberpunk/native-character-claims/alt-cunningham.json` (16 claims: 9 public, 5 private, 2 conditional; 6 cadence examples).
Rules: `research/cyberpunk/native-rules/alt-cunningham-20261014.json` (lane `cyberpunk-native-alt-cunningham-20261014`, rule `alt-cunningham.nomad.met-v`) and an audience change to `priority-endings.johnny.transmission-alt` in `priority-endings-20261004.json`.
Compiler ledger: `REVIEWED_INTRINSIC_SUBJECT_BINDINGS['alt-cunningham']` in `research/cyberpunk/scripts/intrinsic_character_claims.mjs`.

## Evidence
- Archive winners were chosen with `scripts/Extract-VoiceReferences.py` (Archive, Oodle, depot hash), and each file was serialized with the pinned WolvenKit CLI 9.0.1 (sha256 7ae9c308...) in the batch `research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/` (receipt, raw files, serialize logs; outside git, in the offload cache).
- Her scenes: `q110_14_alt` (Transmission), `q114_03d_alt_meeting` (nomad meeting), `q115_03a_alt` (Mikoshi plan); journal codex entry `alt_cunningham` and its English strings.
- Alt's voicetag is 1103967280742240264. Every self-report claim cites the line, the single `scnDialogLineEvent` and the speaker/actor pointers.
- `q108_04_exit` (Alt leaving Johnny after a concert) is Johnny's represented memory, so it supplies no claim.

## Independent review (Sonnet helper, own verifier, no reuse of the author's)
- A. Mechanical: PASS, 0 problems. All source hashes, 1108 refs (before the edits below), speaker and voicetag bindings, event uniqueness, the English variant text against the shipped subtitles, the codex strings and the ledger entry were rechecked.
- C. Compile: PASS. Six mutations (wrong voicetag, wrong actor, Johnny's line swapped in, another codex subject, an uncited line, voicetag 0) all throw. Limit: the compiler verifies only the public claims; the private and conditional claims are covered by the helper's verifier.
- B. Semantics: 3 defects and 7 smaller points; all applied and re-verified (0 problems, 493 refs on the compiled public claims, 1050 refs in the pack):
  1. `self.uncertainty-not-fear` merged two variants gated by `q108_04_alt_harsh`; the text now says the answer depends on an earlier flashback, with a limit against combining them.
  2. `self.netwatch-propaganda` implied a meeting with V and used a branch-only line (`q110_08a_netwatch_deal`); that clause and line 118 were dropped.
  3. `self.not-immortal-and-dreams` limits asserted a conversation with V and the quote lost its "we"; both fixed.
  4. to 6. Cadence examples `soulkiller`, `identity`, `uncertainty`, `mortality` made unsupported or near-verbatim statements; rewritten.
  7. The exclusion claimed no game phrases are kept; it now says short phrases are retained for fidelity.
  8. `conditional.nomad-meeting`: "back door" came from an uncited line; now "passage" (cited line 33), the debate answer is attributed to V's question, and the context names `alt-cunningham.nomad.met-v`.
  9. `mikoshi.integrate-the-constructs`: a limit notes that the q115 lines are variant-gated and the q114 lines carry the claim.
  10. `self.human-alt-is-gone` no longer cites the later Johnny exchange; `johnny.his-own-making` no longer dates the event.
- Judgement calls kept: `self.black-ice-no-cage` stays public (her own statement about Mikoshi's defenses, not the Mikoshi plan).

## Audience rules
- `alt-cunningham.nomad.met-v`: speaker and recipient `alt-cunningham`, participant, private and phone; fires only when `al5.initiation.dakota-carol-wrap` and `al5.initiation.talk-alt` have both succeeded (the same predicate as the reviewed `al5.together.alt-link`, with its source and journal evidence rows copied from `aldecaldos-20261005.json`).
- `priority-endings.johnny.transmission-alt` now lists `alt-cunningham` as speaker and recipient. The affected rules use exact catalog topics, so no `native-topic-aliases.json` hash changes.

## Adoption and pin
- Hash pin `alt-cunningham` in `bridge/intrinsic-character-context.mjs` (canonical sha256 af787690..., LF raw sha256 9ea1b151...) with curated topics; the two conditional claims are not selectable.
- Profile adopted (`nativeIntrinsicProfiles`), first-person rewrite redone for the new text, roster row and `profile-text` regenerated; no other roster row changed.

## Not done
- The Convai re-provision of her profile and twin (needs approval; see TODO.md). No live call was made.
