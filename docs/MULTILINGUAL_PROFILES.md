# Multilingual Convai profiles (full roster)

Every character the mod has a Convai profile for (all 79 in `characters/roster.json`
with an ID in `runtime/characters.json`) has a twin named "<name> Multilingual" in the
same account, and so does each relationship variant. Today the only variants are the
five romantic profiles (Judy, Panam, River, Kerry, Meredith), so there are 84 twins.
The twins exist and are verified; the mod uses them while Settings > Conversations > Multilingual
conversations is on (see "Multilingual conversations" below).
Alt Cunningham is a tier-1 voice but has no Convai profile.

```powershell
node scripts/Create-MultilingualProfiles.mjs --dry-run        # default: plan only, no remote calls
node scripts/Create-MultilingualProfiles.mjs --apply          # create/adopt + verify all 84
node scripts/Create-MultilingualProfiles.mjs --apply --only judy-alvarez,judy-alvarez-romantic
node --test bridge/multilingual-profiles.test.mjs
```

The mapping is `runtime/multilingual-profiles.json` (ignored by Git, no secrets):
per profile key (a roster key, or `<key>-romantic`) the original ID, twin ID, name, voice, language list, model,
`verified`, `languageBoxField`, `languageBoxOff` and `notCloned`. Romantic twins are
keyed `<key>-romantic` (the provider key used in `runtime/relationship-profiles.json`)
and also record `variant: "romantic"` and `baseKey`. Only new characters are created;
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
| Romantic original | `[CyberpunkConvai profile v2:<key>-romantic]` |
| Romantic twin | `[CyberpunkConvai profile v2:<key>-romantic:multilingual]` |

The romantic original has the same Convai display name as the ordinary profile (for
example both are "Judy Alvarez"), so the ordinary twin and the romantic twin are both
named "Judy Alvarez Multilingual". Tell them apart by character ID or marker, never by
name. (The name can be changed on the twin later without affecting the script, which
matches on name plus marker only to recover a lost create receipt.)

## What a twin copies and what differs

Copied and read back: biography (only the ownership marker line differs, so a twin
never matches its original's marker or another twin's), speaking style description,
sample dialogues, model (list readback), memory enabled, state of mind, verbosity,
and every other compared setting (moderation, filters, guardrails, traits, listing,
actions, narrative flag, temperature, and so on; any difference is listed in
`notCloned`, all empty today). A romantic twin clones the romantic profile, including
its added "CONVERSATION PROFILE" paragraph and affectionate style and samples.

Different on purpose:

- **Voice.** Convai refuses non-English `languageCodes` on a Kokoro voice
  ("Given voice incompatible with the language code"). Twins use an Azure multilingual
  voice (71 languages, English included) chosen per character; see "Voices" below. The
  original Kokoro voice is not kept, but it and the profile decide the gender, age and tone
  of the match. Gender comes from the original Kokoro voice, falling back to the roster's
  `gender` field (the dry run lists any key that needed the fallback; none did, and the two
  sources agree for the whole roster). The mod mostly speaks with its own local voices, so
  this matters only for Convai cloud voice. Romantic twins use the voice of the ordinary
  profile of the same character.
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

Status (2026-10-07): all 84 twins (23 tier-1, 5 romantic, 56 for the rest of the roster)
have the box off, set through the web session and verified by readback, and are marked
`languageBoxOff: true` in the mapping.

## Voices

