// Command-line import: node import.js <file> [<file> ...]
import path from 'node:path';
import { openDb } from './db.js';
import { runImport } from './lib/importers.js';

const files = process.argv.slice(2);
if (!files.length) { console.log('Usage: node import.js <file.csv|file.xlsx> [...]'); process.exit(1); }
const db = openDb();
for (const f of files) {
  try {
    const r = runImport(db, path.resolve(f), 'command line');
    console.log(`${path.basename(f)} — ${r.label}`);
    for (const line of r.result) console.log('  ' + line);
  } catch (e) { console.error(`${path.basename(f)} — failed: ${e.message}`); process.exitCode = 1; }
}
db.close();
