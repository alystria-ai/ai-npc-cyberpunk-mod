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

September 30 correction: the user's enabled setting reached the bridge as
`true`, but the original prompt only allowed a question. A bounded text-only
provider check reproduced an ordinary On reply with no follow-up. The revised
On policy actively requests one relevant question; goodbye, explicit no-question
and exact-reply requests remain exceptions. Off remains the default, and an
explicit saved On preference is retained.

The same check reproduced a spoken-text `8ug8ear:` prefix. All 79 profiles now
use response-only examples, and the per-turn context requires dialogue without
speaker labels. See `CHARACTER_API.md` for the profile repair and preservation
checks. No generated text is stripped after audio has already been synthesized.

The combined change passed **998 automated tests**, with zero failures or skips,
including the installed MCM API. All 14 context checks passed again after the
farewell-priority wording adjustment below. Automated checks cover policy routing;
the actual spoken result and rendered settings still require an in-game check.

### Bounded provider results

`scripts/Check-ConversationStyle.mjs` defaults to an offline plan. An explicit
`--run` reuses the existing isolated research identity and fresh text-only
sessions. It never uses the player's identity, creates new IDs or generates
test conversations in the game. The tested responses were read in full;
question-mark counts alone were not treated as proof of a relevant follow-up.

- The three-turn baseline reproduced both the name prefix and an omitted On
  follow-up.
- After cloud repair, private On/Off pairs for 8ug8ear, Judy and Johnny behaved
  as requested. The first group speaker answered without a question; the final
  speaker asked one. An explicit no-question request was respected. None of the
  ten replies used a speaker-name prefix.
- The initial goodbye reply still asked a question. The prompt now makes
  leaving/no-question/fixed-reply intent take priority before describing the
  ordinary On behavior. Four targeted turns then produced two brief goodbyes,
  a no-question answer, and an ordinary answer with a relevant question. All
  four omitted speaker-name prefixes.

These are observed examples, not a guarantee of every future model output or
an audible check of all 79 characters. Private receipts remain under
`runtime/conversation-style-check/` (`before-2026-09-30T07-31-46-379Z.json`,
`after-2026-09-30T07-49-06-744Z.json`, and
`exceptions-2026-09-30T07-51-41-205Z.json`).

The user subsequently confirmed a live Judy F6 reply with a relevant question
and no spoken name prefix while the setting was On. This accepts that private
conversation path; group follow-ups and live microphone input remain separate
listening checks.

This change uses Lua and bridge code only. It requires one CET **Reload All
Mods** after installation and a bridge restart, with no game restart. Live
microphone testing remains deferred at the user's request.

The original `135264d` installation is superseded by the September 30 corrections
above. The user already enabled the toggle, so activation must preserve that On
choice instead of resetting it to the new-user default.
