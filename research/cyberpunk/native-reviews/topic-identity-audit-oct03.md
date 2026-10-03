# Native topic identity audit

Date: 2026-10-03. Scope: all 195 enabled native rules and their 195 researched narrative links. No game, save, provider, voice or conversation-memory mutation was performed.

## Result

169 links use their catalog topic exactly. 26 existing rules use a different native topic: 20 preserve an existing bounded event namespace, two describe compatible facets, two preserve a mutually exclusive stance domain, and two represent compatible temporal stages. The exact pairs are listed below and declared in `native-topic-aliases.json`.

There is no universal authoring contract that every catalog topic describes mutually exclusive outcomes. Blindly replacing all native topics with catalog topics would break valid histories:

- Panam's room sharing and motel flirt are independent compatible facets. The [prior native review](aldecaldos-oct01.md) explicitly documents distinct topics and coexistence, with separate completed scene receipts and stage guards. The actual resolver emits both facets together; an injected topic rewrite suppresses both as a false conflict.
- Jake's gift invitation precedes collection. The [city-contact review](city-contacts.md) explicitly preserves separate topics so both stages coexist. Collection additionally requires the invitation, positive Life's Work provenance and Jake's debrief. An injected topic rewrite falsely suppresses the legitimate completed-gift history.
- The two farmhouse stances already share one native topic and exclusive group. The [October 1 review](aldecaldos-oct01.md) requires both to be suppressed when contradictory positive observations occur.
- The other twenty differences retain existing native event/outcome identities rather than broadening the claims. Their full statements, conditions, audiences, source references and narrative outcome links are pinned by a canonical authored-rule SHA-256. The per-rule rationale remains in the closed alias document. These are current curated compatibility declarations, not inferred permission for every future outcome under a similarly named topic.

## Exact differences retained

| Native rule | Existing native topic | Linked catalog topic | Reviewed treatment |
| --- | --- | --- | --- |
| `aldecaldos.native.panam-plan-disclosed` | `aldecaldos.panam-plan-disclosed` | `panam.convoy-trust` | identity-preserving-namespace |
| `aldecaldos.native.panam-basilisk-intimacy` | `aldecaldos.panam-basilisk-intimacy` | `panam.romance` | identity-preserving-namespace |
| `aldecaldos.native.panam-relic-explanation` | `aldecaldos.panam-relic-explanation` | `v.relic-known-to-aldecaldos` | identity-preserving-namespace |
| `aldecaldos.native.saul-riders-rescue` | `aldecaldos.saul-riders-rescue` | `saul.captivity` | identity-preserving-namespace |
| `aldecaldos.native.v-aldecaldo-initiation` | `aldecaldos.v-aldecaldo-initiation` | `v.aldecaldo-membership` | identity-preserving-namespace |
| `aldecaldos.native.saul-smasher-death` | `aldecaldos.saul-smasher-death` | `saul.survival` | identity-preserving-namespace |
| `aldecaldos.native.dakota-antenna-disabled` | `aldecaldos.dakota-antenna-disabled` | `dakota.delivery-drones` | identity-preserving-namespace |
| `aldecaldos.native.dakota-minefield-delivery` | `aldecaldos.dakota-minefield-delivery` | `dakota.smuggling-route-recovery` | identity-preserving-namespace |
| `aldecaldos.native.dakota-trevor-returned` | `aldecaldos.dakota-trevor-returned` | `trevor.remains` | identity-preserving-namespace |
| `aldecaldos.native.dakota-sparring-delivered` | `aldecaldos.dakota-sparring-delivered` | `red-joe.training-software` | identity-preserving-namespace |
| `aldecaldos.native.dakota-iris-van-delivery` | `aldecaldos.dakota-iris-van-delivery` | `iris.rescue` | identity-preserving-namespace |
| `aldecaldos.native.dakota-ben-returned` | `aldecaldos.dakota-ben-returned` | `ben.extraction` | identity-preserving-namespace |
| `aldecaldos.native.dakota-bruce-returned` | `aldecaldos.dakota-bruce-returned` | `bruce.rescue` | identity-preserving-namespace |
| `aldecaldos.native.dakota-radar-delivered` | `aldecaldos.dakota-radar-delivered` | `aldecaldos.radar-prototype` | identity-preserving-namespace |
| `aldecaldos.native.basilisk-convoy-secured` | `aldecaldos.basilisk-convoy-secured` | `aldecaldos.basilisk-acquisition` | identity-preserving-namespace |
| `aldecaldos.native.panam-saul-co-leadership` | `aldecaldos.panam-saul-co-leadership` | `aldecaldos.leadership` | identity-preserving-namespace |
| `aldecaldos.native.panam-nash-assistance` | `panam.nash-assistance` | `panam.nash-response` | identity-preserving-namespace |
| `aldecaldos.native.panam-motel-room-shared` | `panam.motel-room` | `panam.motel-intimacy` | compatible-facet |
| `aldecaldos.native.panam-motel-flirt` | `panam.motel-flirt` | `panam.motel-intimacy` | compatible-facet |
| `aldecaldos.native.farmhouse-initially-backed-panam` | `aldecaldos.farmhouse-stance` | `aldecaldos.corporate-policy-stance` | mutually-exclusive-stance |
| `aldecaldos.native.farmhouse-backed-saul` | `aldecaldos.farmhouse-stance` | `aldecaldos.corporate-policy-stance` | mutually-exclusive-stance |
| `aldecaldos.native.panam-farmhouse-flirt` | `panam.farmhouse-overture` | `panam.early-affection` | identity-preserving-namespace |
| `city-native.nam-recovered` | `nam.recovery-completed` | `nam.rescue` | identity-preserving-namespace |
| `city-native.jake-gift-offered` | `jake.quadra.invitation` | `jake.quadra.gift` | compatible-stage |
| `city-native.jake-gift-collected` | `jake.quadra.collected` | `jake.quadra.gift` | compatible-stage |
| `silverhand.porsche-recovered` | `silverhand.porsche-recovery` | `johnny.possessions.porsche` | identity-preserving-namespace |

