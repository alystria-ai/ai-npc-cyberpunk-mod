// A minimal GGUF file (version 3) with a `general.architecture` and a name, for the tests of vision projector discovery and of the supervisor's projector handling.
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const kvString = (key, value) => Buffer.concat([str(key), u32(8), str(value)]);
export const ggufFile = (architecture, {magic = 'GGUF'} = {}) => Buffer.concat([Buffer.from(magic, 'latin1'), u32(3), u64(0), u64(2), kvString('general.architecture', architecture), kvString('general.name', 'Test')]);
