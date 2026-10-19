# Cast expansion recipe

How one new talkable character is added end to end: game lines, a scene-level identity check, voice references for Pocket,
OmniVoice and Voxtral, a dossier and first-person profile, an appearance description, a knowledge audience, a Convai
character and its multilingual twin, and the release lists. Proven on Bryce Mosley on 2026-10-18 (worked example below).

Every step writes either to a per-character staging folder (`staging/cast/<key>/`, ignored by git) or, for the shared files,
through one merge script that the lead runs serially. That lets many helpers work on different characters at the same time
without touching the same file.

Tools: `scripts/clip-search/cast-expansion/` (each file has a docstring with its usage).

| Step | Command | Writes | Who |
|---|---|---|---|
| 1 Survey | `python survey.py --prefix <stem> --record Character.<X> --key <key> --top 5` | `survey.json` | Haiku or Sonnet |
| 2 Attribute | `python attribute.py --key <key> --prefix <stem> --token "<quest>\scenes" --export` | `attribution.json` | Sonnet (judgement) |
| 3 Voice spec | hand-written `voice-spec.json` (accepted scene actors, identity reasoning) | `voice-spec.json` | Sonnet |
| 4 Clips | `python extract.py --key <key>`; `<VS> analyze.py --key <key>`; `<VS> build.py --key <key> [--dry-run]` | WORK clips, `analysis.json`, reference WAVs, `voice-rows.json` | Haiku with this recipe |
| 5 Dossier | hand-written `dossier.json` (third person) and `roster-base.json` | staging | Sonnet |
| 6 Appearance | fandom API image, then `appearance.json` | staging | Haiku |
| 7 Profile | `node profile_stage.mjs build <key>`, rewrite `first-person/output.json`, `node profile_stage.mjs finish <key>` | `row.json`, store, profile text | Haiku writes, the checker and the lead review |
| 8 Merge | `node merge.mjs profiles|knowledge|release-plan --keys ...`; `node merge_rows.mjs --keys ...`; `node scripts/Build-FacialGraphs.mjs --reds` | shared files | lead only |
| 9 Convai | `node scripts/Provision-Characters.mjs [--apply] --only <keys>`, then `node scripts/Create-MultilingualProfiles.mjs [--apply] --roster named --only <keys>` | `runtime/characters.json`, `runtime/multilingual-profiles.json` | lead only, user-approved |
| 10 Release data | `node packaging/Refresh-ReleaseData.mjs` | `packaging/release-data/` | lead |
| 11 Tests | `node scripts/run-tests.mjs` | | lead |

`<VS>` is the Python with torch, torchaudio, soundfile and transformers:
`"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\vendor\reference-voicestudio\.venv\Scripts\python.exe"`. `survey.py`,
`attribute.py` and `extract.py` also run on the plain Python 3.12. Decoded clips go to
`E:\CyberpunkConvai-offload\work\clip-search\cast-expansion\<key>\` (game dialogue never enters the repo); references go to
`runtime/voice-references/picked/autobest/<omni-short|omni-long|pocket>/<key>.wav` (git-ignored).

## 1. Voice files and record

A voice file is `base\localization\en-us\vo\<stem>_<f|m>_<16 hex>.wem` (or the `ep1` equivalent). The hex is the subtitle
string id in decimal. `_f_`/`_m_` is V's gender variant of the line, not the speaker's gender; `vo_holocall`, `vo_helmet`
and `vo_radio` copies are processed deliveries and are counted but never used. Find stems in
`runtime/voice-cast-inventory-20261001/{base,ep1}-wem-paths.txt`:

```
grep -io 'vo\\[a-z0-9_]*_[fm]_' base-wem-paths.txt | sed -E 's/_[fm]_$//' | sort | uniq -c | sort -rn
```

A named character usually has a stem of their own (`bryce_mosley_q110`). `civ_*` and `gang_*` stems are shared civilian
models: such a line counts only when a scene actor that is the character speaks it (Rita Wheeler's `civ_prnd_f_01` lines,
2026-10-18).

`survey.py` reads the WEM headers for seconds (nothing is decoded) and checks record names in the installed `tweakdb.bin`
and `tweakdb_ep1.bin` by CRC32 plus name length. A hit shows the record exists, not that it is the body in a scene; a scene
actor's non-zero `specCharacterRecordId` can be matched with `cx_common.tweakdb_u64(name)`. Records prefixed `q###_`,
`sq###_` or `mq###_` are story actors to the mod (`mod/character-catalog.lua` `storyRecord`).

