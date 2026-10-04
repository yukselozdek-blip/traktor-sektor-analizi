'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('il listesi (geo yardımcıları server.js tarafından erişilebilir)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, user;
    before(async () => {
        s = await startServer();
        user = await s.createUserWithToken({ role: 'admin' });
    });
    after(async () => { if (s) await s.stop(); });

    it('GET /api/provinces -> 200 ve referans verisiyle zenginleştirilmiş liste', async () => {
        const r = await s.api('GET', '/api/provinces', { token: user.token });
        assert.equal(r.status, 200, r.text);
        assert.ok(Array.isArray(r.json) && r.json.length > 0);
        assert.ok(r.json[0].climate_zone, 'climate_zone referans değerle doldurulmalı');
    });
});
