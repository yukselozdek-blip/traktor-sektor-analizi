'use strict';
// Minimal SMTP mailer (nodemailer). SMTP yoksa asla throw etmez: {sent:false} döner.
// Test kancası: MAIL_OUTBOX_FILE tanımlı ve NODE_ENV !== 'production' ise mesajlar
// SMTP yerine JSON satırı olarak bu dosyaya eklenir.
const fs = require('fs');

let transporter = null;
let warned = false;

function isMailConfigured() {
    return !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function outboxFile() {
    return process.env.NODE_ENV !== 'production' && process.env.MAIL_OUTBOX_FILE ? process.env.MAIL_OUTBOX_FILE : '';
}

function getTransporter() {
    if (transporter) return transporter;
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });
    return transporter;
}

async function sendMail({ to, subject, text, html } = {}) {
    try {
        if (!to || !subject) return { sent: false, error: 'invalid_message' };
        const outbox = outboxFile();
        if (outbox) {
            fs.appendFileSync(outbox, JSON.stringify({ to, subject, text, html, at: new Date().toISOString() }) + '\n');
            return { sent: true, outbox: true };
        }
        if (!isMailConfigured()) {
            if (!warned) {
                warned = true;
                console.warn('[mailer] SMTP yapılandırılmamış (SMTP_HOST / MAIL_FROM). E-postalar (şifre sıfırlama, e-posta doğrulama) gönderilmeyecek.');
            }
            return { sent: false, error: 'not_configured' };
        }
        await getTransporter().sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
        return { sent: true };
    } catch (err) {
        // Token/link içerebilecek ayrıntıyı loglama; yalnızca hata kodu/mesajı.
        console.error('[mailer] E-posta gönderilemedi:', err && err.code ? err.code : (err && err.message) || err);
        return { sent: false, error: 'send_failed' };
    }
}

module.exports = { isMailConfigured, sendMail };
