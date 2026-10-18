import {readFileSync, realpathSync, statSync} from 'node:fs';
import {resolve, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertPlainSampleDialogues} from '../../../scripts/character-samples.mjs';
import {jsonPointer} from './build_native_pack.mjs';

const LIMIT = Object.freeze({packs: 79, claims: 128, refs: 2048, sources: 64,
  publicClaims: 24, publicChars: 6000, samples: 10, artifactBytes: 128 * 1024 * 1024});
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const publicDisclosures = new Set(['self-may-volunteer', 'when-identity-is-relevant',
  'on-topic-in-small-amounts', 'light-banter-when-topic-fits', 'only-with-explicit-memory-perspective']);
const compiledViews = new WeakSet();
const qualificationFields = new Set(['evidenceBasis', 'status', 'currentSaveQualified', 'limits', 'viewpoint', 'profileUse']);
// Reviewed against the installed 2.31 typed codex/contact titles and source-hashed
// native actor/speaker joins. These entries are a qualification ledger, not a
// filename, last-name or suffix heuristic. Proposals remain unadopted.
// Independently reviewed 2026-10-01 identities. These exact receipts establish
// authored speakers, a signed document or a contact role; no world registry edge.
export const REVIEWED_HELD_IDENTITY_BINDINGS = freeze({
  "8ug8ear": {
    "kind": "journal-contact",
    "id": "8ug8ear",
    "titles": [
      "8ug8ear"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6851/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6851/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [],
    "authoredDocuments": [
      {
        "reviewId": "held-identity-oct01-8ug8ear",
        "kind": "signed-native-document",
        "evidenceKind": "authored-document",
        "worldRegistryBindingVerified": false,
        "limits": "Written viewpoint only; no spoken accent, old-Net eyewitness history, or live-player relationship.",
        "sources": [
          {
            "id": "held-02",
            "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
            "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
            "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3",
            "depotPath": "base\\journal\\cooked_journal.journal"
          },
          {
            "id": "held-01",
            "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
            "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
            "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
            "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
          }
        ],
        "refs": [
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data/$type","expectedValue":"gameJournalContact"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data/id","expectedValue":"8ug8ear"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data/name/value","expectedValue":"LocKey#10546"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/6851/primaryKey","expectedValue":"10546"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/6851/femaleVariant","expectedValue":"8ug8ear"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/$type","expectedValue":"gameJournalOnscreen"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/id","expectedValue":"generic_guide_net"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/title/value","expectedValue":"LocKey#7270"},
          {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/description/value","expectedValue":"LocKey#7269"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/3788/primaryKey","expectedValue":"7270"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/3788/femaleVariant","expectedValue":"Blaming Bartmoss – by 8ug8ear"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/3787/primaryKey","expectedValue":"7269"},
          {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/3787/femaleVariant","expectedValue":"When I imagine what the Net was like before Bartmoss, I see thousands of potential threats. And thousands of opportunities. Course, the whole system was unstable, corpo runners pulling one way, post-war rogue AIs pulling the other; financial markets tanked, virus mutation spiralled in uncontrollable ways, and runners got cooked in their living rooms every now and then. Bartmoss saw the Net as a grenade waiting for the pin to get pulled. And that's exactly what he did.\\n\\nFuck it, right? Let the world burn.\\n\\nBartmoss fucked the system but fucked all of us right along with it. Just look at it now – corps are on top as usual, the Blackwall (which was supposed to protect us after the net's crash) is just another control tool in NetWatch's arsenal...\\n\\nBefore Bartmoss, the net was an untamed jungle – if you could navigate it, you had a chance to survive. You were free. After Bartmoss, the net's like an airport security check – every step you take NetWatch is checkin your papers and performing a thorough cavity search. Oh, but all for your own good, of course..."}
        ],
        "lines": [],
        "documentRef": {
          "sourceId": "journal",
          "jsonPointer": "/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data",
          "containerType": "gameJournalOnscreen",
          "expectedId": "generic_guide_net",
          "titlePointer": "/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/title/value",
          "contentPointer": "/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data/description/value"
        },
        "author": "8ug8ear",
        "title": "Blaming Bartmoss – by 8ug8ear",
        "titleLocKey": "7270",
        "contentLocKey": "7269",
        "titlePointer": "/Data/RootChunk/root/Data/entries/3788/femaleVariant",
        "contentPointer": "/Data/RootChunk/root/Data/entries/3787/femaleVariant"
      }
    ]
  },
  "coach-fred": {
    "kind": "journal-contact",
    "id": "trainer_fred",
    "titles": [
      "Coach Fred"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/5/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/5/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7205/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7205/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "fistfight_human",
        "voice": "1624173162010259556",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/coach-tutorial/raw/base/base/quest/main_quests/prologue/q001/scenes/q001_02a_fistfight_tutorial.scene.json",
          "assetSha256": "f315616211d560ad85834754418c270fd27f456e9afe5b65b8d26587f6e8d1d8",
          "jsonSha256": "90ff91e38fa90aa447367de3e78a8bac2216648a7d0c50126d1c0b351259ac09",
          "actorPointer": "/Data/RootChunk/actors/1"
        }
      },
      {
        "name": "wat_lch_melee_01",
        "voice": "1624173162010259556",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/coach-default/raw/base/base/open_world/vendors/watson/little_china/wat_lch_melee_01/wat_lch_melee_01.scene.json",
          "assetSha256": "a3f48049fb07477476084ff078e75cb3c13ae2ec151a6938c4558d519c3985a2",
          "jsonSha256": "b8527c1c970d1f79351b902df04c3d3ac4183cc516772f76703dff889c86a845",
          "actorPointer": "/Data/RootChunk/actors/0"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-coach-fred",
      "kind": "reviewed-narrative-identity",
      "evidenceKind": "direct-name-and-response",
      "worldRegistryBindingVerified": false,
      "limits": "Player addresses Fred; tutorial actor answers in the same emitted section. Vendor and tutorial actors use the identical active spawn-set reference and entry. This identifies authored speaker continuity but does not resolve the world registry to a Character record.",
      "sources": [
        {
          "id": "held-02",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-07",
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/coach-tutorial/raw/base/base/quest/main_quests/prologue/q001/scenes/q001_02a_fistfight_tutorial.scene.json",
          "assetSha256": "f315616211d560ad85834754418c270fd27f456e9afe5b65b8d26587f6e8d1d8",
          "jsonSha256": "90ff91e38fa90aa447367de3e78a8bac2216648a7d0c50126d1c0b351259ac09",
          "depotPath": "base\\quest\\main_quests\\prologue\\q001\\scenes\\q001_02a_fistfight_tutorial.scene"
        },
        {
          "id": "held-10",
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-mercs-promoter/raw/base/localization/en-us/subtitles/quest/q001/q001_02a_fistfight_tutorial.json.json",
          "assetSha256": "6079783b3df7a3e3419dd801bc4794e1e9b927ce1351beb28ccf3321cb21a62f",
          "jsonSha256": "08a9eeb9ac8a7dd1d75f0d4f790209bae8d51417d12b91f27e88669fb249f483",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\q001\\q001_02a_fistfight_tutorial.json"
        },
        {
          "id": "held-08",
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/coach-default/raw/base/base/open_world/vendors/watson/little_china/wat_lch_melee_01/wat_lch_melee_01.scene.json",
          "assetSha256": "a3f48049fb07477476084ff078e75cb3c13ae2ec151a6938c4558d519c3985a2",
          "jsonSha256": "b8527c1c970d1f79351b902df04c3d3ac4183cc516772f76703dff889c86a845",
          "depotPath": "base\\open_world\\vendors\\watson\\little_china\\wat_lch_melee_01\\wat_lch_melee_01.scene"
        }
      ],
      "refs": [
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/5/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/5/Data/id","expectedValue":"trainer_fred"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/5/Data/name/value","expectedValue":"LocKey#10923"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7205/primaryKey","expectedValue":"10923"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7205/femaleVariant","expectedValue":"Coach Fred"},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/screenplayStore/lines/15","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1EF96226EC404000"},"itemId":{"$type":"scnscreenplayItemId","id":3841},"locstringId":{"$type":"scnlocLocstringId","ruid":"2231923009650704384"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1EF96226EC404000"},"speaker":{"$type":"scnActorId","id":2},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/0/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":1595,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2231923416330420224"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":3841},"startTime":0,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/locStore/vdEntries/70","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"2231923009650704384"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2779520542124818456"},"vpeIndex":38}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/locStore/vpEntries/38","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Where'd you get 'im, Fred?","variantId":{"$type":"scnlocVariantId","ruid":"2779520542124818456"}}},
        {"sourceId":"held-10","jsonPointer":"/Data/RootChunk/root/Data/entries/14","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Where'd you get 'im, Fred?","maleVariant":"","stringId":"2231923009650704384"}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/playerActors/0","expectedValue":{"$type":"scnPlayerActorDef","acquisitionPlan":"findInContext","actorId":{"$type":"scnActorId","id":2},"animSets":[],"bodyCinematicAnimSets":[],"cyberwareAnimSets":[],"cyberwareCinematicAnimSets":[],"deformationAnimSets":[],"dynamicAnimSets":[],"facialAnimSets":[],"facialCinematicAnimSets":[],"findActorInContextParams":{"$type":"scnFindEntityInContextParams","contextActorName":{"$type":"CName","$storage":"string","$value":"None"},"contextualName":"Player","forceMaxVisibility":0,"specRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"voiceVagId":{"$type":"scnVoicetagId","id":"0"}},"findNetworkPlayerParams":{"$type":"scnFindNetworkPlayerParams","networkId":0},"lipsyncAnimSet":{"$type":"scnLipsyncAnimSetSRRefId","id":2},"playerName":"V","specAppearance":{"$type":"CName","$storage":"string","$value":"default"},"specCharacterRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"specTemplate":{"$type":"CName","$storage":"string","$value":"(None)"},"voicetagId":{"$type":"scnVoicetagId","id":"1103967280742240864"}}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/screenplayStore/lines/16","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":2},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1EF962B8AB404000"},"itemId":{"$type":"scnscreenplayItemId","id":4097},"locstringId":{"$type":"scnlocLocstringId","ruid":"2231923635625410560"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1EF962B8AB404000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/1/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":10165,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2231923680286359552"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":4097},"startTime":1627,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/locStore/vdEntries/71","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"2231923635625410560"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2779520542124818460"},"vpeIndex":41}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/locStore/vpEntries/41","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Off the street. Saw 'im lookin' up at me with these big, sad eyes. So I took the poor pup in, fed him, clothed him…","variantId":{"$type":"scnlocVariantId","ruid":"2779520542124818460"}}},
        {"sourceId":"held-10","jsonPointer":"/Data/RootChunk/root/Data/entries/15","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Off the street. Saw 'im lookin' up at me with these big, sad eyes. So I took the poor pup in, fed him, clothed him…","maleVariant":"","stringId":"2231923635625410560"}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"fistfight_human"},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259556"}},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-07","jsonPointer":"/Data/RootChunk/actors/1/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"wat_lch_melee_01"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#wat_lch_melee_01"}}},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"wat_lch_melee_01"},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259556"}},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-08","jsonPointer":"/Data/RootChunk/actors/0/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"wat_lch_melee_01"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#wat_lch_melee_01"}}}
      ],
      "lines": [
        {
          "sourceId": "held-07",
          "actorPointer": "/Data/RootChunk/playerActors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/15",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/0/Data",
          "expectedVoicetag": "1103967280742240864"
        },
        {
          "sourceId": "held-07",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/16",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/1/Data",
          "expectedVoicetag": "1624173162010259556"
        }
      ]
    }
  },
  "pepe-najarro": {
    "kind": "journal-contact",
    "id": "pepe_el_coyote",
    "titles": [
      "Pepe Najarro"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/64/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/64/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7170/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7170/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "bartender",
        "voice": "1624173162027037464",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/held-pepe-named-oct01/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_kid_01b_meet_your_fixer.scene.json",
          "assetSha256": "afdad5ffee1d0b1535ec9cfac659e31622c0298d12a7fe6aaab299c8fa1bd855",
          "jsonSha256": "875f7fd7d581614d3a1119aba592c27deca4a7ea052574d912c6cd9fbdf9ee0f",
          "actorPointer": "/Data/RootChunk/actors/1"
        }
      },
      {
        "name": "El_Coyote_Barman",
        "voice": "1624173162027037464",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/default-in-person/raw/base/base/quest/minor_quests/mq040/scenes/mq040_01_bar.scene.json",
          "assetSha256": "b8fdf591f639b9d1ddb9e404dae9c6f15006358d7c71b175b250f9ddc53e89a3",
          "jsonSha256": "f3629dd4d9ece41efadf7605ebfed3b609e828dc19e2f6b5d0f087f82a2d32f6",
          "actorPointer": "/Data/RootChunk/actors/3"
        }
      },
      {
        "name": "El_Coyote_Barman",
        "voice": "1624173162027037464",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq040/scenes/mq040_03_ripperdoc.scene.json",
          "assetSha256": "4500ac580c486baadd8d627eb83afe7d4e98e1b4fa8c6490ceadd42c36870432",
          "jsonSha256": "348944c771140cf5b382d4e3ea00c09c1ce88cf6200b93d8ab8a4e1cd957a17f",
          "actorPointer": "/Data/RootChunk/actors/4"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-pepe-najarro",
      "kind": "reviewed-narrative-identity",
      "evidenceKind": "direct-name-and-response",
      "worldRegistryBindingVerified": false,
      "limits": "Direct prologue address and reply establishes bartender as Pepe. Prologue bartender and held bar El_Coyote_Barman retain identical active elcoyote_barman spawn-set fields. The mq040 continuation independently addresses its El_Coyote_Barman phone actor as Pepe; that phone actor uses the separate pepe_holo spawn-set and is not mislabeled as the bar acquisition.",
      "sources": [
        {
          "id": "held-02",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-31",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/held-pepe-named-oct01/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_kid_01b_meet_your_fixer.scene.json",
          "assetSha256": "afdad5ffee1d0b1535ec9cfac659e31622c0298d12a7fe6aaab299c8fa1bd855",
          "jsonSha256": "875f7fd7d581614d3a1119aba592c27deca4a7ea052574d912c6cd9fbdf9ee0f",
          "depotPath": "base\\quest\\main_quests\\prologue\\q000\\scenes\\q000_kid_01b_meet_your_fixer.scene"
        },
        {
          "id": "held-33",
          "jsonPath": "runtime/voice-cast/minor-generic/held-identity-resolution/subtitles/q000_kid_01b_meet_your_fixer.json.json",
          "assetSha256": "14e7dc817db2ac4d389b820194b3e55e0c0ee9d3c913ac21d472517af927c56c",
          "jsonSha256": "12adc479538999d7153f06133c71b2823cf84aa4ec370faf5ba959be52590198",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\q000\\q000_kid_01b_meet_your_fixer.json"
        },
        {
          "id": "held-11",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq040/scenes/mq040_03_ripperdoc.scene.json",
          "assetSha256": "4500ac580c486baadd8d627eb83afe7d4e98e1b4fa8c6490ceadd42c36870432",
          "jsonSha256": "348944c771140cf5b382d4e3ea00c09c1ce88cf6200b93d8ab8a4e1cd957a17f",
          "depotPath": "base\\quest\\minor_quests\\mq040\\scenes\\mq040_03_ripperdoc.scene"
        },
        {
          "id": "held-12",
          "jsonPath": "runtime/voice-cast/minor-generic/history-minor-support/subtitle-evidence/base-mq040_03_ripperdoc.json.json",
          "assetSha256": "57c9a6f5c4a92e338c49dda68a19a1e82199e4c4447b6dd2fb16d1090bc23d95",
          "jsonSha256": "fe3925907d5000a272dd728954cff92f1e3685839952de700f3ba809003078ec",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq040\\mq040_03_ripperdoc.json"
        },
        {
          "id": "held-13",
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/default-in-person/raw/base/base/quest/minor_quests/mq040/scenes/mq040_01_bar.scene.json",
          "assetSha256": "b8fdf591f639b9d1ddb9e404dae9c6f15006358d7c71b175b250f9ddc53e89a3",
          "jsonSha256": "f3629dd4d9ece41efadf7605ebfed3b609e828dc19e2f6b5d0f087f82a2d32f6",
          "depotPath": "base\\quest\\minor_quests\\mq040\\scenes\\mq040_01_bar.scene"
        }
      ],
      "refs": [
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/64/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/64/Data/id","expectedValue":"pepe_el_coyote"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/64/Data/name/value","expectedValue":"LocKey#10883"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7170/primaryKey","expectedValue":"10883"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7170/femaleVariant","expectedValue":"Pepe Najarro"},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/screenplayStore/lines/32","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":5},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1904B8F7744E2000"},"itemId":{"$type":"scnscreenplayItemId","id":8193},"locstringId":{"$type":"scnlocLocstringId","ruid":"1802769123802750976"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1904B8F7744E2000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/35/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2019,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1979373759022534688"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8193},"startTime":12726,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vdEntries/338","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1802769123802750976"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745228"},"vpeIndex":110}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vpEntries/110","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Who? Local guy?","variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745228"}}},
        {"sourceId":"held-33","jsonPointer":"/Data/RootChunk/root/Data/entries/43","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Who? Local guy?","maleVariant":"","stringId":"1802769123802750976"}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"bartender"},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162027037464"}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/actors/1/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"elcoyote_barman"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#elcoyote_barman"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/screenplayStore/lines/33","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_194B7EE6342EF000"},"itemId":{"$type":"scnscreenplayItemId","id":8449},"locstringId":{"$type":"scnlocLocstringId","ruid":"1822690001384566784"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_194B7EE6342EF000"},"speaker":{"$type":"scnActorId","id":5},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/38/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":1,"role":"OnlyLipsync","speakers":[{"$type":"scnAdditionalSpeaker","actorId":{"$type":"scnActorId","id":4},"type":"Holocall"},{"$type":"scnAdditionalSpeaker","actorId":{"$type":"scnActorId","id":3},"type":"Holocall"}]},"duration":3380,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1979373759022534696"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8449},"startTime":15262,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vdEntries/341","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1822690001384566784"},"signature":{"$type":"scnlocSignature","val":"2"},"variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745236"},"vpeIndex":114}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vpEntries/114","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"You really think somebody local'd try to mug me, Pepe?","variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745236"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vdEntries/342","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1822690001384566784"},"signature":{"$type":"scnlocSignature","val":"1"},"variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745232"},"vpeIndex":113}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vpEntries/113","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Ya really think somebody local'd try to mug me, Pepe?","variantId":{"$type":"scnlocVariantId","ruid":"4217260319773745232"}}},
        {"sourceId":"held-33","jsonPointer":"/Data/RootChunk/root/Data/entries/46","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"You really think somebody local'd try to mug me, Pepe?","maleVariant":"Ya really think somebody local'd try to mug me, Pepe?","stringId":"1822690001384566784"}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/playerActors/0","expectedValue":{"$type":"scnPlayerActorDef","acquisitionPlan":"findInContext","actorId":{"$type":"scnActorId","id":5},"animSets":[],"bodyCinematicAnimSets":[{"$type":"scnCinematicAnimSetSRRefId","id":17},{"$type":"scnCinematicAnimSetSRRefId","id":18},{"$type":"scnCinematicAnimSetSRRefId","id":19},{"$type":"scnCinematicAnimSetSRRefId","id":20}],"cyberwareAnimSets":[],"cyberwareCinematicAnimSets":[],"deformationAnimSets":[],"dynamicAnimSets":[],"facialAnimSets":[],"facialCinematicAnimSets":[],"findActorInContextParams":{"$type":"scnFindEntityInContextParams","contextActorName":{"$type":"CName","$storage":"string","$value":"None"},"contextualName":"Player","forceMaxVisibility":0,"specRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"voiceVagId":{"$type":"scnVoicetagId","id":"0"}},"findNetworkPlayerParams":{"$type":"scnFindNetworkPlayerParams","networkId":0},"lipsyncAnimSet":{"$type":"scnLipsyncAnimSetSRRefId","id":5},"playerName":"Player_fpp","specAppearance":{"$type":"CName","$storage":"string","$value":"default"},"specCharacterRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"specTemplate":{"$type":"CName","$storage":"string","$value":"(None)"},"voicetagId":{"$type":"scnVoicetagId","id":"1103967280742240864"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/screenplayStore/lines/34","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":5},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1ABDD770F22EF000"},"itemId":{"$type":"scnscreenplayItemId","id":8705},"locstringId":{"$type":"scnlocLocstringId","ruid":"1926933095683911680"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1ABDD770F22EF000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/45/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3954,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1979373759039311872"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8705},"startTime":21432,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vdEntries/406","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1926933095683911680"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4217260319790522368"},"vpeIndex":117}},
        {"sourceId":"held-31","jsonPointer":"/Data/RootChunk/locStore/vpEntries/117","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Listen, V... I got a problem. Serious this time.","variantId":{"$type":"scnlocVariantId","ruid":"4217260319790522368"}}},
        {"sourceId":"held-33","jsonPointer":"/Data/RootChunk/root/Data/entries/107","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Listen, V... I got a problem. Serious this time.","maleVariant":"","stringId":"1926933095683911680"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/33","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":7},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A90A0F71044D000"},"itemId":{"$type":"scnscreenplayItemId","id":8449},"locstringId":{"$type":"scnlocLocstringId","ruid":"1914206824622772224"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A90A0F71044D000"},"speaker":{"$type":"scnActorId","id":4},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/1/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3170,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344485416976"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8449},"startTime":3214,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":1,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Phone"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/257","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1914206824622772224"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167768"},"vpeIndex":105}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/105","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"OK... What now?","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167768"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/68","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"OK... What now?","maleVariant":"","stringId":"1914206824622772224"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/actorId","expectedValue":{"$type":"scnActorId","id":4}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/actorName","expectedValue":"El_Coyote_Barman"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162027037464"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/4/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"pepe_holo"},"forceMaxVisibility":1,"reference":{"$type":"NodeRef","$storage":"string","$value":"#pepe_holo"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/34","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":4},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A90A1228944D000"},"itemId":{"$type":"scnscreenplayItemId","id":8705},"locstringId":{"$type":"scnlocLocstringId","ruid":"1914207011336409088"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A90A1228944D000"},"speaker":{"$type":"scnActorId","id":7},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/2/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":5493,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344485416980"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8705},"startTime":6266,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/258","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1914207011336409088"},"signature":{"$type":"scnlocSignature","val":"2"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167776"},"vpeIndex":109}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/109","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"I wish I knew, Pepe. I really do. But who am I to make your mind up for you?","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167776"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/259","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1914207011336409088"},"signature":{"$type":"scnlocSignature","val":"1"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167772"},"vpeIndex":108}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/108","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"I wish I knew, Pepe. I really do. But who am I to make your mind up for ya?","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167772"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/69","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"I wish I knew, Pepe. I really do. But who am I to make your mind up for you?","maleVariant":"I wish I knew, Pepe. I really do. But who am I to make your mind up for ya?","stringId":"1914207011336409088"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/playerActors/0","expectedValue":{"$type":"scnPlayerActorDef","acquisitionPlan":"findInContext","actorId":{"$type":"scnActorId","id":7},"animSets":[],"bodyCinematicAnimSets":[],"cyberwareAnimSets":[],"cyberwareCinematicAnimSets":[],"deformationAnimSets":[],"dynamicAnimSets":[],"facialAnimSets":[],"facialCinematicAnimSets":[],"findActorInContextParams":{"$type":"scnFindEntityInContextParams","contextActorName":{"$type":"CName","$storage":"string","$value":"None"},"contextualName":"Player","forceMaxVisibility":0,"specRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"voiceVagId":{"$type":"scnVoicetagId","id":"0"}},"findNetworkPlayerParams":{"$type":"scnFindNetworkPlayerParams","networkId":0},"lipsyncAnimSet":{"$type":"scnLipsyncAnimSetSRRefId","id":7},"playerName":"V","specAppearance":{"$type":"CName","$storage":"string","$value":"default"},"specCharacterRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"specTemplate":{"$type":"CName","$storage":"string","$value":"(None)"},"voicetagId":{"$type":"scnVoicetagId","id":"1103967280742240864"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/35","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":7},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A90A1D3F044D000"},"itemId":{"$type":"scnscreenplayItemId","id":8961},"locstringId":{"$type":"scnlocLocstringId","ruid":"1914207773273673728"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A90A1D3F044D000"},"speaker":{"$type":"scnActorId","id":4},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/3/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":4376,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344485416984"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8961},"startTime":11589,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":1,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Phone"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/260","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1914207773273673728"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167780"},"vpeIndex":112}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/112","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Yeah, yeah, I know. Well... see you.","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167780"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/70","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Yeah, yeah, I know. Well... see you.","maleVariant":"","stringId":"1914207773273673728"}},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/actorId","expectedValue":{"$type":"scnActorId","id":3}},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/actorName","expectedValue":"El_Coyote_Barman"},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162027037464"}},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-13","jsonPointer":"/Data/RootChunk/actors/3/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"elcoyote_barman"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#elcoyote_barman"}}}
      ],
      "lines": [
        {
          "sourceId": "held-31",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/32",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/35/Data",
          "expectedVoicetag": "1624173162027037464"
        },
        {
          "sourceId": "held-31",
          "actorPointer": "/Data/RootChunk/playerActors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/33",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/38/Data",
          "expectedVoicetag": "1103967280742240864"
        },
        {
          "sourceId": "held-31",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/34",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/45/Data",
          "expectedVoicetag": "1624173162027037464"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/4",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/33",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/1/Data",
          "expectedVoicetag": "1624173162027037464"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/playerActors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/34",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/2/Data",
          "expectedVoicetag": "1103967280742240864"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/4",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/35",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/3/Data",
          "expectedVoicetag": "1624173162027037464"
        }
      ]
    }
  },
  "cynthia-najarro": {
    "kind": "journal-contact",
    "id": "rachel_joestar_mq040",
    "titles": [
      "Cynthia Najarro"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/46/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/46/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7175/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7175/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Wife",
        "voice": "1630226362467385344",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq040/scenes/mq040_03_ripperdoc.scene.json",
          "assetSha256": "4500ac580c486baadd8d627eb83afe7d4e98e1b4fa8c6490ceadd42c36870432",
          "jsonSha256": "348944c771140cf5b382d4e3ea00c09c1ce88cf6200b93d8ab8a4e1cd957a17f",
          "actorPointer": "/Data/RootChunk/actors/1"
        }
      },
      {
        "name": "Wife_phonecall",
        "voice": "1630226362467385344",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq040/scenes/mq040_03_ripperdoc.scene.json",
          "assetSha256": "4500ac580c486baadd8d627eb83afe7d4e98e1b4fa8c6490ceadd42c36870432",
          "jsonSha256": "348944c771140cf5b382d4e3ea00c09c1ce88cf6200b93d8ab8a4e1cd957a17f",
          "actorPointer": "/Data/RootChunk/actors/6"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-cynthia-najarro",
      "kind": "reviewed-narrative-identity",
      "evidenceKind": "direct-vocative-and-explicit-self-identification",
      "worldRegistryBindingVerified": false,
      "limits": "Identity use only. Private body history and conditional marital outcomes remain excluded.",
      "sources": [
        {
          "id": "held-02",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-11",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq040/scenes/mq040_03_ripperdoc.scene.json",
          "assetSha256": "4500ac580c486baadd8d627eb83afe7d4e98e1b4fa8c6490ceadd42c36870432",
          "jsonSha256": "348944c771140cf5b382d4e3ea00c09c1ce88cf6200b93d8ab8a4e1cd957a17f",
          "depotPath": "base\\quest\\minor_quests\\mq040\\scenes\\mq040_03_ripperdoc.scene"
        },
        {
          "id": "held-12",
          "jsonPath": "runtime/voice-cast/minor-generic/history-minor-support/subtitle-evidence/base-mq040_03_ripperdoc.json.json",
          "assetSha256": "57c9a6f5c4a92e338c49dda68a19a1e82199e4c4447b6dd2fb16d1090bc23d95",
          "jsonSha256": "fe3925907d5000a272dd728954cff92f1e3685839952de700f3ba809003078ec",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq040\\mq040_03_ripperdoc.json"
        }
      ],
      "refs": [
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/46/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/46/Data/id","expectedValue":"rachel_joestar_mq040"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/46/Data/name/value","expectedValue":"LocKey#10888"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7175/primaryKey","expectedValue":"10888"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7175/femaleVariant","expectedValue":"Cynthia Najarro"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/4","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":7},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_190F28EEF6623000"},"itemId":{"$type":"scnscreenplayItemId","id":1025},"locstringId":{"$type":"scnlocLocstringId","ruid":"1805706982399815680"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_190F28EEF6623000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/3/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2508,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344451862544"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":1025},"startTime":0,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/190","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1805706982399815680"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731802390540"},"vpeIndex":14}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/14","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Hey, you! What're you doing here?!","variantId":{"$type":"scnlocVariantId","ruid":"4024716731802390540"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/3","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Hey, you! What're you doing here?!","maleVariant":"","stringId":"1805706982399815680"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"Wife"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1630226362467385344"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/1/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"wife"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq040_com_apartment"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/5","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_190F2C4081623000"},"itemId":{"$type":"scnscreenplayItemId","id":1281},"locstringId":{"$type":"scnlocLocstringId","ruid":"1805710631159083008"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_190F2C4081623000"},"speaker":{"$type":"scnActorId","id":2},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/6/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3599,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344451862548"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":1281},"startTime":3136,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/191","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1805710631159083008"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731802390544"},"vpeIndex":17}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/17","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Fuck, Cynthia! Told ya to make sure nobody followed you!","variantId":{"$type":"scnlocVariantId","ruid":"4024716731802390544"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/4","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Fuck, Cynthia! Told ya to make sure nobody followed you!","maleVariant":"","stringId":"1805710631159083008"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/actorId","expectedValue":{"$type":"scnActorId","id":2}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/actorName","expectedValue":"Ripperdoc"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010260272"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/2/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"ripperdoc"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq040_com_apartment"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/42","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":7},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1936F53985623000"},"itemId":{"$type":"scnscreenplayItemId","id":10753},"locstringId":{"$type":"scnlocLocstringId","ruid":"1816909127090319360"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1936F53985623000"},"speaker":{"$type":"scnActorId","id":6},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/23/Data/events/1/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":5489,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344485417012"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":10753},"startTime":0,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":1,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Phone"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/209","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1816909127090319360"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167808"},"vpeIndex":133}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/133","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Oh, hi. It's, uh, Cynthia, Pepe's wife? Remember me?","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167808"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/21","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Oh, hi. It's, uh, Cynthia, Pepe's wife? Remember me?","maleVariant":"","stringId":"1816909127090319360"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/actorId","expectedValue":{"$type":"scnActorId","id":6}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/actorName","expectedValue":"Wife_phonecall"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1630226362467385344"}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/actors/6/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"cynthia_holo"},"forceMaxVisibility":1,"reference":{"$type":"NodeRef","$storage":"string","$value":"#cynthia_holo"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/screenplayStore/lines/45","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":7},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1936F57064623000"},"itemId":{"$type":"scnscreenplayItemId","id":11521},"locstringId":{"$type":"scnlocLocstringId","ruid":"1816909362759872512"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1936F57064623000"},"speaker":{"$type":"scnActorId","id":6},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/24/Data/events/1/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3125,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2037214344485417024"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":11521},"startTime":0,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":1,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Phone"}}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vdEntries/210","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1816909362759872512"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167824"},"vpeIndex":144}},
        {"sourceId":"held-11","jsonPointer":"/Data/RootChunk/locStore/vpEntries/144","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Hi, it's Cynthia, Pepe's wife. Remember me?","variantId":{"$type":"scnlocVariantId","ruid":"4024716731819167824"}}},
        {"sourceId":"held-12","jsonPointer":"/Data/RootChunk/root/Data/entries/22","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Hi, it's Cynthia, Pepe's wife. Remember me?","maleVariant":"","stringId":"1816909362759872512"}}
      ],
      "lines": [
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/4",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/3/Data",
          "expectedVoicetag": "1630226362467385344"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/2",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/5",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/6/Data",
          "expectedVoicetag": "1624173162010260272"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/6",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/42",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/23/Data/events/1/Data",
          "expectedVoicetag": "1630226362467385344"
        },
        {
          "sourceId": "held-11",
          "actorPointer": "/Data/RootChunk/actors/6",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/45",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/24/Data/events/1/Data",
          "expectedVoicetag": "1630226362467385344"
        }
      ]
    }
  },
  "dennis-cranmer": {
    "kind": "journal-contact",
    "id": "darryl",
    "titles": [
      "Dennis Cranmer"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/137/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/137/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7019/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7019/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "2849614f40fad84fea3d19543dedf8e1855f23d5fc567286aad9ac7c1a4332a7"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Darryl",
        "voice": "1624173162010259552",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq038/scenes/mq038_01_briefing.scene.json",
          "assetSha256": "c6f424249c63fd39bba97df5b78193f7431e8f7e7b1f31793b0d02125c363796",
          "jsonSha256": "71c9c8615dd712739d8e720dcbcfe9fe7e366103197eed005b8473ec2c58581c",
          "actorPointer": "/Data/RootChunk/actors/0"
        }
      },
      {
        "name": "Darryl",
        "voice": "1624173162010259552",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq038/scenes/mq038_02_ending.scene.json",
          "assetSha256": "856f9d639df1beabae9e313a212353fa29053ebe0a170dc97762290eed65f8c4",
          "jsonSha256": "c3bb3388fd8feeee7128b96149f1834778027f0a4b78a84f242b4ce3892a3361",
          "actorPointer": "/Data/RootChunk/actors/1"
        }
      },
      {
        "name": "Denis",
        "voice": "1624173162010259552",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/held-identity-narrative-oct01/raw/base/base/quest/minor_quests/mq038/scenes/mq038_01b_fisher_village.scene.json",
          "assetSha256": "380d9b176549975fefcc4d746848cb48cd1faf43706f25e073f3622d31b553ab",
          "jsonSha256": "645920f9c50eb67ae722d4b103da2dd7924ba8998867ab230c68140a67f86a11",
          "actorPointer": "/Data/RootChunk/actors/4"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-dennis-cranmer",
      "kind": "reviewed-narrative-identity",
      "evidenceKind": "named-call-transition-and-addressed-reply",
      "worldRegistryBindingVerified": false,
      "limits": "This is a reviewed contextual narrative alias: the Surgeon names Dennis in the third person while replying to Darryl; it is not a full-name self-introduction or a verified world registry edge. The surgeon account remains his attributed private account; no transplant profession, crime, rescue result, payment or gratitude is granted to Dennis universally.",
      "sources": [
        {
          "id": "held-20",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "2849614f40fad84fea3d19543dedf8e1855f23d5fc567286aad9ac7c1a4332a7",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-30",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/held-identity-narrative-oct01/raw/base/base/quest/minor_quests/mq038/scenes/mq038_01b_fisher_village.scene.json",
          "assetSha256": "380d9b176549975fefcc4d746848cb48cd1faf43706f25e073f3622d31b553ab",
          "jsonSha256": "645920f9c50eb67ae722d4b103da2dd7924ba8998867ab230c68140a67f86a11",
          "depotPath": "base\\quest\\minor_quests\\mq038\\scenes\\mq038_01b_fisher_village.scene"
        },
        {
          "id": "held-34",
          "jsonPath": "runtime/voice-cast/minor-generic/held-identity-resolution/subtitles/mq038_01b_fisher_village.json.json",
          "assetSha256": "97a9dc7c27aec63ad4b5dc1e63e917a6f26f3bb6aeae9438aa82fa8b49072e8e",
          "jsonSha256": "c2815cc865b029ba501d11b6b55e6472139c3dbe0142b0f454c8e68e061c087e",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq038\\mq038_01b_fisher_village.json"
        },
        {
          "id": "held-18",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq038/scenes/mq038_02_ending.scene.json",
          "assetSha256": "856f9d639df1beabae9e313a212353fa29053ebe0a170dc97762290eed65f8c4",
          "jsonSha256": "c3bb3388fd8feeee7128b96149f1834778027f0a4b78a84f242b4ce3892a3361",
          "depotPath": "base\\quest\\minor_quests\\mq038\\scenes\\mq038_02_ending.scene"
        },
        {
          "id": "held-19",
          "jsonPath": "runtime/voice-cast/minor-generic/history-gig-contacts-wave3/subtitles/raw/base/base/localization/en-us/subtitles/quest/mq038/mq038_02_ending.json.json",
          "assetSha256": "ef0fed0c85f8a75c62ceb11c52095e7de142d2ff27c3e2ebb74d1167f4f7a4c2",
          "jsonSha256": "c2fd7b2f566b9758a85dd2489039bc35f0198ec819cf51548ced9e9a9f460083",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq038\\mq038_02_ending.json"
        },
        {
          "id": "held-16",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq038/scenes/mq038_01_briefing.scene.json",
          "assetSha256": "c6f424249c63fd39bba97df5b78193f7431e8f7e7b1f31793b0d02125c363796",
          "jsonSha256": "71c9c8615dd712739d8e720dcbcfe9fe7e366103197eed005b8473ec2c58581c",
          "depotPath": "base\\quest\\minor_quests\\mq038\\scenes\\mq038_01_briefing.scene"
        }
      ],
      "refs": [
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/137/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/137/Data/id","expectedValue":"darryl"},
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/137/Data/name/value","expectedValue":"LocKey#10727"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7019/primaryKey","expectedValue":"10727"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/7019/femaleVariant","expectedValue":"Dennis Cranmer"},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/screenplayStore/lines/2","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":6},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A2367C11B44D000"},"itemId":{"$type":"scnscreenplayItemId","id":513},"locstringId":{"$type":"scnlocLocstringId","ruid":"1883463148254842880"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A2367C11B44D000"},"speaker":{"$type":"scnActorId","id":6},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/2/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2828,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2086590917971857416"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":513},"startTime":6665,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/locStore/vdEntries/52","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1883463148254842880"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"3221450358153699340"},"vpeIndex":10}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/locStore/vpEntries/10","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Let's hear what Dennis has to say...","variantId":{"$type":"scnlocVariantId","ruid":"3221450358153699340"}}},
        {"sourceId":"held-34","jsonPointer":"/Data/RootChunk/root/Data/entries/7","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Let's hear what Dennis has to say...","maleVariant":"","stringId":"1883463148254842880"}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/playerActors/0","expectedValue":{"$type":"scnPlayerActorDef","acquisitionPlan":"findInContext","actorId":{"$type":"scnActorId","id":6},"animSets":[],"bodyCinematicAnimSets":[],"cyberwareAnimSets":[],"cyberwareCinematicAnimSets":[],"deformationAnimSets":[],"dynamicAnimSets":[],"facialAnimSets":[],"facialCinematicAnimSets":[],"findActorInContextParams":{"$type":"scnFindEntityInContextParams","contextActorName":{"$type":"CName","$storage":"string","$value":"None"},"contextualName":"Player","forceMaxVisibility":0,"specRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"voiceVagId":{"$type":"scnVoicetagId","id":"0"}},"findNetworkPlayerParams":{"$type":"scnFindNetworkPlayerParams","networkId":0},"lipsyncAnimSet":{"$type":"scnLipsyncAnimSetSRRefId","id":5},"playerName":"Player","specAppearance":{"$type":"CName","$storage":"string","$value":"default"},"specCharacterRecordId":{"$type":"TweakDBID","$storage":"string","$value":"Character.Player_Puppet_Base"},"specTemplate":{"$type":"CName","$storage":"string","$value":"(None)"},"voicetagId":{"$type":"scnVoicetagId","id":"1103967280742240864"}}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/screenplayStore/lines/3","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":6},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_192C9D83FF4E6004"},"itemId":{"$type":"scnscreenplayItemId","id":769},"locstringId":{"$type":"scnlocLocstringId","ruid":"1813997940173070340"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_192C9D83FF4E6004"},"speaker":{"$type":"scnActorId","id":4},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/1/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2876,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"2086590917971857420"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":769},"startTime":0,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":1,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Phone"}}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/locStore/vdEntries/47","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1813997940173070340"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"3221450358153699344"},"vpeIndex":14}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/locStore/vpEntries/14","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Hey, got a status? Find the package?","variantId":{"$type":"scnlocVariantId","ruid":"3221450358153699344"}}},
        {"sourceId":"held-34","jsonPointer":"/Data/RootChunk/root/Data/entries/2","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Hey, got a status? Find the package?","maleVariant":"","stringId":"1813997940173070340"}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/actorId","expectedValue":{"$type":"scnActorId","id":4}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/actorName","expectedValue":"Denis"},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259552"}},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-30","jsonPointer":"/Data/RootChunk/actors/4/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"dennis_holo"},"forceMaxVisibility":1,"reference":{"$type":"NodeRef","$storage":"string","$value":"#dennis_holo"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/screenplayStore/lines/2","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":0},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_19127CCB7D4E6000"},"itemId":{"$type":"scnscreenplayItemId","id":513},"locstringId":{"$type":"scnlocLocstringId","ruid":"1806643613951483904"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_19127CCB7D4E6000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/8/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2353,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1994013092086702084"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":513},"startTime":4544,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vdEntries/59","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1806643613951483904"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2805564431657152520"},"vpeIndex":9}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vpEntries/9","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Holdin' in there all right, Haruyoshi?","variantId":{"$type":"scnlocVariantId","ruid":"2805564431657152520"}}},
        {"sourceId":"held-19","jsonPointer":"/Data/RootChunk/root/Data/entries/2","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Holdin' in there all right, Haruyoshi?","maleVariant":"","stringId":"1806643613951483904"}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"Darryl"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259552"}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/1/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"darryl"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq038_com_darryl"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/screenplayStore/lines/3","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A237C256944D000"},"itemId":{"$type":"scnscreenplayItemId","id":769},"locstringId":{"$type":"scnlocLocstringId","ruid":"1883485569292750848"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A237C256944D000"},"speaker":{"$type":"scnActorId","id":0},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/12/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2126,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1994013092086702092"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":769},"startTime":7490,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vdEntries/66","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1883485569292750848"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2805564431657152524"},"vpeIndex":12}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vpEntries/12","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Dennis give me hope.","variantId":{"$type":"scnlocVariantId","ruid":"2805564431657152524"}}},
        {"sourceId":"held-19","jsonPointer":"/Data/RootChunk/root/Data/entries/9","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Dennis give me hope.","maleVariant":"","stringId":"1883485569292750848"}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"Surgeon"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259596"}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/actors/0/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"surgeon"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq038_com_surgeon"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/screenplayStore/lines/9","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":2},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A2385D16E44D000"},"itemId":{"$type":"scnscreenplayItemId","id":2305},"locstringId":{"$type":"scnlocLocstringId","ruid":"1883496203715661824"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A2385D16E44D000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/4/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":2794,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1994013092103479296"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":2305},"startTime":1839,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vdEntries/70","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1883496203715661824"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2805564431673929728"},"vpeIndex":31}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vpEntries/31","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"He'll tell you his story. Haruyoshi?","variantId":{"$type":"scnlocVariantId","ruid":"2805564431673929728"}}},
        {"sourceId":"held-19","jsonPointer":"/Data/RootChunk/root/Data/entries/13","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"He'll tell you his story. Haruyoshi?","maleVariant":"","stringId":"1883496203715661824"}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/screenplayStore/lines/11","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":2},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1A238767A344D000"},"itemId":{"$type":"scnscreenplayItemId","id":2817},"locstringId":{"$type":"scnlocLocstringId","ruid":"1883497948361576448"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1A238767A344D000"},"speaker":{"$type":"scnActorId","id":0},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/19/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":6793,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1994013092103479304"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":2817},"startTime":15309,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vdEntries/72","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1883497948361576448"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2805564431673929736"},"vpeIndex":37}},
        {"sourceId":"held-18","jsonPointer":"/Data/RootChunk/locStore/vpEntries/37","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Tyger Claws were very angry. I hide in boat, swim to America. Here Dennis save me.","variantId":{"$type":"scnlocVariantId","ruid":"2805564431673929736"}}},
        {"sourceId":"held-19","jsonPointer":"/Data/RootChunk/root/Data/entries/15","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Tyger Claws were very angry. I hide in boat, swim to America. Here Dennis save me.","maleVariant":"","stringId":"1883497948361576448"}},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"Darryl"},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259552"}},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-16","jsonPointer":"/Data/RootChunk/actors/0/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"darryl"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq038_com_darryl"}}}
      ],
      "lines": [
        {
          "sourceId": "held-30",
          "actorPointer": "/Data/RootChunk/playerActors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/2/Data",
          "expectedVoicetag": "1103967280742240864"
        },
        {
          "sourceId": "held-30",
          "actorPointer": "/Data/RootChunk/actors/4",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/1/Data",
          "expectedVoicetag": "1624173162010259552"
        },
        {
          "sourceId": "held-18",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/8/Data",
          "expectedVoicetag": "1624173162010259552"
        },
        {
          "sourceId": "held-18",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/12/Data",
          "expectedVoicetag": "1624173162010259596"
        },
        {
          "sourceId": "held-18",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/9",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/4/Data",
          "expectedVoicetag": "1624173162010259552"
        },
        {
          "sourceId": "held-18",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/11",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/19/Data",
          "expectedVoicetag": "1624173162010259596"
        }
      ]
    }
  },
  "liam-northom": {
    "kind": "journal-contact",
    "id": "liam",
    "titles": [
      "Liam Northom"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/49/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/49/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14372/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14372/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "2849614f40fad84fea3d19543dedf8e1855f23d5fc567286aad9ac7c1a4332a7"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Liam",
        "voice": "1624173162010259524",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json",
          "assetSha256": "1e614ec8620123f5e4a79be4c4585edb903fe3b8c06c1b602300c738ca873bf8",
          "jsonSha256": "0ed2033de14625909cfcf804bc7dfaacaaf1a98b3aa59d6c97966609b6f586c3",
          "actorPointer": "/Data/RootChunk/actors/0"
        }
      }
    ],
    "witnesses": [
      {
        "name": "Lizzy_Wizzy",
        "voice": "1792218388178575360",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq019/scenes/mq019_01_notell_motel.scene.json",
          "assetSha256": "e8baed4c0d2e1b0f2ec0c844b15932797fc948db2f7070a58f76a5c0ac883b92",
          "jsonSha256": "a33417edee6a2e8a303049b6774b91008ab61a8971176bcaad56b8a9f074b8a3",
          "actorPointer": "/Data/RootChunk/actors/0"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-liam-northom",
      "kind": "reviewed-narrative-identity",
      "evidenceKind": "direct-name-and-response-plus-full-name-testimony",
      "worldRegistryBindingVerified": false,
      "limits": "Identity review does not make private relationship, covert backup plans, bribery, symptoms or outcomes universal public history.",
      "sources": [
        {
          "id": "held-20",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "2849614f40fad84fea3d19543dedf8e1855f23d5fc567286aad9ac7c1a4332a7",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-25",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/city-contacts-authenticated-oct01/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json",
          "assetSha256": "1e614ec8620123f5e4a79be4c4585edb903fe3b8c06c1b602300c738ca873bf8",
          "jsonSha256": "0ed2033de14625909cfcf804bc7dfaacaaf1a98b3aa59d6c97966609b6f586c3",
          "depotPath": "base\\quest\\minor_quests\\mq019\\scenes\\mq019_04_manager.scene"
        },
        {
          "id": "held-26",
          "jsonPath": "runtime/voice-cast/minor-generic/history-gig-contacts-wave3/subtitles/raw/base/base/localization/en-us/subtitles/quest/mq019/mq019_04_manager.json.json",
          "assetSha256": "7e16b79eb67ef6a232effc0fedc9ccb19a80ecfa8bf00fd616f67e814805ccbf",
          "jsonSha256": "019628dd1e01f84c98402bd6ca11558decd7f34c19b6bf6a27b62c74816cbab1",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq019\\mq019_04_manager.json"
        },
        {
          "id": "held-23",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/intrinsic-gig-contacts-wave3/raw/base/base/quest/minor_quests/mq019/scenes/mq019_01_notell_motel.scene.json",
          "assetSha256": "e8baed4c0d2e1b0f2ec0c844b15932797fc948db2f7070a58f76a5c0ac883b92",
          "jsonSha256": "a33417edee6a2e8a303049b6774b91008ab61a8971176bcaad56b8a9f074b8a3",
          "depotPath": "base\\quest\\minor_quests\\mq019\\scenes\\mq019_01_notell_motel.scene"
        },
        {
          "id": "held-24",
          "jsonPath": "runtime/voice-cast/minor-generic/history-gig-contacts-wave3/subtitles/raw/base/base/localization/en-us/subtitles/quest/mq019/mq019_01_notell_motel.json.json",
          "assetSha256": "2142eddf02bcbd2e80be083905522642f8275e3906e414125403da1448a9d268",
          "jsonSha256": "f6fb14f419965d74c46df755d534fc7abe967aacc268fb9641bb1c47c475962d",
          "depotPath": "base\\localization\\en-us\\subtitles\\quest\\mq019\\mq019_01_notell_motel.json"
        }
      ],
      "refs": [
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/49/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/49/Data/id","expectedValue":"liam"},
        {"sourceId":"held-20","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/49/Data/name/value","expectedValue":"LocKey#19259"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/14372/primaryKey","expectedValue":"19259"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/14372/femaleVariant","expectedValue":"Liam Northom"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/screenplayStore/lines/50","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":3},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1B01AC545044D000"},"itemId":{"$type":"scnscreenplayItemId","id":12801},"locstringId":{"$type":"scnlocLocstringId","ruid":"1946025992124682240"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1B01AC545044D000"},"speaker":{"$type":"scnActorId","id":1},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/3/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3283,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1984867574969847816"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":12801},"startTime":6480,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/locStore/vdEntries/196","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1946025992124682240"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2541623251059515432"},"vpeIndex":154}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/locStore/vpEntries/154","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Liam, no. Arasaka was very clear--","variantId":{"$type":"scnlocVariantId","ruid":"2541623251059515432"}}},
        {"sourceId":"held-26","jsonPointer":"/Data/RootChunk/root/Data/entries/46","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Liam, no. Arasaka was very clear--","maleVariant":"","stringId":"1946025992124682240"}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"Technician"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1630226362467385344"}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/1/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"technician"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq019_com_night_club"}}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/screenplayStore/lines/51","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1B01AC888144D000"},"itemId":{"$type":"scnscreenplayItemId","id":13057},"locstringId":{"$type":"scnlocLocstringId","ruid":"1946026216285065216"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1B01AC888144D000"},"speaker":{"$type":"scnActorId","id":0},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/5/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":1723,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1984867574969847820"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":13057},"startTime":10390,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/locStore/vdEntries/197","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1946026216285065216"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"2541623251076292608"},"vpeIndex":157}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/locStore/vpEntries/157","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Fuck Arasaka.","variantId":{"$type":"scnlocVariantId","ruid":"2541623251076292608"}}},
        {"sourceId":"held-26","jsonPointer":"/Data/RootChunk/root/Data/entries/47","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Fuck Arasaka.","maleVariant":"","stringId":"1946026216285065216"}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"Liam"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259524"}},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"community"},
        {"sourceId":"held-25","jsonPointer":"/Data/RootChunk/actors/0/communityParams","expectedValue":{"$type":"scnCommunityParams","entryName":{"$type":"CName","$storage":"string","$value":"liam"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#mq019_com_night_club"}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/screenplayStore/lines/34","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1B00C97DC244D000"},"itemId":{"$type":"scnscreenplayItemId","id":8705},"locstringId":{"$type":"scnlocLocstringId","ruid":"1945776580991438848"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1B00C97DC244D000"},"speaker":{"$type":"scnActorId","id":0},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/23/Data/events/11/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":10457,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1984870402853490688"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":8705},"startTime":10916,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/locStore/vdEntries/236","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1945776580991438848"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4117412058409115728"},"vpeIndex":110}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/locStore/vpEntries/110","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Ugh. Anyway, a man. His name's Liam, Liam Northom. Been together a few months, but... I think he's cheating on me.","variantId":{"$type":"scnlocVariantId","ruid":"4117412058409115728"}}},
        {"sourceId":"held-24","jsonPointer":"/Data/RootChunk/root/Data/entries/41","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Ugh. Anyway, a man. His name's Liam, Liam Northom. Been together a few months, but... I think he's cheating on me.","maleVariant":"","stringId":"1945776580991438848"}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"Lizzy_Wizzy"},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1792218388178575360"}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/actors/0/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"lizzy_wizzy"},"forceMaxVisibility":0,"reference":{"$type":"NodeRef","$storage":"string","$value":"#lizzy_wizzy"}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/screenplayStore/lines/38","expectedValue":{"$type":"scnscreenplayDialogLine","addressee":{"$type":"scnActorId","id":1},"femaleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"f_1B00D21C0044D000"},"itemId":{"$type":"scnscreenplayItemId","id":9729},"locstringId":{"$type":"scnlocLocstringId","ruid":"1945786056729481216"},"maleLipsyncAnimationName":{"$type":"CName","$storage":"string","$value":"m_1B00D21C0044D000"},"speaker":{"$type":"scnActorId","id":0},"usage":{"$type":"scnscreenplayLineUsage","playerGenderMask":{"$type":"scnGenderMask","mask":3}}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/24/Data/events/7/Data","expectedValue":{"$type":"scnDialogLineEvent","additionalSpeakers":{"$type":"scnAdditionalSpeakers","executionTag":0,"role":"Full","speakers":[]},"duration":3315,"executionTagFlags":0,"id":{"$type":"scnSceneEventId","id":"1984870402853490708"},"scalingData":null,"screenplayLineId":{"$type":"scnscreenplayItemId","id":9729},"startTime":14973,"type":"0","visualStyle":"regular","voParams":{"$type":"scnDialogLineVoParams","alwaysUseBrainGender":0,"customVoEvent":{"$type":"CName","$storage":"string","$value":"None"},"disableHeadMovement":0,"ignoreSpeakerIncapacitation":0,"isHolocallSpeaker":0,"voContext":"Vo_Context_Quest","voExpression":"Vo_Expression_Spoken"}}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/locStore/vdEntries/243","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantDescriptorEntry","localeId":"en_us","locstringId":{"$type":"scnlocLocstringId","ruid":"1945786056729481216"},"signature":{"$type":"scnlocSignature","val":"3"},"variantId":{"$type":"scnlocVariantId","ruid":"4117412058425892880"},"vpeIndex":124}},
        {"sourceId":"held-23","jsonPointer":"/Data/RootChunk/locStore/vpEntries/124","expectedValue":{"$type":"scnlocLocStoreEmbeddedVariantPayloadEntry","content":"Hehhh... He's my manager.","variantId":{"$type":"scnlocVariantId","ruid":"4117412058425892880"}}},
        {"sourceId":"held-24","jsonPointer":"/Data/RootChunk/root/Data/entries/46","expectedValue":{"$type":"localizationPersistenceSubtitleEntry","femaleVariant":"Hehhh... He's my manager.","maleVariant":"","stringId":"1945786056729481216"}}
      ],
      "lines": [
        {
          "sourceId": "held-25",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/50",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/3/Data",
          "expectedVoicetag": "1630226362467385344"
        },
        {
          "sourceId": "held-25",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/51",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/5/Data",
          "expectedVoicetag": "1624173162010259524"
        },
        {
          "sourceId": "held-23",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/34",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/23/Data/events/11/Data",
          "expectedVoicetag": "1792218388178575360"
        },
        {
          "sourceId": "held-23",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/38",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/24/Data/events/7/Data",
          "expectedVoicetag": "1792218388178575360"
        }
      ]
    }
  },
  "life-coach": {
    "kind": "journal-contact",
    "id": "coach",
    "titles": [
      "Life Coach"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/116/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/116/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6969/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6969/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Coach",
        "voice": "1624173162010259648",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/native-bindings-oct01/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_corpo_03b_fly_to_lizzies.scene.json",
          "assetSha256": "1c0bb8fbd25df5143c7463208684b434156a6d9787fb36ea636c1a494d4f47c7",
          "jsonSha256": "ede33fe5bb919e24f7fb14d0d51eaaca8e0e5b43771790601f5d1210c6cb2801",
          "actorPointer": "/Data/RootChunk/actors/1"
        }
      }
    ],
    "identityQualification": {
      "reviewId": "held-identity-oct01-life-coach",
      "kind": "reviewed-contact-role",
      "evidenceKind": "same-actor-holocall-initializer-to-typed-contact",
      "worldRegistryBindingVerified": false,
      "limits": "No legal name, clinical qualification, live biometrics, current company benefit, or prior session with this V is inferred.",
      "sources": [
        {
          "id": "held-02",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3",
          "depotPath": "base\\journal\\cooked_journal.journal"
        },
        {
          "id": "held-01",
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5",
          "depotPath": "base\\localization\\en-us\\onscreens\\onscreens.json"
        },
        {
          "id": "held-27",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/native-bindings-oct01/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_corpo_03b_fly_to_lizzies.scene.json",
          "assetSha256": "1c0bb8fbd25df5143c7463208684b434156a6d9787fb36ea636c1a494d4f47c7",
          "jsonSha256": "ede33fe5bb919e24f7fb14d0d51eaaca8e0e5b43771790601f5d1210c6cb2801",
          "depotPath": "base\\quest\\main_quests\\prologue\\q000\\scenes\\q000_corpo_03b_fly_to_lizzies.scene"
        },
        {
          "id": "held-32",
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/history-minor-support-oct01/raw/base/base/quest/holocalls/coach/coach_holocall.scene.json",
          "assetSha256": "e821a67afa03aeb663eed4d51c752e2b8f7554372f506e5966ec41f99f611e0f",
          "jsonSha256": "e8edbc24391919e4a0dc9155636f687856dd3f7b23056f18a60106d1306aa1ec",
          "depotPath": "base\\quest\\holocalls\\coach\\coach_holocall.scene"
        }
      ],
      "refs": [
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/116/Data/$type","expectedValue":"gameJournalContact"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/116/Data/id","expectedValue":"coach"},
        {"sourceId":"held-02","jsonPointer":"/Data/RootChunk/entry/Data/entries/3/Data/entries/116/Data/name/value","expectedValue":"LocKey#10664"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/6969/primaryKey","expectedValue":"10664"},
        {"sourceId":"held-01","jsonPointer":"/Data/RootChunk/root/Data/entries/6969/femaleVariant","expectedValue":"Life Coach"},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/actorId","expectedValue":{"$type":"scnActorId","id":1}},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/actorName","expectedValue":"Coach"},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"1624173162010259648"}},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"coach_holo"},"forceMaxVisibility":1,"reference":{"$type":"NodeRef","$storage":"string","$value":"#coach_holo"}}},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/$type","expectedValue":"scnActorDef"},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/actorId","expectedValue":{"$type":"scnActorId","id":0}},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/actorName","expectedValue":"coach"},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/voicetagId","expectedValue":{"$type":"scnVoicetagId","id":"0"}},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/acquisitionPlan","expectedValue":"spawnSet"},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/actors/0/spawnSetParams","expectedValue":{"$type":"scnSpawnSetParams","entryName":{"$type":"CName","$storage":"string","$value":"coach_holo"},"forceMaxVisibility":1,"reference":{"$type":"NodeRef","$storage":"string","$value":"#coach_holo"}}},
        {"sourceId":"held-27","jsonPointer":"/Data/RootChunk/actors/1/holocallInitScn","expectedValue":{"DepotPath":{"$type":"ResourcePath","$storage":"string","$value":"base\\quest\\holocalls\\coach\\coach_holocall.scene"},"Flags":"Soft"}},
        {"sourceId":"held-32","jsonPointer":"/Data/RootChunk/sceneGraph/Data/graph/5/Data/questNode/Data/type/Data","expectedValue":{"$type":"questCallContact_NodeType","addressee":{"HandleId":"14","Data":{"$type":"gameJournalPath","className":{"$type":"CName","$storage":"string","$value":"gameJournalContact"},"editorPath":"","fileEntryIndex":1,"realPath":"contacts/player"}},"applyPhoneRestriction":1,"caller":{"HandleId":"15","Data":{"$type":"gameJournalPath","className":{"$type":"CName","$storage":"string","$value":"gameJournalContact"},"editorPath":"","fileEntryIndex":1,"realPath":"contacts/coach"}},"isRejectable":0,"mode":"Video","phase":"StartCall","prefabNodeRef":{"$type":"NodeRef","$storage":"string","$value":"#holocalls_studio"},"showAvatar":0,"visuals":"Default"}}
      ],
      "lines": []
    }
  },
  "r3n0": {
    "kind": "actor-record",
    "titles": [
      "R3N0"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [],
    "actors": [
      {
        "name": "Seller",
        "voice": "1624173162010259764",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/history-reno-phone-oct01/raw/base/base/quest/minor_quests/mq015/scenes/mq015_02_seller_holocall.scene.json",
          "assetSha256": "3f19852c45592e667689e7e556f49d6d44d957fe5edb514c03b0a3fc05fad249",
          "jsonSha256": "4623208bb3b748c9f588c5da4dc1d446c174856ce7d6c2cccd5e8c142e0d5eb6",
          "actorPointer": "/Data/RootChunk/actors/0"
        }
      }
    ],
    "recordBindings": [
      {
        "record": "Character.mq015_seller",
        "primaryKey": "32025",
        "secondaryKey": "Story-base-gameplay-static_data-database-characters-npcs-records-quest-minor_quests-mq015-mq015_seller_displayName",
        "titles": [
          "R3N0"
        ],
        "localizationQualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        },
        "propertyQualification": {
          "kind": "reviewed-live-property",
          "reviewId": "r3n0-live-property-oct01",
          "reviewPath": "runtime/voice-cast/minor-generic/held-identity-resolution/live-property-review.json",
          "reviewSha256": "5ab6d527ff1a22bd1034603d5bad8bf6fa5b94d9aba01c28bf2e02b270089420",
          "probePath": "runtime/verification/reno-record-name/record-name-probe.json",
          "probeSha256": "6767fcab924b31e61c41338ac870c01305cab2dc7a3e4e6e1064d631691ae0bc",
          "installedReceiptPath": "runtime/verification/reno-record-name/installed-tweakdb-receipt.json",
          "installedReceiptSha256": "89b421b2beab3d4d49b528831041d87f18502efd78a0b6eaf47a649e4d732385",
          "querySnapshotPath": "runtime/voice-cast/minor-generic/held-identity-resolution/record-name-probe.source.lua",
          "querySnapshotSha256": "7bfe732995a2d09af58f354a4ed115f351dcc76c0c51bd6e2e3428ff6ec117c8",
          "record": "Character.mq015_seller",
          "gameVersion": "2.31",
          "capturedAt": 1790872343000,
          "properties": {
            "fullDisplayName": {
              "localized": "R3N0",
              "query": "TweakDB:GetFlat('Character.mq015_seller.fullDisplayName')",
              "luaType": "userdata",
              "localizationKey": "32025",
              "ok": true,
              "value": "LocKey(32025ull)"
            },
            "displayName": {
              "localized": "R3N0",
              "query": "TweakDB:GetFlat('Character.mq015_seller.displayName')",
              "luaType": "userdata",
              "localizationKey": "32025",
              "ok": true,
              "value": "LocKey(32025ull)"
            }
          },
          "installedTweakdbFiles": [
            {
              "absolutePath": "E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\r6\\cache\\tweakdb.bin",
              "name": "tweakdb.bin",
              "bytes": 42028033,
              "sha256": "918f0acfc3f3174b29b5c10b463dfb106b603118c85d24456204a1e2a2ac13f9"
            },
            {
              "absolutePath": "E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\r6\\cache\\tweakdb_ep1.bin",
              "name": "tweakdb_ep1.bin",
              "bytes": 48192743,
              "sha256": "89c7ee678c1366d4c289edc78beaa60ce3d64bf44b300fc3902adc94f6ac14c5"
            }
          ],
          "limits": [
            "Runtime probe is not a fabricated CR2W resource or an offline native-property serialization.",
            "Installed file hashes identify the files present; this review does not prove absence of runtime mod overrides.",
            "This evidence concerns the phone actor; the separate restaurant community acquisition stays unresolved."
          ]
        }
      }
    ]
  }
});

