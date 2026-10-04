'use strict';
// "Üretim" tespiti: NODE_ENV=production VEYA Railway'in kendi ortam değişkenleri.
// Dockerfile NODE_ENV'i ayarlamadığı için yalnızca NODE_ENV'e güvenmek, Railway'de unutulursa
// üretimin geliştirme gibi davranmasına (sahte ödeme, ayrıntılı hata, doğrulama token'ının yanıtta dönmesi) yol açardı.
function isProduction() {
    return process.env.NODE_ENV === 'production'
        || Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
}
module.exports = { isProduction };
