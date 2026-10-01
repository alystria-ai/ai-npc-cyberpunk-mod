# Wave 3: Blue Moon, Lizzy Wizzy and Rachel Casich

Reviewed against the installed Cyberpunk 2077 2.31 resources on October 1,
2026. These are **authoring proposals, not adopted profiles**:

- `native-character-proposals-wave3/blue-moon.json`
- `native-character-proposals-wave3/lizzy-wizzy.json`
- `native-character-proposals-wave3/rachel-casich.json`

No generated pack, roster, cloud character, user memory, installed game, voice
configuration or audio reference was changed. The parent owns independent
review, compilation and adoption.

## Reviewed coverage

| Character | Public claims | Original examples | Source artifacts | Exact refs |
| --- | ---: | ---: | ---: | ---: |
| Blue Moon | 6 | 6 | 4 | 447 |
| Lizzy Wizzy | 11 | 6 | 4 | 424 |
| Rachel Casich | 8 | 6 | 6 | 556 |
| Total | 25 | 18 | 10 distinct pairs | 1,427 |

The same current journal and English onscreen resources are reused as shared
subject evidence, not counted as separately acquired versions of the people.
Every selected source has exact winning archive SHA-1, raw SHA-256, serialized
JSON SHA-256, and a pinned WolvenKit 9.0.1 serializer receipt. Every proposed
speaker line has an actual typed dialog event, screenplay item, exact speaker
ID, actor name, voice tag, English locale descriptor and payload, and same-ID
shipped English subtitle. **All selected embedded lines match a shipped English
variant exactly.** The verification does not turn a future-oriented or optional
line into current-save history.

## Subject identity and actor ledger

### Blue Moon

Her genuine individual identity is a phone contact, not a fabricated individual
codex entry:

```text
journal /Data/RootChunk/entry/Data/entries/3/Data/entries/122/Data
  $type = gameJournalContact
  id = blue_moon
  name/value = LocKey#10585
  avatarID/$value = PhoneAvatars.Avatar_Blue_moon
english /Data/RootChunk/root/Data/entries/6890
  primaryKey = 10585
  femaleVariant = Blue Moon
```

The freshly serialized `sq017_10_us_crack_intro.scene` binds the actual
`blue_moon` actor at `/Data/RootChunk/actors/1`, actor ID 1, voice tag
`1792259170252005376`. Its acquisition is community entry `sq017_blue_moon` at
`#sq017_com_blue_moon`. These proposal receipts establish a named dialog
speaker; they **do not claim to resolve that NodeRef to a spawn record**.

The typed Us Cracks codex at journal character entry 43 has ID
`us_cracks_blue_moon_purple_force_red_menace`, title LocKey#20450 and description
LocKey#20452. It is cited only as contextual corroboration of her band
membership, alongside the independently bound Blue Moon subject and her own
speech. It never replaces her individual contact subject or grants her the
other members' private history. Codex-only formation, American-born Japanese
background, genre and promotional-persona claims remain held in this proposal
rather than disguised as self-spoken biography.

The selected expansion gives her concrete work and taste: recording work,
singles and tracks in progress, admiration for another artist, label/artist
agency, de-escalation and asking what the other person actually wants, and a
small preference for azaleas. The cover agreement is not proof the current V
visited Riot, Kerry consented, a concert was cancelled or the dispute resolved.
Her constructive manner does not require childish helplessness, mandatory
honorifics or an exaggerated accent.

The separate Us Cracks television scene was freshly exported and inspected but
is **not a selected claim source**. The performed excitement about Night City
and the equipment-truck incident would add publicity and current quest history,
not a reliable new general biography.

### Lizzy Wizzy

Her genuine individual codex is:

```text
journal /Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/47/Data
  $type = gameJournalCodexEntry
  id = lizzy_wizzy
  title/value = LocKey#86188
  entries/0/Data/textContent/value = LocKey#86189
english /Data/RootChunk/root/Data/entries/55323
  primaryKey = 86188
  femaleVariant = Lizzy Wizzy
english /Data/RootChunk/root/Data/entries/55324
  primaryKey = 86189
```

`mq019_01_notell_motel.scene` has actual `Lizzy_Wizzy` actor 0 at
`/Data/RootChunk/actors/0`, voice tag `1792218388178575360`. Its ordinary speech
is used for privacy, chrome and emotion, constant scrutiny, ambivalence toward
attention, deliberation and artistic focus. The scene's private trouble is not
preloaded: no suspicion about Liam, copies, investigation, current relationship,
violence, murder or cover-up is universal history.

