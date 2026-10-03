'use strict';
// LOGIN_LIMITER / SIGNUP_LIMITER moved verbatim from server.js.
const rateLimit = require('express-rate-limit');

const LOGIN_LIMITER = rateLimit({
    windowMs: 5 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla giriş denemesi. 5 dakika bekleyin.' }
});
const SIGNUP_LIMITER = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla kayıt denemesi. 1 saat bekleyin.' }
});

module.exports = { LOGIN_LIMITER, SIGNUP_LIMITER };
