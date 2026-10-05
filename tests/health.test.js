'use strict';
// /health/ready herkese açık ve ayrıntısız; /health/deep yalnızca yönetici.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('sağlık uçları', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin, user;
    before(async () => {
        s = await startServer();
        admin = await s.createUserWithToken({ role: 'admin' });
        user = await s.createUserWithToken({ role: 'brand_user' });
    });
    after(async () => { if (s) await s.stop(); });

    it('/health/ready: oturumsuz 200, yalnızca durum döner (ayrıntı sızmaz)', async () => {
        const r = await s.api('GET', '/health/ready');
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { status: 'ok' });
        assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    it('/health/deep: oturumsuz 401, marka kullanıcısı 403, yönetici 200 ve ayrıntı görür', async () => {
        assert.equal((await s.api('GET', '/health/deep')).status, 401);
        assert.equal((await s.api('GET', '/health/deep', { token: user.token })).status, 403);
        const r = await s.api('GET', '/health/deep', { token: admin.token });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.status, 'ok');
        assert.equal(r.json.checks.database.status, 'ok');
        assert.ok(Number.isFinite(r.json.checks.memory.rss_mb));
        assert.ok(Number.isFinite(r.json.checks.event_loop_lag_ms));
        assert.equal(JSON.stringify(r.json).includes('postgres'), false, 'veritabanı adı/bağlantı bilgisi sızmamalı');
    });
});
