'use strict';
// Yönetim konsolu API'si (ADMIN_PANEL_PLAN.md §7.1). Her rota authMiddleware + requirePermission(...) ile korunur.
// Hata sözleşmesi: doğrulama → 400, yetki → 403, çakışma → 409, beklenmeyen hata → 500 + logRouteError.
// Tüm kullanıcı girdileri parametre olarak gider; SQL metnine değer birleştirilmez.
const { requirePermission, requireSuperuser, PERMISSIONS, getStaffContext } = require('../middleware/permissions');
const {
    ORG_EFFECTIVE_SQL, parseJsonish, mergeFeatureKeys, mergeLimits, normalizeDomain,
    PUBLIC_EMAIL_DOMAINS, countSeatsUsed, addMemberWithSeatCheck, invalidateFeatureFlagCache
} = require('../lib/org-entitlements');
const { logAdminAudit } = require('../lib/admin-audit');
const { logRouteError } = require('../lib/log-error');

const ID_RE = /^\d{1,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;
const STAFF_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;
const FEATURE_KEY_RE = /^[a-z0-9_]{1,100}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const ORG_STATUSES = ['trial', 'active', 'suspended', 'expired'];
const BILLING_TYPES = ['contract', 'invoice', 'card', 'free'];
const MEMBER_ROLES = ['member', 'org_admin'];
const LIMIT_KEYS = ['max_rivals', 'history_months', 'ai_queries_monthly', 'export_rows_monthly', 'api_requests_monthly', 'whatsapp_phones'];
const PAGE_SIZE = 50;
const MAX_LIMIT_VALUE = 1000000000;
const MAX_DOMAIN_LEN = 253;
const MAX_BULK_DOMAINS = 50;

// ---------- hata ve yardımcılar ----------
class HttpError extends Error {
    constructor(status, body) {
        super(body.error);
        this.httpStatus = status;
        this.body = body;
    }
}

function fail(status, error, extra) {
    throw new HttpError(status, Object.assign({ error }, extra || {}));
}

function sendError(req, res, err, label, conflictMsg) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json(err.body);
    if (err && err.code === '23505' && conflictMsg) return res.status(409).json({ error: conflictMsg });
    logRouteError(req, err, label);
    return res.status(500).json({ error: 'Sunucu hatası' });
}

