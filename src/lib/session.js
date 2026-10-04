'use strict';
// Oturum çerezi (httpOnly) yardımcıları. Tarayıcı JWT'yi çerezle taşır (JS erişemez: XSS ile çalınamaz);
// API istemcileri (n8n vb.) Authorization: Bearer kullanmaya devam eder.
// CSRF: çerezle kimlik doğrulanan değiştirici istekler (POST/PUT/PATCH/DELETE) özel başlık
// (X-Requested-With: XMLHttpRequest) ve eşleşen Origin gerektirir; ayrıca çerez SameSite=Lax'tir.
const COOKIE_NAME = 'tk_session';
const MAX_AGE_S = 7 * 24 * 60 * 60; // JWT ömrüyle (7 gün) aynı
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k || k in out) continue;
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
    }
    return out;
}

// Authorization: Bearer önceliklidir (açık istemci niyeti); yoksa oturum çerezi.
function getRequestToken(req) {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer !== auth) return { token: bearer, source: 'bearer' };
    const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (cookie) return { token: cookie, source: 'cookie' };
    return null;
}

function isSecureRequest(req) {
    return process.env.NODE_ENV === 'production' || req.secure === true;
}

function setSessionCookie(req, res, token) {
    res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${isSecureRequest(req) ? '; Secure' : ''}`);
}

function clearSessionCookie(req, res) {
    res.append('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isSecureRequest(req) ? '; Secure' : ''}`);
}

// Çerezle gelen değiştirici isteklerde CSRF doğrulaması. true = geçerli.
function csrfOk(req, allowedOrigins = new Set()) {
    if (SAFE_METHODS.has(req.method)) return true;
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return false;
    const origin = req.headers.origin;
    if (!origin) return true; // aynı-origin fetch bazı tarayıcılarda Origin göndermez; özel başlık zaten şart
    const norm = String(origin).replace(/\/$/, '');
    if (allowedOrigins.has(norm)) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

module.exports = { COOKIE_NAME, parseCookies, getRequestToken, setSessionCookie, clearSessionCookie, csrfOk };
