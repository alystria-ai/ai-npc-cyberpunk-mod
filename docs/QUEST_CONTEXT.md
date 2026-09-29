# Current-save quest context

Companions receive the tracked quest and its active, revealed objectives when V
starts a conversation. This is read-only: no journal entries are activated,
tracked, visited or completed by this feature.

## Ownership and scope

- `mod/quest-context.lua` reads the live `JournalManager`. It follows the tracked
  entry to its quest, checks the active state, then visits only active quest,
  phase and objective nodes. Inactive and finished branches are excluded before
  reading descriptions. It does not load quest assets, endings or codex links.
- The tracked objective comes first. Up to eight visible objectives include
  optional status and verified counters where available. Traversal is bounded
  by depth, node count and visited hashes; localized labels have size limits.
- Every capture uses fresh native handles and returns plain data. No journal,
  quest, player or objective reference is retained across frames or save loads.
  Missing/untracked/unavailable states explicitly replace earlier assumptions.
- F6 captures at submission. A group question captures once at round start;
  its actual and prepared speakers share that snapshot. F7 captures when recording
  starts. Phone Chat captures on send, without changing the displayed message.
- The bridge validates and normalizes the snapshot. Only expected public fields
  enter the prompt. Malformed context becomes unavailable; it cannot discard the
  user's message or inject arbitrary extra metadata into the context.
- The realtime client replaces context silently before sending the original
  text. HTTP/phone messages put the same bounded context before V's text.
  Quest changes participate in preparation identity, so a prepared answer cannot
  be claimed with a different quest snapshot.
- The journal is explicitly shared with the companion as usable knowledge:
  questions about the next step should use the supplied objectives, prioritizing
  the tracked one. If only a quest title is available, the next step is unknown.
  Instructions distinguish journal facts from eyewitness knowledge and forbid
  treating tracking as completion. They request relevant discussion without
  hidden outcomes or fabricated progress. Model adherence still needs live checks;
  filtering input cannot guarantee every generated sentence is spoiler-free.

This supplies context when V speaks. Automatic battle, loot and exploration
reactions remain separate backlog items.

## Evidence — September 29

- Reviewed Dawnwalker 0.5.5 `targeting.lua` quest/observation snapshots for intent:
  use revealed journal facts and distinguish them from companion knowledge.
  Cyberpunk uses its own journal API and state filters.
- Inspected the running game's journal classes and function parameters with a
  temporary read-only probe. The game's notification source uses
  `JournalQuest.GetTitle(journalManager)`; objective descriptions take no argument.
- The actual game capture returned **Nocturne Op55N1**, with one active objective:
  **Meet Hanako at Embers.** The production capture completed without an error.
  The diagnostic receipt stays in the installed mod's ignored runtime folder.
- 53 affected checks passed: hidden/completed branches, optional counters,
  localization, bounded cycles, save changes, unavailable data, group snapshots,
  preparation identity, phone delivery, protocol validation and silent realtime
  context replacement. All six changed Lua files parse; the realtime bundle built.
- Lua files were installed with hash verification and the user reloaded CET.
  Their first Alex/Judy objective questions failed: the input contained
  **Meet Hanako at Embers**, but the answers told V to check their own journal.
- Isolated text-only sessions reproduced that refusal. Convai's `serverResponse`
  confirmed successful context replacement and echoed the objective intact.
  Waiting for that acknowledgement, using `updateDynamicInfo`, supplying context
  at connection time, and placing the original context beside the question still
  produced refusals. This was not fixed by a transport delay.
- Making knowledge ownership explicit corrected the isolated reply with the same
  objective question: **You're supposed to meet Hanako at Embers.** The production
  prompt now says the verified journal is shared with the companion and should
  be used to answer relevant questions, while retaining the limits on hidden
  events and eyewitness claims. No remote character profile was changed.
- The correction passed the same 53 affected checks and was applied by restarting
  only the hidden bridge (PID 23836). Cyberpunk stayed open, the saved Convai voice
  choice stayed active, and the local voice model stayed unloaded. The user
  confirmed the repeat F6 check works. Their subsequent input tracked **Freedom**;
  Judy replied that V had a message from Muamar to check, matching the updated
  objective. F8 and phone propagation have automated coverage; a separate live
  test of each route and the deferred microphone check have not been claimed.

The [Convai message reference](https://github.com/Conv-AI/Convai-Documentation/blob/main/api-reference/core-api-reference/live-apis-beta/client-to-server-messages.md#context-update)
documents silent context replacement and its success receipt. That receipt proves
retention by the context service; it is not evidence that a generated answer used
the information correctly. The ignored `runtime/quest-context-service-probe.json`
stores bounded test replies and receipt metadata without credentials/session IDs.

## Live check

With the Lua update loaded, invite a companion and ask about the current objective in F6.
Compare the answer with the journal. Changing the tracked quest before the next
message should update its context; an F8 exchange keeps one snapshot per question.
Phone Chat uses the same facts with its separate conversation history. Microphone
capture is wired but its user test remains deferred.

For a read-only diagnostic, request `quest-context:<new nonce>` through the
existing request file and inspect `runtime/quest-context-probe.json`. It never
opens menus, presses keys or sends a Convai message.
