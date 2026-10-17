'use strict';
// Kurumsal sözleşme (ADMIN_PANEL_PLAN.md §5, §6, §7.1, §7.2) uçtan uca: kurum oluşturma, alan adıyla kayıt,
// koltuk kotası, sözleşme/özellik yetkilendirmesi, faturalama engeli, davet yolu ve kurum yöneticisi self-servisi.
// Testler sıralıdır (node:test describe içinde sırayla çalışır); sonraki adımlar önceki adımların durumuna dayanır.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');

let ipSeq = 0;
const nextIp = () => `10.88.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`; // signup/login hız sınırı IP başına

describe('kurumsal sözleşme (organizations)', { skip: SKIP_DB && SKIP_REASON }, () => {
    const DOMAIN = 'deere-test.com';
    let s, admin, brandId, otherBrandId, orgId, orgId2;
    let x1Token, x2Token;

    // Davet kodu OLMADAN kayıt (kurum eşleşmesi e-posta alan adı / davet ile yapılır).
    const signup = (email) => s.api('POST', '/api/auth/signup', {
        headers: { 'X-Forwarded-For': nextIp() },
        body: { email, password: TEST_PASSWORD, full_name: 'Kurum Kullanıcısı', company_name: 'Firma A.Ş.', job_title: 'Mühendis' }
    });

    // E-posta doğrulaması zorunlu: doğrulayıp giriş yapar, JWT döner.
    async function verifyAndLogin(email) {
        await s.pool.query('UPDATE users SET email_verified = true WHERE email = $1', [email]);
        const r = await s.api('POST', '/api/auth/login', { headers: { 'X-Forwarded-For': nextIp() }, body: { email, password: TEST_PASSWORD } });
        assert.equal(r.status, 200, r.text);
        return r.json.token;
    }
    const userRow = async (email) => (await s.pool.query('SELECT id, brand_id FROM users WHERE email = $1', [email])).rows[0];
    const memberRow = async (email) => (await s.pool.query(
        `SELECT m.organization_id, m.member_role, m.joined_via
           FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
        [email]
    )).rows[0];
    const setContractEnd = (sql) => s.pool.query(`UPDATE organizations SET contract_end = ${sql} WHERE id = $1`, [orgId]);

    before(async () => {
        s = await startServer();
        brandId = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Deere Test Marka','deere-test-marka',true) RETURNING id`)).rows[0].id;
        otherBrandId = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Diğer Marka','diger-marka-test',true) RETURNING id`)).rows[0].id;
        // Plan: seed edilmiş 'enterprise' (media_watch dahil) olmalı.
        const plan = await s.pool.query(`SELECT feature_keys FROM subscription_plans WHERE slug = 'enterprise' AND is_active = true`);
        assert.equal(plan.rows.length, 1, "seed'de 'enterprise' planı yok");
        assert.ok(plan.rows[0].feature_keys.includes('media_watch'), "'enterprise' planında media_watch yok");
        admin = await s.createUserWithToken({ role: 'admin' }); // staff_role NULL: eski yönetici (super_admin sayılır)
    });
    after(async () => { if (s) await s.stop(); });

    it('1. admin kurum oluşturur (plan enterprise, koltuk 2, alan adı deere-test.com) → 201', async () => {
        const r = await s.api('POST', '/api/admin/console/organizations', {
            token: admin.token,
            body: { name: 'Deere Test A.Ş.', brand_id: brandId, plan_slug: 'enterprise', seat_limit: 2, domains: [DOMAIN] }
        });
        assert.equal(r.status, 201, r.text);
        orgId = r.json.id;
        assert.equal(r.json.plan_slug, 'enterprise');
        assert.equal(r.json.seat_limit, 2);
        assert.equal(r.json.status, 'active');
        assert.deepEqual(r.json.domains.map(d => d.domain), [DOMAIN]);
        const audit = await s.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'org.create' AND target_id = $1`, [String(orgId)]);
        assert.equal(audit.rowCount, 1);
    });

    it('2. alan adıyla şifreli kayıt (davet kodu yok) → 201; marka kurumdan gelir, üyelik açılır, kişisel abonelik açılmaz', async () => {
        const r = await signup('x1@deere-test.com');
        assert.equal(r.status, 201, r.text);
        const u = await userRow('x1@deere-test.com');
        assert.equal(u.brand_id, brandId);
        const m = await memberRow('x1@deere-test.com');
        assert.equal(m.organization_id, orgId);
        assert.equal(m.member_role, 'member');
        assert.equal(m.joined_via, 'domain');
        const subs = await s.pool.query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1', [u.id]);
        assert.equal(subs.rows[0].n, 0);
    });

    it('3. eşleşmeyen alan adı ve davet kodu yok → 400, kullanıcı oluşmaz', async () => {
        const r = await signup('dis@example-other.com');
        assert.equal(r.status, 400, r.text);
        assert.equal(await userRow('dis@example-other.com'), undefined);
    });

    it('4. koltuk kotası: 2. kayıt başarılı; 3. kayıt 403 ORG_SEATS_FULL ve kullanıcı oluşmaz', async () => {
        const r2 = await signup('x2@deere-test.com');
        assert.equal(r2.status, 201, r2.text);
        const r3 = await signup('x3@deere-test.com');
        assert.equal(r3.status, 403, r3.text);
        assert.equal(r3.json.code, 'ORG_SEATS_FULL');
        assert.equal(await userRow('x3@deere-test.com'), undefined);
        const d = await s.api('GET', `/api/admin/console/organizations/${orgId}`, { token: admin.token });
        assert.equal(d.status, 200, d.text);
        assert.equal(d.json.seats_used, 2);
    });

    it('5. doğrulanmış üye: /api/subscription source=organization; media_watch kapısı 402 değil (200)', async () => {
        x1Token = await verifyAndLogin('x1@deere-test.com');
        const sub = await s.api('GET', '/api/subscription', { token: x1Token });
        assert.equal(sub.status, 200, sub.text);
        assert.equal(sub.json.source, 'organization');
        assert.equal(sub.json.organization_id, orgId);
        assert.equal(sub.json.plan_slug, 'enterprise');
        assert.equal(sub.json.is_entitled, true);
        assert.ok(sub.json.feature_keys.includes('media_watch'));
        const mw = await s.api('GET', '/api/media-watch/overview', { token: x1Token });
        assert.notEqual(mw.status, 402, mw.text);
        assert.equal(mw.status, 200, mw.text);
    });

    it('6. sözleşme bitişi dün → erişim kapanır (402); bugün son gündür, geçerli; süresiz (NULL) geçerli', async () => {
        await setContractEnd(`CURRENT_DATE - 1`);
        const sub = await s.api('GET', '/api/subscription', { token: x1Token });
        assert.equal(sub.status, 200, sub.text);
        assert.ok(!sub.json || sub.json.source !== 'organization', 'süresi dolan kurum aboneliği dönmemeli');
        assert.ok(!sub.json || sub.json.is_entitled !== true);
        const expired = await s.api('GET', '/api/media-watch/overview', { token: x1Token });
        assert.equal(expired.status, 402, expired.text);
        assert.equal(expired.json.code, 'NO_ACTIVE_SUBSCRIPTION');

        await setContractEnd(`CURRENT_DATE`); // bitiş günü dahil geçerlidir
        assert.equal((await s.api('GET', '/api/media-watch/overview', { token: x1Token })).status, 200);

        await setContractEnd(`NULL`); // süresiz
        assert.equal((await s.api('GET', '/api/media-watch/overview', { token: x1Token })).status, 200);
    });

    it('7. küresel bayrak: media_watch kapalı → üyeye 403 FEATURE_DISABLED; açılınca erişim geri gelir', async () => {
        const off = await s.api('PUT', '/api/admin/console/features/media_watch', { token: admin.token, body: { is_enabled: false } });
        assert.equal(off.status, 200, off.text);
        const blocked = await s.api('GET', '/api/media-watch/overview', { token: x1Token });
        assert.equal(blocked.status, 403, blocked.text);
        assert.equal(blocked.json.code, 'FEATURE_DISABLED');
        const sub = await s.api('GET', '/api/subscription', { token: x1Token });
        assert.ok(!sub.json.feature_keys.includes('media_watch'), 'kapalı bayrak /api/subscription yanıtında olmamalı');

        const on = await s.api('PUT', '/api/admin/console/features/media_watch', { token: admin.token, body: { is_enabled: true } });
        assert.equal(on.status, 200, on.text);
        assert.equal((await s.api('GET', '/api/media-watch/overview', { token: x1Token })).status, 200);
    });

    it('8. kurum kaynaklı abonelik kartla iptal edilemez: POST /api/billing/cancel → 409 ORG_MANAGED', async () => {
        const r = await s.api('POST', '/api/billing/cancel', { token: x1Token, body: {} });
        assert.equal(r.status, 409, r.text);
        assert.equal(r.json.code, 'ORG_MANAGED');
    });

    it('9. davet yolu: koltuk 3 yapılır; alan dışı e-posta davet edilir (invited); kayıtta kuruma üye olur', async () => {
        const put = await s.api('PUT', `/api/admin/console/organizations/${orgId}`, { token: admin.token, body: { seat_limit: 3 } });
        assert.equal(put.status, 200, put.text);
        assert.equal(put.json.seat_limit, 3);

        const inv = await s.api('POST', `/api/admin/console/organizations/${orgId}/members`, {
            token: admin.token, body: { email: 'danisman@gmail.com' }
        });
        assert.equal(inv.status, 201, inv.text);
        assert.equal(inv.json.result, 'invited');

        const r = await signup('danisman@gmail.com');
        assert.equal(r.status, 201, r.text);
        const m = await memberRow('danisman@gmail.com');
        assert.equal(m.organization_id, orgId);
        assert.equal(m.joined_via, 'invitation');
        assert.equal((await userRow('danisman@gmail.com')).brand_id, brandId);
        const invRow = (await s.pool.query(
            `SELECT status FROM organization_invitations WHERE organization_id = $1 AND email = 'danisman@gmail.com'`, [orgId]
        )).rows[0];
        assert.equal(invRow.status, 'accepted');

        // Davetsiz ve alan dışı gmail kaydı hâlâ reddedilir.
        assert.equal((await signup('baska@gmail.com')).status, 400);
    });

    it('10. alan adı doğrulaması: gmail.com → 400; aynı alan adı ikinci kuruma → 409', async () => {
        const g = await s.api('POST', `/api/admin/console/organizations/${orgId}/domains`, { token: admin.token, body: { domain: 'gmail.com' } });
        assert.equal(g.status, 400, g.text);

        const o2 = await s.api('POST', '/api/admin/console/organizations', {
            token: admin.token, body: { name: 'İkinci Kurum', brand_id: otherBrandId, plan_slug: 'enterprise', seat_limit: 5 }
        });
        assert.equal(o2.status, 201, o2.text);
        orgId2 = o2.json.id;

        const dup = await s.api('POST', `/api/admin/console/organizations/${orgId2}/domains`, { token: admin.token, body: { domain: DOMAIN } });
        assert.equal(dup.status, 409, dup.text);
    });

    it('11. kurum yöneticisi (org_admin): /api/org/me çalışır; /api/org/members düz üyeye 403, org_admin’e 200', async () => {
        const x1 = await userRow('x1@deere-test.com');
        const promote = await s.api('PUT', `/api/admin/console/organizations/${orgId}/members/${x1.id}`, {
            token: admin.token, body: { member_role: 'org_admin' }
        });
        assert.equal(promote.status, 200, promote.text);

        x2Token = await verifyAndLogin('x2@deere-test.com');

        const me = await s.api('GET', '/api/org/me', { token: x1Token });
        assert.equal(me.status, 200, me.text);
        assert.equal(me.json.member_role, 'org_admin');
        assert.equal(me.json.organization.id, orgId);
        assert.equal(me.json.organization.seats_used, 3);
        assert.equal(me.json.organization.seat_limit, 3);

        const meMember = await s.api('GET', '/api/org/me', { token: x2Token });
        assert.equal(meMember.status, 200, meMember.text);
        assert.equal(meMember.json.member_role, 'member');

        const denied = await s.api('GET', '/api/org/members', { token: x2Token });
        assert.equal(denied.status, 403, denied.text);

        const list = await s.api('GET', '/api/org/members', { token: x1Token });
        assert.equal(list.status, 200, list.text);
        assert.ok(list.text.includes('x2@deere-test.com') && list.text.includes('danisman@gmail.com'), list.text);
    });
});
