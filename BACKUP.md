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

## Otomatik Gece Yedeği (önerilen): GitHub → Hetzner Storage Box

Her gece 04:17'de (Türkiye saati) GitHub, Railway veritabanının yedeğini alır, **şifreler** ve Hetzner Storage Box'a yükler. Son 14 yedek saklanır. Depo herkese açık olduğu için yedek GitHub'da **asla** tutulmaz. Çalıştıran: `.github/workflows/db-backup.yml`.

### Tek seferlik kurulum (yaklaşık 15 dakika)

**1) Yedek için yeni bir anahtar çifti üretin** (kendi bilgisayarınızda; kendi SSH anahtarınızı kullanmayın):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/hetzner_yedek -N "" -C "github-yedek"
cat ~/.ssh/hetzner_yedek.pub
```
Son komut tek satırlık `ssh-ed25519 AAAA...` metnini yazar (açık anahtar, paylaşılabilir).

**2) Açık anahtarı Storage Box'a ekleyin:** Hetzner Console → Storage Box → SSH anahtarları bölümü → yeni satır olarak yapıştırın (SSH desteğinin açık olduğundan emin olun).

**3) Sunucunun parmak izini alın** (araya sahte sunucu girmesini engeller):
```bash
ssh-keyscan -p 23 u648249.your-storagebox.de
```
Çıkan **tüm satırları** kopyalayın.

**4) Yedek parolası üretin ve parola yöneticinize kaydedin:**
```bash
openssl rand -hex 24
```
Bu parola olmadan yedekler **açılamaz**. Kaybetmeyin, sohbete yazmayın.

**5) GitHub'a secret'ları ekleyin:** Depo → **Settings → Secrets and variables → Actions → New repository secret**. Aşağıdaki 6 secret'ı tek tek ekleyin:

| Ad | Değer |
|---|---|
| `BACKUP_DATABASE_URL` | Railway → Postgres → Variables → `DATABASE_PUBLIC_URL` |
| `BACKUP_PASSPHRASE` | 4. adımdaki parola |
| `STORAGEBOX_HOST` | `u648249.your-storagebox.de` |
| `STORAGEBOX_USER` | `u648249` |
| `STORAGEBOX_SSH_KEY` | `cat ~/.ssh/hetzner_yedek` çıktısının **tamamı** (`-----BEGIN` ile `-----END` satırları dahil) |
| `STORAGEBOX_KNOWN_HOSTS` | 3. adımdaki satırlar |

**6) Deneyin:** Depo → **Actions → "Veritabanı Yedeği (Hetzner)" → Run workflow**. Yeşil tik çıkmalı, Storage Box'ta `backups/` klasöründe `traktor-....dump.gpg` dosyası görünmeli.

### Geri yükleme
```bash
gpg -d traktor-YYYYMMDD-HHMM.dump.gpg > geri.dump        # parolayı sorar
bash scripts/restore-db.sh geri.dump "HEDEF_VERITABANI_ADRESI"
```
Önce kendi bilgisayarınızdaki boş bir test veritabanına geri yüklemeyi deneyin.

### Dikkat
- Postgres parolasını yenilerseniz `BACKUP_DATABASE_URL` secret'ını da güncelleyin, yoksa yedek başarısız olur (GitHub size e-posta gönderir).
- GitHub, 60 gün hiç hareket olmayan herkese açık depolarda zamanlanmış işleri durdurur. Ayda bir Actions sayfasına bakın.
- `pg_dump` sürümü Railway'in Postgres sürümüyle (şu an 18) uyumlu olmalıdır. Railway Postgres'i yükseltirse iş akışındaki `18` değerini güncelleyin.

---

## Seçenek A: Railway Yerleşik Yedekleri (yalnızca Pro plan)

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
