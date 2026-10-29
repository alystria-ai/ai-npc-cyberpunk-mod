// What each main story character knows about the main plot, by the quest that makes them learn it (docs/STORY_KNOWLEDGE.md in spirit, see
// bridge/story-knowledge.mjs). Hand written, reviewed against the repo's research data. Every row names:
//   character   the profile key
//   topic       relic (the chip), johnny (his engram in V's head), dying (the Relic is killing V), arasaka, hellman, mikoshi
//   quest       the cooked journal quest path whose SUCCESS makes the character know it (the same path the finished-quest inventory reports,
//               bridge/journal-history.mjs row.nativePath, and the keys of bridge/journal-quest-types.mjs)
//   questTitle  the quest's name, for people reading this table
//   needsFact   optional: a game fact (the allowlisted world-knowledge facts) that must also read 1 or more, for a disclosure V chose to make or a route V chose
//   groupSafe   true when the others in a group conversation could also know it. A private disclosure is false and never enters a group turn.
//   line        the plain third person statement given to the model (under 160 characters, no dashes, no semicolons)
//   verified    true only when repo research data or a source verified rule says it. An unverified row has NO line text sent to any model.
//   source      where it was verified, or why it could not be
// A character who has nothing unlocked gets nothing. A row for a quest that is not finished is never used.
const row = (character, topic, rest) => Object.freeze({character, topic, groupSafe: false, ...rest});

const PLAYING = 'quests/main_quest/act_01/q101_resurrection';
const RIDE = 'quests/main_quest/prologue/q001_02_dex';
const HEIST = 'quests/main_quest/prologue/q005_heist';
const GHOST = 'quests/main_quest/act_01/q103_warhead';
const WARTIME = 'quests/main_quest/act_01/q104_02_av_chase';
const QUEEN = 'quests/side_quest/sq027_02_raffen_shiv_attack';
const BELLY = 'quests/main_quest/act_01/q114_03_attack_on_arasaka_tower';
const TRANSMISSION = 'quests/main_quest/act_01/q110_03_cyberspace';
const HOLDIN = 'quests/side_quest/sq011_kerry';
const PYRAMID = 'quests/side_quest/sq030_judy_romance';
const GIMME = 'quests/main_quest/act_01/q112_02_industrial_park';
const BELL = 'quests/main_quest/act_01/q115_afterlife';
const DOG = 'ep1/quests/main_quest/q301_crash';

const WHY_UNVERIFIED = 'No repo research data or source verified rule says this character learns it, so nothing is sent.';

