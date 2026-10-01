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
// Reviewed against the installed 2.31 typed codex titles and source-hashed
// native actor/speaker joins. These entries are a qualification ledger, not a
// filename, last-name or suffix heuristic. Proposals remain unadopted.
export const REVIEWED_INTRINSIC_SUBJECT_BINDINGS = freeze({
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

function diskLoader(root) {
  function bytes(name) {
    if (!safeSourcePath(name)) fail('Uncontained source path');
    const target = realpathSync(resolve(root, name));
    const inside = relative(root, target).replaceAll('\\', '/');
    if (!safeSourcePath(inside)) fail('Source junction escapes the evidence roots');
    const info = statSync(target);
    if (!info.isFile() || info.size > LIMIT.artifactBytes) fail('Native artifact size limit');
    return readFileSync(target);
  }
  return source => ({raw: bytes(source.rawPath), jsonRaw: bytes(source.jsonPath)});
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
function verifyReviewedSubjectOwnership(claim, proof, subject, entry, profile, documentFor) {
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
    const titlePointer = subject.jsonPointer.slice(0, -3) + '/title/value';
    const titleKey = /^LocKey#(\d+)$/u.exec(entry.title?.value);
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
        if (reviewed.titles.includes(value)) matched = true;
      }
    }
    // Explicitly supplied wrong title evidence cannot be rescued by a separate
    // record reference: contradictory ownership data must reject the proposal.
    if (!matched) fail(`${claim.id}: reviewed native subject title mismatch`);
    return {qualified: true, checks: 3};
  }
  if (recordRefs !== undefined) {
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
function reviewedNamedSubject(actor, profile, ownership) {
  const reviewed = reviewedSubject(profile.key);
  if (!reviewed) return namedSubject(actor, profile);
  return ownership && reviewed.actors.some(binding => nativeString(actor.actorName) === binding.name
    && String(actor.voicetagId?.id ?? '') === binding.voice);
}
function representedSubject(actor, profile) {
  const record = actorRecord(actor), voice = String(actor.voicetagId?.id ?? '');
  return playerSubjectBindings.get(profile.key)?.some(binding => binding.record === record
    && binding.playerName === actor.playerName && binding.voice === voice) === true;
}

function verifyAttribution(claim, pack, profile, documentFor) {
  const proof = claim.attribution;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.characterKey !== pack.key
      || !['native-codex', 'self-report', 'third-party-report', 'represented-memory'].includes(proof.mode)
      || !nonempty(proof.perspective) || proof.perspective.length > 1600
      || !Array.isArray(proof.speakers) || proof.speakers.length > 128) fail(`${claim.id}: missing claim-scoped subject attribution`);
  const subject = proof.subjectRef;
  if (!subject || typeof subject.jsonPointer !== 'string' || !subject.jsonPointer.endsWith('/id')) {
    fail(`${claim.id}: missing typed subject binding`);
  }
  const document = documentFor(subject.sourceId), actual = jsonPointer(document, subject.jsonPointer);
  const entry = jsonPointer(document, subject.jsonPointer.slice(0, -3));
  const expectedSubjectId = reviewedSubject(pack.key)?.id ?? pack.key.replaceAll('-', '_');
  if (entry?.$type !== 'gameJournalCodexEntry' || actual !== expectedSubjectId
      || (subject.expected !== undefined && actual !== subject.expected)
      || (subject.containerType !== undefined && subject.containerType !== entry.$type)) {
    fail(`${claim.id}: native subject identity mismatch`);
  }
  const ownership = verifyReviewedSubjectOwnership(claim, proof, subject, entry, profile, documentFor);
  const narrativeLines = new Set(claim.nativeRefs.flatMap(reference => {
    const match = /^(\/Data\/RootChunk\/screenplayStore\/lines\/\d+)(?:\/|$)/u.exec(reference.jsonPointer);
    return match ? [JSON.stringify([reference.sourceId, match[1]])] : [];
  }));
  if (proof.mode === 'native-codex') {
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
    const subjectActor = speaker.frameActorPointer ? jsonPointer(source, speaker.frameActorPointer) : actor;
    if (speaker.frameActorPointer && !/^\/Data\/RootChunk\/(?:actors|playerActors)\/\d+$/u.test(speaker.frameActorPointer)) {
      fail(`${claim.id}: invalid represented-memory frame`);
    }
    const isSubject = actor.$type === 'scnActorDef' ? reviewedNamedSubject(actor, profile, ownership.qualified)
      : representedSubject(actor, profile);
    const isFrame = subjectActor?.$type === 'scnPlayerActorDef' && representedSubject(subjectActor, profile);
    if (speaker.expectedSubjectRecord !== undefined
        && actorRecord(subjectActor) !== speaker.expectedSubjectRecord
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
  return {checks, mode: proof.mode, perspective: proof.perspective};
}

/** Source qualification runs only in the authoring compiler, never at chat time.
 * Tests inject byte fixtures; an explicitly adopted local build opens only the
 * allowlisted evidence paths and rejects missing/stale artifacts. */
export function compileIntrinsicCharacterPacks(values, {roster, root, loadArtifact} = {}) {
  if (!Array.isArray(values) || values.length > LIMIT.packs || !Array.isArray(roster)) fail('Invalid compiler input');
  const known = new Map(roster.map(profile => [profile.key, profile]));
  const firstNames = new Map();
  for (const profile of roster) {
    const first = profile.name?.trim().split(/\s+/u)[0]?.toLocaleLowerCase('en-US');
    if (nonempty(first)) firstNames.set(first, (firstNames.get(first) || 0) + 1);
  }
  const load = loadArtifact ?? (root ? diskLoader(resolve(root)) : null);
  if (values.length && typeof load !== 'function') fail('Native artifact loader is required');
  const artifacts = new Map(), seen = new Set(), results = [];
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
      const subjectProfile = {...profile, nativeSubjectNames: firstNames.get(first.toLocaleLowerCase('en-US')) === 1 ? [first] : []};
      const attribution = verifyAttribution(claim, pack, subjectProfile, documentFor);
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
      policy: 'recorded-binary-and-json-hash-typed-pointer-public-only'});
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
