// Pocket English as bfloat16 (docs/POCKET_BF16.md). The Runtime build stores the English student's weights as bfloat16, the dtype the five Pocket language
// models are published in: 219 MB instead of 438 MB, the same 214 tensors. The worker widens the file into float32 modules on load (bridge/pocket-voice-worker.py),
// so nothing about how it runs changes; only the file and the pins that name it (model sha256, receipt sha256) differ.
//
// Plain Node, no torch: every float32 value is cut to its upper 16 bits with round-to-nearest-even (the cast torch's `.to(torch.bfloat16)` makes; scripts/Convert-PocketBf16.py
// is the same thing in Python, and the two give the same bytes). The output is a safetensors file written the way the safetensors library writes one:
// compact JSON header padded with spaces to a multiple of 8 bytes, tensors in name order, no metadata unless the source had some.
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';

// The words the receipt's provenance carries (the same text in scripts/Convert-PocketBf16.py).
export const BF16_CAST = 'float32 to bfloat16, round to nearest even, every float32 tensor';
export const BF16_TOOL = 'packaging/lib/pocket-bf16.mjs';

/** The bfloat16 bits (upper 16) of a float32 given as its 32 raw bits: round to nearest even, NaN kept a NaN. */
export function bf16Bits(bits) {
  if ((bits & 0x7fffffff) > 0x7f800000) return ((bits >>> 16) | 0x40) & 0xffff; // NaN: quiet, payload truncated
  return ((bits + 0x7fff + ((bits >>> 16) & 1)) >>> 16) & 0xffff; // at most 0xff800000 + 0x8000, no wrap
}

/** Reads a safetensors file: {header (tensors only), metadata, dataStart, data (Buffer of the whole file)}. */
export function parseSafetensors(buffer) {
  if (buffer.length < 8) throw Error('Not a safetensors file: too short.');
  const length = Number(buffer.readBigUInt64LE(0));
  if (!Number.isSafeInteger(length) || length < 2 || 8 + length > buffer.length) throw Error('Not a safetensors file: bad header length.');
  const header = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'));
  const metadata = header.__metadata__; delete header.__metadata__;
  const dataStart = 8 + length;
  let expected = 0;
  for (const [name, info] of Object.entries(header).sort((a, b) => a[1].data_offsets[0] - b[1].data_offsets[0])) {
    const [from, to] = info.data_offsets;
    if (from !== expected || to < from || dataStart + to > buffer.length) throw Error(`${name}: tensor data is not contiguous or runs past the file.`);
    expected = to;
  }
  if (dataStart + expected !== buffer.length) throw Error('The tensor data does not end at the end of the file.');
  return {header, metadata, dataStart, buffer};
}

/** The bfloat16 safetensors bytes of a float32 safetensors file's bytes (other dtypes are refused: an export holds float32 only). */
export function toBf16(buffer) {
  const {header, metadata, dataStart} = parseSafetensors(buffer);
  const names = Object.keys(header).sort();
  const out = {};
  let offset = 0;
  for (const name of names) {
    const info = header[name];
    if (info.dtype !== 'F32') throw Error(`${name}: dtype ${info.dtype}; only float32 tensors are converted.`);
    const bytes = info.data_offsets[1] - info.data_offsets[0];
    if (bytes % 4) throw Error(`${name}: a float32 tensor must be a multiple of 4 bytes.`);
    out[name] = {dtype: 'BF16', shape: info.shape, data_offsets: [offset, offset + bytes / 2]};
    offset += bytes / 2;
  }
  const head = JSON.stringify(metadata ? {__metadata__: metadata, ...out} : out);
  const padded = head + ' '.repeat((8 - (Buffer.byteLength(head) % 8)) % 8);
  const result = Buffer.alloc(8 + Buffer.byteLength(padded) + offset);
  result.writeBigUInt64LE(BigInt(Buffer.byteLength(padded)), 0);
  result.write(padded, 8, 'utf8');
  const base = 8 + Buffer.byteLength(padded);
  for (const name of names) {
    const from = dataStart + header[name].data_offsets[0], count = (header[name].data_offsets[1] - header[name].data_offsets[0]) / 4;
    const to = base + out[name].data_offsets[0];
    for (let i = 0; i < count; i++) result.writeUInt16LE(bf16Bits(buffer.readUInt32LE(from + i * 4)), to + i * 2);
  }
  return result;
}

/** The receipt text for the converted model: model_sha256 is the new file's, and `provenance.bfloat16` records where it came from. The text is edited in place
 *  (not parsed and written again) so the receipt keeps its own layout, line endings and numbers such as 1.0. */
export function bf16ReceiptText(text, newSha256) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const own = /"model_sha256": "([0-9a-f]{64})"/g;
  const found = [...text.matchAll(own)];
  if (found.length !== 1) throw Error('The receipt must name its model_sha256 exactly once.');
  const was = found[0][1];
  if (/"bfloat16"/.test(text)) throw Error('This receipt already records a bfloat16 conversion.');
  const opening = /"provenance": \{\r?\n/.exec(text);
  if (!opening) throw Error('The receipt has no provenance block.');
  const block = ['    "bfloat16": {', `      "from_model_sha256": "${was}",`, `      "cast": "${BF16_CAST}",`, `      "tool": "${BF16_TOOL}"`, '    },'].join(eol) + eol;
  const edited = text.slice(0, opening.index + opening[0].length) + block + text.slice(opening.index + opening[0].length);
  return edited.replace(`"model_sha256": "${was}"`, `"model_sha256": "${newSha256}"`);
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/**
 * Makes the bfloat16 copy of an English student export in `directory` (model.safetensors and receipt.json; the other files stay where they are).
 * Returns {modelPath, receiptPath, pins: {sha256, receiptSha256}, bytes, sourceBytes, fromSha256}.
 */
export async function makePocketBf16({modelPath, receiptPath, directory}) {
  const source = await readFile(modelPath);
  const converted = toBf16(source);
  const modelSha256 = sha256(converted);
  const receipt = Buffer.from(bf16ReceiptText(await readFile(receiptPath, 'utf8'), modelSha256), 'utf8');
  await mkdir(directory, {recursive: true});
  const out = {modelPath: `${directory}/model.safetensors`, receiptPath: `${directory}/receipt.json`};
  await writeFile(out.modelPath, converted);
  await writeFile(out.receiptPath, receipt);
  return {...out, pins: {sha256: modelSha256, receiptSha256: sha256(receipt)}, bytes: converted.length, sourceBytes: source.length, fromSha256: sha256(source)};
}
