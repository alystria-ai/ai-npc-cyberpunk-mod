# Multilingual Convai profiles (full roster)

Every character the mod has a Convai profile for (all 80 in `characters/roster.json`
with an ID in `runtime/characters.json`, and the 44 generic NPC archetypes of
`characters/archetype-roster.json`, keys `npc-*`) has a twin named "<name> Multilingual" in the
same account: 124 twins (80 named, 44 archetype). Each character has one profile and one
twin. (Until 2026-10-09 the five romantic profiles of Judy, Panam, River, Kerry and
Meredith had twins too, 128 in all; see "Retired romantic profiles" below.)
The twins exist and are verified; the mod uses them automatically, for a message that is clearly not English, on the Convai
route (see "Automatic language" below). There is no setting for it (the Multilingual conversations setting was removed on 2026-10-21).
Lucy Kushinada and Rita Wheeler (`lucy-kushinada`, `rita-wheeler`, the Night City Allies followers, added 2026-10-18) have a profile and a twin like the rest (156 twins in all: 82 named, 74 archetype); their twins' language boxes were unticked through the signed-in dashboard on 2026-10-18 (readback unticked) and `languageBoxOff: true` is recorded for both in `runtime/multilingual-profiles.json` and the release data (`docs/NCA_FOLLOWERS_PLAN.md`, section 6).
Alt Cunningham (`alt-cunningham`, added 2026-10-10) has a profile and a twin like the rest. Her twin's language box is not yet recorded
as unticked (`languageBoxOff` is false in `runtime/multilingual-profiles.json`): until that web-session step is done the
bridge answers her with the original profile. See `needsLanguageBoxOff` in `scripts/Create-MultilingualProfiles.mjs`.
The 2026-10-23 cast batch 3 twins (`hasan-demir`, `pedro-aimar`, `mr-blue-eyes`) were created and read back, and their language boxes were set off
through the signed-in dashboard the same day (readback `off`, `languageBoxOff: true` recorded).

```powershell
node scripts/Create-MultilingualProfiles.mjs --dry-run        # default: plan only, no remote calls
node scripts/Create-MultilingualProfiles.mjs --apply          # create/adopt + verify all 124 (--roster all, the default)
node scripts/Create-MultilingualProfiles.mjs --roster archetypes --apply   # only the 44 npc-* archetypes
node scripts/Create-MultilingualProfiles.mjs --roster named --apply        # only the 80 named characters
node scripts/Create-MultilingualProfiles.mjs --apply --only judy-alvarez,panam-palmer
node --test bridge/multilingual-profiles.test.mjs
```

The mapping is `runtime/multilingual-profiles.json` (ignored by Git, no secrets):
per roster key the original ID, twin ID, name, voice, language list, model,
`verified`, `languageBoxField`, `languageBoxOff` and `notCloned`. Only new characters are created;
originals are only read. A re-run adopts the mapped twin, or an existing twin found by
exact name plus the exact marker line, and re-verifies it, so it never duplicates. An
interrupted create with no matching character stops that profile instead of guessing.
`--apply` keeps going after a failing profile and lists it under `failures` (exit
code 1); re-running retries only what is not yet verified.

Ownership markers (the exact backstory line that identifies a character as ours):

| Profile | Marker line |
| --- | --- |
| Ordinary original | `[CyberpunkConvai profile v2:<key>]` |
| Ordinary twin | `[CyberpunkConvai profile v2:<key>:multilingual]` |

The name of a twin can be changed later without affecting the script, which matches on
name plus marker only to recover a lost create receipt.

### Retired romantic profiles

The five romantic profiles (`<key>-romantic`, marker `[CyberpunkConvai profile v2:<key>-romantic]`) and
their five twins were retired on 2026-10-09; each character has one profile and one twin. The
script no longer creates or accepts them (`--only` with a `-romantic` key is refused), the bridge
ignores any `<key>-romantic` row left in `runtime/multilingual-profiles.json`, and the relationship
setting (Auto / On / Off) only decides whether a romance block is added to the turn's dynamic context.
Deleting the retired Convai characters is a separate manual step, see docs/ROMANCE_DYNAMIC_CONTEXT.md.

## Text providers (Mistral, Local AI, Custom): the player's language, no twins (the same detector serves every route)

Added 2026-10-20 after a Local AI player with the European microphone pack and OmniVoice reported that characters always answered in English.
The cause: on every text provider the bridge forced Multilingual conversations off (the twins are Convai characters), and with it the
reply-language block, so an English persona answered in English whatever the player wrote.

Now there is no setting and no twin: while a text provider answers, the reply-language block is built for every turn (since 2026-10-21 on every route, not only text providers) and
- the dynamic context ends with the same `languageContext` block as the twins get ("answer in the language of the player's latest message,
  which is French ..."), but only when it changes something (`textProviderLanguageContext`): nothing for an English conversation (the context is
  byte-identical to before, no extra tokens), the player's language when the message is in another language, English again when the player
  switches back, and "the language the player is using (so far X)" for a turn with no text of its own (a recording, a reaction) once the
  conversation is in another language. A recording with nothing said yet follows the language the microphone last heard or the one remembered
  from the last launch (`player-language.json`, docs/LOCAL_STT.md). Natural speech and V's line get the language too (CJK sounds, V skipped);
