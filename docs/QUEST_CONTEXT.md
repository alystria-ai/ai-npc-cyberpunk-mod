# Current-save quest context

The October 5 reviewed pack has **768 enabled rules / 749 mapped outcomes** out
of 1,162 researched outcomes (413 unmapped, each with a reason). See
[the October 5 verification and expansion](QUEST_OUTCOME_COVERAGE_2026-10-05.md)
for the end-to-end evidence, per-character counts, the Johnny co-witness policy
and remaining limits; [priority character coverage](QUEST_PRIORITY_COVERAGE_2026-10-04.md)
records the earlier eight-character pass. Tracked objectives and reviewed branch
knowledge are separate inputs.

Companions receive the tracked quest and its active, revealed objectives when V
starts a conversation. Since October 9 they also get their most recent shared
events with V and V's open jobs by journal category (see below). This is read-only: no journal entries are activated,
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

## Recent shared events and open jobs — October 9

**Why Judy forgot.** World facts were an unordered set. On the user's save Judy
had 15 true facts, including the apartment date, but nothing said which came
last. The journal-history block made it worse: "what did we do last?" matched
the word *last* in **Gig: Last Login** and offered that gig instead.

**Ordering signal.** `JournalManager.GetEntryTimestamp` returns the game time of
an entry's last state change. The save stores the same value per entry (uint32
game seconds, then a uint16 sequence within that second). On six autosaves the
game clock (TimeSystem) advanced with play, and Pyramid Song's objectives
ordered exactly as played. The intra-second sequence exists only in the save,
so live ties are marked `sameMomentAsPrevious` rather than guessed.

**Capture (Lua, inside the existing throttled cycles).**
- `world-knowledge.lua` adds `gameTimeSeconds` to each revealed journal
  observation. It reads the timestamp only when that entry's state differs
  from the last timed state, so a steady journal costs no extra native call.
  One game-clock read is made per capture, on demand.
- `journal-history.lua` adds each quest root's `questType` (`GetQuestType`,
  cached per hash for the session) and `gameTimeSeconds`.
- GameTime is read both as the `seconds` field and through
  `GameTime.GetSeconds`. If the two disagree, no time is used. Any failure
  leaves the field absent and the state unchanged.

**Recent shared events** (`bridge/quest-overview.mjs`).
- Up to 3 events, newest first, at most 2 per quest.
- Only true, audience-permitted *participant*, *witnessed* or *private*
  rules where the character is a declared speaker (or Johnny's co-witness
  policy). Shared-journal and public facts are excluded.
- Each event is timed by the latest journal entry its condition rests on. A
  fact-only rule falls back to its finished quest's completion time, labelled
  as the latest possible time. Untimed events are left out.
- `"recently"` means within 2 in-game days, otherwise `"a while ago"`, plus
  `inGameDaysAgo`.
- With no timed event the section says the order is unknown. With no shared
  event it says not to invent one.

**Open jobs.**
- Active journal quests from the fresh active lane, grouped by the game's own
  type. The headings are the game's labels: MainQuests "Main Jobs";
  SideQuests and MinorQuests "Side Jobs"; StreetStories "Gigs"; Contracts
  "NCPD Scanner Hustles". Other types are only counted.
- The native type is preferred. `bridge/journal-quest-types.mjs`, generated
  from the cooked journal by `build_journal_quest_types.mjs`, is the
  fallback.
- Caps: main 6, side 8, gigs 5, NCPD 3, and a total of 1800 characters.
- The tracked job is flagged and its objectives are not repeated.
- A job counts as the speaker's own only when its researched cast is at most
  5 and either names them alone or they have a verified event in it on this
  save. Own jobs show at most 2 active objectives as `stillToDo`, marked as
  not yet happened. Other jobs are title and category only. Unrevealed and
  finished objectives never appear.
- Temporal words such as *last*, *next* and *take* no longer drive
  journal-history matching.

**Verification on the user's save (AutoSave-8, game day 101).**
`node research/cyberpunk/scripts/save_overview.mjs "<save>" --who judy-alvarez`
rebuilds both captures read-only and prints the sections:

1. Judy's apartment date (*I Really Want to Stay at Your House*, 27 in-game
   days ago, timed by its journal entry).
2. Pyramid Song: continuing the relationship.
3. Pyramid Song: the Laguna Bend dive (34 days ago, by quest completion).

The open jobs were 2 main jobs, 8 side jobs (*One Way or Another* tracked; the
apartment quest with "Meet Judy at your Glen apartment." still to do) and 1
NCPD hustle. River, who shares that quest's cast, gets its title only.

A text probe with a throwaway identity, its memories cleared, compared the old
and new context:
- **Before:** "what did we do last?" got "I don't know what you mean", and
  "what jobs should I take next?" got a deflection.
- **After:** Judy said the last time was when she came over to V's place, a
  while ago. For jobs she named the tracked job and the main jobs.

Residual risk: she often adds "in the Glen", taken from the still-to-do
objective. The date's apartment is not recorded. Without the job list she said
only "your place".

This supplies context when V speaks. [Battle awareness](BATTLE_REACTIONS.md) uses
the same conversation routing; loot and exploration reactions remain backlog items.

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
