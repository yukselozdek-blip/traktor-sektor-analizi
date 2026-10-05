'use strict';
// Dönemi dolan abonelikler otomatik 'expired' olur; dolmayan ve süresiz olanlar değişmez.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('abonelik süre dolumu taraması', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer({ env: { BILLING_SWEEP_INTERVAL_MS: '500' } }); });
    after(async () => { if (s) await s.stop(); });

    it('süresi dolan abonelik expired olur; geçerli ve süresiz olanlar değişmez', async () => {
        const plan = (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, plan_limits, feature_keys)
             VALUES ('ex', 'ex-plan', 1, 1, '{}'::jsonb, '[]'::jsonb) RETURNING id`)).rows[0].id;
        const mk = async (status, endSql) => {
            const u = await s.createUser({ role: 'brand_user' });
            return (await s.pool.query(
                `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                 VALUES ($1, $2, $3, 'test', NOW() - INTERVAL '40 days', ${endSql}) RETURNING id`, [u.id, plan, status])).rows[0].id;
        };
        const stale = await mk('active', `NOW() - INTERVAL '1 day'`);
        const staleCancelled = await mk('cancelled', `NOW() - INTERVAL '1 day'`);
        const valid = await mk('active', `NOW() + INTERVAL '5 days'`);
        const open = await mk('active', 'NULL');
        const pending = await mk('pending', `NOW() - INTERVAL '1 day'`);
        const statusOf = async id => (await s.pool.query('SELECT status FROM subscriptions WHERE id = $1', [id])).rows[0].status;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && (await statusOf(stale)) !== 'expired') await new Promise(r => setTimeout(r, 300));
        assert.equal(await statusOf(stale), 'expired');
        assert.equal(await statusOf(staleCancelled), 'expired');
        assert.equal(await statusOf(valid), 'active');
        assert.equal(await statusOf(open), 'active');
        assert.equal(await statusOf(pending), 'pending'); // ödeme bekleyen satıra dokunulmaz
    });
});
