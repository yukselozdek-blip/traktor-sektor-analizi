'use strict';
// Kurumsal sözleşme (organization) yetkilendirme yardımcıları. Tek doğru kaynak: ADMIN_PANEL_PLAN.md §5, §10.
// Tüm fonksiyonlar yalnızca `db` parametresi alır (pool veya transaction client); modül pool'a bağlı değildir.

// Geçerli kurum: durum trial/active VE sözleşme aralığı bugünü kapsıyor. Sözleşme bitince erişim otomatik kapanır.
// `o` takma adı organizations tablosunu gösterir.
const ORG_EFFECTIVE_SQL = `(
    o.status IN ('trial', 'active')
    AND (o.contract_start IS NULL OR o.contract_start <= CURRENT_DATE)
    AND (o.contract_end IS NULL OR o.contract_end >= CURRENT_DATE)
)`;

const PUBLIC_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
    'yandex.com', 'yandex.com.tr', 'live.com', 'msn.com', 'proton.me', 'protonmail.com',
    'mail.ru', 'aol.com'
]);

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// Feature-flag önbelleği: küresel kapalı anahtarlar, 30 sn.
const FEATURE_FLAG_TTL_MS = 30 * 1000;
let featureFlagCache = null; // { set: Set<string>, exp: number }

// JSONB (nesne/dizi), JSON metni veya boş değer -> beklenen tipte değer. Bozuk girdi fallback'e düşer.
function parseJsonish(value, fallback) {
    let v = value;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return fallback; }
    }
    if (v == null) return fallback;
    if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
    if (typeof v !== 'object' || Array.isArray(v)) return fallback;
    return v;
}

// Plan özellikleri ∪ add − remove; tekrarsız dizi.
function mergeFeatureKeys(planKeys, overrides) {
    const ov = parseJsonish(overrides, { add: [], remove: [] });
    const set = new Set(parseJsonish(planKeys, []).filter(k => typeof k === 'string'));
    for (const k of parseJsonish(ov.add, [])) if (typeof k === 'string') set.add(k);
    for (const k of parseJsonish(ov.remove, [])) if (typeof k === 'string') set.delete(k);
    return [...set];
}

// Plan limitleri ← kurum istisnaları. Yalnızca sonlu sayılar alınır (-1 = sınırsız).
function mergeLimits(planLimits, overrides) {
    const out = {};
    const take = (src) => {
        for (const [k, v] of Object.entries(parseJsonish(src, {}))) {
            if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        }
    };
    take(planLimits);
    take(overrides);
    return out;
}

// "ad@Alan.Adi" -> "alan.adi"; geçersizse null.
function emailDomain(email) {
    if (typeof email !== 'string') return null;
    const s = email.trim().toLowerCase();
    const at = s.lastIndexOf('@');
    if (at < 0) return null;
    return s.slice(at + 1) || null;
}

// Alan adı girdisi -> geçerli, küçük harf alan adı veya null. Baştaki '@' atılır.
function normalizeDomain(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim().toLowerCase();
    if (s.startsWith('@')) s = s.slice(1);
    return DOMAIN_RE.test(s) ? s : null;
}