export const REVIEWED_INTRINSIC_SUBJECT_BINDINGS = freeze({
  ...REVIEWED_HELD_IDENTITY_BINDINGS,
  // Wave 3 exact native identity receipts. Narrative speaker identity never
  // supplies an unverified world acquisition edge or authorizes adoption.
  "aaron": {
    "kind": "codex",
    "id": "aaron",
    "titles": [
      "Aaron Waines"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/18/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/18/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/5691/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/5691/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "5bc281ddd6bc506b8bf55fe8b30648b253af972c20276bae14889da3c4a2ecfa"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "259adaeb3109a315e0faa8dbac0c6cbe93442d73f36baa5202e93cffe16c78dd"
        }
      }
    ],
    "actors": [
      {
        "name": "Aaron",
        "voice": "2918414563693977600",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/scenes/ordinary-dialogues/raw/ep1/ep1/quest/minor_quests/mq306/scenes/mq306_01_intro.scene.json",
          "assetSha256": "6374a4d10c5fe828c1c6d34e93d61c12a32e36b913d448dce37fba1fa759400a",
          "jsonSha256": "50017a549aceb41b283f8b3d8405ea0ebbf866fa46aacdcff8c345c95c0dfd29",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/15",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/13/Data/events/1/Data"
        }
      },
      {
        "name": "Aaron",
        "voice": "2918414563693977600",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/wave3-dogtown-extra/raw/ep1/ep1/quest/minor_quests/mq306/scenes/mq306_02_tech_expo_exploration.scene.json",
          "assetSha256": "a33e80c5f094910ef73320575c0cbcae7de78b835848cf68fc8f5c9ca4fe9c22",
          "jsonSha256": "21369984d85bebc20fbc1dcafee71e25f3c3f10144766d9570b87a1e0740ffa0",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/21",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/20/Data/events/2/Data"
        }
      }
    ]
  },
  "adam-smasher": {
    "kind": "codex",
    "id": "adam_smasher",
    "titles": [
      "Adam Smasher"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/16/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/16/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15082/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15082/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "smasher",
        "voice": "1558641050515300352",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json",
          "assetSha256": "7642406d5e724bfd0fa1c662a7934507d68364a022157291aa9492c92f751eb1",
          "jsonSha256": "37898e55518d31fb81e870026aaafd4034d84572599a9861b129b625ed837568",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/10",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/0/Data"
        }
      }
    ]
  },
  "alan-noel": {
    "kind": "codex",
    "id": "alan_noel",
    "titles": [
      "Alan Noël"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/18/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/18/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4509/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4509/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "66ab93833590c40b5071dcbbf1493930b12b4ccc31740842aa6146be7246e256"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "a98fddbe72704b0b63d5684ed62dd8bbafdee36b7bd2f1fd2d9d76f6aee6e818"
        }
      }
    ],
    "actors": [
      {
        "name": "Alan_noel",
        "voice": "3262351441488277504",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/openworld/street_stories/sts_ep1_12/scenes/sts_ep1_12_final_scene.scene.json",
          "assetSha256": "843402a53fda4aaa804c669cfe6a2a080b137f2dd95f5ee721ee9899caa089f9",
          "jsonSha256": "3790d233cb546ebee7b90c866f23dfd280138ad61ca5466bd5260933faf6d12f",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/27",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/32/Data/events/1/Data"
        }
      }
    ]
  },
  "alt-cunningham": {
    "kind": "codex",
    "id": "alt_cunningham",
    "titles": [
      "Alt Cunningham"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/24/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/24/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15084/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15084/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/raw/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "fd069432d89cf374d06516867f5a5fe59f32c4edef294111bc960966769ca26c"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/raw/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "3e6be87fef2764a5bf2c5db6e33fce3cd30c75e6449f997a7af422cc3a1ac620"
        }
      }
    ],
    "actors": [
      {
        "name": "Alt",
        "voice": "1103967280742240264",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/raw/base/quest/main_quests/part1/q110/scenes/q110_14_alt.scene.json",
          "assetSha256": "e9f18b5a26beb061f6e8822b76b53f310867c90218e59eed181ab211bce3398f",
          "jsonSha256": "45823fb1aa91619ca7e69534f3bc11066c60a5b2652cdd2fdcce34093ec4a565",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/6/Data"
        }
      },
      {
        "name": "Alt",
        "voice": "1103967280742240264",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/raw/base/quest/main_quests/part1/q114/scenes/q114_03d_alt_meeting.scene.json",
          "assetSha256": "09a63e641b2c3ed49de2ba4a31cc1e0e52cb7c9067087bf44b4d7eca2dd95b07",
          "jsonSha256": "e60f6bccc010364f524d40e7853dac0138839b20db5db4f5d0520fc3b607f436",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/1",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/5/Data/events/1/Data"
        }
      },
      {
        "name": "alt",
        "voice": "1103967280742240264",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/alt-cunningham-20261014/raw/base/quest/main_quests/part1/q115/scenes/q115_03a_alt.scene.json",
          "assetSha256": "be9965126c13c7d511c1b2690067773785e06e724ba4a755d8394ef9bc8ccb30",
          "jsonSha256": "942b1ce2176271608d6f9f7de4abeeaeab28a1b50acfdd01f292a0375aa75680",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/6/Data/events/1/Data"
        }
      }
    ]
  },
  "ana-friedman": {
    "kind": "codex",
    "id": "ana_friedman",
    "titles": [
      "Ana Friedman"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/13/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/13/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4511/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4511/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "66ab93833590c40b5071dcbbf1493930b12b4ccc31740842aa6146be7246e256"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "a98fddbe72704b0b63d5684ed62dd8bbafdee36b7bd2f1fd2d9d76f6aee6e818"
        }
      }
    ],
    "actors": [
      {
        "name": "Ana",
        "voice": "3262211889930989568",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/openworld/street_stories/sts_ep1_08/scenes/sts_ep1_08_client_meeting.scene.json",
          "assetSha256": "8b740ef961ec0cc03b2852d1a995506b5a4db03d8312b9fd1c907e0ec42711f1",
          "jsonSha256": "89327ea77667d8174eef3e8d03e3523a0f3257e67d7af39688b471b586bb4e42",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/58",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/72/Data/events/3/Data"
        }
      },
      {
        "name": "Ana",
        "voice": "3262211889930989568",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/openworld/street_stories/sts_ep1_08/scenes/sts_ep1_08_client_ending.scene.json",
          "assetSha256": "6fa4dbe1be6237f9c46e2f6377c6c346899a55946022227bdc2ddfb3a111b265",
          "jsonSha256": "b45c092fc216915d83afe31bb0f7fc97f4a6fba0c5df6ee3f713c1fbedfda7d1",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/21",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/16/Data/events/15/Data"
        }
      }
    ]
  },
  "arthur-jenkins": {
    "kind": "journal-contact",
    "id": "agent_jenkins",
    "titles": [
      "Arthur Jenkins"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/132/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/132/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6866/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6866/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Jenkins",
        "voice": "1751491689828077568",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/initial-three/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_corpo_03_jenkins.scene.json",
          "assetSha256": "23b38a7768c6aefc593bcd451c11f7db661044954f37f0805282599a32b87bd9",
          "jsonSha256": "b3fb717a6896c16a5fde70c873e9a43122d5ffc828503b6976e6fa2b53660280",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/74",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/66/Data/events/0/Data"
        }
      }
    ]
  },
  "babs-okoye": {
    "kind": "codex",
    "id": "babs",
    "titles": [
      "Barbara \"Babs\" Okoye"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/22/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/22/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/8305/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/8305/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "5bc281ddd6bc506b8bf55fe8b30648b253af972c20276bae14889da3c4a2ecfa"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "259adaeb3109a315e0faa8dbac0c6cbe93442d73f36baa5202e93cffe16c78dd"
        }
      }
    ],
    "actors": [
      {
        "name": "Babs",
        "voice": "2958153248038883328",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/scenes/ordinary-dialogues/raw/ep1/ep1/quest/minor_quests/mq301/scenes/mq301_01_fireplace.scene.json",
          "assetSha256": "76b1f27586c661e125e6e8a8f611ac9bc131cca2762d2e36ccec7920d75efec3",
          "jsonSha256": "cf46afb60a6213cd920d6431dd85b967190f0825951a01f8cbe288440b63eaef",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/47",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/59/Data/events/14/Data"
        }
      }
    ]
  },
  "bill-mitchell": {
    "kind": "codex",
    "id": "bill_mitchel",
    "titles": [
      "Bill Mitchel"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/14/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/14/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4515/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4515/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "66ab93833590c40b5071dcbbf1493930b12b4ccc31740842aa6146be7246e256"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "a98fddbe72704b0b63d5684ed62dd8bbafdee36b7bd2f1fd2d9d76f6aee6e818"
        }
      }
    ],
    "actors": [
      {
        "name": "Bill_vendor",
        "voice": "3262292272626298880",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/knowledge-wave3-pl-support/raw/ep1/quest/tertiary_characters/default_dialogs/bill_default/sts_10_bill_default.scene.json",
          "assetSha256": "86dd6e762ab2d2124f6f27fff383b5f4e845196605c0bc94c31179318d797ec9",
          "jsonSha256": "5183e69dcd1c472d28a85c60717cf36ce80d809d24b6fc7353b966da256b1ddc",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/18",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/15/Data/events/3/Data"
        }
      }
    ]
  },
  "blue-moon": {
    "kind": "journal-contact",
    "id": "blue_moon",
    "titles": [
      "Blue Moon"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/122/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/122/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6890/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6890/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "ae88da966e4a468d7705f07326f6cc781fd072e423ee6cc6a8ff59cfd29fce4b"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "e9441435f8840d05d07d0fa61907bf927cb1f7fc5c0a231395848bada3014672"
        }
      }
    ],
    "actors": [
      {
        "name": "blue_moon",
        "voice": "1792259170252005376",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/wave3-performers-intrinsic-oct01/raw/base/base/quest/side_quests/sq017/scenes/sq017_10_us_crack_intro.scene.json",
          "assetSha256": "b4b55ee1eac2f0511a431373c01eb80412a622cf22c3c1c435c706687a5c76ce",
          "jsonSha256": "7c89ddabe54ea9757ea702959c9c9df20dea99044794f63846264eeb9b088010",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/44",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/20/Data/events/12/Data"
        }
      }
    ]
  },
  "bob-sagan": {
    "kind": "journal-contact",
    "id": "bob",
    "titles": [
      "Bob Sagan"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/140/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/140/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6912/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6912/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Bob",
        "voice": "1531707735786143744",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04a_camping.scene.json",
          "assetSha256": "3fc9218f1edb9886bcf5e7b469a562232ceb6ae355fbc6533f821d86e652f035",
          "jsonSha256": "6ba75204197502597fd1946039c5ef76e528e4e469cc1dd97a0628db390b5440",
          "actorPointer": "/Data/RootChunk/actors/3",
          "voicetagPointer": "/Data/RootChunk/actors/3/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/19",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/17/Data"
        }
      },
      {
        "name": "Bob",
        "voice": "1531707735786143744",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04_preparations_mitch_bob.scene.json",
          "assetSha256": "42e08d236be72082005f9f0abca632f0ce97975c0b2158a089c9ddd5d93b2318",
          "jsonSha256": "d48d9427560ab1f5857a1044d2ed61cc6f376b1319fba94dcc0eb39609fdc3f4",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/1",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/1/Data/events/6/Data"
        }
      },
      {
        "name": "Bob",
        "voice": "1531707735786143744",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04b_party.scene.json",
          "assetSha256": "bcd013c5059b16a5df05f324e9b9ca1cc503f7ef089810f688f627653694b027",
          "jsonSha256": "aa4cecaef8b7c4c18f463cc8c618bb1ab93aa9134ffa63b13b3c84ad727cba13",
          "actorPointer": "/Data/RootChunk/actors/7",
          "voicetagPointer": "/Data/RootChunk/actors/7/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/130",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/78/Data/events/10/Data"
        }
      }
    ],
    "witnesses": [
      {
        "name": "Bob",
        "voice": "1531707735786143744",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04a_camping.scene.json",
          "assetSha256": "3fc9218f1edb9886bcf5e7b469a562232ceb6ae355fbc6533f821d86e652f035",
          "jsonSha256": "6ba75204197502597fd1946039c5ef76e528e4e469cc1dd97a0628db390b5440",
          "actorPointer": "/Data/RootChunk/actors/3",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/5",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/53/Data"
        }
      }
    ]
  },
  "briana-dolson": {
    "kind": "codex",
    "id": "briana_dawson",
    "titles": [
      "Briana Dolson"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/5/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/5/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4519/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4519/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [
      {
        "name": "briana",
        "voice": "3262300873080205312",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/openworld/street_stories/sts_ep1_03/scenes/sts_ep1_03_mourner.scene.json",
          "assetSha256": "08cf51f72510024238d84c60060c56899a6577296e807283271b6b866388f043",
          "jsonSha256": "052034b733bd07f6c4c34a3c0bb2992bf0ee79c662876970d298a932c8e49f8b",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/23",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/20/Data/events/1/Data"
        }
      }
    ]
  },
  "carol-emeka": {
    "kind": "codex",
    "id": "carol_emeka",
    "titles": [
      "Carol Emeka"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/51/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/51/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/56207/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/56207/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Carol",
        "voice": "1690764978148888576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04_preparations_carol.scene.json",
          "assetSha256": "e7c7697b4f14bd6d8e8f064e8ede851215c04b7cf81a87c698c45aa903da4320",
          "jsonSha256": "f91f15f7a320814a0e3e3a8fb3babb43200fa9384b102a826b5b640252577714",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/10",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/12/Data/events/4/Data"
        }
      },
      {
        "name": "Carol",
        "voice": "1690764978148888576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_03c_dakota_trailer.scene.json",
          "assetSha256": "4532663463e50c4020fe4d6e716ad530577765314acc2a598312d920a5c4bcf6",
          "jsonSha256": "0349797fece30d3a37efc35f704ee7d307de5779837aefc9c1ad2b3d4795746e",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/17",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/19/Data/events/11/Data"
        }
      },
      {
        "name": "Carol",
        "voice": "1690764978148888576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04b_party.scene.json",
          "assetSha256": "bcd013c5059b16a5df05f324e9b9ca1cc503f7ef089810f688f627653694b027",
          "jsonSha256": "aa4cecaef8b7c4c18f463cc8c618bb1ab93aa9134ffa63b13b3c84ad727cba13",
          "actorPointer": "/Data/RootChunk/actors/6",
          "voicetagPointer": "/Data/RootChunk/actors/6/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/15",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/5/Data/events/41/Data"
        }
      },
      {
        "name": "Carol",
        "voice": "1690764978148888576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04a_camping.scene.json",
          "assetSha256": "3fc9218f1edb9886bcf5e7b469a562232ceb6ae355fbc6533f821d86e652f035",
          "jsonSha256": "6ba75204197502597fd1946039c5ef76e528e4e469cc1dd97a0628db390b5440",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/20",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/38/Data"
        }
      }
    ]
  },
  "cassidy-righter": {
    "kind": "journal-contact",
    "id": "cassidy",
    "titles": [
      "Cassidy Righter"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/130/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/130/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/6916/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/6916/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Cassidy",
        "voice": "1690767249364504576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04b_party.scene.json",
          "assetSha256": "bcd013c5059b16a5df05f324e9b9ca1cc503f7ef089810f688f627653694b027",
          "jsonSha256": "aa4cecaef8b7c4c18f463cc8c618bb1ab93aa9134ffa63b13b3c84ad727cba13",
          "actorPointer": "/Data/RootChunk/actors/5",
          "voicetagPointer": "/Data/RootChunk/actors/5/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/229",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/336/Data/events/2/Data"
        }
      },
      {
        "name": "Cassidy",
        "voice": "1690767249364504576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/wave3-bob-cassidy-dakota/raw/base/base/quest/side_quests/sq027/scenes/sq027_04_preparations_cassidy_teddy.scene.json",
          "assetSha256": "d7378d0d7cc042ce439692cafb476b07d93433b25bb857123d461449d406a954",
          "jsonSha256": "cc1a2faaadfc9919565ba0f07a9494336bd86d49fc7b9267ad1912d3ae4e8ca5",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/9",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/6/Data/events/6/Data"
        }
      },
      {
        "name": "Cassidy",
        "voice": "1690767249364504576",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json",
          "assetSha256": "2e9029faf8b8c8efe612d97bc5ffe7b900a79235e3237c0b9b087bad4ceae68d",
          "jsonSha256": "279868d46b5a948be3a7cc0c9e49ca3d93a940ffef5fa52fad9363ba14d95544",
          "actorPointer": "/Data/RootChunk/actors/5",
          "voicetagPointer": "/Data/RootChunk/actors/5/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/55/Data"
        }
      }
    ]
  },
  "chang-hoon-nam": {
    "kind": "codex",
    "id": "chang_hoon_nam",
    "titles": [
      "Chang-Hoon Nam"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/50/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/50/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/56204/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/56204/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "ae88da966e4a468d7705f07326f6cc781fd072e423ee6cc6a8ff59cfd29fce4b"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "e9441435f8840d05d07d0fa61907bf927cb1f7fc5c0a231395848bada3014672"
        }
      }
    ],
    "actors": [
      {
        "name": "Chang_Hoon_Nam",
        "voice": "1895221312667856896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/scenes/sts_wbr_jpn_05_ren_cheng.scene.json",
          "assetSha256": "62c1735c551152615aa1e0ec441149d57e143ed0670f90e7c88e3a79e84d5e77",
          "jsonSha256": "5ac916eb594de48ab9d80cf97652da1cb417091bd1e203ab34231afc8e2017b0",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/15",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/17/Data"
        }
      }
    ]
  },
  "claire-russell": {
    "kind": "codex",
    "id": "claire_russell",
    "titles": [
      "Claire Russell"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/44/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/44/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15089/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15089/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "claire",
        "voice": "1619997299022241792",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-iris-jim-claire/raw/base/base/quest/side_quests/sq024/scenes/sq024_02b_santo_domingo_race_end.scene.json",
          "assetSha256": "0945a3264658654e17edeff16a119aec32eeda2f225ec4c95e820d723fce82a0",
          "jsonSha256": "c79ea3ade206a327c70ebffca1de772220d407d0ac5d7f8a843e94f552443f7c",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/66",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/45/Data/events/3/Data"
        }
      },
      {
        "name": "claire",
        "voice": "1619997299022241792",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-iris-jim-claire/raw/base/base/quest/side_quests/sq024/scenes/sq024_04b_docks_scene.scene.json",
          "assetSha256": "7842282f825dc0449783de6111bd9e5ca03bc65dfd17c1bdcdca8855c219cc7f",
          "jsonSha256": "0736ed9371053c426f79933c7b48a644df536ef2c51cdf88e62481408550a651",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/38",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/21/Data/events/4/Data"
        }
      }
    ]
  },
  "dakota-smith": {
    "kind": "codex",
    "id": "dakota",
    "titles": [
      "Dakota Smith"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/4/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/4/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14934/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14934/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "dakota_smith",
        "voice": "1317005973663428608",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/wave3-bob-cassidy-dakota/raw/base/base/open_world/fixers/dakota/scenes/dakota_smith_defaut.scene.json",
          "assetSha256": "16fdf315da2970d70396110ec9d142625606b8afaf3c82a40eeac488b08d1375",
          "jsonSha256": "6cc2ef097ea874ffc587d99c44d1e8ed9059842b69abb815df8672aa84a9c2d2",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/4",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/3/Data"
        }
      },
      {
        "name": "Dakota",
        "voice": "1317005973663428608",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_03c_dakota_trailer.scene.json",
          "assetSha256": "4532663463e50c4020fe4d6e716ad530577765314acc2a598312d920a5c4bcf6",
          "jsonSha256": "0349797fece30d3a37efc35f704ee7d307de5779837aefc9c1ad2b3d4795746e",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/7",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/3/Data"
        }
      },
      {
        "name": "Dakota",
        "voice": "1317005973663428608",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04b_party.scene.json",
          "assetSha256": "bcd013c5059b16a5df05f324e9b9ca1cc503f7ef089810f688f627653694b027",
          "jsonSha256": "aa4cecaef8b7c4c18f463cc8c618bb1ab93aa9134ffa63b13b3c84ad727cba13",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/56",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/43/Data/events/4/Data"
        }
      }
    ]
  },
  "dexter-deshawn": {
    "kind": "codex",
    "id": "dexter_deshawn",
    "titles": [
      "Dexter DeShawn"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/10/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/10/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15093/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15093/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "dex",
        "voice": "1103967280742240416",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-prologue-oct01/raw/base/base/quest/main_quests/prologue/q001/scenes/q001_03a_jackie_dex_intro.scene.json",
          "assetSha256": "953b074432cfefcbb41eb9542dc25652943fb2fdd3641b61122d0e459b778383",
          "jsonSha256": "40f57aa15b1e416043b64b6aa972071c3ccc973c3e9496e5a4f0db5ac4405fc0",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/36",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/13/Data/events/9/Data"
        }
      },
      {
        "name": "Dex",
        "voice": "1103967280742240416",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/native-initial-20261001/raw/base/base/quest/main_quests/prologue/q005/scenes/q005_01_plan.scene.json",
          "assetSha256": "a7594ccc43cf7e26a703e11f5d8a81c897ef9f46233af210be627a4427612280",
          "jsonSha256": "eb646523b239aa305e9f01c4dd59e72596ef46c7e279c347301353f508a5961d",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/138",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/92/Data/events/5/Data"
        }
      },
      {
        "name": "Dex",
        "voice": "1103967280742240416",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/wave3-dex-meredith-yorinobu/raw/base/base/quest/secondary_characters/default_dialogues/dex_default.scene.json",
          "assetSha256": "45e3d72c7c5f102fb8d34f480790761476f25569403f22bc41175f2d2dcaf4c5",
          "jsonSha256": "142770b0385cdce5604817ae16eca254839b77643d90d38b3bcbb8aa6207a615",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/1",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/3/Data"
        }
      }
    ]
  },
  "dino-dinovic": {
    "kind": "codex",
    "id": "dino_dinovic",
    "titles": [
      "Dino Dinovic"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/1/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/1/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14941/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14941/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "dyno",
        "voice": "1609920229118869504",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/wave3-padre-wakako-dino/raw/base/base/open_world/fixers/dyno/scenes/dyno_default.scene.json",
          "assetSha256": "458f6b8e395a6ac1f29a4eb54281393a15ac9aca96f5ae41302ddae529eacb7b",
          "jsonSha256": "f6fffaa61775a256a3488bdc768fe93043fc3288222b0f67a8d1432bba8baf57",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/2/Data"
        }
      }
    ]
  },
  "elizabeth-peralez": {
    "kind": "codex",
    "id": "elizabeth_peralez",
    "titles": [
      "Elizabeth Peralez"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/38/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/38/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15094/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15094/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "elizabeth",
        "voice": "1354717605155950592",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-peralez-joss-oct01/raw/base/base/quest/side_quests/sq006/scenes/sq006_01a_apartment_welcome.scene.json",
          "assetSha256": "d5345b83c2d05ebb3ee65f7dc49f97f965c0465202ba82a2d213294ca8656af0",
          "jsonSha256": "4ffd93a9e2b052da267f79418f38a251d22fdb790fa204df9a9fda5369f36cce",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/5",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/5/Data/events/0/Data"
        }
      },
      {
        "name": "elizabeth",
        "voice": "1354717605155950592",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-peralez-joss-oct01/raw/base/base/quest/side_quests/sq012/scenes/sq012_01a_peralez_car.scene.json",
          "assetSha256": "6e12ea574d17e31fed1a4f9fff177c3f8349efce2895341489f885e768e21ade",
          "jsonSha256": "8eae3a8a43926e8360b8207be8027854c362fe7bdc21e13eef4fc780832a8cb1",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/34",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/26/Data/events/3/Data"
        }
      }
    ]
  },
  "frank-nostra": {
    "kind": "journal-contact",
    "id": "frank",
    "titles": [
      "Frank Nostra"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/91/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/91/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7078/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7078/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "corpo_friend",
        "voice": "1624173162010261164",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/history-wave3-runners/raw/base/base/quest/main_quests/prologue/q000/scenes/q000_corpo_02_to_elevators.scene.json",
          "assetSha256": "adad2c0437680fc474d1e648844f569a210d0866597fb82b82085a1e28a7e8d7",
          "jsonSha256": "512e96cf32703176498072dc001cb16488a739d922b8580e87965b6b88cdc1bf",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/0",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/1/Data"
        }
      }
    ]
  },
  "iris-tanner": {
    "kind": "codex",
    "id": "iris_tanner",
    "titles": [
      "Iris Tanner"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/1/Data/entries/5/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/1/Data/entries/5/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14974/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14974/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "tanner",
        "voice": "1924111535157194752",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/scenes/sts_bls_ina_06_meeting_dakota.scene.json",
          "assetSha256": "10d68773e582132d707ac4ca3f58f0b9349eeb6e6b943e35a598f5c767e8f8a9",
          "jsonSha256": "d2b2800b060e8a17418f4e62cf368603d9f296962d487f95cffb810ce82ea805",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/1/Data/events/6/Data"
        }
      }
    ]
  },
  "jefferson-peralez": {
    "kind": "codex",
    "id": "jefferson_peralez",
    "titles": [
      "Jefferson Peralez"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/37/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/37/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15106/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15106/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "jefferson",
        "voice": "1354718838415544320",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-peralez-joss-oct01/raw/base/base/quest/side_quests/sq012/scenes/sq012_01a_peralez_car.scene.json",
          "assetSha256": "6e12ea574d17e31fed1a4f9fff177c3f8349efce2895341489f885e768e21ade",
          "jsonSha256": "8eae3a8a43926e8360b8207be8027854c362fe7bdc21e13eef4fc780832a8cb1",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/11",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/12/Data/events/11/Data"
        }
      },
      {
        "name": "jefferson",
        "voice": "1354718838415544320",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-peralez-joss-oct01/raw/base/base/quest/side_quests/sq006/scenes/sq006_01a_apartment_welcome.scene.json",
          "assetSha256": "d5345b83c2d05ebb3ee65f7dc49f97f965c0465202ba82a2d213294ca8656af0",
          "jsonSha256": "4ffd93a9e2b052da267f79418f38a251d22fdb790fa204df9a9fda5369f36cce",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/1/Data"
        }
      }
    ]
  },
  "jesse": {
    "kind": "journal-contact",
    "id": "stud",
    "titles": [
      "Flaming Crotch Man"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/2/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/2/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7197/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7197/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "stud",
        "voice": "1922727464330600448",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq012/scenes/mq012_00_stud.scene.json",
          "assetSha256": "b357e2e0b05566200d338748ec1e943ac81bac937de4f968e6150dbd1c6c1e04",
          "jsonSha256": "155ba6f93b6bdba53b1192486cef9c8eba92ee780afe5d0b6b3946d5a797ed5d",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/1/Data"
        }
      }
    ]
  },
  "jim-jarry": {
    "kind": "journal-contact",
    "id": "announcer_mq056",
    "titles": [
      "Jim Jarry"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/124/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/124/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/37137/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/37137/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "jim_jarry",
        "voice": "1796388644539244544",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/jim-media-oct01/raw/base/base/media/fluff/scenes/guns_n_horses/guns_n_horses_01.scene.json",
          "assetSha256": "d07006b093c60220c989d5d8cb4478ec596938d9ca874649cde47a85be354f67",
          "jsonSha256": "7d7851511f79d2e68f777c1bd235f19b4e1fe09b5ed5a3a0841481c95807762a",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/1",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/1/Data"
        }
      },
      {
        "name": "jim_jarry",
        "voice": "1796388644539244544",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/jim-media-oct01/raw/base/base/media/fluff/scenes/guns_n_horses/guns_n_horses_03.scene.json",
          "assetSha256": "813e137e9383eda40153884eb8599dbdcda8df58698b4f2830957a9c729a8f38",
          "jsonSha256": "90942986481d3e55b52336fb6957bb44e3ff34550843c4e04e9043c7d41accb9",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/3/Data"
        }
      },
      {
        "name": "jim_jarry",
        "voice": "1796388644539244544",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/jim-media-oct01/raw/base/base/media/fluff/scenes/guns_n_horses/guns_n_horses_04.scene.json",
          "assetSha256": "a1772f7e174fcac17aadfe8e6deeec9c55086f91559ff696598f1b0f3b8a2de9",
          "jsonSha256": "1b10b16fdb54db03c2b48f5f3eff02b15e363071ee439ab28257268a1624cab9",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/0",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/0/Data"
        }
      },
      {
        "name": "jim_jarry",
        "voice": "1796388644539244544",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/jim-media-oct01/raw/base/base/media/fluff/scenes/guns_n_horses/guns_n_horses_05.scene.json",
          "assetSha256": "a82149a8a830864dabc9beb0d5c4ab9805bb3baa9371c99dca1e45b597616218",
          "jsonSha256": "d4810f8b3110ba4a111b9f8ab2fbe61296d2919407304b01a2d6fac38b4927ed",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/10",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/10/Data"
        }
      },
      {
        "name": "jim_jarry",
        "voice": "1796388644539244544",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/jim-media-oct01/raw/base/base/media/fluff/scenes/guns_n_horses/guns_n_horses_02.scene.json",
          "assetSha256": "4ef69e88ae14b8a43a946cfaf04237c8ffc127f672eb45ca1c0c7d5bc9799c0b",
          "jsonSha256": "ebdd2233962992ee9a1a6d0cd32cfbd592589a40fdf9eee0f98af0cb287e8eed",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/6/Data"
        }
      }
    ]
  },
  "joss-kutcher": {
    "kind": "journal-contact",
    "id": "joss",
    "titles": [
      "Joss Kutcher"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/76/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/76/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7149/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7149/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Joss",
        "voice": "1461762769070243840",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/wave3-joss-dinner-oct01/raw/base/base/quest/side_quests/sq029/scenes/sq029_04a_dinner.scene.json",
          "assetSha256": "508b2e56398f74397197ab579f08190649dd5d8349c39585612cb41f7242cdc6",
          "jsonSha256": "508017e19032dca57af45cb54790fec89b0b38e709fb54e683988bd2b908121a",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/17",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/13/Data/events/3/Data"
        }
      },
      {
        "name": "joss",
        "voice": "1461762769070243840",
        "qualification": {
          "jsonPath": "runtime/voice-cast/river-peralez/scenes/intrinsic-river-oct01/raw/base/base/quest/side_quests/sq029/scenes/sq029_02a_arrival.scene.json",
          "assetSha256": "8e73bc68a37588c055866d9149c9473ae7a3476fd108aad4cab5195b5d4da7bc",
          "jsonSha256": "50ede6d3e5dc9075b91620c7f06a331cc89901d7e750276cc3486032ebbb392b",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/20",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/20/Data/events/5/Data"
        }
      }
    ]
  },
  "lina-malina": {
    "kind": "codex",
    "id": "lina_malina",
    "titles": [
      "Lina Malina"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/16/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/16/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4574/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4574/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [
      {
        "name": "Lina",
        "voice": "3342203672536473600",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/scenes/ordinary-dialogue-20261001/raw/ep1/ep1/quest/minor_quests/mq303/scenes/mq303_02_linas_mansion.scene.json",
          "assetSha256": "1b26c26c9a07185dcee971c44c14b3d251a1f6967811695aa9290a2f5a761eab",
          "jsonSha256": "26aa399dd799e84d1b5974d0c6c88aedd965e2c5a94c332391f226a951a5c3b1",
          "actorPointer": "/Data/RootChunk/actors/3",
          "voicetagPointer": "/Data/RootChunk/actors/3/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/20",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/21/Data/events/17/Data"
        }
      }
    ]
  },
  "lizzy-wizzy": {
    "kind": "codex",
    "id": "lizzy_wizzy",
    "titles": [
      "Lizzy Wizzy"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/47/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/47/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/55323/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/55323/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "ae88da966e4a468d7705f07326f6cc781fd072e423ee6cc6a8ff59cfd29fce4b"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "e9441435f8840d05d07d0fa61907bf927cb1f7fc5c0a231395848bada3014672"
        }
      }
    ],
    "actors": [
      {
        "name": "Lizzy_Wizzy",
        "voice": "1792218388178575360",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/ordinary-dialogue/raw/base/base/quest/minor_quests/mq019/scenes/mq019_01_notell_motel.scene.json",
          "assetSha256": "e8baed4c0d2e1b0f2ec0c844b15932797fc948db2f7070a58f76a5c0ac883b92",
          "jsonSha256": "7063660e2282d0566c6889c52721b772a732483a3df5c2122064e461112702b6",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/4",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/7/Data"
        }
      }
    ]
  },
  "mark-bana": {
    "kind": "journal-contact",
    "id": "mark_bana",
    "titles": [
      "Mark Bana"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/16/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/16/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/1397/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/1397/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [],
    "witnesses": [
      {
        "name": "Ana",
        "voice": "3262211889930989568",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/openworld/street_stories/sts_ep1_08/scenes/sts_ep1_08_client_meeting.scene.json",
          "assetSha256": "8b740ef961ec0cc03b2852d1a995506b5a4db03d8312b9fd1c907e0ec42711f1",
          "jsonSha256": "d6e3aa465699b2f54f85ee24f6c7b4c065825549dbcffd0743c2e6f9edb288f1",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/49",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/65/Data/events/0/Data"
        }
      },
      {
        "name": "Steven",
        "voice": "3262212739462098944",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/openworld/street_stories/sts_ep1_08/scenes/sts_ep1_08_client_meeting.scene.json",
          "assetSha256": "8b740ef961ec0cc03b2852d1a995506b5a4db03d8312b9fd1c907e0ec42711f1",
          "jsonSha256": "d6e3aa465699b2f54f85ee24f6c7b4c065825549dbcffd0743c2e6f9edb288f1",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/0",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/4/Data"
        }
      }
    ]
  },
  "meredith-stout": {
    "kind": "journal-contact",
    "id": "stout",
    "titles": [
      "Meredith Stout"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/20/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/20/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7196/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7196/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Meredith",
        "voice": "1667926559363391488",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-oct01/raw/base/base/quest/main_quests/prologue/q003/scenes/q003_01a_militech.scene.json",
          "assetSha256": "273bc29a9cc23f202771fb4fe2f23234f7b7c81923ead6ef83df274438ef6393",
          "jsonSha256": "eb507e5e21a02e1366222bef66ea378b123741b134f2c7fd0b1176066cc253a4",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/34",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/25/Data/events/0/Data"
        }
      }
    ],
    "witnesses": [
      {
        "name": "dex",
        "voice": "1103967280742240416",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-prologue-oct01/raw/base/base/quest/main_quests/prologue/q001/scenes/q001_03a_jackie_dex_intro.scene.json",
          "assetSha256": "953b074432cfefcbb41eb9542dc25652943fb2fdd3641b61122d0e459b778383",
          "jsonSha256": "40f57aa15b1e416043b64b6aa972071c3ccc973c3e9496e5a4f0db5ac4405fc0",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/27",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/23/Data"
        }
      }
    ]
  },
  "mitch-anderson": {
    "kind": "codex",
    "id": "mitch",
    "titles": [
      "Mitch Anderson"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/32/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/32/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15120/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15120/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Mitch",
        "voice": "1437131307769548800",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04a_camping.scene.json",
          "assetSha256": "3fc9218f1edb9886bcf5e7b469a562232ceb6ae355fbc6533f821d86e652f035",
          "jsonSha256": "6ba75204197502597fd1946039c5ef76e528e4e469cc1dd97a0628db390b5440",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/18",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/7/Data/events/4/Data"
        }
      },
      {
        "name": "Mitch",
        "voice": "1437131307769548800",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_04_preparations_mitch_bob.scene.json",
          "assetSha256": "42e08d236be72082005f9f0abca632f0ce97975c0b2158a089c9ddd5d93b2318",
          "jsonSha256": "d48d9427560ab1f5857a1044d2ed61cc6f376b1319fba94dcc0eb39609fdc3f4",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/1/Data/events/13/Data"
        }
      },
      {
        "name": "Mitch",
        "voice": "1437131307769548800",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json",
          "assetSha256": "5cca608d7a3162d361705447d24bce7b1de3257968241a0889505771abd8686f",
          "jsonSha256": "22752767a6744fe39e5df8d06fdca0e2d29672026eb715c973d58b140f270d48",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/79",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/47/Data/events/5/Data"
        }
      }
    ]
  },
  "nancy-hartley": {
    "kind": "journal-contact",
    "id": "nancy",
    "titles": [
      "Nancy Hartley"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/59/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/59/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7163/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7163/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/raw/base/base/quest/side_quests/sq011/scenes/sq011_07a_royce.scene.json",
          "assetSha256": "5acb80fc5fadf66d248bc809e710cf64cff95a04cbde5105e04b15e9bc63bb44",
          "jsonSha256": "1d63876190c9adbc246cbff18c69e99c5a000d7b29bd667f0e6254076c803c7f",
          "actorPointer": "/Data/RootChunk/actors/3",
          "voicetagPointer": "/Data/RootChunk/actors/3/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/123",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/152/Data/events/6/Data"
        }
      },
      {
        "name": "Bes_Isis",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/raw/base/base/quest/minor_quests/mq018/scenes/mq018_01_call.scene.json",
          "assetSha256": "a2bddd8300283489b2d0e7788d19ea7a75c835083bd554d3a2df1301d4d07ce3",
          "jsonSha256": "0dbd2b37ae158379a259ad8d13946168fa119aeecd80e00eb6bf34d0878c922d",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/6/Data/events/0/Data"
        }
      },
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/side_quests/sq011/scenes/sq011_08_nancy_saved.scene.json",
          "assetSha256": "05d3898873c59246edfd28b0a50e8d71f09d9575aa2e6992a5adc24842ce81c0",
          "jsonSha256": "a1e86366b97ab6495916445a7e1f84b8ef4ac164f42be866e2849c42fd041cef",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/55",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/2/Data"
        }
      },
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/raw/base/base/quest/minor_quests/mq018/scenes/mq018_01_call.scene.json",
          "assetSha256": "a2bddd8300283489b2d0e7788d19ea7a75c835083bd554d3a2df1301d4d07ce3",
          "jsonSha256": "0dbd2b37ae158379a259ad8d13946168fa119aeecd80e00eb6bf34d0878c922d",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/10",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/11/Data/events/3/Data"
        }
      },
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/side_quests/sq011/scenes/sq011_10_concert.scene.json",
          "assetSha256": "cbdae241c5cc5bff475fa8c709c91b8f5bbe4a45022608c52842a76aa7e3be94",
          "jsonSha256": "91f037066d6e97a95333bf4a1eca99dde29a0d0655da00f969ab79c8541899c7",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/146",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/130/Data/events/8/Data"
        }
      }
    ],
    "witnesses": [
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/side_quests/sq011/scenes/sq011_08_nancy_saved.scene.json",
          "assetSha256": "05d3898873c59246edfd28b0a50e8d71f09d9575aa2e6992a5adc24842ce81c0",
          "jsonSha256": "a1e86366b97ab6495916445a7e1f84b8ef4ac164f42be866e2849c42fd041cef",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/55",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/2/Data"
        }
      },
      {
        "name": "Nancy",
        "voice": "1381176181915344896",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/raw/base/base/quest/side_quests/sq011/scenes/sq011_07a_royce.scene.json",
          "assetSha256": "5acb80fc5fadf66d248bc809e710cf64cff95a04cbde5105e04b15e9bc63bb44",
          "jsonSha256": "1d63876190c9adbc246cbff18c69e99c5a000d7b29bd667f0e6254076c803c7f",
          "actorPointer": "/Data/RootChunk/actors/3",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/123",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/152/Data/events/6/Data"
        }
      },
      {
        "name": "Johnny",
        "voice": "1103967280742240508",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/raw/base/base/quest/side_quests/sq011/scenes/sq011_02_totentanz.scene.json",
          "assetSha256": "daf148d3d92617df6a300afb9dad25f24194a136a2b3c9759642b2b18b760174",
          "jsonSha256": "f89f71246c82644836cf03de46fd1232e3c763250f8f0b462f73a4d39957152b",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/9/Data/events/4/Data"
        }
      }
    ]
  },
  "nele-springer": {
    "kind": "codex",
    "id": "nele_spranger",
    "titles": [
      "Nele Springer"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/9/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/9/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4537/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4537/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [
      {
        "name": "Nele",
        "voice": "3262211134922715136",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/scenes/ordinary-dialogue-20261001/raw/ep1/ep1/openworld/street_stories/sts_ep1_07/scenes/sts_ep1_07_client_meeting.scene.json",
          "assetSha256": "a79b7af260fbeb38c9d3df8e5213573ad941c36593fabc988f0a423776876caa",
          "jsonSha256": "443f63be604132a6a7e325564f3c59faa41c0057ccfb09d2635f6ad77d965952",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/7",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/1/Data"
        }
      }
    ]
  },
  "nix": {
    "kind": "codex",
    "id": "nix",
    "titles": [
      "Nix"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/49/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/49/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/56205/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/56205/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "nix",
        "voice": "1791017447710433280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/minor_quests/mq015/scenes/mq015_05_afterlife.scene.json",
          "assetSha256": "2e9ce56c5500f80fbb31da423658769bad648af8ca642df7ef4ad26293208314",
          "jsonSha256": "2e665e45f83152ded8d65907bf01bcd7db4cc9334885636fd016dff23529e008",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/22",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/13/Data/events/6/Data"
        }
      },
      {
        "name": "nix",
        "voice": "1791017447710433280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/raw/base/base/quest/minor_quests/mq016/scenes/mq016_02_afterlife.scene.json",
          "assetSha256": "c716dba8fc01aec83978b81528910ec899bc81fca048ce3bb2a39a5cec17609e",
          "jsonSha256": "b11f331680903d87a8cf838f57a306ac91588ab5cb407bbe3723d3011fb71f9d",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/4/Data"
        }
      }
    ]
  },
  "ozob-bozo": {
    "kind": "journal-contact",
    "id": "ozob",
    "titles": [
      "Ozob Bozo"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/53/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/53/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7166/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7166/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Ozob",
        "voice": "1805485973630234624",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/wave3-mercs-promoter/raw/base/base/quest/minor_quests/mq035/scenes/mq035_ozob_dialogues.scene.json",
          "assetSha256": "edb70ad1ccd1f3691d9f9c5220b0e766d0ff84ee6629d09a5b1cd50da79b8309",
          "jsonSha256": "52c7ac7d71dbae186fc738c01e8dc4883986f6a3721fb8417afb7d5add7319af",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/9",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/2/Data"
        }
      },
      {
        "name": "Ozob",
        "voice": "1805485973630234624",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/heywood-authenticated-oct01/raw/base/base/quest/minor_quests/mq025/scenes/mq025_06_pacifica.scene.json",
          "assetSha256": "8d4c8f0cff236842cc1e20cb97a532e655dcbd3c39573ce631d35be300035788",
          "jsonSha256": "bc5cb6f3bf86e180db66fc097018faaef1551c306177ce80cef4a3d272495f87",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/28",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/31/Data/events/7/Data"
        }
      }
    ]
  },
  "paco-torres": {
    "kind": "codex",
    "id": "paco",
    "titles": [
      "Paco Torres"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/21/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/21/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/8303/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/8303/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "5bc281ddd6bc506b8bf55fe8b30648b253af972c20276bae14889da3c4a2ecfa"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-main/intrinsic-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "259adaeb3109a315e0faa8dbac0c6cbe93442d73f36baa5202e93cffe16c78dd"
        }
      }
    ],
    "actors": [
      {
        "name": "Paco",
        "voice": "2958152608508186624",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/scenes/ordinary-dialogues/raw/ep1/ep1/quest/minor_quests/mq301/scenes/mq301_01_fireplace.scene.json",
          "assetSha256": "76b1f27586c661e125e6e8a8f611ac9bc131cca2762d2e36ccec7920d75efec3",
          "jsonSha256": "cf46afb60a6213cd920d6431dd85b967190f0825951a01f8cbe288440b63eaef",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/14/Data/events/2/Data"
        }
      }
    ]
  },
  "padre-ibarra": {
    "kind": "codex",
    "id": "padre",
    "titles": [
      "Padre"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/5/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/5/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14947/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14947/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Padre",
        "voice": "1609919701408317440",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/wave3-padre-wakako-dino/raw/base/base/open_world/fixers/padre/scenes/padre_default.scene.json",
          "assetSha256": "f14800f90c08c2ea0f35102a99dd6e6360e6736645da5fa7783f6296f186de58",
          "jsonSha256": "f76f9c9a9e0e9d08c41010a77fda28548b791451efafe26739f4ed82307adadb",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/3/Data/events/8/Data"
        }
      }
    ]
  },
  "placide": {
    "kind": "codex",
    "id": "placide",
    "titles": [
      "Placide"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/35/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/35/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15129/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15129/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "placide",
        "voice": "1105384460095864832",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/initial-three/raw/base/base/quest/main_quests/part1/q110/scenes/q110_02_placide.scene.json",
          "assetSha256": "1c5318c3a185d3b6d6ac39d522a07eaa1a12bc0484122dfdcb2e66f198db9979",
          "jsonSha256": "e37501b18c62a59e7a1e427bfb542f4271cb605075edec4ec5692afda184904f",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/63",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/123/Data/events/2/Data"
        }
      },
      {
        "name": "placide",
        "voice": "1105384460095864832",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/initial-three/raw/base/base/quest/main_quests/part1/q110/scenes/q110_04_netrunners_den.scene.json",
          "assetSha256": "bcfcfb2c56d22945b0638d62d28e49a7dbb5b9df5cf7d20b01d896a0dcd04dae",
          "jsonSha256": "69b6dd4b0404da2e31b45c365bc184a5a4ac2fabb2bc326ac376f08833086205",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/6/Data/events/6/Data"
        }
      }
    ]
  },
  "rachel-casich": {
    "kind": "journal-contact",
    "id": "rachel",
    "titles": [
      "Rachel Casich"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/52/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/52/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7174/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7174/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "ae88da966e4a468d7705f07326f6cc781fd072e423ee6cc6a8ff59cfd29fce4b"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/minor-named/knowledge-wave3-nam-residents/raw/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "e9441435f8840d05d07d0fa61907bf927cb1f7fc5c0a231395848bada3014672"
        }
      }
    ],
    "actors": [
      {
        "name": "Rachel",
        "voice": "1631420577167360000",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/ordinary-dialogue/raw/base/base/quest/side_quests/sq023/scenes/sq023_07_restaurant.scene.json",
          "assetSha256": "e660d69d97fc854f93b7326f4b656d6a28f5dd0874f4b63407806f610e5dbd50",
          "jsonSha256": "e916975737d3e783a765f33f2369fdd069762c57ba240148345f299cbe51944d",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/111",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/61/Data/events/7/Data"
        }
      },
      {
        "name": "rachel_casich",
        "voice": "1631420577167360000",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/wave3-performers-intrinsic-oct01/raw/base/base/media/quests/scenes/sq023_01_rachel_talk_show.scene.json",
          "assetSha256": "f16253956ed5521c1195eefb0e7bce981176f54a8b43321442fdd2adb7210baf",
          "jsonSha256": "ac0e86f6d59f6fc7df391247aa7a90023b3c9c4f9c8552738e592ca33b5a1b68",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/11",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/11/Data"
        }
      }
    ],
    "witnesses": [
      {
        "name": "ziggy_q",
        "voice": "1669161994995802112",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-named/scenes/wave3-performers-intrinsic-oct01/raw/base/base/media/quests/scenes/sq023_01_rachel_talk_show.scene.json",
          "assetSha256": "f16253956ed5521c1195eefb0e7bce981176f54a8b43321442fdd2adb7210baf",
          "jsonSha256": "ac0e86f6d59f6fc7df391247aa7a90023b3c9c4f9c8552738e592ca33b5a1b68",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/0",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/2/Data/events/0/Data"
        }
      }
    ]
  },
  "robert-wilson": {
    "kind": "journal-contact",
    "id": "wilson",
    "titles": [
      "Robert Wilson"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/13/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/13/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/22512/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/22512/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "wilson",
        "voice": "1641612469127499776",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/default-in-person/raw/base/base/quest/minor_quests/mq011/scenes/mq011_00_gun_range.scene.json",
          "assetSha256": "d40f1e9f65c970a91cbf38c2a3ace5a9f48e8354decd24ee881b3446c3bbbd89",
          "jsonSha256": "4c8ba00389e2a4b0b647245602cf7f00f23c41bfa99d0115c5735e9e1adec0d0",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/56",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/99/Data/events/6/Data"
        }
      }
    ]
  },
  "sandra-dorsett": {
    "kind": "codex",
    "id": "sandra_dorsett",
    "titles": [
      "Sandra Dorsett"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/48/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/48/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/56200/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/56200/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "sandra",
        "voice": "1630225746710003712",
        "qualification": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/quest/minor_quests/mq024/scenes/mq024_02_meet_sandra.scene.json",
          "assetSha256": "949fab003c6e830c88634b060cdb6968657d8c454e6206af27e38cfc813929d5",
          "jsonSha256": "4d5f4eaed290dcfb5a040af66da24d63c7e5d473205e425b6d9847c58498774f",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/49",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/33/Data/events/1/Data"
        }
      }
    ]
  },
  "santiago": {
    "kind": "journal-contact",
    "id": "santiago",
    "titles": [
      "Santiago"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/34/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/34/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7187/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7187/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [],
    "witnesses": [
      {
        "name": "Santiago",
        "voice": "1197872723565494272",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/flashback-actors/raw/base/base/quest/main_quests/part1/q108/scenes/q108_14_rogue.scene.json",
          "assetSha256": "3796d71423272deced7bdcab2952ba3fa6280f9b511f367bc7427ce2a27e5a2a",
          "jsonSha256": "d8fa120472e33bc9505256a465e5de686f769b4ce8814448984597e261921858",
          "actorPointer": "/Data/RootChunk/actors/1",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/5",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/5/Data/events/0/Data"
        }
      }
    ]
  },
  "saul-bright": {
    "kind": "codex",
    "id": "saul_bright",
    "titles": [
      "Saul Bright"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/23/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/23/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15139/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15139/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "Saul",
        "voice": "1537319941382881280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_03_saul_whistleblowing.scene.json",
          "assetSha256": "7c02ac7cd644aeab9ca19a80a3e533288fd454c2af8699c86f8224acfb401120",
          "jsonSha256": "76bb37370c7c1876b6e61f73ae993e4b7aa76ec0c080e9af9f2b312e33c023a7",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/2",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/1/Data"
        }
      },
      {
        "name": "Saul",
        "voice": "1537319941382881280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04b_party.scene.json",
          "assetSha256": "bcd013c5059b16a5df05f324e9b9ca1cc503f7ef089810f688f627653694b027",
          "jsonSha256": "aa4cecaef8b7c4c18f463cc8c618bb1ab93aa9134ffa63b13b3c84ad727cba13",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/93",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/66/Data/events/8/Data"
        }
      },
      {
        "name": "Saul",
        "voice": "1537319941382881280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json",
          "assetSha256": "f0e16b6381105b24cdd6104d201ca63f46ea410b5a7e5bd1f1a001dc7f4ff9ea",
          "jsonSha256": "497ac42c7cc592a65158255174b070715e332c32f7b1959209091b62ae150a6d",
          "actorPointer": "/Data/RootChunk/actors/3",
          "voicetagPointer": "/Data/RootChunk/actors/3/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/60",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/30/Data/events/8/Data"
        }
      },
      {
        "name": "Saul",
        "voice": "1537319941382881280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json",
          "assetSha256": "5cca608d7a3162d361705447d24bce7b1de3257968241a0889505771abd8686f",
          "jsonSha256": "22752767a6744fe39e5df8d06fdca0e2d29672026eb715c973d58b140f270d48",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/69",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/40/Data/events/7/Data"
        }
      },
      {
        "name": "Saul",
        "voice": "1537319941382881280",
        "qualification": {
          "jsonPath": "runtime/voice-cast/aldecaldos/scenes/dialogue-oct01/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json",
          "assetSha256": "6c5d4682e491207dd70d1aea022b31df8206388decb3534b6cafa95b2300c967",
          "jsonSha256": "4a5a5b41c9ce46826d042be69c8807fbfd042bef66cc1a658ff23b035d0d82a0",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/7",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/28/Data"
        }
      }
    ]
  },
  "sergei-karasinsky": {
    "kind": "journal-contact",
    "id": "sergiej",
    "titles": [
      "Sergei Karasinsky"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/18/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/18/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/16397/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/16397/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "sergei",
        "voice": "1814095808301662208",
        "qualification": {
          "jsonPath": "runtime/voice-cast/minor-generic/scenes/native-bindings-oct01/raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_01/scenes/sts_wbr_jpn_01_meeting_sergei.scene.json",
          "assetSha256": "963e9db898bb31fc6b0f680cac6f117e8e9a788fcf6928ae9bf73a442d824c62",
          "jsonSha256": "41305151e5df5da5d10c399ccf30f9476c7bd0443127c55a37b8c15f95a72b2c",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/24",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/13/Data/events/5/Data"
        }
      }
    ]
  },
  "shank": {
    "kind": "journal-contact",
    "id": "shank",
    "titles": [
      "Shank"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/15/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/15/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/1931/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/1931/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [
      {
        "name": "Shank",
        "voice": "3342233105796358144",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/scenes/ordinary-dialogue-20261001/raw/ep1/ep1/quest/minor_quests/mq303/scenes/mq303_01_hook.scene.json",
          "assetSha256": "38889a7942ac7f80b2b16b44d369b8c53d501c48361586b59b97c336b625eddb",
          "jsonSha256": "1a011652762b1758b4fa9071f482fa199ee8cf572aed7784f999632585278502",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/12",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/10/Data/events/11/Data"
        }
      }
    ]
  },
  "spider-murphy": {
    "kind": "journal-contact",
    "id": "spider_murphy",
    "titles": [
      "Spider Murphy"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/11/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/11/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/16275/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/16275/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [],
    "witnesses": [
      {
        "name": "netrunner_phone",
        "voice": "1624173162010259956",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/flashback-actors/raw/base/base/quest/main_quests/part1/q101/scenes/q101_06c_memories_p2.scene.json",
          "assetSha256": "ba27ef78c443d8a1928db510b8d606d2e9d05b862af09117e50301e74cda2b27",
          "jsonSha256": "cff00723ec09e314bb434ab29040ea3ca03dc2d61db8c294414d3a822a1c751e",
          "actorPointer": "/Data/RootChunk/actors/7",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/4",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/0/Data"
        }
      }
    ]
  },
  "steven-santos": {
    "kind": "codex",
    "id": "steven_santos",
    "titles": [
      "Steven Santos"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/12/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/12/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/4545/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/4545/femaleVariant",
        "subject": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/journal/cooked_journal.journal.json",
          "assetSha256": "1b85cf3d05431c628a03a4d5824fa2d052c48034147550ea0720df977f4aa7d3",
          "jsonSha256": "be2ad4c2570a734b003ead30e19bdc14b3c4e652ceae1186c5de973412a417b4"
        },
        "localization": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d",
          "jsonSha256": "76b5bdacc5210bfd16e3fed0232bea717e26ca6414da8947c818fa5665351a52"
        }
      }
    ],
    "actors": [
      {
        "name": "Steven",
        "voice": "3262212739462098944",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-gigs/wave3-support/raw/ep1/openworld/street_stories/sts_ep1_08/scenes/sts_ep1_08_client_meeting.scene.json",
          "assetSha256": "8b740ef961ec0cc03b2852d1a995506b5a4db03d8312b9fd1c907e0ec42711f1",
          "jsonSha256": "d6e3aa465699b2f54f85ee24f6c7b4c065825549dbcffd0743c2e6f9edb288f1",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/22",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/29/Data/events/6/Data"
        }
      }
    ]
  },
  "t-bug": {
    "kind": "codex",
    "id": "t_bug",
    "titles": [
      "T-Bug"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/29/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/29/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15141/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15141/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "TBug",
        "voice": "1103967280742240832",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/native-initial-20261001/raw/base/base/quest/main_quests/prologue/q005/scenes/q005_01_plan.scene.json",
          "assetSha256": "a7594ccc43cf7e26a703e11f5d8a81c897ef9f46233af210be627a4427612280",
          "jsonSha256": "eb646523b239aa305e9f01c4dd59e72596ef46c7e279c347301353f508a5961d",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/84",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/42/Data/events/3/Data"
        }
      }
    ]
  },
  "thompson": {
    "kind": "journal-contact",
    "id": "thompson",
    "titles": [
      "Thompson"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/12/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/3/Data/entries/12/Data/name/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/7203/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/7203/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [],
    "witnesses": [
      {
        "name": "thompson",
        "voice": "1103967280742240840",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/flashback-actors/raw/base/base/quest/main_quests/part1/q108/scenes/q108_11_thompson.scene.json",
          "assetSha256": "ba080c581911d0e8ae36acf5586235317bd11d9ebc3bce7bb6e901ebd8c20008",
          "jsonSha256": "e1ecdc4363a26d8c96e971099f40e16d04cee9fd5faf81efddd10743d2c63d67",
          "actorPointer": "/Data/RootChunk/actors/0",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/4/Data/events/5/Data"
        }
      },
      {
        "name": "Thompson",
        "voice": "1103967280742240840",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/flashback-actors/raw/base/base/quest/main_quests/part1/q108/scenes/q108_14_rogue.scene.json",
          "assetSha256": "3796d71423272deced7bdcab2952ba3fa6280f9b511f367bc7427ce2a27e5a2a",
          "jsonSha256": "d8fa120472e33bc9505256a465e5de686f769b4ce8814448984597e261921858",
          "actorPointer": "/Data/RootChunk/actors/3",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/56",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/11/Data"
        }
      }
    ]
  },
  "wakako-okada": {
    "kind": "codex",
    "id": "wakako_okada",
    "titles": [
      "Wakako Okada"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/3/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/3/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/14951/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/14951/femaleVariant",
        "subject": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b"
        },
        "localization": {
          "jsonPath": "runtime/johnny-intrinsic-evidence/localization/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92"
        }
      }
    ],
    "actors": [
      {
        "name": "wakako_okada",
        "voice": "1630416502798118912",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/wave3-padre-wakako-dino/raw/base/base/open_world/fixers/wakako/scenes/wakako_okada_default.scene.json",
          "assetSha256": "bd588c87c7a060be5432015fd22d302b910ab17d00d6a9d3d14cff9744c90498",
          "jsonSha256": "1327e4301f93ab1fb700c77587f522b51899621ce3e922ff85d748af526f979a",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/5/Data/events/2/Data"
        }
      }
    ]
  },
  "yorinobu-arasaka": {
    "kind": "codex",
    "id": "yorinobu_arasaka",
    "titles": [
      "Yorinobu Arasaka"
    ],
    "emittedSpeech": true,
    "subjectQualifications": [
      {
        "subjectPointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/13/Data/id",
        "titlePointer": "/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/13/Data/title/value",
        "primaryKeyPointer": "/Data/RootChunk/root/Data/entries/15157/primaryKey",
        "variantPointer": "/Data/RootChunk/root/Data/entries/15157/femaleVariant",
        "subject": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json",
          "assetSha256": "55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b",
          "jsonSha256": "558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3"
        },
        "localization": {
          "jsonPath": "research/cyberpunk/cache/game/scene-evidence/judy-river-authenticated-oct01/raw/base/base/localization/en-us/onscreens/onscreens.json.json",
          "assetSha256": "73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b",
          "jsonSha256": "78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5"
        }
      }
    ],
    "actors": [
      {
        "name": "Yorinobu",
        "voice": "1641804990500585472",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/wave3-dex-meredith-yorinobu/raw/base/base/quest/main_quests/prologue/q004/scenes/q004_05_bd_yorinobu.scene.json",
          "assetSha256": "357c55647bef238e57487242095060b479d3939a5308d8e601b2af77be72795c",
          "jsonSha256": "6a6c77e22ab69117c7b33f10bbc6f0e09144607ddae9eaee4f9c860f3e017f07",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/66",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/107/Data/events/67/Data"
        }
      },
      {
        "name": "yorinobu",
        "voice": "1641804990500585472",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/wave3-dex-meredith-yorinobu/raw/base/base/quest/main_quests/part1/q113/scenes/q113_14_yorinobu.scene.json",
          "assetSha256": "eeb1d730498bedacd32f79bd9342d0ff0d4a6c3f57bb182f66e648d8daa18d39",
          "jsonSha256": "b7aef58e3d427a9c4588b8428e6d2b4669e99786a2a5b78b6cb6fa81ac92894c",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/42",
          "eventPointer": "/Data/RootChunk/sceneGraph/Data/graph/28/Data/events/0/Data"
        }
      }
    ]
  },
  "mama-welles": {
    "id": "mama_welles",
    "titles": [
      "Mama Welles"
    ],
    "actors": [
      {
        "name": "mama_welles",
        "voice": "1704188817181679616",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/native-initial-20261001/raw/base/base/quest/tertiary_characters/default_dialogues/mama_welles_default.scene.json",
          "assetSha256": "3cba5c8ad9599041d986617cc7599c7fc3923b4f55880bcac7a02d6e17e74575",
          "jsonSha256": "11a0213c32195e5326e7f722f0ba897d6bf069fe24b5488db0f4d63212701a27",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/3"
        }
      },
      {
        "name": "Mama_Welles",
        "voice": "1704188817181679616",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-oct01/raw/base/base/quest/side_quests/sq018/scenes/sq018_03_funeral.scene.json",
          "assetSha256": "f9fb4978219a4cb589edd0a97681b4b8ad6bddf2295450f9d6b4ab103ea97b5a",
          "jsonSha256": "4ace66bc76eb0d2caefc2450763e0f2fe91ebbcafb6318a040e45738ba5ca970",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/38"
        }
      }
    ]
  },

  "misty-olszewski": {
    "id": "misty",
    "titles": [
      "Misty"
    ],
    "actors": [
      {
        "name": "Misty",
        "voice": "1103967280742240328",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-oct01/raw/base/base/quest/side_quests/sq018/scenes/sq018_03a_misty.scene.json",
          "assetSha256": "04028c9e99bc2782c3d1a4ad72af665bc47400f1cb1d62965794270209a7ff45",
          "jsonSha256": "3b90f69386f365cf59a196478df3984e8fb54574d45c1e2d12971964feb13d25",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/4"
        }
      }
    ]
  },
  "viktor-vektor": {
    "id": "viktor",
    "titles": [
      "Viktor Vektor"
    ],
    "actors": [
      {
        "name": "viktor",
        "voice": "1103967280742240868",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/native-initial-20261001/raw/base/base/quest/main_quests/prologue/q001/scenes/q001_04_ripperdoc.scene.json",
          "assetSha256": "42936da965ee84731061a69823ea91a150f6e7461dba8e27abdd65005431a671",
          "jsonSha256": "116196bdf65aaf6ab5155808a19a1c44f6aef7b4026d31ccbb298374ca07caa2",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/86"
        }
      },
      {
        "name": "Victor_Vector",
        "voice": "1103967280742240868",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/heywood-family-intrinsic-oct01/raw/base/base/quest/tertiary_characters/default_dialogues/victor_vector_default.scene.json",
          "assetSha256": "af528c7d7fbefeceeb47833fd63e73ad9d7b4414bca586b0e8ea0826c91bd0cf",
          "jsonSha256": "d92b97a4c1f182c2789aa058e56755107b717059d1a220c74af6fecd53915468",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/39"
        }
      }
    ]
  },
  "rogue-amendiares": {
    "id": "rogue",
    "titles": [
      "Rogue"
    ],
    "actors": [
      {
        "name": "rogue",
        "voice": "1215558083456446464",
        "qualification": {
          "jsonPath": "runtime/voice-cast/silverhand-cast/scenes/intrinsic-rogue-kerry-oct01/raw/base/base/quest/main_quests/part1/q103/scenes/q103_03_rogue.scene.json",
          "assetSha256": "7f4de2c6ce8581d261cc61268e27cf5a86b904ee7d0618b0c3bc8c95365b3556",
          "jsonSha256": "b169ac09a9c6b532f95e4cfc0abbe962f119cf4cdd727b34a558962ae28aebdb",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/6"
        }
      }
    ]
  },
  "takemura": {
    "id": "goro_takemura",
    "titles": [
      "Goro Takemura"
    ],
    "actors": [
      {
        "name": "Takemura",
        "voice": "1641719118585413632",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-b/scenes/arasaka-intrinsic-oct01/raw/base/base/quest/main_quests/part1/q112/scenes/q112_04_takemura.scene.json",
          "assetSha256": "34b93c3009397b12d9f5108546ee0500068d833369b47a925f39b249cad96945",
          "jsonSha256": "1088094791271ff50aedcfc89f75b0682ad8b32304f9cfcf0d8959bfb1cd6f28",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/87"
        }
      }
    ]
  },
  "solomon-reed": {
    "id": "reed",
    "titles": [
      "Solomon Reed"
    ],
    "actors": [
      {
        "name": "Reed_Holo",
        "voice": "2553392786132918272",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/scenes/intrinsic-fia-oct01/raw/ep1/ep1/quest/main_quests/q303/scenes/q303_02_nighthawks.scene.json",
          "assetSha256": "ef5b0e80d4adc0f53aa1548b737e7fd5f7a963425fbf7aea9ed63a4d3a426c03",
          "jsonSha256": "b9662ad910dd326fd3cbddfeb574f34623739ed70666022f1a690c3a0e478c55",
          "actorPointer": "/Data/RootChunk/actors/2",
          "voicetagPointer": "/Data/RootChunk/actors/2/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/28"
        }
      },
      {
        "name": "Reed",
        "voice": "2553392786132918272",
        "qualification": {
          "jsonPath": "runtime/voice-cast/phantom-main/scenes/intrinsic-fia-oct01/raw/ep1/ep1/quest/main_quests/q303/scenes/q303_02_nighthawks.scene.json",
          "assetSha256": "ef5b0e80d4adc0f53aa1548b737e7fd5f7a963425fbf7aea9ed63a4d3a426c03",
          "jsonSha256": "b9662ad910dd326fd3cbddfeb574f34623739ed70666022f1a690c3a0e478c55",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/41"
        }
      }
    ]
  },
  "muamar-reyes": {
    "id": "el_capitan",
    "titles": [
      "Muamar “El Capitan” Reyes"
    ],
    "actors": [
      {
        "name": "muamar_reyes",
        "voice": "1609922889482010624",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/raw/base/base/open_world/fixers/el_capitan/scenes/muamar_reyes_default.scene.json",
          "assetSha256": "9d5ae0e5a324181be06f20c7a1dd12e4bf3ff6fcf6430d02e2a2a948df666d2e",
          "jsonSha256": "799c9fd34bf867345a4c5c5bb4e8558d357fde471eed7f82c499ca0d4e20d754",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/1"
        }
      },
      {
        "name": "muamar_holo",
        "voice": "1609922889482010624",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/raw/base/base/open_world/fixers/el_capitan/scenes/muamar_reyes_default.scene.json",
          "assetSha256": "9d5ae0e5a324181be06f20c7a1dd12e4bf3ff6fcf6430d02e2a2a948df666d2e",
          "jsonSha256": "799c9fd34bf867345a4c5c5bb4e8558d357fde471eed7f82c499ca0d4e20d754",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/23"
        }
      }
    ]
  },
  "mr-hands": {
    "id": "mr_hands",
    "titles": [
      "Mr. Hands"
    ],
    "actors": [
      {
        "name": "Mr_Hands",
        "voice": "1254681766112239616",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/raw/ep1/ep1/quest/main_quests/q303/scenes/q303_04_mr_hands.scene.json",
          "assetSha256": "f4a684feac94901866ddee9b07d54b2e7c3b21abf0450d73fed7a69f0fb91f3a",
          "jsonSha256": "d8909b06235b225d8edfe302a6d72899449c02ee354e9878dae96913a9bc9107",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/33"
        }
      }
    ]
  },
  "regina-jones": {
    "id": "regina_jones",
    "titles": [
      "Regina Jones"
    ],
    "actors": [
      {
        "name": "regina",
        "voice": "1609919435757879296",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/raw/base/base/open_world/fixers/reggie/scenes/reggie_default.scene.json",
          "assetSha256": "0bbce4beb5ef0160a3b98ed4694f4bf9e4914bd76819929e6edf978b6982ebd0",
          "jsonSha256": "8ceb92790485ee13822a1c350ca734164a0bea8895f40c2084646242145537d4",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/8"
        }
      },
      {
        "name": "regina_holo",
        "voice": "1609919435757879296",
        "qualification": {
          "jsonPath": "runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/raw/base/base/open_world/fixers/reggie/scenes/reggie_default.scene.json",
          "assetSha256": "0bbce4beb5ef0160a3b98ed4694f4bf9e4914bd76819929e6edf978b6982ebd0",
          "jsonSha256": "8ceb92790485ee13822a1c350ca734164a0bea8895f40c2084646242145537d4",
          "actorPointer": "/Data/RootChunk/actors/1",
          "voicetagPointer": "/Data/RootChunk/actors/1/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/16"
        }
      }
    ]
  },
  "evelyn-parker": {
    "id": "eveyly_parker",
    "titles": [
      "Evelyn Parker"
    ],
    "actors": [
      {
        "name": "Evelyn",
        "voice": "1103967280742240436",
        "qualification": {
          "jsonPath": "runtime/voice-cast/main-core-a/scenes/native-initial-20261001/raw/base/base/quest/main_quests/prologue/q004/scenes/q004_02_meeting_evelyn.scene.json",
          "assetSha256": "ffcd4410566e3d0d05118e93d0305e4a473c7fb4c146c2f04cfa058857b1f207",
          "jsonSha256": "489574a28c3fd859188fe442fe3b037be9957abed043f74ecf07d5fdad268953",
          "actorPointer": "/Data/RootChunk/actors/0",
          "voicetagPointer": "/Data/RootChunk/actors/0/voicetagId/id",
          "linePointer": "/Data/RootChunk/screenplayStore/lines/60"
        }
      }
    ]
  }
});

