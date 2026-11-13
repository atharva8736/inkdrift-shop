// Regenerates src/migrations/index.js from the .sql files.
import fs from 'node:fs';
import path from 'node:path';
const dir = new URL('../src/migrations/', import.meta.url).pathname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let out = '// Generated from the .sql files in this folder (run `npm run build:migrations`).\nexport const MIGRATIONS = [\n';
for (const f of files) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  if (sql.includes('`') || sql.includes('${')) throw new Error(`${f} contains a backtick or \${`);
  out += `  { name: ${JSON.stringify(f)}, sql: \`${sql}\` },\n`;
}
fs.writeFileSync(path.join(dir, 'index.js'), out + '];\n');
console.log('wrote', files.length, 'migration(s)');
