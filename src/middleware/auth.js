'use strict';
// authMiddleware / adminOnly moved verbatim from server.js.
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { pool } = require('../db');

// Şifre sıfırlamadan önce verilmiş JWT'leri geçersiz kılmak için küçük bellek içi önbellek:
// userId -> { at: password_changed_at (epoch sn, yoksa 0), exp: önbellek bitişi (ms) }.
// Çoklu replika durumunda başka süreçlerde en fazla TTL kadar gecikir.
const PWD_CHANGED_TTL_MS = 60 * 1000;
const PWD_CHANGED_MAX = 10000;
const pwdChangedCache = new Map();

function invalidatePasswordChangedCache(userId) {
    if (userId == null) pwdChangedCache.clear();
    else pwdChangedCache.delete(Number(userId));
}

async function getPasswordChangedAt(userId) {
    const hit = pwdChangedCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.at;
    const r = await pool.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
    const d = r.rows[0] && r.rows[0].password_changed_at;
    const at = d ? Math.floor(new Date(d).getTime() / 1000) : 0;
    if (pwdChangedCache.size >= PWD_CHANGED_MAX) pwdChangedCache.clear();
    pwdChangedCache.set(userId, { at, exp: Date.now() + PWD_CHANGED_TTL_MS });
    return at;
}

async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token gerekli' });
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Geçersiz token' });
    }
    // Şifre değişiminden önce verilmiş token'ı reddet. Yalnızca DB hatasında açık (fail-open) davranır.
    if (payload && payload.iat && payload.id != null) {
        try {
            const changedAt = await getPasswordChangedAt(Number(payload.id));
            if (changedAt && payload.iat < changedAt) {
                return res.status(401).json({ error: 'Oturum geçersiz. Lütfen tekrar giriş yapın.' });
            }
        } catch (err) {
            console.error('authMiddleware: password_changed_at kontrolü atlandı:', err && err.message);
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

module.exports = { authMiddleware, adminOnly, invalidatePasswordChangedCache };