- the voice follows the reply: OmniVoice speaks it with the reply's language (as in the Convai twins' path); Voxtral (Mistral cloud, Voxtral TTS 3,
  2026-10-21) and Inworld (TTS-2 Flash, 2026-10-31, `bridge/inworld-languages.mjs`) speak it for the languages their model lists (`local.cloud` and `local.speaks` in `planTurnVoice`/`replyVoice`, `bridge/voxtral-languages.mjs`:
  Voxtral's API has no language field, the model speaks the language of the text, so nothing is passed. Inworld's takes a `language` code, which the voice adds itself); Pocket, which speaks English only (and French, Italian, German, Spanish and Portuguese when their PocketTTS model and multilingual pack are installed: `local.pocket`, docs/POCKET_LANGUAGE_MODELS.md), and Voxtral for an
  unlisted language keep the plan and `replyVoice` shows a non-English reply as text (`engine: 'none'`, reason `english-only-voice` or
  `voice-language-unsupported`), with one `voice-language` notice per game session ("Replies in some languages show as text: this voice does not speak
  them. OmniVoice speaks them all, and Voxtral most of them."). No voice model is loaded for it. An English conversation keeps the chosen voice untouched.
  A text provider has no Convai cloud voice to fall back on, so the plan never hands such a turn to `convai`.

The Convai route uses the same detection and the same context block, and adds the twins (next section).

## Archetype twins (npc-*)

The 44 archetype profiles (docs/NPC_ARCHETYPES.md) have twins made by the same script and the same rules: a faithful
clone of the original (only the ownership marker line differs: `[CyberpunkConvai profile v2:npc-maelstrom-male:multilingual]`),
`languageCodes: ['en-US']`, an Azure multilingual voice from the map, the original's model, verbosity and state of mind.
**Memory stays as the original has it: off** (a twin whose memory differs is put back; the script turns it off as well as on).
The twin ID is mapped under the archetype key in `runtime/multilingual-profiles.json`; the bridge routes the archetype to
it exactly like a named character (`bridge/multilingual.mjs`, `bridge/relationship-routing.mjs`: provider key
`npc-...-multilingual`, same memory family as the archetype). Like every twin it is used only once it is verified and its
language box is marked off (the web-session step below); until then the archetype keeps its English original.

Archetype voices (also in `characters/multilingual-voice-map.json`, keyed `npc-*`) were matched to the kind, gender, age and tone
of each archetype from the 53 Azure voices, avoiding the fourteen main-cast voices (Judy, Panam, Johnny, Kerry, River, Jackie, Viktor,
Misty, Rogue, Takemura, Mama Welles, Meredith, Claire, Solomon); there are only 16 non-main female Azure voices for 22 women, so six are
shared between kinds that do not meet (for example the Maelstrom and Animals women). Examples: Maelstrom man OnyxTurbo (the lowest, roughest
register), Voodoo Boys Remy and Vivienne (French-native, for the Haitian-French flavour), Tyger Claws Hyunsu and Xiaoxiao (East Asian-native),
Valentinos Alessio and Isidora (Latin-leaning, Spanish-native), corporate guard Steffan and Ada (crisp, formal), street locals Ryan and Jenny (the generic
resident voices). Not audition-tested, like the rest of the map; change the entry and run `--voices-only` to swap one.

## What a twin copies and what differs

Copied and read back: biography (only the ownership marker line differs, so a twin
never matches its original's marker or another twin's), speaking style description,
sample dialogues, model (list readback), memory enabled, state of mind, verbosity,
and every other compared setting (moderation, filters, guardrails, traits, listing,
actions, narrative flag, temperature, and so on; any difference is listed in
`notCloned`, all empty today).

Different on purpose:

- **Voice.** Convai refuses non-English `languageCodes` on a Kokoro voice
  ("Given voice incompatible with the language code"). Twins use an Azure multilingual
  voice (71 languages, English included) chosen per character; see "Voices" below. The
  original Kokoro voice is not kept, but it and the profile decide the gender, age and tone
  of the match. Gender comes from the original Kokoro voice, falling back to the roster's
  `gender` field (the dry run lists any key that needed the fallback; none did, and the two
  sources agree for the whole roster). The mod mostly speaks with its own local voices, so
  this matters only for Convai cloud voice.
- **Languages.** `languageCodes` is `['en-US']` only. With the language box off (next
  section) the character answers in whatever language the player uses, so the
  languages do not need to be listed. An earlier version listed ten interface
  languages; that is no longer wanted.
- **Not cloned:** the avatar (Convai assigns a random one; the mod does not use
  it) and `embodiment_data`. The originals have no knowledge bank files
  (`character/knowledge-bank/list` returned none for the 23 tier-1 profiles), no
  narrative design (`is_narrative_driven` false) and no actions, so nothing was
  missing.

## The "Only reply in the selected languages" box

The box is the dashboard field `language_hardening_mode`: `default` means ticked and
`off` means unticked. The twins want it unticked (`off`).

- Core `POST /character/update` **ignores** the field (camelCase and snake_case were
  both tried; readback was unchanged), and `/character/get` and `/character/list`
  never return it.
- The Core API key gets 401 on the web dashboard API
  (`https://convai.com/api/character/...`). Only a signed-in browser session can set
  it, with `POST https://convai.com/api/character/update` and JSON
  `{character_id, workspace_id, language_hardening_mode: 'off'}`.
- The script therefore **never sets it**. Its output includes `needsLanguageBoxOff`,
  the `{key, id, name}` of every twin whose mapping entry is not marked
  `languageBoxOff: true`. After the box is set through the browser session, edit the
  mapping entry to `languageBoxOff: true` (the script preserves that flag on re-runs).

Status (2026-10-07): all 84 twins then existing (23 tier-1, 5 romantic since retired, 56 for the rest of the roster; 80 today)
have the box off, set through the web session and verified by readback, and are marked
`languageBoxOff: true` in the mapping.

## Voices

Before 2026-10-08 every twin used one of two voices (Emma for women, Christopher for men). Each twin now has a
voice chosen for its character. The choice lives in `characters/multilingual-voice-map.json` (per roster key: voice ID,
voice name, one-line reason), which `scripts/Create-MultilingualProfiles.mjs` reads.
Emma and Christopher remain only as the fallback for a key with no entry.

### Which voices exist

`GET https://api.convai.com/tts/get_available_voices` (header `CONVAI-API-KEY`) returns nine provider groups, 1,319
voices in all. A voice is multi-language when its `lang_codes` lists more than one language; **252 voices** qualify. The
full inventory (ID, name, gender, language count, age/style text where the name carries one, sample link, credit cost) is
`characters/convai-multilingual-voices.json`.

| Provider group | Multi-language voices | Notes |
| --- | --- | --- |
| Azure Voices | 53 | 51 `AZURE-MULTILINGUAL-*` voices with 71 languages, plus `JennyMultilingualV2Neural` and `RyanMultilingualNeural` (42 languages). 23 female, 29 male, 1 neutral (FableTurbo, unused). |
| Elevenlabs Voices | 177 | All list 37 languages. The names carry age, accent and style ("Old Husky American Male", "Young Calm American Female"). |
| Open AI voices | 6 | 43 languages; names carry a short age/register note. |
| OpenAI Realtime Voices | 8 | 43 languages; no cost field. |
| GCP Voices | 8 | Two languages each. |
| Convai, GCP Realtime, Fish Audio | 0 | Single-language voices. |

Eight of the 252 do not list `en-US` (GCP two-language pairs); every voice assigned below does.

**Why only Azure.** The twins were created and verified on Azure multilingual voices, and Azure is what the request and
this doc already assumed. The ElevenLabs and OpenAI voices are multi-language too and have better age and style labels,
but none has been tried on a twin, so they are listed in the inventory as candidates and not used. Any of them can be
dropped into the map, then applied with `--voices-only` (below).

### How the voices were matched

Azure's voice names carry no age or style information, so each voice was characterised from three things:

- the median pitch of its Convai sample clip (autocorrelation over the ~6 s WAV; rough, useful for low versus high
  register and not for age),
- Microsoft's published notes where they exist (Adam deep and warm, Andrew empathetic, Dustin soft-spoken and calm, Evelyn
  mature and straightforward, Amanda and Ava bright, Emma cheerful and conversational, Brian casual),
