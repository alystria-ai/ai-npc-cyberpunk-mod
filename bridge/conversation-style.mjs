// Ordinary turns carry no question rule either way: whether a character asks V
// anything is left to their personality and the moment. Only turn-order and
// automatic-event constraints remain, since those turns hand off to someone else.
export const OPEN_QUESTION_POLICY = 'Whether you ask V anything is your own call, '
  + 'driven by your personality and the moment. Do not tack a question onto a reply out of habit or just to keep the conversation going.';

export function followUpContext(input) {
  if (input.reaction?.kind === 'distraction') {
    return 'This is a staged conversation in the game world. You are talking to the person named in the event, not to V. '
      + 'Ask or answer questions only as the conversation naturally calls for.';
  }
  if (input.reaction) return 'This is an automatic reaction. Do not ask V a question, including rhetorical or follow-up questions.';
  if (input.group && input.group.index !== input.group.total) {
    return 'Another companion speaks after you. Do not ask V a question or try to restart the exchange.';
  }
  return OPEN_QUESTION_POLICY;
}
