# Deployment Runtime Rehberi

## Temel Gerçekler

- Lokal geliştirme adresi: `http://localhost:3002`
- Production adresi: `https://affectionate-blessing-production-f2fe.up.railway.app/`
- Lokal deploy bridge adresi: `http://127.0.0.1:3010`
- Bu projede `localhost:3000` her zaman bu uygulama olmayabilir; test ve ekran doğrulamasında referans adres `localhost:3002` kabul edilmelidir.

## Hangi Değişiklik Nereye Yansır

- `public/index.html`
- `public/app_v3.js`
- `public/api_v3.js`
- `public/style.css`

Bu dosyalar frontend tarafıdır. Lokal Docker uygulaması bu klasörü volume olarak kullandığı için değişiklikler genelde tarayıcı yenilemesiyle görünür.

- `server.js`
- `deploy-bridge.js`
- `package.json`
- `database/schema.sql`

Bu dosyalar backend veya runtime davranışını etkiler. Lokal çalışan sürece yansıması için servis veya ilgili process yeniden başlatılmalıdır.

## Lokal Runtime

### Uygulama
- Docker compose servisi: `traktor-app`
- Lokal URL: `http://localhost:3002`
- Veritabanı: Docker içindeki PostgreSQL ve lokal `5432`

### Deploy Bridge
- Hostta çalışır, Docker içinde değildir
- Başlatma komutu: `npm run deploy-bridge`
- Railway CLI'yi host ortamdan çağırır
- UI'daki deploy butonu bu bridge'e bağlıdır

## Deploy Yöntemleri

### 1. UI Butonu ile Deploy
1. `http://localhost:3002` üzerinde admin olarak giriş yap.
2. `Ayarlar` sayfasına git.
3. `Railway'e Güncelle` butonuna bas.
4. Kart içindeki durum ve log alanını izle.

Notlar:
- Bu akışın çalışması için deploy bridge ayakta olmalı.
- UI butonu sadece lokal kullanıma yöneliktir.

### 2. Manuel CLI ile Deploy
Repo kökünde şu komutu çalıştır:

```powershell
railway up --detach
```

Bu komut host makinede, proje kök dizininde çalıştırılmalıdır.

## Doğrulama Akışı

1. Değişikliği önce `http://localhost:3002` üzerinde kontrol et.
2. Gerekirse backend değişikliklerinden sonra lokal servisi yeniden başlat.
3. Deploy başlat.
4. Production URL üzerinde aynı ekranı veya ilgili endpoint'i kontrol et.
5. Production doğrulanmadan iş tamamlandı varsayımı yapma.

## Sık Tuzaklar

- `localhost:3000` adresini bu proje sanıyor olmak
- Frontend değişikliği görünmediğinde cache ihtimalini atlamak
- `server.js` değişikliğini yapıp lokal runtime'i yeniden başlatmamak
- Railway deploy'u Docker container içinden çalıştırmaya çalışmak
- UI deploy butonu çalışmadığında deploy bridge sürecini kontrol etmemek
