'use strict';
// WhatsApp asistanı yalnızca onaylı + aktif abonelikli numaralara cevap verir.
// Gönderim, WHATSAPP_GRAPH_API_BASE ile yerel sahte Graph API sunucusuna yönlendirilir ve izlenir.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const WA_SECRET = 'wa-approval-secret';
const QUERY_KEY = 'q-key-approval';
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('whatsapp approval gate', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, graph, sent = [];
    let admin, brand, planWa, planNoWa, seq = 0;

    before(async () => {
        graph = http.createServer((req, res) => {
            let b = ''; req.on('data', d => b += d);
            req.on('end', () => { try { sent.push(JSON.parse(b)); } catch (_) { sent.push({}); } res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
        });
        await new Promise(r => graph.listen(0, '127.0.0.1', r));
        s = await startServer({ env: {
            WHATSAPP_APP_SECRET: WA_SECRET, WHATSAPP_QUERY_API_KEY: QUERY_KEY,
            WHATSAPP_ACCESS_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123',
            WHATSAPP_GRAPH_API_BASE: `http://127.0.0.1:${graph.address().port}`
        } });
        admin = await s.createUserWithToken({ role: 'admin' });
        brand = await s.createUserWithToken({ role: 'brand_user' });
        const mk = async (slug, limits) => (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits) VALUES ($1,$2,0,$3::jsonb) RETURNING id`,
            [slug, slug, JSON.stringify(limits)])).rows[0].id;
        planWa = await mk('wa-plan', { whatsapp_phones: 3 });
        planNoWa = await mk('nowa-plan', { whatsapp_phones: 0 });
    });
    after(async () => { if (graph) graph.close(); if (s) await s.stop(); });

    // Kullanıcı + abonelik + numara kurar; digits Meta biçimi (+'sız), DB'de '+' ile saklanır.
    async function setup({ approved = true, active = true, verified = true, status = 'active', plan = 'wa', noSub = false } = {}) {
        const u = await s.createUser({ active });
        await s.pool.query('UPDATE users SET email_verified = $1 WHERE id = $2', [verified, u.id]);
        let subId = null;
        if (!noSub) {
            subId = (await s.pool.query(
                `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1,$2,$3) RETURNING id`,
                [u.id, plan === 'wa' ? planWa : planNoWa, status])).rows[0].id;
        }
        const digits = '90555' + String(1000000 + (++seq) * 7).slice(0, 7) ;
        await s.pool.query(
            `INSERT INTO whatsapp_phones (user_id, subscription_id, phone_e164, admin_approved) VALUES ($1,$2,$3,$4)`,
            [u.id, subId, '+' + digits, approved]);
        return { u, digits };
    }

    async function webhook(from, text = 'merhaba') {
        const raw = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'X' } }], messages: [{ from, type: 'text', id: 'm1', text: { body: text } }] } }] }] });
        const sig = 'sha256=' + crypto.createHmac('sha256', WA_SECRET).update(raw).digest('hex');
        const r = await s.api('POST', '/api/public/whatsapp/webhook', { headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, rawBody: raw });
        assert.equal(r.status, 200);
        await sleep(700);
    }
    const sentTo = d => sent.filter(m => m.to === d);

    it('onaylı + aktif abonelikli numara -> cevap gönderilir', async () => {
        const { digits } = await setup();
        await webhook(digits);
        assert.equal(sentTo(digits).length, 1);
    });

    for (const [name, opts] of [
        ['onaysız numara', { approved: false }],
        ['pasif kullanıcı', { active: false }],
        ['e-postası doğrulanmamış', { verified: false }],
        ['pending abonelik', { status: 'pending' }],
        ['aboneliği olmayan', { noSub: true }],
        ['whatsapp özelliği olmayan plan', { plan: 'nowa' }]
    ]) {
        it(`${name} -> cevap yok`, async () => {
            const { digits } = await setup(opts);
            await webhook(digits);
            assert.equal(sentTo(digits).length, 0);
        });
    }

    it('kayıtsız numara -> cevap yok', async () => {
        await webhook('905550000000');
        assert.equal(sentTo('905550000000').length, 0);
    });

    it('loglar numarayı maskeler ve mesaj metnini içermez', async () => {
        const { digits } = await setup({ approved: false });
        await webhook(digits, 'gizli-soru-metni-xyz');
        const logs = s.logs();
        assert.ok(!logs.includes(digits), 'tam numara loglanmamalı');
        assert.ok(!logs.includes('gizli-soru-metni-xyz'), 'mesaj metni loglanmamalı');
        assert.ok(logs.includes(`son4=${digits.slice(-4)}`));
        assert.ok(logs.includes('neden=not_approved'));
    });

    it('sales-query: onaysız from -> 403, onaylı from -> 200, from yok -> 200 (eski davranış)', async () => {
        const bad = await setup({ approved: false });
        const good = await setup();
        const h = { 'x-query-token': QUERY_KEY };
        const r1 = await s.api('POST', '/api/public/assistant/sales-query', { headers: h, body: { question: 'merhaba', from: bad.digits } });
        assert.equal(r1.status, 403);
        assert.equal(r1.json.answer, '');
        assert.equal(r1.json.error, 'Numara onaylı değil');
        const r2 = await s.api('POST', '/api/public/assistant/sales-query', { headers: h, body: { question: 'merhaba', from: good.digits } });
        assert.equal(r2.status, 200);
        const r3 = await s.api('POST', '/api/public/assistant/sales-query', { headers: h, body: { question: 'merhaba' } });
        assert.equal(r3.status, 200);
    });

    it('admin API: brand_user 403, anonim 401, admin listeler / onaylar / reddeder', async () => {
        const { u } = await setup({ approved: false });
        const id = (await s.pool.query('SELECT id FROM whatsapp_phones WHERE user_id=$1', [u.id])).rows[0].id;
        assert.equal((await s.api('GET', '/api/admin/whatsapp-phones')).status, 401);
        assert.equal((await s.api('GET', '/api/admin/whatsapp-phones', { token: brand.token })).status, 403);
        assert.equal((await s.api('POST', `/api/admin/whatsapp-phones/${id}/approve`, { token: brand.token, body: {} })).status, 403);
        assert.equal((await s.api('POST', `/api/admin/whatsapp-phones/${id}/reject`, { token: brand.token, body: {} })).status, 403);

        let l = await s.api('GET', '/api/admin/whatsapp-phones?status=pending', { token: admin.token });
        assert.equal(l.status, 200);
        const row = l.json.phones.find(p => p.id === id);
        assert.ok(row && row.status === 'pending' && row.user_email === u.email && /^\*\*\*\d{4}$/.test(row.phone_masked));
        assert.equal((await s.api('POST', `/api/admin/whatsapp-phones/${id}/approve`, { token: admin.token, body: {} })).status, 200);
        l = await s.api('GET', '/api/admin/whatsapp-phones?status=approved', { token: admin.token });
        assert.ok(l.json.phones.some(p => p.id === id));
        assert.equal((await s.api('POST', `/api/admin/whatsapp-phones/${id}/reject`, { token: admin.token, body: {} })).status, 200);
        l = await s.api('GET', '/api/admin/whatsapp-phones?status=pending', { token: admin.token });
        assert.equal(l.json.phones.find(p => p.id === id).status, 'rejected');
        assert.equal((await s.api('POST', '/api/admin/whatsapp-phones/999999/approve', { token: admin.token, body: {} })).status, 404);
    });

    it('kullanıcı numara ekleyince approval=pending döner, listede görünür', async () => {
        const u = await s.createUserWithToken();
        await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1,$2,'active')`, [u.id, planWa]);
        const add = await s.api('POST', '/api/billing/whatsapp', { token: u.token, body: { phone_e164: '+90 555 111 22 33' } });
        assert.equal(add.status, 201);
        assert.equal(add.json.approval, 'pending');
        assert.equal(add.json.phone.phone_e164, '+905551112233');
        const list = await s.api('GET', '/api/billing/whatsapp', { token: u.token });
        assert.equal(list.json.phones[0].approval, 'pending');
    });
});
