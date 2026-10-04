'use strict';
// Kullanıcı kaynaklı serbest metin alanları için girdi doğrulama (savunma derinliği: asıl koruma çıktı kaçışıdır).
const MAX_LEN = { full_name: 120, company_name: 160, company_tax_office: 120, company_tax_number: 40, job_title: 120, dealer_or_distributor: 120, phone: 20, city: 80 };
const SAFE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Hata varsa kullanıcıya gösterilecek mesajı, yoksa null döndürür.
function validateProfileText(body, fields = Object.keys(MAX_LEN)) {
    for (const f of fields) {
        const v = body?.[f];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string') return `${f} metin olmalıdır`;
        if (/[<>]/.test(v)) return 'Alanlarda "<" ve ">" karakterleri kullanılamaz';
        if (v.length > MAX_LEN[f]) return `${f} en fazla ${MAX_LEN[f]} karakter olabilir`;
    }
    return null;
}

module.exports = { validateProfileText, SAFE_EMAIL, MAX_LEN };