## Qualification gate

`scripts/narrative_topic_identity.mjs` requires an exact linked topic or an explicit reviewed alias for the exact rule/decision/outcome pair. Each alias pins the full authored rule, both topic names and its treatment. A changed rule, changed catalog topic, wrong outcome, unreviewed record, duplicate or missing declaration rejects qualification. New aliases are never inferred from the current mismatch list.

An exact catalog topic cannot bypass a previously reviewed native domain for a new alternative. A future mapping must join the existing native domain or qualify its own distinct facet/stage. This prevents preserving a legacy alias while silently routing the opposing outcome into a nonconflicting new topic.

The evidence compiler applies this gate before counting an outcome mapped. Its production path also requires the referenced nonempty review document inside the bounded research review directory, records its digest, and refuses generated-pack output/application on errors. Runtime topic names, outcome names and conflict code remain unchanged.

`scripts/audit_native_topics.mjs` offers a read-only repeatable audit and can write a fresh ignored runtime receipt. It does not requalify native bytes or approve newly discovered aliases. Full native binary/JSON qualification remains in `build_native_pack.mjs`.

## Verification and remaining limits

The actual older Aldecaldo source is rejected without its 22 explicit alias records and accepted with the pinned declarations. Tests also reject changed authored statements/topics, changed catalog topics, missing canonical metadata, unreviewed/duplicate/wrong-outcome aliases, and a proposed exact-catalog shortcut around an existing native domain. Actual full-pack Panam and Jake resolver fixtures verify compatible histories and reproduce why a blanket rewrite is incorrect.

The River/Joss reviewer separately found and corrected a new accidental Harris topic mismatch, a dependent claim escaping a contradictory rescue route, and wording that overclaimed V not witnessing an offscreen event. Those corrections are documented in [the event-history review](river-joss-oct03.md). The corrected facts remain source-only; no live-save acceptance is claimed.

The topic audit compares current authored rules, the decision catalog and documented prior native review scopes. It does not re-review every earlier scene's entire story semantics or certify all possible future cross-quest contradictions. New incompatible premises still need correctly authored shared conflict groups. Source hashes and metadata identity cannot independently prove every natural-language interpretation.
