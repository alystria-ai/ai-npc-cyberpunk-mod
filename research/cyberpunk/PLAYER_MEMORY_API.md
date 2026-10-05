# Player memory provider contract

Audited 2026-09-30 against the installed official Convai Web SDK **1.7.0**,
official current documentation, and local provisioning manifests. This audit
made no authenticated cloud requests, created no profiles or end users, and
enabled or deleted no remote memory. API shapes below are source qualification;
the new production flow is not yet qualified by a real conversation and clear.

This document follows the single-ID decision now preserved in [the TODO list](../../TODO.md) and supersedes the
three-ID/anonymous/manual-archive policy at the top of `MEMORY_API_AUDIT.md`.
The existing archive probes must not be resumed to implement this policy.

## 1. Identity and natural memory

- Persist one opaque UUID for the local player. Use that exact `endUserId` for
  all characters, saves, phone, private, group and microphone conversations.
  Save reload and either forget command preserve it.
- An explicit Invite prepares and verifies the selected profile's memory and
  connection before spawning, including while the manager is open. Conversation
  admission can also prepare an actually addressed profile. Polling, world
  capture and unrelated profiles must not initiate setup. Preparation does not
  mark a character contacted; only the player's actual conversation does.
  Never call `/memory/add` or seed synthetic dialogue for this flow.
- Send `endUserId` through the official realtime SDK, and verify the returned
  identity equals the requested UUID and character ID before a player turn.
- Keep separate transient session scopes for channel, audience, world token and
  reset epochs. These do not create separate provider memory partitions.
- A save reload supplies fresh authoritative world context and invalidates old
  session/turn ownership. It retains this player's provider memories.

