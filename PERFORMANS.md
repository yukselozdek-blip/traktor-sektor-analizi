# Performans ve kapasite

## Ayarlar (Railway ortam değişkenleri, hepsi isteğe bağlı)

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `PG_POOL_MAX` | 20 | Veritabanı bağlantı havuzu üst sınırı (Railway Postgres ~100 bağlantı) |
| `PG_STATEMENT_TIMEOUT_MS` | 120000 | Bir sorgunun en fazla çalışma süresi (0 = kapalı) |
| `PG_CONNECT_TIMEOUT_MS` / `PG_IDLE_TIMEOUT_MS` | 10000 / 30000 | Bağlantı açma / boşta bekleme süresi |
| `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS` | 600 / 60000 | IP başına genel API sınırı (eskiden 15 dk'da 300 idi; sayfa yüklemeleri onlarca çağrı yaptığı için gerçek kullanımda erken tetiklenebiliyordu) |
| `RESPONSE_CACHE_TTL_MS` | 60000 | `/api/sales/*` ve `/api/dashboard*` GET yanıtları için kullanıcıya özel önbellek (0 = kapalı) |

Önbellek yalnızca aynı kullanıcının aynı URL'ye art arda isteklerini hızlandırır ve eşzamanlı aynı istekleri tek hesaplamaya indirir; yanıtlarda `X-Cache: HIT|MISS` görünür. Veri en fazla TTL kadar eski olabilir (aylık TÜİK verisi için uygundur). Kullanıcılar arasında paylaşılmaz (abonelik kısıtları atlanmasın diye).

## Yük testi

`TEST_DATABASE_URL=postgresql://... node scripts/load-test.js [bağlantı=50] [süre_sn=10]`
Geçici veritabanı + yerel sunucu, hız sınırı kapalı, ~70 bin satırlık örnek veri. Üretime karşı çalıştırmayın.

Örnek ölçüm (yerel, 200 eşzamanlı bağlantı, önbellekli): çoğu rota 1.000-4.000 istek/sn, p99 < 600 ms.
Önbelleksiz 200 eşzamanlı bağlantıda ağır rotalar (`brand-summary`, `by-province`, `regional-index`) saniyede 0-15 isteğe düşüyordu.

## Bilinen sınırlar / sıradaki işler

- **Farklı kullanıcılar** aynı ağır sorguyu ayrı ayrı hesaplatır; kalıcı çözüm gerçek veri üzerinde `EXPLAIN ANALYZE` ile
  sorgu/indeks iyileştirmesi ya da özet (materialized view) tablolarıdır. Bunun için üretim veri hacminde ölçüm gerekir.
- Önbellek süreç içidir; birden fazla replika çalıştırılırsa her biri kendi önbelleğini tutar.
- Cloudflare önbelleği/proxy'si açıldığında statik dosyalar (`public/dist`) için ek hız kazanılır.
