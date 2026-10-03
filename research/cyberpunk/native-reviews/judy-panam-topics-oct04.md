# Judy and Panam: bounded conversation topics

October 4, 2026. This increment makes **17 existing source-qualified public claims** available through **12 explicit topic selectors**. It adds no biography claims or runtime quest outcomes. Reviewed quest coverage remains **195 enabled rules / 188 mapped outcomes / 972 unmapped outcomes**.

## What changes

Judy has six topics: childhood/Laguna Bend, grandparents, BD craft, art/editing, the Mox and professional independence. They select ten existing claims. Panam has six: the California migration, her earlier clan crossroads, Mitch/Scorpion, road life, corporate bargains and government favors. They select seven existing claims.

The existing conversation selector now loads four pinned author packs: Johnny, Jackie, Judy and Panam. It still requires an admitted current-world one-to-one private/phone turn, freezes the selected speaker and audience, rejects automatic/group turns, and limits output to three claims and 4,096 UTF-8 bytes. Each added topic selects at most two claims. The prompt requests one relevant detail at a time, permits a natural back-and-forth, and preserves the player's follow-up setting. The authored source text, provenance, qualification limits and three separate Core profile fields remain unchanged; no new sample dialogue or name prefix is added.

## What stays excluded

All six private Judy/Panam rows remain outside these selectors. In particular, explicit keywords do not prove trust, Judy's later return to the lake or Panam's early clan-era circumstances. Their three later-development rows (Judy's dual-actor experiment and Panam's Basilisk material) also remain excluded. Questions about Judy's parents therefore do not unlock the private source pack merely because the player asks.

No existing quest predicate is changed or synthesized. Scorpion's present life state, Panam's present camp membership and V's experience of the dive remain matters for independently qualified current-save facts. Historical source descriptions never establish that the current V witnessed a source scene. Unmapped researched outcomes remain unavailable as runtime facts and durable memories. Topic selection sends no synthetic conversation, memory seed or request for an unused character.

## Evidence and focused verification

The [October 1 native review](judy-panam-intrinsic-oct01.md) establishes the exact actor/line/event joins and current winning raw assets for these author packs. The existing native compiler was run against just these two unchanged packs: Judy's 18 public claims / 978 reference checks and Panam's 15 public claims / 535 reference checks passed against local binary/JSON hashes and typed attribution. This includes all 17 selected claims; the remaining public claims continue through the existing profile material.

Canonical author pins:

| Character | Canonical SHA-256 | Reviewed file SHA-256 |
| --- | --- | --- |
| Judy | `e959ae43a419f3e08a5f05d33a75b1410b67462cfdabc87e2f57ad5b03bd47ef` | `3a4622f1ac370d2e8a280c3e7deb899bee701e87c2fba652f2e131d66cf47ca9` |
| Panam | `c0a60ce91588df608f78be06d6003dcc2e4d9d15c64170c8ddf98501b8f2eb15` | `b8cf0634738dbef31dc0e64da10df64971a92d86a28531d574064945dd28b522` |

A direct local selector check loaded all four packs, selected Judy's childhood and Panam's road-life claims, kept Judy's private parents claim out, and left the drive request without autobiographical material. No new test suite, live conversation, cloud profile update, memory write or game installation was performed. Source integration does not claim live personality or recall acceptance.
