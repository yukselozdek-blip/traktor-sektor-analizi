'use strict';
// RFC 6238 TOTP (SHA-1, 6 hane, 30 sn) + secret şifreleme + kurtarma kodları. Harici bağımlılık yok.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    const clean = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) throw new Error('Geçersiz base32');
        value = (value << 5) | idx; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBase32, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
    const off = h[h.length - 1] & 0xf;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

// Kodu ±1 adım toleransla doğrular; eşleşen adım numarasını döndürür (tekrar kullanım engeli çağırana ait), yoksa null.
function verifyTotp(secretBase32, code, nowMs = Date.now(), window = 1) {
    const c = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) return null;
    const step = currentStep(nowMs);
    const given = Buffer.from(c);
    let matched = null;
    for (let d = -window; d <= window; d++) {
        const exp = Buffer.from(hotp(secretBase32, step + d));
        if (crypto.timingSafeEqual(exp, given) && matched === null) matched = step + d;
    }
    return matched;
}

function otpauthUri(secret, email, issuer = 'Traktör Sektör Analizi') {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

const encKey = () => crypto.createHash('sha256').update('totp-secret:' + (process.env.TOTP_ENC_KEY || process.env.JWT_SECRET || '')).digest();
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function decryptSecret(blob) {
    const [iv, tag, ct] = String(blob).split('.').map(p => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const hashRecovery = code => crypto.createHash('sha256').update(String(code).trim().toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
function generateRecoveryCodes(n = 10) {
    const codes = Array.from({ length: n }, () => {
        const h = crypto.randomBytes(5).toString('hex');
        return `${h.slice(0, 5)}-${h.slice(5)}`;
    });
    return { codes, hashes: codes.map(hashRecovery) };
}

module.exports = { generateSecret, verifyTotp, currentStep, otpauthUri, encryptSecret, decryptSecret, hashRecovery, generateRecoveryCodes, base32Encode, base32Decode, hotp };
