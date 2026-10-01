# Wider-cast voice reference preparation

## October 1 scope

The user now authorizes reference-based local voice profiles for the wider voiced
cast. Every profile uses the same pinned base OmniVoice weights. A new character
adds an attributed game recording, its exact transcript and conditioning metadata;
it does not add another neural model or require fine-tuning. Preserve the three
accepted Johnny, Judy and Panam references. Their alternatives and historical
training corpora are evidence, not a request to retrain or replace those voices.

The current authored roster has 79 profiles. This investigation reads production
code and cached native evidence, lists the installed English audio archive paths,
and writes only an isolated ignored inventory. It performs no GPU inference,
new audio decoding, game/save changes, Convai requests, installs or restarts.

## Measured available evidence

- Fresh installed archive-name lists contain 84,567 base and 25,928 Phantom Liberty
  WEM paths, 110,495 combined. These are resolved depot names from the current
  archive directory, not a claim that every unidentified archive hash was named.
- There are 127 cached winning `.scene` exports spanning 118 unique depot paths.
  Their raw binary SHA-256 and serialization source paths were rechecked. Exact
  normalized actor-name lookups find cached actor definitions for 37 profiles.
  Missing cached actors mean more source discovery is needed.
- 63 profiles have plausible named voice prefixes; 14 have only shared/generic
  scene-scoped candidates in this first pass. The two resident profiles do not
  identify a unique canonical named actor.
- Six profiles already have decoded, archive-hashed candidates: Ana Friedman,
  Blue Moon, Adam Smasher, Johnny, Judy and Panam. This is metadata/waveform
  qualification; historical `listeningVerified:false` flags are not listening
  acceptance. The three installed references remain accepted independently.
- The existing installed English text corpus contains 104,895 subtitle rows,
  including repeated resource entries, and no conflicting text ID groups at its
  recorded checkpoint. Recheck actual resource fingerprints before promotion.

Machine-readable evidence is under ignored
`runtime/voice-cast-inventory-20261001/`: `cast-roster-inventory.json`,
`cached-scene-actors.json`, `voice-archive-summary.json`, both WEM path lists,
and `casting-lanes.json`. The source roster SHA-256 is included in the inventory.
The inventory scripts are `list_voice_paths.py`, `inventory_cast.py`, and
`plan_lanes.py` in that same isolated directory.

## Exact attribution and transcript chain

Use external SoundDB search metadata to discover candidate paths and delivery
categories when useful. It is not the final attribution or transcript authority.
Do not download audio from it. Complete this chain against the installed game:

1. Verify the winning native `.scene` archive resource, entry SHA-1, decoded
   payload SHA-256 and serialized source path. Retain base/EP1 precedence for
   identical depot paths and the JSON serialization hash.
2. Resolve `screenplayStore.lines[i].speaker.id` to the same scene's
   `actors[j].actorId.id`. Preserve the actor name, voicetag ID and exact actor
   pointer. If a generic actor name is used, resolve its quest actor acquisition
   or spawn record to the requested canonical character; a shared voicetag or
   WEM prefix alone cannot establish character identity.
3. Resolve each `scnDialogLineEvent.screenplayLineId.id` to the explicit
   screenplay `itemId.id`. Retain the graph/event JSON pointer, expression,
   `isHolocallSpeaker`, custom voice event, duration and context. Prefer ordinary
   `Vo_Expression_Spoken` with no call/radio/underwater/braindance processing.
4. Take the line's exact `locstringId.ruid`. In `locStore.vdEntries`, require
   `localeId == en_us`; bounds-check `vpeIndex` into `vpEntries`, and require
   matching `variantId`. These identifier domains must not be guessed from
   nearby values. Keep descriptor, payload and line pointers.
5. Query `localization/index/lookup.sqlite3` read-only using
   `domain == subtitle.stringId` and that decimal string ID. Keep all candidate
   resources and exact variant pointers. Require installed English transcript
   agreement; do not silently choose a conflicting cross-resource entry.
6. Match the reviewed WEM's final hexadecimal stem to the exact decimal string
   ID. Establish the female/male resource variant explicitly. Player-gender
   variants can exist even for the same NPC; they are not different actors.
   Keep both the actor/source proof and the WEM path rather than relying on a
   filename resemblance.
7. Read only the allowlisted WEM from the installed base/EP1 English archive,
   verify its entry SHA-1 and RIFF bounds, decode with the verified vgmstream
   executable, then verify WAV frames, duration and hash with ffprobe. The
   exact installed subtitle entry supplies the reference transcript.

