// Minimal readers for the two file types people export: CSV and .xlsx. No dependencies.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Streams a CSV file of any size row by row (the golden record export is hundreds of MB).
export function* csvRows(file) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 22), dec = new StringDecoder('utf8');
  let row = [], cell = '', quoted = false, pendingQuote = false, lastCR = false, first = true, n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let text = dec.write(buf.subarray(0, n));
      if (first) { first = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (pendingQuote) { pendingQuote = false; if (c === '"') { cell += '"'; continue; } quoted = false; }
        if (quoted) { if (c === '"') pendingQuote = true; else cell += c; continue; }
        if (c === '\n' && lastCR) { lastCR = false; continue; }
        lastCR = c === '\r';
        if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') { row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') yield row; row = []; }
        else cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); yield row; }
  } finally { fs.closeSync(fd); }
}

function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    p += 46 + nameLen + extra + comment;
  }
  return files;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref) { if (ch < 'A' || ch > 'Z') break; n = n * 26 + ch.charCodeAt(0) - 64; } return n - 1; };

export const xlsxSheetNames = (buf) => [...unzip(buf)['xl/workbook.xml']().matchAll(/<sheet\b[^>]*>/g)].map((m) => unxml(/name="([^"]+)"/.exec(m[0])[1]));

// Returns { sheetName: rows[][] } with every cell as a string (numbers and dates keep Excel's stored value).
export function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
    : [];
  const rels = Object.fromEntries([...files['xl/_rels/workbook.xml.rels']().matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])[1], /Target="([^"]+)"/.exec(m[0])[1]]));
  const out = {};
  for (const m of files['xl/workbook.xml']().matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/name="([^"]+)"/.exec(m[0])[1]), target = rels[/r:id="([^"]+)"/.exec(m[0])[1]];
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    if (!files[path]) continue;
    const rows = [];
    for (const r of files[path]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(c[1]), type = /t="(\w+)"/.exec(c[1])?.[1], inner = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const val = type === 's' ? shared[+v] : type === 'inlineStr' ? unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')) : v == null ? '' : unxml(v);
        row[ref ? colIndex(ref[1]) : row.length] = val ?? '';
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    out[name] = rows;
  }
  return out;
}
