// Save the SDK's indexed timeline, not one sample per browser poll. A batch
// can arrive before its audio or contain several frames between two polls.
export function drainBlendshapes(queue, target) {
  const count = queue.length;
  if (!count) return;
  const fps = queue.getPlaybackFps(), first = queue.getFramesConsumed();
  try {
    if (!Number.isFinite(fps) || fps < 1 || fps > 120 || !Number.isInteger(first) || first < 0) return;
    // A new SDK timeline owner replaces any already collected old owner.
    if (target.length && first / fps <= target.at(-1).at) target.length = 0;
    for (let index = 0; index < count && target.length < 14400; index++) {
      const at = (first + index) / fps, frame = queue.getFrame(index);
      if (at > 120) break;
      if (frame?.length === 61 && Array.from(frame).every(Number.isFinite)) {
        target.push({at, values: Array.from(frame)});
      }
    }
  } finally {
    // Facial data must never block completion of an otherwise valid voice.
    queue.consumeFrames(count);
  }
}
