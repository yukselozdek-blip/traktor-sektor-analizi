# Yedekleme Stratejisi (Backup Strategy)

## Neden ve Ne?

Traktör Sektör Analizi uygulaması bu önemli verileri içerir:
- Kullanıcı hesapları ve oturum bilgileri
- Abonelik ve ödeme kayıtları
- Satış verileri (Sales Data)
- Marka portalı içeriği
- Medya takip günlüğü
- Yapay zeka işlem günlükleri (AI logs)

Veritabanı kaybı tüm işleri durdurur. **TÜİK içe aktarma (import-tuik.js) satış tablolarını boşaltıp yeniden yükler. Riskli işlemlerden önce MUTLAKA yedek alın.**

---

## Seçenek A: Railway Yerleşik Yedekleri (Tercih Edilen)

Railway, Postgres servisine otomatik yedekleme sunabilir.

**Nasıl açılır:**
1. Railway.app'te oturum açın
2. Projenizi açın → Postgres servisi seçin
3. **Backups sekmesi**ne gidin
4. "Enable scheduled backups" seçeneğini etkinleştirin
5. Günlük veya haftalık yedekleme seçin ve kaydedin

**Manuel yedek (riskli işlem öncesi):**
- Backups sekmesinde "Create backup" düğmesine tıklayın
- Tamamlanmasını bekleyin (birkaç dakika)

**Geri yükleme:**
- Backups sekmesinde, geri yüklemek istediğiniz yedek yanında "Restore" düğmesine tıklayın
- Uyarıyı onaylayın ve bitmesini bekleyin

**Not:** Yedekleme özellikleri plan türüne göre değişebilir. Backups sekmesinin var olup olmadığını kontrol edin.

---

## Seçenek B: Bilgisayarınızdan Haftalık Yedek (Bağımsız Kopya)

**Gereklilikler:**
- Linux/Mac: `sudo apt install postgresql-client` (Ubuntu)
- Windows: PostgreSQL Client yükleyin (pgAdmin ile gelir)

**1. Veritabanı URL'si bulun:**
- Railway.app → Postgres servisi
- "Variables" sekmesine gidin
- `DATABASE_PUBLIC_URL` kopyalayın (yapıştırmayın, güvenlik için)

**2. Yedek alın:**
```bash
# Terminal/PowerShell'de:
export DATABASE_URL_BACKUP="BURAYA_DATABASE_PUBLIC_URL_DEGERINI_YAPISTIRIN"
bash scripts/backup-db.sh
```

**3. Yedek nerede?**
- `./backups/traktor-20260103-143022.dump` gibi bir dosya oluşturulur
- Boyutu ekranda gösterilir
- Son 8 yedek tutulur, eski olanlar silinir

**4. Güvenlik:**
- Yedek dosyaları Git'e commit etmeyin (şifreler içerir)
- Bilgisayarınıza indirin, Google Drive/Dropbox'a yükleyin

---

## Geri Yükleme Egzersizi (Test Önemi)

**Yerel test için:**
```bash
bash scripts/restore-db.sh backups/traktor-20260103-143022.dump "postgresql://..."
```

Script, üretim sunucularına karşı güvenlik sorgusu sorar. Onaylamak için:
```bash
I_UNDERSTAND_THIS_OVERWRITES=yes bash scripts/restore-db.sh ...
```

**Risky işlemler (import-tuik, DELETE, TRUNCATE) ÖNCESI:**
- ✓ Backups sekmesinde manuel yedek alın VE/VEYA
- ✓ `bash scripts/backup-db.sh` çalıştırın
- ✓ İşlemi gerçekleştirin
- ✓ Sonuç başarıysa eski yedekleri silebilirsiniz

---

## Yapılmaması Gerekenler

❌ DATABASE_URL/DATABASE_PUBLIC_URL'i dosyalara yazmayın  
❌ URL'i chat/message'e paste etmeyin  
❌ Yedek dosyalarını git history'ye commit etmeyin  
❌ URL sızdıysa veya herkese gösterdiyse, Railway'de yeni bir Postgres servisi oluşturun  
❌ Geri yüklemeyi üretim üzerinde test etmeyin — sandbox ortamında test edin  
