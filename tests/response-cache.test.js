'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createResponseCache } = require('../src/middleware/response-cache');

const SECRET = 'cache-test';
const tok = (id, extra = {}) => jwt.sign({ id, role: 'brand_user', brand_id: 1, ...extra }, SECRET);

describe('response cache', () => {
    let server, base, calls, fail;
    before(async () => {
        calls = 0; fail = false;
        const app = express();
        app.use(createResponseCache({ jwtSecret: SECRET, ttlMs: 60000, pathPrefixes: ['/api/sales/'] }));
        app.get('/api/sales/x', async (req, res) => {
            calls++;
            await new Promise(r => setTimeout(r, 50));
            if (fail) return res.status(500).json({ error: 'x' });
            res.json({ n: calls });
        });
        app.get('/api/other', (req, res) => { calls++; res.json({ n: calls }); });
        server = http.createServer(app);
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise(r => server.close(r)));
    const get = (p, token) => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        .then(async r => ({ status: r.status, cache: r.headers.get('x-cache'), json: await r.json() }));

    it('MISS sonra HIT; ikinci istek rotayı çalıştırmaz', async () => {
        calls = 0;
        const a = await get('/api/sales/x?y=1', tok(1));
        const b = await get('/api/sales/x?y=1', tok(1));
        assert.deepEqual([a.cache, b.cache, calls], ['MISS', 'HIT', 1]);
        assert.deepEqual(a.json, b.json);
    });

    it('kullanıcılar arasında paylaşılmaz; farklı URL ayrı anahtardır', async () => {
        calls = 0;
        await get('/api/sales/x?z=1', tok(10));
        const other = await get('/api/sales/x?z=1', tok(11));
        const url2 = await get('/api/sales/x?z=2', tok(10));
        assert.deepEqual([other.cache, url2.cache, calls], ['MISS', 'MISS', 3]);
    });

    it('geçersiz/eksik token ve kapsam dışı yollar önbelleğe alınmaz', async () => {
        calls = 0;
        const bad = await get('/api/sales/x?q=1', 'bozuk');
        const none = await get('/api/sales/x?q=1');
        const o1 = await get('/api/other', tok(1));
        const o2 = await get('/api/other', tok(1));
        assert.deepEqual([bad.cache, none.cache, o1.cache, o2.cache, calls], [null, null, null, null, 4]);
    });

    it('200 dışı yanıtlar saklanmaz', async () => {
        calls = 0; fail = true;
        const a = await get('/api/sales/x?e=1', tok(20));
        fail = false;
        const b = await get('/api/sales/x?e=1', tok(20));
        assert.deepEqual([a.status, b.status, b.cache, calls], [500, 200, 'MISS', 2]);
    });

    it('aynı anahtar için eşzamanlı istekler tek hesaplamayı paylaşır', async () => {
        calls = 0;
        const rs = await Promise.all(Array.from({ length: 8 }, () => get('/api/sales/x?c=1', tok(30))));
        assert.equal(calls, 1);
        assert.ok(rs.every(r => r.status === 200 && r.json.n === 1));
    });
});
