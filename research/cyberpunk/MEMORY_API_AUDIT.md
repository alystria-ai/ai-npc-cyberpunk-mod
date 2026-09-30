# Convai memory, identity, and quest-context audit

> Historical baseline and archive qualification notes. The user's later
> September 30 decision replaces the three-ID/manual archive policy with exactly
> one persistent ID and natural conversation memory. Current implementation:
> [PLAYER_MEMORY.md](../../docs/PLAYER_MEMORY.md), [provider contract](PLAYER_MEMORY_API.md).

Audit date: 2026-09-30. Scope: the Cyberpunk bridge at the start of this overhaul, installed Convai Web SDK 1.7.0, and official Convai API/SDK documentation. The baseline code audit was read-only; code locations and “current” behavior in sections 1–3 describe that starting snapshot. Subsequent implementation is documented in [MEMORY_RUNTIME.md](MEMORY_RUNTIME.md). Separately authorized disposable-profile qualification is recorded in [MEMORY_QUALIFICATION.md](MEMORY_QUALIFICATION.md); no production profile was modified by that probe. No credentials are included.

> **Superseded intermediate policy:** an earlier three-ID proposal used anonymous live sessions and a separate REST archive. That proposal and the per-branch/per-group provider namespaces are inactive. [THREE_ID_MEMORY_DESIGN.md](THREE_ID_MEMORY_DESIGN.md) preserves the experiment; the current runtime always supplies the one player ID and builds natural memory through actual conversations.

> **Observed provider restriction:** a globally memory-enabled disposable profile rejected anonymous connect with HTTP 400 requiring `end_user_id`. Anonymous live dialogue therefore keeps global memory disabled. The runtime helper no longer has any character-update endpoint; explicit REST in the disabled-memory mode requires its own qualification. [Enabled-profile probe](ANONYMOUS_MEMORY_QUALIFICATION.md), [disabled-profile probe](ANONYMOUS_MEMORY_DISABLED_QUALIFICATION.md).

## Subsequent API qualification

The final disposable test used the official SDK's LiveKit connection path and configured `fast-gemma-4-31b-it`. Character memory enablement read back successfully. Two distinct end-user UUIDs were registered and disconnected cleanly; each could add, list and get its own explicit memories. Cross-user get returned HTTP 403 in both directions. Exact test memories were deleted and both lists verified empty; the temporary character was deleted and its absence verified. Earlier setup probes were each cleaned before the next. This qualifies explicit REST ownership, not automatic dialogue extraction or native save integration.

A fresh never-connected end-user UUID returned HTTP 404 with “End user not found.” Connecting that identity registered it, after which list returned an empty result. Thus branch/group seed projection must wait for scoped user registration. Source-backed automatic LTM retrieval occurs at session start, so a connection warmed before explicit seeding must not be assumed to reload newly added records without reconnecting. Keep the verified local episode projection in dynamic context. A modern account-wide EndUsers deletion wire was not established; the probe removed its character-specific memories and profile, and does not claim to have removed the empty temporary end-user records.

## Findings that affect the proposed overhaul

1. **The mod currently supplies quest context, not a quest-memory system.** It captures the tracked quest and at most eight active, revealed objectives. It does not map completed quests, decisions, relationships, or character-specific knowledge.
2. **Realtime conversations currently have no explicit end-user identity.** The Web SDK documents an omitted `endUserId` as anonymous, without automatic cross-session memory. The current HTTP route likewise sends no user identity; its documented interface does not establish an equivalent identity field.
3. **Cloud memory was disabled in the last saved character readback.** The local report `runtime/profile-enrichment-report.json`, modified 2026-09-29 18:34:04 UTC, records `memoryEnabled: false` for all 79 profiles and model `fast-gemma-4-31b-it`. This is a historical local readback, not a fresh remote verification. The production provisioning script deliberately preserves memory configuration.
4. **A Convai conversation session is not a player/save identity.** World sessions are keyed by character profile and private/group scope. Phone sessions persist by Convai character ID alone. These keys currently allow an earlier save's conversation context to remain reachable after loading another save.
5. **The installed SDK already includes explicit memory add/list/get/delete operations.** A deterministic, save-aware local ledger should own game facts; Convai memory can be a derived projection of eligible records.
6. **Adding `endUserId` alone would be unsafe for the existing speculative group path.** A new conversation session with the same character/user still shares LTM. Cancelling a page or refusing to publish a generated response is not a server-side memory rollback.
7. **Remote LTM has no documented transaction, branch, checkpoint, or selective “undo everything after this save” interface.** The accepted bounded-ID policy disables automatic LTM in live sessions and selects an exact local prefix for context; cloud records remain an explicit archive. A new local conversation stream prevents old dialogue from carrying over. Neither a prompt asking the model to forget nor asynchronous clear/reseed supplies rollback semantics.

