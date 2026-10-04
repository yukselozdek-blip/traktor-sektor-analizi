'use strict';
// E-posta doğrulama bağlantısı gönderimi (kayıt ve yeniden gönderim ortak kullanır).
// Hata/SMTP yokluğu çağıran akışı asla bozmaz.
const crypto = require('crypto');
const { getBaseUrl } = require('./app-url');
const { sendMail } = require('./mailer');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const newVerifyToken = () => crypto.randomBytes(24).toString('hex');
const verifyExpiry = () => new Date(Date.now() + VERIFY_TTL_MS);

function sendVerificationEmail(req, user, token, escapeMailHtml) {
    try {
        const base = getBaseUrl(req);
        if (!base) return;
        const link = `${base}/api/auth/verify-email?token=${token}`;
        sendMail({
            to: user.email,
            subject: 'E-posta adresinizi doğrulayın - Traktör Sektör Analizi',
            text: `Merhaba ${user.full_name || ''},\n\nTraktör Sektör Analizi hesabınızı doğrulamak için aşağıdaki bağlantıya tıklayın (24 saat geçerlidir):\n${link}\n\nBu kaydı siz yapmadıysanız bu e-postayı yok sayabilirsiniz.`,
            html: `<p>Merhaba ${escapeMailHtml(user.full_name || '')},</p><p>Traktör Sektör Analizi hesabınızı doğrulamak için aşağıdaki bağlantıya tıklayın (24 saat geçerlidir):</p><p><a href="${link}">E-postamı doğrula</a></p><p>Bu kaydı siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>`
        }).catch(() => {});
    } catch (_) { /* akış bozulmamalı */ }
}

module.exports = { VERIFY_TTL_MS, newVerifyToken, verifyExpiry, sendVerificationEmail };
