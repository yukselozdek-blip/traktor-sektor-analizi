'use strict';
// Kurum self-servis (ADMIN_PANEL_PLAN.md §7.2). Yollar authMiddleware ile korunur; yazma uçları ayrıca
// kullanıcının kendi kurumunda org_admin olmasını ister (member_role === 'org_admin').
const { ORG_EFFECTIVE_SQL, addMemberWithSeatCheck } = require('../lib/org-entitlements');
const { logAdminAudit } = require('../lib/admin-audit');
const { logRouteError } = require('../lib/log-error');

const ID_RE = /^\d{1,9}$/;

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

function sendError(req, res, err, label) {
    if (err instanceof HttpError) return res.status(err.httpStatus).json(err.body);
    logRouteError(req, err, label);
    return res.status(500).json({ error: 'Sunucu hatası' });
}

function parseId(value, message) {
    const s = value == null ? '' : String(value);
    if (!ID_RE.test(s) || Number(s) <= 0) fail(400, message || 'Geçersiz kimlik');
    return Number(s);
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

module.exports = function registerOrgSelf(app, ctx) {
    const { pool, authMiddleware, SAFE_EMAIL, sendOrgInviteEmail } = ctx;
    const EMAIL_FALLBACK = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    const emailRe = SAFE_EMAIL instanceof RegExp ? SAFE_EMAIL : EMAIL_FALLBACK;

    const normEmail = (value) => {
        const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (!s || s.length > 254 || !emailRe.test(s)) fail(400, 'Geçerli bir e-posta adresi girin');
        return s;
    };

    // Kullanıcının org_admin olduğu kurum üyeliğini döndürür; değilse 403 yanıtı yazar ve null döner.
    async function requireOrgAdmin(req, res) {
        const r = await pool.query(
            'SELECT organization_id, member_role FROM organization_members WHERE user_id = $1',
            [req.user.id]
        );
        const m = r.rows[0];
        if (!m || m.member_role !== 'org_admin') {
            res.status(403).json({ error: 'Yalnızca kurum yöneticileri bu işlemi yapabilir' });
            return null;
        }
        return m;
    }

    // Davet e-postası: fonksiyon yoksa veya hata verirse yanıt etkilenmez.
    function sendInviteMail(req, payload) {
        if (typeof sendOrgInviteEmail !== 'function') return;
        try {
            const p = sendOrgInviteEmail(req, payload);
            if (p && typeof p.catch === 'function') {
                p.catch((err) => logRouteError(req, err, 'POST /api/org/members mail'));
            }
        } catch (err) {
            logRouteError(req, err, 'POST /api/org/members mail');
        }
    }

    // ---------- GET /api/org/me ----------
    app.get('/api/org/me', authMiddleware, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT o.id, o.name, o.seat_limit, o.status, to_char(o.contract_end, 'YYYY-MM-DD') AS contract_end,
                        p.name AS plan_name, m.member_role,
                        (${ORG_EFFECTIVE_SQL}) AS is_effective,
                        (SELECT COUNT(*)::int FROM organization_members x WHERE x.organization_id = o.id) AS seats_used
                   FROM organization_members m
                   JOIN organizations o ON o.id = m.organization_id
                   LEFT JOIN subscription_plans p ON p.id = o.plan_id
                  WHERE m.user_id = $1`,
                [req.user.id]
            );
            if (!r.rows.length) return res.json({ organization: null, member_role: null });
            const row = r.rows[0];
            res.json({
                organization: {
                    id: row.id,
                    name: row.name,
                    plan_name: row.plan_name,
                    seat_limit: row.seat_limit,
                    seats_used: row.seats_used,
                    contract_end: row.contract_end,
                    status: row.status,
                    is_effective: row.is_effective
                },
                member_role: row.member_role
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/org/me');
        }
    });

    // ---------- GET /api/org/members ----------
    app.get('/api/org/members', authMiddleware, async (req, res) => {
        try {
            const m = await requireOrgAdmin(req, res);
            if (!m) return;
            const [seat, members, invitations] = await Promise.all([
                pool.query(
                    `SELECT o.seat_limit, (SELECT COUNT(*)::int FROM organization_members x WHERE x.organization_id = o.id) AS seats_used
                       FROM organizations o WHERE o.id = $1`,
                    [m.organization_id]
                ),
                pool.query(
                    `SELECT u.id, u.email, u.full_name, mm.member_role, u.email_verified, u.is_active, u.last_login, mm.created_at
                       FROM organization_members mm JOIN users u ON u.id = mm.user_id
                      WHERE mm.organization_id = $1 ORDER BY mm.created_at, u.id`,
                    [m.organization_id]
                ),
                pool.query(
                    `SELECT id, email, member_role, created_at FROM organization_invitations
                      WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at, id`,
                    [m.organization_id]
                )
            ]);
            res.json({
                seat_limit: seat.rows[0] ? seat.rows[0].seat_limit : 0,
                seats_used: seat.rows[0] ? seat.rows[0].seats_used : 0,
                members: members.rows,
                invitations: invitations.rows
            });
        } catch (err) {
            sendError(req, res, err, 'GET /api/org/members');
        }
    });

    // ---------- POST /api/org/members ----------
    // Mevcut ve kurumsuz bir kullanıcı doğrudan bağlanır; kayıtlı olmayan e-posta için davet oluşturulur.
    app.post('/api/org/members', authMiddleware, async (req, res) => {
        try {
            const m = await requireOrgAdmin(req, res);
            if (!m) return;
            const email = normEmail(req.body && req.body.email);
            const orgId = m.organization_id;
            const result = await withTx(pool, async (c) => {
                const org = await c.query('SELECT id, seat_limit FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
                if (!org.rows.length) fail(404, 'Kurum bulunamadı');
                const u = await c.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
                if (u.rows.length) {
                    const userId = u.rows[0].id;
                    const added = await addMemberWithSeatCheck(c, orgId, userId, { memberRole: 'member', joinedVia: 'org_admin', addedBy: req.user.id });
                    if (!added.ok) {
                        if (added.code === 'ORG_SEATS_FULL') {
                            fail(403, 'Kurumunuzun kullanıcı kotası dolu. Yöneticinizle iletişime geçin.', { code: 'ORG_SEATS_FULL' });
                        }
                        if (added.code === 'ALREADY_MEMBER') fail(409, 'Bu kullanıcı zaten bir kurumun üyesi');
                        fail(404, 'Kurum bulunamadı');
                    }
                    return { result: 'added', user_id: userId };
                }
                // Yeni davet: koltuk + bekleyen davet sayısı kotayı aşamaz (bu e-postanın kendi bekleyen kaydı hariç).
                const counts = await c.query(
                    `SELECT (SELECT COUNT(*)::int FROM organization_members WHERE organization_id = $1) AS used,
                            (SELECT COUNT(*)::int FROM organization_invitations
                              WHERE organization_id = $1 AND status = 'pending' AND email <> $2) AS pending`,
                    [orgId, email]
                );
                const { used, pending } = counts.rows[0];
                if (used + pending + 1 > org.rows[0].seat_limit) {
                    fail(403, 'Kurumunuzun kullanıcı kotası dolu. Yöneticinizle iletişime geçin.', { code: 'ORG_SEATS_FULL' });
                }
                const inv = await c.query(
                    `INSERT INTO organization_invitations (organization_id, email, member_role, status, invited_by)
                     VALUES ($1, $2, 'member', 'pending', $3)
                     ON CONFLICT (organization_id, email)
                     DO UPDATE SET status = 'pending', member_role = 'member', accepted_at = NULL, invited_by = EXCLUDED.invited_by
                     RETURNING id`,
                    [orgId, email, req.user.id]
                );
                const orgRow = await c.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
                return { result: 'invited', invitation_id: inv.rows[0].id, organization_name: orgRow.rows[0] ? orgRow.rows[0].name : null };
            });
            await logAdminAudit(pool, req, result.result === 'added' ? 'org_self.member.add' : 'org_self.member.invite', 'organization', String(orgId), {
                result: result.result
            });
            const { organization_name: orgName, ...payload } = result;
            res.status(201).json(payload);
            if (result.result === 'invited') {
                sendInviteMail(req, { email, invitation_id: result.invitation_id, organization_name: orgName, invited_by_name: req.user.full_name || null });
            }
        } catch (err) {
            sendError(req, res, err, 'POST /api/org/members');
        }
    });

    // ---------- DELETE /api/org/members/:userId ----------
    app.delete('/api/org/members/:userId', authMiddleware, async (req, res) => {
        try {
            const m = await requireOrgAdmin(req, res);
            if (!m) return;
            const userId = parseId(req.params.userId, 'Geçersiz kullanıcı kimliği');
            if (userId === req.user.id) return res.status(403).json({ error: 'Kendinizi kurumdan çıkaramazsınız' });
            const r = await pool.query(
                'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 RETURNING user_id',
                [m.organization_id, userId]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Üye bulunamadı' });
            await logAdminAudit(pool, req, 'org_self.member.remove', 'organization', String(m.organization_id), { user_id: userId });
            res.json({ ok: true, user_id: userId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/org/members/:userId');
        }
    });

    // ---------- DELETE /api/org/invitations/:id ----------
    app.delete('/api/org/invitations/:id', authMiddleware, async (req, res) => {
        try {
            const m = await requireOrgAdmin(req, res);
            if (!m) return;
            const invId = parseId(req.params.id, 'Geçersiz davet kimliği');
            const r = await pool.query(
                `UPDATE organization_invitations SET status = 'revoked'
                  WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`,
                [invId, m.organization_id]
            );
            if (!r.rows.length) return res.status(404).json({ error: 'Davet bulunamadı veya bekleyen durumda değil' });
            await logAdminAudit(pool, req, 'org_self.invitation.revoke', 'organization', String(m.organization_id), { invitation_id: invId });
            res.json({ ok: true, id: invId });
        } catch (err) {
            sendError(req, res, err, 'DELETE /api/org/invitations/:id');
        }
    });
};