## 2. Scene-level identity

`attribute.py` finds every scene referenced by quest phases (`research/cyberpunk/cache/game/index/resources.jsonl`) whose path
contains a token, reuses cached WolvenKit exports and exports the rest (`--export`, batches of 32 through
`research/cyberpunk/scripts/extract_scene_evidence.py`). For each scene it lists the actors that speak the stem's lines:
actor name, community entry, voicetag id, record and matched/total lines. A few referenced scenes missing from the archive
are normal (the exporter reports them).

Accept a scene actor only when the actor is the character: the actor name or community entry is theirs, or the scene is
their known scene and every one of the actor's lines is in their own stem. Never accept a voice tag alone. Lines that no
exported scene contains are left out. Write the decision in `voice-spec.json`:

```json
{"key": "bryce-mosley", "name": "Bryce Mosley", "prefixes": ["bryce_mosley"], "records": ["Character.q110_netwatch_agent"],
 "accept": [{"scene": "base\\quest\\main_quests\\part1\\q110\\scenes\\q110_08a_agent.scene", "actorName": "agent"}, ...],
 "exclude": [], "prefer": [],
 "identity": "Scene q110_08a_agent: actor 1 'agent', voicetag 1666363181854904320, speaks 69 lines, all in bryce_mosley_q110_* ..."}
```

## 3. Clips and references

- `extract.py` takes the accepted lines of 1.5 to 9.5 s with at least three words, longest first (default 60), copies them out
  of the archives (SHA-1 checked), decodes with vgmstream and writes the subtitle as the transcript.
- `analyze.py` measures each clip (duration, peak, clipped samples, gated loudness, silence ratio, noise floor, high-band
  energy relative to the phone band, pitch), a WavLM base-plus-sv x-vector "typicality" (mean cosine to the other clips; the
  ECAPA weights of the 2026-10-13 recipe are no longer on disk and fetching them needs approval) and a Whisper small.en
  transcript against the subtitle. CPU only, low priority; about 2 minutes for 40 clips.
- `build.py` picks by fixed rules: 1.5 to 9 s, at least three words, no clipping, peak at most -3 dBFS (relaxed to -1.5 only
  when the pool would hold under 12 s), gated loudness within 2 dB of the set median, Whisper similarity at least 0.85,
  typicality at least the median minus 0.03, silence ratio at most 0.45; score = typicality + 0.05 x Whisper + 0.004 x seconds.
  Short: best clips while the joined length stays within 10 s (at least 7 s, or the character is voice-thin). Long: the short
  clips plus the next best within 18 s. Pocket uses the long set. Whole clips in string-id order, 0.4 s gaps, mono 24 kHz,
  16-bit PCM, no EQ, denoise or gain (`scripts/clip-search/common.py build_reference`). It refuses to overwrite an existing
  reference without `--replace` and writes the three config rows to `staging/cast/<key>/voice-rows.json`.
- `merge_rows.mjs --keys a,b [--replace x]` (lead only) checks each WAV and transcript against its row, backs up the three
  live configs to `runtime/backups/cast-expansion-<stamp>/`, writes the rows into `pocket-voices.autobest.json`,
  `local-voices.autobest-short.json` and `local-voices.autobest-long.json` (the files `runtime/voice-configs.json` names;
  Voxtral reads the Omni long set first, then Pocket) and runs the bridge's own loaders (Node Pocket validator and Omni
  registry, Python Pocket loader).
