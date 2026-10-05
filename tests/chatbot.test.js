'use strict';
// Web sohbet asistanı: yetki, paket kapısı, doğrulama, kota (yardım ücretsiz), geçmiş izolasyonu.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('chatbot', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, planAi, planNo;
    before(async () => {
        s = await startServer();
        const mk = async (slug, feats) => (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys) VALUES ($1,$1,0,$2::jsonb,$3::jsonb) RETURNING id`,
            [slug, JSON.stringify({ ai_queries_monthly: 3 }), JSON.stringify(feats)])).rows[0].id;
        planAi = await mk('cb-ai', ['ai_insights']);
        planNo = await mk('cb-none', ['dashboard']);
    });
    after(async () => { if (s) await s.stop(); });

    async function userOn(pid) {
        const u = await s.createUser({ role: 'brand_user' });
        await s.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [u.id]);
        await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                            VALUES ($1,$2,'active','test',NOW(),NOW() + INTERVAL '30 days')`, [u.id, pid]);
        const res = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        return { ...u, token: res.json.token };
    }
    const ask = (u, body) => s.api('POST', '/api/chatbot/ask', { token: u.token, body });
    const usedNow = async u => (await s.pool.query('SELECT COALESCE(SUM(ai_queries_count),0)::int AS n FROM usage_meters WHERE user_id = $1', [u.id])).rows[0].n;
    // Başarısız/ücretsiz isteklerde rezervasyon yanıttan sonra, bağlantı kapanırken iade edilir: kısa süre bekle.
    const used = async u => {
        for (let i = 0; i < 20; i++) { const n = await usedNow(u); if (n === 0) return 0; await new Promise(r => setTimeout(r, 100)); }
        return usedNow(u);
    };

    it('oturumsuz 401; AI özelliği olmayan pakette 402/403', async () => {
        assert.equal((await s.api('POST', '/api/chatbot/ask', { body: { question: 'merhaba' } })).status, 401);
        const u = await userOn(planNo);
        const r = await ask(u, { question: 'merhaba' });
        assert.ok([402, 403].includes(r.status), String(r.status));
    });

    it('doğrulama: metin olmayan / boş / çok uzun soru 400', async () => {
        const u = await userOn(planAi);
        for (const q of [undefined, 123, {}, '', '   ', 'a'.repeat(501)]) {
            const r = await ask(u, { question: q });
            assert.equal(r.status, 400, JSON.stringify(q));
        }
    });

    it('yardım/tanıtım yanıtı ücretsizdir (kota düşmez) ve geçmişe yazılır', async () => {
        const u = await userOn(planAi);
        const h = await ask(u, { question: 'merhaba, neler sorabilirim?' });
        assert.equal(h.status, 200, h.text);
        assert.equal(h.json.intent, 'help');
        assert.ok(h.json.suggestions.length > 0);
        const a = await ask(u, { question: 'sen kimsin' });
        assert.equal(a.json.intent, 'about');
        assert.equal(await used(u), 0);
        const hist = await s.api('GET', '/api/chatbot/history', { token: u.token });
        assert.equal(hist.json.count, 2);
    });

    it('veri sorusu: veri yoksa ok:false ve kota düşmez; SQL yalnızca yöneticiye döner', async () => {
        const u = await userOn(planAi);
        const r = await ask(u, { question: '2025 yılında en çok satan marka hangisi?' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.ok, false);
        assert.equal(r.json.sql, undefined);
        assert.equal(await used(u), 0);
    });

    it('geçmiş kullanıcıya özeldir: istemci session_id verip başkasınınkini okuyamaz; silme yalnızca kendisini etkiler', async () => {
        const a = await userOn(planAi);
        const b = await userOn(planAi);
        await ask(a, { question: 'merhaba' });
        const peek = await s.api('GET', `/api/chatbot/history?session_id=web:${a.id}`, { token: b.token });
        assert.equal(peek.json.count, 0);
        const evil = await s.api('DELETE', '/api/chatbot/history', { token: b.token, body: { session_id: `web:${a.id}` } });
        assert.equal(evil.status, 200);
        assert.equal((await s.api('GET', '/api/chatbot/history', { token: a.token })).json.count, 1);
        await s.api('DELETE', '/api/chatbot/history', { token: a.token });
        assert.equal((await s.api('GET', '/api/chatbot/history', { token: a.token })).json.count, 0);
    });

    it('kullanıcı başına hız sınırı: dakikada 20', async () => {
        const u = await userOn(planAi);
        const codes = [];
        for (let i = 0; i < 22; i++) codes.push((await ask(u, { question: 'yardim' })).status);
        assert.equal(codes.filter(c => c === 429).length >= 1, true, codes.join(','));
        assert.equal(codes[0], 200);
    });
});
