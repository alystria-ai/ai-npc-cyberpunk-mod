# Convai character fields

## Three separate text fields

Character creation uses `POST https://api.convai.com/character/create` with
`CONVAI-API-KEY` and `Content-Type: application/json` headers. Keep these three
pieces of content separate in the JSON body:

| Request field | Content | Roster source |
| --- | --- | --- |
| `backstory` | Identity, factual background, conditional story knowledge, relationships and knowledge limits | `backstory` |
| `speaking_style_description` | Tone, mannerisms, speaking rules and delivery guidance | `speakingStyleDescription` |
| `speaking_style_sample_dialogues` | Original examples of how the character talks, formatted as one string | `speakingStyleSampleDialogues` |

Do not append the last two to the biography. `charName` names the character,
`voiceType` selects the Convai voice, and this project also sends
`model_group_name` to retain the verified reference LLM. A voice selection is
independent of speaking style.

```sh
curl --location 'https://api.convai.com/character/create' \
  --header 'CONVAI-API-KEY: <YOUR_API_KEY>' \
  --header 'Content-Type: application/json' \
  --data '{
    "charName": "Demo Companion",
    "voiceType": "<SELECTED_VOICE_VALUE>",
    "backstory": "A fictional mechanic living in Night City.",
    "speaking_style_description": "Direct and friendly, with concise practical explanations.",
    "speaking_style_sample_dialogues": "V: Got a minute?\nDemo Companion: Sure. Tell me what needs fixing."
  }'
```

This is POSIX shell syntax. On Windows use the PowerShell entry point below;
its local credential file supplies the header without embedding a key in source.
Replace the example voice value with a supported voice. The mod retains each
character's existing Kokoro selection.

The endpoint and basic name/voice/backstory fields are described in the
[Convai Character Base API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api).
The two speaking-style request names above follow the integration example
supplied on September 29, 2026. Their update/readback was verified against all
79 existing mod profiles; the older public base-API examples omit them.

## Updating existing characters and checking readback

Send the same fields to `/character/update`, with the existing `charID` added.
Retrieve that character with `/character/get` and compare:

| Sent field | Returned field |
| --- | --- |
| `backstory` | `backstory` |
| `speaking_style_description` | `speaking_style.description` |
| `speaking_style_sample_dialogues` | `speaking_style.sample_dialogues` |

The response's nested `speaking_style` object is not the request format.
Successful biography/voice verification alone is insufficient. Both style
strings must match, and the character ID must remain the requested ID.

## Project workflow

```powershell
npm run build:profiles
npm run profiles:plan
node scripts/Provision-Characters.mjs --apply
# A focused run uses the same implementation:
.\scripts\Provision-Characters.ps1 -Apply -Only judy-alvarez
```

Both entry points plan by default; `--apply` or `-Apply` performs remote writes.
The PowerShell script delegates to the Node implementation so their payloads,
ownership checks and readback cannot drift apart.

- `Build-CharacterProfiles.mjs` separates all named and ambient profiles.
- `character-payload.mjs` maps the three roster strings to their exact API keys.
- Provisioning validates every selected profile before writing, keeps existing
  IDs, backs up previous remote values, and verifies all three fields afterward.
- Existing memory configuration is compared before and after each update.
  The API's `ltm_min_credit_cost_e8` and `kb_min_credit_cost_e8` cost estimates
  are excluded from that comparison; memory enablement is not.
- Model verification still comes from the final character list.
- `profile-text/*.txt` labels the three fields for local review. These complete
  review documents must never be uploaded wholesale as `backstory`.
- The existing v2 ownership marker is retained for interrupted-create recovery;
  generated profile revision 3 describes the new three-field content format.

Credentials are read from ignored `runtime/convai-key.txt` (`api-key=...`) or
`CYBERPUNK_CONVAI_KEY_FILE`. Remote snapshots, mappings and verification reports
remain under ignored `runtime/`. Examples and tracked source use placeholders.

## Migration verification — September 30, 2026 (IST)

All 77 named characters and both ambient residents were updated in the existing
account and read back successfully. Each biography, style description and
sample-dialogue string exactly matched its corresponding generated field.
No characters were recreated. Existing IDs, names, voices, reference model and
memory configuration were preserved; dynamic API credit estimates were excluded
from the memory comparison.

The installed roster was synchronized and hash checked. The background
conversation service was refreshed while Cyberpunk stayed running, with saved
phone session mappings intact. This verifies profile configuration; conversation
quality across the whole cast still requires in-game observations.

Four provisioning regression checks and the character-routing check passed.
The local readback receipt is `runtime/profile-field-migration-verification.json`;
previous cloud values and exact returned fields are backed up beneath the batch
directory recorded there. These account-specific files remain ignored by Git.
