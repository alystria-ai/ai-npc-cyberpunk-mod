# Anonymous live sessions and explicit quest memory with automatic character memory disabled

> Historical disposable-profile experiment. Superseded by the one-ID natural
> memory policy in [PLAYER_MEMORY.md](../../docs/PLAYER_MEMORY.md).

Date: 2026-09-29T23:13:39.142Z

- Result: **incomplete**.
- Model: `fast-gemma-4-31b-it`.
- Mode: `memory-disabled-explicit-rest-v1`.
- Character memory readback was exactly disabled before the test: **yes**; after the test: **unverified**. This run never enables memory.
- One disposable profile (receipt hash `e8917bdf1a441a68`); production profiles changed: **0**.
- Reused the exact two synthetic A/B end-user IDs from the earlier qualification. New end-user IDs: **0**.
- 2 earlier incomplete anonymous attempt(s) were separately cleaned before this explicitly authorized corrected attempt. Their ignored receipts and reports were retained; the corrected run verified earlier disposable profiles absent before creating its own. At most one probe profile was alive at a time.
- No user message, microphone, dynamic context, or explicit generation request. Outbound application messages were restricted to the SDK's readiness handshake.
- Disposable profile absence confirmed: **yes**.
- Synthetic record cleanup: A **no write was dispatched**, B **no write was dispatched**.

| Empty SDK connection | Identity contract | Disconnected |
| --- | --- | --- |
| anonymousBefore | incomplete | yes |
| A | not attempted | unverified |
| B | not attempted | unverified |
| anonymousAfter | not attempted | unverified |

Explicit A/B add, list, get and cross-user denial: **incomplete**.

Failure code: `EMPTY_CONNECT_CONTRACT_FAILED`.

## Scope of the result

The qualification requires actual SDK connect JSON, server response and client-state evidence. Both anonymous connections must omit `end_user_id` and receive null identity, before and after explicit REST memory writes. The two registration connections must echo the existing IDs exactly and all four connections must close cleanly. The table above distinguishes checks reached from checks not attempted.

An empty-session test cannot prove that spoken or dynamically injected content can never be extracted by an undocumented backend path. No conversation was generated to test extraction or recall. No independent per-session read/write flags are asserted. An incomplete result does not append qualification to the original explicit REST receipt.

## Run and recover

`node scripts/Qualify-AnonymousQuestMemory.mjs --memory-disabled` prints the plan without provider calls. Add `--run` for the one bounded probe; an existing completed or cleaned receipt cannot create another profile. Add `--cleanup-only` to recover exact receipt-owned resources. Ambiguous writes are not blindly retried. The source receipt and new receipt are locked during execution. Successful qualification is atomically appended to the original receipt only after every check and record/profile cleanup passes. Raw IDs and credentials are excluded from this report; recovery state is ignored under `runtime/anonymous-memory-disabled-qualification/`.

The prior [memory-enabled negative qualification](ANONYMOUS_MEMORY_QUALIFICATION.md) is retained separately. Its HTTP 400 is not overwritten by this different policy test.

## Sources

- [Official Connect API](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/api-reference/core-api-reference/live-apis-beta/connect-api.md) documents omitted identity as null for single-character connections.
- [Official Web SDK memory guide](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory.md) documents standalone MemoryManager access.
- Installed `@convai/web-sdk@1.7.0` provides the connect serializer, null identity state and clean LiveKit disconnect path.
