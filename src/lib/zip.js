// Minimal streaming ZIP writer (method "store": JPEG files are already compressed). No dependencies.
import zlib from 'node:zlib';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

// entries: [{ name, read: async () => Buffer }]. Writes the archive to a Node writable (an Express response).
export async function writeZip(out, entries) {
  const central = [];
  let offset = 0;
  const send = (buf) => new Promise((resolve, reject) => { out.write(buf, (e) => (e ? reject(e) : resolve())); offset += buf.length; });
  for (const e of entries) {
    const data = await e.read();
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    central.push({ name, crc, size: data.length, offset });
    await send(local); await send(data);
  }
  const cdStart = offset;
  for (const c of central) {
    await send(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), c.name]));
  }
  const cdSize = offset - cdStart;
  await send(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)]));
  out.end();
}
