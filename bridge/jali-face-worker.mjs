// Worker thread for the game-trained facial model. The bridge's event loop
// only exchanges PCM copies and predicted rows; convolution work stays here.
import {parentPort, workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {parseFaceModel, FaceModelStream} from './jali-face-model.mjs';

const model = parseFaceModel(JSON.parse(readFileSync(workerData.meta, 'utf8')), readFileSync(workerData.weights));
const streams = new Map();
const send = (message, transfer) => parentPort.postMessage(message, transfer);
send({type: 'ready', lookahead: model.lookahead, outputs: model.outputs, controls: model.controls, upper: model.upper});

parentPort.on('message', message => {
  const {id} = message;
  try {
    if (message.type === 'begin') {
      if (streams.has(id) || streams.size >= 8) throw Error('Facial model stream limit');
      streams.set(id, new FaceModelStream(model, message.sampleRate));
    } else if (message.type === 'push' || message.type === 'finish') {
      const stream = streams.get(id);
      if (!stream) return; // cancelled while queued
      const rows = message.type === 'push' ? stream.push(message.pcm) : stream.finish();
      if (message.type === 'finish') streams.delete(id);
      send({type: 'rows', id, rows, finished: stream.finished, duration: stream.duration}, [rows.buffer]);
    } else if (message.type === 'cancel') {
      streams.delete(id);
    }
  } catch (error) {
    streams.delete(id);
    send({type: 'error', id, error: String(error?.message || error)});
  }
});