// These are source-reviewed Johnny player representations, not ordinary V.
// New representation identities require another explicit source review.
const playerSubjectBindings = new Map([['johnny-silverhand', [
  {record: 'Character.Player_Puppet_Base', playerName: 'V_Posessed', voice: '1851716938809483264'},
  {record: 'Character.johnny_replacer', playerName: 'Player', voice: '1103967280742240508'},
  // Reviewed 2026-10-19 (native-reviews/johnny-lore-20261019.md): the 2023 memory scenes
  // q101_06c_memories_p2 and _p3 name the same replacer record and voice 'Johnny'.
  {record: 'Character.johnny_replacer', playerName: 'Johnny', voice: '1103967280742240508'},
]]]);
const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const own = (value, key) => Object.hasOwn(value, key);
const fail = message => { throw Error(`Intrinsic character claims: ${message}`); };
const safeSourcePath = value => typeof value === 'string' && !isAbsolute(value)
  && !value.includes('\\') && !value.includes(':')
  && !value.split('/').some(part => !part || part === '.' || part === '..')
  && /^(?:research\/cyberpunk\/cache\/game\/|runtime\/(?:voice-cast|johnny-intrinsic-evidence|jackie-intrinsic-oct01)\/)/u.test(value);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The authored schemas are deliberately normalized here, not rewritten on disk.
 * This view does not itself authenticate artifacts or authorize promotion. */
