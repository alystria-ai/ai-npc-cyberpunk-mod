# Optional follow-up questions

## Player setting

**Companion Manager → Settings → Conversations → Follow-up questions** defaults
to **Off**. Missing or invalid old settings migrate to Off. An explicitly saved
On choice is retained. MCM Apply/Revert uses the existing atomic settings save.

Off tells the character to answer without adding a question or invitation merely
to prolong the exchange. It still permits a necessary clarification or a question
the player explicitly requests. On asks the character to answer and add one brief,
relevant follow-up in their own voice. It omits that question when V says goodbye,
explicitly requests no questions, or requests an exact fixed reply.

Private F6, F7 microphone and phone Chat share this policy. For F8 group text,
only the final remaining scheduled speaker may ask a follow-up when enabled.
Automatic battle and loot comments never ask questions, with either setting.
F9 group microphone is still separate unfinished work.

## Turn ownership

- Private text captures the setting on Send. Phone Chat captures on Send and
  keeps the value in its pending request through polling and retries.
- F7 captures on recording start. Refreshing world facts at recording finish
  preserves the preference. The bridge rejects a changed preference on that
  existing recording, just as it rejects a changed recipient.
- Group text captures once at the beginning of the round. Later setting changes
  apply to the next round. If a speaker leaves, the next dispatch recalculates
  which remaining speaker is last. Previously generated speech is not rewritten,
  and no extra turn is created just to add a question.
- Speculative group replies, input validation and trusted knowledge attachments
  include this preference in their context identity. A prepared reply cannot be
  claimed under a different preference.
- Enabling this option never opens a text box, starts the microphone, creates a
  synthetic player message, or starts another request after a response. The
  player chooses when to reply.

The preference is per-turn prompt context, not a permanent biography edit or a
memory seed. Missing/malformed IPC values mean Off without losing valid messages.
`bridge/conversation-style.mjs` appends the policy after the verified context;
existing automatic-reaction triggers retain their stronger no-question rule.

## Verification boundaries

Executable checks cover the real Lua send, group, phone and microphone adapters,
the bridge parsers and context, prepared-reply invalidation, departing speakers,
and saved native MCM draft/Apply/Revert behavior. These prove policy routing and
ownership. Model adherence remains probabilistic and needs live listening;
output is not rewritten or stripped after speech has been generated.

September 30 validation: **991 tests passed**, with zero failures or skips,
including the installed MCM API. After shortening the Off instruction, all 48
affected context/phone checks passed again. In-game setting and spoken behavior
are still awaiting the user's check.

This change uses Lua and bridge code only. It requires one CET **Reload All
Mods** after installation and a bridge restart, with no game restart. Live
microphone testing remains deferred at the user's request.

Installed September 30 from `135264d`: Lua files and catalogues were hash
verified; the restarted bridge reported ready with no startup stderr. The user
has been asked for one CET reload and a default-Off private reply check.