async function withTx(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const qs = (v) => (typeof v === 'string' ? v.trim() : '');
const actorIsSuper = (req) => !!(req.staff && req.staff.is_superuser);
const todayIso = () => new Date().toISOString().slice(0, 10);
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

function parseId(value) {
    const s = value == null ? '' : String(value);
    if (!ID_RE.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
}

function idParam(value, message) {
    const id = parseId(value);
    if (!id) fail(400, message || 'Geçersiz kimlik');
    return id;
}

function optText(value, max, label) {
    if (value == null) return null;
    if (typeof value !== 'string') fail(400, `${label} metin olmalı`);
    const s = value.trim();
    if (s.length > max) fail(400, `${label} en fazla ${max} karakter olabilir`);
    return s === '' ? null : s;
}

function reqText(value, max, label) {
    const s = optText(value, max, label);
    if (!s) fail(400, `${label} zorunludur`);
    return s;
}

function enumValue(value, allowed, label) {
    if (typeof value !== 'string' || !allowed.includes(value)) fail(400, `${label} geçersiz`);
    return value;
}

function optBool(value, label) {
    if (typeof value !== 'boolean') fail(400, `${label} doğru/yanlış olmalı`);
    return value;
}

function toInt(value, label, min, max) {
    let n = NaN;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^-?\d{1,10}$/.test(value.trim())) n = Number(value.trim());
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} ${min} ile ${max} arasında tam sayı olmalı`);
    return n;
}

function optDate(value, label) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !DATE_RE.test(value)) fail(400, `${label} YYYY-AA-GG biçiminde olmalı`);
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail(400, `${label} geçerli bir tarih olmalı`);
    return value;
}

function pageParam(value) {
    if (value == null || value === '') return 1;
    const s = String(value);
    if (!/^\d{1,5}$/.test(s) || Number(s) < 1) fail(400, 'Geçersiz sayfa numarası');
    return Number(s);
}

function slugify(name) {
    return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 100).replace(/-+$/, '');
}

function checkSlug(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!SLUG_RE.test(s)) fail(400, 'Kısa ad (slug) küçük harf, rakam ve tireden oluşmalı (2-100 karakter)');
    return s;
}

function parseKeyList(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value)) fail(400, `${label} bir dizi olmalı`);
    if (value.length > 100) fail(400, `${label} en fazla 100 öğe içerebilir`);
    const out = new Set();
    for (const k of value) {
        if (typeof k !== 'string' || !FEATURE_KEY_RE.test(k)) fail(400, `${label} içinde geçersiz özellik anahtarı var`);
        out.add(k);
    }
    return [...out];
}

function parseFeatureOverrides(value) {
    if (value == null) return { add: [], remove: [] };
    if (typeof value !== 'object' || Array.isArray(value)) fail(400, 'Özellik istisnaları nesne olmalı');
    return {
        add: parseKeyList(value.add, 'Eklenen özellikler'),
        remove: parseKeyList(value.remove, 'Kaldırılan özellikler')
    };
}

function parseLimitOverrides(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) fail(400, 'Limit istisnaları nesne olmalı');
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (!LIMIT_KEYS.includes(k)) fail(400, 'Bilinmeyen limit anahtarı');
        out[k] = toInt(v, 'Limit değeri', -1, MAX_LIMIT_VALUE);
    }
    return out;
}

function normalizeOverrides(value) {
    const o = parseJsonish(value, {}) || {};
    return {
        add: Array.isArray(o.add) ? o.add : [],
        remove: Array.isArray(o.remove) ? o.remove : []
    };
}

function likeParam(s) {
    return `%${escapeLike(s)}%`;
}

function effectiveStaffRole(row) {
    if (row.role !== 'admin') return null;
    return row.staff_role || 'super_admin';
}

// Süper Yönetici rolü yalnızca üst yönetici (superuser) tarafından verilir veya alınır.
function assertCanTouchSuper(superActor, currentRole, nextRole) {
    if (!superActor && (currentRole === 'super_admin' || nextRole === 'super_admin')) {
        fail(403, 'Süper Yönetici rolünü yalnızca üst yönetici yönetebilir');
    }
}

async function assertStaffRole(db, key) {
    const r = await db.query('SELECT key FROM staff_roles WHERE key = $1', [key]);
    if (!r.rows.length) fail(400, 'Geçersiz rol');
}

function parseStaffRole(value) {
    if (typeof value !== 'string' || !STAFF_KEY_RE.test(value)) fail(400, 'Geçersiz rol');
    return value;
}

async function findActivePlan(db, slug) {
    const r = await db.query('SELECT id, slug, name, tier_rank FROM subscription_plans WHERE slug = $1 AND is_active = true', [slug]);
    if (!r.rows.length) fail(400, 'Geçersiz veya pasif plan');
    return r.rows[0];
}

async function ensureBrand(db, brandId) {
    const r = await db.query('SELECT id FROM brands WHERE id = $1', [brandId]);
    if (!r.rows.length) fail(400, 'Geçersiz marka');
}

// ---------- kurum okuma ----------
const ORG_COLS = `o.id, o.name, o.slug, o.brand_id, o.plan_id, o.seat_limit, o.status,
    to_char(o.contract_start, 'YYYY-MM-DD') AS contract_start, to_char(o.contract_end, 'YYYY-MM-DD') AS contract_end,
    o.billing_type, o.contract_ref, o.contact_name, o.contact_email, o.notes, o.auto_join,
    o.feature_overrides, o.limit_overrides, o.created_at, o.updated_at`;

async function loadOrgDetail(db, id) {
    const r = await db.query(
        `SELECT ${ORG_COLS}, b.name AS brand_name, p.slug AS plan_slug, p.name AS plan_name,
                p.feature_keys AS plan_feature_keys, p.plan_limits AS plan_limits,
                (${ORG_EFFECTIVE_SQL}) AS is_effective,
                (SELECT COUNT(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS seats_used
           FROM organizations o
           LEFT JOIN brands b ON b.id = o.brand_id
           LEFT JOIN subscription_plans p ON p.id = o.plan_id
          WHERE o.id = $1`,
        [id]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const featureOverrides = normalizeOverrides(row.feature_overrides);
    const limitOverrides = parseJsonish(row.limit_overrides, {}) || {};
    const [domains, members, invitations] = await Promise.all([
        db.query('SELECT id, domain, created_at FROM organization_domains WHERE organization_id = $1 ORDER BY domain', [id]),
        db.query(
            `SELECT u.id, u.email, u.full_name, m.member_role, u.email_verified, u.is_active, u.last_login, m.joined_via, m.created_at
               FROM organization_members m JOIN users u ON u.id = m.user_id
              WHERE m.organization_id = $1 ORDER BY m.created_at, u.id`,
            [id]
        ),
        db.query(
            `SELECT id, email, member_role, status, created_at FROM organization_invitations
              WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at`,
            [id]
        )
    ]);
    const { plan_feature_keys: planKeys, plan_limits: planLimits, ...org } = row;
    return {
        ...org,
        feature_overrides: featureOverrides,
        limit_overrides: limitOverrides,
        domains: domains.rows,
        members: members.rows,
        invitations: invitations.rows,
        effective_features: mergeFeatureKeys(parseJsonish(planKeys, []) || [], featureOverrides),
        effective_limits: mergeLimits(parseJsonish(planLimits, {}) || {}, limitOverrides)
    };
}

// Kurum alanlarını ayrıştırır. isCreate=true iken zorunlu alanlar doğrulanır; PUT'ta yalnızca gönderilenler döner.
function parseOrgInput(raw, isCreate, normEmail) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const has = (k) => b[k] !== undefined;
    const out = {};
    if (isCreate || has('name')) out.name = reqText(b.name, 200, 'Kurum adı');
    if (has('slug') && b.slug !== null && b.slug !== '') out.slug = checkSlug(b.slug);
    if (isCreate || has('brand_id')) {
        const brandId = parseId(b.brand_id);
        if (!brandId) fail(400, 'Geçerli bir marka seçin');
        out.brand_id = brandId;
    }
    if (isCreate || has('plan_slug')) out.plan_slug = reqText(b.plan_slug, 100, 'Plan');
    if (has('seat_limit')) out.seat_limit = toInt(b.seat_limit, 'Koltuk sayısı', 0, 100000);
    if (has('status')) out.status = enumValue(b.status, ORG_STATUSES, 'Durum');
    if (has('contract_start')) out.contract_start = optDate(b.contract_start, 'Sözleşme başlangıcı');
    if (has('contract_end')) out.contract_end = optDate(b.contract_end, 'Sözleşme bitişi');
    if (has('billing_type')) out.billing_type = enumValue(b.billing_type, BILLING_TYPES, 'Faturalama tipi');
    if (has('contract_ref')) out.contract_ref = optText(b.contract_ref, 100, 'Sözleşme referansı');
    if (has('contact_name')) out.contact_name = optText(b.contact_name, 200, 'İletişim adı');
    if (has('contact_email')) out.contact_email = b.contact_email == null || b.contact_email === '' ? null : normEmail(b.contact_email);
    if (has('notes')) out.notes = optText(b.notes, 2000, 'Notlar');
    if (has('auto_join')) out.auto_join = optBool(b.auto_join, 'Otomatik katılım');
    if (isCreate && b.domains != null) {
        if (!Array.isArray(b.domains)) fail(400, 'Alan adları bir dizi olmalı');
        if (b.domains.length > MAX_BULK_DOMAINS) fail(400, `En fazla ${MAX_BULK_DOMAINS} alan adı eklenebilir`);
        out.domains = [...new Set(b.domains.map(parseDomainInput))];
    }
    if (has('feature_overrides')) out.feature_overrides = parseFeatureOverrides(b.feature_overrides);
    if (has('limit_overrides')) out.limit_overrides = parseLimitOverrides(b.limit_overrides);
    return out;
}

function parseDomainInput(value) {
    const d = typeof value === 'string' ? normalizeDomain(value) : null;
    if (!d || d.length > MAX_DOMAIN_LEN || !DOMAIN_RE.test(d)) fail(400, 'Geçerli bir alan adı girin (ör. firma.com)');
    if (PUBLIC_EMAIL_DOMAINS.has(d)) fail(400, 'Genel e-posta sağlayıcıları kurum alan adı olarak eklenemez');
    return d;
}

function throwMemberError(code) {
    if (code === 'ORG_NOT_FOUND') fail(404, 'Kurum bulunamadı');
    if (code === 'ORG_SEATS_FULL') fail(403, 'Kurumun kullanıcı kotası dolu.', { code: 'ORG_SEATS_FULL' });
    if (code === 'ALREADY_MEMBER') fail(409, 'Bu kullanıcı zaten bir kurumun üyesi');
    fail(400, 'Üyelik eklenemedi');
}

module.exports = function registerAdminConsole(app, ctx) {
    const { pool, authMiddleware, invalidatePasswordChangedCache, SAFE_EMAIL } = ctx;
    const EMAIL_FALLBACK = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    const emailRe = SAFE_EMAIL instanceof RegExp ? SAFE_EMAIL : EMAIL_FALLBACK;
    const normEmail = (value) => {
        const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (!s || s.length > 254 || !emailRe.test(s)) fail(400, 'Geçerli bir e-posta adresi girin');
        return s;
    };
    const invalidateUser = (userId) => {
        if (typeof invalidatePasswordChangedCache === 'function') invalidatePasswordChangedCache(userId);
    };
    const permissionKeys = new Set(PERMISSIONS.map((p) => p.key));

    function parsePermissionList(value) {
        if (!Array.isArray(value)) fail(400, 'İzinler bir dizi olmalı');
        if (value.length > 50) fail(400, 'En fazla 50 izin tanımlanabilir');
        const out = new Set();
        for (const p of value) {
            if (typeof p !== 'string' || !permissionKeys.has(p)) fail(400, 'Geçersiz izin anahtarı');
            out.add(p);
        }
        return [...out];
    }

    // ---------- /me ----------
    app.get('/api/admin/console/me', authMiddleware, requirePermission(null), async (req, res) => {
        try {
            const staff = req.staff || (await getStaffContext(pool, req.user.id));
            const u = await pool.query('SELECT id, email, full_name FROM users WHERE id = $1', [req.user.id]);
            if (!u.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            res.json({
                user: { id: u.rows[0].id, email: u.rows[0].email, full_name: u.rows[0].full_name },
                is_superuser: !!staff.is_superuser,
                staff_role: staff.staff_role || null,
                role_name: staff.role_name || null,
                permissions: staff.permissions || []
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/me');
        }
    });

    // ---------- genel bakış ----------
    app.get('/api/admin/console/overview', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
        try {
            const [users, subs, orgByStatus, orgEffective, seats, expiring, audit] = await Promise.all([
                pool.query(`SELECT COUNT(*)::int AS total,
                                   COUNT(*) FILTER (WHERE is_active)::int AS active,
                                   COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d
                              FROM users`),
                pool.query(`SELECT COUNT(*)::int AS n FROM subscriptions
                             WHERE status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > NOW())`),
                pool.query('SELECT status, COUNT(*)::int AS n FROM organizations GROUP BY status ORDER BY status'),
                pool.query(`SELECT COUNT(*) FILTER (WHERE (${ORG_EFFECTIVE_SQL}))::int AS effective FROM organizations o`),
                pool.query(`SELECT COALESCE(SUM(o.seat_limit), 0)::int AS total,
                                   (SELECT COUNT(*)::int FROM organization_members) AS used
                              FROM organizations o`),
                pool.query(`SELECT o.id, o.name, o.slug, o.status, to_char(o.contract_end, 'YYYY-MM-DD') AS contract_end
                              FROM organizations o
                             WHERE o.contract_end IS NOT NULL AND o.contract_end >= CURRENT_DATE
                               AND o.contract_end <= CURRENT_DATE + INTERVAL '30 days'
                             ORDER BY o.contract_end, o.id LIMIT 50`),
                pool.query(`SELECT a.id, a.action, a.target_type, a.target_id, a.created_at, u.email AS actor_email
                              FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
                             ORDER BY a.id DESC LIMIT 10`)
            ]);
            res.json({
                users: users.rows[0],
                subscriptions: { active_personal: subs.rows[0].n },
                organizations: {
                    by_status: orgByStatus.rows,
                    effective: orgEffective.rows[0].effective
                },
                seats: seats.rows[0],
                expiring_contracts: expiring.rows,
                recent_audit: audit.rows
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/overview');
        }
    });

    // ---------- kurumlar ----------
    app.get('/api/admin/console/organizations', authMiddleware, requirePermission('orgs.read'), async (req, res) => {
        try {
            const q = qs(req.query.q);
            const status = qs(req.query.status);
            if (q.length > 100) fail(400, 'Arama metni en fazla 100 karakter olabilir');
            if (status && !ORG_STATUSES.includes(status)) fail(400, 'Durum geçersiz');
            const where = [];
            const params = [];
            if (q) {
                params.push(likeParam(q));
                const n = params.length;
                where.push(`(o.name ILIKE $${n} OR o.slug ILIKE $${n} OR EXISTS (SELECT 1 FROM organization_domains d WHERE d.organization_id = o.id AND d.domain ILIKE $${n}))`);
            }
            if (status) {
                params.push(status);
                where.push(`o.status = $${params.length}`);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const r = await pool.query(
                `SELECT o.id, o.name, o.slug, b.name AS brand_name, p.slug AS plan_slug, p.name AS plan_name,
                        o.seat_limit, o.status, to_char(o.contract_start, 'YYYY-MM-DD') AS contract_start,
                        to_char(o.contract_end, 'YYYY-MM-DD') AS contract_end,
                        (${ORG_EFFECTIVE_SQL}) AS is_effective,
                        (SELECT COUNT(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS seats_used,
                        COALESCE((SELECT json_agg(d.domain ORDER BY d.domain) FROM organization_domains d WHERE d.organization_id = o.id), '[]'::json) AS domains
                   FROM organizations o
                   LEFT JOIN brands b ON b.id = o.brand_id
                   LEFT JOIN subscription_plans p ON p.id = o.plan_id
                   ${whereSql}
                  ORDER BY o.name, o.id LIMIT 200`,
                params
            );
            res.json(r.rows);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/organizations');
        }
    });

    app.post('/api/admin/console/organizations', authMiddleware, requirePermission('orgs.write'), async (req, res) => {
        try {
            const input = parseOrgInput(body(req), true, normEmail);
            if (input.seat_limit === undefined) input.seat_limit = 5;
            const status = input.status || 'active';
            const billingType = input.billing_type || 'contract';
            const autoJoin = input.auto_join === undefined ? true : input.auto_join;
            const slug = input.slug || slugify(input.name);
            if (!SLUG_RE.test(slug)) fail(400, 'Kısa ad üretilemedi; lütfen bir kısa ad (slug) girin');
            if (input.contract_end && input.contract_start && input.contract_end < input.contract_start) {
                fail(400, 'Sözleşme bitişi başlangıçtan önce olamaz');
            }
            const domains = input.domains || [];
            const orgId = await withTx(pool, async (c) => {
                await ensureBrand(c, input.brand_id);
                const plan = await findActivePlan(c, input.plan_slug);
                for (const d of domains) {
                    const ex = await c.query('SELECT organization_id FROM organization_domains WHERE domain = $1', [d]);
                    if (ex.rows.length) fail(409, 'Bu alan adı başka bir kuruma bağlı', { domain: d });
                }
                const ins = await c.query(
                    `INSERT INTO organizations (name, slug, brand_id, plan_id, seat_limit, status, contract_start, contract_end,
                            billing_type, contract_ref, contact_name, contact_email, notes, auto_join, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15)
                     RETURNING id`,
                    [input.name, slug, input.brand_id, plan.id, input.seat_limit, status, input.contract_start || null,
                        input.contract_end || null, billingType, input.contract_ref || null, input.contact_name || null,
                        input.contact_email || null, input.notes || null, autoJoin, req.user.id]
                );
                const id = ins.rows[0].id;
                for (const d of domains) {
                    await c.query('INSERT INTO organization_domains (organization_id, domain) VALUES ($1, $2)', [id, d]);
                }
                return id;
            });
            await logAdminAudit(pool, req, 'org.create', 'organization', String(orgId), {
                name: input.name, slug, plan_slug: input.plan_slug, seat_limit: input.seat_limit, domains
            });
            const detail = await loadOrgDetail(pool, orgId);
            res.status(201).json(detail);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/organizations', 'Bu kısa ad (slug) zaten kullanılıyor');
        }
    });

    app.get('/api/admin/console/organizations/:id', authMiddleware, requirePermission('orgs.read'), async (req, res) => {
        try {
            const id = idParam(req.params.id);
            const detail = await loadOrgDetail(pool, id);
            if (!detail) return res.status(404).json({ error: 'Kurum bulunamadı' });
            res.json(detail);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/organizations/:id');
        }
    });

    app.put('/api/admin/console/organizations/:id', authMiddleware, requirePermission('orgs.write'), async (req, res) => {
        try {
            const id = idParam(req.params.id);
            const input = parseOrgInput(body(req), false, normEmail);
            await withTx(pool, async (c) => {
                const cur = await c.query(`SELECT ${ORG_COLS} FROM organizations o WHERE o.id = $1 FOR UPDATE`, [id]);
                if (!cur.rows.length) fail(404, 'Kurum bulunamadı');
                const row = cur.rows[0];
                const next = { ...row, ...input };
                if (input.brand_id !== undefined) await ensureBrand(c, input.brand_id);
                let planId = row.plan_id;
                if (input.plan_slug !== undefined) planId = (await findActivePlan(c, input.plan_slug)).id;
                if (next.contract_end && next.contract_start && next.contract_end < next.contract_start) {
                    fail(400, 'Sözleşme bitişi başlangıçtan önce olamaz');
                }
                const used = await countSeatsUsed(c, id);
                if (next.seat_limit < used) fail(400, `Koltuk sayısı mevcut üye sayısının (${used}) altına inemez`);
                const featureOverrides = input.feature_overrides !== undefined ? input.feature_overrides : normalizeOverrides(row.feature_overrides);
                const limitOverrides = input.limit_overrides !== undefined ? input.limit_overrides : (parseJsonish(row.limit_overrides, {}) || {});
                await c.query(
                    `UPDATE organizations SET name = $2, slug = $3, brand_id = $4, plan_id = $5, seat_limit = $6, status = $7,
                            contract_start = $8::date, contract_end = $9::date, billing_type = $10, contract_ref = $11,
                            contact_name = $12, contact_email = $13, notes = $14, auto_join = $15,
                            feature_overrides = $16::jsonb, limit_overrides = $17::jsonb, updated_at = NOW()
                      WHERE id = $1`,
                    [id, next.name, next.slug, next.brand_id, planId, next.seat_limit, next.status,
                        next.contract_start || null, next.contract_end || null, next.billing_type, next.contract_ref || null,
                        next.contact_name || null, next.contact_email || null, next.notes || null, next.auto_join,
                        JSON.stringify(featureOverrides), JSON.stringify(limitOverrides)]
                );
            });
            await logAdminAudit(pool, req, 'org.update', 'organization', String(id), { fields: Object.keys(input) });
            const detail = await loadOrgDetail(pool, id);
            res.json(detail);
        } catch (err) {
            sendError(req, res, err, 'PUT /api/admin/console/organizations/:id', 'Bu kısa ad (slug) zaten kullanılıyor');
        }
    });

    app.post('/api/admin/console/organizations/:id/domains', authMiddleware, requirePermission('orgs.write'), async (req, res) => {
        try {
            const id = idParam(req.params.id);
            const domain = parseDomainInput(body(req).domain);
            const row = await withTx(pool, async (c) => {
                const org = await c.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [id]);
                if (!org.rows.length) fail(404, 'Kurum bulunamadı');
                const ex = await c.query('SELECT organization_id FROM organization_domains WHERE domain = $1', [domain]);
                if (ex.rows.length) {
                    if (ex.rows[0].organization_id === id) fail(409, 'Bu alan adı zaten bu kuruma ekli');
                    fail(409, 'Bu alan adı başka bir kuruma bağlı');
                }
                const ins = await c.query(
                    'INSERT INTO organization_domains (organization_id, domain) VALUES ($1, $2) RETURNING id, domain, created_at',
                    [id, domain]
                );
                return ins.rows[0];
            });
            await logAdminAudit(pool, req, 'org.domain.add', 'organization', String(id), { domain });
            res.status(201).json(row);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/organizations/:id/domains', 'Bu alan adı zaten kayıtlı');
        }
    });

    app.delete('/api/admin/console/organizations/:id/domains/:domainId', authMiddleware, requirePermission('orgs.write'), async (req, res) => {
        try {
            const id = idParam(req.params.id);
            const domainId = idParam(req.params.domainId, 'Geçersiz alan adı kimliği');
            const r = await pool.query(
                'DELETE FROM organization_domains WHERE id = $1 AND organization_id = $2 RETURNING domain',
                [domainId, id]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Alan adı bulunamadı' });
            await logAdminAudit(pool, req, 'org.domain.remove', 'organization', String(id), { domain: r.rows[0].domain });
            res.json({ ok: true, id: domainId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/admin/console/organizations/:id/domains/:domainId');
        }
    });

    // ---------- kurum üyeleri ----------
    app.post('/api/admin/console/organizations/:id/members', authMiddleware, requirePermission('members.write'), async (req, res) => {
        try {
            const orgId = idParam(req.params.id);
            const email = normEmail(body(req).email);
            const rawRole = body(req).member_role;
            const memberRole = rawRole === undefined ? 'member' : enumValue(rawRole, MEMBER_ROLES, 'Üye rolü');
            const result = await withTx(pool, async (c) => {
                const org = await c.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
                if (!org.rows.length) fail(404, 'Kurum bulunamadı');
                const u = await c.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
                if (u.rows.length) {
                    const userId = u.rows[0].id;
                    const added = await addMemberWithSeatCheck(c, orgId, userId, { memberRole, joinedVia: 'admin', addedBy: req.user.id });
                    if (!added.ok) throwMemberError(added.code);
                    return { result: 'added', user_id: userId };
                }
                const inv = await c.query(
                    `INSERT INTO organization_invitations (organization_id, email, member_role, status, invited_by)
                     VALUES ($1, $2, $3, 'pending', $4)
                     ON CONFLICT (organization_id, email)
                     DO UPDATE SET status = 'pending', member_role = EXCLUDED.member_role, accepted_at = NULL, invited_by = EXCLUDED.invited_by
                     RETURNING id`,
                    [orgId, email, memberRole, req.user.id]
                );
                return { result: 'invited', invitation_id: inv.rows[0].id };
            });
            await logAdminAudit(pool, req, result.result === 'added' ? 'org.member.add' : 'org.member.invite', 'organization', String(orgId), {
                member_role: memberRole, result: result.result
            });
            res.status(201).json(result);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/organizations/:id/members');
        }
    });

    app.put('/api/admin/console/organizations/:id/members/:userId', authMiddleware, requirePermission('members.write'), async (req, res) => {
        try {
            const orgId = idParam(req.params.id);
            const userId = idParam(req.params.userId, 'Geçersiz kullanıcı kimliği');
            const memberRole = enumValue(body(req).member_role, MEMBER_ROLES, 'Üye rolü');
            const from = await withTx(pool, async (c) => {
                const cur = await c.query(
                    'SELECT member_role FROM organization_members WHERE organization_id = $1 AND user_id = $2 FOR UPDATE',
                    [orgId, userId]
                );
                if (!cur.rows.length) fail(404, 'Üyelik bulunamadı');
                await c.query(
                    'UPDATE organization_members SET member_role = $3 WHERE organization_id = $1 AND user_id = $2',
                    [orgId, userId, memberRole]
                );
                return cur.rows[0].member_role;
            });
            await logAdminAudit(pool, req, 'org.member.role', 'organization', String(orgId), {
                user_id: userId, from, to: memberRole
            });
            res.json({ ok: true, organization_id: orgId, user_id: userId, member_role: memberRole });
        } catch (err) {
            sendError(req, res, err, 'PUT /api/admin/console/organizations/:id/members/:userId');
        }
    });

    app.delete('/api/admin/console/organizations/:id/members/:userId', authMiddleware, requirePermission('members.write'), async (req, res) => {
        try {
            const orgId = idParam(req.params.id);
            const userId = idParam(req.params.userId, 'Geçersiz kullanıcı kimliği');
            const r = await pool.query(
                'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 RETURNING user_id',
                [orgId, userId]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Üyelik bulunamadı' });
            await logAdminAudit(pool, req, 'org.member.remove', 'organization', String(orgId), { user_id: userId });
            res.json({ ok: true, organization_id: orgId, user_id: userId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/admin/console/organizations/:id/members/:userId');
        }
    });

    app.delete('/api/admin/console/organizations/:id/invitations/:invId', authMiddleware, requirePermission('members.write'), async (req, res) => {
        try {
            const orgId = idParam(req.params.id);
            const invId = idParam(req.params.invId, 'Geçersiz davet kimliği');
            const r = await pool.query(
                `UPDATE organization_invitations SET status = 'revoked'
                  WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`,
                [invId, orgId]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Davet bulunamadı veya bekleyen durumda değil' });
            await logAdminAudit(pool, req, 'org.invitation.revoke', 'organization', String(orgId), { invitation_id: invId });
            res.json({ ok: true, id: invId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/admin/console/organizations/:id/invitations/:invId');
        }
    });

    app.post('/api/admin/console/organizations/:id/link-domain-users', authMiddleware, requirePermission('members.write'), async (req, res) => {
        try {
            const orgId = idParam(req.params.id);
            const result = await withTx(pool, async (c) => {
                const org = await c.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
                if (!org.rows.length) fail(404, 'Kurum bulunamadı');
                const doms = await c.query('SELECT domain FROM organization_domains WHERE organization_id = $1', [orgId]);
                if (!doms.rows.length) return { linked: 0, skipped_no_seat: 0 };
                const cands = await c.query(
                    `SELECT u.id FROM users u
                      WHERE split_part(LOWER(u.email), '@', 2) = ANY($1::text[])
                        AND u.role <> 'admin' AND COALESCE(u.is_superuser, false) = false
                        AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)
                      ORDER BY u.id`,
                    [doms.rows.map((d) => d.domain)]
                );
                let linked = 0;
                for (let i = 0; i < cands.rows.length; i++) {
                    const r = await addMemberWithSeatCheck(c, orgId, cands.rows[i].id, { memberRole: 'member', joinedVia: 'domain', addedBy: req.user.id });
                    if (r.ok) {
                        linked++;
                    } else if (r.code === 'ORG_SEATS_FULL') {
                        return { linked, skipped_no_seat: cands.rows.length - i };
                    }
                }
                return { linked, skipped_no_seat: 0 };
            });
            await logAdminAudit(pool, req, 'org.link_domain_users', 'organization', String(orgId), result);
            res.json(result);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/organizations/:id/link-domain-users');
        }
    });

    // ---------- kullanıcılar ----------
    app.get('/api/admin/console/users', authMiddleware, requirePermission('users.read'), async (req, res) => {
        try {
            const q = qs(req.query.q);
            const status = qs(req.query.status);
            const kind = qs(req.query.kind);
            const page = pageParam(req.query.page);
            if (q.length > 100) fail(400, 'Arama metni en fazla 100 karakter olabilir');
            if (status && status !== 'active' && status !== 'inactive') fail(400, 'Durum filtresi geçersiz');
            if (kind && kind !== 'staff' && kind !== 'customer') fail(400, 'Tür filtresi geçersiz');
            const where = [];
            const params = [];
            if (q) {
                params.push(likeParam(q));
                const n = params.length;
                where.push(`(u.email ILIKE $${n} OR u.full_name ILIKE $${n} OR u.company_name ILIKE $${n})`);
            }
            if (status === 'active') where.push('u.is_active = true');
            if (status === 'inactive') where.push('u.is_active = false');
            if (kind === 'staff') where.push(`u.role = 'admin'`);
            if (kind === 'customer') where.push(`u.role IS DISTINCT FROM 'admin'`);
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const offset = (page - 1) * PAGE_SIZE;
            const [count, list] = await Promise.all([
                pool.query(`SELECT COUNT(*)::int AS n FROM users u ${whereSql}`, params),
                pool.query(
                    `SELECT u.id, u.email, u.full_name, u.role, u.staff_role, u.is_superuser, u.is_active, u.email_verified,
                            b.name AS brand_name, m.organization_id, o.name AS organization_name, sp.slug AS plan_slug,
                            u.last_login, u.created_at
                       FROM users u
                       LEFT JOIN brands b ON b.id = u.brand_id
                       LEFT JOIN organization_members m ON m.user_id = u.id
                       LEFT JOIN organizations o ON o.id = m.organization_id
                       LEFT JOIN LATERAL (
                            SELECT p.slug FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
                             WHERE s.user_id = u.id AND s.status IN ('active','trialing')
                             ORDER BY s.id DESC LIMIT 1
                       ) sp ON true
                       ${whereSql}
                      ORDER BY u.id DESC
                      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                    [...params, PAGE_SIZE, offset]
                )
            ]);
            res.json({ items: list.rows, total: count.rows[0].n, page });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/users');
        }
    });

    app.get('/api/admin/console/users/:id', authMiddleware, requirePermission('users.read'), async (req, res) => {
        try {
            const id = idParam(req.params.id);
            const u = await pool.query(
                `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.staff_role, u.is_superuser, u.is_active,
                        u.email_verified, u.auth_provider, u.company_name, u.city, u.brand_id, b.name AS brand_name,
                        u.last_login, u.created_at
                   FROM users u LEFT JOIN brands b ON b.id = u.brand_id
                  WHERE u.id = $1`,
                [id]
            );
            if (!u.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            const [membership, subs, events] = await Promise.all([
                pool.query(
                    `SELECT m.organization_id, m.member_role, m.joined_via, o.name AS organization_name,
                            (${ORG_EFFECTIVE_SQL}) AS is_effective
                       FROM organization_members m JOIN organizations o ON o.id = m.organization_id
                      WHERE m.user_id = $1`,
                    [id]
                ),
                pool.query(
                    `SELECT s.id, p.slug AS plan_slug, p.name AS plan_name, s.status, s.provider,
                            s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.created_at
                       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
                      WHERE s.user_id = $1 ORDER BY s.id DESC LIMIT 10`,
                    [id]
                ),
                pool.query(
                    `SELECT id, event, ip_address, created_at FROM auth_audit
                      WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
                    [id]
                )
            ]);
            res.json({
                user: u.rows[0],
                organization: membership.rows[0] || null,
                subscriptions: subs.rows,
                auth_events: events.rows
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/users/:id');
        }
    });

    app.post('/api/admin/console/users/:id/status', authMiddleware, requirePermission('users.write'), async (req, res) => {
        try {
            const userId = idParam(req.params.id);
            const isActive = optBool(body(req).is_active, 'is_active');
            if (userId === req.user.id) fail(403, 'Kendi hesabınızın durumunu değiştiremezsiniz');
            await withTx(pool, async (c) => {
                const u = await c.query('SELECT id, role, staff_role, is_superuser FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (!u.rows.length) fail(404, 'Kullanıcı bulunamadı');
                const t = u.rows[0];
                if (t.is_superuser) fail(403, 'Üst yönetici durumu değiştirilemez');
                assertCanTouchSuper(actorIsSuper(req), effectiveStaffRole(t), null);
                await c.query('UPDATE users SET is_active = $2, updated_at = NOW() WHERE id = $1', [userId, isActive]);
            });
            invalidateUser(userId);
            await logAdminAudit(pool, req, 'user.status', 'user', String(userId), { is_active: isActive });
            res.json({ ok: true, id: userId, is_active: isActive });
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/users/:id/status');
        }
    });

    app.post('/api/admin/console/users/:id/subscription', authMiddleware, requirePermission('users.write'), async (req, res) => {
        try {
            const userId = idParam(req.params.id);
            const planSlug = reqText(body(req).plan_slug, 100, 'Plan');
            const periodEnd = optDate(body(req).period_end, 'Dönem bitişi');
            if (!periodEnd) fail(400, 'Dönem bitiş tarihi zorunludur');
            if (periodEnd < todayIso()) fail(400, 'Dönem bitiş tarihi bugünden önce olamaz');
            const result = await withTx(pool, async (c) => {
                const u = await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (!u.rows.length) fail(404, 'Kullanıcı bulunamadı');
                const plan = await findActivePlan(c, planSlug);
                const cancelled = await c.query(
                    `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
                      WHERE user_id = $1 AND status IN ('active','trialing','pending') RETURNING id`,
                    [userId]
                );
                const ins = await c.query(
                    `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                     VALUES ($1, $2, 'active', 'manual', NOW(), $3::date + INTERVAL '1 day' - INTERVAL '1 second')
                     RETURNING id, current_period_start, current_period_end`,
                    [userId, plan.id, periodEnd]
                );
                return {
                    id: ins.rows[0].id,
                    plan_slug: plan.slug,
                    current_period_start: ins.rows[0].current_period_start,
                    current_period_end: ins.rows[0].current_period_end,
                    cancelled_count: cancelled.rows.length
                };
            });
            await logAdminAudit(pool, req, 'user.subscription.grant', 'user', String(userId), {
                plan_slug: planSlug, period_end: periodEnd, cancelled_count: result.cancelled_count
            });
            res.status(201).json(result);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/users/:id/subscription');
        }
    });

    // ---------- ekip ----------
    app.get('/api/admin/console/staff', authMiddleware, requirePermission('staff.manage'), async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT u.id, u.email, u.full_name, u.staff_role, COALESCE(u.staff_role, 'super_admin') AS effective_staff_role,
                        r.name AS role_name, u.is_superuser, u.is_active, u.email_verified, u.last_login, u.created_at
                   FROM users u
                   LEFT JOIN staff_roles r ON r.key = COALESCE(u.staff_role, 'super_admin')
                  WHERE u.role = 'admin'
                  ORDER BY u.id`
            );
            res.json(r.rows);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/staff');
        }
    });

    app.post('/api/admin/console/staff', authMiddleware, requirePermission('staff.manage'), async (req, res) => {
        try {
            const email = normEmail(body(req).email);
            const staffRole = parseStaffRole(body(req).staff_role);
            const superActor = actorIsSuper(req);
            if (staffRole === 'super_admin' && !superActor) fail(403, 'Süper Yönetici rolünü yalnızca üst yönetici verebilir');
            const result = await withTx(pool, async (c) => {
                await assertStaffRole(c, staffRole);
                const u = await c.query(
                    'SELECT id, email, role, staff_role, is_superuser, email_verified FROM users WHERE LOWER(email) = $1 FOR UPDATE',
                    [email]
                );
                if (!u.rows.length) fail(404, 'Kullanıcı bulunamadı. Kişinin önce kayıt olması gerekir.');
                const t = u.rows[0];
                if (t.id === req.user.id) fail(403, 'Kendi rolünüzü değiştiremezsiniz');
                if (t.is_superuser) fail(403, 'Üst yönetici hedef olamaz');
                if (!t.email_verified) fail(400, 'Kullanıcının e-posta adresi doğrulanmamış');
                assertCanTouchSuper(superActor, effectiveStaffRole(t), staffRole);
                await c.query(`UPDATE users SET role = 'admin', staff_role = $2, updated_at = NOW() WHERE id = $1`, [t.id, staffRole]);
                return { id: t.id, email: t.email, staff_role: staffRole, previous_role: effectiveStaffRole(t) };
            });
            invalidateUser(result.id);
            await logAdminAudit(pool, req, 'staff.add', 'user', String(result.id), {
                staff_role: staffRole, previous_role: result.previous_role
            });
            res.status(201).json({ id: result.id, email: result.email, staff_role: staffRole });
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/staff');
        }
    });

    app.put('/api/admin/console/staff/:userId', authMiddleware, requirePermission('staff.manage'), async (req, res) => {
        try {
            const userId = idParam(req.params.userId, 'Geçersiz kullanıcı kimliği');
            const staffRole = parseStaffRole(body(req).staff_role);
            if (userId === req.user.id) fail(403, 'Kendi rolünüzü değiştiremezsiniz');
            const superActor = actorIsSuper(req);
            const previous = await withTx(pool, async (c) => {
                const u = await c.query('SELECT id, role, staff_role, is_superuser FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (!u.rows.length || u.rows[0].role !== 'admin') fail(404, 'Ekip üyesi bulunamadı');
                const t = u.rows[0];
                if (t.is_superuser) fail(403, 'Üst yönetici hedef olamaz');
                assertCanTouchSuper(superActor, effectiveStaffRole(t), staffRole);
                await assertStaffRole(c, staffRole);
                await c.query('UPDATE users SET staff_role = $2, updated_at = NOW() WHERE id = $1', [userId, staffRole]);
                return effectiveStaffRole(t);
            });
            invalidateUser(userId);
            await logAdminAudit(pool, req, 'staff.role.set', 'user', String(userId), { from: previous, to: staffRole });
            res.json({ ok: true, id: userId, staff_role: staffRole });
        } catch (err) {
            sendError(req, res, err, 'PUT /api/admin/console/staff/:userId');
        }
    });

    app.delete('/api/admin/console/staff/:userId', authMiddleware, requirePermission('staff.manage'), async (req, res) => {
        try {
            const userId = idParam(req.params.userId, 'Geçersiz kullanıcı kimliği');
            if (userId === req.user.id) fail(403, 'Kendi kaydınızı ekipten çıkaramazsınız');
            const superActor = actorIsSuper(req);
            const previous = await withTx(pool, async (c) => {
                const u = await c.query('SELECT id, role, staff_role, is_superuser FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (!u.rows.length || u.rows[0].role !== 'admin') fail(404, 'Ekip üyesi bulunamadı');
                const t = u.rows[0];
                if (t.is_superuser) fail(403, 'Üst yönetici hedef olamaz');
                assertCanTouchSuper(superActor, effectiveStaffRole(t), null);
                await c.query(`UPDATE users SET role = 'brand_user', staff_role = NULL, updated_at = NOW() WHERE id = $1`, [userId]);
                return effectiveStaffRole(t);
            });
            invalidateUser(userId);
            await logAdminAudit(pool, req, 'staff.remove', 'user', String(userId), { previous_role: previous });
            res.json({ ok: true, id: userId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/admin/console/staff/:userId');
        }
    });

    // ---------- roller (yalnızca superuser yazar) ----------
    app.get('/api/admin/console/roles', authMiddleware, requirePermission('staff.manage'), async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT r.key, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at,
                        (SELECT COUNT(*)::int FROM users u WHERE u.staff_role = r.key) AS user_count
                   FROM staff_roles r
                  ORDER BY r.is_system DESC, r.key`
            );
            res.json({
                roles: r.rows.map((x) => ({ ...x, permissions: parseJsonish(x.permissions, []) || [] })),
                permission_catalog: PERMISSIONS.map((p) => ({ key: p.key, name: p.name, description: p.description }))
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/roles');
        }
    });

    app.post('/api/admin/console/roles', authMiddleware, requirePermission('staff.manage'), requireSuperuser, async (req, res) => {
        try {
            const b = body(req);
            const key = parseStaffRole(b.key);
            const name = reqText(b.name, 100, 'Rol adı');
            const description = optText(b.description, 500, 'Açıklama');
            const permissions = parsePermissionList(b.permissions === undefined ? [] : b.permissions);
            const ins = await pool.query(
                `INSERT INTO staff_roles (key, name, description, permissions, is_system)
                 VALUES ($1, $2, $3, $4::jsonb, false)
                 RETURNING key, name, description, permissions, is_system, created_at, updated_at`,
                [key, name, description, JSON.stringify(permissions)]
            );
            await logAdminAudit(pool, req, 'role.create', 'staff_role', key, { name, permissions });
            res.status(201).json(ins.rows[0]);
        } catch (err) {
            sendError(req, res, err, 'POST /api/admin/console/roles', 'Bu rol anahtarı zaten var');
        }
    });

    app.put('/api/admin/console/roles/:key', authMiddleware, requirePermission('staff.manage'), requireSuperuser, async (req, res) => {
        try {
            const key = parseStaffRole(req.params.key);
            if (key === 'super_admin') fail(403, 'Süper Yönetici rolü değiştirilemez');
            const b = body(req);
            const hasName = b.name !== undefined;
            const hasDesc = b.description !== undefined;
            const hasPerms = b.permissions !== undefined;
            const name = hasName ? reqText(b.name, 100, 'Rol adı') : null;
            const description = hasDesc ? optText(b.description, 500, 'Açıklama') : null;
            const permissions = hasPerms ? parsePermissionList(b.permissions) : null;
            const updated = await withTx(pool, async (c) => {
                const cur = await c.query('SELECT key, name, description, permissions FROM staff_roles WHERE key = $1 FOR UPDATE', [key]);
                if (!cur.rows.length) fail(404, 'Rol bulunamadı');
                const row = cur.rows[0];
                const nextName = hasName ? name : row.name;
                const nextDesc = hasDesc ? description : row.description;
                const nextPerms = hasPerms ? permissions : (parseJsonish(row.permissions, []) || []);
                const r = await c.query(
                    `UPDATE staff_roles SET name = $2, description = $3, permissions = $4::jsonb, updated_at = NOW()
                      WHERE key = $1
                      RETURNING key, name, description, permissions, is_system, created_at, updated_at`,
                    [key, nextName, nextDesc, JSON.stringify(nextPerms)]
                );
                return r.rows[0];
            });
            await logAdminAudit(pool, req, 'role.update', 'staff_role', key, {
                changed: [hasName && 'name', hasDesc && 'description', hasPerms && 'permissions'].filter(Boolean)
            });
            res.json(updated);
        } catch (err) {
            sendError(req, res, err, 'PUT /api/admin/console/roles/:key');
        }
    });

    app.delete('/api/admin/console/roles/:key', authMiddleware, requirePermission('staff.manage'), requireSuperuser, async (req, res) => {
        try {
            const key = parseStaffRole(req.params.key);
            if (key === 'super_admin') fail(403, 'Süper Yönetici rolü silinemez');
            const sys = await pool.query('SELECT is_system FROM staff_roles WHERE key = $1', [key]);
            if (!sys.rows.length) return res.status(404).json({ error: 'Rol bulunamadı' });
            if (sys.rows[0].is_system) return res.status(403).json({ error: 'Sistem rolleri silinemez' });
            const used = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE staff_role = $1', [key]);
            if (used.rows[0].n > 0) return res.status(409).json({ error: 'Bu rolü kullanan ekip üyeleri var. Önce rollerini değiştirin.' });
            await pool.query('DELETE FROM staff_roles WHERE key = $1', [key]);
            await logAdminAudit(pool, req, 'role.delete', 'staff_role', key, {});
            res.json({ ok: true, key });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/admin/console/roles/:key');
        }
    });

    // ---------- özellik bayrakları, planlar, markalar ----------
    app.get('/api/admin/console/features', authMiddleware, requirePermission('orgs.read'), async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT f.key, f.name, f.description, f.is_enabled, f.updated_at,
                        COALESCE((SELECT json_agg(p.slug ORDER BY p.tier_rank, p.slug)
                                    FROM subscription_plans p
                                   WHERE p.is_active = true AND p.feature_keys ? f.key), '[]'::json) AS plans
                   FROM feature_flags f
                  ORDER BY f.name, f.key`
            );
            res.json(r.rows);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/features');
        }
    });

    app.put('/api/admin/console/features/:key', authMiddleware, requirePermission('features.manage'), async (req, res) => {
        try {
            const key = String(req.params.key || '');
            if (!FEATURE_KEY_RE.test(key)) fail(400, 'Geçersiz özellik anahtarı');
            const isEnabled = optBool(body(req).is_enabled, 'is_enabled');
            const r = await pool.query(
                `UPDATE feature_flags SET is_enabled = $2, updated_by = $3, updated_at = NOW()
                  WHERE key = $1 RETURNING key, name, is_enabled, updated_at`,
                [key, isEnabled, req.user.id]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Özellik bulunamadı' });
            invalidateFeatureFlagCache();
            await logAdminAudit(pool, req, 'feature.toggle', 'feature_flag', key, { is_enabled: isEnabled });
            res.json(r.rows[0]);
        } catch (err) {
            sendError(req, res, err, 'PUT /api/admin/console/features/:key');
        }
    });

    app.get('/api/admin/console/plans', authMiddleware, requirePermission('orgs.read'), async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT id, slug, name, tier_rank, price_monthly, feature_keys, plan_limits
                   FROM subscription_plans WHERE is_active = true
                  ORDER BY tier_rank, price_monthly, id`
            );
            res.json(r.rows);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/plans');
        }
    });

    app.get('/api/admin/console/brands', authMiddleware, requirePermission('orgs.read'), async (req, res) => {
        try {
            const r = await pool.query('SELECT id, name, slug FROM brands WHERE is_active = true ORDER BY name');
            res.json(r.rows);
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/brands');
        }
    });

    // ---------- denetim kaydı ----------
    app.get('/api/admin/console/audit', authMiddleware, requirePermission('audit.read'), async (req, res) => {
        try {
            const action = qs(req.query.action);
            const actor = qs(req.query.actor);
            const page = pageParam(req.query.page);
            if (action && !/^[a-z0-9_.]{1,80}$/.test(action)) fail(400, 'İşlem filtresi geçersiz');
            if (actor.length > 100) fail(400, 'Yönetici filtresi en fazla 100 karakter olabilir');
            const where = [];
            const params = [];
            if (action) {
                params.push(action);
                where.push(`a.action = $${params.length}`);
            }
            if (actor) {
                if (ID_RE.test(actor)) {
                    params.push(Number(actor));
                    where.push(`a.actor_user_id = $${params.length}`);
                } else {
                    params.push(likeParam(actor.toLowerCase()));
                    where.push(`LOWER(u.email) ILIKE $${params.length}`);
                }
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            params.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
            const r = await pool.query(
                `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target_type, a.target_id,
                        a.details, a.ip_address, a.created_at
                   FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
                   ${whereSql}
                  ORDER BY a.id DESC
                  LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );
            res.json({ items: r.rows, page, page_size: PAGE_SIZE });
        } catch (err) {
            sendError(req, res, err, 'GET /api/admin/console/audit');
        }
    });
};
