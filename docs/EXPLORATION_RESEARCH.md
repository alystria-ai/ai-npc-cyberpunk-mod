# Exploration remarks — deferred

The user deprioritized this feature on September 30, 2026: skip it unless a reliable automatic native trigger is available. No exploration reactions or settings are installed. The temporary read-only capture was explicitly stopped; it recorded no subtitle events.

## Findings

- The supplied Dawnwalker 0.5.5 reference proves that an authored dialogue graph contains only the player before reacting. A line attributed to the player is insufficient.
- Cyberpunk's `scnDialogLineData` exposes an opaque ID, text, speaker, subtitle type, persistence and duration. It has no scene path, participant list or solo-observation flag.
- `IsEntityInDialogue` and scene tier are useful interruption gates, but cannot distinguish an exploration remark from a quest line.
- Locally extracted `sts_std_arr_01_room_new.scene` has apparent V self-observations; all four reachable entry graphs also contain Johnny dialogue. Missing/self addressee metadata does not prove a solo scene.
- The runtime subtitle ID has not been correlated with the scene event ID or localization string ID. Subtitle removal is not independently proven uninterrupted voice completion.

The ignored `runtime/exploration-research/` directory retains bounded SoundDB discovery results, one locally extracted scene, the inactive probe receipt, and deferred policy/protocol prototypes. None are added to the production loader or deployment list. Prototype tests do not qualify the native feature. Do not enable reactions from generic player subtitle callbacks or ask the user to manufacture a solo line merely to progress this optional feature.

The accepted battle and loot reactions remain unchanged.