// Kullanıcının kuruma üyeliği (kullanıcı en fazla bir kuruma bağlıdır). Yoksa null.
async function getUserOrgMembership(db, userId) {
    const r = await db.query(
        `SELECT m.organization_id, m.member_role, m.joined_via, o.*, ${ORG_EFFECTIVE_SQL} AS is_effective
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1`,
        [userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    const org = { ...row };
    delete org.organization_id;
    delete org.member_role;
    delete org.joined_via;
    delete org.is_effective;
    return {
        organization_id: row.organization_id,
        member_role: row.member_role,
        joined_via: row.joined_via,
        org,
        is_effective: row.is_effective === true
    };
}

// Kurumdan türetilmiş abonelik nesnesi (§5). Yalnızca geçerli kurumda; değilse null.
// Kurum sözleşmesi kişisel aboneliğe önceliklidir (çağıran taraf sırayı yönetir).
async function getOrgSubscriptionForUser(db, userId) {
    const r = await db.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, o.contract_start, o.contract_end,
                o.feature_overrides, o.limit_overrides,
                m.member_role,
                sp.id AS plan_id, sp.slug AS plan_slug, sp.name AS plan_name, sp.tier_rank,
                sp.feature_keys, sp.plan_limits,
                sp.has_ai_insights, sp.has_competitor_analysis, sp.has_weather_data, sp.has_export
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
           JOIN subscription_plans sp ON sp.id = o.plan_id
          WHERE m.user_id = $1 AND ${ORG_EFFECTIVE_SQL}
          LIMIT 1`,
        [userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    const featureKeys = mergeFeatureKeys(row.feature_keys, row.feature_overrides);
    const planLimits = mergeLimits(row.plan_limits, row.limit_overrides);
    return {
        id: null,
        source: 'organization',
        organization_id: row.organization_id,
        organization_name: row.organization_name,
        member_role: row.member_role,
        user_id: userId,
        plan_id: row.plan_id,
        plan_slug: row.plan_slug,
        plan_name: row.plan_name,
        tier_rank: row.tier_rank,
        status: 'active',
        current_period_start: row.contract_start,
        // Sözleşme bitiş günü dahil: gün sonu (23:59:59). Süresiz ise null.
        current_period_end: row.contract_end ? new Date(`${formatDate(row.contract_end)}T23:59:59`) : null,
        cancel_at_period_end: false,
        feature_keys: featureKeys,
        plan_limits: planLimits,
        features: featureKeys,
        has_ai_insights: row.has_ai_insights === true,
        has_competitor_analysis: row.has_competitor_analysis === true,
        has_weather_data: row.has_weather_data === true,
        has_export: row.has_export === true
    };
}

// pg DATE değeri (Date veya metin) -> 'YYYY-MM-DD' (yerel tarih bileşenleri).
function formatDate(value) {
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

// Kurumdaki üye sayısı (kullanılan koltuk).
async function countSeatsUsed(db, orgId) {
    const r = await db.query('SELECT COUNT(*)::int AS n FROM organization_members WHERE organization_id = $1', [orgId]);
    return r.rows[0] ? r.rows[0].n : 0;
}

// Kayıt sırasında uygun kurum: önce bekleyen davet (e-posta eşleşmesi), yoksa alan adı (auto_join). Yalnızca geçerli kurum.
async function findSignupOrganization(db, email) {
    if (typeof email !== 'string') return null;
    const lower = email.trim().toLowerCase();
    if (!lower) return null;

    const inv = await db.query(
        `SELECT i.id AS invitation_id, i.organization_id, i.member_role
           FROM organization_invitations i
           JOIN organizations o ON o.id = i.organization_id
          WHERE i.status = 'pending' AND LOWER(i.email) = $1 AND ${ORG_EFFECTIVE_SQL}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT 1`,
        [lower]
    );
    if (inv.rows[0]) {
        const row = inv.rows[0];
        return { organization_id: row.organization_id, invitation_id: row.invitation_id, member_role: row.member_role, joined_via: 'invitation' };
    }

    const domain = emailDomain(lower);
    if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
    const dom = await db.query(
        `SELECT d.organization_id
           FROM organization_domains d
           JOIN organizations o ON o.id = d.organization_id
          WHERE d.domain = $1 AND o.auto_join = true AND ${ORG_EFFECTIVE_SQL}
          LIMIT 1`,
        [domain]
    );
    if (dom.rows[0]) {
        return { organization_id: dom.rows[0].organization_id, invitation_id: null, member_role: 'member', joined_via: 'domain' };
    }
    return null;
}

// Koltuk kontrollü üyelik ekleme. Transaction içinde çağrılmalıdır (client). Kurum satırını kilitler.
async function addMemberWithSeatCheck(client, orgId, userId, { memberRole = 'member', joinedVia = 'admin', addedBy = null } = {}) {
    const o = await client.query('SELECT id, brand_id, seat_limit FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    const org = o.rows[0];
    if (!org) return { ok: false, code: 'ORG_NOT_FOUND' };

    const existing = await client.query('SELECT 1 FROM organization_members WHERE user_id = $1', [userId]);
    if (existing.rows.length > 0) return { ok: false, code: 'ALREADY_MEMBER' };

    const cnt = await countSeatsUsed(client, orgId);
    if (cnt >= org.seat_limit) return { ok: false, code: 'ORG_SEATS_FULL' };

    await client.query(
        `INSERT INTO organization_members (organization_id, user_id, member_role, added_by, joined_via)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, memberRole, addedBy, joinedVia]
    );
    await client.query('UPDATE users SET brand_id = $1 WHERE id = $2', [org.brand_id, userId]);
    await client.query(
        `UPDATE organization_invitations SET status = 'accepted', accepted_at = NOW()
          WHERE organization_id = $1 AND status = 'pending'
            AND email = (SELECT LOWER(email) FROM users WHERE id = $2)`,
        [orgId, userId]
    );
    return { ok: true };
}

// Küresel kapalı özellik anahtarları (30 sn önbellek). Hata olursa boş küme döner ve önbelleğe alınmaz.
async function getDisabledFeatureKeys(db) {
    const now = Date.now();
    if (featureFlagCache && featureFlagCache.exp > now) return featureFlagCache.set;
    try {
        const r = await db.query('SELECT key FROM feature_flags WHERE is_enabled = false');
        const set = new Set(r.rows.map(row => row.key));
        featureFlagCache = { set, exp: now + FEATURE_FLAG_TTL_MS };
        return set;
    } catch (err) {
        console.warn('getDisabledFeatureKeys: feature_flags okunamadı:', err && err.message);
        return new Set();
    }
}

function invalidateFeatureFlagCache() {
    featureFlagCache = null;
}

module.exports = {
    ORG_EFFECTIVE_SQL,
    PUBLIC_EMAIL_DOMAINS,
    parseJsonish,
    mergeFeatureKeys,
    mergeLimits,
    emailDomain,
    normalizeDomain,
    getUserOrgMembership,
    getOrgSubscriptionForUser,
    countSeatsUsed,
    findSignupOrganization,
    addMemberWithSeatCheck,
    getDisabledFeatureKeys,
    invalidateFeatureFlagCache
};