Native event duration and remote index duration are useful hints. WAV frame
counts determine decoded duration. Do not cut or concatenate clips to force
agreement. Quest branches need not have happened in the player's current save
to supply a correctly attributed reference recording, and reference text must
never be inserted into the player's conversation memory.

## Alias and voice-ownership traps

- The manager's Aaron is `Character.mq306_aaron`, with `aaron_waines` voice paths.
  `aaron_mccarlson` is another character and must not be substituted.
- Mark Bana uses `mark_bana`; `mark_muratovitch` is not his alias.
- River uses `sobchak`; Viktor uses `victor_vector`; Nancy uses `nancy`; T-Bug
  uses `t_bug`; Nele's native path spelling is `nele_spranger`.
- Padre uses `sebastian_padre_perez`, Muamar uses `muamar_capitan_reyes`, Dino
  uses `dino_dyno_dinovic`, Regina uses `regina_reggie_jones`.
- Mr. Hands uses `wade_bleecker` resources. Separate base/EP1 actor/voice
  incarnations and delivery processing before selecting the intended source.
- There are `civ_mid_f_07_enus_15_scene_bugbear_default` resources. Earlier empty
  actor-name searches are not proof that 8ug8ear has no audio. These candidate
  default-scene resources require local ownership review and use a shared native
  voice; they do not establish a unique canonical voiced personality.
- Several one-off characters use generic civil/gang voice tags. Choose only
  that character's verified lines. Never replace them with an unrelated NPC
  merely because the accent, demographic tag or voice actor resembles them.
- Adam Smasher is a voiced cyborg with deliberately processed speech. He needs
  a character-specific qualification decision, not the assumption that every
  source must sound like clean neutral human dialogue. The current 79-profile
  roster contains no Delamain profile.
- Resident Male/Female identify many crowd actors. Keep Convai for those generic
  profiles unless a separate, explicit model/voice selection policy is designed;
  do not label one randomly chosen crowd voice as the recovered cast voice.

## Bounded reusable extraction stages

`Extract-VoiceReferences.py` already implements bounded archive directory reads,
Oodle decoding, RIFF validation, exact subtitle parsing, hidden vgmstream/ffprobe
and hashes. Its current `main()` is a historical pilot: it caps the entire
allowlist at 48, confines output to `runtime/voice-references`, rejects 8ug8ear,
and accepts external scene/speaker metadata. Reuse the low-level verified
helpers, but replace pilot assumptions with an explicit reviewed wider-cast
candidate manifest and native attribution receipts. Do not weaken the archive,
path, bounds or hash checks.

`Prepare-VoiceTraining.py` is three-speaker dataset/training work. Its metadata
query and screening logic are useful references; do not run its `all` phase or
expand its old hundreds-of-clips datasets for this request. One primary and at
most one alternate recording per character are sufficient initial outputs.

`index_native_localization.py` has the verified installed English index and
scene-local descriptor join. `extract_scene_evidence.py` implements exact path
allowlists, winning resource selection, serialization, and raw hash checks.
Both currently own specific research cache destinations. A casting wrapper
must respect those boundaries or implement equivalent isolated-output checks;
it must not impersonate another lane by writing into shared manifests.

Start with at most six ordinary-spoken candidates per character. Prefer complete
3–12 second lines with at least five spoken words and a reasonable text/audio
rate. Reject clipped, silent, unintelligible, overlapping, strongly emotional,
sung, whispered, phone-filtered or environment-obscured references unless that
processing is the intended canonical character voice. Review original audio
listening as well as waveform gates. Retain the original decoded PCM with no
gain, EQ, denoising, resampling, time/pitch alteration, trimming or concatenation.
Mono and stereo originals remain explicitly recorded rather than silently
changing them during preparation.

The coordinator owns one shared promotion manifest. Research agents own their
lane folders and candidate decisions. Cap archive/decoder work at two CPU jobs
globally and any later synthesis at one GPU worker; 25 research agents do not
justify 25 competing decoders or model instances.

## Promotion receipt

Each candidate must retain these independently checkable fields:

