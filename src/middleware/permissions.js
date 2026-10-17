'use strict';
// Ekip (staff) rol yetkileri. Superuser her yetkiye sahiptir; `role='admin'` ve `staff_role` NULL olan eski
// yöneticiler super_admin sayılır (migration 010 bunları açıkça super_admin yazar). ADMIN_PANEL_PLAN.md §3, §10.
const { logRouteError } = require('../lib/log-error');
const { pool } = require('../db');

// Yetki kataloğu (anahtar, Türkçe ad, açıklama).
const PERMISSIONS = [
    { key: 'dashboard.view', name: 'Genel bakış', description: 'Yönetim paneli genel bakış ekranını görüntüleme' },
    { key: 'orgs.read', name: 'Kurumları görüntüleme', description: 'Kurum listesi ve detaylarını, planları ve markaları görüntüleme' },
    { key: 'orgs.write', name: 'Kurumları yönetme', description: 'Kurum oluşturma/düzenleme, sözleşme, plan, koltuk, durum, alan adı ve özellik/limit istisnaları' },
    { key: 'members.write', name: 'Üyeleri yönetme', description: 'Kuruma üye ekleme/çıkarma, kurum yöneticisi atama ve kurum davetleri' },
    { key: 'users.read', name: 'Kullanıcıları görüntüleme', description: 'Kullanıcı listesi ve detaylarını görüntüleme' },
    { key: 'users.write', name: 'Kullanıcıları yönetme', description: 'Kullanıcıyı aktif/pasif yapma, elle (kartsız) abonelik tanımlama' },
    { key: 'features.manage', name: 'Özellikleri yönetme', description: 'Küresel özellik bayraklarını açma/kapatma' },
    { key: 'staff.manage', name: 'Ekibi yönetme', description: 'Ekip üyesi ekleme/çıkarma ve rol atama (super_admin atama ve rol düzenleme yalnızca superuser)' },
    { key: 'audit.read', name: 'Denetim kaydını görüntüleme', description: 'Yönetim denetim kaydını görüntüleme' }
];

const CATALOG_KEYS = PERMISSIONS.map(p => p.key);
const CATALOG_SET = new Set(CATALOG_KEYS);

// Kullanıcının ekip bağlamı. Bilinmeyen kullanıcı için tüm alanlar boş/false döner.
async function getStaffContext(db, userId) {
    const r = await db.query(
        `SELECT u.role, u.is_active, u.is_superuser, u.staff_role, r.name AS role_name, r.permissions
           FROM users u
           LEFT JOIN staff_roles r ON r.key = u.staff_role
          WHERE u.id = $1`,
        [userId]
    );
    const u = r.rows[0];
    if (!u) {
        return { is_admin: false, is_active: false, is_superuser: false, staff_role: null, role_name: null, permissions: [] };
    }
    const is_admin = u.role === 'admin';
    const is_superuser = u.is_superuser === true;
    const legacyAdmin = is_admin && u.staff_role == null;
    let perms = [];
    if (is_superuser || legacyAdmin) {
        perms = CATALOG_KEYS.slice();
    } else if (is_admin) {
        const raw = Array.isArray(u.permissions) ? u.permissions : [];
        if (raw.includes('*')) perms = CATALOG_KEYS.slice();
        else perms = [...new Set(raw.filter(k => typeof k === 'string' && CATALOG_SET.has(k)))];
    }
    return {
        is_admin,
        is_active: u.is_active !== false,
        is_superuser,
        staff_role: u.staff_role || null,
        role_name: u.role_name || null,
        permissions: perms
    };
}

// Tam yetkili mi? Superuser veya super_admin (ya da staff_role'u olmayan eski yönetici).
function isFullAdmin(staffCtx) {
    if (!staffCtx) return false;
    if (staffCtx.is_superuser) return true;
    if (staffCtx.staff_role === 'super_admin') return true;
    return staffCtx.is_admin === true && staffCtx.staff_role == null;
}

// Express ara katmanı. authMiddleware'den SONRA kullanılır. permKey null ise yalnızca aktif yönetici kontrolü yapar.
function requirePermission(permKey) {
    if (permKey != null && !CATALOG_SET.has(permKey)) {
        throw new Error(`requirePermission: bilinmeyen izin anahtarı: ${permKey}`);
    }
    return async function requirePermissionMiddleware(req, res, next) {
        let ctx;
        try {
            if (!req.user || req.user.id == null) return res.status(403).json({ error: 'Yetkisiz erişim' });
            ctx = await getStaffContext(pool, req.user.id);
        } catch (err) {
            logRouteError(req, err, 'requirePermission');
            return res.status(500).json({ error: 'Sunucu hatası' });
        }
        if (!ctx.is_admin || !ctx.is_active) return res.status(403).json({ error: 'Yetkisiz erişim' });
        if (permKey != null && !ctx.permissions.includes(permKey)) return res.status(403).json({ error: 'Yetkisiz erişim' });
        req.staff = ctx;
        next();
    };
}

// Yalnızca superuser. Yetki kataloğu veya super_admin rolü gerektiren işlemler için.
function requireSuperuser(req, res, next) {
    getStaffContext(pool, req && req.user ? req.user.id : null)
        .then(ctx => {
            if (!ctx.is_superuser || !ctx.is_active) return res.status(403).json({ error: 'Yetkisiz erişim' });
            req.staff = ctx;
            next();
        })
        .catch(err => {
            logRouteError(req, err, 'requireSuperuser');
            res.status(500).json({ error: 'Sunucu hatası' });
        });
}

module.exports = { PERMISSIONS, getStaffContext, requirePermission, requireSuperuser, isFullAdmin };