- the voice's likely native locale, from Azure's own naming (Ximena, Tristan, Isidora: Spanish; Vivienne, Remy, Lucien:
  French; Seraphina, Florian: German; Isabella, Alessio, Giuseppe, Marcello: Italian; Thalita, Macerio: Brazilian
  Portuguese; Hyunsu, Masaru: Korean, Japanese; Xiaochen, Xiaoxiao, Xiaoyu, Yunfan, Yunxiao, Yunyi: Chinese; Ada, Ollie:
  British). Unverified: a foreign-native voice may keep a light accent in English. It is used on purpose where it suits
  the character (Takemura, Chang-Hoon Nam, Placide, Ana Friedman, Mark Bana, Jackie) and otherwise only for minor characters
  who needed a distinct voice.

The character side came from the original Kokoro voice's label (for example "Deep Calm Middle-Aged American Male"),
the roster summary and the profile. Rules: gender matches; the main cast that appears together never shares a voice (Judy,
Panam, Johnny, Kerry, River, Jackie, Viktor, Misty, Rogue, Takemura, Mama Welles, Meredith, Claire, Solomon each have their
own; the test in `bridge/multilingual-profiles.test.mjs` enforces it); a voice is shared only by characters from different
parts of the story (for example Viktor and Saul Bright, Rogue and Dakota Smith). 52 of the 53 Azure multilingual voices are used (2 to 3
characters each where shared).

**Not audition-tested.** The pitch and locale hints are measurements and naming, not listening. Use the sample links below
and change `characters/multilingual-voice-map.json` where a voice is wrong.

### Assignments

