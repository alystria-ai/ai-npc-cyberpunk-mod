// "Companions can see" with Local AI (docs/COMPANION_VISION.md, docs/LOCAL_AI.md "Pictures"): the numbers both sides share. Pure constants and arithmetic, no I/O.
//
// A picture reaches the local model through llama-server's multimodal support: the model is started with `--mmproj <projector file>` and the chat request carries
// the picture as an OpenAI-style `image_url` part of the LAST user message (bridge/vision-message.mjs). The projector is loaded only while the setting is on and
// the model has one; when the setting goes off the server is restarted without it, with the old server's exit confirmed (bridge/local-llm-server.mjs).

export const LOCAL_VISION = Object.freeze({
  // The picture a local turn carries: 768 px wide JPEG at quality 80 (the helper scales and encodes it, bridge/vision-capture.mjs). Convai gets 1024 px at 88.
  maxWidth: 768, quality: 80,
  // `--image-max-tokens`: the most tokens one picture may cost a model with dynamic resolution (Gemma 4, Qwen VL). A model with a fixed size (Gemma 3: 256) ignores it.
  imageMaxTokens: 320,
  // What one picture takes out of the prompt budget (bridge/prompt-budget.mjs): the image tokens plus the markers around them. The prompt is fitted to the context less this.
  imageReserveTokens: 400,
  // Graphics memory the projector takes beyond its file: the compute buffer of the image encoder (an estimate, not measured: the projector files are not on the development machine).
  computeHeadroomMiB: 384,
});

/** The graphics memory (MiB) a projector file of `fileMiB` takes while the model runs with it: the weights (about the file size) plus the encoder's compute buffer. */
export const projectorNeedMiB = fileMiB => (Number(fileMiB) > 0 ? Math.ceil(Number(fileMiB)) + LOCAL_VISION.computeHeadroomMiB : 0);

/** The tokens to keep free in the prompt for `count` pictures. */
export const imageReserveTokens = count => Math.max(0, Math.floor(Number(count) || 0)) * LOCAL_VISION.imageReserveTokens;
