// xlsx.js — writes a real Excel workbook, with no dependencies.
//
// The app already exports everything as JSON, which is the right thing to
// restore from and the wrong thing to work in. What was asked for is a file
// you can open on a laptop with no internet and carry on from: read the
// season, check a cost, sort a column, add a row of your own. That is a
// spreadsheet, and a spreadsheet with one sheet per subject rather than a
// single flat dump.
//
// CSV would have been a tenth of this code and is what most projects reach
// for. It cannot hold sixteen tables in one file, so the alternative was
// sixteen loose files whose relationship to each other lives only in their
// names — which is exactly the state this app exists to replace. It also has
// no way to say "this column is money" or "this column is a date", so Excel
// guesses, and its guesses about dates are famously destructive.
//
// An .xlsx is a ZIP of XML parts. Both halves are in the standard library:
// zlib deflates, and the XML is small enough to write by hand. What follows
// is the minimum that Excel, LibreOffice and Google Sheets all accept:
// a workbook, its relationships, one styles part, and a sheet per table.
import { deflateRawSync } from 'node:zlib';

// --- ZIP ---------------------------------------------------------------
//
// Written out by hand rather than shelled out to a zip tool, because the
// server has no guarantee of one and a spawned process is a far larger thing
// to depend on than forty lines of header writing.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS packed date and time, which is what a ZIP entry records. */
function dosStamp(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5)
    | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5)
    | (d.getDate() & 31);
  return { time, date };
}

/** A ZIP archive of `files` ([{ name, data }]), deflated. */
function zip(files, when = new Date()) {
  const { time, date } = dosStamp(when);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    // A "compressed" form larger than the original is a real possibility for
    // the tiny parts, and storing those uncompressed keeps the file honest.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    name.copy(local, 30);
    locals.push(local, body);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    offset += local.length + body.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, dir, end]);
}

// --- XML ---------------------------------------------------------------

/**
 * Escape text for XML, and drop the control characters XML cannot carry.
 *
 * A single stray byte in a pasted WhatsApp message would otherwise produce a
 * file Excel refuses to open at all, with an error that says nothing about
 * which cell caused it.
 */
function xml(v) {
  let out = "";
  for (const ch of String(v)) {
    const c = ch.codePointAt(0);
    // Tab, newline and carriage return are the only control characters XML
    // can carry. The rest are dropped rather than escaped, because there is
    // no escape for them: one stray byte in a pasted WhatsApp message would
    // otherwise produce a file Excel refuses to open, with an error naming
    // the file and not the cell.
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue;
    out += ch === "&" ? "&amp;"
      : ch === "<" ? "&lt;"
        : ch === ">" ? "&gt;"
          : ch === '"' ? "&quot;"
            : ch;
  }
  return out;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * Excel's day number for an ISO date.
 *
 * Day 1 is 1900-01-01 and the calendar contains a 29th of February 1900 that
 * never happened, which is why the epoch below is the 30th of December 1899
 * rather than the 31st. Anything that is not a plain yyyy-mm-dd is left as
 * text: a half-parsed date is worse than a string, because it looks right.
 */
const EPOCH = Date.UTC(1899, 11, 30);
function dateSerial(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / 86400000);
}

// Style indexes, in the order they are declared in STYLES below.
const S = { plain: 0, header: 1, date: 2, money: 3, int: 4, wrap: 5 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
<numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * A worksheet's XML.
 *
 * `columns` is [{ header, key, type, width }] where type is one of text,
 * money, int, number, date or wrap. The type is declared rather than sniffed
 * from the first row: a column of dates whose first entry happens to be blank
 * would otherwise format itself as text for the whole season.
 */
function sheetXml({ columns, rows, freeze = true, filter = true }) {
  const headRow = `<row r="1" ht="22" customHeight="1">` + columns.map((c, ci) =>
    `<c r="${colName(ci)}1" s="${S.header}" t="inlineStr"><is><t xml:space="preserve">`
    + `${xml(c.header)}</t></is></c>`).join('') + `</row>`;

  const body = rows.map((row, ri) => {
    const r = ri + 2;
    const inner = columns.map((c, ci) => {
      let v = row[c.key];
      if (v === null || v === undefined || v === '') return '';
      const ref = `${colName(ci)}${r}`;
      if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
      if (c.type === 'date') {
        const serial = dateSerial(v);
        if (serial !== null) return `<c r="${ref}" s="${S.date}"><v>${serial}</v></c>`;
      } else if (c.type === 'money' || c.type === 'int' || c.type === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) {
          const s = c.type === 'money' ? S.money : c.type === 'int' ? S.int : S.plain;
          return `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
        }
      }
      const style = c.type === 'wrap' ? S.wrap : S.plain;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">`
        + `${xml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${inner}</row>`;
  }).join('');

  const cols = `<cols>` + columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width
      || Math.min(46, Math.max(10, String(c.header).length + 4))}" customWidth="1"/>`)
    .join('') + `</cols>`;

  const view = `<sheetViews><sheetView workbookViewId="0">`
    + (freeze ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
      + `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` : '')
    + `</sheetView></sheetViews>`;

  const last = `${colName(Math.max(0, columns.length - 1))}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="A1:${last}"/>${view}${cols}`
    + `<sheetData>${headRow}${body}</sheetData>`
    + (filter && rows.length ? `<autoFilter ref="A1:${last}"/>` : '')
    + `</worksheet>`;
}

/**
 * Excel's rules for a sheet name, applied quietly.
 *
 * Over 31 characters, or containing any of : \ / ? * [ ], and the whole file
 * fails to open — with an error naming the file, not the sheet. Names must
 * also be unique, so a truncation that collides gets a number.
 */
function safeName(name, taken) {
  let s = String(name).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  if (taken.has(s.toLowerCase())) {
    const base = s.slice(0, 28);
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    s = `${base} ${n}`;
  }
  taken.add(s.toLowerCase());
  return s;
}

/**
 * Build the workbook.
 *
 * `sheets` is [{ name, columns, rows, freeze, filter }]. Returns a Buffer
 * ready to be written to disk or sent as a download.
 */
export function buildWorkbook(sheets, { created = new Date() } = {}) {
  const taken = new Set();
  const named = sheets.map(s => ({ ...s, name: safeName(s.name, taken) }));

  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) =>
        `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...named.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s),
    })),
  ];

  return zip(files, created);
}

// Exported for the tests, which read a workbook back out of its own ZIP
// rather than trusting that writing it went well.
export const _internals = { crc32, colName, dateSerial, safeName, xml };