| Character | Voice | Why |
| --- | --- | --- |
| 8ug8ear (`8ug8ear`) | Ava | Bright young-adult voice for a risk-taking Japantown netrunner. |
| Aaron (`aaron`) | EchoTurbo | Light young male voice for a young Dogtown boxer. |
| Adam Smasher (`adam-smasher`) | OnyxTurbo | Lowest male register on offer, for a menacing cyborg mercenary. |
| Alan Noël (`alan-noel`) | Remy | Smooth, low French-native voice for a discreet hardware dealer with a Francophone name. |
| Alex (`alex`) | Emma | Cheerful, adaptable voice for an operative who plays roles (keeps the old default). |
| Ana Friedman (`ana-friedman`) | Thalita | Brazilian Portuguese-native voice for a Brazilian intelligence analyst. |
| Arthur Jenkins (`arthur-jenkins`) | Samuel | Higher, sharper male voice for a bitter, rank-conscious corporate counterintelligence head. |
| Babs Okoye (`babs-okoye`) | ShimmerTurbo | Low, steady female voice for a wary BARGHEST veteran. |
| Bes Isis (`nancy-hartley`) | Ada | British-native female voice for an investigative reporter and ex-Samurai keyboardist (Bes Isis). |
| Bill Mitchell (`bill-mitchell`) | Brian | Casual, sincere mid-register voice for an unsure young NCPD officer. |
| Blue Moon (`blue-moon`) | Xiaoxiao | Bright, cheerful voice for a pop-trio star. |
| Bob Sagan (`bob-sagan`) | Davis | Relaxed, slightly rough mid-low male voice for a dry, practical nomad veteran. |
| Briana Dolson (`briana-dolson`) | NovaTurbo | Friendly, grounded low-mid voice for a trusted neighborhood organizer. |
| Carol Emeka (`carol-emeka`) | Serena | Calm, mature female voice for a technician and ex-army netrunner. |
| Cassidy Righter (`cassidy-righter`) | Derek | Easygoing mid-low male voice for an older, dry-humored gunslinger. |
| Chang-Hoon Nam (`chang-hoon-nam`) | Hyunsu | Korean-native male voice, matching the Korean name, for a veteran Japantown netrunner. |
| Claire Russell (`claire-russell`) | Cora | Warm, slightly husky mid female voice for the Afterlife bartender and mechanic. |
| Coach Fred (`coach-fred`) | OnyxTurbo | Deep, confident voice for a retired boxer and trainer. |
| Cynthia Najarro (`cynthia-najarro`) | Isidora | Spanish-native female voice for a Heywood mother and office worker. |
| Dakota Smith (`dakota-smith`) | Lola | Deep, authoritative female voice for the Badlands fixer Mad Coyote. |
| Dennis Cranmer (`dennis-cranmer`) | Andrew | Measured, businesslike warm voice for an economical Afterlife contact. |
| Dexter DeShawn (`dexter-deshawn`) | Brandon | Smooth, assured mid male voice for a veteran fixer. |
| Dino Dinovic (`dino-dinovic`) | Marcello | Smooth, expressive Italian-native voice for a party-scene fixer and bassist. |
| Elizabeth Peralez (`elizabeth-peralez`) | Isabella | Polished, clear female voice for a lawyer and campaign strategist. |
| Evelyn Parker (`evelyn-parker`) | Vivienne | Soft, light French-native voice for a vulnerable would-be actress. |
| Flaming Crotch Man (`jesse`) | Ryan | Ordinary American male voice for a panicked Night City resident. |
| Frank Nostra (`frank-nostra`) | Derek | Confident mid male voice for a self-assured Arasaka operative. |
| Hanako Arasaka (`hanako-arasaka`) | Seraphina | Cool, precise German-native voice for an Arasaka heiress and netrunner. |
| Iris Tanner (`iris-tanner`) | Arabella | Low, direct female voice for a hard-bargaining nomad techie. |
| Jackie Welles (`jackie-welles`) | Tristan | Warm, energetic Spanish-native male voice for a Heywood Latino merc. |
| Jake Estevez (`jake-estevez`) | Brandon | Confident mid male voice for a gifted vehicle mechanic. |
| Jefferson Peralez (`jefferson-peralez`) | Steffan | Mature, crisp voice for a mayoral candidate. |
| Jim Jarry (`jim-jarry`) | Yunxiao | Mid-high male voice for a street-race organizer contact. |
| Johnny Silverhand (`johnny-silverhand`) | Davis | Casual, expressive, slightly gritty male voice for a sardonic rockerboy. |
| Joss Kutcher (`joss-kutcher`) | Ximena | Gentle, warm Spanish-native female voice for a mother of three. |
| Judy Alvarez (`judy-alvarez`) | Ava | Bright, engaging voice for a young braindance editor. |
| Kerry Eurodyne (`kerry-eurodyne`) | Lewis | Higher, animated male voice for a flamboyant rock singer. |
| Liam Northom (`liam-northom`) | Ollie | Young British-native male voice for a smooth pop-star manager. |
| Life Coach (`life-coach`) | Yunfan | Even, encouraging mid male voice for a coaching contact. |
| Lina Malina (`lina-malina`) | Emma | Upbeat, forceful female voice for a braindance performer. |
| Lizzy Wizzy (`lizzy-wizzy`) | Phoebe | Highest female register, theatrical, for a conceptual pop star. |
| Mama Welles (`mama-welles`) | ShimmerTurbo | Low, warm, commanding female voice for a restaurant owner and mother. |
| Mark Bana (`mark-bana`) | Macerio | Brazilian Portuguese-native male voice for a veteran of the Brazilian Intelligence Agency. |
| Meredith Stout (`meredith-stout`) | Evelyn | Mature, straightforward, believable voice for a senior Militech executive. |
| Misty Olszewski (`misty-olszewski`) | Nancy | Calm, gentle female voice for a spiritual shopkeeper. |
| Mitch Anderson (`mitch-anderson`) | Christopher | Low, steady voice for an older mechanic and war veteran. |
| Mr. Hands (`mr-hands`) | Steffan | Mature, crisp, polished voice for a discreet fixer. |
| Muamar Reyes (`muamar-reyes`) | Alessio | Warm, authoritative Latin-leaning male voice for an independent fixer. |
| Nele Springer (`nele-springer`) | Nancy | Calm, serious female voice for a practical chemist. |
| Night City Resident Female (`resident-female`) | Jenny | Friendly, ordinary American female voice for an ambient resident. |
| Night City Resident Male (`resident-male`) | Ryan | Ordinary American male voice for an ambient resident. |
| Nix (`nix`) | AlloyTurbo | Neutral, curious mid male voice for an enthusiastic netrunner. |
| Ozob Bozo (`ozob-bozo`) | Macerio | Brazilian Portuguese-native male voice for a Brazilian mercenary joker. |
| Paco Torres (`paco-torres`) | Tristan | Spanish-native male voice for an eager Latino BARGHEST recruit. |
| Padre Ibarra (`padre-ibarra`) | Andrew | Warm, empathetic male voice for an ex-counselor turned fixer. |
| Panam Palmer (`panam-palmer`) | NovaTurbo | Energetic, low-mid, slightly husky voice for a feisty nomad. |
| Pepe Najarro (`pepe-najarro`) | Brian | Casual, sincere voice for a worn-out family bartender. |
| Placide (`placide`) | Lucien | Deep French-native male voice for a Haitian Voodoo Boy elder. |
| R3n0 (`r3n0`) | Ada | Clear British-native female voice for a guarded netrunner. |
| Rachel Casich (`rachel-casich`) | Jenny | Friendly, brisk American voice for a commercially minded braindance producer. |
| Regina Jones (`regina-jones`) | Xiaochen | Confident, broadcast-style voice for a Chinese-heritage fixer and former reporter. |
| River Ward (`river-ward`) | Dustin | Soft-spoken, calm, trustworthy male voice for a detective. |
| Robert Wilson (`robert-wilson`) | Yunfan | Even, careful mid male voice for a meticulous gunsmith. |
| Rogue Amendiares (`rogue-amendiares`) | Lola | Deep, weathered female voice for the Afterlife owner and legendary fixer. |
| Sandra Dorsett (`sandra-dorsett`) | Seraphina | Cool, controlled German-native voice for a cautious corporate netrunner. |
| Santiago (`santiago`) | Giuseppe | Smooth, persuasive Italian-native male voice for a nomad negotiator. |
| Saul Bright (`saul-bright`) | Adam | Deep, warm, steady male voice for the Aldecaldo family leader. |
| Sergei Karasinsky (`sergei-karasinsky`) | Lucien | Deep French-native male voice for a gruff, trouble-prone solo. |
| Shank (`shank`) | Yunyi | Mid-high male voice for a Brainporium owner. |
| Solomon Reed (`solomon-reed`) | Christopher | Low, authoritative male voice for a veteran FIA operative. |
| Songbird (`songbird`) | Amanda | Bright, youthful voice for an ambitious young netrunner. |
| Spider Murphy (`spider-murphy`) | Xiaoyu | Lively, quick female voice for a showy veteran netrunner. |
| Steven Santos (`steven-santos`) | Dustin | Calm, measured male voice for a Brazilian intelligence risk analyst. |
| T-Bug (`t-bug`) | Serena | Calm, mature female voice for a survival-minded professional netrunner. |
| Takemura (`takemura`) | Masaru | Japanese-native male voice for a stoic former Arasaka bodyguard. |
| Thompson (`thompson`) | Ollie | British-native male voice for a veteran armed reporter. |
| Viktor Vektor (`viktor-vektor`) | Adam | Deep, warm, calm male voice for a ripperdoc and ex-boxer. |
| Wakako Okada (`wakako-okada`) | Arabella | Low, measured female voice for a formidable Japantown broker. |
| Yorinobu Arasaka (`yorinobu-arasaka`) | Florian | Cold, precise German-native male voice for an estranged Arasaka heir. |

