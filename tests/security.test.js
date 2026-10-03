'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { startServer, SKIP_DB, SKIP_REASON, INSIGHTS_API_KEY } = require('./helpers');

const WA_SECRET = 'wa-test-secret';
const ADMIN_ROUTES = [
    ['POST', '/api/admin/reseed-sales'],
    ['POST', '/api/admin/seed-sales'],
    ['POST', '/api/admin/seed-models'],
    ['GET', '/api/auth/diagnostic'],
    ['GET', '/api/debug/version'],
    ['POST', '/api/insights']
];

describe('security (HTTP, child-process server)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin, brand;
    // Login limiter: 15 / 5 dk. Bu dosya toplam 3 (token) + 2 + 6 = 11 login çağrısı yapar.
    before(async () => {
        s = await startServer({ env: { WHATSAPP_APP_SECRET: WA_SECRET } });
        admin = await s.createUserWithToken({ role: 'admin' });
        brand = await s.createUserWithToken({ role: 'brand_user' });
    });
    after(async () => { if (s) await s.stop(); });

    it('GET /health -> 200', async () => {
        assert.equal((await s.api('GET', '/health')).status, 200);
    });

    it('unauthenticated admin routes -> 401', async () => {
        for (const [m, p] of ADMIN_ROUTES) {
            const r = await s.api(m, p, m === 'POST' ? { body: {} } : {});
            assert.equal(r.status, 401, `${m} ${p}`);
        }
    });

    it('brand_user on admin routes -> 403', async () => {
        for (const [m, p] of ADMIN_ROUTES) {
            const r = await s.api(m, p, { token: brand.token, ...(m === 'POST' ? { body: {} } : {}) });
            assert.equal(r.status, 403, `${m} ${p}`);
        }
    });

    it('admin can GET /api/auth/diagnostic and /api/debug/version', async () => {
        assert.equal((await s.api('GET', '/api/auth/diagnostic', { token: admin.token })).status, 200);
        assert.equal((await s.api('GET', '/api/debug/version', { token: admin.token })).status, 200);
    });

    it('POST /api/insights: valid x-api-key passes auth, wrong key -> 401', async () => {
        const ok = await s.api('POST', '/api/insights', { headers: { 'x-api-key': INSIGHTS_API_KEY }, body: {} });
        assert.ok(![401, 403].includes(ok.status), `status ${ok.status}`);
        const bad = await s.api('POST', '/api/insights', { headers: { 'x-api-key': 'wrong' }, body: {} });
        assert.equal(bad.status, 401);
    });

    it('unknown API route -> 404 JSON {error}', async () => {
        const r = await s.api('GET', '/api/does-not-exist');
        assert.equal(r.status, 404);
        assert.equal(typeof r.json?.error, 'string');
    });

    it('login: wrong password -> 401, correct -> 200 + token', async () => {
        const u = await s.createUser();
        const bad = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: 'nope' } });
        assert.equal(bad.status, 401);
        const ok = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        assert.equal(ok.status, 200);
        assert.ok(ok.json.token);
    });

    it('login: account locks after repeated failures (423)', async () => {
        const u = await s.createUser();
        const statuses = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await s.api('POST', '/api/auth/login', { body: { email: u.email, password: 'bad' } })).status);
        }
        assert.deepEqual(statuses, [401, 401, 401, 401, 401, 423]);
    });

    it('CORS: foreign origin gets no access-control-allow-origin', async () => {
        const r = await s.api('GET', '/health', { headers: { Origin: 'https://evil.example' } });
        assert.equal(r.headers.get('access-control-allow-origin'), null);
    });

    it('JWT signed with another secret -> 401', async () => {
        const forged = jwt.sign({ id: admin.id, email: admin.email, role: 'admin' }, 'other-secret');
        const r = await s.api('GET', '/api/auth/diagnostic', { token: forged });
        assert.equal(r.status, 401);
    });

    it('deactivated admin with previously issued token -> 403', async () => {
        const a = await s.createUserWithToken({ role: 'admin' });
        assert.equal((await s.api('GET', '/api/debug/version', { token: a.token })).status, 200);
        await s.pool.query('UPDATE users SET is_active = false WHERE id = $1', [a.id]);
        assert.equal((await s.api('GET', '/api/debug/version', { token: a.token })).status, 403);
    });

    it('stripe webhook without/with invalid signature -> 4xx', async () => {
        const r1 = await s.api('POST', '/api/billing/webhook/stripe', { body: { type: 'x' } });
        assert.ok(r1.status >= 400 && r1.status < 500, `status ${r1.status}`);
        const r2 = await s.api('POST', '/api/billing/webhook/stripe', { headers: { 'stripe-signature': 't=1,v1=deadbeef' }, body: { type: 'x' } });
        assert.ok(r2.status >= 400 && r2.status < 500, `status ${r2.status}`);
    });

    it('whatsapp webhook: missing/invalid signature -> 401, valid HMAC -> 200', async () => {
        const raw = JSON.stringify({ entry: [] });
        const h = { 'Content-Type': 'application/json' };
        assert.equal((await s.api('POST', '/api/public/whatsapp/webhook', { headers: h, rawBody: raw })).status, 401);
        assert.equal((await s.api('POST', '/api/public/whatsapp/webhook', { headers: { ...h, 'x-hub-signature-256': 'sha256=00' }, rawBody: raw })).status, 401);
        const sig = 'sha256=' + crypto.createHmac('sha256', WA_SECRET).update(raw).digest('hex');
        const ok = await s.api('POST', '/api/public/whatsapp/webhook', { headers: { ...h, 'x-hub-signature-256': sig }, rawBody: raw });
        assert.equal(ok.status, 200);
    });

    it('assistant sales-query without WHATSAPP_QUERY_API_KEY -> 503', async () => {
        const r = await s.api('POST', '/api/public/assistant/sales-query', { body: { question: 'test' } });
        assert.equal(r.status, 503);
    });
});
