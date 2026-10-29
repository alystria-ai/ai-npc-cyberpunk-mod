// "Companions can see" for the text providers (Mistral, Local AI, Custom): how a picture goes into a chat-completions request (docs/COMPANION_VISION.md, "Text providers").
// Pure functions, no I/O.
//
// The picture is an OpenAI-style `image_url` part of the LAST user message and nowhere else. Everything before that message (the persona, the memory, the earlier turns)
// stays plain text and byte for byte what it is without a picture, so a provider's prompt cache (llama-server's slot, Mistral's `prompt_cache_key`) is reused as it was:
// the last user message already differs on every turn (the live context, V's words), so nothing that could be reused sits after the picture.

/** The picture a text turn carries: 768 px wide at JPEG quality 80 (about 45 KB), taken by the helper (bridge/vision-capture.mjs). Convai's is 1024 px at 88. */
export const TEXT_PICTURE = Object.freeze({maxWidth: 768, quality: 80});

/** What the model is told about the picture, in the same message as V's words (Convai gets the same facts in its context update, bridge/convai-vision.mjs). */
export const VISION_NOTE = '[PICTURE: what V can see around V right now, taken from the game window a few seconds ago. It may show V\'s vehicle, the interface or you. '
  + 'Mention what you see only when it fits what V says or asks. Never describe the interface. If the picture is dark or unclear, say so instead of guessing. '
  + 'Whether V is indoors or outdoors comes from the text below when it says so, never from the name of a district.]';

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
