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

// Dahili/özel ağ adresi mi? (SSRF engeli) Ad çözümlemesi yapılmaz; yalnızca açık adres/ad kalıpları.
function isPrivateHost(hostname = '') {
    let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    // Savunma derinliği: 127.1, 0177.0.0.1, 0x7f.1, sondaki nokta gibi biçimleri WHATWG URL ile gerçek adrese normalize et
    // (çağıran kodun normalize ettiğine güvenme); ayrıştırılamayan host güvenli sayılmaz.
    try { h = new URL('http://' + (h.includes(':') && !h.startsWith('[') ? '[' + h + ']' : h)).hostname.replace(/^\[|\]$/g, ''); } catch (_) { return true; }
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return true;
    if (!h.includes('.') && !h.includes(':')) return true; // tek etiketli iç ad (ör. postgres, n8n)
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
    if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true; // ondalık/hex IP biçimleri
    return false;
}

module.exports = { validateProfileText, SAFE_EMAIL, MAX_LEN, isPrivateHost };
