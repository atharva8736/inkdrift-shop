// Uploads the four pack ZIPs to your PRIVATE Vercel Blob store.
// Usage: BLOB_READ_WRITE_TOKEN=... npm run upload-packs -- /path/to/folder/with/zips
// (Alternatively drag the ZIPs into the Blob store in the Vercel dashboard, using the exact file names.)
import fs from 'node:fs';
import path from 'node:path';
import { put } from '@vercel/blob';

const dir = process.argv[2];
if (!dir) { console.error('Give the folder that contains the ZIP files.'); process.exit(1); }
const wanted = ['Inkdrift_Vol1_Old_Money.zip', 'Inkdrift_Vol2_Time.zip', 'Inkdrift_Vol3_Machines.zip', 'Inkdrift_Vol4_Late_Nights.zip'];
for (const name of wanted) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) { console.error(`Missing ${file}`); process.exitCode = 1; continue; }
  const r = await put(name, fs.createReadStream(file), { access: 'private', addRandomSuffix: false, allowOverwrite: true, multipart: true, contentType: 'application/zip' });
  console.log('uploaded', r.pathname);
}