| Group | Required fields |
| --- | --- |
| Identity | schema version, canonical roster key/name, roster SHA-256, aliases considered, unique/generic/processed policy |
| Discovery | query URL/version/time or local discovery input, raw metadata SHA-256, candidate/depot path |
| Native actor | scene depot/archive/winner, entry SHA-1, raw and JSON SHA-256, actor JSON pointer, actor ID/name/voicetag, canonical identity proof and any quest acquisition pointer |
| Native line | screenplay line/item ID, line pointer, speaker ID, event/node pointer, expression/context/processing flags, locstring ID as decimal string |
| English join | locale `en_us`, descriptor/payload pointers, checked vpeIndex/variantId, subtitle depot/archive/winner, subtitle binary/JSON hashes, entry/variant pointers, exact transcript and transcript SHA-256 |
| Source audio | WEM depot and archive, path hash, segment bounds, entry SHA-1 verified, payload SHA-256, explicit gender variant |
| Decoded audio | decoder path/version/hash, original channels/rate/bits/frames/duration, WAV SHA-256, peak/RMS/clipping/silence observations, ffprobe receipt, no processing declaration |
| Review | reviewer, attribution verified, transcript agreement, listening verified, clean/intelligible/overlap/processing observations, selection/rejection reason, approved primary/alternate |
| Runtime | shared model pinned revision, profile version, reference/transcript hashes, conditioning cache version/fingerprint, qualification status |

Separate statuses are `discovered`, `attributed`, `decoded_verified`,
`listening_qualified`, and `promoted`. A missing or rejected reference keeps
that character's configured Convai voice. Do not borrow an unrelated cloned
voice or claim extraction metadata establishes perceived quality.

Prompt caching must include the model/tokenizer revision, reference and
transcript hashes, adapter version and any preprocessing version. Do not
eagerly synthesize one warmup sentence for all 79 profiles at startup. Load one
shared model; cached conditioning can be prepared without multiplying model
weights. Runtime routing/promotion and cache ownership require their own
implementation review before this plan is installed.

## Independent casting lanes

`casting-lanes.json` partitions all 79 keys exactly once. The accepted-existing
lane only rechecks hashes. Each remaining lane can inspect source metadata and
select recordings in its own `runtime/voice-cast/<lane>` folder. Its current
partition is main-core13, silverhand8, Aldecaldos8, river/peralez7, fixers/city8,
Phantom Liberty main7, Phantom Liberty gigs8, minor/generic12 and minor/named5.
Use smaller bounded decoder batches when a lane exceeds the existing 48-resource
pilot cap. Canonical actor attribution comes before parallel decoding.

## Current profile discovery coverage

Counts below are candidate path counts, not approved references or proof that
all lines belong to the requested profile. Scoped searches often include V and
other quest participants; they require actor resolution. `cached` counts exact
name-matched native actor rows and may include repeated scene exports.

