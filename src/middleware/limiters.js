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

const FORGOT_LIMITER = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla şifre sıfırlama isteği. 1 saat sonra tekrar deneyin.' }
});
// doğrulama e-postasını yeniden gönderme (saatte 5)
const RESEND_LIMITER = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla doğrulama e-postası isteği. 1 saat sonra tekrar deneyin.' }
});
// validate + reset uç noktaları için (token tahminini zorlaştırır)
const RESET_LIMITER = rateLimit({
    windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla deneme. Lütfen daha sonra tekrar deneyin.' }
});

module.exports = { LOGIN_LIMITER, SIGNUP_LIMITER, FORGOT_LIMITER, RESET_LIMITER, RESEND_LIMITER };
