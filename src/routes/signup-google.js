'use strict';
// Password signup and Google OAuth routes, moved verbatim from server.js.
// Registration order is preserved (called at the original position).
const bcrypt = require('bcryptjs');
const { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } = require('../config');

const { validateProfileText, SAFE_EMAIL } = require('../lib/validate');
const { INVITE_ERROR, consumeInviteCode } = require('../lib/invites');
const { newVerifyToken, hashVerifyToken, verifyExpiry, sendVerificationEmail } = require('../lib/verify-email');
const BRAND_MISMATCH_ERROR = 'Davet kodu seçtiğiniz markaya ait değil';

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
                job_title, dealer_or_distributor, phone, city, invite_code
            } = req.body || {};

            const email = String(rawEmail || '').trim().toLowerCase();
            const isSuperEmail = SUPERUSER_EMAILS.has(email);
            const inviteCode = typeof invite_code === 'string' ? invite_code : '';
            if (!email || !password || !full_name || !company_name || !job_title) {
                return res.status(400).json({ error: 'E-posta, şifre, ad-soyad, firma adı ve unvan zorunludur' });
            }
            if (!isSuperEmail && !inviteCode) return res.status(400).json({ error: INVITE_ERROR });
            if (!brand_id && isSuperEmail) return res.status(400).json({ error: 'Marka seçimi zorunludur' });
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

            const verifyToken = newVerifyToken();
            const verifyExpires = verifyExpiry();
            const hash = await bcrypt.hash(password, 12);

            // Davet kodu tüketimi, kullanıcı/abonelik kayıtlarıyla aynı transaction'da: kayıt başarısız olursa kod harcanmaz.
            const client = await pool.connect();
            let newUser, pendingSub = null, effectiveBrandId, effectivePlan = plan_slug, inviteId = null;
            try {
                await client.query('BEGIN');
                effectiveBrandId = brand_id ? Number(brand_id) : null;
                if (!isSuperEmail) {
                    const invite = await consumeInviteCode(client, inviteCode);
                    if (!invite) { await client.query('ROLLBACK'); return res.status(400).json({ error: INVITE_ERROR }); }
                    if (effectiveBrandId && effectiveBrandId !== invite.brand_id) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ error: BRAND_MISMATCH_ERROR });
                    }
                    effectiveBrandId = invite.brand_id;
                    inviteId = invite.id;
                    if (!effectivePlan && invite.plan_slug) effectivePlan = invite.plan_slug;
                }
                if (!Number.isInteger(effectiveBrandId)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Geçersiz marka seçimi' }); }
                const brandCheck = await client.query('SELECT id, name FROM brands WHERE id = $1 AND is_active = true', [effectiveBrandId]);
                if (brandCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Geçersiz marka seçimi' }); }

                // Superuser e-postaları şifre ile kayıtta otomatik yetki ALMAZ; normal doğrulama akışı izlenir.
                const userInsert = await client.query(
                    `INSERT INTO users
                (email, password_hash, full_name, phone, role, brand_id, company_name, company_tax_office,
                 company_tax_number, job_title, dealer_or_distributor, city, is_active,
                 auth_provider, email_verified, email_verify_token, email_verify_expires, is_superuser)
             VALUES ($1, $2, $3, $4, 'brand_user', $5, $6, $7, $8, $9, $10, $11, true, 'password', false, $12, $13, false)
             RETURNING id, email, full_name, role, brand_id, company_name, job_title, is_superuser, email_verified`,
                    [
                        email, hash, full_name, phone || null, effectiveBrandId,
                        company_name, company_tax_office || null, company_tax_number || null,
                        job_title, dealer_or_distributor || 'bayi', city || null,
                        hashVerifyToken(verifyToken), verifyExpires
                    ]
                );
                newUser = userInsert.rows[0];

                // Plan seçimi varsa pending abonelik aç
                if (effectivePlan) {
                    const planRes = await client.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1 AND is_active = true', [String(effectivePlan).toLowerCase()]);
                    if (planRes.rows.length > 0) {
                        const subInsert = await client.query(
                            `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id, plan_id, status`,
                            [newUser.id, planRes.rows[0].id]
                        );
                        pendingSub = { ...subInsert.rows[0], plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
                    }
                }
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK').catch(() => {});
                if (txErr && txErr.code === '23505') { // aynı anda aynı e-posta ile kayıt
                    return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı' });
                }
                throw txErr;
            } finally {
                client.release();
            }

            await logAuthAudit(newUser.id, 'signup_password', req, { brand_id: effectiveBrandId, plan: effectivePlan || null, invite_id: inviteId });
            // E-posta doğrulama bağlantısı: hata/SMTP yokluğu kayıt akışını asla etkilemez.
            sendVerificationEmail(req, newUser, verifyToken, escapeMailHtml);
            // Oturum/çerez VERİLMEZ: giriş, e-posta doğrulandıktan sonra yapılır.
            res.status(201).json({
                message: 'Kayıt alındı. E-posta adresinize doğrulama bağlantısı gönderdik; doğruladıktan sonra giriş yapabilirsiniz.',
                email_verify_required: true,
                pending_subscription: pendingSub,
                verify_token_dev: !require('../lib/env').isProduction() ? verifyToken : undefined
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
            const { id_token, brand_id, plan_slug, company_name, job_title, invite_code } = req.body || {};
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
                // Pasif hesap Google ile de giremez (şifreli girişle aynı kural).
                if (user.is_active === false) {
                    await logAuthAudit(user.id, 'login_google_inactive', req);
                    return res.status(403).json({ error: 'Hesabınız pasif durumda. Lütfen destek ile iletişime geçin.' });
                }
                // Mevcut hesabı Google'a bağla. E-postası DOĞRULANMAMIŞ şifreli bir hesap devralınıyorsa (önceden
                // hesap ele geçirme: saldırgan kurbanın e-postasıyla kayıt olmuş olabilir) şifre silinir ve
                // eski oturumlar geçersiz kılınır.
                if (!user.google_id) {
                    const hijackable = user.email_verified !== true && user.password_hash;
                    await pool.query(
                        `UPDATE users SET google_id = $1, auth_provider = 'google', email_verified = true,
                                password_hash = CASE WHEN $3 THEN NULL ELSE password_hash END,
                                password_changed_at = CASE WHEN $3 THEN NOW() ELSE password_changed_at END
                         WHERE id = $2`,
                        [profile.google_id, user.id, !!hijackable]);
                    if (hijackable) {
                        require('../middleware/auth').invalidatePasswordChangedCache(user.id);
                        await logAuthAudit(user.id, 'google_link_cleared_unverified_password', req);
                    }
                }
                // Şifre deneme sayaçları sıfırlanmaz (Google girişi şifre kaba kuvvetini sıfırlamamalı).
                await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);
                // Superuser
                if (SUPERUSER_EMAILS.has(profile.email) && !user.is_superuser) {
                    await pool.query(`UPDATE users SET is_superuser = true, role = 'admin', email_verified = true WHERE id = $1`, [user.id]);
                    user.is_superuser = true; user.role = 'admin';
                }
                const challenge = require('../lib/mfa').mfaChallenge(user);
                if (challenge) {
                    await logAuthAudit(user.id, challenge.mfa_setup_required ? 'login_google_mfa_setup_required' : 'login_google_mfa_challenge', req);
                    return res.json(challenge);
                }
                await logAuthAudit(user.id, 'login_google', req);
                return res.json({ token: issueAuthToken(user), user: buildUserPayload(user), is_new: false });
            }

            // Yeni kullanıcı: davet kodu (süper kullanıcı hariç) + firma + unvan zorunlu; marka koddan gelir.
            const textErr = validateProfileText(req.body, ['company_name', 'job_title']);
            if (textErr) return res.status(400).json({ error: textErr });
            const isSuperuser = SUPERUSER_EMAILS.has(profile.email);
            const inviteCode = typeof invite_code === 'string' ? invite_code : '';
            if (!company_name || !job_title || (isSuperuser ? !brand_id : !inviteCode)) {
                return res.status(202).json({
                    code: 'GOOGLE_NEEDS_PROFILE',
                    google_email: profile.email,
                    google_name: profile.full_name,
                    message: 'Google ile kayıt için davet kodu, firma ve unvan bilgisi gerekli'
                });
            }

            const client = await pool.connect();
            let newUser, pendingSub = null, effectiveBrandId, inviteId = null;
            try {
                await client.query('BEGIN');
                effectiveBrandId = brand_id ? Number(brand_id) : null;
                let invitePlan = null;
                if (!isSuperuser) {
                    const invite = await consumeInviteCode(client, inviteCode);
                    if (!invite) { await client.query('ROLLBACK'); return res.status(400).json({ error: INVITE_ERROR }); }
                    if (effectiveBrandId && effectiveBrandId !== invite.brand_id) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ error: BRAND_MISMATCH_ERROR });
                    }
                    effectiveBrandId = invite.brand_id;
                    inviteId = invite.id;
                    invitePlan = invite.plan_slug;
                }
                if (!Number.isInteger(effectiveBrandId)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Geçersiz marka' }); }
                const brandCheck = await client.query('SELECT id FROM brands WHERE id = $1 AND is_active = true', [effectiveBrandId]);
                if (brandCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Geçersiz marka' }); }

                const ins = await client.query(
                    `INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name, job_title,
                                auth_provider, google_id, email_verified, is_superuser)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'google', $7, true, $8)
             RETURNING *`,
                    [profile.email, profile.full_name, isSuperuser ? 'admin' : 'brand_user',
                     effectiveBrandId, company_name, job_title, profile.google_id, isSuperuser]
                );
                newUser = ins.rows[0];

                const planSlug = plan_slug || invitePlan;
                if (planSlug) {
                    const planRes = await client.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1', [String(planSlug).toLowerCase()]);
                    if (planRes.rows.length > 0) {
                        const subIns = await client.query(
                            `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id`,
                            [newUser.id, planRes.rows[0].id]
                        );
                        pendingSub = { id: subIns.rows[0].id, plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
                    }
                }
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK').catch(() => {});
                throw txErr;
            } finally {
                client.release();
            }

            await logAuthAudit(newUser.id, 'signup_google', req, { brand_id: effectiveBrandId, invite_id: inviteId });
            const newChallenge = require('../lib/mfa').mfaChallenge(newUser);
            if (newChallenge) return res.status(201).json({ ...newChallenge, is_new: true });
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