<!-- cast-inventory-table -->
| Profile | Named prefix / scoped hint | WEM candidates | Cached actor rows | Status |
| --- | --- | ---: | ---: | --- |
| 8ug8ear | scene_bugbear_default | 12 | 1 | shared actor; resolve |
| aaron | aaron_waines | 104 | 3 | named candidate; resolve |
| adam-smasher | smasher | 70 | 4 | decoded; needs review |
| alan-noel | alan_noel | 56 | 0 | named candidate; resolve |
| alex | alex | 505 | 4 | named candidate; resolve |
| ana-friedman | ana_friedman | 61 | 0 | decoded; needs review |
| arthur-jenkins | jenkins | 64 | 0 | named candidate; resolve |
| babs-okoye | babs | 39 | 0 | named candidate; resolve |
| bill-mitchell | bill_brooks | 72 | 0 | named candidate; resolve |
| blue-moon | blue_moon | 133 | 4 | decoded; needs review |
| bob-sagan | bob | 108 | 5 | named candidate; resolve |
| briana-dolson | sts_ep1_03 | 294 | 0 | shared actor; resolve |
| carol-emeka | carol | 164 | 5 | named candidate; resolve |
| cassidy-righter | cassidy | 133 | 5 | named candidate; resolve |
| chang-hoon-nam | chang_hoon_nam | 104 | 1 | named candidate; resolve |
| claire-russell | claire | 442 | 3 | named candidate; resolve |
| coach-fred | wat_lch_melee; sq011 | 1275 | 0 | shared actor; resolve |
| cynthia-najarro | mq040 | 253 | 0 | shared actor; resolve |
| dakota-smith | dakota_smith | 223 | 0 | named candidate; resolve |
| dennis-cranmer | mq038 | 81 | 0 | shared actor; resolve |
| dexter-deshawn | dexter | 248 | 0 | named candidate; resolve |
| dino-dinovic | dino_dyno_dinovic | 134 | 0 | named candidate; resolve |
| elizabeth-peralez | elizabeth_peralez | 273 | 0 | named candidate; resolve |
| evelyn-parker | evelyn | 219 | 3 | named candidate; resolve |
| frank-nostra | q000 | 1598 | 0 | shared actor; resolve |
| hanako-arasaka | hanako | 429 | 5 | named candidate; resolve |
| iris-tanner | iris_tanner | 44 | 0 | named candidate; resolve |
| jackie-welles | jackie | 1261 | 7 | named candidate; resolve |
| jake-estevez | sts_hey_gle_06 | 34 | 0 | shared actor; resolve |
| jefferson-peralez | jefferson_peralez | 204 | 0 | named candidate; resolve |
| jesse | jesse | 49 | 0 | named candidate; resolve |
| jim-jarry | jim_jarry | 136 | 0 | named candidate; resolve |
| johnny-silverhand | johnny | 3168 | 56 | accepted; preserve |
| joss-kutcher | joss | 126 | 2 | named candidate; resolve |
| judy-alvarez | judy | 1711 | 11 | accepted; preserve |
| kerry-eurodyne | kerry | 978 | 12 | named candidate; resolve |
| liam-northom | mq019 | 342 | 0 | shared actor; resolve |
| life-coach | q000 | 1598 | 0 | shared actor; resolve |
| lina-malina | lina | 73 | 0 | named candidate; resolve |
| lizzy-wizzy | lizzy_wizzy | 125 | 2 | named candidate; resolve |
| mama-welles | mama_welles | 200 | 2 | named candidate; resolve |
| mark-bana | mark_bana | 22 | 0 | named candidate; resolve |
| meredith-stout | meredith_stout | 80 | 0 | named candidate; resolve |
| misty-olszewski | misty | 422 | 3 | named candidate; resolve |
| mitch-anderson | mitch | 521 | 7 | named candidate; resolve |
| mr-hands | wade_bleecker | 890 | 0 | named candidate; resolve |
| muamar-reyes | muamar_capitan_reyes | 395 | 0 | named candidate; resolve |
| nancy-hartley | nancy | 185 | 3 | named candidate; resolve |
| nele-springer | nele_spranger | 70 | 0 | named candidate; resolve |
| nix | nix | 144 | 2 | named candidate; resolve |
| ozob-bozo | ozob | 92 | 1 | named candidate; resolve |
| paco-torres | paco | 120 | 0 | named candidate; resolve |
| padre-ibarra | sebastian_padre_perez | 298 | 0 | named candidate; resolve |
| panam-palmer | panam | 2644 | 16 | accepted; preserve |
| pepe-najarro | scene_elcoyote_barman_default; mq040 | 289 | 0 | shared actor; resolve |
| placide | placide | 451 | 3 | named candidate; resolve |
| r3n0 | mq015 | 164 | 0 | shared actor; resolve |
| rachel-casich | rachel | 164 | 1 | named candidate; resolve |
| regina-jones | regina_reggie_jones | 510 | 0 | named candidate; resolve |
| river-ward | sobchak | 1257 | 1 | named candidate; resolve |
| robert-wilson | wilson | 73 | 1 | named candidate; resolve |
| rogue-amendiares | rogue | 1243 | 5 | named candidate; resolve |
| sandra-dorsett | mq024 | 163 | 0 | shared actor; resolve |
| santiago | santiago | 53 | 0 | named candidate; resolve |
| saul-bright | saul | 428 | 10 | named candidate; resolve |
| sergei-karasinsky | scene_sergei_karasinsky_default | 21 | 0 | shared actor; resolve |
| shank | shank | 80 | 0 | named candidate; resolve |
| solomon-reed | reed | 2054 | 7 | named candidate; resolve |
| songbird | songbird | 2005 | 6 | named candidate; resolve |
| spider-murphy | q101 | 819 | 0 | shared actor; resolve |
| steven-santos | steven_santos | 75 | 0 | named candidate; resolve |
| t-bug | t_bug | 555 | 0 | named candidate; resolve |
| takemura | takemura | 1134 | 4 | named candidate; resolve |
| thompson | thompson | 74 | 0 | named candidate; resolve |
| viktor-vektor | victor_vector | 440 | 1 | named candidate; resolve |
| wakako-okada | wakako_okada | 328 | 1 | named candidate; resolve |
| yorinobu-arasaka | yorinobu | 134 | 1 | named candidate; resolve |
| resident-male | generic crowd | 0 | 0 | shared actor; resolve |
| resident-female | generic crowd | 0 | 0 | shared actor; resolve |
