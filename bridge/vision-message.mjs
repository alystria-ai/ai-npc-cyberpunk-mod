// "Companions can see" for the text providers (Mistral, Local AI, Custom): how a picture goes into a chat-completions request (docs/COMPANION_VISION.md, "Text providers").
// Pure functions, no I/O.
//
// The picture is an OpenAI-style `image_url` part of the LAST user message and nowhere else. Everything before that message (the persona, the memory, the earlier turns)
// stays plain text and byte for byte what it is without a picture, so a provider's prompt cache (llama-server's slot, Mistral's `prompt_cache_key`) is reused as it was:
// the last user message already differs on every turn (the live context, V's words), so nothing that could be reused sits after the picture.

/** The picture a text turn carries: 768 px wide at JPEG quality 80 (about 45 KB), taken by the helper (bridge/vision-capture.mjs). Convai's is 1024 px at 88. */
export const TEXT_PICTURE = Object.freeze({maxWidth: 768, quality: 80});

/**
 * What the model is told about the picture, in the same message as V's words. Framed as the character's own view (2026-10-30, docs/NATURAL_TALK_RESEARCH_2026-10-30.md): the
 * old note called it a picture "from the game window" that "may show the interface", and with the HUD in it a model read it as V "staring at a screen", narrated the neon in
 * every reply and nagged V about the quest notice it showed. Measured on Gemini Flash-Lite: the framing alone did not stop that (the cut and the gate below did), but it
 * keeps a picture that is sent from being talked about as a picture. No word here names a screen, an image or an interface.
 */
export const VISION_NOTE = '[What you see around you right now, with your own eyes. It is there so you know where you are: bring up something in view only when V asks about it '
  + 'or it truly matters to what V just said. Words and symbols floating over the view are not part of the place. Whether you are indoors or outdoors comes from the text below '
  + 'when it says so. If it is too dark to tell, say so instead of guessing.]';

// "Companions can see" sends the view only when V's words are about what is around them (2026-10-30). Sent with every turn, the view became the topic of every turn: in the
// owner's live test and in scripts/Eval-NaturalTalk.mjs a companion answered "how is biz" and "so hows life" with remarks about the neon, the screen and the message V had
// not read. With it only on these turns the replies answered V again, and a question about the place still got its answer from what she sees. A stem of a few common
// languages is listed as well; a turn without any of them goes without the picture (the text of the turn still says where V is).
const VIEW_WORDS = new RegExp([
  String.raw`\b(?:look|looking|looks|see|seeing|saw|seen|view|watch|notice[ds]?|check (?:this|that|it|them) out)\b`,
  String.raw`\b(?:this|that|the) (?:place|spot|bar|club|room|street|view|building|car|ride|bike|crowd|sign|billboard|guy|girl|man|woman|kid|person|thing|stuff)\b`,
  String.raw`\b(?:around (?:here|us|you)|in here|out here|over there|out there|outside|surroundings|where (?:are|were) we|where is this|what is (?:this|that)|what's (?:this|that)|who is (?:this|that)|who's (?:this|that))\b`,
  String.raw`\b(?:weather|rain(?:ing)?|sky|sunset|sunrise|neon|lights)\b`,
  // es, pt, fr, de, it, ru, pl, ja, zh, ko (the seeing verbs and "this place" / "here")
  String.raw`\b(?:mira|miras|ves|lugar|aqui|olha|v[eê]s|regarde|vois|endroit|schau|siehst|sieh|guarda|vedi|posto|smotri)\b`,
  'aquí|смотри|видишь|место|здесь|patrz|widzisz|miejsce|見て|見える|ここ|景色|看|这里|這裡|봐|보여|여기',
].join('|'), 'iu');
// V about V's own look ("like what you see?"), a goodbye ("see you later") or a greeting ("long time no see") is not about the surroundings.
// Nor is a compliment ("you look good"): her look is her own, not something in view.
const NOT_VIEW = /\b(?:like|love|enjoy)(?:s|d)? what (?:you|ya) see\b|\bsee (?:you|ya)\b|\bno see\b|\bi see\b|\blet'?s see\b|\b(?:you|ya|u) look\b|\blook(?:s|ing)? (?:good|great|nice|fine|beautiful|pretty|hot|amazing|tired|sad|happy|well|forward|after|for)\b|\bhow (?:do|does) (?:i|this|it) look\b/giu;
/** True when V's words are about what is around them, so the turn takes the companion's view with it. */
export function pictureForTurn({text} = {}) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return VIEW_WORDS.test(text.replace(NOT_VIEW, ' '));
}

const dataUrl = image => `data:${image.mime};base64,${image.base64}`;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The pictures that can go in a request: {mime, base64} with an image type and some data, at most `limit`. */
export function usableImages(images, limit = 4) {
  if (!Array.isArray(images)) return [];
  return images.filter(image => image && IMAGE_TYPES.has(image.mime) && typeof image.base64 === 'string' && image.base64.length > 0).slice(0, limit);
}

/**
 * `messages` with the pictures in the last user message: its content becomes the image parts followed by one text part (the note, then the text it had). The array is a copy,
 * the other messages are the very same objects, and with no usable picture (or no user message) `messages` itself is returned.
 */
export function withImages(messages, images) {
  const pictures = usableImages(images);
  if (!pictures.length || !Array.isArray(messages)) return messages;
  let at = messages.length - 1;
  while (at >= 0 && messages[at]?.role !== 'user') at--;
  if (at < 0 || typeof messages[at].content !== 'string') return messages;
  const copy = messages.slice();
  copy[at] = {...messages[at], content: [...pictures.map(image => ({type: 'image_url', image_url: {url: dataUrl(image)}})),
    {type: 'text', text: `${VISION_NOTE}\n\n${messages[at].content}`}]};
  return copy;
}

// What a server says when it will not take a picture: an OpenAI-style 400 that names images, vision or multimodal input, or says the message content must be a string.
const IMAGE_WORDS = /\bimage(?:_url|s)?\b|\bvision\b|multi-?modal|modalit|visual input|content (?:must|should|has to) be (?:a )?(?:string|text)|valid string|expected (?:a )?string|unsupported (?:content|part|type)|unknown variant/i;
const REFUSING_STATUS = new Set([400, 404, 413, 415, 422]);

/** Is this answer a server refusing a request because it carried a picture? Only when the request had one, only for the statuses a refusal uses, and only when the words say so. */
export function isImageRefusal(status, text) {
  return REFUSING_STATUS.has(Number(status)) && IMAGE_WORDS.test(String(text ?? ''));
}