export function normalizeIntrinsicCharacterPack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid pack');
  value = structuredClone(value);
  const jackieForm = value.version === 1 && nonempty(value.key);
  const johnnyForm = value.schemaVersion === 1 && nonempty(value.characterKey);
  if (jackieForm === johnnyForm) fail('Unsupported or ambiguous pack schema');
  const key = jackieForm ? value.key : value.characterKey;
  const gameVersions = jackieForm ? value.gameVersions : [value.gameVersion];
  if (!KEY.test(key) || !Array.isArray(gameVersions) || !gameVersions.length
      || gameVersions.some(version => typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(version))) {
    fail('Invalid character or game version');
  }
  const supplied = jackieForm ? value.nativeSources : value.sources;
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > LIMIT.sources) fail(`${key}: invalid sources`);
  const seen = new Set();
  const sources = supplied.map(source => {
    const row = {id: source.id, depotPath: source.depotPath,
      rawPath: jackieForm ? source.rawPath : source.rawFile,
      jsonPath: jackieForm ? source.jsonPath : source.jsonFile,
      assetSha256: jackieForm ? source.assetSha256 : source.rawSha256,
      jsonSha256: source.jsonSha256, archiveEntrySha1: source.archiveEntrySha1,
      serialized: jackieForm ? source.serializationVerified === true
        : source.serialization === 'fresh-pinned-wolvenkit-9.0.1' && source.nativeIndexVerified === true};
    if (!ID.test(row.id || '') || seen.has(row.id) || !nonempty(row.depotPath)
        || !safeSourcePath(row.rawPath) || !safeSourcePath(row.jsonPath)
        || !SHA256.test(row.assetSha256 || '') || !SHA256.test(row.jsonSha256 || '')
        || !/^[a-f0-9]{40}$/u.test(row.archiveEntrySha1 || '') || !row.serialized) {
      fail(`${key}: unqualified or duplicate native source`);
    }
    seen.add(row.id); return row;
  });
  if (!Array.isArray(value.claims) || !value.claims.length || value.claims.length > LIMIT.claims) fail(`${key}: invalid claims`);
  const ids = new Set();
  const claims = value.claims.map(claim => {
    if (!claim || !ID.test(claim.id || '') || ids.has(claim.id) || !nonempty(claim.text)
        || claim.text.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(claim.text)
        || !Array.isArray(claim.audience)) fail(`${key}: invalid or duplicate claim`);
    if (own(claim, 'requiredContext') && (!Array.isArray(claim.requiredContext)
        || claim.requiredContext.length > 16 || claim.requiredContext.some(value => !nonempty(value)))) {
      fail(`${key}/${claim.id}: unsupported prerequisite shape`);
    }
    if (!claim.qualification || typeof claim.qualification !== 'object' || Array.isArray(claim.qualification)
        || Object.keys(claim.qualification).some(field => !qualificationFields.has(field))
        || (own(claim.qualification, 'currentSaveQualified') && typeof claim.qualification.currentSaveQualified !== 'boolean')) {
      fail(`${key}/${claim.id}: unsupported qualification shape`);
    }
    ids.add(claim.id);
    return {...claim, nativeRefs: jackieForm ? claim.exactnativeRefs : claim.nativeRefs};
  });
  const samples = jackieForm ? value.speakingStyleSamples : value.cadenceExamples;
  if (samples !== undefined && (!Array.isArray(samples) || samples.length > 32)) fail(`${key}: invalid samples`);
  return freeze({key, name: value.name, gameVersions: [...gameVersions], sources, claims,
    samples: (samples || []).map(sample => ({...sample,
      original: jackieForm ? /^original; not a game quote$/u.test(sample.authoring || '') && sample.speakerPrefix === false
        : /^Original editorial delivery examples,/u.test(value.sourcePolicy?.examples || '')})),
    sourceContentSha256: hash(JSON.stringify(value))});
}

