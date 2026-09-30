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
  return 'Follow-up questions are enabled for this turn. You may ask V at most one short, relevant question when it follows naturally. '
    + 'Do not add a question by habit or repeat one V has already answered. Keep your reply brief and in character; let V choose whether to answer.';
}
