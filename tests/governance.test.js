'use strict';
// Yönetişim paneli: yalnızca yönetici; özet sayıları ve denetim kaydı sayfalaması/filtre doğrulaması.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('yönetişim paneli', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin, user;
    before(async () => {
        s = await startServer();
        admin = await s.createUserWithToken({ role: 'admin' });
        user = await s.createUserWithToken({ role: 'brand_user' });
    });
    after(async () => { if (s) await s.stop(); });
    const get = (path, token) => s.api('GET', path, { token });

    it('yalnızca yönetici: oturumsuz 401, marka kullanıcısı 403', async () => {
        for (const p of ['/api/admin/governance/overview', '/api/admin/governance/audit', '/api/admin/governance/audit-events']) {
            assert.equal((await get(p)).status, 401, p);
            assert.equal((await get(p, user.token)).status, 403, p);
        }
    });

    it('özet: kullanıcı/2FA/abonelik/AI/denetim alanları doğru sayılır', async () => {
        const plan = (await s.pool.query(`INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys)
            VALUES ('gv','gv-plan',1,'{}'::jsonb,'[]'::jsonb) RETURNING id`)).rows[0].id;
        await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
            VALUES ($1,$2,'active','t',NOW(),NOW() + INTERVAL '3 days')`, [user.id, plan]);
        await s.pool.query(`INSERT INTO ai_usage_log (user_id, feature, model, input_tokens, output_tokens, cost_tl) VALUES ($1,'chatbot','m',10,5,0.5)`, [user.id]);
        await s.pool.query(`INSERT INTO auth_audit (user_id, event, ip_address) VALUES (NULL,'login_failed_unknown','203.0.113.9'),(NULL,'login_failed_unknown','203.0.113.9')`);
        const r = await get('/api/admin/governance/overview', admin.token);
        assert.equal(r.status, 200, r.text);
        assert.ok(r.json.users.total >= 2);
        assert.equal(r.json.users.admins, 1);
        assert.equal(r.json.users.privileged_with_2fa, 0);
        assert.equal(r.json.subscriptions.expiring_7d, 1);
        assert.equal(r.json.ai_30d.queries, 1);
        assert.equal(r.json.ai_30d.by_feature[0].feature, 'chatbot');
        assert.equal(r.json.auth_7d.failed_by_ip_24h[0].ip_address, '203.0.113.9');
        assert.equal(r.json.auth_7d.failed_by_ip_24h[0].n, 2);
        assert.equal(JSON.stringify(r.json).includes('password'), false, 'şifre/özet alanı sızmamalı');
    });

    it('denetim kaydı: sayfalama, olay filtresi ve girdi doğrulaması', async () => {
        for (let i = 0; i < 7; i++) await s.pool.query(`INSERT INTO auth_audit (user_id, event) VALUES (NULL,'test_event_${i % 2}')`);
        const p1 = await get('/api/admin/governance/audit?limit=5', admin.token);
        assert.equal(p1.status, 200, p1.text);
        assert.equal(p1.json.items.length, 5);
        assert.equal(p1.json.has_more, true);
        const p2 = await get(`/api/admin/governance/audit?limit=5&before=${p1.json.next_before}`, admin.token);
        assert.ok(p2.json.items.every(x => x.id < p1.json.next_before));
        const f = await get('/api/admin/governance/audit?event=test_event_1&limit=100', admin.token);
        assert.equal(f.json.items.length, 3);
        assert.ok(f.json.items.every(x => x.event === 'test_event_1'));
        for (const bad of ['event=a%27%3BDROP', 'event[]=x', 'before=abc', 'before=-1']) {
            assert.equal((await get(`/api/admin/governance/audit?${bad}`, admin.token)).status, 400, bad);
        }
        const big = await get('/api/admin/governance/audit?limit=100000', admin.token);
        assert.ok(big.json.items.length <= 100);
        const ev = await get('/api/admin/governance/audit-events', admin.token);
        assert.ok(ev.json.includes('test_event_0'));
    });
});
