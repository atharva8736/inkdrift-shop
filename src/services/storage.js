// Where the paid ZIP packs live. 'blob' = Vercel Blob (private store), 'disk' = a local folder (dev and tests).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export function createStorage(cfg) {
  if (cfg.storage.driver === 'blob') {
    return {
      driver: 'blob',
      async open(fileName) {
        const { get } = await import('@vercel/blob');
        const r = await get(path.basename(fileName), { access: 'private', token: cfg.storage.blobToken || undefined });
        if (!r || r.statusCode !== 200 || !r.stream) return null;
        return { stream: Readable.fromWeb(r.stream), size: r.blob?.size };
      },
    };
  }
  return {
    driver: 'disk',
    async open(fileName) {
      const file = path.resolve(cfg.packsDir, path.basename(fileName));          // basename blocks path tricks
      if (!fs.existsSync(file)) return null;
      return { stream: fs.createReadStream(file), size: fs.statSync(file).size };
    },
  };
}