- Re-running `scripts/Build-AutobestConfigs.mjs` would reset hand-added rows to `unprepared` for characters the picker pool
  does not cover; re-apply them with `merge_rows.mjs --replace <keys>` afterwards (the staged rows stay in `staging/cast`).

## 4. Dossier and roster base

`staging/cast/<key>/dossier.json` has the shape of `research/cyberpunk/dossiers/*.json` (third person; validated by
`validateResearch` in `research/cyberpunk/scripts/build_research.mjs`):

- `profile.backstory` (who they are, what they believe, how they treat V; no invented history), `publicSummary`,
  `speakingStyleDescription` ("Editorial guidance: ..."), at least six ORIGINAL sample lines (never quotations from the game).
- `intrinsicClaims` with sources and confidence (`corroborated`, `source-supported`, `uncertain`).
- `relationships`: `withKey` is a roster key for roster characters, otherwise a plain name. `changes` and
  `knowledge.conditional` cite real decisions of `research/cyberpunk/quest-maps/*.json` (`decisionId`, `questKey`,
  `outcomeKey` must exist there; the validator checks it).
- `knowledge.background`, `private`, `unknown` (limits: what they cannot know), `conditional`.
- `uncertainties`: how a story character is marked. Always say when the character dies on a branch or exists in one quest
  only, and that a copy summoned by the mod establishes no survival, deal or meeting (Alt's and Jackie's rows do the same).
- `sources`: https URLs with title, locator and notes. Fandom pages answer HTTP 402 to a direct fetch; the MediaWiki API works:
  `curl -s -A "Mozilla/5.0" "https://cyberpunk.fandom.com/api.php?action=parse&page=<Title>&prop=wikitext&format=json"`.
  Cite the canonical page URL with the note "read through the MediaWiki API".

