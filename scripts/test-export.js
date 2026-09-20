#!/usr/bin/env node
/**
 * test-export.js — the Excel workbook, read back out of itself.
 *
 * A file that "downloads fine" and then will not open is the worst kind of
 * export bug: it is only discovered by the person who needed it, offline,
 * with no way to get another one. So nothing here trusts the writer. Every
 * check below unzips the produced bytes, parses the XML that came out, and
 * reads the actual cells — the same way Excel will.
 *
 * The three things that matter:
 *   - it is a valid archive, and every part Excel demands is present
 *   - the figures in it are the figures the app shows
 *   - no credential is anywhere in the file
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-xlsx-')), 'x.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run against ${DB_FILE}`);
  process.exit(1);
}
initSchema();

const { buildWorkbook, _internals } = await import('../server/xlsx.js');
const { exportWorkbook, workbookSheets, NEVER_EXPORTED } = await import(
  '../server/repos/export_workbook.js');
const { ledgersRepo } = await import('../server/repos/ledgers.js');

// --- a small club to export ------------------------------------------------

const now = new Date().toISOString();
db.prepare(`INSERT OR REPLACE INTO contracts (id,name,venue,cost_per_gw,rates,sort)
  VALUES ('mon_thu','Mon/Thu','O365',275,'{"contracted_10":30,"noncontract":40}',1)`).run();
db.prepare(`INSERT OR REPLACE INTO contracts (id,name,venue,cost_per_gw,rates,sort)
  VALUES ('sat','Saturdays','Wasl',353,'{"contracted_10":37,"noncontract":40}',2)`).run();

const addPlayer = (id, name, type = 'regular') => {
  db.prepare(`INSERT OR REPLACE INTO players (id,name,aliases,created_at,player_type)
    VALUES (?,?,'[]',?,?)`).run(id, name, now, type);
};
addPlayer('alice', 'Alice');
addPlayer('bob', 'Bob');
addPlayer('gus', 'Gus the guest', 'outside');

for (const [p, c, open] of [['alice', 'mon_thu', 300], ['bob', 'mon_thu', 0],
  ['alice', 'sat', -50]]) {
  db.prepare(`INSERT OR REPLACE INTO ledgers (player_id,contract_id,opening_balance,status)
    VALUES (?,?,?,'')`).run(p, c, open);
}

db.prepare(`INSERT INTO gameweeks (id,contract_id,gw_number,date,cost_per_gw,num_players,
  teams_raw,captains_raw,score,comments,historical,created_at,hours)
  VALUES ('g1','mon_thu',1,'2026-09-03',275,3,'','','Red 5-4 Blue','A "quoted" note & more',0,?,1)`)
  .run(now);
db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,paid)
  VALUES ('c1','g1','alice','Red',0,'contracted_10',30,0)`).run();
db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,paid)
  VALUES ('c2','g1','bob','Blue',0,'contracted_10',30,0)`).run();
db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,paid,
  settles_cash) VALUES ('c3','g1','gus','Red',0,'noncontract',40,0,1)`).run();
db.prepare(`INSERT INTO contributions (id,player_id,contract_id,name_raw,amount,date,comments,
  historical,created_at) VALUES ('m1','bob','mon_thu','Bob',200,'2026-09-01','cash',0,?)`).run(now);
db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,scope,historical,created_at)
  VALUES ('k1','income','Water money','15','2026-09-03','g1',0,?)`).run(now);

// --- reading an .xlsx back -------------------------------------------------

/**
 * Unzip an archive by walking its central directory.
 *
 * Deliberately NOT by scanning for local headers: those can legitimately
 * appear inside compressed data, and a reader that guesses would pass on a
 * file Excel rejects. The central directory is what Excel reads.
 */