### The voices used, with samples

Pitch is the median of the sample clip. The sample links are Convai's public WAVs (no credits).

| Voice | Gender | Pitch (Hz) | Likely native locale | Used by | Sample |
| --- | --- | --- | --- | --- | --- |
| Lola | Female | 147 | en-US | Dakota Smith, Rogue Amendiares | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-579bb40ede.wav) |
| ShimmerTurbo | Female | 150 | en-US | Babs Okoye, Mama Welles | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-c419069dad.wav) |
| Arabella | Female | 157 | en-US | Iris Tanner, Wakako Okada | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-c49149301e.wav) |
| NovaTurbo | Female | 168 | en-US | Briana Dolson, Panam Palmer | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-ccad980348.wav) |
| Seraphina | Female | 168 | de-DE | Hanako Arasaka, Sandra Dorsett | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-ad8798063c.wav) |
| Emma | Female | 184 | en-US | Alex, Lina Malina | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-a0810a758f.wav) |
| Thalita | Female | 184 | pt-BR | Ana Friedman | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-fa9bf5ee42.wav) |
| Ada | Female | 184 | en-GB | Bes Isis, R3n0 | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-a274d6d359.wav) |
| Vivienne | Female | 186 | fr-FR | Evelyn Parker | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-b439921109.wav) |
| Cora | Female | 190 | en-US | Claire Russell | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-8a6fbf3e26.wav) |
| Ava | Female | 195 | en-US | 8ug8ear, Judy Alvarez | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-54251ef38f.wav) |
| Isabella | Female | 198 | it-IT | Elizabeth Peralez | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-ea3de26c8e.wav) |
| Isidora | Female | 200 | es-ES? | Cynthia Najarro | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-552d02efd8.wav) |
| Xiaoxiao | Female | 203 | zh-CN | Blue Moon | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-ad3499ac3d.wav) |
| Jenny | Female | 203 | en-US | Night City Resident Female, Rachel Casich | [wav](https://storage.googleapis.com/tts-voice-samples/JennyMultilingualV2Neuralen_US_sampleVoice.wav) |
| Ximena | Female | 205 | es-ES | Joss Kutcher | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-eb15982107.wav) |
| Nancy | Female | 208 | en-US | Misty Olszewski, Nele Springer | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-674bb044a0.wav) |
| Xiaoyu | Female | 215 | zh-CN | Spider Murphy | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-94e17e5330.wav) |
| Serena | Female | 216 | en-US | Carol Emeka, T-Bug | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-9a90389ca0.wav) |
| Xiaochen | Female | 219 | zh-CN | Regina Jones | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-c54bd099e4.wav) |
| Amanda | Female | 229 | en-US | Songbird | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-c1eb570bf7.wav) |
| Evelyn | Female | 246 | en-US | Meredith Stout | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-8f3af70863.wav) |
| Phoebe | Female | 254 | en-US | Lizzy Wizzy | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-8fb9b03aef.wav) |
| OnyxTurbo | Male | 90 | en-US | Adam Smasher, Coach Fred | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-b56af7ad45.wav) |
| Lucien | Male | 96 | fr-FR | Placide, Sergei Karasinsky | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-3e4638872a.wav) |
| Christopher | Male | 108 | en-US | Mitch Anderson, Solomon Reed | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-3ea74315c9.wav) |
| Remy | Male | 110 | fr-FR | Alan Noël | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-4ef14f6865.wav) |
| Andrew | Male | 111 | en-US | Dennis Cranmer, Padre Ibarra | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-c387a0c635.wav) |
| EchoTurbo | Male | 122 | en-US | Aaron | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-8087ad87b4.wav) |
| Adam | Male | 122 | en-US | Saul Bright, Viktor Vektor | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-1aabb8bc8a.wav) |
| Masaru | Male | 122 | ja-JP | Takemura | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-d71516a5ca.wav) |
| Brian | Male | 125 | en-US | Bill Mitchell, Pepe Najarro | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-df94d676e2.wav) |
| Ollie | Male | 125 | en-GB | Liam Northom, Thompson | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-3ff4a9681c.wav) |
| Davis | Male | 126 | en-US | Bob Sagan, Johnny Silverhand | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-65374d4054.wav) |
| Marcello | Male | 127 | it-IT | Dino Dinovic | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-a2e2d3c386.wav) |
| Dustin | Male | 127 | en-US | River Ward, Steven Santos | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-1aa256e8f9.wav) |
| Brandon | Male | 128 | en-US | Dexter DeShawn, Jake Estevez | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-99b13147b2.wav) |
| Tristan | Male | 128 | es-ES | Jackie Welles, Paco Torres | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-7fb84283de.wav) |
| Ryan | Male | 130 | en-US | Flaming Crotch Man, Night City Resident Male | [wav](https://storage.googleapis.com/tts-voice-samples/RyanMultilingualNeuralen_US_sampleVoice.wav) |
| Derek | Male | 131 | en-US | Cassidy Righter, Frank Nostra | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-19f6a69dbc.wav) |
| Hyunsu | Male | 132 | ko-KR | Chang-Hoon Nam | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-61873ce320.wav) |
| Florian | Male | 136 | de-DE | Yorinobu Arasaka | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-3cff3776e9.wav) |
| Yunfan | Male | 138 | zh-CN | Life Coach, Robert Wilson | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-713bbb4510.wav) |
| Macerio | Male | 142 | pt-BR | Mark Bana, Ozob Bozo | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-6d586af64a.wav) |
| Alessio | Male | 142 | it-IT | Muamar Reyes | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-92203654f0.wav) |
| Steffan | Male | 143 | en-US | Jefferson Peralez, Mr. Hands | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-7c29b4eda9.wav) |
| Yunyi | Male | 147 | zh-CN | Shank | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-99eda63017.wav) |
| AlloyTurbo | Male | 148 | en-US | Nix | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-f1ebefb495.wav) |
| Yunxiao | Male | 151 | zh-CN | Jim Jarry | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-83464fdaf7.wav) |
| Giuseppe | Male | 152 | it-IT | Santiago | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-742a42448d.wav) |
| Lewis | Male | 155 | en-US | Kerry Eurodyne | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-67e07b0e1f.wav) |
| Samuel | Male | 163 | en-US | Arthur Jenkins | [wav](https://storage.googleapis.com/tts-voice-samples/AZURE-MULTILINGUAL-de811bb34d.wav) |

### Applying a change to the live twins

```powershell
node scripts/Create-MultilingualProfiles.mjs --dry-run                 # lists every twin with its voice
node scripts/Create-MultilingualProfiles.mjs --apply --voices-only      # voice only, existing twins only
node scripts/Create-MultilingualProfiles.mjs --apply --voices-only --only judy-alvarez,panam-palmer
```

`--voices-only` reads each mapped twin, checks its ownership marker, and sends `/character/update` with `charID` and
`voiceType` only, and only when the voice differs. It then reads the twin back and fails that profile unless the voice
changed and every other field of the readback is identical to the read before the update. Originals are never read or
written in this mode. It records the voice in the mapping's `voiceType`. Requests are 1.6 s apart.

### Verification (2026-10-08)

All 84 live twins then existing (80 today; the other five were the retired romantic twins) were read before and after (`/character/get`), together with their 84 originals. Result: the voice of
all 84 twins equals the map (52 distinct voices; 80 twins changed, 4 already had their mapped voice: Alex, Lina Malina
(Emma), Mitch Anderson, Solomon Reed (Christopher)); no other field of any twin changed (backstory, speaking style,
`language_codes` `['en-US']`, model, memory, state of mind, verbosity and the rest all identical); no original changed;
the mapping file changed only in `voiceType`. The credit-cost estimates
inside `memory_settings` (`kb_min_credit_cost_e8`, `ltm_min_credit_cost_e8`) flip between two reads of the same
character, so the comparison ignores keys ending in `min_credit_cost_e8`; they are computed, not settings.

## Voice and memory

- Voices stay Azure multilingual (Kokoro rejects non-English); see "Voices" for the per-character choice.
- Memory is per profile: Convai long-term memory is scoped by character ID plus
  end-user ID, so each twin keeps its own memory, as if it were another character.

## Automatic language (since 2026-10-21; there is no setting)

The Multilingual conversations setting (`multilingualConversations`, Settings > Conversations, off by default) is gone. An old saved value is a
retired setting: dropped at load (`RETIRED_SETTINGS` in `mod/manager.lua`) and ignored by an Apply and by the bridge. Code:
`bridge/reply-language.mjs` (language detection), `bridge/multilingual.mjs` (the holder of the conversation's language, `wantsTwin`, the per-turn
voice plan), `bridge/relationship-routing.mjs` (`select(profile, boundary, {multilingual})`), `bridge/player-knowledge.mjs` (passes the turn's text
when it picks the route), `bridge/convai-bridge.mjs` (`twinForTurn`).

### Detection (`bridge/reply-language.mjs`)

No model, no network, no per-turn load. Script first (kana, Hangul, Han, Greek, Arabic, Hebrew, Devanagari, Thai name their language; Cyrillic is
Russian or Ukrainian). Latin text is scored against word lists built once when the module loads (`bridge/language-lexicon.mjs`: 16 languages, about
300 to 700 function words, everyday verbs, question words and greetings each; `bridge/language-english-vocab.mjs`: English words from the mod's own
docs and profiles at half weight; `bridge/language-ui-vocab.mjs`: the interface words of the 11 shipped translations at half weight), plus marked letters
(ñ, ß, ł, ř, ő, ğ, ă, ø, Vietnamese tone marks) and Spanish's ¿ and ¡. A short line the lists cannot decide ("Siamo quasi arrivati?") goes to a character
trigram model trained on the same lists, which chooses among the languages the lists lean towards and must clear English by a margin; English is called only when
nothing foreign was heard. Night City names, street slang and the Spanish and Japanese nicknames the characters use are neutral (no language), so
"preem gig choom" and "hey hermano what's up" stay English, and "¿Qué pasa, choom?" is Spanish. Short capitals ("CET", "LOL") are ignored. A call costs
about 20 to 60 microseconds for a chat line and a quarter of a millisecond for a 1,200 character reply; loading the lists takes about 100 ms once.
Languages: English, Spanish, Portuguese, French, German, Italian, Dutch, Polish, Czech, Hungarian, Turkish, Swedish, Romanian, Catalan, Norwegian, Vietnamese
(Latin); Russian, Ukrainian, Japanese, Chinese, Korean, Greek, Arabic, Hebrew, Hindi, Thai (by script). That covers every language the mod's interface ships in, and most of those Voxtral TTS 3 and Inworld list, and
every language the mod's interface ships in (`bridge/reply-language.test.mjs` checks both).
Measurement: `node scripts/Eval-LanguageDetection.mjs [--set=dev|heldout|blind] [--errors]` prints precision and recall per language on the labelled short
lines (`bridge/reply-language.cases.mjs`, `.heldout.json`, `.blind.json`); `node scripts/Eval-LanguageCorpus.mjs [--parity=even]` runs it on the mod's own
translated interface strings and on windows of English documentation (the English false-positive check).

### Reply language (Settings > Voices > Voice language, 2026-10-23; `replyLanguage`)

A row of the Voices category (MCM and Native Settings UI): **English** (the default, for everyone, new and existing), **Automatic**, then the mod's
other languages (`REPLY_LANGUAGES` in `bridge/multilingual.mjs`, the same list as `replyLanguages` in `mod/manager.lua`: German, French, Spanish, Italian,
Portuguese, Polish, Russian, Ukrainian, Turkish, Czech, Hungarian, Japanese, Korean, Chinese; it holds every multilingual pack and every Pocket
language model language). It is a VOICE setting: it counts only while Voice playback is on. With voices off the routing is Automatic, exactly as before
the setting existed (the row stays visible and its description says so; the saved choice is kept).

- **A fixed language** (English or any other) skips the detection. `MultilingualConversations.setFixed` makes every turn that language: the Convai route
  goes to that language's twin (English: the ordinary character), the voice plan uses it (`planTurnVoice({fixed})`; the finished reply is not
  re-detected), the context names it (`fixedLanguageContext`, nothing for English, so an English conversation sends the context it always did), V's typed
  line is voiced in it unless the line is solidly English. A voice that cannot speak the language still shows the reply as text with the usual one-time
  notice (Pocket needs the language's model and voice pack).
- **Other language** (2026-10-31, `docs/SUBTITLE_LANGUAGE.md`): the last choice of the row, with the row **Other language** under it (`replyLanguageOther`: Finnish, Swedish,
  Norwegian, Danish, Dutch, Greek, Romanian, Bulgarian, Croatian, Serbian, Slovak, Slovenian, Estonian, Latvian, Lithuanian, Hindi, Indonesian, Vietnamese, Hebrew). It is a
  fixed language like the others, so the context names it, the voice plan and the voice request carry its code and V's lines follow it. It needs a text provider (not Convai,
  which keeps the routing Automatic and says so in the log) and a voice that speaks it: OmniVoice, or Voxtral for the languages Voxtral TTS 3 lists. Pocket never speaks it
  (`other-language-pocket`: the reply is shown as text with a message that names the language and the voices that can).
