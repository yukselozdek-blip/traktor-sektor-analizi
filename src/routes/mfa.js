'use strict';
// İki adımlı doğrulama (TOTP) uç noktaları: giriş doğrulama, kurulum, etkinleştirme, kapatma, kurtarma kodları, yönetici sıfırlaması.
const bcrypt = require('bcryptjs');
const { logRouteError } = require('../lib/log-error');
const totp = require('../lib/totp');
const { adminMfaEnforced, isPrivileged, verifyMfaToken } = require('../lib/mfa');

const LOCK_MS = 15 * 60 * 1000;
const GENERIC_FAIL = 'Doğrulama kodu geçersiz veya süresi dolmuş.';

module.exports = function registerMfa(app, ctx) {
    const { pool, authMiddleware, adminOnly, LOGIN_LIMITER, logAuthAudit, issueAuthToken, buildUserPayload } = ctx;

    const loadUser = async id => (await pool.query(
        `SELECT u.*, b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color, b.accent_color, b.text_color, b.logo_url
         FROM users u LEFT JOIN brands b ON u.brand_id = b.id WHERE u.id = $1 AND u.is_active = true`, [id])).rows[0];

    // Yanlış kod sayacı şifre kilidiyle ortaktır (5 hata → 15 dk).
    const isLocked = u => u.locked_until && new Date(u.locked_until) > new Date();
    async function registerFailure(user, req, event) {
        const n = (user.failed_login_count || 0) + 1;
        await pool.query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3',
            [n, n >= 5 ? new Date(Date.now() + LOCK_MS) : null, user.id]);
        await logAuthAudit(user.id, event, req, { count: n });
    }

    // TOTP kodunu doğrular ve adımı atomik olarak tüketir (aynı kod ikinci kez kullanılamaz).
    async function consumeTotp(user, code) {
        if (!user.totp_secret_enc) return false;
        let secret;
        try { secret = totp.decryptSecret(user.totp_secret_enc); } catch (_) { return false; }
        const step = totp.verifyTotp(secret, code);
        if (step === null) return false;
        const r = await pool.query(
            'UPDATE users SET totp_last_step = $1 WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1) RETURNING id', [step, user.id]);
        return r.rows.length === 1;
    }
    async function consumeRecovery(user, code) {
        const h = totp.hashRecovery(code);
        const r = await pool.query(
            `UPDATE users SET totp_recovery_hashes = totp_recovery_hashes - $2::text
             WHERE id = $1 AND totp_recovery_hashes @> to_jsonb($2::text) RETURNING id`, [user.id, h]);
        return r.rows.length === 1;
    }
    const looksLikeRecovery = code => /^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(String(code || '').trim());

    // Kurulum/etkinleştirme kimliği: oturum açmış kullanıcı YA DA zorunlu kurulum için verilen kısa ömürlü 'setup' token'ı.
    function setupActor(req, res, next) {
        if (req.body && req.body.mfa_token) {
            const uid = verifyMfaToken(req.body.mfa_token, 'setup');
            if (!uid) return res.status(401).json({ error: 'Oturum süresi doldu. Lütfen yeniden giriş yapın.' });
            req.mfaActorId = uid; req.viaSetupToken = true;
            return next();
        }
        return authMiddleware(req, res, () => { req.mfaActorId = req.user.id; next(); });
    }

    // 1) Giriş ikinci adım: kod (veya kurtarma kodu) → oturum
    app.post('/api/auth/2fa/verify', LOGIN_LIMITER, async (req, res) => {
        try {
            const uid = verifyMfaToken(req.body?.mfa_token, 'verify');
            const code = String(req.body?.code || '').trim();
            if (!uid || !code) return res.status(401).json({ error: GENERIC_FAIL });
            const user = await loadUser(uid);
            if (!user || !user.totp_enabled) return res.status(401).json({ error: GENERIC_FAIL });
            if (isLocked(user)) {
                await logAuthAudit(user.id, 'mfa_blocked_locked', req);
                return res.status(401).json({ error: GENERIC_FAIL });
            }
            const ok = looksLikeRecovery(code) ? await consumeRecovery(user, code) : await consumeTotp(user, code);
            if (!ok) { await registerFailure(user, req, 'mfa_failed'); return res.status(401).json({ error: GENERIC_FAIL }); }
            await pool.query('UPDATE users SET last_login = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
            await logAuthAudit(user.id, looksLikeRecovery(code) ? 'mfa_login_recovery' : 'mfa_login_success', req);
            const remaining = (await pool.query('SELECT jsonb_array_length(totp_recovery_hashes) AS n FROM users WHERE id = $1', [user.id])).rows[0].n;
            res.json({ token: issueAuthToken(user), user: buildUserPayload(user), recovery_codes_remaining: remaining });
        } catch (err) { logRouteError(req, err, 'POST /api/auth/2fa/verify'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // 2) Durum
    app.get('/api/auth/2fa/status', authMiddleware, async (req, res) => {
        try {
            const u = (await pool.query('SELECT role, is_superuser, totp_enabled, jsonb_array_length(totp_recovery_hashes) AS n FROM users WHERE id = $1', [req.user.id])).rows[0];
            if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            res.json({ enabled: !!u.totp_enabled, required: isPrivileged(u) && adminMfaEnforced(), recovery_codes_remaining: u.totp_enabled ? u.n : 0 });
        } catch (err) { logRouteError(req, err, 'GET /api/auth/2fa/status'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // 3) Kurulum başlat: yeni (henüz etkin olmayan) secret üretir
    app.post('/api/auth/2fa/setup', LOGIN_LIMITER, setupActor, async (req, res) => {
        try {
            const user = await loadUser(req.mfaActorId);
            if (!user) return res.status(401).json({ error: 'Geçersiz oturum' });
            if (user.totp_enabled) return res.status(409).json({ error: 'İki adımlı doğrulama zaten etkin' });
            // Kurulum tamamlanana kadar aynı (bekleyen) secret döner: sayfa yenilenir ya da yeniden giriş yapılırsa
            // telefona eklenmiş anahtar geçersiz kalmasın. Yeni anahtar yalnızca açıkça istenirse üretilir.
            let secret = null;
            if (user.totp_secret_enc && req.body?.regenerate !== true) {
                try { secret = totp.decryptSecret(user.totp_secret_enc); } catch (_) { secret = null; }
            }
            if (!secret) {
                secret = totp.generateSecret();
                await pool.query('UPDATE users SET totp_secret_enc = $1, totp_last_step = NULL WHERE id = $2', [totp.encryptSecret(secret), user.id]);
            }
            await logAuthAudit(user.id, 'mfa_setup_started', req);
            res.json({ secret, otpauth_uri: totp.otpauthUri(secret, user.email) });
        } catch (err) { logRouteError(req, err, 'POST /api/auth/2fa/setup'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // 4) Etkinleştir: ilk kodu doğrular, kurtarma kodlarını bir kez gösterir
    app.post('/api/auth/2fa/enable', LOGIN_LIMITER, setupActor, async (req, res) => {
        try {
            const user = await loadUser(req.mfaActorId);
            if (!user) return res.status(401).json({ error: 'Geçersiz oturum' });
            if (user.totp_enabled) return res.status(409).json({ error: 'İki adımlı doğrulama zaten etkin' });
            if (isLocked(user)) return res.status(401).json({ error: GENERIC_FAIL });
            if (!(await consumeTotp(user, req.body?.code))) { await registerFailure(user, req, 'mfa_enable_failed'); return res.status(400).json({ error: GENERIC_FAIL }); }
            const { codes, hashes } = totp.generateRecoveryCodes();
            await pool.query(`UPDATE users SET totp_enabled = true, totp_enabled_at = NOW(), totp_recovery_hashes = $1::jsonb,
                              failed_login_count = 0, locked_until = NULL WHERE id = $2`, [JSON.stringify(hashes), user.id]);
            await logAuthAudit(user.id, 'mfa_enabled', req);
            const body = { enabled: true, recovery_codes: codes };
            if (req.viaSetupToken) { body.token = issueAuthToken(user); body.user = buildUserPayload(user); }
            res.json(body);
        } catch (err) { logRouteError(req, err, 'POST /api/auth/2fa/enable'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // Şifre (varsa) + güncel kod ile yeniden doğrulama: kapatma ve kurtarma kodu yenileme için.
    async function reauth(req, user) {
        if (user.password_hash && !(await bcrypt.compare(String(req.body?.password || ''), user.password_hash))) return false;
        return consumeTotp(user, req.body?.code);
    }

    // 5) Kapat (yönetici/süper kullanıcı için zorunluluk açıkken yasak)
    app.post('/api/auth/2fa/disable', LOGIN_LIMITER, authMiddleware, async (req, res) => {
        try {
            const user = await loadUser(req.user.id);
            if (!user || !user.totp_enabled) return res.status(400).json({ error: 'İki adımlı doğrulama etkin değil' });
            if (isPrivileged(user) && adminMfaEnforced()) return res.status(403).json({ error: 'Yönetici hesaplarında iki adımlı doğrulama zorunludur ve kapatılamaz.' });
            if (isLocked(user)) return res.status(401).json({ error: GENERIC_FAIL });
            if (!(await reauth(req, user))) { await registerFailure(user, req, 'mfa_disable_failed'); return res.status(401).json({ error: 'Şifre veya doğrulama kodu hatalı.' }); }
            await pool.query(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, totp_recovery_hashes = '[]'::jsonb WHERE id = $1`, [user.id]);
            await logAuthAudit(user.id, 'mfa_disabled', req);
            res.json({ enabled: false });
        } catch (err) { logRouteError(req, err, 'POST /api/auth/2fa/disable'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // 6) Kurtarma kodlarını yenile
    app.post('/api/auth/2fa/recovery-codes', LOGIN_LIMITER, authMiddleware, async (req, res) => {
        try {
            const user = await loadUser(req.user.id);
            if (!user || !user.totp_enabled) return res.status(400).json({ error: 'İki adımlı doğrulama etkin değil' });
            if (isLocked(user)) return res.status(401).json({ error: GENERIC_FAIL });
            if (!(await reauth(req, user))) { await registerFailure(user, req, 'mfa_recovery_regen_failed'); return res.status(401).json({ error: 'Şifre veya doğrulama kodu hatalı.' }); }
            const { codes, hashes } = totp.generateRecoveryCodes();
            await pool.query('UPDATE users SET totp_recovery_hashes = $1::jsonb WHERE id = $2', [JSON.stringify(hashes), user.id]);
            await logAuthAudit(user.id, 'mfa_recovery_regenerated', req);
            res.json({ recovery_codes: codes });
        } catch (err) { logRouteError(req, err, 'POST /api/auth/2fa/recovery-codes'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });

    // 7) Cihaz kaybı: yalnızca süper kullanıcı başka bir kullanıcının 2FA'sını sıfırlar (kullanıcı sonraki girişte yeniden kurar/kurulum zorunlu olur)
    app.post('/api/admin/users/:id/2fa-reset', authMiddleware, adminOnly, async (req, res) => {
        try {
            if (!req.user.sup) return res.status(403).json({ error: 'Bu işlem yalnızca süper kullanıcılara açıktır' });
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'Geçersiz kullanıcı' });
            if (id === req.user.id) return res.status(400).json({ error: 'Kendi hesabınızın iki adımlı doğrulamasını bu yolla sıfırlayamazsınız' });
            const r = await pool.query(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, totp_recovery_hashes = '[]'::jsonb WHERE id = $1 RETURNING id`, [id]);
            if (!r.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            await logAuthAudit(id, 'mfa_reset_by_admin', req, { by: req.user.id });
            res.json({ ok: true });
        } catch (err) { logRouteError(req, err, 'POST /api/admin/users/:id/2fa-reset'); res.status(500).json({ error: 'Sunucu hatası' }); }
    });
};
