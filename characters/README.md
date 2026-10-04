# Cyberpunk conversation profiles

The source of each named profile is in `research/contacts-a.json` through `contacts-e.json`. The phone catalog defines the supported physical character identities. Contact aliases share one profile; multiple copies of a character share that identity for group speaker selection.

## Profile content

Each researched profile separates established background, conditional quest events, relationships, editorial speaking direction and original dialogue examples. The examples are new writing, not transcriptions of the game's performances. Source links and uncertainty notes remain in the research and exported roster.

Current save outcomes are not inferred from spawning a companion. A summoned Jackie, for example, does not establish a quest outcome. Impersonation, historical character versions, optional romances and branching deaths need explicit context. Sparse biographies are recorded as sparse rather than extended with invented personal history.

The Convai profile uses three separate fields: biography in `backstory`, delivery guidance in `speaking_style_description`, and original examples in `speaking_style_sample_dialogues`. The last two must not be embedded in the biography. The roster stores them as `speakingStyleDescription` and `speakingStyleSampleDialogues`; readable exports label all three sections. See [the API request and readback contract](../docs/CHARACTER_API.md).

The API's sample field contains only the character's spoken words, separated by
blank lines. Do not add name/speaker prefixes or V's prompt: the model may say
those labels aloud. Source research can retain paired examples; both builders
export only the original character response and preserve third-party names.

`profile-settings.json` records the model verified through the reference character's Core API data. `kokoro-voices.json` is the public voice selection data read from Convai on the recorded date. Voice casting is editorial; these are Kokoro voices, not replicas of the original actors.

## Build and apply

1. Run `npm run build:profiles` to validate coverage and rebuild `roster.json`, `profile-text/`, and the build report.
2. Run `npm run profiles:plan` to review the intended profiles without writing to Convai.
3. Run `node scripts/Provision-Characters.mjs --apply` to create missing mod profiles and update the project's mapped profiles. `--only key1,key2` limits a run.

The provisioning tool reads the ignored local key file, retains existing IDs, backs up prior descriptions, checks account ownership, validates biography, speaking style, sample dialogues and voice after writing, and checks the model in the final character list. Ambiguous create failures are not automatically repeated. A subsequent run looks for the project ownership marker before creating another character. The PowerShell entry point now delegates to the same Node implementation and also requires `-Apply` for writes.

Convai's API labels accept only letters, numbers and single spaces. Punctuation is replaced with spaces in those labels; canonical names such as Chang-Hoon Nam and T-Bug remain intact in the game and character instructions.

Credentials, character IDs, API responses and backup snapshots stay in ignored `runtime/`. Never copy those into a release. Another account needs its own provisioning run. Existing memory settings are preserved; the tool does not enable shared long-term memory across private and group sessions.

## In-game behavior

Private text uses the addressed identity. Group text uses that identity first, then at most two different nearby supported companions; duplicate copies count once. The input heading shows only the addressed name. Assign these actions in CET's Bindings; the mod does not impose particular keys. Characters unlocked later in the phone use the same mapping when they become available. Service contacts and unmapped drones do not become walking NPCs through conversation profiles.

Source validation and API readback establish configuration correctness. They do not establish the quality of every in-game conversation, follower body, animation or voice. Those require live observations and are tracked in the [current handoff backlog](../HANDOFF_README.md#11-remaining-work-in-practical-order-after-resumption).
