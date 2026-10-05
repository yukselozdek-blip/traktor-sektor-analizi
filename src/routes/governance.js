'use strict';
// Yönetişim paneli (yalnızca yönetici): özet göstergeler ve giriş denetim kaydı.
// Yeni veri toplama yok: mevcut tablolardan (users, subscriptions, ai_usage_log, auth_audit, whatsapp_phones, invite_codes) okunur.
// Herkese açık uç yoktur; tüm yollar authMiddleware + adminOnly.
const { logRouteError } = require('../lib/log-error');

const EVENT_RE = /^[a-z0-9_]{1,50}$/;
const MAX_LIMIT = 100;

module.exports = function registerGovernance(app, ctx) {
    const { pool, authMiddleware, adminOnly } = ctx;
    const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || {};
    const many = async (sql, params = []) => (await pool.query(sql, params)).rows;

    app.get('/api/admin/governance/overview', authMiddleware, adminOnly, async (req, res) => {
        try {
            const [users, mfa, subs, expiring, aiTotals, aiByFeature, aiTopUsers, authEvents, failedIps, wa, invites] = await Promise.all([
                one(`SELECT COUNT(*)::int AS total,
                            COUNT(*) FILTER (WHERE is_active)::int AS active,
                            COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
                            COUNT(*) FILTER (WHERE email_verified IS NOT TRUE)::int AS unverified,
                            COUNT(*) FILTER (WHERE locked_until > NOW())::int AS locked_now,
                            COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '7 days')::int AS active_7d
                     FROM users`),
                one(`SELECT COUNT(*) FILTER (WHERE role = 'admin' OR is_superuser)::int AS privileged,
                            COUNT(*) FILTER (WHERE (role = 'admin' OR is_superuser) AND totp_enabled)::int AS privileged_with_2fa,
                            COUNT(*) FILTER (WHERE totp_enabled)::int AS with_2fa
                     FROM users`),
                many(`SELECT status, COUNT(*)::int AS n FROM subscriptions GROUP BY status ORDER BY n DESC`),
                one(`SELECT COUNT(*)::int AS n FROM subscriptions
                     WHERE status IN ('active','trialing') AND current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days'`),
                one(`SELECT COUNT(*)::int AS queries, COALESCE(SUM(cost_tl), 0)::float AS cost_tl,
                            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens
                     FROM ai_usage_log WHERE created_at >= NOW() - INTERVAL '30 days'`),
                many(`SELECT COALESCE(feature, '-') AS feature, COUNT(*)::int AS n
                      FROM ai_usage_log WHERE created_at >= NOW() - INTERVAL '30 days'
                      GROUP BY 1 ORDER BY n DESC LIMIT 8`),
                many(`SELECT u.email, COUNT(*)::int AS n, COALESCE(SUM(l.cost_tl), 0)::float AS cost_tl
                      FROM ai_usage_log l JOIN users u ON u.id = l.user_id
                      WHERE l.created_at >= NOW() - INTERVAL '30 days'
                      GROUP BY u.email ORDER BY n DESC LIMIT 5`),
                many(`SELECT event, COUNT(*)::int AS n FROM auth_audit
                      WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY event ORDER BY n DESC LIMIT 20`),
                many(`SELECT ip_address, COUNT(*)::int AS n FROM auth_audit
                      WHERE created_at >= NOW() - INTERVAL '24 hours' AND event IN ('login_failed', 'login_failed_unknown', 'mfa_failed')
                        AND ip_address IS NOT NULL
                      GROUP BY ip_address ORDER BY n DESC LIMIT 5`),
                one(`SELECT COUNT(*) FILTER (WHERE admin_approved IS NOT TRUE AND admin_rejected_at IS NULL)::int AS pending,
                            COUNT(*) FILTER (WHERE admin_approved)::int AS approved
                     FROM whatsapp_phones`),
                one(`SELECT COUNT(*) FILTER (WHERE is_active AND (expires_at IS NULL OR expires_at > NOW()) AND used_count < max_uses)::int AS usable
                     FROM invite_codes`)
            ]);
            res.json({
                generated_at: new Date().toISOString(),
                users: { ...users, ...mfa },
                subscriptions: { by_status: subs, expiring_7d: expiring.n || 0 },
                ai_30d: { ...aiTotals, tokens: Number(aiTotals.tokens || 0), by_feature: aiByFeature, top_users: aiTopUsers },
                auth_7d: { events: authEvents, failed_by_ip_24h: failedIps },
                whatsapp: wa,
                invites
            });
        } catch (err) { logRouteError(req, err, 'GET /api/admin/governance/overview'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // Denetim kaydı: en yeniden eskiye, imleç tabanlı sayfalama (before = son görülen id).
    app.get('/api/admin/governance/audit', authMiddleware, adminOnly, async (req, res) => {
        try {
            const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
            const params = [];
            const where = [];
            if (req.query.event !== undefined && req.query.event !== '') {
                if (typeof req.query.event !== 'string' || !EVENT_RE.test(req.query.event)) return res.status(400).json({ error: 'Geçersiz olay adı' });
                params.push(req.query.event); where.push(`a.event = $${params.length}`);
            }
            if (req.query.before !== undefined && req.query.before !== '') {
                const before = parseInt(req.query.before, 10);
                if (!Number.isInteger(before) || before < 1) return res.status(400).json({ error: 'Geçersiz imleç' });
                params.push(before); where.push(`a.id < $${params.length}`);
            }
            params.push(limit + 1);
            const rows = await many(
                `SELECT a.id, a.created_at, a.event, a.ip_address, LEFT(COALESCE(a.user_agent, ''), 160) AS user_agent, u.email
                 FROM auth_audit a LEFT JOIN users u ON u.id = a.user_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY a.id DESC LIMIT $${params.length}`, params);
            const hasMore = rows.length > limit;
            const items = rows.slice(0, limit);
            res.json({ items, has_more: hasMore, next_before: hasMore ? items[items.length - 1].id : null });
        } catch (err) { logRouteError(req, err, 'GET /api/admin/governance/audit'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // Olay adı seçici için (filtre listesi)
    app.get('/api/admin/governance/audit-events', authMiddleware, adminOnly, async (req, res) => {
        try {
            const rows = await many(`SELECT DISTINCT event FROM auth_audit WHERE event IS NOT NULL ORDER BY event LIMIT 100`);
            res.json(rows.map(r => r.event));
        } catch (err) { logRouteError(req, err, 'GET /api/admin/governance/audit-events'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });
};
