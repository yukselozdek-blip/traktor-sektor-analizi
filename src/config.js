'use strict';
// Env-derived constants and tiny helpers moved verbatim from server.js.
// dotenv must already be loaded (server.js calls require('dotenv').config() first).
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = (() => {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    if (require('./lib/env').isProduction()) {
        console.error('!!! GÜVENLİK UYARISI: JWT_SECRET ortam değişkeni tanımlı değil. Geçici rastgele anahtar üretildi; her yeniden başlatmada tüm oturumlar geçersiz olur. JWT_SECRET tanımlayın !!!');
    }
    return crypto.randomBytes(48).toString('hex');
})();
const SUPERUSER_EMAILS_LIST = (process.env.SUPERUSER_EMAILS || 'yukselozdek@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const { isProduction } = require('./lib/env');
const IS_PRODUCTION = isProduction();
function safeEqualStr(a, b) {
    const ba = Buffer.from(String(a == null ? '' : a));
    const bb = Buffer.from(String(b == null ? '' : b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
function errMsg(err) {
    return IS_PRODUCTION ? 'Sunucu hatası' : (err && err.message ? err.message : 'Sunucu hatası');
}

const PASSWORD_POLICY = /^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
const PASSWORD_POLICY_MESSAGE = 'Şifre en az 10 karakter, 1 büyük harf, 1 sayı ve 1 özel karakter içermeli';

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const WHATSAPP_QUERY_API_KEY = process.env.WHATSAPP_QUERY_API_KEY || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
// Baştaki/sondaki boşluk ve satır sonu temizlenir: yapıştırılan anahtarda görünmez boşluk olması köprüyle uyuşmazlığa (401) yol açıyordu.
const MEDIA_WATCH_WEBHOOK_KEY = String(process.env.MEDIA_WATCH_WEBHOOK_KEY || process.env.WHATSAPP_QUERY_API_KEY || '').trim();
const N8N_WHATSAPP_PROCESSOR_URL = (
    process.env.N8N_WHATSAPP_PROCESSOR_URL
    || (process.env.RAILWAY_SERVICE_N8N_URL ? `https://${process.env.RAILWAY_SERVICE_N8N_URL}/webhook/whatsapp-sales-assistant-process-v4` : '')
).replace(/\/$/, '');
const N8N_MODEL_INTEL_WEBHOOK_URL = (process.env.N8N_MODEL_INTEL_WEBHOOK_URL || '').replace(/\/$/, '');
const MODEL_IMAGE_BRIDGE_URL = (process.env.MODEL_IMAGE_BRIDGE_URL || 'http://127.0.0.1:3012').replace(/\/$/, '');

module.exports = {
    ROOT,
    PORT,
    JWT_SECRET,
    SUPERUSER_EMAILS_LIST,
    IS_PRODUCTION,
    safeEqualStr,
    errMsg,
    PASSWORD_POLICY,
    PASSWORD_POLICY_MESSAGE,
    APP_BASE_URL,
    WHATSAPP_QUERY_API_KEY,
    WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    MEDIA_WATCH_WEBHOOK_KEY,
    N8N_WHATSAPP_PROCESSOR_URL,
    N8N_MODEL_INTEL_WEBHOOK_URL,
    MODEL_IMAGE_BRIDGE_URL
};
