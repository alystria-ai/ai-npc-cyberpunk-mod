// Worker thread for the game-trained facial model. The bridge's event loop
// only exchanges PCM copies and predicted rows; convolution work stays here.
import {parentPort, workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseFaceModel, FaceModelStream} from './jali-face-model.mjs';
import {parseFaceText} from './jali-face-text.mjs';

const weights = readFileSync(workerData.weights);
const model = parseFaceModel(JSON.parse(readFileSync(workerData.meta, 'utf8')), weights);
// Optional text path (face-text.*): only for the exact audio model it was trained on.
let faceText = null, textStatus = 'absent';
if (workerData.text) {
  try {
    const meta = JSON.parse(readFileSync(workerData.text.meta, 'utf8'));
    if (meta.stage1Sha256 !== createHash('sha256').update(weights).digest('hex')) textStatus = 'mismatched-model';
    else { faceText = parseFaceText(meta, readFileSync(workerData.text.weights), readFileSync(workerData.text.lexicon), model); textStatus = 'ready'; }
  } catch (error) { textStatus = `invalid: ${String(error?.message || error).slice(0, 120)}`; }
}
const streams = new Map();
const send = (message, transfer) => parentPort.postMessage(message, transfer);
send({type: 'ready', lookahead: model.lookahead, outputs: model.outputs, controls: model.controls, upper: model.upper,
  text: textStatus});

parentPort.on('message', message => {
  const {id} = message;
  try {
    if (message.type === 'begin') {
      if (streams.has(id) || streams.size >= 8) throw Error('Facial model stream limit');
      let text;
      if (faceText && typeof message.text === 'string') {
        try { text = faceText.session({mode: message.textMode === 'phrase' ? 'phrase' : 'stream', text: message.text, complete: message.textComplete !== false}); }
        catch { text = undefined; }
      }
      streams.set(id, new FaceModelStream(model, message.sampleRate, {text}));
    } else if (message.type === 'text') {
      streams.get(id)?.setText(message.text, message.complete !== false);
    } else if (message.type === 'push' || message.type === 'finish') {
      const stream = streams.get(id);
      if (!stream) return; // cancelled while queued
      const rows = message.type === 'push' ? stream.push(message.pcm, {sentAt: message.sentAt}) : stream.finish();
      if (message.type === 'finish') streams.delete(id);
      const text = stream.finished ? (stream.text ? stream.text.info() : stream.textFailed ? {active: false, reason: stream.textFailed} : undefined) : undefined;
      send({type: 'rows', id, rows, finished: stream.finished, duration: stream.duration, ...(text ? {text} : {})}, [rows.buffer]);
    } else if (message.type === 'cancel') {
      streams.delete(id);
    }
  } catch (error) {
    streams.delete(id);
    send({type: 'error', id, error: String(error?.message || error)});
  }
});
