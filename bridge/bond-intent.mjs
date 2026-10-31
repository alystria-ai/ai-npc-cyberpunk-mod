// How V answers a story pack's stage, read from V's own words (docs/RELATIONSHIPS_AND_QUESTS.md, 7.3): no model is asked and nothing is added to a reply.
// A few regular expressions per language over a short line, run after the reply is published. The kinds are the closed list of bridge/bond-packs.mjs CHOICE_KINDS:
//   yes      V agrees, offers, says they will come or help         no       V declines, cannot, calls it off
//   honest   V says something of substance (an opinion)             flatter  V only pays a short compliment or is vaguely nice
// A screen, not a judge: it has to be right about plain answers; a line it cannot place gives no kind and the stage simply waits (its timer still ends it).
// The languages are the ones the game's menus are translated into (en de fr es it pt pl ru uk tr cs hu ja ko zh). Latin and Cyrillic stems start at a word start;
// Japanese, Korean and Chinese are not written with spaces, so those match anywhere.
import {screenMeet} from './meet-requests.mjs';
import {MIC_PLACEHOLDER} from './call-meet.mjs';

const B = String.raw`(?<![\p{L}\p{N}])`;
const YES = {
  words: String.raw`yes|yeah|yep|yup|sure|ok(?:ay)?|alright|all right|will do|deal|on it|got it|you bet|of course|absolutely|definitely|happy to|glad to|count me in|`
    + String.raw`i'?ll (?:come|be there|be right there|help|go|do it|take it|get it|bring|pay|handle|see)|i'?m (?:in|on my way|coming|there)|i can help|let'?s (?:go|do|get|take)|sounds good|you(?:'re| are) on(?![\p{L}])(?!\s+(?:the|a|an|my|your|his|her|their|our|this|that|it)(?![\p{L}]))|i'?m game|game on|challenge accepted|it'?s a deal|you got a deal|i'?ll take (?:that|the|your) (?:bet|dare|deal|offer)|`
    + String.raw`ja(?![\p{L}])|klar|gerne|mach ich|ich komme|bin dabei|abgemacht|nat[uü]rlich|`
    + String.raw`oui|d'accord|bien s[uû]r|je viens|j'arrive|compte sur moi|volontiers|avec plaisir|`
    + String.raw`s[ií](?![\p{L}])|claro|vale|de acuerdo|voy|cuenta conmigo|por supuesto|con gusto|ahora voy|`
    + String.raw`certo|va bene|arrivo|ci sto|contaci|volentieri|`
    + String.raw`sim(?![\p{L}])|t[aá] bom|combinado|vou(?![\p{L}])|conta comigo|com certeza|com prazer|`
    + String.raw`tak(?![\p{L}])|jasne|dobra|okej|zgoda|id[eę]|przyjd[eę]|pomog[eę]|ch[eę]tnie|`
    + String.raw`да(?![\p{L}])|конечно|ладно|хорошо|договорились|иду|приду|помогу|с радостью|согласен|`
    + String.raw`так(?![\p{L}])|звісно|добре|домовились|іду|прийду|допоможу|залюбки|згоден|`
    + String.raw`evet|tamam|olur|tabii|geliyorum|geleyim|yard[ıi]m ederim|anla[sş]t[ıi]k|`
    + String.raw`ano(?![\p{L}])|jasn[eě]|dob[rř]e|souhlas[ií]m|jdu(?![\p{L}])|p[rř]ijdu|pomohu|r[aá]d(?![\p{L}])|`
    + String.raw`igen|persze|rendben|ok[eé]|megyek|j[oö]v[oö]k|seg[ií]tek|sz[ií]vesen|`,
  spaceless: 'はい|うん|わかった|了解|いいよ|行く|行くよ|任せて|手伝う|もちろん|응|네(?![가-힣])|예(?![가-힣])|좋아|알았어|갈게|도와줄게|물론|그래|好的|好啊|可以|没问题|我来|我去|一定|当然|帮你|我帮',
};
const NO = {
  words: String.raw`no(?![\p{L}])|nope|nah|can'?t|cannot|won'?t|not (?:now|tonight|today|this time|interested|my problem|my business)|no way|never ?mind|nvm|forget it|pass(?![\p{L}])|`
    + String.raw`i'?m busy|you'?re on your own|handle it yourself|figure it out|deal with it|not going to|don'?t (?:have time|want to|feel like)|sorry,? (?:but |i )|`
    + String.raw`nein|kann nicht|keine zeit|vergiss es|nicht jetzt|ohne mich|`
    + String.raw`non(?![\p{L}])|je ne peux pas|pas question|pas maintenant|laisse tomber|pas le temps|`
    + String.raw`no puedo|ahora no|ni hablar|d[eé]jalo|no tengo tiempo|`
    + String.raw`non posso|adesso no|non ho tempo|lascia perdere|`
    + String.raw`n[aã]o(?![\p{L}])|n[aã]o posso|agora n[aã]o|sem tempo|esquece|`
    + String.raw`nie(?![\p{L}])|nie mog[eę]|nie teraz|nie mam czasu|zapomnij|`
    + String.raw`нет|не могу|не сейчас|некогда|забудь|отстань|сам разбирайся|`
    + String.raw`ні(?![\p{L}])|не можу|не зараз|нема часу|забудь|`
    + String.raw`hay[ıi]r|yapamam|[sş]imdi de[gğ]il|vaktim yok|bo[sş] ver|`
    + String.raw`ne(?![\p{L}])|nemohu|te[dď] ne|nem[aá]m [cč]as|zapome[nň]|`
    + String.raw`nem(?![\p{L}])|nem tudok|most nem|nincs id[oö]m|felejtsd el|`,
  spaceless: 'いいえ|いや|無理|できない|行けない|やめて|忘れて|아니|안 돼|못 해|못 가|바빠|不行|不要|不能|没空|不去|算了|别',
};
const PRAISE = {
  words: String.raw`great|good|nice|beautiful|gorgeous|amazing|perfect|stunning|lovely|pretty|hot|fine|wow|love it|looks? (?:great|good|amazing|fine|nice)|you look|`
    + String.raw`sch[oö]n|toll|super|wundervoll|hinrei[sß]end|magnifique|superbe|joli|belle|parfait|`
    + String.raw`hermoso|hermosa|guapa|perfecto|precioso|incre[ií]ble|bellissim|bello|bella|splendid|lind[oa]|maravilhos|linda|`
    + String.raw`pi[eę]kn|[sś]wietn|cudown|прекрасн|красив|отличн|шикарн|чудов|гарн|чудесн|g[uü]zel|harika|muhte[sş]em|kr[aá]sn|skv[eě]l|nádhern|sz[eé]p|gy[oö]ny[oö]r|csod[aá]s|`,
  spaceless: '綺麗|きれい|素敵|かわいい|似合|すごい|예쁘|멋있|멋져|좋아 보|漂亮|好看|很美|真好|很棒',
};
const compile = ({words, spaceless}) => [new RegExp(`${B}(?:${words.replace(/\|$/, '')})`, 'iu'), new RegExp(spaceless, 'u')];
const patterns = {yes: compile(YES), no: compile(NO), praise: compile(PRAISE)};
const has = (name, text) => patterns[name][0].test(text) || patterns[name][1].test(text);
const normal = value => String(value ?? '').slice(0, 600).replace(/[‘’‛ʼ`´]/g, "'");
/** Words (Latin/Cyrillic runs) of a line, or for spaceless scripts one per character. */
const countWords = text => {
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  const wide = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  return words.length + Math.floor(wide / 2);
};

/**
 * What V's line says: {yes, no, honest, flatter} (booleans; at most one of yes/no is true, and none for an empty line or a recording placeholder).
 * "no" wins over "yes" ("sure, but I can't"): a refusal anywhere in the line is a refusal, and so is calling a meeting off.
 */
export function screenIntent(text) {
  const value = normal(text).trim();
  const none = {yes: false, no: false, honest: false, flatter: false};
  if (!value || value === MIC_PLACEHOLDER) return none;
  const meet = screenMeet(value);
  const no = has('no', value) || meet.cancel;
  const yes = !no && (has('yes', value) || (meet.kind === 'here' || meet.kind === 'waypoint'));
  const words = countWords(value), praise = has('praise', value);
  // A short compliment, or a line that is only polite and short, is flattery; anything with more to say is an opinion.
  const flatter = !no && words > 0 && words <= 4 && (praise || has('yes', value));
  const honest = !flatter && words >= 3;
  return {yes, no, honest, flatter};
}

/** The kind of a line among the kinds a stage offers: 'yes' | 'no' | 'honest' | 'flatter' or null. A refusal beats the rest; then yes; then honest; then flatter. */
export function intentKind(text, offered) {
  const screen = screenIntent(text);
  for (const kind of ['no', 'yes', 'honest', 'flatter']) if (screen[kind] && offered.includes(kind)) return kind;
  // "yes" to a stage that offers only an opinion, or an opinion to a yes/no stage, is not an answer to it.
  return null;
}

// Giving a quest up, in V's own words (owner decision 1 Nov 2026: a quest has no time limit, so V closes it by doing it, or by saying it is off). Stricter than a plain "no": a
// stage's own `no` answer is read first, and this only reads a line that says the whole thing is off. It is a screen over plain, explicit phrases and never a judge.
const ABANDON = {
  words: String.raw`(?:i )?(?:abandon|drop|cancel|scrap|call off) (?:it|this|that|the (?:quest|job|whole thing|plan|dinner|deal))|call it off|forget (?:it|this|that|the (?:quest|job|whole thing))|`
    + String.raw`never ?mind (?:about )?(?:it|this|that|the (?:quest|job|whole thing))|i give up|i'?m (?:not (?:doing|going to do) (?:this|it|that)|no longer interested|out of this)|count me out|`
    + String.raw`i'?m (?:dropping|leaving) (?:it|this)|let'?s (?:drop|forget) (?:it|this)|`
    + String.raw`vergiss es|lassen wir das|ich lass das|ich gebe auf|ich bin raus|vergiss das|`
    + String.raw`laisse tomber|oublie (?:[çc]a|tout)|j'abandonne|annule (?:tout|[çc]a)|on laisse tomber|`
    + String.raw`olv[ií]dalo|d[eé]jalo|lo dejo|me rindo|cancela(?:lo| esto)|d[eé]jalo estar|`
    + String.raw`lascia (?:perdere|stare)|rinuncio|annulla (?:tutto|questo)|lasciamo perdere|`
    + String.raw`esquece|deixa pra l[aá]|desisto|cancela (?:isso|tudo)|`
    + String.raw`zapomnij o tym|odpu[sś][cć]|rezygnuj[eę]|anuluj to|`
    + String.raw`забудь|забей|я сдаюсь|отказываюсь|отмена задания|`
    + String.raw`облиш|здаюся|скасуй це|забудь про це|`
    + String.raw`bo[sş]ver|vazge[cç]tim|bunu b[ıi]rak|iptal et|`
    + String.raw`zapome[nň] na to|nech to b[yý]t|vzd[aá]v[aá]m se|zru[sš] to|`
    + String.raw`felejtsd el|hagyd (?:az eg[eé]szet|[eé]ppen)|feladom|t[oö]r[oö]ld az eg[eé]szet|`,
  spaceless: 'やめる|やめた|やめておく|あきらめる|諦める|キャンセル|もういい|忘れて|그만할게|포기할게|포기|취소할게|잊어버려|算了|放弃|不做了|取消吧|别管了|不干了'
};
const ABANDON_RE = {
  words: new RegExp(`${B}(?:${ABANDON.words.replace(/\|$/, '')})(?![\\p{L}\\p{N}])`, 'iu'),
  spaceless: new RegExp(`(?:${ABANDON.spaceless})`, 'u')
};

/** Whether V's line says the quest is off: an explicit phrase ("forget it", "I give up", "cancel the quest", "vergiss es"), nothing vague. False for an empty line or a recording placeholder. */
export function screenAbandon(text) {
  const value = normal(text).trim();
  if (!value || value === MIC_PLACEHOLDER || value.length > 400) return false;
  return ABANDON_RE.words.test(value) || ABANDON_RE.spaceless.test(value);
}