function unzip(buf) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  assert.ok(eocd >= 0, 'no end-of-central-directory record — not a zip at all');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry is malformed');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `${name}: local header is malformed`);
    const lNameLen = buf.readUInt16LE(offset + 26);
    const lExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, rawSize, `${name}: uncompressed size does not match`);
    assert.equal(_internals.crc32(data), crc, `${name}: CRC does not match its own contents`);
    out[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Cell text by reference, e.g. 'B4' — inline strings and numbers alike. */
function cells(sheetXml) {
  const map = {};
  const re = /<c r="([A-Z]+\d+)"[^>]*?(?:\st="inlineStr")?[^>]*>(.*?)<\/c>/gs;
  let m;
  while ((m = re.exec(sheetXml))) {
    const inner = m[2];
    const t = /<t[^>]*>(.*?)<\/t>/s.exec(inner);
    const v = /<v>(.*?)<\/v>/s.exec(inner);
    map[m[1]] = t ? t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      : (v ? v[1] : '');
  }
  return map;
}

const files = unzip(exportWorkbook().buffer);
const sheetNames = [...files['xl/workbook.xml'].toString('utf8')
  .matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
const sheetByName = Object.fromEntries(sheetNames.map((n, i) =>
  [n, files[`xl/worksheets/sheet${i + 1}.xml`].toString('utf8')]));

// --- the tests -------------------------------------------------------------

test('it is an archive Excel will open', () => {
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
    assert.ok(files[part], `missing ${part}`);
  }
  const types = files['[Content_Types].xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
  sheetNames.forEach((_, i) => {
    // Every sheet needs BOTH a content type and a relationship. Miss either
    // and Excel reports "unreadable content" without naming what is missing.
    assert.ok(types.includes(`/xl/worksheets/sheet${i + 1}.xml`), `sheet ${i + 1} has no type`);
    assert.ok(rels.includes(`worksheets/sheet${i + 1}.xml`), `sheet ${i + 1} has no relationship`);
    assert.ok(files[`xl/worksheets/sheet${i + 1}.xml`], `sheet ${i + 1} is not in the file`);
  });
  assert.ok(rels.includes('styles.xml'), 'the styles part is not related to the workbook');
});

test('every sheet name is one Excel accepts', () => {
  const seen = new Set();
  for (const n of sheetNames) {
    assert.ok(n.length > 0 && n.length <= 31, `"${n}" is ${n.length} characters`);
    assert.ok(!/[:\\/?*[\]]/.test(n), `"${n}" contains a character Excel forbids`);
    assert.ok(!seen.has(n.toLowerCase()), `"${n}" appears twice`);
    seen.add(n.toLowerCase());
  }
});

test('a balance in the file is the balance the app shows', () => {
  const sheet = cells(sheetByName.Balances);
  const want = ledgersRepo.all();
  // Row 2 onwards; find Alice on Mon/Thu the way a reader would.
  const rows = [];
  for (let r = 2; sheet[`A${r}`] !== undefined; r++) {
    rows.push({ contract: sheet[`A${r}`], player: sheet[`B${r}`], balance: Number(sheet[`I${r}`]) });
  }
  assert.equal(rows.length, want.length, 'one row per ledger');
  for (const w of want) {
    const row = rows.find(x => x.player === w.player_name
      && x.contract === (w.contract_id === 'sat' ? 'Saturdays' : 'Mon/Thu'));
    assert.ok(row, `${w.player_name} is missing from the sheet`);
    assert.equal(row.balance, w.present_balance,
      `${w.player_name}: the sheet says ${row.balance}, the app says ${w.present_balance}`);
  }
});

test('money is a number and a date is a date, not text', () => {
  const xmlText = sheetByName.Balances;
  // Style 3 is the money format, 2 is the date format — see server/xlsx.js.
  // A money column written as inlineStr is the classic export bug: it looks
  // right and will not sum.
  assert.ok(/<c r="I2" s="3"><v>-?\d/.test(xmlText),
    'the balance column is not a formatted number');
  const games = sheetByName.Games;
  assert.ok(/<c r="A2" s="2"><v>\d+<\/v><\/c>/.test(games),
    'the game date is not a date cell');
  // 2026-09-03 is day 46268 in Excel's calendar. Hard-coded on purpose: the
  // 1900 leap-year quirk means a "reasonable" formula is off by one, and off
  // by one silently.
  assert.match(games, /<c r="A2" s="2"><v>46268<\/v><\/c>/);
});

test('a quote or an ampersand in a note does not corrupt the file', () => {
  const games = cells(sheetByName.Games);
  const note = Object.values(games).find(v => String(v).includes('quoted'));
  assert.equal(note, 'A "quoted" note & more');
});

test('control characters are dropped rather than written', () => {
  const bell = String.fromCharCode(7);
  const buf = buildWorkbook([{
    name: 'T',
    columns: [{ header: 'A', key: 'a', type: 'text' }],
    rows: [{ a: `before${bell}after` }],
  }]);
  const out = unzip(buf)['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.ok(out.includes('beforeafter'), 'the text survived');
  assert.ok(!out.includes(bell), 'and the character XML cannot carry did not');
});

test('the ids needed to carry on offline are in the file', () => {
  // Without these the workbook is a photograph of the season. With them, a
  // row edited on a laptop can be matched back to the charge it came from.
  const charges = cells(sheetByName.Charges);
  const ids = Object.entries(charges).filter(([ref]) => ref.startsWith('P'))
    .map(([, v]) => v);
  assert.ok(ids.includes('c1') && ids.includes('c3'), 'charge ids are missing');
});

test('no PIN, hash or login reaches the workbook', () => {
  // A real one, so this fails on the day somebody adds an auth sheet.
  const salt = 'saltysalt';
  const hash = 'a'.repeat(64);
  db.prepare(`INSERT OR REPLACE INTO auth_users
    (id,email,password_hash,pin,pin_salt,requires_pin_change,login_attempts,role,player_id,
     is_active,created_at) VALUES ('au1','a@b.c',?,?,?,0,0,'player','alice',1,?)`)
    .run(hash, hash, salt, now);

  const whole = Buffer.concat(Object.values(unzip(exportWorkbook().buffer))).toString('utf8');
  for (const needle of [hash, salt, 'password_hash', 'pin_salt']) {
    assert.ok(!whole.includes(needle), `the workbook contains ${needle}`);
  }
  for (const table of Object.keys(NEVER_EXPORTED)) {
    assert.ok(!sheetNames.some(n => n.toLowerCase().includes(table.split('_')[0])),
      `there is a sheet named after ${table}`);
  }
});

test('the workbook survives a player with no ledger and a contract with no games', () => {
  // The empty cases are what break an exporter, and they are normal here: a
  // new member before their first night, a contract entered before it starts.
  addPlayer('nobody', 'Never Played');
  db.prepare(`INSERT OR REPLACE INTO contracts (id,name,venue,cost_per_gw,rates,sort)
    VALUES ('fri','Fridays','',0,'{}',3)`).run();
  const out = exportWorkbook();
  assert.ok(out.buffer.length > 1000, 'it still produced a workbook');
  const again = unzip(out.buffer);
  assert.ok(Object.keys(again).length > 5, 'with all its parts');
});

test('the contents page counts what is actually there', () => {
  const sheets = workbookSheets();
  const about = cells(unzip(buildWorkbook(sheets))['xl/worksheets/sheet1.xml']);
  const listed = {};
  for (let r = 2; r < 200; r++) {
    if (about[`A${r}`] === undefined && about[`B${r}`] === undefined) continue;
    listed[about[`A${r}`]] = about[`B${r}`];
  }
  for (const s of sheets.slice(1)) {
    if (!(s.name in listed)) continue;
    assert.equal(Number(listed[s.name]), s.rows.length,
      `the contents page says ${s.name} has ${listed[s.name]} rows`);
  }
  assert.ok(Object.keys(listed).length > 5, 'the contents page lists the sheets');
});

test('a sheet name too long for Excel is cut, not passed through', () => {
  const long = 'A name that is far too long to be an Excel sheet name at all';
  const buf = buildWorkbook([
    { name: long, columns: [{ header: 'A', key: 'a' }], rows: [] },
    { name: long, columns: [{ header: 'A', key: 'a' }], rows: [] },
  ]);
  const names = [...unzip(buf)['xl/workbook.xml'].toString('utf8')
    .matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  assert.equal(names.length, 2);
  assert.ok(names.every(n => n.length <= 31), 'both were cut to length');
  assert.notEqual(names[0], names[1], 'and the collision was resolved');
});
