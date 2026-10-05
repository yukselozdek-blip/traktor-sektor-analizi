'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');
const { validateProfileText, SAFE_EMAIL, isPrivateHost } = require('../src/lib/validate');

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

describe('SSRF: isPrivateHost', () => {
    it('iç ağ/loopback/metadata adreslerini reddeder, genel alan adlarını kabul eder', () => {
        for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', 'fd00::1', 'n8n', 'postgres', 'app.railway.internal', 'printer.local', '2130706433', '0x7f000001', '::ffff:127.0.0.1']) {
            assert.equal(isPrivateHost(h), true, h);
        }
        for (const h of ['www.example.com', 'commons.wikimedia.org', '8.8.8.8', 'cdn.tumosan.com.tr']) assert.equal(isPrivateHost(h), false, h);
    });
});

describe('kayıt girdi doğrulaması (HTTP)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brandId;
    before(async () => {
        s = await startServer();
        brandId = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 1')).rows[0].id;
        invite = await s.createInvite({ brandId });
    });
    after(async () => { if (s) await s.stop(); });
    let invite;
    const base = () => ({ invite_code: invite && invite.code, email: `k_${Math.random().toString(36).slice(2)}@test.local`, password: 'Test-Pass-123!', full_name: 'Ali Veli', brand_id: brandId, company_name: 'Firma', job_title: 'Müdür', plan_slug: 'growth' });

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
