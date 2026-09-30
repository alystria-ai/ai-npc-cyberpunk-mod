// Convai's speaking_style_sample_dialogues contains examples of the character's
// spoken words. Transcript speaker labels can be copied into generated speech.
// Keep paired research examples intact on disk, but send only their responses.
const shortLabels = {'dexter-deshawn': ['Dex']};
const genericLabels = ['V', 'User', 'Player', 'Character', 'Assistant', 'NPC'];
const normalizedLabel = value => value.trim().toLocaleLowerCase('en-US');

function speakerLabels(profile) {
  const names = [profile.name, ...(profile.aliases || []), ...(shortLabels[profile.key] || [])]
    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
  // The authored research also uses first/last-name labels (Judy, Jenkins).
  return new Set([...names, ...names.flatMap(name => name.split(/\s+/))].map(normalizedLabel));
}

function labelAtStart(value) {
  const match = /^([^:\r\n]{1,80}):[ \t]*(.*)$/u.exec(value);
  return match && {label: match[1], words: match[2]};
}

export function characterSampleUtterance(sample, profile) {
  let value = typeof sample === 'string' ? sample : sample?.character;
  if (typeof value !== 'string' || !value.trim()) throw Error(`Empty dialogue example: ${profile.key}`);
  value = value.trim();
  const names = speakerLabels(profile);
  if (/^V:[ \t]/iu.test(value)) {
    const lines = value.split(/\r?\n/u);
    const response = lines.length === 2 && labelAtStart(lines[1]);
    if (!response || !names.has(normalizedLabel(response.label))) {
      throw Error(`Unrecognized paired dialogue example: ${profile.key}`);
    }
    value = response.words.trim();
  } else {
    const prefix = labelAtStart(value);
    if (prefix && names.has(normalizedLabel(prefix.label))) value = prefix.words.trim();
  }
  assertPlainSampleDialogues(value, profile);
  return value;
}

export function assertPlainSampleDialogues(value, profile) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`Empty dialogue examples: ${profile.key}`);
  const labels = new Set([...speakerLabels(profile), ...genericLabels.map(normalizedLabel)]);
  for (const utterance of value.split(/\n\s*\n/u)) {
    const prefix = labelAtStart(utterance.trim());
    if (!utterance.trim() || /[\r\n]/u.test(utterance.trim()) || (prefix && labels.has(normalizedLabel(prefix.label)))) {
      throw Error(`Dialogue examples must contain spoken words without speaker labels: ${profile.key}`);
    }
  }
}

export function serializeCharacterSamples(samples, profile) {
  if (!Array.isArray(samples) || !samples.length) throw Error(`Missing dialogue examples: ${profile.key}`);
  return samples.map(sample => characterSampleUtterance(sample, profile)).join('\n\n');
}