The public codex supports Elizabeth Wissenfurth's professional identity, stage
work, full conversion associated with MoorE Technologies, and the staged death
and surgical return. It also supports an artistic framing that questions the
future and identity. Praise and criticism stay attributed; neither a description
of worried critics nor her body conversion establishes cyberpsychosis or lost
humanity. No invented mechanism, exact performance date or biological
immortality is added.

Her current creative block and private relationship upset are deliberately not
permanent character traits. The artistic-focus claim selects her expressed
priority without carrying over the private distraction. An unknown player can
encounter a firm boundary without provoking a universal hostile response.

### Rachel Casich

Her individual subject is the actual contact `rachel`, not Cynthia Najarro's
separate `rachel_joestar_mq040`:

```text
journal /Data/RootChunk/entry/Data/entries/3/Data/entries/52/Data
  $type = gameJournalContact
  id = rachel
  name/value = LocKey#10887
  avatarID/$value = PhoneAvatars.Avatar_Rachel
english /Data/RootChunk/root/Data/entries/7174
  primaryKey = 10887
  femaleVariant = Rachel Casich
```

Exact personal actor aliases require coordinator review, with no punctuation
normalization substituted for attribution:

| Native source | Actual actor pointer/name | Voice |
| --- | --- | --- |
| `sq023_07_restaurant.scene` | `/Data/RootChunk/actors/0`, `Rachel` | `1631420577167360000` |
| `sq023_01_rachel_talk_show.scene` | `/Data/RootChunk/actors/1`, `rachel_casich` | `1631420577167360000` |

The TV introduction is actual host `ziggy_q`, actor 0, voice tag
`1669161994995802112`. It expressly names Rachel Casich and credits Maxwell's
Rehab and Cyb3rpsych0sis. This is a **third-party public career attribution**, not
Rachel speaking the introduction and not an objective review of their quality.
It includes the typed Rachel contact/title chain plus the complete host
screenplay/event/English chain. No additional credits, award, year or sole
authorship is invented.

Her actual speech supplies producer identity, an attributed EBM/corporate
studio relationship, enthusiasm for production technology, meditation and a
personal view of spirituality. Presentation can be persuasive, practical,
clipped or profane under pressure, without making every companion utterance a
villain speech. Her polished public pitch about audience insight and possible
sequels is explicitly **a professional delivery example**: it does not prove
The Passion happened, succeeded, redeemed anyone or involved V. Private
bribes, mind-manipulation, deadlines, exact execution arrangements and trade
secrets are not universal biography. Joshua's internal conviction is not hers
to know objectively.

## Source acquisition and reproducibility

Owned isolated evidence:

- `runtime/voice-cast/minor-named/scenes/wave3-performers-intrinsic-oct01/`
  contains three exact newly extracted scenes and winning archive/serializer
  receipts. Extraction used the shared lane lock and two-CPU gate.
- `runtime/voice-cast/minor-named/knowledge-wave3-performers/` contains four
  fresh installed English subtitle extractions/serializations,
  `localization-receipt.json`, exact `line-joins.json`, verification and the
  proposal builder. The same-ID text-difference list is empty for selected
  lines; no text was normalized to force agreement.
- Current hashed journal/onscreen sources are reused from the independently
  acquired `knowledge-wave3-nam-residents` evidence. Lizzy and Rachel's ordinary
  scene sources reuse the freshly serialized and verified `ordinary-dialogue`
  evidence. The builder rechecks their recorded raw SHA-1 and raw/JSON SHA-256.

The builder re-resolves every exact pointer and every expected or hashed value;
it verifies the actual event-to-line join and matching native English text.
This is evidence validation, **not shared compilation or parent adoption**.
No audio decoding, synthesis, model training, GPU work, gameplay test, cloud API
request, conversation or memory seed was performed by this lane.

The 18 examples are original spoken editorial demonstrations supported by the
selected public claims. They contain no character-name prefixes, lyrics,
quotes from the game, fabricated player exchanges or completed quest memory.

## Remaining holds

- Coordinator-reviewed contact/actor aliases are required before the new
  contact branch can accept Blue Moon and Rachel.
- Actual world registry/spawn-set resolution is not claimed from matching
  names, a community entry or an inactive record field.
- More group-only Us Cracks biography requires a explicitly qualified
  contextual codex branch; the current selected self-speech avoids padding.
- Static source evidence is not a current-save outcome. Stalker, Violence,
  Joshua production and private relationship facts remain runtime gated.
