# Convai memory API qualification

Run: 2026-09-29T22:02:00.086Z

- Profile: one disposable mod-owned test character (receipt hash `0c65c826071276f6`).
- Selected model: `fast-gemma-4-31b-it`; production character IDs modified: **0**.
- No user message, microphone audio or model-generation request submitted. Synthetic facts only; two newly generated end-user UUIDs.
- Result: **explicit REST qualification passed**.
- Disposable profile removal verified: **yes**.

- Individual memory records removed and lists empty before profile deletion: A **yes**, B **yes**.

| Check | Observed result |
| --- | --- |
| separateProfileFields | true |
| memoryInitiallyEnabled | false |
| memoryEnabledReadback | true |
| modelReadback | fast-gemma-4-31b-it |
| registeredUsersViaConnect | true |
| newUsersEmpty | true |
| userAAddListGet | true |
| crossUserGetB | {"denied":true,"status":403} |
| userBAddListGet | true |
| crossUserGetA | {"denied":true,"status":403} |
| distinctUserLists | true |

Earlier setup probes: [{"removed":true,"failure":{"code":"HTTP_ERROR","status":404}},{"removed":true,"failure":{"code":"CONNECT_TRANSPORT_MISMATCH"}},{"removed":true,"failure":{"code":"UNEXPECTED_FAILURE"}},{"removed":true,"failure":{"code":"REGISTER_SOCKET_ERROR"}}]. Every earlier disposable profile was removed before the next run.

Redacted provider diagnostics: `[{"endpoint":"/memory/get","status":403,"message":"Memory [redacted-id] does not belong to this character-user pair."},{"endpoint":"/memory/get","status":403,"message":"Memory [redacted-id] does not belong to this character-user pair."}]`.

## What this proves

The recorded results qualify character memory configuration readback and explicit add/list/get ownership for the tested account and model configuration. They do not prove automatic conversation extraction, cancellation exclusion, dynamic-context extraction behavior, save restoration, or realtime conversational recall. No production memory setting was enabled by this script.

## Exact supported wire

Character enable uses POST `/character/update` with `{charID,memorySettings:{enabled:true}}`; readback uses POST `/character/get` and `memory_settings.enabled`. The write/read casing difference is deliberate. Memory operations use JSON POST `/memory/add|list|get|delete` with `character_id` and `end_user_id`.

[Official Unreal memory implementation](https://github.com/Conv-AI/Convai-UnrealEngine-SDK-V4/blob/98575b10a0b85facd570ed29decb5a65a8b3b49b/Source/Convai/Private/RestAPI/ConvaiLTMProxy.cpp), [Web SDK memory guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory), [character API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api). Installed Web SDK 1.7.0 `dist/core/MemoryManager.js` provides the exact memory endpoint bodies.

## Reproducibility and recovery

`node scripts/Qualify-QuestMemory.mjs` previews the plan. `--run` executes or resumes one owned test; the durable receipt prevents accidental duplicate profiles. `--cleanup-only` resumes exact receipt-based cleanup. An explicitly authorized `--new-run --run` archives a verified-cleaned prior receipt before a corrected probe; at most five attempts are permitted and only one profile may remain alive. An ambiguous create or add is never blindly repeated. The hidden browser and official SDK bundle are preflighted before remote profile creation. Keys, raw remote IDs and responses remain out of this report; the detailed recovery receipt is ignored under `runtime/memory-qualification/`. Modern end-user account deletion has no verified wire endpoint here; temporary user records may remain after their character-specific memories and test character are removed.