- **Automatic** is the detection of this page, made harder to fool after the live finding of 2026-10-23: "hows biz" typed to Alex (Pocket voice, automatic)
  was detected as Turkish, went to the Turkish-speaking twin, Pocket could not voice it and the reply was text only.
  - A **short** line (fewer than 4 words or 20 letters) in Latin letters is solid evidence only when the word lists made the call (not the character model)
    AND it holds a letter English does not write (é, ñ, ß, ı, ¿ ...). Anything else ("hows biz", "wassup", "yo choom", "nova", "preem") never moves the
    conversation, nor does the remembered language lose to it. Other scripts are solid at once (`assessLanguage` in `bridge/reply-language.mjs`).
  - **Hysteresis**: the conversation's language changes on a solid detection that is also a **long** line (5 words and 24 letters, or a few letters of
    another script), or the second solid detection of that language in a row, or a line of three words or more that agrees with the prior. A different
    language, or a line in the conversation's own language, restarts the count. The check is done by `MultilingualConversations.judge`; the state is
    committed once the turn is published (`observeTurn`), and a reply counts only for a turn whose own text had no language (a recording).
  - **The prior**: the language the player was heard in (the microphone's last language, the remembered `player-language.json`) and the game's own text
    language (`runtime/ui-language.txt` or the Interface language setting, `SpeechLanguage.uiPrior`, read at most once in a few seconds).
  - The same guard keeps the microphone's recogniser from following a short misdetected line (`SpeechLanguage.observeText`).
- **V's own line** has its own language (`lineLanguage`): English unless solidly in another language or a fixed one is chosen, so it still plays when
  it is English even if the reply cannot be voiced.

Tests: `bridge/reply-language-setting.test.mjs` (the 36 short English and Night City lines that must stay English, real French, Spanish, German, Japanese and
Turkish lines that must switch, the prior, the fixed routes), `bridge/manager.test.mjs` (the row), `bridge/settings-file-lua.test.mjs` (persistence).

### Routing

- The bridge loads `runtime/multilingual-profiles.json` at start. A twin is used only when its entry is
  `verified: true`, `languageBoxOff: true` and its `originalCharacterId` equals the ID the mod uses today
  (`runtime/characters.json`); anything else stays on the
  original and is logged as "Multilingual profiles not used". No map is an English-only installation.
- Each twin becomes provider key `<providerKey>-multilingual` (`judy-alvarez-multilingual`)
  in the original's family (`judy-alvarez`).
- **Per turn, from the message** (`wantsTwin`, `twinForTurn`): a message clearly in another language goes to the twin of THE character's profile; a message
  clearly in English (three words or more) goes to the ordinary character; anything unclear ("ok", one word, a recording with no text yet, a reaction) stays where
  the conversation is (the twin while it was last in another language, a microphone hint counting when nothing was said yet). A reaction never starts a twin
  conversation. The relationship style (Auto / Romantic / Ordinary) does not pick the profile, it only decides the romance block of the turn's context. A profile
  without a usable twin keeps its original. Twins are used only on the free shared Convai plan: a player's own key (one session, no twins) and any text
  provider answer with the ordinary character.
- Nothing is committed or retired when the language changes: `PlayerKnowledge.prepare` receives the turn's text, asks `select(profile, boundary,
  {multilingual})` and freezes the route (provider key, character ID, session scope) for that turn. Warm connections have no message and stay on the ordinary
  character, so a language change never re-warms every nearby character on its twin; only the character being talked to opens a twin session.
  Guards on either ID of a character are current (`guardSelected`).
- **Cost of a switch.** The twin is another Convai character: its first turn opens a new realtime session (a connection and a session
  start, nothing measured live yet for the twin path) and, in the shipped backend mode, no memory checks are made from the player's machine. Within a
  French conversation every turn after the first goes to the twin and its open session. Switching back to English returns to the original's session.
  Because the choice is made per message, a bilingual player can cost one new session per language change; the rules above (three English words to
  switch back, unclear lines stay) keep that to real changes.
- **Memory.** A twin has its own Convai memory and its own session history, so what the player said in English is not known to the twin (and the other way
  round); nothing is copied. The mod's own context (world, relationship, phone recap, quests) is rebuilt for every turn and is the same for both, so
  the character keeps its knowledge of the world and the relationship; only Convai's long-term memory of past conversations and the in-session history are
  split by language. The bridge-side text routes (Mistral, Local AI, Custom) have one memory and are not affected.

### Memory and Forget

- A twin is its own character for Convai memory (character ID + player ID), so its memories are separate from the
  original's (nothing is copied; there is no memory-add API).
- The twin keys are in the family map (`providerFamilies`) used by player memory, the Forget command and chat
  history resets, so Forget for a character clears the profile and its twin, and Forget all
  clears every twin the player talked to. The Memory screen shows the canonical character only.
- `PlayerMemoryApi` checks each twin's own marker (`markerKeys`: `[CyberpunkConvai profile v2:<key>:multilingual]`);
  an original's marker on a twin ID, or the reverse, is refused (`NOT_MOD_OWNED`).

### Voices

No voice setting is moved, refused or switched any more (the staged-Apply rules of the old setting are gone). The voice of each turn is planned from the
message and checked against the finished reply (`planTurnVoice`, `replyVoice`; the bridge passes `textProvider: true` on every route):

- English: the chosen voice, untouched (the characters' Spanish slang is never muted).
- OmniVoice speaks any language and is told the reply's language. The Voxtral voice speaks the languages Voxtral TTS 3 lists (38 since 2026-10-31, before that the 22 Mistral's announcement named, which left Czech as text), the language of the text. The Inworld voice speaks the 94 languages of Tier 1 and 2 of TTS-2 Flash (all 15 of the mod's among them), and the request carries the language code.
- Pocket TTS (English only, plus the languages with an installed PocketTTS model and voice pack) and Voxtral or Inworld for a language they do not list keep the plan; a reply in another language is shown as text, with one
  `voice-language` notice per game session (and one `pocket-pack-<language>` notice per language when the PocketTTS model is installed but its voice pack is not). The Convai cloud voice is only the voice when the player chose it (the twins have Azure multilingual voices).
  No voice ever hands a reply to a cloud voice it was not chosen for.
- An OmniVoice choice that cannot run shows the replies as text, never Pocket in its place and never a cloud voice (`VoiceSelection.resolve`, route `text`;
  changed 2026-10-21, before it fell to the cloud voice). A chosen Voxtral voice that cannot be asked (no key, a limit, a refused key) or a language it does not speak is shown as text as well, never given to the Convai voice (changed 2026-10-21, before it fell to the Convai voice, cloud to cloud).
- A turn the cloud voice speaks gets no Natural speech or Expressive emotions (emotion tag) instructions.
- The expected language is the player's message (detector above), else the language of the last exchange (reactions, the microphone placeholder, warm
  connections), else English. A reaction's reply does not set the conversation's language.
- Checked on 2026-10-07 with Judy's reference: en, es, ja, de, zh, ru all render with the Omni worker (16 steps).

### Known limits

- **Microphone:** the player's speech is transcribed by Convai's server STT through the realtime SDK (no local
  recogniser; the PocketSphinx "US English" model is only the lip-sync phone analyser). The SDK has no STT language
  field; recognition follows the character's languages, and the twins list only `en-US` by default. Speaking another language
  into the microphone is untested and probably transcribes as English. To try it, list the player's languages on a twin:
  `node scripts/Create-MultilingualProfiles.mjs --apply --languages es --only judy-alvarez` (en-US first, then each language
  as its Convai code: `es-ES`, `ja-JP`, ...; `all` lists the 15 interface languages; the language box stays off; an existing
  twin is updated and read back; running again without `--languages` puts it back to en-US). Not yet checked live
  (TODO.md, "Multilingual follow-ups"). Text chat works in any language.
- **Lip sync:** the facial model is trained on English game audio but works from audio alone, so the mouth still moves
  for other languages, with English-shaped visemes.
- **Subtitles and phone chat:** the text path is UTF-8 safe (character-based splitting, no byte truncation of reply
  text). The game draws reply text in the font of the selected game language, so CJK or Cyrillic replies with an
  English game language may show missing glyphs. Since 2026-10-14 the mod picks a `ui-fonts.lua` family from the
  script of the reply itself (`scriptCode`/`replyCode`: kana Japanese, Hangul Korean, Han Chinese, Cyrillic Russian)
  and gives it to the owned subtitle widgets (overhead and dialogue HUD, `mod/subtitles.lua`) and to the chat
  messages in the phone (`mod/phone-chat-style.lua`, three timed passes after a present); a Latin reply costs
  nothing and every font is put back when the reply ends. Unit-tested only; not yet checked in game (TODO.md).
- **Cloud voice:** with the Convai cloud voice, a twin speaks with its Azure multilingual voice (see "Voices"),
  not the original Kokoro voice, also in English.
