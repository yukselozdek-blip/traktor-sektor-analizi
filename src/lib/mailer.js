'use strict';
// Minimal SMTP mailer (nodemailer). SMTP yoksa asla throw etmez: {sent:false} döner.
// Test kancası: MAIL_OUTBOX_FILE tanımlı ve NODE_ENV !== 'production' ise mesajlar
// SMTP yerine JSON satırı olarak bu dosyaya eklenir.
const fs = require('fs');

let transporter = null;
let warned = false;

// Railway (Free/Hobby) giden SMTP portlarını (25/465/587) engeller; bu yüzden HTTPS üzerinden
// çalışan Brevo API'si öncelikli, SMTP ikinci seçenek.
function hasBrevoApi() {
    return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

function isMailConfigured() {
    return hasBrevoApi() || !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function parseFrom(from) {
    const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(from || '').trim() };
}

async function sendViaBrevoApi({ to, subject, text, html }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                sender: parseFrom(process.env.MAIL_FROM),
                to: [{ email: to }],
                subject,
                textContent: text || undefined,
                htmlContent: html || (text ? `<pre>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` : undefined)
            }),
            signal: ctrl.signal
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            const e = new Error(`brevo_http_${resp.status} ${body.slice(0, 200)}`);
            throw e;
        }
    } finally {
        clearTimeout(timer);
    }
}

function outboxFile() {
    return !require('./env').isProduction() && process.env.MAIL_OUTBOX_FILE ? process.env.MAIL_OUTBOX_FILE : '';
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
                console.warn('[mailer] SMTP yapılandırılmamış (BREVO_API_KEY veya SMTP_HOST, ve MAIL_FROM). E-postalar (şifre sıfırlama, e-posta doğrulama) gönderilmeyecek.');
            }
            return { sent: false, error: 'not_configured' };
        }
        if (hasBrevoApi()) {
            await sendViaBrevoApi({ to, subject, text, html });
            console.log('[mailer] e-posta Brevo API\'ye teslim edildi');
            return { sent: true };
        }
        await getTransporter().sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
        console.log('[mailer] e-posta SMTP ile teslim edildi');
        return { sent: true };
    } catch (err) {
        // Token/link içerebilecek ayrıntıyı loglama; yalnızca hata kodu/mesajı.
        console.error('[mailer] E-posta gönderilemedi:', err && err.code ? err.code : (err && err.message) || err);
        return { sent: false, error: 'send_failed' };
    }
}

module.exports = { isMailConfigured, sendMail };