function publicClaim(claim) {
  if (!['intrinsic', 'uncertain-recollection', 'attributed-recollection'].includes(claim.kind)
      || !publicDisclosures.has(claim.disclosure) || claim.requiredContext?.length
      || claim.condition !== undefined || claim.questKey !== undefined || claim.decisionId !== undefined
      || claim.outcomeKey !== undefined || claim.currentSaveQualified === true
      || claim.qualification?.currentSaveQualified === true) return false;
  const audience = new Set(claim.audience);
  const allChannels = audience.size === 3 && ['private', 'phone', 'group'].every(channel => audience.has(channel));
  // The alternate schema explicitly marks the claim safe for a group without
  // private details. Its public topic material is equally eligible by phone;
  // this does not grant permission to claims carrying one-to-one only labels.
  const publicGroup = audience.size === 2 && audience.has('private-one-to-one') && audience.has('group-without-private-details');
  if (!allChannels && !publicGroup) return false;
  const qualification = claim.qualification;
  if (!qualification || (qualification.profileUse !== undefined && qualification.profileUse !== 'topic-knowledge')
      || (qualification.status !== undefined && qualification.status !== 'source-authenticated-authoring')) return false;
  if (claim.kind !== 'intrinsic' && !/\b(?:recalls?|remembers?|recollection|according to|says|reports?)\b/iu.test(claim.text)) return false;
  return true;
}

