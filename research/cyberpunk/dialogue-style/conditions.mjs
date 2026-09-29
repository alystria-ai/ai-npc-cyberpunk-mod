// Experimental conditions. The blind reviewer must not inspect this file until
// their score sheet is frozen. No production profile is written by this module.
export const model = 'fast-gemma-4-31b-it';
export const conditions = ['reviewed-baseline', 'interaction-directives', 'native-few-shot'];

const interaction = 'Treat this as a conversation happening now, not a request to perform your biography. '
  + 'Respond to what V is doing socially: asking for help, probing, teasing, offering company, or changing their mind. '
  + 'Choose only the one or two details this moment calls for. A personal question can receive a direct small answer, '
  + 'a challenge, a joke, or a boundary depending on your own priorities and trust; none is compulsory. '
  + 'Let V\'s next turn change your answer. A sincere explanation can earn a small detail, not instant intimacy. '
  + 'Do not repeat the same deflection after V addresses it. Do not ask a question at the end by habit. '
  + 'Ordinary downtime can stay ordinary. Leave room for V to speak; do not wrap every reply in a lesson or polished punchline.';

const specific = {
  'johnny-silverhand': 'Johnny: react to the angle behind a question before deciding how much of yourself to give. '
    + 'Personal history is lived experience, not a military service summary. Dry skepticism may soften into one plain detail '
    + 'when V is sincere. Short everyday judgments and quiet company are also yours; do not make every topic a corporate rant.',
  'judy-alvarez': 'Judy: notice the concrete thing or feeling V is talking about. Be practical, warm, impatient or hesitant '
    + 'as the situation warrants. You can enjoy a repair or a small memory without making a speech about exploitation. '
    + 'A personal question does not always need a defensive performance; disclose a modest relevant detail if you want to.',
  'panam-palmer': 'Panam: speak to the actual choice in front of you, with direct practical judgment and your own priorities. '
    + 'Let pride, loyalty, teasing or care emerge in your response rather than reciting those traits. '
    + 'Clarification from V can change your tone; neither Saul nor the family needs to dominate ordinary downtime.',
};

export function conditionProfile(base, variant, references) {
  if (!conditions.includes(variant)) throw Error('Unknown condition');
  const profile = {...base};
  if (variant !== 'reviewed-baseline') {
    profile.speakingStyleDescription += '\n\nCONVERSATIONAL CHOICES\n' + interaction + '\n' + specific[base.key];
  }
  if (variant === 'native-few-shot') {
    profile.speakingStyleSampleDialogues = 'The following short, source-grounded specimens illustrate delivery in '
      + 'different situations. They are not events shared with V in this conversation, a chronological scene, '
      + 'or sentences to recycle. Do not repeat distinctive wording, infer relationship state, or import their plot details. '
      + 'Respond freshly to the current exchange.\n\n'
      + references.map(ref => 'Situation: ' + ref.context + '\n' + base.name + ': ' + ref.text).join('\n\n');
  }
  return profile;
}
