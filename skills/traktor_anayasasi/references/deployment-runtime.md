# Deployment Runtime Rehberi (GÜNCEL)

> Bu dosya eski "lokal deploy butonu / `railway up`" akışını **emekliye ayırır**. Güncel ve tam süreç: `../../operasyon-altyapi-anayasasi/SKILL.md`.

## Temel Gerçekler

- Production: **`https://app.tarimtraktor.com`** (eski adres `https://affectionate-blessing-production-f2fe.up.railway.app/` yedek).
- Lokal geliştirme adresi: `http://localhost:3002` (Docker compose servisi `traktor-app`). `localhost:3000` başka bir uygulamaya ait olabilir; referans adres `localhost:3002`.
- Canlıya çıkış: **GitHub PR → CI yeşil → squash merge → Railway otomatik deploy.**
- `railway up`, lokal "Railway'e Güncelle" butonu ve `deploy-bridge.js` **canlıya çıkış yolu değildir**, yeni iş için kullanılmaz.

## Hangi Değişiklik Nereye Yansır

- Frontend (`public/index.html`, `app_v3.js`, `api_v3.js`, `style.css`): lokal Docker volume'ünden servis edilir, genelde tarayıcı yenilemesiyle görünür. Canlıda minify + `?v=` sürümleme uygulanır; frontend değişince `public/index.html` içindeki sürüm parametresi artırılır.
- Backend (`server.js`, `src/**`, `package.json`, `database/migrations/**`): lokal çalışan sürecin yeniden başlatılması gerekir. Canlıda `master` birleşmesiyle yeni imaj derlenir (`Dockerfile`: build aşamasında `npm ci --ignore-scripts` + `npm run build`, son aşamada `npm ci --omit=dev`, `USER node`).
- Veritabanı: **yalnızca** `database/migrations/NNN_*.sql` ile. Açılışta `initDB()` migrasyonları çalıştırır.

## Doğrulama Akışı

1. Yerelde `npm run lint:syntax` ve `npm test` (geçici Postgres + `TEST_DATABASE_URL`).
2. PR aç, CI `test` işi yeşil olsun.
3. Squash merge → Railway deploy'u bekle (Deployments sekmesinde "Active").
4. Canlıda ilgili ekranı/endpoint'i kontrol et. Doğrulanmadan "tamam" deme.

## Railway Notları

- Sağlık kontrolü: `railway.json` → `/health`, zaman aşımı 120 sn.
- Variables değişikliği "staged" olur, **Deploy** denmeden devreye girmez.
- Ortam değişkeni adları ve anlamları: operasyon anayasası §2, `.env.example`, `SECURITY_SETUP.md`.

## Sık Tuzaklar

- Frontend değişikliği görünmüyorsa önbellek/`?v=` sürümünü kontrol et.
- Squash merge sonrası eski dal "dirty" görünür: dalı `origin/master`'dan yeniden başlat.
- Production'da `NODE_ENV=production` iken mock webhook reddedilir (bilinçli).
- Railway'de SMTP portları engelli: e-posta için Brevo HTTPS API.
