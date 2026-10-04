'use strict';
// change-plan: eskiden app._router.handle ile kendine geri dönüp 429'a düşüyordu.
// Artık checkout ile aynı işleyiciyi çağırır ve bekleyen (pending) bir abonelik oluşturur.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('billing change-plan', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('eksik parametrede 400, token yoksa 401', async () => {
        const user = await s.createUserWithToken();
        const noAuth = await s.api('POST', '/api/billing/change-plan', { body: { plan_slug: 'x', provider: 'stripe' } });
        assert.equal(noAuth.status, 401);
        const bad = await s.api('POST', '/api/billing/change-plan', { token: user.token, body: {} });
        assert.equal(bad.status, 400);
    });

    it('geçerli istek checkout gibi çalışır (200, bekleyen abonelik)', async () => {
        const user = await s.createUserWithToken();
        const plan = await s.pool.query('SELECT slug FROM subscription_plans WHERE is_active = true ORDER BY id LIMIT 1');
        assert.ok(plan.rows.length, 'test DB\'de aktif plan yok');
        const res = await s.api('POST', '/api/billing/change-plan', {
            token: user.token,
            body: { plan_slug: plan.rows[0].slug, provider: 'bank_transfer', period: 'monthly' }
        });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.success, true);
        const sub = await s.pool.query('SELECT status FROM subscriptions WHERE user_id = $1', [user.id]);
        assert.equal(sub.rows[0].status, 'pending');
    });
});
