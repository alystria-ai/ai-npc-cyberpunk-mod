# October 1 companion integration

## Scope and current evidence

This update implements the latest user choices. Source verification and installed
game verification are recorded separately; a native API contract or passing test
does not establish that its animation looks correct in Cyberpunk.

| Area | Implemented behavior | Evidence before installation |
| --- | --- | --- |
| Character knowledge | 76 intrinsic packs across the 79-profile roster; 627 public claims and 431 original spoken examples | Current native resource hashes, typed subjects and exact reference checks; 57 ordinary Core profiles updated and read back |
| Local voices | 75 references share one OmniVoice model; 8ug8ear, Jake and the two resident archetypes retain Convai | 247 attributed additional source clips; accepted Johnny/Judy/Panam descriptors unchanged; 94 focused helper checks |
| Relationships | Auto/On/Off for Judy, Panam, River, Kerry and Meredith, with separate ordinary/romantic provider profiles | Five alternate profiles provisioned and read back; fixed current-world fact predicates; Meredith remains a casual encounter |
| Memory and Chat | One player identity; persistent Chat; confirmed Forget clears the corresponding history and drafts | Durable reset receipts, alias/family handling, stale-reply fencing and failure/recovery tests; no real history was erased in verification |
| Reactions | Combat and loot stay separate and wait for each other's playback | Separate request ownership and cooldown tests; exploration remains inactive |
| Expressions | Subtle default smile, bounded face reactions, optional correctly correlated provider emotion | One final facial writer, speech-shape preservation, pause/combat/lifecycle tests; rendered appearance still needs verification |
| Vehicles | Fill V's passenger seats, then additional carpools using sourced personal cars where available | Allocation, exact command ownership, actual seat sensing, delayed completion and cleanup tests; native road behavior still needs verification |
| Fast travel | Carry active managed copies through an explicitly observed fast travel transaction | Restore descriptors only after destination readiness; ordinary save loading and death discard the transaction |
| Keys | F4 manager, F6 text, F7 voice, F8 group text, F10 group voice | F9 is native Quick Load; F10 is free in the installed game and saved CET bindings |

Prepared references are enabled without a new listening gate, as requested.
Their receipt says `listeningVerified: false`; attribution is not a claim that
every clone sounds equally good. Startup still prepares only the accepted three
profiles; the rest use bounded lazy conditioning, at most eight cached profiles.

## Development method

1. Split independently reviewable source research and runtime ownership work.
   Source reviewers checked the actual shipped English text, native actor/contact
   bindings, resource hashes, and whether a statement is public biography,
   private context or a conditional event. No quest outcome was fabricated from
   an unavailable fact or a character's mere presence.
2. Compile approved knowledge before touching provider profiles. Preserve the
   old 19 profiles' three public fields, the ordinary character mappings, voices,
   LLM selection and player identity. Update biography, speaking style and spoken
   examples through separate Core API fields, then verify their readback.
3. Model lifecycle ownership explicitly. A turn pins its actual relationship
   profile; a transport transaction owns movement until native release is
   confirmed; one facial writer combines speech with small expression deltas.
4. Test meaningful failure paths: interrupted memory resets, stale completions,
   provider changes during Invite, late emotion packets, occupied seats,
   delayed dismount/deletion and save/load cancellation. Real user memories,
   microphone input and synthetic cloud conversations are not test fixtures.
5. Run the combined source gate with current native evidence and installed MCM
   enabled. The October 1 run passed 1,805 of 1,806 checks; its only remaining
   failure found an old F9 listening hint. That was changed to F10, and all 25
   affected real-adapter integration checks then passed. Earlier failed mock
   assumptions were corrected without weakening production ownership checks.
6. Install Lua/catalog changes with hash verification and a rollback receipt;
   use CET reload for this update. No native script change requires a restart.
   Check real settings, actor commands and rendered output before marking live
   behavior accepted. Keep focused local Git checkpoints; do not publish.

## Deliberate boundaries

- Jake's intrinsic native pack remains held for lack of adequate identity/source
  proof. His previous researched profile remains. The residents remain generic
  archetypes rather than invented canonical people.
- Current quest coverage remains 191 rules and 185 mapped outcomes. Expanded
  intrinsic biography does not mean every possible quest decision is mapped.
- Separate relationship provider IDs have separate remote memories. One player
  UUID is reused; actual bounded phone history can supply conversational
  continuity, but no memory-copy or memory-seeding calls are made.
- Native blinking and accepted eye contact are retained. There is no extra
  expression toggle, per-character voice picker, disappearing-message setting,
  combined battle/loot comment, or save-load party restoration.
- Microphone listening remains user-deferred. The F10 binding can be assigned
  without starting a recording.
- Packaging remains a design, not a qualified release. Portable dependencies,
  licenses and the model asset size still need a buildable distribution plan.
- Local TODO and pause notes are ignored by Git. Credentials, player state,
  transcripts, reset receipts and machine-specific voice settings stay local.

## Installed verification

Pending the combined Lua reload and bridge restart. Append concrete observations
here; do not convert source test results into game acceptance.