export const STORY_KNOWLEDGE = Object.freeze([
  // ---- Panam ----
  row('panam-palmer', 'relic', {quest: QUEEN, questTitle: 'Queen of the Highway', needsFact: 'sq027_panam_knows_about_chip', verified: true,
    line: 'Panam knows V carries a biochip with a personality construct inside it that is harming V, because V told her after the Basilisk fight.',
    source: 'characters/world-knowledge.json aldecaldos.native.panam-relic-explanation (source verified, scene sq027_09_new_camp_wakeup), quest-maps/aldecaldos.json queen-of-the-highway'}),
  row('panam-palmer', 'johnny', {quest: QUEEN, questTitle: 'Queen of the Highway', verified: false, line: '',
    source: 'research/cyberpunk/native-reviews/aldecaldos.md: the Relic rule never names Johnny, and the flag sq027_panam_doesnt_know_about_johnny does not prove a completed disclosure either way',
    note: 'Owner to confirm live whether Panam is told it is Johnny Silverhand. Until then only the personality construct is stated.'}),
  row('panam-palmer', 'dying', {quest: QUEEN, questTitle: 'Queen of the Highway', needsFact: 'sq027_panam_knows_about_chip', verified: true,
    line: 'Panam knows the chip is threatening V\'s life, which is why V is fighting to survive.',
    source: 'characters/world-knowledge.json aldecaldos.native.panam-relic-explanation ("threatening V\'s life")'}),
  row('panam-palmer', 'arasaka', {quest: BELLY, questTitle: 'Belly of the Beast', groupSafe: true, verified: true,
    line: 'Panam fought beside V inside Arasaka Tower during the Aldecaldo assault, where Smasher killed Saul.',
    source: 'characters/world-knowledge.json priority-endings.nomad.breach and aldecaldos.native.saul-smasher-death (both source verified)',
    note: 'The Saul detail only holds on the route this quest belongs to, which finishing the quest implies.'}),
  row('panam-palmer', 'hellman', {quest: WARTIME, questTitle: 'Life During Wartime', groupSafe: true, verified: true,
    line: 'Panam helped V chase down and capture Hellman, the man Rogue named as V\'s lead.',
    source: 'research/cyberpunk/quest-maps/aldecaldos.json life-during-wartime (captured with Panam\'s help) and ghost-town (Rogue\'s Hellman lead), community sources, not native'}),
  row('panam-palmer', 'mikoshi', {quest: BELLY, questTitle: 'Belly of the Beast', groupSafe: true, verified: true,
    line: 'Panam was with V when V connected to Mikoshi during the Aldecaldo assault on Arasaka.',
    source: 'characters/world-knowledge.json priority-endings.nomad.mikoshi-panam (source verified)'}),

  // ---- Judy ----
  row('judy-alvarez', 'relic', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: true,
    line: 'Judy knows V has the Relic chip, because the shared dive at the lake showed her what it is doing in V\'s head.',
    source: 'research/cyberpunk/quest-maps/judy-river.json pyramid-song decision relic-awareness (community source, not native)'}),
  row('judy-alvarez', 'johnny', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: true,
    line: 'Judy saw Johnny Silverhand in V\'s head during the shared dive.',
    source: 'research/cyberpunk/quest-maps/judy-river.json pyramid-song decision relic-awareness (link-revelation, community source, not native)'}),
  row('judy-alvarez', 'dying', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: false, line: '', source: WHY_UNVERIFIED,
    note: 'Talkin\' \'Bout a Revolution only has an optional explanation (explained or symptoms only), no allowlisted fact marks which.'}),
  row('judy-alvarez', 'arasaka', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('judy-alvarez', 'hellman', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('judy-alvarez', 'mikoshi', {quest: PYRAMID, questTitle: 'Pyramid Song', verified: false, line: '', source: WHY_UNVERIFIED}),

  // ---- Johnny ----
  row('johnny-silverhand', 'relic', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Johnny knows he is a personality construct living on the Relic chip in V\'s head.',
    source: 'research/cyberpunk/native-character-claims/johnny-silverhand.json johnny.identity.personality-construct, bridge/johnny-head.mjs'}),
  row('johnny-silverhand', 'johnny', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Johnny knows the Relic put his engram in V\'s head and that the two of them are stuck with each other.',
    source: 'bridge/johnny-head.mjs STANDING.wary, research/cyberpunk/quest-maps/silverhand.json playing-for-time'}),
  row('johnny-silverhand', 'dying', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Johnny knows the Relic is killing V.',
    source: 'bridge/johnny-head.mjs STANDING.wary, characters/world-knowledge.json hw5.pft.viktor.relic-diagnosis'}),
  row('johnny-silverhand', 'arasaka', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Johnny knows he died in the 2023 attack on Arasaka Tower and that Arasaka kept his construct in its labs for decades.',
    source: 'research/cyberpunk/native-character-claims/johnny-silverhand.json johnny.history.codex-tower-death'}),
  row('johnny-silverhand', 'hellman', {quest: GHOST, questTitle: 'Ghost Town', verified: true,
    line: 'Johnny knows V paid Rogue for the Hellman lead and that it led to Panam.',
    source: 'characters/world-knowledge.json jr-priority.rogue.commission (source verified), quest-maps/silverhand.json ghost-town'}),
  row('johnny-silverhand', 'mikoshi', {quest: TRANSMISSION, questTitle: 'Transmission', verified: true,
    line: 'Johnny knows he and V reached Alt beyond the Blackwall and that she spoke of a way into Mikoshi.',
    source: 'characters/world-knowledge.json ahe-native.alt-contact (source verified), quest-maps/silverhand.json transmission'}),

  // ---- Viktor ----
  row('viktor-vektor', 'relic', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Viktor told V the biochip is a bomb with the fuse lit.',
    source: 'characters/world-knowledge.json hw5.pft.viktor.relic-diagnosis (source verified)'}),
  row('viktor-vektor', 'johnny', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Viktor knows Silverhand\'s construct on the chip is overwriting V\'s consciousness.',
    source: 'characters/world-knowledge.json hw5.pft.viktor.relic-diagnosis (source verified)'}),
  row('viktor-vektor', 'dying', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Viktor told V that V has only a few weeks.',
    source: 'characters/world-knowledge.json hw5.pft.viktor.relic-diagnosis (source verified)'}),
  row('viktor-vektor', 'arasaka', {quest: HEIST, questTitle: 'The Heist', verified: false, line: '',
    source: 'Only if V had Jackie\'s body taken to his clinic (research/cyberpunk/quest-maps/heywood.json the-heist, characters/world-knowledge.json hw5.jackie.body-disposition.clinic-seized)',
    note: 'A choice branch with no usable fact here, so it stays with that existing rule.'}),
  row('viktor-vektor', 'hellman', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('viktor-vektor', 'mikoshi', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '', source: WHY_UNVERIFIED}),

  // ---- Jackie (dies in The Heist, so he only ever knows the job) ----
  row('jackie-welles', 'relic', {quest: RIDE, questTitle: 'The Ride', groupSafe: true, verified: true,
    line: 'Jackie knows the job is to steal an Arasaka prototype biochip for Evelyn Parker, because Dex briefed him and V.',
    source: 'characters/world-knowledge.json ah5.ride.dex-briefing (source verified), research/cyberpunk/quest-briefings.json q001_02_dex'}),
  row('jackie-welles', 'johnny', {quest: HEIST, questTitle: 'The Heist', verified: false, line: '',
    source: 'Jackie dies in The Heist before Johnny appears, so he never knows.'}),
  row('jackie-welles', 'dying', {quest: HEIST, questTitle: 'The Heist', verified: false, line: '',
    source: 'Jackie dies in The Heist before V\'s diagnosis, so he never knows.'}),
  row('jackie-welles', 'arasaka', {quest: HEIST, questTitle: 'The Heist', groupSafe: true, verified: true,
    line: 'Jackie saw Saburo Arasaka killed in the Konpeki Plaza penthouse alongside V.',
    source: 'research/cyberpunk/quest-maps/heywood.json the-heist konpeki-witness and arasaka-heist.json the-heist saburo-killing (community sources, not native)'}),
  row('jackie-welles', 'hellman', {quest: HEIST, questTitle: 'The Heist', verified: false, line: '', source: 'Jackie dies in The Heist before the Hellman lead exists.'}),
  row('jackie-welles', 'mikoshi', {quest: HEIST, questTitle: 'The Heist', verified: false, line: '', source: 'Jackie dies in The Heist before Mikoshi comes up.'}),

  // ---- Rogue ----
  row('rogue-amendiares', 'relic', {quest: GHOST, questTitle: 'Ghost Town', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('rogue-amendiares', 'johnny', {quest: BELL, questTitle: 'For Whom the Bell Tolls', needsFact: 'q115_rogue_in_av', verified: true,
    line: 'Rogue agreed to join Johnny\'s assault on Arasaka Tower, with Johnny speaking through V.',
    source: 'characters/world-knowledge.json priority-endings.rogue.assault-commitment (source verified), quest-maps/silverhand.json for-whom-the-bell-tolls',
    note: 'Earlier moments where Rogue first learns Johnny is in V (Chippin\' In, fact sq031_rogue_met_johnny) are not pinned to one quest in the data, so they are not stated.'}),
  row('rogue-amendiares', 'dying', {quest: GHOST, questTitle: 'Ghost Town', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('rogue-amendiares', 'arasaka', {quest: BELL, questTitle: 'For Whom the Bell Tolls', needsFact: 'q115_rogue_in_av', verified: true,
    line: 'Rogue agreed to take part in the assault on Arasaka Tower and boarded the AV.',
    source: 'characters/world-knowledge.json priority-endings.rogue.assault-commitment (source verified)'}),
  row('rogue-amendiares', 'hellman', {quest: GHOST, questTitle: 'Ghost Town', groupSafe: true, verified: true,
    line: 'Rogue sold V the Hellman lead after V paid her, and pointed V to Panam.',
    source: 'characters/world-knowledge.json jr-priority.rogue.commission (source verified)'}),
  row('rogue-amendiares', 'mikoshi', {quest: BELL, questTitle: 'For Whom the Bell Tolls', verified: false, line: '',
    source: 'On the route where Rogue takes part she dies before Mikoshi (quest-maps/silverhand.json knockin-on-heavens-door), so nothing is stated.'}),

  // ---- Kerry ----
  row('kerry-eurodyne', 'relic', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('kerry-eurodyne', 'johnny', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: true,
    line: 'Kerry has met Johnny speaking through V and accepted that it really is Johnny.',
    source: 'characters/world-knowledge.json jr-priority.mansion.recognized (source verified)'}),
  row('kerry-eurodyne', 'dying', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('kerry-eurodyne', 'arasaka', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('kerry-eurodyne', 'hellman', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('kerry-eurodyne', 'mikoshi', {quest: HOLDIN, questTitle: 'Holdin\' On', verified: false, line: '', source: WHY_UNVERIFIED}),

  // ---- River (nothing in the repo data shows River learning any of it) ----
  row('river-ward', 'relic', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),
  row('river-ward', 'johnny', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),
  row('river-ward', 'dying', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),
  row('river-ward', 'arasaka', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),
  row('river-ward', 'hellman', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),
  row('river-ward', 'mikoshi', {quest: null, questTitle: null, verified: false, line: '', source: WHY_UNVERIFIED}),

  // ---- Takemura ----
  row('takemura', 'relic', {quest: PLAYING, questTitle: 'Playing for Time', verified: true,
    line: 'Takemura knows about V\'s Relic predicament and agreed to work with V on it and on Saburo\'s murder.',
    source: 'characters/world-knowledge.json jt.takemura-alliance.agreed (source verified)'}),
  row('takemura', 'johnny', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '',
    source: WHY_UNVERIFIED, note: 'The diner talk is about the Relic predicament, the data does not say Johnny is named.'}),
  row('takemura', 'dying', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('takemura', 'arasaka', {quest: GIMME, questTitle: 'Gimme Danger', needsFact: 'q112_takemura_told_about_jackie', verified: true,
    line: 'Takemura told V that Arasaka took Jackie\'s body and can extract a damaged engram from it with Soulkiller.',
    source: 'characters/world-knowledge.json jt.jackie-capture-disclosed.told (source verified)'}),
  row('takemura', 'hellman', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('takemura', 'mikoshi', {quest: PLAYING, questTitle: 'Playing for Time', verified: false, line: '', source: WHY_UNVERIFIED}),

  // ---- Songbird ----
  row('songbird', 'relic', {quest: DOG, questTitle: 'Dog Eat Dog', verified: true,
    line: 'Songbird knows about the Relic in V\'s head and offered V help with it.',
    source: 'research/cyberpunk/quest-briefings.json ep1 q301_crash overview (community sources, not native)'}),
  row('songbird', 'johnny', {quest: DOG, questTitle: 'Dog Eat Dog', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('songbird', 'dying', {quest: DOG, questTitle: 'Dog Eat Dog', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('songbird', 'arasaka', {quest: DOG, questTitle: 'Dog Eat Dog', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('songbird', 'hellman', {quest: DOG, questTitle: 'Dog Eat Dog', verified: false, line: '', source: WHY_UNVERIFIED}),
  row('songbird', 'mikoshi', {quest: DOG, questTitle: 'Dog Eat Dog', verified: false, line: '', source: WHY_UNVERIFIED}),
]);

export const STORY_CHARACTERS = Object.freeze(['panam-palmer', 'judy-alvarez', 'johnny-silverhand', 'viktor-vektor', 'jackie-welles',
  'rogue-amendiares', 'kerry-eurodyne', 'river-ward', 'takemura', 'songbird']);
export const STORY_TOPICS = Object.freeze(['relic', 'johnny', 'dying', 'arasaka', 'hellman', 'mikoshi']);
