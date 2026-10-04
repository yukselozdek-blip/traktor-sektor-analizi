'use strict';
// Password signup and Google OAuth routes, moved verbatim from server.js.
// Registration order is preserved (called at the original position).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } = require('../config');

const { validateProfileText, SAFE_EMAIL } = require('../lib/validate');

module.exports = function registerSignupGoogle(app, ctx) {
    const {
        pool, SIGNUP_LIMITER, LOGIN_LIMITER, SUPERUSER_EMAILS, logAuthAudit, issueAuthToken,
        buildUserPayload, escapeMailHtml
    } = ctx;

    // ============================================
    // SIGNUP — güçlü şifre + zorunlu marka + firma alanları
    // ============================================
    app.post('/api/auth/signup', SIGNUP_LIMITER, async (req, res) => {
        try {
            const {
                email: rawEmail, password, full_name, brand_id, plan_slug,
                company_name, company_tax_office, company_tax_number,
                job_title, dealer_or_distributor, phone, city
            } = req.body || {};

            const email = String(rawEmail || '').trim().toLowerCase();
            if (!email || !password || !full_name || !brand_id || !company_name || !job_title) {
                return res.status(400).json({ error: 'E-posta, şifre, ad-soyad, marka, firma adı ve unvan zorunludur' });
            }
            if (!PASSWORD_POLICY.test(String(password))) {
                return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
            }
            if (!SAFE_EMAIL.test(email) || email.length > 254) {
                return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
            }
            const textErr = validateProfileText(req.body);
            if (textErr) return res.status(400).json({ error: textErr });

            const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
            if (exists.rows.length > 0) {
                await logAuthAudit(null, 'signup_email_taken', req, { email });
                return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı' });
            }

            const brandCheck = await pool.query('SELECT id, name FROM brands WHERE id = $1 AND is_active = true', [Number(brand_id)]);
            if (brandCheck.rows.length === 0) return res.status(400).json({ error: 'Geçersiz marka seçimi' });

            // Superuser e-postaları şifre ile kayıtta otomatik yetki ALMAZ; normal doğrulama akışı izlenir.
            const isSuperuser = false;
            const role = 'brand_user';
            const verifyToken = crypto.randomBytes(24).toString('hex');
            const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const hash = await bcrypt.hash(password, 12);

            const userInsert = await pool.query(
                `INSERT INTO users
                (email, password_hash, full_name, phone, role, brand_id, company_name, company_tax_office,
                 company_tax_number, job_title, dealer_or_distributor, city, is_active,
                 auth_provider, email_verified, email_verify_token, email_verify_expires, is_superuser)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, 'password', $13, $14, $15, $16)
             RETURNING id, email, full_name, role, brand_id, company_name, job_title, is_superuser, email_verified`,
                [
                    email, hash, full_name, phone || null, role, Number(brand_id),
                    company_name, company_tax_office || null, company_tax_number || null,
                    job_title, dealer_or_distributor || 'bayi', city || null,
                    isSuperuser, // email_verified true if superuser
                    isSuperuser ? null : verifyToken,
                    isSuperuser ? null : verifyExpires,
                    isSuperuser
                ]
            );
            const newUser = userInsert.rows[0];

            // Plan seçimi varsa pending abonelik aç
            let pendingSub = null;
            if (plan_slug) {
                const planRes = await pool.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1 AND is_active = true', [String(plan_slug).toLowerCase()]);
                if (planRes.rows.length > 0) {
                    const subInsert = await pool.query(
                        `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id, plan_id, status`,
                        [newUser.id, planRes.rows[0].id]
                    );
                    pendingSub = { ...subInsert.rows[0], plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
                }
            }

            await logAuthAudit(newUser.id, 'signup_password', req, { brand_id: Number(brand_id), plan: plan_slug || null });
            // E-posta doğrulama bağlantısı: hata/SMTP yokluğu kayıt akışını asla etkilemez.
            if (!isSuperuser) {
                try {
                    const base = require('../lib/app-url').getBaseUrl(req);
                    if (base) {
                        const link = `${base}/api/auth/verify-email?token=${verifyToken}`;
                        require('../lib/mailer').sendMail({
                            to: newUser.email,
                            subject: 'E-posta adresinizi doğrulayın - Traktör Sektör Analizi',
                            text: `Merhaba ${newUser.full_name || ''},\n\nTraktör Sektör Analizi hesabınızı doğrulamak için aşağıdaki bağlantıya tıklayın (24 saat geçerlidir):\n${link}\n\nBu kaydı siz yapmadıysanız bu e-postayı yok sayabilirsiniz.`,
                            html: `<p>Merhaba ${escapeMailHtml(newUser.full_name || '')},</p><p>Traktör Sektör Analizi hesabınızı doğrulamak için aşağıdaki bağlantıya tıklayın (24 saat geçerlidir):</p><p><a href="${link}">E-postamı doğrula</a></p><p>Bu kaydı siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>`
                        }).catch(() => {});
                    }
                } catch (_) { /* kayıt başarısız olmamalı */ }
            }
            const token = issueAuthToken(newUser);
            res.status(201).json({
                token,
                user: buildUserPayload(newUser),
                pending_subscription: pendingSub,
                email_verify_required: !isSuperuser,
                verify_token_dev: process.env.NODE_ENV !== 'production' ? verifyToken : undefined
            });
        } catch (err) {
            console.error('Signup error:', err);
            res.status(500).json({ error: 'Kayıt başarısız' });
        }
    });

    // ============================================
    // GOOGLE OAUTH — ID token doğrulama
    // ============================================
    const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';

    async function verifyGoogleIdToken(idToken) {
        // Google'ın tokeninfo endpoint'i ile minimal doğrulama (production'da google-auth-library tercih edilir)
        const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
            signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) throw new Error('Google token doğrulanamadı');
        const data = await r.json();
        if (!data.email || data.email_verified !== 'true') throw new Error('Google e-posta doğrulanmamış');
        if (!GOOGLE_OAUTH_CLIENT_ID || data.aud !== GOOGLE_OAUTH_CLIENT_ID) throw new Error('Google client ID eşleşmiyor');
        return {
            email: String(data.email).toLowerCase(),
            google_id: data.sub,
            full_name: String(data.name || data.email || '').replace(/[<>]/g, '').slice(0, 120),
            picture: data.picture || null
        };
    }

    app.post('/api/auth/google', LOGIN_LIMITER, async (req, res) => {
        try {
            const { id_token, brand_id, plan_slug, company_name, job_title } = req.body || {};
            if (!GOOGLE_OAUTH_CLIENT_ID) return res.status(503).json({ error: 'Google ile giriş şu anda yapılandırılmamış' });
            if (!id_token) return res.status(400).json({ error: 'id_token gerekli' });

            const profile = await verifyGoogleIdToken(id_token).catch(err => {
                throw new Error(err.message || 'Google doğrulama hatası');
            });

            // Mevcut kullanıcı var mı?
            let user = (await pool.query(
                `SELECT u.*, b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color, b.accent_color, b.text_color, b.logo_url
             FROM users u LEFT JOIN brands b ON u.brand_id = b.id WHERE u.email = $1`,
                [profile.email]
            )).rows[0];

            if (user) {
                // Mevcut hesabı Google'a bağla (varsa güncelle)
                if (!user.google_id) {
                    await pool.query(`UPDATE users SET google_id = $1, auth_provider = 'google', email_verified = true WHERE id = $2`,
                        [profile.google_id, user.id]);
                }
                await pool.query(`UPDATE users SET last_login = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
                // Superuser
                if (SUPERUSER_EMAILS.has(profile.email) && !user.is_superuser) {
                    await pool.query(`UPDATE users SET is_superuser = true, role = 'admin', email_verified = true WHERE id = $1`, [user.id]);
                    user.is_superuser = true; user.role = 'admin';
                }
                await logAuthAudit(user.id, 'login_google', req);
                return res.json({ token: issueAuthToken(user), user: buildUserPayload(user), is_new: false });
            }

            // Yeni kullanıcı: marka + firma + unvan zorunlu
            const textErr = validateProfileText(req.body, ['company_name', 'job_title']);
            if (textErr) return res.status(400).json({ error: textErr });
            if (!brand_id || !company_name || !job_title) {
                return res.status(202).json({
                    code: 'GOOGLE_NEEDS_PROFILE',
                    google_email: profile.email,
                    google_name: profile.full_name,
                    message: 'Google ile kayıt için marka, firma ve unvan bilgisi gerekli'
                });
            }
            const brandCheck = await pool.query('SELECT id FROM brands WHERE id = $1 AND is_active = true', [Number(brand_id)]);
            if (brandCheck.rows.length === 0) return res.status(400).json({ error: 'Geçersiz marka' });

            const isSuperuser = SUPERUSER_EMAILS.has(profile.email);
            const ins = await pool.query(
                `INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name, job_title,
                                auth_provider, google_id, email_verified, is_superuser)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'google', $7, true, $8)
             RETURNING *`,
                [profile.email, profile.full_name, isSuperuser ? 'admin' : 'brand_user',
                 Number(brand_id), company_name, job_title, profile.google_id, isSuperuser]
            );
            const newUser = ins.rows[0];

            let pendingSub = null;
            if (plan_slug) {
                const planRes = await pool.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1', [String(plan_slug).toLowerCase()]);
                if (planRes.rows.length > 0) {
                    const subIns = await pool.query(
                        `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id`,
                        [newUser.id, planRes.rows[0].id]
                    );
                    pendingSub = { id: subIns.rows[0].id, plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
                }
            }

            await logAuthAudit(newUser.id, 'signup_google', req, { brand_id: Number(brand_id) });
            res.status(201).json({
                token: issueAuthToken(newUser),
                user: buildUserPayload(newUser),
                is_new: true,
                pending_subscription: pendingSub
            });
        } catch (err) {
            console.error('Google auth error:', err);
            res.status(401).json({ error: err.message || 'Google girişi başarısız' });
        }
    });

    // Google OAuth client ID (frontend için)
    app.get('/api/auth/google-config', (req, res) => {
        res.json({ client_id: GOOGLE_OAUTH_CLIENT_ID || null });
    });
};
