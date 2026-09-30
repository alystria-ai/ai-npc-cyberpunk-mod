// Opt in only with a real Boolean. Older adapters and malformed settings retain
// the default Off without discarding the player's otherwise valid message.
export const followUpsEnabled = value => value === true;

export function followUpContext(input) {
  if (input.reaction) return 'This is an automatic reaction. Do not ask V a question, including rhetorical or follow-up questions.';
  if (input.group && input.group.index !== input.group.total) {
    return 'Another companion speaks after you. Do not ask V a question or try to restart the exchange.';
  }
  if (!followUpsEnabled(input.followUpQuestions)) {
    return 'Follow-up questions are disabled for this turn. Answer V in character without adding a question or invitation just to keep the conversation going. '
      + 'Ask only when clarification is necessary or V explicitly requests a question. Do not mention this setting.';
  }
  return 'Follow-up questions are enabled for this turn. After answering, ask V one short, relevant follow-up question in your own voice. '
    + 'Build on what V just said rather than offering generic help or repeating an answered question. '
    + 'If V says goodbye, explicitly requests no questions, or requests an exact fixed reply, omit the question. Keep the exchange brief.';
}
