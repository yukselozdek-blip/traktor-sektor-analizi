'use strict';
// Mail içi bağlantılar için temel URL. Production'da yalnızca APP_BASE_URL kullanılır
// (Host başlığına güvenilmez); geliştirme/test'te istek host'undan türetilir.
const { APP_BASE_URL, IS_PRODUCTION } = require('../config');

function getBaseUrl(req) {
    if (APP_BASE_URL) return APP_BASE_URL;
    if (IS_PRODUCTION || !req) return '';
    const host = req.get && req.get('host');
    return host ? `${req.protocol}://${host}` : '';
}

module.exports = { getBaseUrl };
