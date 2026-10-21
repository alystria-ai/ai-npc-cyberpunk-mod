// The mouth-shape cue list some facial paths accept (letters A-H and X on one continuous timeline over the audio): checked here before it
// shapes a face. The local lip-sync model and the resident phone analyser are the production sources; a cue list that is malformed or does not
// cover the audio is refused, and the line plays on its audio envelope.
export function validateMouthCues(document, duration) {
  const cues = document?.mouthCues;
  if (!Number.isFinite(document?.metadata?.duration) || Math.abs(document.metadata.duration - duration) > 0.03
      || !Array.isArray(cues) || !cues.length || cues.length > 4000) throw Error('Invalid phonetic timeline');
  let end = 0;
  for (const cue of cues) {
    if (!Number.isFinite(cue?.start) || !Number.isFinite(cue.end) || cue.start < 0
        || Math.abs(cue.start - end) > 0.001 || cue.end <= cue.start || cue.end > duration + 0.03
        || !/^[A-HX]$/.test(cue.value)) throw Error('Invalid phonetic cue');
    end = cue.end;
  }
  if (Math.abs(end - duration) > 0.03) throw Error('Incomplete phonetic timeline');
  return cues.map(cue => ({...cue, end: Math.min(duration, cue.end)}));
}
