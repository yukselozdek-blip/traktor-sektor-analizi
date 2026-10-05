'use strict';
// İki adımlı doğrulama kapısı: kimin 2FA'ya tabi olduğu ve kısa ömürlü "mfa" ara token'ı.
// Ara token farklı bir anahtarla imzalanır; oturum token'ı olarak ASLA kabul edilmez.
const jwt = require('jsonwebtoken');
const { isProduction } = require('./env');

const MFA_TOKEN_TTL = '5m';
const mfaKey = () => (process.env.JWT_SECRET || '') + ':mfa-step';

// Zorunluluk: üretimde varsayılan açık; REQUIRE_ADMIN_2FA=1 ile her ortamda açılır, =0 ile kapatılır (acil geri alma).
function adminMfaEnforced() {
    const v = process.env.REQUIRE_ADMIN_2FA;
    if (v === '0') return false;
    return v === '1' || isProduction();
}
const isPrivileged = user => user.role === 'admin' || !!user.is_superuser;

// 'verify' (kod iste), 'setup' (kurulum zorunlu) ya da null (ek adım yok)
function mfaGate(user) {
    if (user.totp_enabled) return 'verify';
    if (isPrivileged(user) && adminMfaEnforced()) return 'setup';
    return null;
}

const signMfaToken = (userId, purpose) => jwt.sign({ uid: userId, pur: purpose }, mfaKey(), { algorithm: 'HS256', expiresIn: MFA_TOKEN_TTL });
function verifyMfaToken(token, purpose) {
    try {
        const p = jwt.verify(String(token || ''), mfaKey(), { algorithms: ['HS256'] });
        return p && p.pur === purpose && Number.isInteger(p.uid) ? p.uid : null;
    } catch (_) { return null; }
}

function mfaChallenge(user) {
    const gate = mfaGate(user);
    if (!gate) return null;
    return gate === 'verify'
        ? { mfa_required: true, mfa_token: signMfaToken(user.id, 'verify') }
        : { mfa_required: true, mfa_setup_required: true, mfa_token: signMfaToken(user.id, 'setup') };
}

module.exports = { adminMfaEnforced, isPrivileged, mfaGate, mfaChallenge, signMfaToken, verifyMfaToken };