## 1. What the mod actually does today

### 1.1 Quest capture and injection

| Layer | Exact code | Current behavior |
| --- | --- | --- |
| Native snapshot | `mod/quest-context.lua:15-77` | Reads `GetTrackedEntry()`, walks parents to the active quest, traverses active journal nodes, captures localized descriptions, tracked flags, optional flags and bounded counters. Inactive, succeeded and failed entries are excluded. Traversal is bounded to 128 nodes, depth eight and eight objectives. |
| Capture safety | `mod/quest-context.lua:80-90` | Rejects unavailable/pre-game/dead/detached player state and reports unavailable on native errors. Native handles remain local to the read. |
| Protocol validation | `bridge/quest-context.mjs:13-37`; `bridge/protocol.mjs:12-31` | Validates the optional journal payload. Malformed optional context becomes unavailable without discarding a valid chat message. The protocol has no stable player, campaign, save, branch or checkpoint field. |
| Prompt composition | `bridge/quest-context.mjs:40-59` | Serializes the journal into bounded context, explicitly distinguishes V's journal from the NPC's witnessed history, and forbids inferring completion, hidden outcomes or relationship progress. Adds group/battle/loot context. |
| Realtime | `bridge/realtime-client.mjs:153-160,175-196` | Before a text turn, calls `updateContext({mode: 'replace', run_llm: 'false', text: ...})`, then sends the user's actual text separately. Voice begins through the same context update. The generic prefix currently says no verified relationship state is supplied. |
| HTTP world fallback | `bridge/convai-bridge.mjs:189-204` | Prepends the composed context to `userText`, then calls `getResponse`. This is not a dedicated dynamic-information field. |
| Phone messages | `bridge/phone-chat.mjs:65-71` | Also prepends current context to `userText`, followed by V's message. Uses HTTP with voice disabled. |

Thus the accurate present-tense answer is: **yes, current quest state is fed into temporary context on realtime requests; the phone and HTTP fallback emulate this by including it in the submitted text. The requested granular quest decisions and persistent player memory do not yet exist.**

The current realtime update is fire-and-forget. `updateContext()` returns no acknowledgement promise in SDK 1.7.0 (`ConvaiClient.js:1049-1074`), and the mod does not wait for a `serverResponse` success before sending the next user input. Existing successful replies are useful behavioral evidence, but they do not establish acknowledgement ordering or rejection handling for a much larger future payload.

### 1.2 Identity and session ownership

| Object | Current identity | Persistence / boundary |
| --- | --- | --- |
| HTTP world session | `profileKey + ':' + conversationScope(input)` | In-memory `sessions` map in bridge process. |
| Realtime world session | Same key, separate `realtimeSessions` map | In-memory; reused after successful publication. |
| Private scope | Literal `private` | Separate from group sessions, but shared by copies of the same canonical profile. |
| Group scope | `group:` plus sorted audience profile keys | Order-independent audience set. Separate group session for each speaker. Does not encode save or player. |
| Phone session | Convai character ID | Persisted in project `runtime/phone-sessions.json`; reloaded after bridge restart. |
| Phone request world token | Current `os.time()` plus random number | Cancels obsolete UI work and late publication after detach/reattach. It is not a campaign identity. |
| Phone launch token | Cyberpunk PID plus process start ticks | Controls disappearing local messages. Deliberately survives save changes. It is not a save identity. |
| Remote Web SDK user | None supplied | Current `new ConvaiClient(...)` omits `endUserId` and `endUserMetadata`. |
| Runtime entity | NPC entity hash | Owns playback and exact-copy cleanup. It must not become the persistent canonical character key. |

Source: `bridge/convai-bridge.mjs:50-58,86-118,238-242`; `bridge/group-context.mjs:29-31`; `bridge/realtime-host.mjs:7,57-79`; `bridge/realtime-client.mjs:26-46`; `bridge/phone-chat.mjs:22-27,42-70`; `mod/phone-chat.lua:53-76`; `bridge/game-launch.mjs:7-19`.

