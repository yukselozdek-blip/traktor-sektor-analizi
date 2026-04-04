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
