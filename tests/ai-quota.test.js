'use strict';
// AI kotası: atomik rezervasyon, 429 AI_QUOTA_EXCEEDED, fail-closed, admin muafiyeti.
// LLM çağrıları sahte yerel bir HTTP sunucusuna gider (MINIMAX_BASE_URL); gerçek ağa çıkılmaz.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('AI kotası', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, fake, fakeCalls = 0, fakeMode = 'ok', planId2, planId0, planUnl;
    before(async () => {
        fake = http.createServer((req, res) => {
            fakeCalls++;
            req.resume();
            req.on('end', () => setTimeout(() => {
                if (fakeMode === 'fail') { res.writeHead(500); return res.end('boom'); }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ model: 'fake', choices: [{ message: { content: 'analiz' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
            }, 40));
        });
        await new Promise(r => fake.listen(0, '127.0.0.1', r));
        s = await startServer({ env: { MINIMAX_API_KEY: 'fake-key', MINIMAX_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1` } });
        const mk = async (slug, lim) => (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys) VALUES ($1,$1,0,$2::jsonb,$3::jsonb) RETURNING id`,
            [slug, JSON.stringify({ ai_queries_monthly: lim }), JSON.stringify(['ai_insights', 'ai_forecast'])])).rows[0].id;
        planId2 = await mk('q-two', 2);
        planId0 = await mk('q-zero', 0);
        planUnl = await mk('q-unl', -1);
    });

    // E-posta doğrulaması zorunlu olabilir: kullanıcıyı doğrulanmış oluşturup giriş yap
    async function mkUser(opts = {}) {
        const u = await s.createUser(opts);
        await s.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [u.id]);
        const res = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        if (res.status !== 200 || !res.json?.token) throw new Error(`Login başarısız (${res.status}): ${res.text}`);
        return { ...u, token: res.json.token };
    }
    after(async () => { if (s) await s.stop(); await new Promise(r => fake.close(r)); });

    async function userOn(pid) {
        const u = await mkUser({ role: 'brand_user' });
        await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                            VALUES ($1,$2,'active','test',NOW(),NOW() + INTERVAL '30 days')`, [u.id, pid]);
        return u;
    }
    const analyze = u => s.api('POST', '/api/ai/analyze', { token: u.token, body: { type: 'regional-index', context: { year: 2024, provinces: [] } } });
    const used = async u => (await s.api('GET', '/api/billing/usage', { token: u.token })).json.usage.ai_queries;

    it('limit=2: 3. istek 429 AI_QUOTA_EXCEEDED (used/limit ile)', async () => {
        const u = await userOn(planId2);
        assert.equal((await analyze(u)).status, 200);
        assert.equal((await analyze(u)).status, 200);
        const before = fakeCalls;
        const r = await analyze(u);
        assert.equal(r.status, 429, r.text);
        assert.equal(r.json.code, 'AI_QUOTA_EXCEEDED');
        assert.equal(r.json.used, 2);
        assert.equal(r.json.limit, 2);
        assert.equal(fakeCalls, before, 'kota aşılınca LLM çağrılmamalı');
        assert.equal(await used(u), 2, 'kullanım sayfası tutarlı');
        const log = await s.pool.query(`SELECT COUNT(*)::int c, SUM(input_tokens)::int i FROM ai_usage_log WHERE user_id = $1`, [u.id]);
        assert.equal(log.rows[0].c, 2);
        assert.equal(log.rows[0].i, 20);
    });

    it('aynı anda 10 istek: en fazla limit kadar başarılı', async () => {
        const u = await userOn(planId2);
        const before = fakeCalls;
        const rs = await Promise.all(Array.from({ length: 10 }, () => analyze(u)));
        const ok = rs.filter(r => r.status === 200).length;
        const limited = rs.filter(r => r.status === 429).length;
        assert.equal(ok, 2, rs.map(r => r.status).join(','));
        assert.equal(limited, 8);
        assert.equal(fakeCalls - before, 2);
        assert.equal(await used(u), 2);
    });

    it('LLM hatası (başarısız çağrı) kotadan düşmez (rezervasyon iade edilir)', async () => {
        const u = await userOn(planId2);
        fakeMode = 'fail';
        try {
            const r = await analyze(u);
            assert.equal(r.status, 500);
        } finally { fakeMode = 'ok'; }
        await new Promise(r => setTimeout(r, 200));
        assert.equal(await used(u), 0);
        assert.equal((await analyze(u)).status, 200);
    });

    it('doğrulama hatası (400) kotadan düşmez', async () => {
        const u = await userOn(planId2);
        const bad = await s.api('POST', '/api/ai/analyze', { token: u.token, body: { type: 'yok-boyle-tip' } });
        assert.equal(bad.status, 400);
        await new Promise(r => setTimeout(r, 200));
        assert.equal(await used(u), 0);
    });

    it('limit=0: AI yok (402 AI_NOT_INCLUDED); -1: sınırsız', async () => {
        const z = await userOn(planId0);
        const r = await analyze(z);
        assert.equal(r.status, 402);
        assert.equal(r.json.code, 'AI_NOT_INCLUDED');
        const u = await userOn(planUnl);
        for (let i = 0; i < 4; i++) assert.equal((await analyze(u)).status, 200);
        assert.equal(await used(u), 4);
    });

    it('diğer AI uçları da sayılır: /api/insights ve /api/forecast/executive', async () => {
        const u = await userOn(planId2);
        assert.equal((await s.api('GET', '/api/insights', { token: u.token })).status, 200);
        assert.equal(await used(u), 1);
        const f = await s.api('GET', '/api/forecast/executive', { token: u.token });
        assert.ok(f.status !== 429 && f.status !== 402, f.text);
        if (f.status === 200) {
            assert.equal(await used(u), 2);
            const x = await s.api('GET', '/api/insights', { token: u.token });
            assert.equal(x.status, 429);
        }
    });

    it('ay başında sıfırlanır: önceki ayın doluluğu bu ayı etkilemez', async () => {
        const u = await userOn(planId2);
        await s.pool.query(
            `INSERT INTO usage_meters (user_id, period_start, ai_queries_count) VALUES ($1, date_trunc('month', NOW()) - INTERVAL '1 month', 2)`, [u.id]);
        assert.equal((await analyze(u)).status, 200);
        assert.equal(await used(u), 1);
    });

    it('admin muaf: kota/abonelik gerekmez, sınırsız geçer', async () => {
        const a = await mkUser({ role: 'admin' });
        for (let i = 0; i < 4; i++) assert.equal((await analyze(a)).status, 200);
    });

    it('DB hatasında fail-closed: 503 AI_QUOTA_UNAVAILABLE, LLM çağrılmaz', async () => {
        const u = await userOn(planId2);
        const before = fakeCalls;
        await s.pool.query('ALTER TABLE usage_meters RENAME TO usage_meters_bak');
        try {
            const r = await analyze(u);
            assert.equal(r.status, 503, r.text);
            assert.equal(r.json.code, 'AI_QUOTA_UNAVAILABLE');
            assert.equal(fakeCalls, before);
        } finally {
            await s.pool.query('ALTER TABLE usage_meters_bak RENAME TO usage_meters');
        }
    });
});
