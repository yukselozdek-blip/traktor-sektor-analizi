'use strict';
// Analitik GET yanıtları için kısa ömürlü, KULLANICIYA ÖZEL bellek içi önbellek.
// - Anahtar: kullanıcı id + rol + marka + tam URL (abonelik/özellik kısıtları kullanıcıya bağlı olduğundan
//   başka kullanıcının yanıtı asla sunulmaz).
// - Yalnızca 200 JSON yanıtları saklanır. Aynı anahtar için eşzamanlı istekler tek hesaplamayı bekler.
// - Doğrulanamayan token'larda atlanır (401'i rotanın kendi authMiddleware'i üretir).
// - TTL: RESPONSE_CACHE_TTL_MS (varsayılan 60 sn; 0 = kapalı). Çoklu replikada her süreç kendi önbelleğini tutar.
const jwt = require('jsonwebtoken');

function createResponseCache({ jwtSecret, ttlMs = 60000, maxEntries = 500, pathPrefixes = [] }) {
    const store = new Map(); // key -> { body, exp }
    const pending = new Map(); // key -> Promise (ilk hesaplama bitince çözülür)

    function keyFor(req) {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return null;
        let p;
        try { p = jwt.verify(token, jwtSecret); } catch { return null; }
        return `${p.id}|${p.role}|${p.brand_id ?? ''}|${req.originalUrl}`;
    }

    function middleware(req, res, next) {
        if (!ttlMs || req.method !== 'GET' || !pathPrefixes.some(p => req.originalUrl.startsWith(p))) return next();
        const key = keyFor(req);
        if (!key) return next();

        const serve = hit => { res.set('X-Cache', 'HIT'); res.json(hit.body); };
        const hit = store.get(key);
        if (hit && hit.exp > Date.now()) return serve(hit);

        const compute = () => {
            let release;
            pending.set(key, new Promise(r => { release = r; }));
            const origJson = res.json.bind(res);
            res.json = body => {
                if (res.statusCode === 200) {
                    if (store.size >= maxEntries) store.delete(store.keys().next().value);
                    store.set(key, { body, exp: Date.now() + ttlMs });
                }
                res.set('X-Cache', 'MISS');
                return origJson(body);
            };
            res.on('close', () => { pending.delete(key); release(); });
            next();
        };

        const inflight = pending.get(key);
        if (!inflight) return compute();
        inflight.then(() => {
            const again = store.get(key);
            if (again && again.exp > Date.now()) return serve(again);
            compute();
        });
    }

    middleware.clear = () => store.clear();
    middleware.size = () => store.size;
    return middleware;
}

module.exports = { createResponseCache };