Before 2026-10-08 every twin used one of two voices (Emma for women, Christopher for men). Each twin now has a
voice chosen for its character. The choice lives in `characters/multilingual-voice-map.json` (per roster key: voice ID,
voice name, one-line reason; romantic twins follow their base key), which `scripts/Create-MultilingualProfiles.mjs` reads.
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
| Convai, GCP Realtime, Fish Audio, Inworld | 0 | Single-language voices. |

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
| Judy Alvarez (+ romantic twin) (`judy-alvarez`) | Ava | Bright, engaging voice for a young braindance editor (romantic twin shares it). |
| Kerry Eurodyne (+ romantic twin) (`kerry-eurodyne`) | Lewis | Higher, animated male voice for a flamboyant rock singer (romantic twin shares it). |
| Liam Northom (`liam-northom`) | Ollie | Young British-native male voice for a smooth pop-star manager. |
| Life Coach (`life-coach`) | Yunfan | Even, encouraging mid male voice for a coaching contact. |
| Lina Malina (`lina-malina`) | Emma | Upbeat, forceful female voice for a braindance performer. |
| Lizzy Wizzy (`lizzy-wizzy`) | Phoebe | Highest female register, theatrical, for a conceptual pop star. |
| Mama Welles (`mama-welles`) | ShimmerTurbo | Low, warm, commanding female voice for a restaurant owner and mother. |
| Mark Bana (`mark-bana`) | Macerio | Brazilian Portuguese-native male voice for a veteran of the Brazilian Intelligence Agency. |
| Meredith Stout (+ romantic twin) (`meredith-stout`) | Evelyn | Mature, straightforward, believable voice for a senior Militech executive (romantic twin shares it). |
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
| Panam Palmer (+ romantic twin) (`panam-palmer`) | NovaTurbo | Energetic, low-mid, slightly husky voice for a feisty nomad (romantic twin shares it). |
| Pepe Najarro (`pepe-najarro`) | Brian | Casual, sincere voice for a worn-out family bartender. |
| Placide (`placide`) | Lucien | Deep French-native male voice for a Haitian Voodoo Boy elder. |
| R3n0 (`r3n0`) | Ada | Clear British-native female voice for a guarded netrunner. |
| Rachel Casich (`rachel-casich`) | Jenny | Friendly, brisk American voice for a commercially minded braindance producer. |
| Regina Jones (`regina-jones`) | Xiaochen | Confident, broadcast-style voice for a Chinese-heritage fixer and former reporter. |
| River Ward (+ romantic twin) (`river-ward`) | Dustin | Soft-spoken, calm, trustworthy male voice for a detective (romantic twin shares it). |
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
node scripts/Create-MultilingualProfiles.mjs --apply --voices-only --only judy-alvarez,judy-alvarez-romantic
```

`--voices-only` reads each mapped twin, checks its ownership marker, and sends `/character/update` with `charID` and
`voiceType` only, and only when the voice differs. It then reads the twin back and fails that profile unless the voice
changed and every other field of the readback is identical to the read before the update. Originals are never read or
written in this mode. It records the voice in the mapping's `voiceType`. Requests are 1.6 s apart.

### Verification (2026-10-08)

All 84 live twins were read before and after (`/character/get`), together with their 84 originals. Result: the voice of
all 84 twins equals the map (52 distinct voices; 80 twins changed, 4 already had their mapped voice: Alex, Lina Malina
(Emma), Mitch Anderson, Solomon Reed (Christopher)); no other field of any twin changed (backstory, speaking style,
`language_codes` `['en-US']`, model, memory, state of mind, verbosity and the rest all identical); no original changed;
each romantic twin has its ordinary twin's voice; the mapping file changed only in `voiceType`. The credit-cost estimates
inside `memory_settings` (`kb_min_credit_cost_e8`, `ltm_min_credit_cost_e8`) flip between two reads of the same
character, so the comparison ignores keys ending in `min_credit_cost_e8`; they are computed, not settings.

## Voice and memory

- Voices stay Azure multilingual (Kokoro rejects non-English); see "Voices" for the per-character choice.
- Memory is per profile: Convai long-term memory is scoped by character ID plus
  end-user ID, so each twin keeps its own memory, as if it were another character.

## Multilingual conversations (the mod setting)

Settings > Conversations > **Multilingual conversations**, off by default (`multilingualConversations` in
`runtime/settings.json`). Code: `bridge/multilingual.mjs` (twin map, setting, per-turn voice),
`bridge/reply-language.mjs` (language detection), `bridge/relationship-routing.mjs` (twin selection),
`bridge/voice-selection.mjs` (no Pocket fallback while on), `mod/manager.lua` / `mod/mcm.lua` (setting, staged Apply).

### Routing

- The bridge loads `runtime/multilingual-profiles.json` at start. A twin is used only when its entry is
  `verified: true`, `languageBoxOff: true` and its `originalCharacterId` equals the ID the mod uses today
  (`runtime/characters.json`, or `relationship-profiles.json` for `<key>-romantic`); anything else stays on the
  original and is logged as "Multilingual profiles not used". No map is an English-only installation.
- Each twin becomes provider key `<providerKey>-multilingual` (`judy-alvarez-multilingual`,
  `judy-alvarez-romantic-multilingual`) in the original's family (`judy-alvarez`).
- On, relationship routing first decides ordinary or romantic exactly as before (Auto / Romantic / Ordinary, the
  same save facts), then the twin of THAT profile is used. A profile without a usable twin keeps its original.
- The setting commits at the same idle boundary as the relationship modes; every character with a twin is
  marked changed once, so its warm connections are replaced with the new character ID.

### Memory and Forget

- A twin is its own character for Convai memory (character ID + player ID), so its memories are separate from the
  original's, and switching the setting starts on the other profile's memories (nothing is copied; there is no
  memory-add API).
- The twin keys are in the family map (`providerFamilies`) used by player memory, the Forget command and chat
  history resets, so Forget for a character clears the original, the romantic profile and both twins, and Forget all
  clears every twin the player talked to. The Memory screen shows the canonical character only.
- `PlayerMemoryApi` checks each twin's own marker (`markerKeys`: `[CyberpunkConvai profile v2:<key>:multilingual]`);
  an original's marker on a twin ID, or the reverse, is refused (`NOT_MOD_OWNED`).

### Voices while it is on (staged Apply, `mod/manager.lua` `resolveMultilingualVoice`)

Pocket TTS speaks only English, so turning the setting on also switches Companion voices in the same Apply, with a
one-time notice:

| Situation at Apply | Result |
| --- | --- |
| Turned on, Omni pack installed, voice Pocket or Convai | OmniVoice · Balanced (16 steps, short reference: the lightest Omni) |
| Turned on, voice already an OmniVoice tier | kept |
| Turned on together with Convai · Cloud voice chosen in the same Apply (no tag setting on) | kept |
| Turned on, no Omni pack | Convai · Cloud voice; Natural speech and Expressive emotions turned off (Multilingual wins: the cloud voice would read their tags aloud) |
| On, Pocket chosen | refused: "Pocket TTS speaks only English. Turn off Multilingual conversations to choose it." |
| On, no pack, Natural speech or Expressive emotions turned on | refused, with the reason |
| On, pack installed, a tag setting with the cloud voice | voice moves to OmniVoice · Balanced (never to Pocket) |
| Turned off | the voice stays as it is |

Refusing Pocket was chosen over turning Multilingual off: a voice change that silently drops another feature would be
surprising, while the refusal keeps the draft pending and says exactly what to do. With the pack, all three settings
work together. A saved file that pairs Multilingual with Pocket (hand-edited) is read as the cloud voice, and a saved
cloud voice with a tag setting has the tag settings turned off.

### Voice per turn (the safety net)

With the voice always OmniVoice or the cloud voice, the per-turn plan (`planTurnVoice`, `replyVoice`) mostly passes
the chosen voice through. It still guards the edge cases:

- A turn the cloud voice speaks never gets the Natural speech or Expressive emotions instructions.
- OmniVoice is told each reply's language (ISO 639-1); English requests are unchanged.
- While the setting is on, an OmniVoice choice that cannot run falls back to the cloud voice, never to Pocket
  (`VoiceSelection.resolve`). If a turn still ends up on Pocket, a turn expected in another language goes to the cloud
  voice, and a reply in another language is shown as text rather than read by Pocket.
- The expected language is the player's message (script, function words, greetings), else the language of the last
  exchange (reactions, the microphone placeholder, warm connections), else English.
- Checked on 2026-10-07 with Judy's reference: en, es, ja, de, zh, ru all render with the Omni worker (16 steps).

### Known limits

- **Microphone:** the player's speech is transcribed by Convai's server STT through the realtime SDK (no local
  recogniser; the PocketSphinx "US English" model is only the lip-sync phone analyser). The SDK has no STT language
  field; recognition follows the character's languages, and the twins list only `en-US`. Speaking another language
  into the microphone is untested and probably transcribes as English. Text chat works in any language.
- **Lip sync:** the facial model is trained on English game audio but works from audio alone, so the mouth still moves
  for other languages, with English-shaped visemes.
- **Subtitles and phone chat:** the text path is UTF-8 safe (character-based splitting, no byte truncation of reply
  text). The mod sets no font on reply text; the game's font for the selected game language draws it, so CJK or
  Cyrillic replies with an English game language may show missing glyphs (to check in game).
- **Cloud voice:** with the Convai cloud voice, a twin speaks with its Azure multilingual voice (see "Voices"),
  not the original Kokoro voice, also in English.
