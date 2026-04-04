# WhatsApp + n8n Satis Asistani

Bu kurulum ile WhatsApp'tan gelen soru `n8n -> Railway app -> PostgreSQL` hattinda cevaplanir.

Ornek sorular:

- `2024 yilinda Tumosan kac traktor satti?`
- `2023 yili Tumosan ile Basak karsilastir`

## Eklenen parcalar

- Backend sorgu endpoint'i: `POST /api/public/assistant/sales-query`
- n8n workflow dosyasi: [n8n-workflows/whatsapp-sales-assistant.json](/c:/03-PROJELERİM/03-TraktorSektorAnalizi/n8n-workflows/whatsapp-sales-assistant.json)
- Gerekli env alanlari: [.env.example](/c:/03-PROJELERİM/03-TraktorSektorAnalizi/.env.example)

## Gerekli ortam degiskenleri

Uygulama ve n8n tarafinda su alanlari tanimlanmali:

- `APP_BASE_URL`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_QUERY_API_KEY`

`WHATSAPP_QUERY_API_KEY`, n8n'in backend endpoint'ini cagirirken kullandigi ic ag guvenlik anahtaridir.

`APP_BASE_URL`, n8n'in backend sorgusunu hangi public adresten cagiracagini belirler. Railway kullaniyorsaniz deger su olmali:

- `https://affectionate-blessing-production-f2fe.up.railway.app`

## Kurulum

1. Railway servisinizde `APP_BASE_URL=https://affectionate-blessing-production-f2fe.up.railway.app` olacak sekilde env degerlerini tanimlayin.
2. Uygulamayi Railway'e deploy edin.
3. n8n hangi ortamda calisacaksa orada da ayni `APP_BASE_URL`, `WHATSAPP_*` ve `WHATSAPP_QUERY_API_KEY` degiskenlerini tanimlayin.
4. n8n arayuzune girip [n8n-workflows/whatsapp-sales-assistant.json](/c:/03-PROJELERİM/03-TraktorSektorAnalizi/n8n-workflows/whatsapp-sales-assistant.json) dosyasini import edin.
5. Workflow'u aktif edin.
6. Meta tarafinda callback URL olarak n8n webhook adresinizi verin:
   `https://N8N-ALAN-ADINIZ/webhook/whatsapp-sales-assistant`
7. Verify token alanina n8n ortamindaki `WHATSAPP_VERIFY_TOKEN` degerini yazin.

Not:
WhatsApp callback adresi dogrudan Railway site adresiniz olmaz; callback, public n8n adresine gitmelidir. Railway alan adiniz ise n8n'in veri okuyacagi backend API adresidir.

## Veri mantigi

Backend su anda iki tip soruyu deterministik olarak cevaplar:

- Tek marka + tek yil toplam satis
- Iki marka + tek yil karsilastirma

Cevaplar `sales_data` tablosundan gelir. Yani dashboard'da kullanilan veri ile ayni veri kaynagi konusur.

## Test

Backend endpoint'ini lokal olarak su sekilde test edebilirsiniz:

```bash
curl -X POST https://affectionate-blessing-production-f2fe.up.railway.app/api/public/assistant/sales-query \
  -H "Content-Type: application/json" \
  -H "x-query-token: YOUR_QUERY_TOKEN" \
  -d "{\"question\":\"2024 yilinda Tumosan kac traktor satti?\"}"
```

Beklenen cevap yapisi:

```json
{
  "ok": true,
  "intent": "brand_year_total",
  "answer": "2024 icin TUMOSAN toplam 1.234 traktör satti. ..."
}
```

## Onemli notlar

- Sohbette paylasilan WhatsApp access token'i artik gizli kabul edilmemeli. Is bitince Meta tarafindan yeni token uretmeniz iyi olur.
- Eger veri kaynagi veritabaninda degil de harici bir web sitesinde ise, bir ek n8n scraping/ETL akisi kurup bu veriyi once `sales_data` tablosuna yazmaliyiz.
