#!/usr/bin/env node
/**
 * test-deps.js — the guard that belongs with the qs override.
 *
 * package.json forces qs to ^6.16.0 while express 4.22.2 and body-parser 1.20.6
 * both pin it to ~6.15.1. That is a deliberate violation of a range express
 * never sanctioned, taken because every 6.15.x carries two moderate advisories
 * (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) and 6.16 is the fix.
 *
 * Overriding a pinned range is not free: nothing in npm will warn if a future
 * qs changes a default express relies on, and the symptom would be query
 * strings quietly parsing differently on every request. So this exercises the
 * three things express and body-parser actually ask qs for — nesting, arrays,
 * and plain pairs — through a real listening server using the project's own
 * installed copies.
 *
 * If this fails after a dependency bump, do not "fix" the assertions. Either
 * express has widened its range (drop the override) or qs has changed
 * behaviour under us (pin it back and re-check the advisories).
 */
import express from 'express';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const version = name => require(`${name}/package.json`).version;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.get('/q', (req, res) => res.json(req.query));
app.post('/b', (req, res) => res.json(req.body));

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async path => (await fetch(base + path)).json();

try {
  // Plain pairs — nearly every route in this app.
  assert.deepStrictEqual(await get('/q?name=Rojy&contract=mon_thu'),
    { name: 'Rojy', contract: 'mon_thu' });

  // Nesting, which is the whole reason express uses qs over querystring.
  assert.deepStrictEqual(await get('/q?filter[team]=Blue&filter[paid]=0'),
    { filter: { team: 'Blue', paid: '0' } });

  // Repeated keys and explicit array syntax.
  assert.deepStrictEqual(await get('/q?id[]=a&id[]=b'), { id: ['a', 'b'] });
  assert.deepStrictEqual(await get('/q?id=a&id=b'), { id: ['a', 'b'] });

  // Percent-decoding, and an absent query string.
  assert.deepStrictEqual(await get('/q?d=2026-09-13&note=a%20b'),
    { d: '2026-09-13', note: 'a b' });
  assert.deepStrictEqual(await get('/q'), {});

  // The same parser again, reached through body-parser's extended urlencoded.
  const posted = await (await fetch(`${base}/b`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'player=Toby&charge[amount]=27&charge[cash]=1',
  })).json();
  assert.deepStrictEqual(posted, { player: 'Toby', charge: { amount: '27', cash: '1' } });

  // express sets arrayLimit to 1000 explicitly (lib/utils.js), NOT the qs
  // default of 20 — so the boundary this app actually runs on is 1000, and
  // indices past it must degrade to an object rather than allocate an array.
  const under = await get(`/q?${Array.from({ length: 120 }, (_, i) => `a[${i}]=${i}`).join('&')}`);
  assert.ok(Array.isArray(under.a) && under.a.length === 120,
    'under express\'s arrayLimit of 1000 this should still be an array');
  const over = await get('/q?a[0]=x&a[5000]=y');
  assert.ok(!Array.isArray(over.a) && over.a['5000'] === 'y',
    'past arrayLimit qs must produce an object, not a sparse array of 5000');

  console.log(`✓ test-deps: express ${version('express')} + body-parser `
    + `${version('body-parser')} parse correctly with qs ${version('qs')}`);
} finally {
  server.close();
}
