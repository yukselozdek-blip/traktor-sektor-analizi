'use strict';
// WhatsApp numara normalizasyonu ve "bu numara cevap alabilir mi" kontrolü.
// Kayıt rotası, webhook ve sales-query aynı fonksiyonları kullanır.

// '+90 532 ...', '90532...' -> '+90532...' ; geçersizse null
function normalizePhoneE164(input) {
    const s = String(input == null ? '' : input).replace(/[\s\-().]/g, '');
    if (!/^\+?\d{10,15}$/.test(s)) return null;
    return s.startsWith('+') ? s : '+' + s;
}

function maskPhone(input) {
    const d = String(input == null ? '' : input).replace(/\D/g, '');
    return d ? '***' + d.slice(-4) : '***';
}

function last4(input) {
    return String(input == null ? '' : input).replace(/\D/g, '').slice(-4) || '????';
}

// Dönüş: { ok: true, userId, phoneId } | { ok: false, reason }
// reason: invalid_phone | not_registered | not_approved | phone_inactive | user_inactive |
//         email_unverified | no_subscription | plan_no_whatsapp
async function checkWhatsappAuthorization(pool, from) {
    const phone = normalizePhoneE164(from);
    if (!phone) return { ok: false, reason: 'invalid_phone' };
    const r = await pool.query(
        `SELECT wp.id, wp.user_id, wp.is_active AS phone_active, wp.admin_approved,
                u.is_active AS user_active, u.email_verified, u.role
         FROM whatsapp_phones wp JOIN users u ON u.id = wp.user_id
         WHERE wp.phone_e164 = $1 LIMIT 1`, [phone]);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'not_registered' };
    if (row.admin_approved !== true) return { ok: false, reason: 'not_approved' };
    if (row.phone_active === false) return { ok: false, reason: 'phone_inactive' };
    if (row.user_active !== true) return { ok: false, reason: 'user_inactive' };
    if (row.email_verified !== true) return { ok: false, reason: 'email_unverified' };
    // Admin: plan sınırı yok (getPlanLimits ile aynı mantık)
    if (row.role === 'admin') return { ok: true, userId: row.user_id, phoneId: row.id };
    const s = await pool.query(
        `SELECT sp.plan_limits FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.user_id = $1 AND s.status IN ('active','trialing')
         ORDER BY s.created_at DESC LIMIT 1`, [row.user_id]);
    if (!s.rows[0]) return { ok: false, reason: 'no_subscription' };
    let limits = s.rows[0].plan_limits;
    if (typeof limits === 'string') { try { limits = JSON.parse(limits); } catch (_) { limits = {}; } }
    const n = limits && limits.whatsapp_phones;
    if (n === undefined || n === null || Number(n) === 0) return { ok: false, reason: 'plan_no_whatsapp' };
    return { ok: true, userId: row.user_id, phoneId: row.id };
}

module.exports = { normalizePhoneE164, maskPhone, last4, checkWhatsappAuthorization };
