'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');
const { validateProfileText, SAFE_EMAIL } = require('../src/lib/validate');

describe('girdi doğrulama (birim)', () => {
    it('SAFE_EMAIL işaretleme/boşluk içeren adresleri reddeder', () => {
        assert.ok(SAFE_EMAIL.test('ali.veli+x@firma.com.tr'));
        for (const bad of ['<svg/onload=alert(1)>@x.co', 'a"b@x.co', "a'b@x.co", 'a b@x.co', 'a@b', 'a@b.c']) assert.ok(!SAFE_EMAIL.test(bad), bad);
    });
    it('validateProfileText: < > ve uzunluk', () => {
        assert.equal(validateProfileText({ full_name: 'Ali Veli' }), null);
        assert.match(validateProfileText({ company_name: '<img src=x>' }), /karakterleri/);
        assert.match(validateProfileText({ phone: '1'.repeat(30) }), /en fazla/);
        assert.match(validateProfileText({ city: { a: 1 } }), /metin/);
    });
});

describe('kayıt girdi doğrulaması (HTTP)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brandId;
    before(async () => {
        s = await startServer();
        brandId = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 1')).rows[0].id;
    });
    after(async () => { if (s) await s.stop(); });
    const base = () => ({ email: `k_${Math.random().toString(36).slice(2)}@test.local`, password: 'Test-Pass-123!', full_name: 'Ali Veli', brand_id: brandId, company_name: 'Firma', job_title: 'Müdür', plan_slug: 'growth' });

    it('işaretleme içeren alanlar 400 döner', async () => {
        for (const f of ['company_name', 'city']) { // kayıt hız sınırı: saatte 5
            const r = await s.api('POST', '/api/auth/signup', { body: { ...base(), [f]: '<img src=x onerror=alert(1)>' } });
            assert.equal(r.status, 400, f);
        }
    });
    it('zararlı e-posta 400 döner', async () => {
        const r = await s.api('POST', '/api/auth/signup', { body: { ...base(), email: '<svg/onload=alert(1)>@x.co' } });
        assert.equal(r.status, 400);
    });
    it('geçerli kayıt başarılı', async () => {
        const r = await s.api('POST', '/api/auth/signup', { body: base() });
        assert.equal(r.status, 201, r.text);
    });
});