function limitsFor(claim) {
  const limits = claim.qualification?.limits;
  if (limits === undefined) return [];
  const values = typeof limits === 'string' ? [limits] : limits;
  if (!Array.isArray(values) || values.length > 8 || values.some(value => !nonempty(value) || value.length > 1600)) {
    fail(`${claim.id}: invalid qualification limits`);
  }
  return values.map(value => value.trim());
}

// The 2026-10-05 disk offload moved research/cyberpunk/cache here; the repo path is a junction to it.
export const OFFLOAD_ROOT = 'E:\\CyberpunkConvai-offload';
function within(directory, target) {
  const distance = relative(directory, target);
  return distance !== '' && !isAbsolute(distance) && distance.split(/[\\/]/)[0] !== '..';
}
export function diskLoader(root, {offloadRoot = OFFLOAD_ROOT} = {}) {
  // A resolved target is acceptable inside the evidence root or inside the offload folder; anything else escapes.
  function offloaded(target) {
    try { return within(realpathSync(offloadRoot), target); } catch { return false; }
  }
  function bytes(name) {
    if (!safeSourcePath(name)) fail('Uncontained source path');
    const target = realpathSync(resolve(root, name));
    const inside = relative(root, target).replaceAll('\\', '/');
    if (!safeSourcePath(inside) && !offloaded(target)) fail('Source junction escapes the evidence roots');
    const info = statSync(target);
    if (!info.isFile() || info.size > LIMIT.artifactBytes) fail('Native artifact size limit');
    return readFileSync(target);
  }
  return source => ({raw: bytes(source.rawPath), jsonRaw: bytes(source.jsonPath)});
}

