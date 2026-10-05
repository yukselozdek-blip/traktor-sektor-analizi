'use strict';
// Davet kodu yardımcıları. Kod düz metin saklanmaz (SHA-256), tüketim tek bir atomik UPDATE ile yapılır.
const crypto = require('crypto');

const INVITE_ERROR = 'Davet kodu geçersiz, süresi dolmuş veya kullanılmış';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 karakter, okunabilir (0/O/1/I yok)

// 'TSA-XXXX-XXXX-XXXX' (12 karakter x 5 bit = 60 bit entropi)
function generateInviteCode() {
    const bytes = crypto.randomBytes(12);
    let s = '';
    for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % 32]; // 256 % 32 == 0: sapma yok
    return `TSA-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function normalizeInviteCode(code) {
    return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashInviteCode(code) {
    return crypto.createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}

function inviteHint(code) {
    return normalizeInviteCode(code).slice(-4);
}

// Atomik tüketim: yarış durumunda iki istek aynı tek kullanımlık kodu alamaz. `db` pool veya transaction client'ı olabilir.
// Geçerliyse { id, brand_id, plan_slug } döner, değilse null.
async function consumeInviteCode(db, code) {
    const norm = normalizeInviteCode(code);
    if (norm.length < 8 || norm.length > 64) return null;
    const r = await db.query(
        `UPDATE invite_codes SET used_count = used_count + 1
          WHERE code_hash = $1 AND is_active = true AND used_count < max_uses
            AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id, brand_id, plan_slug`,
        [hashInviteCode(code)]
    );
    return r.rows[0] || null;
}

module.exports = { INVITE_ERROR, generateInviteCode, normalizeInviteCode, hashInviteCode, inviteHint, consumeInviteCode };
