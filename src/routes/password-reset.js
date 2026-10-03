'use strict';
// Şifre sıfırlama: forgot / validate / reset. Tokenlar DB'de yalnızca sha256 özeti olarak durur.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } = require('../config');
const { sendMail } = require('../lib/mailer');
const { getBaseUrl } = require('../lib/app-url');
const { invalidatePasswordChangedCache } = require('../middleware/auth');

const TOKEN_TTL_MIN = 30;
const MAX_EMAILS_PER_HOUR = 3;
const GENERIC_FORGOT = 'Eğer bu e-posta kayıtlıysa, şifre sıfırlama bağlantısı gönderildi. Lütfen gelen kutunuzu (ve gerekirse spam klasörünü) kontrol edin.';
const GENERIC_BAD_TOKEN = 'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş. Lütfen yeni bir bağlantı isteyin.';

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const isValidTokenShape = t => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t);
const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function registerPasswordReset(app, ctx) {
    const { pool, logAuthAudit, FORGOT_LIMITER, RESET_LIMITER } = ctx;

    app.post('/api/auth/forgot-password', FORGOT_LIMITER, async (req, res) => {
        const generic = () => res.json({ ok: true, message: GENERIC_FORGOT });
        let mail = null;
        try {
            const email = String(req.body && typeof req.body.email === 'string' ? req.body.email : '').trim().toLowerCase();
            if (email && email.length <= 254) {
                const u = await pool.query('SELECT id, email, full_name, is_active FROM users WHERE email = $1', [email]);
                const user = u.rows[0];
                if (user && user.is_active) {
                    const recent = await pool.query(
                        `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
                        [user.id]
                    );
                    const base = getBaseUrl(req);
                    if (recent.rows[0].n < MAX_EMAILS_PER_HOUR && base) {
                        const token = crypto.randomBytes(32).toString('hex');
                        const client = await pool.connect();
                        try {
                            await client.query('BEGIN');
                            await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
                            await client.query(
                                `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
                                 VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)`,
                                [user.id, sha256(token), String(TOKEN_TTL_MIN), req.ip || null]
                            );
                            await client.query('COMMIT');
                        } catch (e) {
                            await client.query('ROLLBACK').catch(() => {});
                            throw e;
                        } finally {
                            client.release();
                        }
                        const link = `${base}/reset-password.html?token=${token}`;
                        mail = {
                            to: user.email,
                            subject: 'Şifre sıfırlama - Traktör Sektör Analizi',
                            text: `Merhaba ${user.full_name || ''},\n\nTraktör Sektör Analizi hesabınız için şifre sıfırlama talebi aldık. Yeni şifre belirlemek için aşağıdaki bağlantıya tıklayın (${TOKEN_TTL_MIN} dakika geçerlidir ve yalnızca bir kez kullanılabilir):\n${link}\n\nBu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmeyecektir.`,
                            html: `<p>Merhaba ${escapeHtml(user.full_name || '')},</p><p>Traktör Sektör Analizi hesabınız için şifre sıfırlama talebi aldık. Yeni şifre belirlemek için aşağıdaki bağlantıya tıklayın (${TOKEN_TTL_MIN} dakika geçerlidir ve yalnızca bir kez kullanılabilir):</p><p><a href="${link}">Şifremi sıfırla</a></p><p>Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmeyecektir.</p>`
                        };
                        await logAuthAudit(user.id, 'password_reset_requested', req);
                    }
                } else {
                    // Kullanıcı yoksa/pasifse de benzer sayıda sorgu çalıştır (zamanlama farkını azaltır).
                    await pool.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [-1]);
                    await pool.query('SELECT 1');
                    await pool.query('SELECT 1');
                }
            }
        } catch (err) {
            console.error('forgot-password error:', err && err.message);
        }
        generic();
        // SMTP gecikmesi yanıt süresinden sızmasın diye yanıttan sonra gönder.
        if (mail) sendMail(mail).catch(() => {});
    });

    app.get('/api/auth/reset-password/validate', RESET_LIMITER, async (req, res) => {
        try {
            const token = req.query.token;
            if (!isValidTokenShape(token)) return res.json({ valid: false });
            const r = await pool.query(
                `SELECT 1 FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
                 WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.is_active = true`,
                [sha256(token)]
            );
            res.json({ valid: r.rows.length > 0 });
        } catch (err) {
            res.json({ valid: false });
        }
    });

    app.post('/api/auth/reset-password', RESET_LIMITER, async (req, res) => {
        const token = req.body && req.body.token;
        const password = req.body && req.body.password;
        if (typeof password !== 'string' || password.length > 200 || !PASSWORD_POLICY.test(password)) {
            return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
        }
        if (!isValidTokenShape(token)) return res.status(400).json({ error: GENERIC_BAD_TOKEN });
        let client;
        try {
            const hash = await bcrypt.hash(password, 12);
            client = await pool.connect();
            await client.query('BEGIN');
            const t = await client.query(
                `SELECT t.id, t.user_id FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
                 WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.is_active = true
                 FOR UPDATE OF t`,
                [sha256(token)]
            );
            if (t.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: GENERIC_BAD_TOKEN });
            }
            const { id: tokenId, user_id: userId } = t.rows[0];
            await client.query(
                `UPDATE users SET password_hash = $1, password_changed_at = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $2`,
                [hash, userId]
            );
            await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [tokenId]);
            await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId]);
            await client.query('COMMIT');
            invalidatePasswordChangedCache(userId);
            await logAuthAudit(userId, 'password_reset_completed', req);
            res.json({ ok: true });
        } catch (err) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('reset-password error:', err && err.message);
            res.status(500).json({ error: 'Sunucu hatası' });
        } finally {
            if (client) client.release();
        }
    });
};