The Web SDK guide says a stable supplied ID allows automatic conversation
memory without explicit CRUD writes. The official lifecycle explains recall at
connect and fact extraction when the conversation closes. Selection is not a
guarantee that every word or fact will be stored. A shared UUID still leaves each
character with a separate memory set. Private/group sessions for the same
character share that character's LTM; separate session scopes alone cannot
prove that private recollections are inaccessible in a group.
[Web SDK memory guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory),
[official lifecycle](https://raw.githubusercontent.com/Conv-AI/Convai-Documentation/main/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/how-long-term-memory-works.md).

Local primary SDK pointers: `package.json:19`,
`node_modules/@convai/web-sdk/dist/core/ConvaiClient.js:451` (wire identity),
`:577` (returned identity), `:715` (manager initialization), and
`dist/core/types.d.ts:399` (configuration). The legacy HTTP `getResponse` route
has no qualified equivalent end-user memory contract. A phone route needing
this feature must use the identified SDK connection, including text-only TTS
configuration where appropriate.

## 2. Profile ownership before a mutation

Resolve the exact character ID from the trusted local mapping. Require a unique
canonical key to ID relation; no name search, implicit adoption or fallback ID.
The ownership marker remains **v2** even though generated biography/style content
has a newer revision:

```text
[CyberpunkConvai profile v2:<canonical profile key>]
```

Require `detail.character_id === characterId` and a whole trimmed backstory line
equal to the marker for that exact key. Do not accept a substring, a matching
display name, a foreign marker or a marker for a different profile. Preserve the
authenticated `/character/list` membership check used by the local provisioner:
exactly one returned entry must match the mapped ID before enabling or clearing.
Character GET can retrieve public profiles, so a GET result alone is not an
account ownership certificate.
[Character API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api).

Local evidence: `scripts/Build-CharacterProfiles.mjs:94,126,144,166`,
`scripts/Provision-Characters.mjs:57-76`, and
`bridge/knowledge-cloud.mjs:111-123`. The old archive helper's ambient exclusion
is unrelated to the marker: this audit found all 79 roster profiles, including
both `resident-*` profiles, contain their exact marker, every profile is mapped,
and no mapped ID is duplicated. Those local snapshots do not prove current
remote ownership or enablement. `characters-verified.json` is a payload hash
manifest, not a substitute for fresh remote identity/marker readback.

## 3. Exact Core enable wire

Use JSON **POST** to `https://api.convai.com`, with
`Content-Type: application/json` and `CONVAI-API-KEY` in headers. Keep credentials,
raw end-user IDs, provider bodies and memory text out of user diagnostics.

| Purpose | Endpoint | Body | Required readback |
| --- | --- | --- | --- |
| Read profile | `/character/get` | `{ "charID": characterId }` | Root object with matching `character_id`, exact marker and boolean `memory_settings.enabled` |
| Enable natural LTM | `/character/update` | `{ "charID": characterId, "memorySettings": { "enabled": true } }` | Update acknowledgement `STATUS === "SUCCESS"`, then a fresh GET with `memory_settings.enabled === true` |

The write is `memorySettings`; the read is `memory_settings`. Do not send the
snake case readback object as an update payload. The official Unreal memory
proxy constructs this minimal toggle and parses the root readback object.
[Official memory proxy, pinned source](https://github.com/Conv-AI/Convai-UnrealEngine-SDK-V4/blob/98575b10a0b85facd570ed29decb5a65a8b3b49b/Source/Convai/Private/RestAPI/ConvaiLTMProxy.cpp).

Enablement is a character setting, affecting other integrations using that
character ID. Clear targets only the exact character/user pair. Disabling the
character setting is not a per-player clear or a session extraction lock.

The Character API describes omitted character information as preserved. Its
public table does not separately specify nested memory-setting merge behavior.
Keep before/after readback and compare all remaining memory configuration fields
except `enabled` and server cost estimates `ltm_min_credit_cost_e8` /
`kb_min_credit_cost_e8`. A drift is a failed verification, not permission to
guess a larger payload or automatically roll back a remote setting. No
biography, speaking-style, voice or model fields belong in this toggle.
[Character update contract](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api#update-character).

Provider interface agreed with the local memory owner:

```js
await provider.enableMemory({profileKey, characterId, endUserId, signal});
// {enabled: true, changed: boolean}
```

If the first verified GET is already enabled, return `changed:false` without an
update. A verified false -> update -> true sequence returns `changed:true`.
Missing/malformed memory settings, ownership mismatch, API rejection or failed
readback fail the conversation admission. An ambiguous update cannot be treated
as known unchanged. The caller reconnects the exact character's old warmed
connections when `changed` or the previous enable outcome is unknown, before
the first send. No UUID rotation or reset-epoch change is needed for enablement.

## 4. Exact clear and list wire

The installed `MemoryManager.js:70-95,157-164,219-242` establishes these JSON
POSTs to `https://api.convai.com`. Authentication accepts the backend API key
header above, or `API-AUTH-TOKEN` for the SDK's explicit token mode.

| Operation | Endpoint | Exact body |
| --- | --- | --- |
| Clear one character/user pair | `/memory/delete-all` | `{ "character_id": characterId, "end_user_id": endUserId }` |
| Observe remaining memory | `/memory/list` | `{ "character_id": characterId, "end_user_id": endUserId, "page": 1, "page_size": 1 }` |

`MemoryDeleteAllResponse` declares `message`, `character_id` and `end_user_id`.
Validate exact echoed identity when provided; mismatch is never acceptance.
Do not interpret the status text as completed deletion. Require a well-formed
success response without `ERROR`, `API_ERROR` or `INTERNAL_ERROR` fields.

`MemoryListResponse` declares `memories`, `total_count`, `page`, `page_size` and
`has_more` (`types.d.ts:886-911`). For a strict empty observation require:

```js
Array.isArray(value.memories) && value.memories.length === 0
  && value.total_count === 0
  && value.page === 1 && value.page_size === 1
  && value.has_more === false
```

A total of zero with records, a negative/noninteger total, bad pagination, an
error envelope or a malformed response is not empty. Checking page one is
sufficient when this total is valid; there is no need to download the user's
memory text. Treat a 404 as a failed/unknown readback, not automatically empty.
Do not open a synthetic connection merely to make clear/list succeed.

The official SDK and Web guide explicitly describe bulk deletion as
asynchronous and recommend list readback. A bounded implementation can send
**one** delete request, wait briefly, then poll list with a deadline, capped
attempt count and per-request/body limits. A fixed delay is not confirmation.
[Official Web memory guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory#delete-all-memories).

```js
await provider.clearMemory({characterId, endUserId, signal});
// {accepted: true, providerEmptyObserved: true | false}
```

`providerEmptyObserved:true` means a valid empty list was seen after this
command's transport close and accepted delete. It does not mean extraction was
drained. Accepted delete with nonempty list or exhausted polling returns false
or a sanitized failure; the core retains an uncertain clear and blocks affected
conversation admission. A write timeout, abort/network failure after dispatch,
5xx or untrusted success body throws a sanitized code with `writeUncertain:true`.
No automatic destructive retry is allowed. An error before dispatch has no
ambiguous write; known HTTP rejection still does not establish empty memory.

## 5. Close old sessions before clearing

For an explicit UI command, the coordinator durably records its command ID,
original UUID and exact target IDs, increments the appropriate reset epochs,
blocks affected new admissions/warmup, and invalidates stale turns before
remote deletion. "All" uses a snapshot of contacted characters, not all account
profiles, and retains that contacted registry for future clears.

Abort pending private/group/phone/microphone work, stop owned microphone tracks
without submitting end-of-input, cancel warm/reconnect tasks, and disconnect
the affected old SDK clients. Dispose their page/browser leases and discard
their cached conversation IDs. After clear, reconnect with session ID `-1` and
the unchanged player UUID; never reuse the old transcript session. A conservative
host-wide close is acceptable if exact character disposal is unavailable.

Local shutdown seam: `bridge/realtime-client.mjs:22-45` already starts transport
disconnect before stopping microphone hardware, without normal `disableAudio`
submission. `bridge/realtime-host.mjs:204-225` cancels microphone leases and
closes pool/browser ownership. Current pool disposal closes pages directly; it
does not itself call the browser client close method. Prefer bounded SDK close
while the page is alive, then force disposal if needed. Force disposal confirms
local ownership ended, not the provider's extraction progress.

SDK `ConvaiClient.disconnect():818-847` catches transport errors and clears
local managers; resolving it is not a provider flush receipt.
`resetSession():879-884` changes local session/message state only. It does not
disconnect, delete LTM or revoke server work. Memory-manager state is cleared
on disconnect, so use a separate captured exact-pair backend adapter for clear;
do not borrow the now-null live-client manager or mutate its IDs during a command.

## 6. Honest completion and recovery

The provider extracts conversation facts on session close, while delete-all is
also asynchronous. Closing first prevents additional local sends, but an earlier
extraction may finish after an empty readback; an accepted deletion may finish
late. No extraction-drain receipt, generation fence, operation status ID,
transactional clear or cancellation rollback was found in the inspected SDK or
official contracts. Repeated empty lists improve observation, not that guarantee.
[Official extraction lifecycle](https://raw.githubusercontent.com/Conv-AI/Convai-Documentation/main/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/how-long-term-memory-works.md).

| Command outcome | UI/core meaning | Allowed next step |
| --- | --- | --- |
| Delete accepted; valid empty list observed | `succeeded`, with `providerEmptyObserved:true`; label "Cloud memories currently empty" | Fresh session with same UUID; future conversations may create memories |
| Delete accepted; list stays nonempty or unavailable by deadline | `failed` / uncertain; label "Clear could not be confirmed" | Explicit readback recovery; keep affected conversation admission blocked |
| Write outcome ambiguous after dispatch | `failed` / uncertain; no success receipt | Explicit readback recovery; never silently repeat delete |
| Ownership/local close fails before delete | `failed`; remote clear not dispatched | Resolve cause and let an explicit command retry |
| Any target uncertain in clear-all | Overall command cannot succeed | Preserve per-target receipts; recover exact unresolved targets |

Only the status for the exact original UI command ID may complete that command.
Opening the local registry or restarting the bridge performs no remote work.
An explicit `recoverClear({actionId})` may recheck the original exact pairs with
list only; it must not delete, reenable memory, register a user, change IDs or
substitute a remapped profile. It reports a current empty observation without
inventing acceptance for an originally ambiguous delete. A new delete needs a
new explicit UI action. The pending command retains enough durable state for
this recovery and for refusing stale replies after a process restart.

This scope does not qualify live automatic recall, the selected provider model's
extraction timing, a game's settings interaction, or late-extraction exclusion.
Those require later authorized live checks. It establishes the actionable API
and observable result contract without altering provider state during research.
