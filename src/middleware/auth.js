'use strict';
// authMiddleware / adminOnly moved verbatim from server.js.
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { pool } = require('../db');
const { getRequestToken, csrfOk } = require('../lib/session');

// Şifre sıfırlamadan önce verilmiş JWT'leri geçersiz kılmak için küçük bellek içi önbellek:
// userId -> { at: password_changed_at (epoch sn, yoksa 0), exp: önbellek bitişi (ms) }.
// Çoklu replika durumunda başka süreçlerde en fazla TTL kadar gecikir.
// CSRF için izin verilen ek origin'ler (server.js CORS listesini verir); aynı host her zaman geçerlidir.
let csrfAllowedOrigins = new Set();
function setCsrfAllowedOrigins(set) { csrfAllowedOrigins = set; }

const PWD_CHANGED_TTL_MS = 60 * 1000;
const PWD_CHANGED_MAX = 10000;
const pwdChangedCache = new Map();

function invalidatePasswordChangedCache(userId) {
    if (userId == null) pwdChangedCache.clear();
    else pwdChangedCache.delete(Number(userId));
}

// Kullanıcının güncel kimlik durumu (en fazla PWD_CHANGED_TTL_MS eski): şifre değişim zamanı, aktiflik, rol, marka.
// JWT 7 gün geçerlidir; pasife alınan / rolü düşürülen / markası değişen kullanıcı eski token'la erişmesin diye
// yetki bilgisi her zaman buradan (DB) okunur.
async function getAuthState(userId) {
    const hit = pwdChangedCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit;
    const r = await pool.query('SELECT password_changed_at, is_active, role, brand_id, is_superuser FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    const d = u && u.password_changed_at;
    const entry = {
        missing: !u,
        at: d ? Math.floor(new Date(d).getTime() / 1000) : 0,
        active: u ? u.is_active !== false : false,
        role: u ? u.role : null,
        brand_id: u ? u.brand_id : null,
        sup: u ? !!u.is_superuser : false,
        exp: Date.now() + PWD_CHANGED_TTL_MS
    };
    if (pwdChangedCache.size >= PWD_CHANGED_MAX) pwdChangedCache.clear();
    pwdChangedCache.set(userId, entry);
    return entry;
}

async function authMiddleware(req, res, next) {
    const found = getRequestToken(req);
    if (!found) return res.status(401).json({ error: 'Token gerekli' });
    const token = found.token;
    // Çerezle kimlik doğrulanan değiştirici isteklerde CSRF koruması (Bearer isteklerinde gerekmez).
    if (found.source === 'cookie' && !csrfOk(req, csrfAllowedOrigins)) {
        return res.status(403).json({ error: 'İstek doğrulanamadı (CSRF)' });
    }
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Geçersiz token' });
    }
    // Şifre değişiminden önce verilmiş token'ı, silinmiş/pasif kullanıcıyı reddet; rol/marka DB'den alınır.
    // Yalnızca DB hatasında açık (fail-open) davranır.
    if (payload && payload.id != null) {
        try {
            const st = await getAuthState(Number(payload.id));
            if (st.missing || !st.active || (st.at && payload.iat && payload.iat < st.at)) {
                return res.status(401).json({ error: 'Oturum geçersiz. Lütfen tekrar giriş yapın.' });
            }
            payload = { ...payload, role: st.role, brand_id: st.brand_id, sup: st.sup };
        } catch (err) {
            // Fail-closed: kullanıcının aktiflik/rol/şifre-değişim durumu doğrulanamıyorsa isteği geçirme
            // (DB yokken zaten hiçbir rota çalışmaz; "açık geçmek" yalnızca eski/iptal token'a izin verirdi).
            console.error('authMiddleware: kullanıcı durumu doğrulanamadı:', err && err.message);
            return res.status(503).json({ error: 'Oturum doğrulanamadı. Lütfen kısa süre sonra tekrar deneyin.' });
        }
    }
    req.user = payload;
    next();
}

async function adminOnly(req, res, next) {
    try {
        if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Yetkisiz erişim' });
        const r = await pool.query('SELECT role, is_active FROM users WHERE id = $1', [req.user.id]);
        const u = r.rows[0];
        if (!u || u.role !== 'admin' || u.is_active === false) {
            return res.status(403).json({ error: 'Yetkisiz erişim' });
        }
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Sunucu hatası' });
    }
}

module.exports = { authMiddleware, adminOnly, invalidatePasswordChangedCache, setCsrfAllowedOrigins };
