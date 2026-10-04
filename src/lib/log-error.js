'use strict';
// Merkezi hata günlükleme. Yanıt gövdesini/durum kodunu DEĞİŞTİRMEZ; yalnızca Railway günlüğüne
// tek satırlık, makinece okunabilir kayıt yazar.
//  - logRouteError(req, err, label?)  : rota catch bloklarından (req yoksa null verilebilir)
//  - fiveXxLogger                     : res 'finish' içinde >= 500 yanıtları için ara katman
//  - globalErrorHandler               : Express son çare hata ara katmanı
// Gizlilik: query string asla yazılmaz; e-posta, JWT/Bearer, parola/token benzeri değerler ve bağlantı
// dizesindeki kimlik bilgileri maskelenir. İstek gövdesi/başlıkları hiç okunmaz.

const RATE_MAX = 20;
const RATE_WINDOW_MS = 60 * 1000;

// Aynı anahtar için pencere başına en çok `max` satır; fazlası sayılır, pencere kapanınca özet verilir.
function createRateLimiter({ max = RATE_MAX, windowMs = RATE_WINDOW_MS, now = Date.now, onSummary } = {}) {
    const state = new Map();
    function flushOne(key, s) {
        if (s.suppressed > 0 && onSummary) onSummary(key, s.suppressed);
    }
    return {
        // true -> satır yazılabilir
        allow(key) {
            const t = now();
            let s = state.get(key);
            if (s && t - s.start >= windowMs) { flushOne(key, s); s = null; }
            if (!s) { s = { start: t, count: 0, suppressed: 0 }; state.set(key, s); }
            if (s.count < max) { s.count++; return true; }
            s.suppressed++;
            return false;
        },
        // Süresi dolan pencerelerin özetlerini yaz ve temizle
        sweep() {
            const t = now();
            for (const [key, s] of state) {
                if (t - s.start >= windowMs) { flushOne(key, s); state.delete(key); }
            }
        },
        size: () => state.size
    };
}

let sink = (line) => console.error(line);
const limiter = createRateLimiter({
    onSummary: (key, n) => sink(`[log-bastirildi] ${new Date().toISOString()} ${key} bastırıldı (${n})`)
});
{
    const timer = setInterval(() => limiter.sweep(), RATE_WINDOW_MS);
    if (timer.unref) timer.unref();
}

// ---- maskeleme ----
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi;
const CONN_CRED_RE = /:\/\/[^\/\s@'"]*@/g; // postgres://user:pass@host -> ://***@host
const KV_SECRET_RE = /\b((?:pass(?:word|wd)?|parola|sifre|şifre|secret|token|api[_-]?key|apikey|authorization|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi;

function sanitizeText(value, max) {
    let s = typeof value === 'string' ? value : (value == null ? '' : String(value));
    s = s.replace(CONN_CRED_RE, '://***@')
        .replace(JWT_RE, '[jwt]')
        .replace(BEARER_RE, '$1 [gizli]')
        .replace(KV_SECRET_RE, '$1[gizli]')
        .replace(EMAIL_RE, '[email]');
    if (max && s.length > max) s = s.slice(0, max);
    return s;
}

// Yalnızca path: query/hash atılır; token gibi görünen uzun segmentler maskelenir.
function safePath(req) {
    if (!req) return '-';
    let u = String(req.originalUrl || req.url || '');
    u = u.split('?')[0].split('#')[0];
    u = u.split('/').map(seg => (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg) ? ':gizli' : seg)).join('/');
    return sanitizeText(u, 200);
}

function userId(req) {
    const id = req && req.user && req.user.id;
    return id === undefined || id === null ? null : String(id).slice(0, 40);
}

function stackHead(err) {
    if (!err || typeof err.stack !== 'string') return [];
    return err.stack.split('\n').slice(0, 3).map(l => sanitizeText(l.trim(), 300));
}

function formatRouteError(req, err, label, nowDate = new Date()) {
    const e = err && typeof err === 'object' ? err : { message: err };
    const rec = {
        ts: nowDate.toISOString(),
        req: req ? `${req.method || '-'} ${safePath(req)}` : '-',
        user: userId(req),
        label: label || null,
        code: e.code !== undefined && e.code !== null ? sanitizeText(String(e.code), 40) : null,
        message: sanitizeText(e.message !== undefined ? e.message : e, 300)
    };
    if (e.detail) rec.detail = sanitizeText(String(e.detail), 300);
    rec.stack = stackHead(err);
    return rec;
}

function logRouteError(req, err, label) {
    try {
        const rec = formatRouteError(req, err, label);
        if (!limiter.allow(`err:${rec.label || '-'}:${rec.code || '-'}`)) return;
        sink('[route-error] ' + JSON.stringify(rec));
    } catch (_) { /* günlükleme asla isteği bozmamalı */ }
}

// 5xx izleme: gövde yazılmaz. /health hariç.
function fiveXxLogger(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        try {
            if (res.statusCode < 500) return;
            const p = safePath(req);
            if (p === '/health') return;
            if (!limiter.allow(`5xx:${req.method} ${p}:${res.statusCode}`)) return;
            const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
            sink(`[5xx] ${req.method} ${p} ${res.statusCode} ${ms}ms user=${userId(req) || '-'}`);
        } catch (_) { /* noop */ }
    });
    next();
}

// Express son çare hata ara katmanı (4 argüman şart). 4xx (JSON ayrıştırma 400, entity.too.large 413 vb.)
// ve gönderilmiş yanıtlar Express'in varsayılan işleyicisine bırakılır: mevcut davranış korunur.
function globalErrorHandler(err, req, res, next) {
    const status = err && (err.status || err.statusCode);
    if (res.headersSent || (Number.isInteger(status) && status >= 400 && status < 500)) return next(err);
    logRouteError(req, err, 'global-error-handler');
    res.status(500).json({ error: 'Sunucu hatası' });
}

module.exports = {
    logRouteError, fiveXxLogger, globalErrorHandler,
    // testler için
    createRateLimiter, sanitizeText, safePath, formatRouteError,
    _setSink(fn) { const old = sink; sink = fn || ((l) => console.error(l)); return old; }
};