Loading a save resets native references (`mod/init.lua:809-830`) and can close stale realtime connections (`bridge/convai-bridge.mjs:430-439`). It does not clear or rescope the bridge's session maps. No call clearing those two maps was found. Phone world changes abort pending work, but do not clear `PhoneChat.sessions`. Repeating a current-journal warning does not remove earlier dialogue already held in a reused remote session.

### 1.3 Warming versus speculative dialogue

The accepted connection-on-spawn behavior is implemented by `PartyConnections`: membership retains private connections, with optional group connections. It starts at most two connections concurrently, staggers starts by 500 ms and maintains ready connections with idle timer resets (`bridge/party-connections.mjs:12-14,48-63,85-118`). `RealtimeHost.warm()` only connects; it sends no user conversation (`bridge/realtime-host.mjs:80-88`). This can remain once identity is resolved **before** warmup.

Group prefetch is different. It creates an actual answer in a fresh session, discards the browser lease and adopts the session only when a later exact input/context hash matches (`bridge/group-prefetch.mjs:5-8,20-32,42-79`; `bridge/realtime-host.mjs:84-88`). Existing committed sessions are warm-only (`bridge/convai-bridge.mjs:136-140,473-477`). This currently relies on anonymous fresh sessions. A future persistent `endUserId` would remove the LTM isolation even if the session ID stays fresh.

`publishResult()` stores the returned session after writing `reply.json`, before proof that every spoken word was actually heard (`bridge/convai-bridge.mjs:207-243`). This is reasonable transport ownership, but it is not the right commit point for a memory claim such as “Judy heard V say X” or “Johnny said Y to the group.” The new ledger needs delivery receipts and audience eligibility separately.

## 2. Supported provider contracts

### 2.1 End-user identity is explicit in the Web SDK

SDK 1.7.0 accepts `endUserId` and optional `endUserMetadata`. It serializes these as `end_user_id` and `end_user_metadata` on connect, reads the returned end-user identity, and creates `MemoryManager` only when one is present. Its declared configuration specifically describes anonymous behavior when identity is omitted. A UUID is sufficient; no Steam ID, email, or hardware fingerprint is needed. [Web SDK memory guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory)

Local primary evidence:

- `package.json` pins `@convai/web-sdk` to `1.7.0`.
- `node_modules/@convai/web-sdk/dist/core/types.d.ts:399-421` documents identity configuration.
- `node_modules/@convai/web-sdk/dist/core/ConvaiClient.js:447-455,569-580,715-727` maps identity to and from the wire.
- The SDK defaults to `https://realtime-api.convai.com`, not necessarily the older Core Live API documentation's `https://live.convai.com` host (`ConvaiClient.js:416-420`). Preserve the supported SDK path; do not transplant endpoints between API generations.

The Unity SDK has a default device identity provider, but **that default does not apply to this JavaScript integration**. Its current documentation also warns that a newly selected identity only affects the next connection. Use a stable opaque identity and reconnect when the authoritative branch changes. [Identity guide](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/end-user-identity.md)

The concrete Web SDK connection shape is:

```js
const client = new ConvaiClient({
  apiKey: key, characterId,
  endUserId: identity.endUserId,
  endUserMetadata: {app: 'cyberpunk-convai', schema: 'memory-v1'},
  characterSessionId: scopedSessionId || '-1',
  transport: 'livekit', startWithAudioOn: false,
  ttsEnabled: false,
});
await client.connect();
```

The same configuration must reach spawn warmup, private/group text and microphone starts; changing only `realtimeConfig()` while leaving `PartyConnections.configFor()` anonymous is insufficient. `ttsEnabled: false` here is a text-only example, not a required voice setting.

### 2.2 Dynamic context is temporary state

The Web SDK supports connect-time `dynamicInfo`, optional `keepInContext`, and runtime `updateContext` with append/replace/reset behavior. Silent updates do not require an answer. A context-update acknowledgement can report token capacity through `serverResponse`. `resetSession()` starts a new conversation history while retaining LTM associated with the same identity. These operations do not define a save rollback or memory deletion. [Dynamic context guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/dynamic-context.md)

Implementation pointers: `ConvaiClient.js:500-506` sends connect-time dynamic information; `1015-1021` publishes legacy dynamic-info updates; `1049-1074` publishes context-update. There is no memory write in these client methods. The server's exact extraction inputs must not be inferred merely from the client method name.

