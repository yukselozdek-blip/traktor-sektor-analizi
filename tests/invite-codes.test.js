'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');

const GENERIC = 'Davet kodu geçersiz, süresi dolmuş veya kullanılmış';
let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`; // signup hız sınırı IP başına

describe('davet kodları', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brandA, brandB, admin, brandUser;
    const signup = (invite_code, extra = {}) => s.api('POST', '/api/auth/signup', {
        headers: { 'X-Forwarded-For': nextIp() },
        body: {
            email: `i_${crypto.randomBytes(5).toString('hex')}@test.local`, password: TEST_PASSWORD, full_name: 'Ali Veli',
            company_name: 'Firma', job_title: 'Müdür', ...(invite_code === undefined ? {} : { invite_code }), ...extra
        }
    });
    before(async () => {
        s = await startServer();
        brandA = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Marka A','marka-a',true) RETURNING id`)).rows[0].id;
        brandB = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Marka B','marka-b',true) RETURNING id`)).rows[0].id;
        admin = await s.createUserWithToken({ role: 'admin' });
        brandUser = await s.createUserWithToken({ role: 'brand_user' });
    });
    after(async () => { if (s) await s.stop(); });

    it('kod yoksa / uydurma ise genel hata ile 400', async () => {
        for (const c of [undefined, '', 'TSA-AAAA-BBBB-CCCC']) {
            const r = await signup(c, { brand_id: brandA });
            assert.equal(r.status, 400);
            assert.equal(r.json.error, GENERIC);
        }
    });

    it('geçerli kod: marka koddan gelir (brand_id gönderilmese de), kod harcanır, tekrar kullanılamaz', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        const r = await signup(inv.code);
        assert.equal(r.status, 201, r.text);
        const u = (await s.pool.query('SELECT brand_id FROM users WHERE email = (SELECT email FROM users ORDER BY id DESC LIMIT 1)')).rows[0];
        assert.equal(u.brand_id, brandA);
        const again = await signup(inv.code, { brand_id: brandA });
        assert.equal(again.status, 400);
        assert.equal(again.json.error, GENERIC); // kullanılmış: hangisi olduğu sızmaz
    });

    it('küçük harf/boşluklu kod da kabul edilir', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        const r = await signup(' ' + inv.code.toLowerCase() + ' ');
        assert.equal(r.status, 201, r.text);
    });

    it('süresi dolmuş ve iptal edilmiş kod aynı genel hatayı verir', async () => {
        const expired = await s.createInvite({ brandId: brandA, expiresAt: new Date(Date.now() - 1000) });
        const revoked = await s.createInvite({ brandId: brandA, active: false });
        for (const inv of [expired, revoked]) {
            const r = await signup(inv.code, { brand_id: brandA });
            assert.equal(r.status, 400);
            assert.equal(r.json.error, GENERIC);
        }
    });

    it('marka uyuşmazlığı 400 ve kod HARCANMAZ', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        const r = await signup(inv.code, { brand_id: brandB });
        assert.equal(r.status, 400);
        // Kodun geçerli olduğu sızdırılmaz: mesaj, bilinmeyen kodla alınanla birebir aynı
        const unknown = await signup('TSA-AAAA-BBBB-CCCC', { brand_id: brandB });
        assert.equal(r.json.error, unknown.json.error);
        const used = (await s.pool.query('SELECT used_count FROM invite_codes WHERE id = $1', [inv.id])).rows[0].used_count;
        assert.equal(used, 0);
        const ok = await signup(inv.code, { brand_id: brandA });
        assert.equal(ok.status, 201, ok.text);
    });

    it('yarış: max_uses=1 koduyla 5 eşzamanlı kayıttan yalnızca biri başarılı', async () => {
        const inv = await s.createInvite({ brandId: brandA, maxUses: 1 });
        const rs = await Promise.all([1, 2, 3, 4, 5].map(() => signup(inv.code)));
        assert.equal(rs.filter(r => r.status === 201).length, 1, rs.map(r => r.status).join());
        assert.equal(rs.filter(r => r.status === 400).length, 4);
        const row = (await s.pool.query('SELECT used_count FROM invite_codes WHERE id = $1', [inv.id])).rows[0];
        assert.equal(row.used_count, 1);
    });

    it('kayıt başarısız olursa (e-posta kayıtlı) kod harcanmaz', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        const r = await signup(inv.code, { email: brandUser.email });
        assert.equal(r.status, 409);
        assert.equal((await s.pool.query('SELECT used_count FROM invite_codes WHERE id = $1', [inv.id])).rows[0].used_count, 0);
    });

    it('admin API: oluşturma kodu bir kez döner, DB hash saklar, listede hash/kod yok, iptal çalışır', async () => {
        const c = await s.api('POST', '/api/admin/invites', { token: admin.token, body: { brand_id: brandA, max_uses: 3, expires_in_days: 7, note: 'test' } });
        assert.equal(c.status, 201, c.text);
        assert.match(c.json.code, /^TSA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        assert.equal(c.json.max_uses, 3);
        assert.ok(c.json.expires_at);
        const row = (await s.pool.query('SELECT * FROM invite_codes WHERE id = $1', [c.json.id])).rows[0];
        assert.equal(row.code_hash, crypto.createHash('sha256').update(c.json.code.replace(/-/g, '')).digest('hex'));
        assert.ok(!JSON.stringify(row).includes(c.json.code));
        assert.equal(row.code_hint, c.json.code.replace(/-/g, '').slice(-4));
        const l = await s.api('GET', '/api/admin/invites', { token: admin.token });
        assert.equal(l.status, 200);
        const item = l.json.find(i => i.id === c.json.id);
        assert.equal(item.brand_name, 'Marka A');
        assert.ok(!l.text.includes(c.json.code) && !l.text.includes(row.code_hash) && !/code_hash/.test(l.text));
        // oluşturulan kod gerçekten kayıt için çalışır, sonra iptal
        const rv = await s.api('POST', `/api/admin/invites/${c.json.id}/revoke`, { token: admin.token });
        assert.equal(rv.status, 200);
        const r = await signup(c.json.code, { brand_id: brandA });
        assert.equal(r.status, 400);
    });

    it('admin API: brand_user 403, anonim 401, geçersiz girdi 400', async () => {
        for (const [m, p, body] of [['POST', '/api/admin/invites', { brand_id: brandA }], ['GET', '/api/admin/invites'], ['POST', '/api/admin/invites/1/revoke', {}]]) {
            assert.equal((await s.api(m, p, { token: brandUser.token, body })).status, 403, p);
            assert.equal((await s.api(m, p, { body })).status, 401, p);
        }
        assert.equal((await s.api('POST', '/api/admin/invites', { token: admin.token, body: { brand_id: 'x' } })).status, 400);
        assert.equal((await s.api('POST', '/api/admin/invites', { token: admin.token, body: { brand_id: brandA, max_uses: 0 } })).status, 400);
    });
});
