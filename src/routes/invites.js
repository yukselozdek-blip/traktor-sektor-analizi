'use strict';
// Davet kodu yönetimi (yalnızca admin) + doğrulama e-postasını yeniden gönderme.
const { generateInviteCode, hashInviteCode, inviteHint } = require('../lib/invites');
const { newVerifyToken, hashVerifyToken, verifyExpiry, sendVerificationEmail, VERIFY_TTL_MS } = require('../lib/verify-email');

const GENERIC_RESEND = 'Eğer bu e-posta kayıtlı ve doğrulanmamışsa, yeni doğrulama bağlantısı gönderildi. Lütfen gelen kutunuzu (ve gerekirse spam klasörünü) kontrol edin.';
const RESEND_COOLDOWN_MS = 60 * 1000;

module.exports = function registerInvites(app, ctx) {
    const { pool, authMiddleware, adminOnly, RESEND_LIMITER, logAuthAudit, escapeMailHtml } = ctx;

    app.post('/api/admin/invites', authMiddleware, adminOnly, async (req, res) => {
        try {
            const { brand_id, max_uses, expires_in_days, note, plan_slug } = req.body || {};
            const brandId = Number(brand_id);
            if (!Number.isInteger(brandId) || brandId <= 0) return res.status(400).json({ error: 'Geçerli bir marka seçin' });
            const maxUses = max_uses == null || max_uses === '' ? 1 : Number(max_uses);
            if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) return res.status(400).json({ error: 'Kullanım sayısı 1-1000 arasında olmalı' });
            let expiresAt = null;
            if (expires_in_days != null && expires_in_days !== '') {
                const d = Number(expires_in_days);
                if (!Number.isFinite(d) || d <= 0 || d > 3650) return res.status(400).json({ error: 'Geçerlilik süresi 1-3650 gün arasında olmalı' });
                expiresAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
            }
            const noteText = note == null ? null : String(note).slice(0, 500);
            const planSlug = plan_slug ? String(plan_slug).slice(0, 100) : null;
            const brand = await pool.query('SELECT id, name FROM brands WHERE id = $1 AND is_active = true', [brandId]);
            if (brand.rows.length === 0) return res.status(400).json({ error: 'Geçersiz marka' });

            const code = generateInviteCode();
            const ins = await pool.query(
                `INSERT INTO invite_codes (code_hash, code_hint, brand_id, plan_slug, max_uses, expires_at, created_by, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, code_hint, brand_id, plan_slug, max_uses, used_count, expires_at, is_active, note, created_at`,
                [hashInviteCode(code), inviteHint(code), brandId, planSlug, maxUses, expiresAt, req.user.id, noteText]
            );
            await logAuthAudit(req.user.id, 'invite_created', req, { invite_id: ins.rows[0].id, brand_id: brandId });
            res.setHeader('Cache-Control', 'no-store');
            // Düz metin kod YALNIZCA burada, bir kez döner.
            res.status(201).json({ code, ...ins.rows[0], brand_name: brand.rows[0].name });
        } catch (err) {
            console.error('invite create error:', err && err.message);
            res.status(500).json({ error: 'Davet kodu oluşturulamadı' });
        }
    });

    app.get('/api/admin/invites', authMiddleware, adminOnly, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT i.id, i.brand_id, b.name AS brand_name, i.code_hint, i.plan_slug, i.max_uses, i.used_count,
                        i.expires_at, i.is_active, i.note, i.created_at
                   FROM invite_codes i LEFT JOIN brands b ON b.id = i.brand_id
                  ORDER BY i.id DESC LIMIT 500`
            );
            res.setHeader('Cache-Control', 'no-store');
            res.json(r.rows);
        } catch (err) {
            console.error('invite list error:', err && err.message);
            res.status(500).json({ error: 'Davet kodları alınamadı' });
        }
    });

    app.post('/api/admin/invites/:id/revoke', authMiddleware, adminOnly, async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kimlik' });
            const r = await pool.query('UPDATE invite_codes SET is_active = false WHERE id = $1 RETURNING id', [id]);
            if (r.rows.length === 0) return res.status(404).json({ error: 'Davet kodu bulunamadı' });
            await logAuthAudit(req.user.id, 'invite_revoked', req, { invite_id: id });
            res.json({ ok: true, id });
        } catch (err) {
            console.error('invite revoke error:', err && err.message);
            res.status(500).json({ error: 'İptal edilemedi' });
        }
    });

    // Doğrulama e-postasını yeniden gönder: her zaman aynı genel yanıt (kullanıcı numaralandırma yok).
    app.post('/api/auth/resend-verification', RESEND_LIMITER, async (req, res) => {
        let sent = null;
        try {
            const email = String(req.body && typeof req.body.email === 'string' ? req.body.email : '').trim().toLowerCase();
            if (email && email.length <= 254) {
                const u = await pool.query(
                    `SELECT id, email, full_name, email_verify_expires FROM users
                      WHERE email = $1 AND is_active = true AND auth_provider = 'password' AND email_verified IS NOT TRUE`,
                    [email]
                );
                const user = u.rows[0];
                if (user) {
                    const issuedAt = user.email_verify_expires ? new Date(user.email_verify_expires).getTime() - VERIFY_TTL_MS : 0;
                    if (Date.now() - issuedAt >= RESEND_COOLDOWN_MS) {
                        const token = newVerifyToken();
                        await pool.query('UPDATE users SET email_verify_token = $1, email_verify_expires = $2 WHERE id = $3', [hashVerifyToken(token), verifyExpiry(), user.id]);
                        sent = { user, token };
                    }
                }
            }
        } catch (err) {
            console.error('resend-verification error:', err && err.message);
        }
        res.json({ ok: true, message: GENERIC_RESEND });
        if (sent) {
            await logAuthAudit(sent.user.id, 'verification_resent', req).catch(() => {});
            sendVerificationEmail(req, sent.user, sent.token, escapeMailHtml);
        }
    });
};