function reviewedPropertyDiskLoader(root, receipt) {
  const relativeFiles = {reviewRaw: receipt.reviewPath, probeRaw: receipt.probePath,
    installedReceiptRaw: receipt.installedReceiptPath, querySnapshotRaw: receipt.querySnapshotPath};
  const result = {};
  for (const [field, path] of Object.entries(relativeFiles)) {
    const target = realpathSync(resolve(root, path));
    if (relative(root, target).replaceAll('\\', '/') !== path || statSync(target).size > LIMIT.artifactBytes) {
      fail('Uncontained reviewed property evidence');
    }
    result[field] = readFileSync(target);
  }
  result.installedFiles = receipt.installedTweakdbFiles.map(file => {
    if (statSync(file.absolutePath).size !== file.bytes) fail('Installed TweakDB file changed since property review');
    return {absolutePath: file.absolutePath, raw: readFileSync(file.absolutePath)};
  });
  return result;
}

/** This branch authenticates runtime evidence; it never assigns a native CR2W type. */
export function verifyReviewedLivePropertyEvidence(receipt, artifact) {
  const fields = {reviewRaw: 'reviewSha256', probeRaw: 'probeSha256',
    installedReceiptRaw: 'installedReceiptSha256', querySnapshotRaw: 'querySnapshotSha256'};
  for (const [field, digest] of Object.entries(fields)) {
    if (!Buffer.isBuffer(artifact?.[field]) || artifact[field].length > LIMIT.artifactBytes
        || hash(artifact[field]) !== receipt[digest]) fail(`reviewed live-property ${field} hash mismatch`);
  }
  const parse = field => JSON.parse(artifact[field].toString('utf8').replace(/^\uFEFF/u, ''));
  const review = parse('reviewRaw'), probe = parse('probeRaw'), installed = parse('installedReceiptRaw');
  if (review.evidenceKind !== 'live-read-only-TweakDB-property-probe'
      || review.probeSha256 !== receipt.probeSha256 || review.installedReceiptSha256 !== receipt.installedReceiptSha256
      || review.queryCode?.snapshotSha256 !== receipt.querySnapshotSha256 || !isDeepStrictEqual(review.probe, probe)
      || probe.readOnly !== true || probe.recordExists !== true || probe.version !== 1
      || probe.record !== receipt.record || probe.gameVersion !== receipt.gameVersion || probe.capturedAt !== receipt.capturedAt
      || !isDeepStrictEqual(probe.properties, receipt.properties)) fail('reviewed live-property provenance mismatch');
  for (const flat of ['displayName', 'fullDisplayName']) {
    const value = probe.properties[flat];
    if (value.query !== `TweakDB:GetFlat('${receipt.record}.${flat}')` || value.ok !== true
        || value.luaType !== 'userdata' || value.value !== `LocKey(${value.localizationKey}ull)`
        || value.localizationKey !== '32025' || value.localized !== 'R3N0') fail('reviewed live-property flat mismatch');
  }
  if (!Array.isArray(installed) || installed.length !== receipt.installedTweakdbFiles.length
      || !Array.isArray(artifact.installedFiles) || artifact.installedFiles.length !== installed.length) {
    fail('reviewed live-property installed TweakDB receipt mismatch');
  }
  for (const file of receipt.installedTweakdbFiles) {
    const recorded = installed.find(item => item.name === file.name);
    const bytes = artifact.installedFiles.find(item => item.absolutePath === file.absolutePath)?.raw;
    if (!recorded || recorded.bytes !== file.bytes || recorded.sha256 !== file.sha256 || !Buffer.isBuffer(bytes)
        || bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('stale installed TweakDB property receipt');
  }
  const nativeId = numericRecordId(receipt.record);
  const match = /^ToTweakDBID\{ hash = 0x([A-F0-9]+), length = (\d+) /u.exec(probe.nativeRecordId || '');
  if (!match || (BigInt(match[2]) << 32n | BigInt(`0x${match[1]}`)) !== nativeId) {
    fail('reviewed live-property native record ID mismatch');
  }
  return freeze(probe);
}

function typedContainer(document, pointer) {
  const parts = pointer.split('/');
  while (parts.length > 1) {
    const value = jsonPointer(document, parts.join('/'));
    if (value && typeof value === 'object' && !Array.isArray(value) && nonempty(value.$type)) return value.$type;
    parts.pop();
  }
  fail('Reference is not inside a typed native object');
}

const nativeString = value => typeof value === 'string' ? value : value?.$value;
const actorRecord = actor => [actor?.specCharacterRecordId, actor?.spawnDespawnParams?.specRecordId,
  actor?.findActorInContextParams?.specRecordId].map(nativeString)
  .find(value => nonempty(value) && value !== '0' && value !== 'None');
const validActorId = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)));
const sameActorId = (a, b) => validActorId(a) && validActorId(b) && Number(a) === Number(b);
const namedSubject = (actor, profile) => {
  const name = nativeString(actor.actorName)?.trim().toLocaleLowerCase('en-US');
  return nonempty(name) && [profile.name, ...(profile.aliases || []), ...(profile.nativeSubjectNames || [])]
    .some(value => typeof value === 'string' && value.trim().toLocaleLowerCase('en-US') === name);
};
const reviewedSubject = key => own(REVIEWED_INTRINSIC_SUBJECT_BINDINGS, key)
  ? REVIEWED_INTRINSIC_SUBJECT_BINDINGS[key] : null;
// An exact whole-object expectation also records its children. A sibling or a
// mere descendant does not prove a field that the attribution actually uses.
const citedField = (claim, sourceId, pointer) => claim.nativeRefs.some(reference =>
  reference.sourceId === sourceId && (reference.jsonPointer === pointer
    || pointer.startsWith(reference.jsonPointer + '/')
      && ['expected', 'expectedValue'].some(field => reference[field] && typeof reference[field] === 'object')));
const sourceReceiptMatches = (pack, sourceId, receipt) => {
  const source = pack.sources.find(item => item.id === sourceId);
  return source && receipt && ['assetSha256', 'jsonSha256'].every(field => source[field] === receipt[field]);
};

// Review references belong to the identity argument, not to the claim's prose.
// Keeping them distinct prevents a named address or private identity context from
// being emitted as character history or relabeled as the subject's own speech.
function verifyIdentityReceipt(claim, receipt, pack, documentFor) {
  const ids = new Map(receipt.sources.map(source => {
    const declared = pack.sources.find(item => item.depotPath === source.depotPath
      && sourceReceiptMatches(pack, item.id, source));
    if (!declared) fail(`${claim.id}: missing exact reviewed identity source`);
    return [source.id, declared.id];
  }));
  const refs = receipt.refs.map(reference => {
    const sourceId = ids.get(reference.sourceId), document = documentFor(sourceId);
    if (!reference.jsonPointer.startsWith('/Data/') || !nonempty(typedContainer(document, reference.jsonPointer))
        || !isDeepStrictEqual(jsonPointer(document, reference.jsonPointer), reference.expectedValue)) {
      fail(`${claim.id}: reviewed identity field mismatch`);
    }
    return {...reference, sourceId};
  });
  const identityClaim = {id: claim.id, nativeRefs: refs};
  for (const line of receipt.lines) {
    const speaker = {...line, sourceId: ids.get(line.sourceId)}, source = documentFor(speaker.sourceId);
    const actor = jsonPointer(source, speaker.actorPointer), dialogue = jsonPointer(source, speaker.linePointer);
    if (!['scnActorDef', 'scnPlayerActorDef'].includes(actor?.$type)
        || dialogue?.$type !== 'scnscreenplayDialogLine' || !sameActorId(actor.actorId?.id, dialogue.speaker?.id)
        || String(actor.voicetagId?.id) !== speaker.expectedVoicetag) {
      fail(`${claim.id}: reviewed identity actor-to-speaker mismatch`);
    }
    exactEventPointer(identityClaim, speaker, source, dialogue);
    verifyEmittedEnglish(identityClaim, speaker, source, dialogue, pack, documentFor);
  }
  return {refs, checks: refs.length + receipt.lines.length * 3,
    identity: {reviewId: receipt.reviewId, evidenceKind: receipt.evidenceKind,
      worldRegistryBindingVerified: false, limits: receipt.limits}};
}

function verifyNarrativeIdentity(claim, proof, reviewed, pack, documentFor) {
  const receipt = reviewed.identityQualification;
  if (!proof.identityProof || proof.identityProof.kind !== receipt.kind
      || proof.identityProof.reviewId !== receipt.reviewId) fail(`${claim.id}: missing explicit reviewed identity proof`);
  return verifyIdentityReceipt(claim, receipt, pack, documentFor);
}

function verifyAuthoredDocument(claim, proof, reviewed, pack, documentFor, ownership, narrativeLines) {
  const ref = proof.documentRef;
  const receipt = reviewed?.authoredDocuments?.find(item => ref?.expectedId === item.documentRef.expectedId
    && ref.author === item.author && ref.jsonPointer === item.documentRef.jsonPointer);
  if (!receipt || proof.speakers.length || narrativeLines.size || proof.subjectRef.kind !== 'journal-contact') {
    fail(`${claim.id}: missing reviewed document authorship`);
  }
  const result = verifyIdentityReceipt(claim, receipt, pack, documentFor);
  const document = documentFor(ref.sourceId), entry = jsonPointer(document, ref.jsonPointer);
  const titleRef = result.refs.find(item => item.jsonPointer === receipt.titlePointer);
  const contentRef = result.refs.find(item => item.jsonPointer === receipt.contentPointer);
  if (ref.containerType !== 'gameJournalOnscreen' || entry?.$type !== ref.containerType || entry.id !== ref.expectedId
      || ref.titlePointer !== `${ref.jsonPointer}/title/value` || ref.contentPointer !== `${ref.jsonPointer}/description/value`
      || entry.title?.value !== `LocKey#${receipt.titleLocKey}` || entry.description?.value !== `LocKey#${receipt.contentLocKey}`
      || !result.refs.some(item => item.sourceId === ref.sourceId && item.jsonPointer === ref.titlePointer)
      || jsonPointer(documentFor(titleRef.sourceId), titleRef.jsonPointer) !== receipt.title
      || !nonempty(jsonPointer(documentFor(contentRef.sourceId), contentRef.jsonPointer))
      || result.refs.some(item => !citedField(claim, item.sourceId, item.jsonPointer))) {
    fail(`${claim.id}: document title, author or localized content mismatch`);
  }
  const requiredAuthorship = [{sourceId: ref.sourceId, jsonPointer: ref.titlePointer},
    {...titleRef, jsonPointer: titleRef.jsonPointer.replace(/femaleVariant$/u, 'primaryKey')}, titleRef];
  if (!Array.isArray(proof.authorshipRefs) || requiredAuthorship.some(required =>
    !proof.authorshipRefs.some(item => item.sourceId === required.sourceId && item.jsonPointer === required.jsonPointer))) {
    fail(`${claim.id}: missing recorded signed title authorship`);
  }
  return {checks: 1 + ownership.checks + result.checks, mode: proof.mode, perspective: proof.perspective,
    identity: {...result.identity, evidenceKind: 'signed-native-document', author: receipt.author}};
}

function exactEventPointer(claim, speaker, source, line) {
  const candidates = speaker.eventPointer === undefined ? [...new Set(claim.nativeRefs.flatMap(reference => {
    const match = /^(\/Data\/RootChunk\/sceneGraph\/Data\/graph\/\d+\/Data\/events\/\d+\/Data)(?:\/|$)/u.exec(reference.jsonPointer);
    return reference.sourceId === speaker.sourceId && match ? [match[1]] : [];
  }))] : [speaker.eventPointer];
  for (const pointer of candidates) {
    if (!/^\/Data\/RootChunk\/sceneGraph\/Data\/graph\/\d+\/Data\/events\/\d+\/Data$/u.test(pointer)) continue;
    const event = jsonPointer(source, pointer);
    if (event?.$type === 'scnDialogLineEvent' && sameActorId(event.screenplayLineId?.id, line.itemId?.id)
        && citedField(claim, speaker.sourceId, pointer + '/screenplayLineId/id')) return pointer;
  }
  fail(`${claim.id}: missing recorded emitted dialog event for screenplay item`);
}

function verifyEmittedEnglish(claim, speaker, source, line, pack, documentFor) {
  const locstring = line.locstringId?.ruid;
  if (typeof locstring !== 'string' || !/^\d+$/u.test(locstring)
      || !citedField(claim, speaker.sourceId, speaker.linePointer + '/locstringId/ruid')) {
    fail(`${claim.id}: spoken line lacks recorded localization identity`);
  }
  const pointers = [...new Set(claim.nativeRefs.flatMap(reference => {
    const match = /^(\/Data\/RootChunk\/locStore\/vdEntries\/\d+)(?:\/|$)/u.exec(reference.jsonPointer);
    return reference.sourceId === speaker.sourceId && match ? [match[1]] : [];
  }))];
  const matched = pointers.some(pointer => {
    const entry = jsonPointer(source, pointer);
    if (entry?.$type !== 'scnlocLocStoreEmbeddedVariantDescriptorEntry' || entry.localeId !== 'en_us'
        || entry.locstringId?.ruid !== locstring || !Number.isSafeInteger(entry.vpeIndex) || entry.vpeIndex < 0
        || !['localeId', 'locstringId/ruid', 'vpeIndex'].every(field =>
          citedField(claim, speaker.sourceId, `${pointer}/${field}`))) return false;
    const payloadPointer = `/Data/RootChunk/locStore/vpEntries/${entry.vpeIndex}`;
    const payload = source.Data.RootChunk.locStore?.vpEntries?.[entry.vpeIndex];
    return payload?.$type === 'scnlocLocStoreEmbeddedVariantPayloadEntry' && nonempty(payload.content)
      && typeof entry.variantId?.ruid === 'string' && payload.variantId?.ruid === entry.variantId.ruid
      && citedField(claim, speaker.sourceId, `${payloadPointer}/content`);
  });
  if (!matched) fail(`${claim.id}: missing recorded same-line English descriptor and payload`);
  const subtitle = claim.nativeRefs.some(reference => {
    const match = /^(\/Data\/RootChunk\/root\/Data\/entries\/\d+)(?:\/|$)/u.exec(reference.jsonPointer);
    const declared = pack.sources.find(item => item.id === reference.sourceId);
    if (!match || !/\\localization\\en-us\\subtitles\\/u.test(declared?.depotPath || '')) return false;
    const entry = jsonPointer(documentFor(reference.sourceId), match[1]);
    return entry?.$type === 'localizationPersistenceSubtitleEntry' && String(entry.stringId) === locstring
      && citedField(claim, reference.sourceId, match[1] + '/stringId')
      && ['femaleVariant', 'maleVariant'].some(field => nonempty(entry[field])
        && citedField(claim, reference.sourceId, `${match[1]}/${field}`));
  });
  // Exact text revisions remain explicit authored evidence; this joins their
  // native ID and never normalizes or silently equates different wording.
  if (!subtitle) fail(`${claim.id}: missing recorded same-ID shipped English subtitle`);
}

