'use strict';
// Süreç içi, KULLANICIDAN BAĞIMSIZ kısa ömürlü bellek önbelleği (yalnızca herkese aynı sonucu veren,
// pahalı referans/özet sorguları için). Aynı anahtar için eşzamanlı çağrılar tek hesaplamayı paylaşır
// (sürü etkisi: bir sayfa yüklemesi aynı ağır sorguyu onlarca kez tetiklemesin, bağlantı havuzu dolmasın).
// Hata önbelleğe alınmaz. staleOnError: yükleyici hata verirse (DB kilitli/havuz dolu) süresi geçmiş son
// başarılı değer sunulur (staleAfterMs: yanıt gecikirse hata beklemeden); böylece geçici DB sorunu açılış verilerini (marka/il listesi) düşürmez.
const store = new Map(); // key -> { value, exp }
const inflight = new Map(); // key -> Promise

async function memoShared(key, ttlMs, loader, { staleOnError = false, staleAfterMs = 0 } = {}) {
    const hit = store.get(key);
    const now = Date.now();
    if (ttlMs > 0 && hit && hit.exp > now) return hit.value;
    const raceStale = promise => {
        // staleAfterMs: DB yanıt vermiyorsa (kilit/havuz dolu) hata beklemeden son başarılı değeri hemen sun
        if (!(staleOnError && staleAfterMs > 0 && hit)) return promise;
        let timer;
        const stale = new Promise(resolve => { timer = setTimeout(() => resolve(hit.value), staleAfterMs); });
        return Promise.race([promise, stale]).finally(() => clearTimeout(timer));
    };
    if (inflight.has(key)) return raceStale(inflight.get(key));
    const p = (async () => {
        try {
            const value = await loader();
            if (ttlMs > 0) {
                if (store.size >= 200) store.delete(store.keys().next().value);
                store.set(key, { value, exp: Date.now() + ttlMs });
            }
            return value;
        } catch (err) {
            if (staleOnError && hit) {
                console.error(`[memo] ${key}: yükleme hatası, son başarılı değer sunuluyor:`, err && err.message);
                return hit.value;
            }
            throw err;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, p);
    return raceStale(p);
}

memoShared.clear = () => store.clear();
module.exports = { memoShared };
