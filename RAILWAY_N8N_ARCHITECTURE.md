# Railway n8n Architecture

Bu proje icin hedef Railway topolojisi sudur:

- `affectionate-blessing`: uygulama ve raporlama backend'i
- `Postgres`: veri tabani
- `n8n`: ayri Railway servisi, ayri public domain, ayri workflow arayuzu

WhatsApp akisi bu durumda `Meta -> n8n -> app -> PostgreSQL -> n8n -> Meta` hattinda calisir.

## Dogru uretim modeli

Referans alinan uretim yapida `n8n`, uygulamanin icine gomulu degil; Railway icinde ayri servis olarak durur. Bu repo artik ayni topolojiye gore hazir durumdadir.

- uygulama deploy'u: root `Dockerfile`
- n8n runtime: Railway'de ayri servis olarak `n8nio/n8n:latest`
- workflow kaynagi: `n8n-workflows/whatsapp-sales-assistant.json`

## Servis bazli ortam degiskenleri

### App servisi

- `APP_BASE_URL`
- `DATABASE_URL`
- `JWT_SECRET`
- `WHATSAPP_QUERY_API_KEY`

### n8n servisi

- `APP_BASE_URL`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_QUERY_API_KEY`
- `N8N_BASIC_AUTH_USER`
- `N8N_BASIC_AUTH_PASSWORD`
- `N8N_ENCRYPTION_KEY`
- `N8N_EDITOR_BASE_URL`
- `WEBHOOK_URL`
- `DB_TYPE=postgresdb`
- `DB_POSTGRESDB_HOST`
- `DB_POSTGRESDB_PORT`
- `DB_POSTGRESDB_DATABASE`
- `DB_POSTGRESDB_USER`
- `DB_POSTGRESDB_PASSWORD`
- `DB_POSTGRESDB_SCHEMA=n8n`

## Kurulum akisi

1. Railway app servisini root repo ile deploy edin.
2. Ayni Railway projesine ayri bir `n8n` servisi ekleyin.
3. `n8n` servisini `n8nio/n8n:latest` image'i ile calistirin.
4. `n8n` servisine gerekli env degerlerini girin.
5. `n8n-workflows/whatsapp-sales-assistant.json` dosyasini import edin.
6. Workflow'u aktif edin.
7. Meta callback URL'ini `https://N8N-DOMAIN/webhook/whatsapp-sales-assistant` olarak ayarlayin.
8. Verify token olarak `WHATSAPP_VERIFY_TOKEN` degerini kullanin.

## Mevcut blocker

Bu projede daha once embedded `n8n` denemesi icin acilan `affectionate-blessing-volume` Railway tarafinda halen kaynak tuketiyor. Bu volume silinmeden free plan limiti nedeniyle ayri `n8n` servisi olusturulamiyor.

Beklenen temiz durum:

- `Postgres`
- `affectionate-blessing`
- `n8n`
- `postgres-volume`

## Dogrulama

- `railway status`
- `railway service status --all`
- `railway volume list --json`
- `https://N8N-DOMAIN/home/workflows`
- `https://N8N-DOMAIN/webhook/whatsapp-sales-assistant?hub.mode=subscribe&hub.verify_token=...&hub.challenge=123`

## Not

WhatsApp callback adresi uygulama domain'i degil, ayri `n8n` domain'i olmalidir.

---

## Güvenlik ve sağlık denetimi (Ekim 2026)

Kod incelemesiyle bulundu; n8n servisi canlıda çalıştırılarak doğrulanmadı. Önem sırasına göre:

1. **İşlemci webhook'u gelen isteği doğrulamıyor (yüksek).** `whatsapp-sales-processor*.json` içindeki webhook
   (`.../whatsapp-sales-assistant-process-v4`) yalnızca *dışarı* `x-query-token` gönderiyor; *gelen* istekte bu başlığı
   kontrol etmiyor. Adresi bilen biri sahte mesaj olayı gönderip işletme numarası adına WhatsApp yanıtı tetikleyebilir.
   Çözüm: workflow başına bir IF düğümü ekleyip `$json.headers['x-query-token'] === $env.WHATSAPP_QUERY_API_KEY`
   değilse 401 döndürmek (uygulama zaten bu başlığı gönderiyor, `forwardWhatsAppEventToN8n`).
2. **Meta imzası n8n tarafında doğrulanmıyor (orta).** Uygulamanın kendi webhook'unda `WHATSAPP_APP_SECRET` ile imza
   doğrulaması var, ama Meta doğrudan n8n'in `whatsapp-sales-assistant` webhook'una bağlanırsa bu koruma atlanır.
   Meta'yı uygulama webhook'una bağlayıp n8n'e uygulamanın iletmesi tercih edilmeli; ya da imza n8n'de doğrulanmalı.
3. **Editör koruması (orta).** `docker-compose.yml` ve `docker/start-railway.sh` `N8N_BASIC_AUTH_*` kullanıyor; bu ayarlar
   n8n 1.0'dan beri **etkisiz** (kaldırıldı). Editör, sahip hesabı oluşturulana kadar ya da hesap şifresine kadar açıktır.
   Canlı n8n alan adında sahip hesabının oluşturulduğundan ve güçlü şifre taşıdığından emin olun; mümkünse editörü
   Cloudflare Access/IP kısıtıyla koruyun.
4. **Sürüm sabitleme (orta).** `railway-services/n8n/Dockerfile` `n8nio/n8n:latest` kullanıyor (compose `1.70.3`'e sabit).
   Bir deploy sessizce büyük sürüme atlayabilir. Canlıda çalışan sürümü öğrenip Dockerfile'ı o sürüme sabitleyin.
5. **Env erişimi (düşük).** `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` gerekli (workflow'lar `$env` kullanıyor) ama Code
   düğümlerinden tüm sırlar okunabilir; editöre yalnızca güvenilir kişiler girmeli.
6. **Dosya dağınıklığı (düşük).** `railway-services/n8n/` içinde 4 işlemci sürümü var; `start-n8n.sh` yalnızca
   `whatsapp-sales-assistant` ve `processor-v2`'yi yüklüyor. v3/v4 kopyaları kullanılmıyorsa temizlenmeli.
   `n8n-workflows/whatsapp-sales-assistant.json` ile `railway-services/n8n/` kopyası şu an aynı; ikisini senkron tutun.
7. **Gömülü n8n yolu** (`RAILWAY_ENABLE_EMBEDDED_N8N`) varsayılan kapalı; kullanılmıyorsa kaldırılabilir.
