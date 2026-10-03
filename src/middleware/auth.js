'use strict';
// authMiddleware / adminOnly moved verbatim from server.js.
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { pool } = require('../db');

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token gerekli' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Geçersiz token' });
    }
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

module.exports = { authMiddleware, adminOnly };
