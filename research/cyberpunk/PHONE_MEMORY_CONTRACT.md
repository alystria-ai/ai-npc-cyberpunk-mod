# Phone transcript and session ownership

Version 1, September 30, 2026. This implements the phone boundary described in
`FORMAT.md`, `RUNTIME_CONTRACT.md`, and `MEMORY_API_AUDIT.md`. It does not infer a
campaign from a contact, NPC, game PID, wall clock, quest title, or save filename.
It does not create a native save identity, fork the ledger, or write remote LTM.

## Authoritative binding supplied by the parent adapter

```lua
phoneChat.configure(profiles, manager, {
    captureBinding = function(player) return currentBinding end,
    captureWorldKnowledge = function(player, profileKey, binding)
        return currentPhoneAudienceSnapshot
    end
})
```

The two functions can alternatively be assigned to `phoneChat.captureBinding`
and `phoneChat.captureWorldKnowledge`. Existing `captureJournal` and
`captureBattle` hooks remain supported. All hooks are optional, protected with
`pcall`, and copied through bounded JSON before retained use. No injected native
handle is stored. The knowledge hook receives a copy of the binding.

An available binding has exactly the normalized fields below:

```json
{
  "version": 1,
  "status": "available",
  "authoritative": true,
  "confidence": "native-live",
  "localUserId": "bridge-owned-stable-user-UUID",
  "campaignId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branchId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "branchEpoch": 1,
  "ledgerSequence": 10,
  "generation": 4,
  "activationId": "cccccccccccccccccccccccccccccccc"
}
```

`native-restored` is also accepted. Native campaign, branch, and activation IDs
are 32 lowercase hexadecimal characters. Epoch and generation are positive
signed-32-bit integers; ledger sequence is a nonnegative signed-32-bit integer.
The local user ID is a bounded opaque token supplied by the bridge, not a name
or credential. Missing or malformed proof becomes unavailable; it never borrows
a durable namespace. An unavailable result may retain its positive native
generation so a new unresolved world can still invalidate old delivery work.

The native identity coordinator must withhold available status until its
resume/fork transaction finishes. Loading an older checkpoint must resolve to
the appropriate new branch before history or sessions become reusable. This
module deliberately does not reinterpret decreasing quest progress or create
its own competing branch rule. Call `abandon()` on native detach/death/unload.

## Two independent scopes

| Purpose | Fields |
| --- | --- |
| Durable local transcript | Local user ID + campaign ID + branch ID |
| Delivery ownership | Durable scope + branch epoch + native generation + activation ID + the phone world's transient token |
| Provider session | Durable scope + canonical profile + Convai character ID + phone channel + remote recovery generation + optional end-user ID |
| Unverified identity | Current phone world only; no persisted provider session reuse |

Advancing `ledgerSequence` does not itself invalidate the active conversation;
it is captured on each submission. Changing branch, user, campaign, native
generation or activation does cancel the pending reply, reset the native UI
draft to the new scope, and publish a new world binding. The previous scope's
pending message is retained there as a draft. Exact contact routing is preserved
even if the user selects another contact while awaiting a reply.

## Local transcript migration and display retention

`runtime/phone-history.json` now uses version 3:

```js
{
  version: 3,
  buckets: {
    [scope]: { identity, sessionOnly, launch, history: { [contact]: rows }, drafts }
  },
  legacy: [ originalUnscopedDocument ],
  launchPolicies: { [processLaunchToken]: boolean }
}
```

Version 1/2 history is retained under `legacy` without being assigned to the
first loaded save. Unparseable history is preserved as `legacy[].unparsed`.
Unknown-identity transcripts are retained in local `session:` buckets for
recovery but never adopted by a different world or an eventual verified
campaign. No silent transcript row cap was introduced. Existing unsupported
contacts' rows remain stored. Writes stage a complete replacement; on Windows
rename fallback the previous complete document is held until replacement wins.

Disappearing messages affect transcript rows and drafts only. A confirmed new
game process launch applies the recorded launch policy when a bucket is opened.
CET reloads, bridge restarts and native save loads are not process launches.
Changing the preference within an already identified process takes effect at
the next launch; it does not retroactively clear another branch during this
launch. Legacy archives, provider session storage and the episodic ledger are
not deleted by this display preference.

## Bridge and wire integration

The Lua producer emits phone state version 2 with top-level `saveIdentity` and
the same binding on `request.saveIdentity`. Each request separately carries
`worldKnowledge`, `journal` and `battle`. A fresh binding is captured after all
context hooks; a change during capture abandons that outgoing request.

Bridge `parsePhoneState` supports version 1 as an anonymous, session-only
compatibility route. Version 2 checks request and state delivery bindings.
Output now includes a `binding` string; Lua requires world, binding, request ID
and contact to match before appending a reply. Malformed or mismatched world
snapshots become unavailable before they reach the reply or ledger-context
adapter. A ready snapshot must match native generation, exact phone recipient
and any verified user/campaign/branch identity.

```js
new PhoneChat({
  contacts, ids, sessions, saveSessions, publish, reply,
  contextFor: ({characterKey, channel, input, saveIdentity, signal}) =>
    ledger.contextFor({characterKey, channel})
});
```

`contextFor` may be asynchronous. An available result must contain the matching
ledger `identity` (user/campaign/branch plus `remoteGeneration`) and bounded
`endUserId`. A stale result fails closed. An unavailable result can use a fresh
anonymous session in the same verified branch. Recovery changes the provider
session key even when the game branch stays the same. The parent must also call
`phone.close()` during ledger recovery/rebinding so work already in flight is
cancelled before the new ledger generation is made active.

The parent reply adapter receives:

```js
{
  characterId, profileKey, sessionId, voice: false, signal,
  input,            // Original V text and separate normalized context fields
  saveIdentity,     // Native binding that owns this turn
  context,          // Existing journal/battle conversation context
  endUserId,        // Optional, only from matching bridge ledger context
  text              // Legacy-compatible context plus V's message
}
```

The adapter can resolve `input.worldKnowledge` against the reviewed pack and
use a supported text-only realtime route for explicit identity. These extra
JavaScript options are not invented multipart fields for legacy HTTP
`getResponse`. That HTTP interface does not establish end-user LTM support.

`runtime/phone-sessions.json` now uses version 2 with `scoped` records and a
retained `legacy` object. Old character-ID-only entries are never read as live
sessions. Serialized writes preserve other scopes and their legacy archive.
Unknown identities keep provider sessions only in the bridge process for the
current phone world. They do not persist them across a bridge restart or load.

## Verification and remaining boundaries

The focused Node/Fengari suite exercises two contacts, users and campaigns;
rollback branches; reload generations and activation leases; cancellation
during context/network work; legacy retention; unknown identity; snapshot
audiences; durable session recovery keys; and launch-only disappearing history.

This establishes local routing and persistence behavior, not live native-save
identity or remote memory correctness. A stored provider session is transport
continuity, not a confirmed LTM receipt. Abort prevents local publication; it
cannot reverse remote work already accepted. Native restoration, ledger
promotion and delivered-conversation receipts remain owned by their respective
coordinators. Branch ancestry is not inferred or copied from a future transcript.
Explicit, checkpoint-qualified local replay can be added by the parent ledger;
the phone module never guesses such a migration.