// TweakDBID's lower forty bits are the CRC32 plus ASCII byte length. The upper
// offset bits belong to runtime storage, not to a different canonical record.
function numericRecordId(record) {
  if (typeof record !== 'string' || !/^[\x20-\x7e]{1,255}$/u.test(record)) return null;
  let crc = 0xffffffff;
  for (const byte of Buffer.from(record, 'ascii')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (BigInt(record.length) << 32n) | BigInt((crc ^ 0xffffffff) >>> 0);
}

/** Pure identity validation; it does not create an authenticated compiler view. */
export function resolveIntrinsicActorRecord(actor, subject, records) {
  const fields = {findInContext: 'findActorInContextParams/specRecordId', spawnDespawn: 'spawnDespawnParams/specRecordId'};
  const field = fields[actor?.acquisitionPlan];
  if (actor?.$type !== 'scnActorDef' || !field || !/^\/Data\/RootChunk\/actors\/\d+$/u.test(subject.actorPointer || '')
      || subject.jsonPointer !== `${subject.actorPointer}/${field}` || subject.containerType !== 'TweakDBID'
      || actor.acquisitionPlan === 'spawnDespawn'
        && (actor.spawnDespawnParams?.isEnabled === 0 || actor.spawnDespawnParams?.findInWorld === 1)) {
    fail('actor-record must use the same actor active acquisition field');
  }
  const [container, property] = field.split('/'), value = actor[container]?.[property];
  if (value?.$type !== 'TweakDBID' || !nonempty(subject.canonicalRecord) || !Array.isArray(records)) {
    fail('missing typed canonical actor record');
  }
  let matches = [];
  if (value.$storage === 'string') matches = records.filter(record => record === value.$value);
  else if (value.$storage === 'uint64' && typeof value.$value === 'string' && /^\d+$/u.test(value.$value)) {
    const number = BigInt(value.$value);
    if (number > 0n && number <= 0xffffffffffffffffn) {
      const identity = number & 0xffffffffffn;
      matches = records.filter(record => numericRecordId(record) === identity);
    }
  }
  if (matches.length !== 1 || matches[0] !== subject.canonicalRecord) fail('canonical actor record is zero, ambiguous or mismatched');
  return matches[0];
}

function verifyActorRecordOwnership(claim, proof, subject, profile, pack, documentFor, reviewedPropertyFor) {
  const source = documentFor(subject.sourceId), actor = jsonPointer(source, subject.actorPointer);
  if (!profile.records?.includes(subject.canonicalRecord)) fail(`${claim.id}: actor record does not belong to this profile`);
  const record = resolveIntrinsicActorRecord(actor, subject, profile.nativeCanonicalRecords ?? profile.records);
  if (!citedField(claim, subject.sourceId, subject.jsonPointer)
      || !citedField(claim, subject.sourceId, subject.actorPointer + '/acquisitionPlan')
      || !proof.speakers.some(speaker => speaker.sourceId === subject.sourceId && speaker.actorPointer === subject.actorPointer)) {
    fail(`${claim.id}: actor-record is not the recorded speaking actor`);
  }
  // A record-looking localization secondaryKey is not a property binding.
  // Native properties and reviewed live probes have separate provenance paths.
  const binding = reviewedSubject(profile.key)?.recordBindings?.find(item => item.record === record);
  const refs = proof.recordDisplayNameRefs;
  if (!binding || !binding.propertyQualification || !Array.isArray(refs)) {
    fail(`${claim.id}: missing reviewed record display-name property binding`);
  }
  const property = binding.propertyQualification, propertyRef = proof.recordDisplayNameBinding;
  if (property.kind === 'reviewed-live-property') {
    if (!propertyRef || propertyRef.kind !== property.kind || propertyRef.reviewId !== property.reviewId
        || propertyRef.record !== record || !['displayName', 'fullDisplayName'].includes(propertyRef.flat)
        || propertyRef.jsonPointer !== `/properties/${propertyRef.flat}`
        || typeof reviewedPropertyFor !== 'function') fail(`${claim.id}: missing reviewed live-property provenance`);
    const probe = reviewedPropertyFor(property);
    if (!isDeepStrictEqual(jsonPointer(probe, propertyRef.jsonPointer), property.properties[propertyRef.flat])) {
      fail(`${claim.id}: reviewed live-property flat mismatch`);
    }
  } else if (!propertyRef || propertyRef.jsonPointer !== property.jsonPointer
      || !sourceReceiptMatches(pack, propertyRef.sourceId, property)
      || !citedField(claim, propertyRef.sourceId, propertyRef.jsonPointer)
      || !isDeepStrictEqual(jsonPointer(documentFor(propertyRef.sourceId), propertyRef.jsonPointer), property.expected)) {
    fail(`${claim.id}: unqualified record display-name property binding`);
  }
  const matched = refs.some(reference => {
    if (!reference.jsonPointer?.endsWith('/primaryKey') || !citedField(claim, reference.sourceId, reference.jsonPointer)
        || !sourceReceiptMatches(pack, reference.sourceId, binding.localizationQualification)) return false;
    const parent = reference.jsonPointer.slice(0, -11), entry = jsonPointer(documentFor(reference.sourceId), parent);
    return entry?.$type === 'localizationPersistenceOnScreenEntry' && String(entry.primaryKey) === binding.primaryKey
      && entry.secondaryKey === binding.secondaryKey
      && refs.some(item => item.sourceId === reference.sourceId && item.jsonPointer === parent + '/secondaryKey'
        && citedField(claim, item.sourceId, item.jsonPointer))
      && refs.some(item => item.sourceId === reference.sourceId && ['femaleVariant', 'maleVariant'].some(field =>
        item.jsonPointer === `${parent}/${field}` && binding.titles.includes(entry[field]))
        && citedField(claim, item.sourceId, item.jsonPointer));
  });
  if (!matched) fail(`${claim.id}: reviewed record display-name mismatch`);
  return {qualified: true, checks: 5, actorPointer: subject.actorPointer, sourceId: subject.sourceId,
    ...(property.kind === 'reviewed-live-property' ? {identity: {evidenceKind: 'live-read-only-TweakDB-property-probe',
      reviewId: property.reviewId, worldRegistryBindingVerified: false, limits: property.limits}} : {})};
}

function verifyReviewedSubjectOwnership(claim, proof, subject, entry, profile, documentFor, pack) {
  const reviewed = reviewedSubject(profile.key);
  if (!reviewed) return {qualified: false, checks: 0};
  const titleRefs = proof.subjectTitleRefs;
  const recordRefs = proof.subjectRecordRefs;
  const cited = reference => claim.nativeRefs.some(item => item.sourceId === reference.sourceId
    && item.jsonPointer === reference.jsonPointer);
  if (titleRefs !== undefined) {
    if (!Array.isArray(titleRefs) || titleRefs.length < 3 || titleRefs.length > 12
        || titleRefs.some(reference => !reference || !nonempty(reference.sourceId)
          || typeof reference.jsonPointer !== 'string' || !reference.jsonPointer.startsWith('/Data/')
          || !cited(reference))) fail(`${claim.id}: invalid reviewed subject title references`);
    const titleField = subject.kind === 'journal-contact' ? 'name' : 'title';
    const titlePointer = subject.jsonPointer.slice(0, -3) + `/${titleField}/value`;
    const titleKey = /^LocKey#(\d+)$/u.exec(entry[titleField]?.value);
    if (!titleKey || !titleRefs.some(reference => reference.sourceId === subject.sourceId
        && reference.jsonPointer === titlePointer)) fail(`${claim.id}: missing subject-to-title binding`);
    let matched = false;
    for (const reference of titleRefs.filter(reference => reference.jsonPointer.endsWith('/primaryKey'))) {
      const document = documentFor(reference.sourceId), key = jsonPointer(document, reference.jsonPointer);
      const path = reference.jsonPointer.slice(0, -11), localized = jsonPointer(document, path);
      if (localized?.$type !== 'localizationPersistenceOnScreenEntry' || String(key) !== titleKey[1]) continue;
      for (const variant of titleRefs.filter(item => item.sourceId === reference.sourceId
          && ['femaleVariant', 'maleVariant'].some(field => item.jsonPointer === `${path}/${field}`))) {
        const value = jsonPointer(document, variant.jsonPointer);
        if (reviewed.titles.includes(value) && (!reviewed.emittedSpeech || reviewed.subjectQualifications.some(receipt =>
          receipt.subjectPointer === subject.jsonPointer && receipt.titlePointer === titlePointer
          && receipt.primaryKeyPointer === reference.jsonPointer && receipt.variantPointer === variant.jsonPointer
          && sourceReceiptMatches(pack, subject.sourceId, receipt.subject)
          && sourceReceiptMatches(pack, reference.sourceId, receipt.localization)))) matched = true;
      }
    }
    // Explicitly supplied wrong title evidence cannot be rescued by a separate
    // record reference: contradictory ownership data must reject the proposal.
    if (!matched) fail(`${claim.id}: reviewed native subject title mismatch`);
    return {qualified: true, checks: 3};
  }
  if (recordRefs !== undefined && !reviewed.emittedSpeech && subject.kind !== 'journal-contact') {
    if (!Array.isArray(recordRefs) || !recordRefs.length || recordRefs.length > 8
        || recordRefs.some(reference => !reference || !nonempty(reference.sourceId)
          || typeof reference.jsonPointer !== 'string' || !reference.jsonPointer.startsWith('/Data/')
          || !cited(reference))) fail(`${claim.id}: invalid reviewed subject record references`);
    for (const reference of recordRefs) {
      const document = documentFor(reference.sourceId), value = jsonPointer(document, reference.jsonPointer);
      const record = typeof value === 'string' ? value : nativeString(value);
      const typed = typeof value === 'string' ? jsonPointer(document,
        reference.jsonPointer.slice(0, reference.jsonPointer.lastIndexOf('/'))) : value;
      if (typed?.$type === 'TweakDBID' && profile.records?.includes(record)) return {qualified: true, checks: 1};
    }
    fail(`${claim.id}: reviewed native subject record mismatch`);
  }
  fail(`${claim.id}: reviewed subject alias requires sourced title or canonical record ownership`);
}
function reviewedNamedSubject(actor, profile, ownership, speaker, pack) {
  const reviewed = reviewedSubject(profile.key);
  if (!reviewed) return namedSubject(actor, profile);
  return ownership && reviewed.actors.some(binding => nativeString(actor.actorName) === binding.name
    && String(actor.voicetagId?.id ?? '') === binding.voice
    && (!reviewed.emittedSpeech || binding.qualification.actorPointer === speaker.actorPointer
      && sourceReceiptMatches(pack, speaker.sourceId, binding.qualification)));
}
function representedSubject(actor, profile) {
  const record = actorRecord(actor), voice = String(actor.voicetagId?.id ?? '');
  return playerSubjectBindings.get(profile.key)?.some(binding => binding.record === record
    && binding.playerName === actor.playerName && binding.voice === voice) === true;
}

/** Validates attribution structure; compileIntrinsicCharacterPacks alone authenticates bytes. */
export function verifyIntrinsicAttribution(claim, pack, profile, documentFor, reviewedPropertyFor) {
  const proof = claim.attribution;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.characterKey !== pack.key
      || !['native-codex', 'self-report', 'third-party-report', 'represented-memory', 'authored-document'].includes(proof.mode)
      || !nonempty(proof.perspective) || proof.perspective.length > 1600
      || !Array.isArray(proof.speakers) || proof.speakers.length > 128) fail(`${claim.id}: missing claim-scoped subject attribution`);
  const subject = proof.subjectRef;
  const kind = subject?.kind ?? 'codex';
  if (!subject || typeof subject.jsonPointer !== 'string' || !['codex', 'journal-contact', 'actor-record'].includes(kind)
      || (kind !== 'actor-record' && !subject.jsonPointer.endsWith('/id'))) {
    fail(`${claim.id}: missing typed subject binding`);
  }
  const document = documentFor(subject.sourceId), actual = jsonPointer(document, subject.jsonPointer);
  const reviewed = reviewedSubject(pack.key), strict = kind !== 'codex' || reviewed?.emittedSpeech === true;
  let ownership;
  if (kind === 'actor-record') ownership = verifyActorRecordOwnership(claim, proof, subject, profile, pack, documentFor, reviewedPropertyFor);
  else {
    const entry = jsonPointer(document, subject.jsonPointer.slice(0, -3));
    const expectedSubjectId = reviewed?.id ?? pack.key.replaceAll('-', '_');
    const type = kind === 'journal-contact' ? 'gameJournalContact' : 'gameJournalCodexEntry';
    if (entry?.$type !== type || actual !== expectedSubjectId
        || (subject.expected !== undefined && actual !== subject.expected)
        || (subject.containerType !== undefined && subject.containerType !== entry.$type)
        || (strict && (!reviewed || (reviewed.kind ?? 'codex') !== kind
          || !citedField(claim, subject.sourceId, subject.jsonPointer)))) fail(`${claim.id}: native subject identity mismatch`);
    ownership = verifyReviewedSubjectOwnership(claim, proof, subject, entry, profile, documentFor, pack);
  }
  const narrativeLines = new Set(claim.nativeRefs.flatMap(reference => {
    const match = /^(\/Data\/RootChunk\/screenplayStore\/lines\/\d+)(?:\/|$)/u.exec(reference.jsonPointer);
    return match ? [JSON.stringify([reference.sourceId, match[1]])] : [];
  }));
  if (proof.mode === 'authored-document') {
    return verifyAuthoredDocument(claim, proof, reviewed, pack, documentFor, ownership, narrativeLines);
  }
  if (reviewed?.identityQualification) {
    const identity = verifyNarrativeIdentity(claim, proof, reviewed, pack, documentFor);
    ownership = {...ownership, checks: ownership.checks + identity.checks, identity: identity.identity};
  }
  if (proof.mode === 'native-codex') {
    if (kind !== 'codex') fail(`${claim.id}: only a genuine codex can supply native-codex material`);
    if (proof.speakers.length || narrativeLines.size) fail(`${claim.id}: scene evidence cannot masquerade as codex material`);
    const parent = subject.jsonPointer.slice(0, -3);
    if (!claim.nativeRefs.some(reference => reference.sourceId === subject.sourceId
        && reference.jsonPointer === subject.jsonPointer)) fail(`${claim.id}: claim lacks its subject codex identity evidence`);
    const content = claim.nativeRefs.filter(reference => reference.sourceId === subject.sourceId
      && reference.jsonPointer.startsWith(parent + '/') && reference.jsonPointer.endsWith('/textContent/value'));
    const boundText = content.some(reference => {
      const key = /^LocKey#(\d+)$/u.exec(jsonPointer(document, reference.jsonPointer));
      if (!key) return false;
      return claim.nativeRefs.some(localized => {
        if (!localized.jsonPointer.endsWith('/primaryKey')) return false;
        const textDocument = documentFor(localized.sourceId), entryPointer = localized.jsonPointer.slice(0, -11);
        if (String(jsonPointer(textDocument, localized.jsonPointer)) !== key[1]) return false;
        return claim.nativeRefs.some(variant => variant.sourceId === localized.sourceId
          && ['femaleVariant', 'maleVariant'].some(field => variant.jsonPointer === `${entryPointer}/${field}`)
          && nonempty(jsonPointer(textDocument, variant.jsonPointer)));
      });
    });
    if (!boundText) fail(`${claim.id}: claim lacks subject-bound localized codex material`);
    return {checks: 1 + ownership.checks, mode: proof.mode, perspective: proof.perspective};
  }
  if (!proof.speakers.length) fail(`${claim.id}: missing native speaker binding`);
  let self = false, frame = false, checks = 1 + ownership.checks; const attributedLines = new Set();
  for (const speaker of proof.speakers) {
    if (!speaker || !/^\/Data\/RootChunk\/(?:actors|playerActors)\/\d+$/u.test(speaker.actorPointer || '')
        || !/^\/Data\/RootChunk\/screenplayStore\/lines\/\d+$/u.test(speaker.linePointer || '')) {
      fail(`${claim.id}: invalid native speaker pointers`);
    }
    const source = documentFor(speaker.sourceId), actor = jsonPointer(source, speaker.actorPointer);
    const line = jsonPointer(source, speaker.linePointer);
    const lineKey = JSON.stringify([speaker.sourceId, speaker.linePointer]);
    if (!narrativeLines.has(lineKey)) fail(`${claim.id}: attribution points outside the claim's narrative evidence`);
    attributedLines.add(lineKey);
    if (!['scnActorDef', 'scnPlayerActorDef'].includes(actor?.$type)
        || line?.$type !== 'scnscreenplayDialogLine' || !sameActorId(actor.actorId?.id, line.speaker?.id)) {
      fail(`${claim.id}: typed actor-to-screenplay speaker mismatch`);
    }
    if (strict) {
      for (const pointer of [speaker.actorPointer + '/actorName', speaker.actorPointer + '/actorId/id',
        speaker.actorPointer + '/voicetagId/id',
        speaker.linePointer + '/speaker/id', speaker.linePointer + '/itemId/id']) {
        if (!citedField(claim, speaker.sourceId, pointer)) fail(`${claim.id}: speaker join lacks exact recorded native field`);
      }
      const expectedVoice = speaker.expectedVoicetag ?? speaker.expectedSubjectVoicetag;
      if (expectedVoice === undefined || String(actor.voicetagId?.id ?? '') !== String(expectedVoice)) {
        fail(`${claim.id}: emitted speaker voice mismatch`);
      }
      if (reviewed?.emittedSpeech && ![...reviewed.actors, ...(reviewed.witnesses || [])].some(binding =>
        binding.name === nativeString(actor.actorName) && binding.voice === String(actor.voicetagId?.id)
        && binding.qualification.actorPointer === speaker.actorPointer
        && sourceReceiptMatches(pack, speaker.sourceId, binding.qualification))) {
        fail(`${claim.id}: unreviewed emitted actor receipt`);
      }
      exactEventPointer(claim, speaker, source, line);
      verifyEmittedEnglish(claim, speaker, source, line, pack, documentFor);
      checks++;
    }
    const subjectActor = speaker.frameActorPointer ? jsonPointer(source, speaker.frameActorPointer) : actor;
    if (speaker.frameActorPointer && !/^\/Data\/RootChunk\/(?:actors|playerActors)\/\d+$/u.test(speaker.frameActorPointer)) {
      fail(`${claim.id}: invalid represented-memory frame`);
    }
    const isSubject = kind === 'actor-record' ? speaker.sourceId === ownership.sourceId && speaker.actorPointer === ownership.actorPointer
      : actor.$type === 'scnActorDef' ? reviewedNamedSubject(actor, profile, ownership.qualified, speaker, pack)
      : representedSubject(actor, profile);
    const isFrame = subjectActor?.$type === 'scnPlayerActorDef' && representedSubject(subjectActor, profile);
    if (speaker.expectedSubjectRecord !== undefined
        && (kind === 'actor-record' ? subject.canonicalRecord : actorRecord(subjectActor)) !== speaker.expectedSubjectRecord
        || speaker.expectedSubjectVoicetag !== undefined
        && String(subjectActor?.voicetagId?.id) !== String(speaker.expectedSubjectVoicetag)) {
      fail(`${claim.id}: represented subject record or voice mismatch`);
    }
    self ||= isSubject; frame ||= isFrame;
    checks += speaker.frameActorPointer ? 3 : 2;
  }
  if ([...narrativeLines].some(key => !attributedLines.has(key))) fail(`${claim.id}: narrative evidence has an unattributed speaker`);
  if (proof.mode === 'self-report' && !self) fail(`${claim.id}: another character cannot become a self-report`);
  if (proof.mode === 'represented-memory' && (!frame || claim.kind === 'intrinsic')) {
    fail(`${claim.id}: unqualified subjective-memory frame`);
  }
  if (proof.mode === 'third-party-report' && !self
      && (!nonempty(proof.subjectConnection) || proof.subjectConnection.length > 2000)) {
    fail(`${claim.id}: missing attributed third-party subject connection`);
  }
  return {checks, mode: proof.mode, perspective: proof.perspective,
    ...(ownership.identity ? {identity: ownership.identity} : {})};
}

/** Source qualification runs only in the authoring compiler, never at chat time.
 * Tests inject byte fixtures; an explicitly adopted local build opens only the
 * allowlisted evidence paths and rejects missing/stale artifacts. */
export function compileIntrinsicCharacterPacks(values, {roster, root, loadArtifact, loadReviewedPropertyEvidence} = {}) {
  if (!Array.isArray(values) || values.length > LIMIT.packs || !Array.isArray(roster)) fail('Invalid compiler input');
  const known = new Map(roster.map(profile => [profile.key, profile]));
  const firstNames = new Map();
  for (const profile of roster) {
    const first = profile.name?.trim().split(/\s+/u)[0]?.toLocaleLowerCase('en-US');
    if (nonempty(first)) firstNames.set(first, (firstNames.get(first) || 0) + 1);
  }
  const load = loadArtifact ?? (root ? diskLoader(resolve(root)) : null);
  if (values.length && typeof load !== 'function') fail('Native artifact loader is required');
  const artifacts = new Map(), propertyArtifacts = new Map(), seen = new Set(), results = [];
  for (const input of values) {
    const pack = normalizeIntrinsicCharacterPack(input), profile = known.get(pack.key);
    if (!profile || seen.has(pack.key) || profile.kind === 'ambient'
        || (pack.name !== undefined && pack.name !== profile.name)
        || pack.claims.some(claim => claim.characterKey !== undefined && claim.characterKey !== pack.key)) {
      fail(`${pack.key}: mismatched or duplicate character`);
    }
    seen.add(pack.key);
    const sources = new Map(pack.sources.map(source => [source.id, source]));
    const selected = [], rejected = []; let size = 0, refsChecked = 0;
    const usedSources = new Map();
    function reviewedPropertyFor(receipt) {
      if (!propertyArtifacts.has(receipt.reviewId)) {
        const artifact = loadReviewedPropertyEvidence ? loadReviewedPropertyEvidence(receipt)
          : root ? reviewedPropertyDiskLoader(resolve(root), receipt) : null;
        propertyArtifacts.set(receipt.reviewId, verifyReviewedLivePropertyEvidence(receipt, artifact));
      }
      usedSources.set(`live:${receipt.reviewId}`, {id: receipt.reviewId, kind: 'live-read-only-TweakDB-property-probe',
        reviewSha256: receipt.reviewSha256, probeSha256: receipt.probeSha256,
        installedReceiptSha256: receipt.installedReceiptSha256, querySnapshotSha256: receipt.querySnapshotSha256,
        installedTweakdbFiles: receipt.installedTweakdbFiles.map(({name, bytes, sha256}) => ({name, bytes, sha256}))});
      return propertyArtifacts.get(receipt.reviewId);
    }
    function documentFor(sourceId) {
      const source = sources.get(sourceId);
      if (!source) fail(`${pack.key}: unknown attribution source`);
      const cacheKey = JSON.stringify([source.rawPath, source.jsonPath, source.assetSha256, source.jsonSha256]);
      if (!artifacts.has(cacheKey)) {
        const artifact = load(source);
        if (!artifact || !Buffer.isBuffer(artifact.raw) || !Buffer.isBuffer(artifact.jsonRaw)
            || artifact.raw.length > LIMIT.artifactBytes || artifact.jsonRaw.length > LIMIT.artifactBytes
            || hash(artifact.raw) !== source.assetSha256 || hash(artifact.jsonRaw) !== source.jsonSha256) {
          fail(`${pack.key}/${source.id}: recorded binary or JSON hash mismatch`);
        }
        const document = JSON.parse(artifact.jsonRaw.toString('utf8').replace(/^\uFEFF/u, ''));
        if (!nonempty(document?.Data?.RootChunk?.$type)) fail(`${source.id}: missing native root type`);
        artifacts.set(cacheKey, document);
      }
      const document = artifacts.get(cacheKey);
      const nativeVersions = pack.gameVersions.map(version => {
        const [major, minor, patch = 0] = version.split('.').map(Number);
        return major * 1000 + minor * 10 + patch;
      });
      if (document.Header?.WolvenKitVersion !== '9.0.1' || !nativeVersions.includes(document.Header?.GameVersion)) {
        fail(`${source.id}: native serializer or game version mismatch`);
      }
      usedSources.set(source.id, {id: source.id, assetSha256: source.assetSha256, jsonSha256: source.jsonSha256});
      return document;
    }
    for (const claim of pack.claims) {
      if (!publicClaim(claim)) { rejected.push({id: claim.id, reason: 'not-universal-public-topic'}); continue; }
      const limits = limitsFor(claim);
      const line = claim.text.trim() + (limits.length ? `\nScope: ${limits.join(' ')}` : '');
      if (selected.length >= LIMIT.publicClaims || size + line.length > LIMIT.publicChars) {
        rejected.push({id: claim.id, reason: 'bounded-context-limit'}); continue;
      }
      if (!Array.isArray(claim.nativeRefs) || !claim.nativeRefs.length || claim.nativeRefs.length > LIMIT.refs) {
        fail(`${pack.key}/${claim.id}: missing exact native references`);
      }
      for (const reference of claim.nativeRefs) {
        const source = sources.get(reference.sourceId);
        if (!source || typeof reference.jsonPointer !== 'string' || !reference.jsonPointer.startsWith('/Data/')) {
          fail(`${pack.key}/${claim.id}: unknown source or untyped pointer`);
        }
        for (const field of ['rawPath', 'jsonPath', 'assetSha256', 'jsonSha256']) {
          if (reference[field] !== undefined && reference[field] !== source[field]) fail(`${claim.id}: reference/source mismatch`);
        }
        const document = documentFor(source.id), pointed = jsonPointer(document, reference.jsonPointer);
        const type = typedContainer(document, reference.jsonPointer);
        if (reference.expectedType !== undefined && pointed?.$type !== reference.expectedType) fail(`${claim.id}: native type mismatch`);
        const expectedFields = ['expectedValue', 'expected'].filter(field => own(reference, field));
        if (!expectedFields.length && !own(reference, 'valueSha256')) fail(`${claim.id}: no recorded pointer expectation`);
        for (const field of expectedFields) {
          if (!isDeepStrictEqual(pointed, reference[field])) fail(`${claim.id}: exact native value mismatch`);
        }
        if (own(reference, 'valueSha256') && (reference.valueEncoding !== 'utf-8'
            || !SHA256.test(reference.valueSha256 || '') || typeof pointed !== 'string'
            || hash(Buffer.from(pointed, 'utf8')) !== reference.valueSha256)) fail(`${claim.id}: exact native value hash mismatch`);
        refsChecked++;
        usedSources.set(source.id, {id: source.id, assetSha256: source.assetSha256, jsonSha256: source.jsonSha256});
        if (!nonempty(type)) fail(`${claim.id}: untyped native reference`);
      }
      // Native scene actor names use a short name (Jackie, Johnny) where the
      // catalog has the full name. Permit it only when unique in this roster;
      // arbitrary same-named aliases cannot replace the independent codex ID.
      const first = profile.name.trim().split(/\s+/u)[0];
      const subjectProfile = {...profile, nativeSubjectNames: firstNames.get(first.toLocaleLowerCase('en-US')) === 1 ? [first] : [],
        nativeCanonicalRecords: [...new Set(roster.flatMap(item => item.records || []))]};
      const attribution = verifyIntrinsicAttribution(claim, pack, subjectProfile, documentFor, reviewedPropertyFor);
      refsChecked += attribution.checks;
      selected.push({id: claim.id, text: claim.text.trim(), kind: claim.kind, attribution,
        viewpoint: claim.qualification?.viewpoint ?? claim.qualification?.evidenceBasis, limits, rendered: line});
      size += line.length;
    }
    const eligibleIds = new Set(selected.map(claim => claim.id)), samples = [], sampleIds = new Set();
    for (const sample of pack.samples) {
      if (!sample.original || !ID.test(sample.id || '') || sampleIds.has(sample.id) || !nonempty(sample.text)
          || sample.text.length > 320 || !Array.isArray(sample.claimIds) || !sample.claimIds.length
          || sample.claimIds.length > 8 || sample.claimIds.some(id => !eligibleIds.has(id))) continue;
      const context = sample.context ?? sample.useWhen ?? '';
      if (/\b(?:trusted private|private conversation|after verified|completed (?:quest|scene)|trust[- ]earned)\b/iu.test(context)) continue;
      // Do not silently strip an authoring mistake: selected source samples must
      // already be plain original spoken utterances, not paired transcripts.
      assertPlainSampleDialogues(sample.text, profile);
      if (samples.length >= LIMIT.samples) break;
      sampleIds.add(sample.id); samples.push({id: sample.id, text: sample.text.trim(), claimIds: [...sample.claimIds]});
    }
    const result = freeze({key: pack.key, sourceContentSha256: pack.sourceContentSha256,
      claims: selected, samples, rejected, sources: [...usedSources.values()], referencesVerified: refsChecked,
      policy: [...usedSources.values()].some(source => source.kind === 'live-read-only-TweakDB-property-probe')
        ? 'recorded-native-and-reviewed-live-property-public-only' : 'recorded-binary-and-json-hash-typed-pointer-public-only'});
    compiledViews.add(result); results.push(result);
  }
  return Object.freeze(results);
}

export function intrinsicProfileMaterial(view) {
  if (!compiledViews.has(view)) fail('Unverified public intrinsic view');
  const heading = 'PUBLIC INTRINSIC TOPIC MATERIAL\nThese are background and personal perspectives, not proof that V met you, '
    + 'heard the source dialogue, read a codex entry or completed a quest. Use only the relevant detail, usually one or two sentences; '
    + 'leave room for conversation instead of reciting your biography. Keep recollections and opinions attributed. '
    + 'Current verified game facts override conflicting memories; missing context establishes no choice or disclosure.\n';
  return {backstory: view.claims.length ? heading + view.claims.map(claim => claim.rendered).join('\n\n') : '',
    samples: view.samples.map(sample => sample.text),
    revision: hash(JSON.stringify({key: view.key, claims: view.claims, samples: view.samples, sources: view.sources})),
    receipt: {key: view.key, claimIds: view.claims.map(claim => claim.id), sampleIds: view.samples.map(sample => sample.id),
      sourceContentSha256: view.sourceContentSha256, referencesVerified: view.referencesVerified, policy: view.policy}};
}

export function adoptedIntrinsicKeys(settings = {}, roster = []) {
  const keys = settings.nativeIntrinsicProfiles ?? [];
  if (!Array.isArray(keys) || keys.length > LIMIT.packs || new Set(keys).size !== keys.length
      || keys.some(key => typeof key !== 'string' || !KEY.test(key))) fail('Invalid persistent adoption configuration');
  const published = roster.filter(profile => own(profile, 'nativeIntrinsic')).map(profile => {
    if (!KEY.test(profile.key || '') || profile.nativeIntrinsic?.key !== profile.key
        || !Array.isArray(profile.nativeIntrinsic.claimIds) || !profile.nativeIntrinsic.claimIds.length
        || profile.nativeIntrinsic.claimIds.length > LIMIT.publicClaims
        || profile.nativeIntrinsic.claimIds.some(id => !ID.test(id || ''))
        || !Array.isArray(profile.nativeIntrinsic.sampleIds) || profile.nativeIntrinsic.sampleIds.length > LIMIT.samples
        || profile.nativeIntrinsic.sampleIds.some(id => !ID.test(id || ''))) {
      fail('Invalid published intrinsic adoption receipt');
    }
    return profile.key;
  });
  return [...new Set([...keys, ...published])].sort();
}

export function requireAdoptedIntrinsicPacks(keys, packs) {
  const available = new Set(packs.map(pack => normalizeIntrinsicCharacterPack(pack).key));
  for (const key of keys) if (!available.has(key)) fail(`${key}: adopted public history pack is missing; rebuild cannot silently remove it`);
}

export function requireAdoptedIntrinsicMaterial(keys, profiles, previous = []) {
  for (const key of keys) {
    const profile = profiles.find(profile => profile.key === key);
    if (!profile?.nativeIntrinsic?.claimIds?.length) {
      fail(`${key}: adopted public history has no qualified material; rebuild cannot silently remove it`);
    }
    const original = previous.find(profile => profile.key === key)?.nativeIntrinsic;
    for (const field of ['claimIds', 'sampleIds']) {
      for (const id of original?.[field] || []) {
        if (!profile.nativeIntrinsic[field]?.includes(id)) fail(`${key}: adopted ${field} would be removed; an explicit reviewed migration is required`);
      }
    }
  }
}