`roster-base.json`: `key`, `name`, `gender`, `aliases` (full names only), `records` (the body record first: the Companion
Manager registers `records[0]` as the invitable copy), `voice` and `voiceName` (a Kokoro voice from
`characters/kokoro-voices.json`, matched on gender, age and manner to the roster's existing choices), `model`
(`fast-gemma-4-31b-it`), `twinVoice`, `twinVoiceName`, `twinReason` (an Azure multilingual voice from
`characters/multilingual-voice-map.json` `voices`, same gender) and `storyFlags` (for the report only).

## 5. Appearance

Same style as `characters/appearance.json`: two to four second-person sentences ("You have ...", "You wear ..."), only
what is visible in a full-body or portrait picture; no pose, action, lighting or lore. Picture: the infobox image URL from
`https://cyberpunk.fandom.com/api.php?action=query&prop=pageimages&titles=<Title>&piprop=original&format=json`; fetch it
with WebFetch (it saves the binary), convert the webp with `C:\ffmpeg\bin\ffmpeg.exe -i <file> <scratchpad>\<key>.png` and
look at the PNG. `source` is the wiki page, `image` is `appearance-images/<key>.webp` (the folder convention; the folder
itself is not in the repo). Phone-only voices with no model keep `{"text": "", "source": "none"}`.

## 6. First-person profile

`node profile_stage.mjs build <key>` validates the dossier against the quest maps and builds the third-person row exactly as
`buildProfiles` does, then writes `first-person/input.json` (the repo's `makeInput`: numbered lines by kind). The rewrite
(`first-person/output.json`, same ids and order, one line each) turns the speaker into "I/my/me", keeps every name and
number, keeps `Scope: ` and `<relationship>: ` labels, keeps length within 0.8 to 1.25, and opens with "I'm <Name>".
`node profile_stage.mjs check <key>` runs the repo's checker; structural problems must be fixed, pronoun and name flags are
read line by line (a "him" about someone else is fine). `finish` builds the final row (opens with "I'm"), the store entry
and the profile text.

## 7. Merge (lead only, serially)

```
node merge.mjs profiles --keys a,b        # roster, profile plan, profile text, first-person store, appearance, dossier,
                                          # build report, coverage counts, twin voice assignment (all appended)
node merge.mjs knowledge --keys a,b       # world-knowledge profileKeys, both copies
node merge_rows.mjs --keys a,b            # voice rows into the three live configs, with backup and loader checks
node merge.mjs release-plan --keys a,b    # voice.localProfiles (sorted), preparedLocalProfiles, fallbackProfiles
node scripts/Build-FacialGraphs.mjs --reds   # FaceFeature.reds NamedRecords follows the roster records
```

Then bump the count pins in `bridge/first-person-profiles.test.mjs` and the batch list in `bridge/cast-expansion.test.mjs`.

## 8. Convai (lead only, approved by the user for the batch)

```
node scripts/Provision-Characters.mjs --only a,b               # plan: payload validated, no remote call
node scripts/Provision-Characters.mjs --apply --only a,b       # create + readback; IDs into runtime/characters.json
node scripts/Create-MultilingualProfiles.mjs --roster named --only a,b           # plan (needs the original IDs)
node scripts/Create-MultilingualProfiles.mjs --apply --roster named --only a,b   # create twin + readback
node packaging/Refresh-ReleaseData.mjs                         # IDs into packaging/release-data/
```

Never print the key file. `--only` must list only new keys; existing characters are not touched. The twin's "Only reply in
the selected languages" box is set in a signed-in Convai dashboard session (the Core API ignores it); after that, the main
session records `languageBoxOff: true`. Until then the twin is listed as awaiting the language box and the router keeps
using the original.

## 9. Bucket upload (user-approved, main session)

Per character: the three WAVs to `final/voice-references/picked/autobest/{omni-short,omni-long,pocket}/<key>.wav`, and once
per batch the three config files to `final/voice-configs/`.

## Story characters

Characters the game placed (story or not) get talk plus face and audio only in the world; the guard refuses talk while the
game controls them (scene, quest dialogue, combat, dead). A copy invited through the Companion Manager is our own copy with
the full systems, registered from the roster row's first record. A record with a quest prefix (`q110_netwatch_agent`) makes
the world body protected story; the invitable copy of such a record is untested until a live check.

## Worked example: Bryce Mosley (2026-10-18)

1. `survey.py --prefix bryce_mosley --record Character.q110_netwatch_agent --key bryce-mosley`: stem `bryce_mosley_q110`, 87
   files (86 `vo`, 1 holocall; 84 `_f_`, 3 `_m_`), 83 distinct lines, 82 with subtitles, 958 words, 6.2 minutes, 67 lines of
   3 to 9 s; record hash true in base and ep1 (`Character.Bryce` false).
2. `attribute.py --key bryce-mosley --prefix bryce_mosley --token "q110\scenes" --token q110_01_netwatch --export`: 31 scenes
   searched (3 referenced scenes are not in the archive); `q110_08a_agent` actor 1 `agent`, voicetag 1666363181854904320,
   69 of 69 lines; `q110_08b_truck` actor 2 `Agent`, same voicetag, 1 of 1. 70 of 83 lines attributed; 13 unused.
3. `extract.py --max 40`: 40 clips, mono 48 kHz, none clipped. `analyze.py`: gated loudness median -22.9 dB, WavLM typicality
   0.90 to 0.96 (median 0.944: one voice), Whisper 0.74 to 1.00.
4. `build.py`: pool 29 clips, 158 s. omni-short 8.37 s (one line), omni-long and Pocket 15.28 s (two lines). `merge_rows.mjs`:
   three configs at 259 entries; Python Pocket loader 258 ready, 1 unavailable (Lucy, no game voice).
5. Dossier from the wiki (MediaWiki API) and his 83 subtitle lines: NetWatch agent, the Grand Imperial Mall operation, the
   Animals and Sasquatch, Brigitte and Ti frozen, the deal; dies on the refusal branch, one quest only; the fan question
   about whether he is the real Mosley kept as uncertain. Kokoro voice Noah (Confident Adult American Male); twin voice
   Andrew.
6. Appearance from the infobox portrait (pinstriped shirt, blue-grey tie, NetWatch badge, plated facial cyberware).
7. `profile_stage.mjs`: 609-word row; one checker flag (a "him" about Placide, correct).
8. `merge.mjs profiles` appended row 81; `release-plan` 77 prepared, 4 fallback; `Build-FacialGraphs --reds` adds
   `Character.q110_netwatch_agent`; count pins 81.
9. `Provision-Characters.mjs --only bryce-mosley` (plan): 609 words, 1117 style characters, 783 sample characters, voice Noah,
   model fast-gemma-4-31b-it. The twin plan needs the original's ID, so it runs after the create.

## Briefing helpers

Pass the model-choice rule on: the cheapest model that clearly does the job well, set explicitly. Haiku for the mechanical
steps with this recipe and the Bryce example (survey of a given stem, extract/analyze/build, appearance from a picture,
first-person rewrite, knowledge-row drafts from a template); Sonnet for identity decisions, dossiers and anything
ambiguous. Each helper writes only to `staging/cast/<its keys>/`; the lead merges. Every brief also says: no `find /` or
whole-disk searches; stop every background command before finishing; never read, run or stage `scripts/Test-GameInput.ps1`;
never print key, token or auth files; no game launch, no live talk turns, no Convai calls; never mention AMM.

## Lessons from the 28-character batch (2026-10-19)

- `analyze.py` runs Whisper on a free GPU (over 2 GB free), else on the CPU. On the CPU with three helpers at once it took about
  15 minutes per character; on the GPU about one.
- Use the spec overrides instead of loosening rules. Use `exclude` for a clearly foreign line (Henry: one sq011 line at
  typicality 0.50 against a 0.90 median) or shouted outliers (Edgar Tool: five lines at 0.73 to 0.79). Use `prefer` when the
  greedy fill leaves the short set under 7 s although the pool is large (Maiko: a top clip of 6.08 s with nothing that fits
  beside it; Henry: 4 clips, 19 s). Each override carries an `excludeNote` or `preferNote`.
- The relaxed peak rule (-1.5 dBFS) applies when the -3 dBFS pool is under 12 s, even if the relaxed pool is large. Loud
  voices like Garry the Prophet's need it, and their clips still have no clipped samples.
- Mixed stems: the Cassel twins' `bella_*` and `theo_*` stems also hold Alex and V in disguise, so only the twin's own scene
  actors are accepted. Edgar Tool's lines are the TooLina persona and are voiced in a feminine register. He was first rostered
  FEMALE from the lines; the user then decided he is MALE (roster gender MALE). His voices stay feminine on purpose, and his
  twin-voice assignment carries `voiceGender: "FEMALE"` so the gender-match checks accept it.
- Twins are created with `languageBoxOff: false`; the dashboard step then sets the box and the main session records
  `languageBoxOff: true` (done for this batch on 2026-10-19). `bridge/cast-expansion-keys.mjs` lists the batch, and the
  twin-map test in `bridge/multilingual.test.mjs` requires the box to be off for every key in it.
- Ear check: `render_samples.py <lines.json> <out-dir>` loads OmniVoice once for the whole list. Score the renders with the
  same WavLM x-vector against every reference (own reference first is the expected rank) and with Whisper against the line.
  Flag any character whose own reference does not rank first.
- `merge.mjs knowledge` is not needed when the knowledge builder runs after the roster merge, because `profileKeys` follow
  the roster.

## Second batch (2026-10-19, branch `cast-batch-2`)

15 characters, listed in `bridge/cast-expansion-keys.mjs` as `CAST_EXPANSION_2_KEYS`: Steve Sanchez, Jeremiah Grayson, Aymeric Cassel,
Farida Nazeri, Brick, Patricia, Lucy Thackery, Mateo Thiago, Max Jones, Tiny Mike, Ziggy Q, Doctor Paradox, Leon Rinder, Albert Murphy
(voice stem `kruger`) and Carl Robinson ("Dodger"). They are the batch-1 leftovers with a scene-verified identity and enough audio, plus
three BARGHEST lieutenants from the Dogtown gigs. Held back: Hasan Demir and Pedro Aimar (voice and identity are clear, but no body record
was found: a few hundred `Character.*` names were hashed against both TweakDBs, nothing matched), Tom and Sasquatch (identity doubtful), Kirk
Sawyer, Barry Lewis and Mr. Blue Eyes (civilian stems: 77, 40 and 28 attributed lines of mostly shared models).

- **Profile limit.** There is none at 128. That number was `VOICE_PROFILE_LIMITS.profiles` in `bridge/voice-profile-registry.mjs` until commit
  `440de661` (2026-10-08) raised it to 1024; `bridge/pocket_voice_runtime.py` and `bridge/resident-voice-worker.py` carry the same 1024. The
  `registry.profileLimit` in `packaging/release-plan.json` was a stale note that no code reads (now 1024). The next limit is 256
  `profileKeys` per knowledge pack in `bridge/world-knowledge.mjs` (`LIMIT.profiles`); the roster is at 125 and the three voice configs at
  286 rows (before this batch). Nothing needs raising.
- **Aliases are full names only.** A nickname such as "Dodger" is also a handle in `characters/npc-name-pools.json`, and
  `bridge/npc-names.test.mjs` fails when a generated handle equals a roster alias. The nickname stays in the dossier text.
- **Knowledge.** `staging/cast/_knowledge/build-specs.mjs --additions` writes the pack and the audience additions, then
  `node research/cyberpunk/scripts/build_native_pack.mjs --apply` recompiles `generated/world-knowledge.json` and
  `characters/world-knowledge.json`. A rule that sits in a `zz-cast-knowledge-*` pack is cloned, not edited. Review text:
  `research/cyberpunk/native-reviews/cast-knowledge-20261019c.md`.
- **Release data.** `merge.mjs release-data --keys ...` copies only these keys' IDs; the full `Refresh-ReleaseData.mjs` would also take rows
  that other branches added to the shared `runtime/`.
- **Tests that notice a new batch.** `bridge/first-person-profiles.test.mjs` (two count pins), `bridge/nca-compat.test.mjs` (a record that NCA
  also offers, here `Character.Brick`, joins the named set), `bridge/multilingual.test.mjs` (the twins waited for the language box
  under an allowance for `CAST_EXPANSION_2_KEYS`; the boxes were set and recorded on 2026-10-19, the allowance is gone and the test checks
  `languageBoxOff: true` for both key lists).
- **Order used.** Text and CPU work first (specs, extraction, dossiers, profiles, merges, Convai), then the GPU steps: `analyze.py` (all 15 in
  about 25 minutes, Whisper on the GPU), `build.py`, `merge_rows.mjs` (the three configs now hold 301 voices), `merge.mjs release-plan`
  (`preparedLocalProfiles` 108 to 123), the ear check, and the keys moved from `CAST_EXPANSION_2_KEYS` into `CAST_EXPANSION_KEYS` (the
  second list is gone; the `todo` voice test is merged into the batch tests).
- **Voice results (2026-10-19).** Short/long set seconds: Steve 8.9/15.3, Grayson 7.4/17.3, Aymeric 9.7/18.0, Farida 8.5/17.7, Brick 8.7/17.8,
  Patricia 8.8/16.2, Lucy 9.9/18.0, Mateo 9.5/17.8, Max 10.0/17.8, Tiny Mike 8.7/16.8, Ziggy Q 8.7/17.6, Doctor Paradox 8.2/17.5 (loud, relaxed
  peak rule), Leon Rinder 7.9/7.9 (one clip: his lines are shouted and Whisper reads them badly, so the pool is one line; voice-thin),
  Albert Murphy 8.5/17.3, Carl Robinson 10.0/16.2 (pool of 6 clips).
- **`relaxPeak` spec override.** Patricia's voice is loudly mastered (peaks -1.9 to -2.5 dBFS, none clipped): the -3 dBFS pool was about 13 s of
  3 s clips and the short set came to 6.8 s, so `build.py` refused. `"relaxPeak": true` (with `relaxPeakNote`) in `voice-spec.json` applies the
  recipe's -1.5 dBFS rule for such a voice without waiting for a pool under 12 s.
- **Ear check (scores only; nobody listened).** `render_samples.py` rendered one line per character with the long reference; the WavLM
  x-vector of each render ranked its own reference first among all 123 omni-long references for all 15 (own cosine 0.93 to 0.99; closest
  other voice 0.001 to 0.06 lower, Max Jones against Dino Dinovic 0.977 to 0.976 and Leon Rinder against Mateo Thiago 0.929 to 0.925 are the narrow
  ones), and Whisper reads the lines back at 0.93 to 1.0 except Tiny Mike (0.78, number words). The renders are in
  `E:\CyberpunkConvai-offload\work\clip-search\cast-expansion\_ear2`.

### Live checks for the second batch (not done yet; needs the game and a dev install of this branch)

Before: dev-install the branch (every committed `mod/` file and the `.json` data, never `diagnostics.lua`; reds and archives as usual), copy
nothing else (the 15 voice rows are already in the live `runtime/` configs), restart the bridge, load a save.

1. Open the Companion Manager and scroll the character list. Check: Steve Sanchez, Jeremiah Grayson, Aymeric Cassel, Farida Nazeri, Brick,
   Patricia, Lucy Thackery, Mateo Thiago, Max Jones, Tiny Mike, Ziggy Q, Doctor Paradox, Leon Rinder, Albert Murphy and Carl Robinson are listed
   under those names (Lucy Thackery is not the NCA follower Lucy).
2. Invite Brick. Check: the copy appears, wears the ring-shaped head frame with red optics, and is not a generic civilian.
3. Talk to Brick (say hello, ask who runs the crew). Check: a deep, calm, middle-aged male voice answers, the reply is in his first-person
   register and fits what the dossier says about him, and the mouth moves.
4. Dismiss Brick, invite Patricia. Check: short reddish-brown hair, red cyberoptic, chrome forearms. Talk to her. Check: a husky female voice
   (the reference is loud; listen for distortion).
5. Dismiss Patricia, invite Lucy Thackery. Check: teal cap and round gold glasses; the voice is a clear female one.
6. Invite Steve Sanchez, talk about guitar. Check: a young male voice, quiff and bruise visible.
7. Invite Aymeric Cassel (his body is the Cassel twin `Character.theo`). Check: ginger swept-up hair; calm formal young voice; he does not
   call himself Theo.
8. Invite Leon Rinder (voice-thin: one 7.9 s reference). Check: a rough middle-aged male voice, bandaged head; note whether it sounds
   stretched or robotic on longer sentences.
9. Invite Doctor Paradox (no appearance text; the wiki picture is a glitch silhouette). Check: whatever body appears; the voice is an excited
   old male voice. Report the look, since it is the only one never described.
10. Optional: Farida Nazeri, Mateo Thiago, Max Jones, Tiny Mike, Ziggy Q, Albert Murphy, Carl Robinson, Jeremiah Grayson: invite each, one
    line each. Check: the voice matches the gender and age in the roster and no two sound the same as each other.
11. For one of them, type or speak a short line in Spanish. Check: the reply comes in Spanish (their twins are on Convai with the language
    box off) and the voice is still theirs.
