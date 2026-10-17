'use strict';
// Yönetim konsolu (ADMIN_PANEL_PLAN.md §3, §7.1): izin katmanı, ekip rolleri, superuser kısıtları,
// kullanıcı durumu, elle abonelik, denetim kaydı ve girdi doğrulama.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const ALL_PERMS = ['audit.read', 'dashboard.view', 'features.manage', 'members.write', 'orgs.read', 'orgs.write', 'staff.manage', 'users.read', 'users.write'];
const VIEWER_PERMS = ['audit.read', 'dashboard.view', 'orgs.read', 'users.read'];
const futureDate = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe('yönetim konsolu (admin-console)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brandId, admin, brandUser, viewer, accountManager, superUser;
    let originalViewerPerms;

    // Ekip rolü atanmış yönetici: role='admin' + staff_role (yetkiler DB'den her istekte okunur).
    async function staffUser(staffRole) {
        const u = await s.createUserWithToken({ role: 'admin' });
        await s.pool.query('UPDATE users SET staff_role = $2 WHERE id = $1', [u.id, staffRole]);
        return u;
    }
    const auditItems = async (query = '') => {
        const r = await s.api('GET', `/api/admin/console/audit${query}`, { token: admin.token });
        assert.equal(r.status, 200, r.text);
        return r.json.items;
    };
    const orgBody = (name) => ({ name, brand_id: brandId, plan_slug: 'enterprise', seat_limit: 10 });

    before(async () => {
        s = await startServer();
        brandId = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Konsol Marka','konsol-marka',true) RETURNING id`)).rows[0].id;
        admin = await s.createUserWithToken({ role: 'admin' }); // staff_role NULL: eski yönetici (super_admin sayılır)
        brandUser = await s.createUserWithToken({ role: 'brand_user' });
        viewer = await staffUser('viewer');
        accountManager = await staffUser('account_manager');
        superUser = await s.createUserWithToken({ role: 'admin' });
        await s.pool.query('UPDATE users SET is_superuser = true WHERE id = $1', [superUser.id]);
        originalViewerPerms = (await s.pool.query(`SELECT permissions FROM staff_roles WHERE key = 'viewer'`)).rows[0].permissions;
    });
    after(async () => { if (s) await s.stop(); });

    it('1. /me: kullanıcı-olmayan yönetici 403; eski yönetici (staff_role NULL) 9 yetkinin tamamını alır', async () => {
        const denied = await s.api('GET', '/api/admin/console/me', { token: brandUser.token });
        assert.equal(denied.status, 403, denied.text);

        const r = await s.api('GET', '/api/admin/console/me', { token: admin.token });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.user.email, admin.email);
        assert.equal(r.json.is_superuser, false);
        assert.deepEqual([...r.json.permissions].sort(), ALL_PERMS);
    });

    it('2. süper değil ama ekip rolü viewer: salt okunur yetkiler; adminOnly rotası (davet kodları) 403', async () => {
        const me = await s.api('GET', '/api/admin/console/me', { token: viewer.token });
        assert.equal(me.status, 200, me.text);
        assert.deepEqual([...me.json.permissions].sort(), [...VIEWER_PERMS].sort());
        assert.equal(me.json.staff_role, 'viewer');

        assert.equal((await s.api('GET', '/api/admin/console/organizations', { token: viewer.token })).status, 200);
        const create = await s.api('POST', '/api/admin/console/organizations', { token: viewer.token, body: orgBody('Viewer Kurum') });
        assert.equal(create.status, 403, create.text);
        assert.equal((await s.api('GET', '/api/admin/console/staff', { token: viewer.token })).status, 403);

        // Mevcut adminOnly rotası: ekip rolleri geçemez, eski yönetici geçer.
        assert.equal((await s.api('GET', '/api/admin/invites', { token: viewer.token })).status, 403);
        assert.equal((await s.api('GET', '/api/admin/invites', { token: admin.token })).status, 200);
    });

    it('3. account_manager kurum oluşturabilir (201) ama ekip yönetemez (POST /staff 403)', async () => {
        const create = await s.api('POST', '/api/admin/console/organizations', { token: accountManager.token, body: orgBody('AM Kurum') });
        assert.equal(create.status, 201, create.text);
        const target = await s.createUser({ role: 'brand_user' });
        const staff = await s.api('POST', '/api/admin/console/staff', { token: accountManager.token, body: { email: target.email, staff_role: 'viewer' } });
        assert.equal(staff.status, 403, staff.text);
        const roles = await s.api('GET', '/api/admin/console/roles', { token: accountManager.token });
        assert.equal(roles.status, 403, roles.text);
    });

    it('4. ekip yönetimi (eski yönetici, süper değil): support atanır (role admin olur); super_admin verilemez; kendi rolü değiştirilemez', async () => {
        const target = await s.createUser({ role: 'brand_user' });
        const add = await s.api('POST', '/api/admin/console/staff', { token: admin.token, body: { email: target.email, staff_role: 'support' } });
        assert.equal(add.status, 201, add.text);
        const row = (await s.pool.query('SELECT role, staff_role FROM users WHERE id = $1', [target.id])).rows[0];
        assert.equal(row.role, 'admin');
        assert.equal(row.staff_role, 'support');

        const target2 = await s.createUser({ role: 'brand_user' });
        const grant = await s.api('POST', '/api/admin/console/staff', { token: admin.token, body: { email: target2.email, staff_role: 'super_admin' } });
        assert.equal(grant.status, 403, grant.text);
        assert.equal((await s.pool.query('SELECT role FROM users WHERE id = $1', [target2.id])).rows[0].role, 'brand_user');

        const self = await s.api('POST', '/api/admin/console/staff', { token: admin.token, body: { email: admin.email, staff_role: 'viewer' } });
        assert.equal(self.status, 403, self.text);
        assert.equal((await s.pool.query('SELECT staff_role FROM users WHERE id = $1', [admin.id])).rows[0].staff_role, null);

        const unverified = await s.createUser({ role: 'brand_user', verified: false });
        const uv = await s.api('POST', '/api/admin/console/staff', { token: admin.token, body: { email: unverified.email, staff_role: 'viewer' } });
        assert.equal(uv.status, 400, uv.text);
    });

    it('5. rol düzenleme yalnızca superuser: eski yönetici 403; superuser viewer’ı düzenler (200); super_admin ve sistem rolü değişmez', async () => {
        try {
            const denied = await s.api('PUT', '/api/admin/console/roles/viewer', { token: admin.token, body: { permissions: ['dashboard.view'] } });
            assert.equal(denied.status, 403, denied.text);
            const deniedCreate = await s.api('POST', '/api/admin/console/roles', { token: admin.token, body: { key: 'ozel_rol', name: 'Özel', permissions: [] } });
            assert.equal(deniedCreate.status, 403, deniedCreate.text);

            const ok = await s.api('PUT', '/api/admin/console/roles/viewer', { token: superUser.token, body: { permissions: ['dashboard.view'] } });
            assert.equal(ok.status, 200, ok.text);
            assert.deepEqual(ok.json.permissions, ['dashboard.view']);

            const superRole = await s.api('PUT', '/api/admin/console/roles/super_admin', { token: superUser.token, body: { name: 'Değişti' } });
            assert.equal(superRole.status, 403, superRole.text);
            const sysDelete = await s.api('DELETE', '/api/admin/console/roles/viewer', { token: superUser.token });
            assert.equal(sysDelete.status, 403, sysDelete.text);

            // Superuser, super_admin rolünü verebilir.
            const target = await s.createUser({ role: 'brand_user' });
            const grant = await s.api('POST', '/api/admin/console/staff', { token: superUser.token, body: { email: target.email, staff_role: 'super_admin' } });
            assert.equal(grant.status, 201, grant.text);
        } finally {
            await s.pool.query(`UPDATE staff_roles SET permissions = $1::jsonb WHERE key = 'viewer'`, [JSON.stringify(originalViewerPerms)]);
        }
    });

    it('6. kullanıcı pasife alınınca mevcut token 401; yeniden aktifleştirilince çalışır; kendi hesabı ve superuser değiştirilemez', async () => {
        const target = await s.createUserWithToken({ role: 'brand_user' });
        assert.equal((await s.api('GET', '/api/subscription', { token: target.token })).status, 200);

        const off = await s.api('POST', `/api/admin/console/users/${target.id}/status`, { token: admin.token, body: { is_active: false } });
        assert.equal(off.status, 200, off.text);
        const after401 = await s.api('GET', '/api/subscription', { token: target.token });
        assert.equal(after401.status, 401, after401.text);

        const on = await s.api('POST', `/api/admin/console/users/${target.id}/status`, { token: admin.token, body: { is_active: true } });
        assert.equal(on.status, 200, on.text);
        assert.equal((await s.api('GET', '/api/subscription', { token: target.token })).status, 200);

        const self = await s.api('POST', `/api/admin/console/users/${admin.id}/status`, { token: admin.token, body: { is_active: false } });
        assert.equal(self.status, 403, self.text);
        const sup = await s.api('POST', `/api/admin/console/users/${superUser.id}/status`, { token: admin.token, body: { is_active: false } });
        assert.equal(sup.status, 403, sup.text);
    });

    it('7. elle (kartsız) abonelik: gelecek tarihli dönem → GET /api/subscription plan aktif; geçmiş tarih 400', async () => {
        const target = await s.createUserWithToken({ role: 'brand_user' });
        const grant = await s.api('POST', `/api/admin/console/users/${target.id}/subscription`, {
            token: admin.token, body: { plan_slug: 'growth', period_end: futureDate(30) }
        });
        assert.equal(grant.status, 201, grant.text);
        assert.equal(grant.json.plan_slug, 'growth');

        const sub = await s.api('GET', '/api/subscription', { token: target.token });
        assert.equal(sub.status, 200, sub.text);
        assert.equal(sub.json.plan_slug, 'growth');
        assert.equal(sub.json.status, 'active');
        assert.equal(sub.json.is_entitled, true);

        const past = await s.api('POST', `/api/admin/console/users/${target.id}/subscription`, {
            token: admin.token, body: { plan_slug: 'growth', period_end: futureDate(-5) }
        });
        assert.equal(past.status, 400, past.text);
        const unknown = await s.api('POST', `/api/admin/console/users/${target.id}/subscription`, {
            token: admin.token, body: { plan_slug: 'yok-boyle-plan', period_end: futureDate(30) }
        });
        assert.equal(unknown.status, 400, unknown.text);
    });

    it('8. denetim kaydı: org.create ve staff.add yazılır; filtre çalışır; brand_user 403', async () => {
        const items = await auditItems();
        const actions = new Set(items.map(i => i.action));
        assert.ok(actions.has('org.create'), [...actions].join(','));
        assert.ok(actions.has('staff.add'), [...actions].join(','));
        assert.ok(actions.has('user.status'));
        assert.ok(actions.has('user.subscription.grant'));

        const filtered = await auditItems('?action=staff.add');
        assert.ok(filtered.length >= 1);
        assert.ok(filtered.every(i => i.action === 'staff.add'));

        const byActor = await auditItems(`?actor=${accountManager.id}`);
        assert.ok(byActor.some(i => i.action === 'org.create'), 'aktöre göre filtre');

        assert.equal((await s.api('GET', '/api/admin/console/audit', { token: viewer.token })).status, 200);
        assert.equal((await s.api('GET', '/api/admin/console/audit', { token: brandUser.token })).status, 403);
    });

    it('9. girdi doğrulama: geçersiz kurum kimliği 400; ad eksik kurum 400', async () => {
        const badId = await s.api('GET', '/api/admin/console/organizations/abc', { token: admin.token });
        assert.equal(badId.status, 400, badId.text);
        const noName = await s.api('POST', '/api/admin/console/organizations', {
            token: admin.token, body: { brand_id: brandId, plan_slug: 'enterprise', seat_limit: 2 }
        });
        assert.equal(noName.status, 400, noName.text);
    });
});