Recommended use is `replace` for an authoritative current-state snapshot. Append is suitable only for bounded, explicitly expiring events. Never append every poll of the same quest or every historical walkthrough paragraph.

### 2.3 Memory enablement is character-wide

Memory must be enabled on the remote character as well as supplying user identity. Current documentation describes this as an opt-in character setting, affecting all integrations using that character ID. Disabling the setting does not delete previously stored records. [Character memory configuration](https://docs.convai.com/api-docs/plugins-and-integrations/unity-plugin-beta-overview/features/long-term-memory/enabling-memory-on-characters)

The official Unreal SDK at commit `98575b10a0b85facd570ed29decb5a65a8b3b49b` supplies the exact wire contract: JSON POST `/character/get` with `{charID}` reads `memory_settings.enabled`; JSON POST `/character/update` writes `{charID, memorySettings:{enabled:true}}`. The **camelCase write and snake_case read differ intentionally**. Both use `CONVAI-API-KEY`. This is source-backed API evidence, not a claim that the account or a production character has enabled memory. The same official character API documents POST `/character/delete` with `{charID}` for cleanup of an explicitly owned disposable profile. [Official memory proxy](https://github.com/Conv-AI/Convai-UnrealEngine-SDK-V4/blob/98575b10a0b85facd570ed29decb5a65a8b3b49b/Source/Convai/Private/RestAPI/ConvaiLTMProxy.cpp), [official endpoint definitions](https://github.com/Conv-AI/Convai-UnrealEngine-SDK-V4/blob/98575b10a0b85facd570ed29decb5a65a8b3b49b/Source/Convai/Private/RestAPI/ConvaiURL.cpp), [character API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api)

Current local production provisioner verifies that the preexisting memory configuration is unchanged (`scripts/Provision-Characters.mjs:88-102`). Do not silently change this established behavior. Any enabling rollout should select mod-owned IDs, record before/after values and preserve unrelated fields.

### 2.4 Explicit memory REST interface already shipped locally

`node_modules/@convai/web-sdk/dist/core/MemoryManager.js` is direct, inspectable client evidence. All operations below are JSON `POST`s to `https://api.convai.com`, authenticated by `CONVAI-API-KEY` or `API-AUTH-TOKEN` (`:44-95`). Required common body fields are `character_id` and `end_user_id`.

| Operation | Endpoint | Additional request fields | Relevant response |
| --- | --- | --- | --- |
| Add | `/memory/add` | `memories: string[]` | `memories`, containing IDs and stored text/event information |
| List | `/memory/list` | `page`, `page_size` | `memories`, `total_count`, `page`, `page_size`, `has_more` |
| Get | `/memory/get` | `memory_id` | `id`, `memory`, `created_at`, `updated_at` |
| Delete one | `/memory/delete` | `memory_id` | `deleted`, `memory_id`, message |
| Delete pair | `/memory/delete-all` | None | Accepted/deletion-status message; asynchronous completion |

Code ranges: add `:120-129`; list `:157-164`; get `:181-190`; delete one `:207-216`; delete all `:219-242`. Request/response types are in `types.d.ts:845-967`.

Exact standalone SDK calls, with no live conversation required:

```js
import {MemoryManager} from '@convai/web-sdk/core';
const memory = new MemoryManager(key, characterId, identity.endUserId);
const added = await memory.addMemories([eligibleEpisode.text]);
const page = await memory.listMemories({page: 1, pageSize: 50});
const record = await memory.getMemory(remoteMemoryId);
// Destructive cleanup must be a separate explicit application operation:
const removed = await memory.deleteMemory(remoteMemoryId);
const deletion = await memory.deleteAllMemories();
```

For a bridge-owned fetch wrapper, the add shape is `POST /memory/add` with JSON `{character_id: characterId, end_user_id: identity.endUserId, memories: [eligibleEpisode.text]}`. It needs `Content-Type: application/json` and the existing secret key in `CONVAI-API-KEY`, never in the URL, output, identity or committed file.

Important limits of this observed client:

- There is no update, transaction, snapshot, fork, rollback, batch-delete, user-defined record ID, idempotency key, metadata filter, or retention-TTL method.
- `addMemories` accepts strings. The Web SDK type has no field for provenance metadata, quest ID or checkpoint ID. Keep these in a local sidecar ledger unless a newer verified provider interface adds them.
- The public constructor can be used on the bridge independently of a live conversation. It does not require generating dialogue.
- The stock fetch wrapper has no abort signal, timeout or retry policy. A production synchronization worker needs bounded calls and careful reconciliation of ambiguous writes; blindly retrying a POST is not an exactly-once guarantee.
- `setEndUserId()` changes the memory-manager object's future REST requests. It does **not** rebind an already-connected character conversation. It must not be used as a shortcut for switching a live playthrough.
- Deleting all records needs a follow-up list read; an accepted response is not proof that deletion has finished.

The newer Unity memory guide describes optional metadata on returned records and add/update result events. SDK 1.7.0's TypeScript declaration instead types its add event as `ADD` only. This is documentation/client version drift. Parse provider results conservatively and preserve returned IDs; do not build rollback correctness on semantic deduplication or one-to-one correspondence between submitted strings and stored IDs. [Memory management guide](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/memory-management-api.md)

### 2.5 Automatic extraction is not a deterministic event log

Current official lifecycle documentation says memories are injected at connect, conversation facts are extracted when the session ends, and only selected meaningful details are retained. It describes semantic deduplication and independent user-character partitions. This supports natural continuity, but it does not guarantee that a dynamic-context update alone becomes a memory, when an individual fact will appear, or exactly which words it preserves. [LTM lifecycle](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/how-long-term-memory-works.md)

Consequences for this mod:

- Connections kept alive from spawn can delay automatic consolidation until disconnect. “Slowly” should mean an explicit promotion policy, not a promise that the provider will periodically ingest dynamic information.
- Manually adding a fact while a character stays connected may not update its already-injected memory context. Continue supplying the locally resolved fact in dynamic context; refresh a connection at a natural boundary only if necessary.
- Same user + different character means separate memory sets. Heard group dialogue must be recorded for eligible listeners; it is not shared across characters automatically.
- Same user + same character + different private/group session is still the same LTM partition. Session separation alone is not private-memory separation.
- Do not treat the provider's natural-language summary as proof of a game decision. Game state remains authoritative.

These are the documented semantics, not measured guarantees for this account, model or every current backend version. A disposable-profile integration check remains required before enabling live synchronization.

### 2.6 Legacy HTTP, chat history and deletion

The Core `getResponse` reference documents `charID`, `sessionID`, input text/audio, voice and streaming options; `-1` starts a new conversation. It does not document `end_user_id`, `speaker_id` or a dedicated dynamic context field in that request. Do not invent unsupported form fields. A text-only Web SDK connection (`ttsEnabled: false`) is the already-supported route for explicit identity/context on phone conversations; alternatively retain anonymous HTTP and inject a local save-scoped memory projection. [Interaction API](https://docs.convai.com/api-docs/api-reference/core-api-reference/interaction-apis/interaction-api)

Convai's own support answer distinguishes `speaker_id` on the **legacy gRPC** service from `end_user_id` on **WebRTC**. It does not establish a `speakerID` field on HTTP `getResponse`. An internal server speaker identifier is not a field to guess into every transport. The answer also notes unsupported LTM for provider-native OpenAI Realtime/Gemini Live; this should not be confused with the mod's WebRTC transport using an ordinary selected text LLM. [Convai identity clarification](https://forum.convai.com/t/long-term-memory-issues-with-new-playground-dashboard/6141/8)

The Chat History API lists sessions and retrieves transcript details, with plan restrictions. Its example reports `is_added_to_memory`, but this does not establish granular quest ingestion or rollback. Its list/get endpoints are not a local memory ledger. [Chat History API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/chat-history-api)

A separate selected-customer endpoint deletes whole sessions using `charID` and `sessionIDs`. The page does not promise that deleting a transcript reverses already-extracted memories. It cannot implement “undo to checkpoint” by itself. [Chat History Delete API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/chat-history-delete-api.md)

Deleting an end-user record is broader still: the documented management interface removes its memories across characters. That should be reserved for a user-requested complete reset; never use it for loading a save. [End-user management](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/long-term-memory/end-user-management.md)

## 3. Recommended application contract

This section records the design audit, not a provider guarantee. The subsequent isolated implementation and its exact integration contract are documented in [MEMORY_RUNTIME.md](MEMORY_RUNTIME.md). That contract supersedes illustrative interfaces here, particularly exact-audience group namespaces and native-restored-only promotion.

### 3.1 Separate five kinds of information

| Kind | Owner | Suitable contents | Must not contain |
| --- | --- | --- | --- |
| Canonical character profile | Authored, source-backed dossier | Stable biography, motivations, relationships known before the chosen story epoch, speech patterns, original sample dialogue | One player's decisions, assumed romances, future quest outcomes presented as current |
| Canonical quest knowledge | Versioned local research corpus | Branch graph, choice conditions, record/fact identifiers, character knowledge gates, citations | An assertion that an outcome occurred merely because a guide describes it |
| Current world snapshot | Read-only game adapter | Active objectives, resolved current facts, NPC availability, verified relationship state, current location | Completed-history claims derived solely from quest title or an absent zero-valued fact |
| Local episodic ledger | Save-aware mod subsystem | Verified milestone transitions, player statements explicitly marked as statements, delivered/heard conversations | Scraped walkthroughs automatically recorded as personal experiences |
| Remote LTM projection | Bounded asynchronous worker | Eligible, stable, character-visible local episodes | Authoritative save state, unresolved branches, predictions, unplayed group speech, secrets a listener never heard |

All three character profile fields stay separate: `backstory`, `speaking_style_description`, `speaking_style_sample_dialogues`. The decision-resolved context is runtime data and should never be written into the shared biography.

### 3.2 Identity tuple

Use an explicit local identity record, generated independently of NPC entities, names and game PIDs:

```ts
type MemoryIdentity = {
  version: 1;
  localUserId: string;       // opaque stable UUID, not an API key or display name
  campaignId: string;        // a particular V/playthrough, not the save filename
  branchId: string;          // current history lineage
  checkpointId: string;      // last verified save/checkpoint in that lineage
  namespaceVersion: number;
  endUserId: string;         // opaque stable encoding/hash of approved scope
};
```

Recommended remote base partition: an opaque ID derived from `{namespaceVersion, localUserId, campaignId, branchId}`. Convai already adds `character_id` to the partition. Canonical NPC copies should share the character's memories by default; instance entity IDs remain only for physical delivery and witnessed events. An explicit alternate-persona mode may choose a separate partition later.

Include the identity tuple in session keys, pool keys, all request/response leases, prewarm keys, prefetch fingerprints, persisted phone sessions and synchronization outbox entries. Do not merely add it to the prompt.

Every identity change must atomically stop old output publication, cancel input/prefetch, release microphone, close old connections, switch the ledger projection, and only then warm new scoped connections. A late response can finish remotely but cannot attach to the new branch.

**Unresolved game requirement:** the current adapter has no verified persistent campaign/save lineage identity. PID/start time, wall-clock request IDs and journal progress are insufficient substitutes. If native save identity cannot be established confidently, provide an explicit local playthrough selection and disable automatic remote promotion while identity is uncertain. Do not silently merge campaigns.

### 3.3 Fact and episode model

```ts
type ResolvedFact = {
  factId: string;                    // stable local mapping ID
  value: string | number | boolean;
  status: 'verified' | 'unknown' | 'conflicted';
  evidence: Array<{
    kind: 'quest-fact' | 'journal-state' | 'native-event';
    key: string;
    rawValue: unknown;
    mappingVersion: string;
  }>;
  observedCheckpoint: string;
  knowledge: {characters: string[]; reason: string};
  supersedes?: string[];
};

type MemoryEpisode = {
  episodeId: string;                 // content/identity based local dedupe key
  identity: MemoryIdentity;
  characterKey: string;
  kind: 'decision' | 'shared-experience' | 'player-statement';
  text: string;                      // compact paraphrase, explicit knowledge source
  evidenceFactIds: string[];
  witnessedBy: string[];
  visibility: 'private' | 'heard-group' | 'public-game-fact';
  delivery?: {requestId: string; state: 'played' | 'partial' | 'cancelled'};
  state: 'candidate' | 'checkpointed' | 'eligible' | 'submitted' | 'verified' | 'superseded';
  remoteReceipts: Array<{endUserId: string; characterId: string; memoryId: string}>;
};
```

Distinguish **V knows**, **the NPC witnessed**, **V told the NPC**, and **a public outcome is known**. Seeing a quest in V's journal does not give every companion firsthand memories of it. A private statement should retain that provenance even if it later contradicts a game fact. Canonical research is an interpretation map, never a substitute for evidence from the loaded save.

### 3.4 Promotion policy: controlled accumulation

1. Capture a consistent game snapshot after load/attachment settles. Resolve only validated mapping rules; retain unknown and conflicting states explicitly.
2. Diff against the current branch ledger. Repeated polling of one state produces no new episode.
3. Form a compact episode only for meaningful transitions or confirmed delivered conversation. Do not promote “currently tracking quest X,” momentary combat status or an uncompleted objective as a permanent event.
4. Apply per-character knowledge eligibility. A milestone can generate different contextual summaries for Judy, Johnny and a fixer; an uninformed stranger gets none.
5. Hold unsaved episodes locally. Promote after a verified checkpoint, or a separately declared non-game memory policy for stable player preferences. Never use a timer alone as proof that the world state is durable.
6. Queue the exact namespace, source episode IDs and normalized text in an atomic outbox. Serialize writes per user-character pair and reconcile ambiguous results before retries.
7. Record remote IDs and read back accepted writes. Keep a projection manifest so future amendments can identify what the application submitted.
8. Continue providing current truth in dynamic context. Remote LTM aids natural recall; it does not overrule the loaded save.

There is no documented exactly-once remote insertion contract. The local ledger must remain deduplicated even when the provider merges memories, rewrites text, or returns after a network timeout. Do not display “memory saved” solely because a request was scheduled.

### 3.5 Save rollback and branching

On loading an ancestor checkpoint, create or resolve a branch whose ledger contains only the checkpoint's eligible prefix. Give that branch a separate remote end-user namespace and fresh conversation sessions. Seed it from verified local episodes visible at that checkpoint. Leave later asynchronous writes attached to the abandoned namespace, so their eventual completion cannot contaminate the active branch.

Do not attempt immediate in-place deletion of all “newer” remote records. Automatic extraction and semantic merging can modify preexisting records, and timestamps are server activity times rather than game causality. A list/delete loop cannot prove exact restoration. Whole-partition deletion is also asynchronous.

If preserving unsaved conversation preferences across reload is desired, define a separate non-game preference store and opt-in transfer policy. Do not accidentally carry a failed quest choice, an ending, or an undone romance into a rewound save.

### 3.6 Private/group/phone routing

- **Private world and private phone:** same canonical character and branch can share episodic knowledge, while retaining separate conversation session streams to avoid interleaved requests. The transcript UI and disappearing-message policy remain independent of memory retention.
- **Group:** use a filtered local projection of character-visible, group-safe episodes. The current “do not reveal private history” prompt is not strict isolation once a shared LTM partition contains private information. Identified group sessions require an end-user namespace containing the **exact sorted canonical audience**; a universal group-safe bucket would leak automatically extracted dialogue into a different party. Seed only eligible episodes authorized for every current member, and rekey sessions when membership changes. Anonymous groups remain an explicitly different fallback.
- **Multiple copies:** deduplicate conversational identity by canonical profile while tracking exact entities as witnesses. A duplicate Judy spawning does not create a new person or duplicate an episode automatically.
- **Phone HTTP fallback:** either migrate to text-only realtime for the same supported context/identity contract, or deliberately remain anonymous with filtered local memory injected. Do not claim equivalent cloud memory across both routes until verified.
- **Prepared group answers:** disable speculative LLM generation for identified memory sessions initially. Continue connection prewarming. Retaining anonymous speculation would require a demonstrated safe commit/replay mechanism; reusing an anonymously generated session under an identified user is not documented as a supported rebind.

### 3.7 Dynamic-context envelope

Use a bounded envelope generated from the resolved ledger, not the full scraped corpus:

```json
{
  "schema": "cyberpunk-context/v2",
  "identityEpoch": "opaque-current-branch-epoch",
  "snapshotRevision": 42,
  "character": "judy-alvarez",
  "authority": "verified-loaded-save",
  "currentObjective": {},
  "knownDecisions": [],
  "relationship": {"status": "unknown", "evidence": []},
  "sharedEpisodes": [],
  "reportedByV": [],
  "unknowns": [],
  "groupHeard": [],
  "supersededFactIds": []
}
```

Selection should prioritize the current question, relevant known quests and recent shared episodes, with strict token budgets. Treat titles, scraped text and player quotes as data. Do not let a source page's instructions or a quoted utterance change system behavior. Send an entire replacement snapshot after a load, branch change or material decision change; include the revision in diagnostics. Investigate the SDK's available acknowledgement event before relying on silent updates for first-turn correctness.

## 4. Concrete implementation seams

| Proposed interface | Responsibility | Existing integration point |
| --- | --- | --- |
| `SaveIdentityResolver.resolve(snapshot)` | Produces verified identity or explicit uncertainty | Native journal/world capture and attachment lifecycle |
| `QuestResolver.resolve(gameSnapshot, mappingVersion)` | Returns facts with evidence and unknown/conflicted states | New mapping layer behind `mod/quest-context.lua` / bridge validation |
| `KnowledgeProjector.forCharacter(character, facts, audience)` | Filters by NPC knowledge and privacy | `conversationContext(input)` |
| `EpisodeLedger.observe/acknowledgeDelivery/checkpoint/fork` | Owns temporal history and causal boundaries | Request publication, native playback receipts, phone delivery and save events |
| `ContextPublisher.replaceAndConfirm(snapshot, signal)` | Bounded, revisioned delivery with failure state | `bridge/realtime-client.mjs:updateContext` |
| `MemoryOutbox.enqueue/reconcile` | Queues eligible explicit writes with namespace and receipt | Bridge worker, independent of game frame polling |
| `ConvaiMemoryAdapter.add/list/get/delete` | Exact supported REST contract, bounded timeout, no automatic destructive cleanup | Installed SDK `MemoryManager` interface or audited wrapper |
| `ScopedSessionRegistry.acquire/invalidate` | Persists sessions only for matching user/campaign/branch/privacy scope | `sessions`, `realtimeSessions`, phone sessions, pool keys |

No native fact extraction or external source scraper should call Convai directly. It emits structured evidence; the memory policy decides what becomes context or a durable episode.

## 5. Qualification gates before remote memory is enabled

These are concrete remaining risks, not claims that an enormous test count would establish correctness.

1. **Identity:** two local users, two V campaigns and two branches of one campaign must not share sessions, warmed pages, phone history or remote memory partitions.
2. **Rollback:** record one milestone, checkpoint, record a different later choice, then restore the checkpoint. Current context and new remote namespace must omit the later choice even if its old remote request completes afterward.
3. **Knowledge:** a private Judy statement must not enter another character's context or a group-safe projection. A companion absent from an event must not claim to have witnessed it.
4. **Promotion:** polling, CET reloads, bridge restarts and retries must not create duplicate local episodes. Partial/cancelled speech cannot be recorded as fully heard.
5. **Warm connections:** resolve identity before spawn warmup; a branch change must close/rekey them. Verify first response receives current context, including a context-update rejection or timeout case.
6. **Provider contract:** on disposable mod-owned test profiles only, verify identity isolation, memory enabled readback, explicit add/list/get, eventual deletion, extraction timing and reconnect recall for the selected model. Do not use the live companions for destructive tests.
7. **Transport parity:** phone, private text, microphone and each group speaker must use the declared scope. If legacy HTTP lacks support, the product should use the deterministic local projection and report the limitation internally.
8. **Profile safety:** decision-specific information cannot enter shared `backstory`; static biographies and sample dialogue cannot leak unreached endings or assume the player's relationship choices.

## 6. Provider questions that remain genuinely unresolved

- Does the deployed backend for SDK 1.7.0 extract memories from ephemeral context itself, or only transcript messages/answers? Does `run_llm: false` ever contribute to extraction?
- Is there a supported per-session option for read-only LTM / suppressed automatic extraction? None was found in the installed configuration and inspected docs. Character-wide disabling is not equivalent.
- Is there a current HTTP `getResponse` identity/context contract beyond the published fields? Do not assume undocumented `speaker_id` or `end_user_id` works.
- Does adding memory while a session remains warm affect that active session, or only a subsequent connect, on this backend/model?
- Are caller-supplied idempotency keys, provenance metadata, exact filtering, revisioned updates, or transactional snapshots supported by a newer stable API? They are absent from the installed Web SDK contract.
- Does deleting session history affect extracted memory? The published delete-history page makes no such guarantee.
- What exact acknowledgement identifies a successful context replacement before a subsequent user turn on the current transport? The present bridge does not observe one.

These questions do not block building the research corpus, validated quest rules, save-local ledger or dynamic-context projector. They do block claiming exact cloud-memory ingestion and rollback semantics without a controlled integration check.

## Recommended sequence

First establish source-backed character dossiers and a structured quest/fact schema. In parallel, add stable campaign/branch identity and deterministic local episodic storage. Integrate the resulting character-specific snapshot through the existing dynamic-context route with acknowledgement handling. Then qualify explicit Convai memory projection on disposable profiles and enable it per owned character only after the identity, rollback and privacy boundaries are demonstrated. Keep remote memory a replayable projection of verified local history throughout.
