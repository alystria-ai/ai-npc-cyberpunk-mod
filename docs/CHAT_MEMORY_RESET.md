# Phone Chat history and Forget

Phone Chat stores the complete local transcript and unsent drafts across game launches, save loads, and CET reloads. There is no disappearing-message setting or automatic launch cleanup. The current single-player UI uses one local transcript bucket; legacy scoped buckets stay archived rather than being silently combined.

## Explicit memory resets

The Memory page's confirmed Forget action owns both cloud memory reset and matching local Chat cleanup:

- Forget one displayed character clears all of that character's **contacted** provider profiles (the ordinary profile and its Multilingual twin; the retired romantic profiles are ignored). Its shared local Chat and drafts are removed only after the aggregate reset succeeds.
- Forget all removes every local Chat and draft only after the full cloud reset succeeds. Archived structured buckets and opaque legacy data are included.
- Failed, cancelled, or uncertain cloud resets preserve local Chat data. Affected conversations remain fenced whenever the memory owner reports them blocked. Other characters' local Chat is preserved.

An empty contacted set does not prevent local cleanup. Forget all, and Forget a configured but never-contacted family, can succeed locally without enabling, creating, deleting, or inspecting an unused provider pair. A completely unconfigured character with no durable provider history is not authorized as a cloud target; UI registration must explicitly authorize any additional local-only character clear.

The Convai player ID is unchanged. Inviting, opening Chat, or warming a connection never creates a synthetic conversation or seeds memory.

## Ownership and persistence

`PlayerMemory` owns provider reset actions and exact-ID memory guards. `PlayerMemoryControl` writes a local reset intent before dispatch and reconciles its result into `memory-chat-resets.json` using `ChatMemoryResets`. The journal contains action IDs, canonical character keys, and explicit legacy alias mappings, never API keys, player UUIDs, transcripts, or provider/session IDs.

Lua remains the only writer of `phone-history.json`. It applies successful journal receipts, removing the relevant history and draft together with an action tombstone in one file replacement. Repeated receipts and later launches therefore retain conversations started **after** Forget. A stored contact-to-profile map also allows cleanup of retired contact aliases. Scoped clears scrub attributable structured legacy data; opaque, unparseable legacy bytes cannot be attributed to a particular character and remain archived. Forget all removes those opaque archives too.

First installation baselines old reset actions. It does not replay a historical Forget against newer conversations. After the journal exists, a successful result missed by a stopped game or bridge is reconciled locally on restart without sending another cloud deletion.

An explicit family upgrade also baselines older single-variant intents rather than widening their deletion scope. Their applied tombstone labels can migrate without deleting newer conversations. Only a new aggregate family success authorizes clearing the shared Chat.

## In-flight requests and storage faults

Pending resets cancel the affected phone request and preserve its text as a draft until success. A successful reset clears that pending owner before reply processing, native draft capture, save-change abandonment, or timeout restoration. The native editor must be repainted with the current draft before it can contribute another submission; cached pre-reset text cannot restore a deleted draft.

Late replies still require the exact request, world, binding, and memory guard. Every request additionally carries global/per-character intent epochs and actual durable memory epochs. Intent counts include known baseline actions: moving an old action to baseline suppresses deletion replay without reviving earlier requests. Actual memory epochs come from the memory owner and cover same-ID recovery as well as new clear commands. The bridge checks both pairs at admission and publication; Lua checks them before consuming even an already-written reply. An old pending file therefore cannot acquire a fresh post-reset guard after a service restart. Failed clear intents still retire their earlier request epoch without erasing Chat. An unrelated character reset does not remove another character's local pending request or transcript; existing broad transport quiescence may still cancel its remote work.

A failed intent write prevents cloud dispatch. Failed receipt writes are retried only as local reconciliation. A failed history replacement leaves the reset unacknowledged and temporarily holds phone sends until history plus tombstone can be saved. Missing/invalid ownership in an established journal fails closed rather than guessing a character or erasing data.

## Bounded phone continuity

Before appending the current message, Lua captures at most six complete actual rows from that contact's local Chat, with a 2,400-byte UTF-8 budget. It includes no other contact, native quest SMS, unsent draft, or duplicate current message. The snapshot carries the exact contact/profile/world/binding and reset epochs; parsing freezes it before asynchronous projection.

The admitted phone route may quote these recent utterances as dynamic conversation context. They are not promoted to verified world facts or new instructions, and no extra turn or memory-seeding request is sent. This supplies limited ordinary/romantic phone continuity; the two provider profiles still have separate remote memory. It does not invent a general transcript ledger for private voice conversations.

## Verification

Focused offline coverage uses injected storage, temporary memory registries, and the real Lua adapter under Fengari. It covers startup baselines, intent/registry races, cancellation, partial failures, retries, aliases and archives, late responses, queued native submissions, history replacement failures, tombstone replay, reset epochs and same-ID recovery, empty-contact local clears, bounded quoted history, and frozen ordinary/romantic phone routes. The combined phone/memory/API/invitation/party run passed 268 checks. No test clears real user memory, reads private transcripts, or invokes the provider.
