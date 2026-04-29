// ============================================
// REPORT REGISTRY
// Single source of truth for page purpose,
// ownership, and anti-duplication rules.
// ============================================

(function attachReportRegistry(global) {
    const aliases = Object.freeze({
        distributor: 'brand-summary',
        benchmark: 'brand-compare',
        'hp-top': 'hp-segment',
        'hp-top-il': 'hp-segment',
        'hp-top-model': 'hp-segment',
        'hp-top-il-cat': 'hp-segment',
        'obt-hp': 'hp-segment',
        'brand-hp': 'hp-segment',
        'hp-brand-matrix': 'hp-segment',
        tarmakbir2: 'tarmakbir'
    });

    const pages = Object.freeze({
        'brand-hub': {
            title: 'Marka Merkezi',
            subtitle: 'Markaya özel komuta merkezi',
            group: 'Kurumsal',
            purpose: 'Seçili markanın yönetim kurulu seviyesindeki ana karar ekranı.',
            decision_job: 'Markanın mevcut konumunu, saha önceliklerini ve rakip baskısını tek ekranda okumak.',
            owner: 'Marka yönetimi',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        dashboard: {
            title: 'Dashboard',
            subtitle: 'Genel bakış',
            group: 'Kurumsal',
            purpose: 'Tüm platformun hızlı özet katmanı.',
            decision_job: 'Kullanıcıya sistemin o anki genel nabzını vermek.',
            owner: 'Platform özeti',
            status: 'refactor',
            year_filter: false,
            model_year_note: true
        },
        'model-images-admin': {
            title: 'Model Görsel Yönetimi',
            subtitle: 'Marka ve model fotoğraflarının doğrulama merkezi',
            group: 'Yönetim',
            purpose: 'Aday görselleri toplamak, doğrulamak ve yayınlanabilir setini onaylamak.',
            decision_job: 'Hangi modelin fotoğrafı eksik, hangi aday yayına hazır, kapsama yüzdesi ne durumda?',
            owner: 'Admin / Görsel Yönetimi',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        map: {
            title: 'Türkiye Haritası',
            subtitle: 'İl bazlı satış dağılımı ve saha ritmi',
            group: 'Pazar ve Dağılım',
            purpose: 'Talebi il bazında görmek, sıcak noktaları bulmak ve saha yayılımını izlemek.',
            decision_job: 'Hangi ilde güçlüyüz, nerede zayıfız, nerede büyümeliyiz?',
            owner: 'Coğrafi talep',
            status: 'keep',
            year_filter: false,
            model_year_note: true
        },
        'map-full': {
            title: 'Türkiye Haritası',
            subtitle: 'Eski tam ekran harita çalışma alanı',
            group: 'Pazar ve Dağılım',
            purpose: 'Önceki harita denemeleri için geçiş katmanı.',
            decision_job: 'Harita deneyimini teknik olarak desteklemek.',
            owner: 'Coğrafi talep',
            status: 'legacy',
            year_filter: true,
            model_year_note: true
        },
        historical: {
            title: 'Tarihsel Gelişim',
            subtitle: 'Traktör pazarı trend motoru',
            group: 'Pazar ve Dağılım',
            purpose: 'Yıllara yayılan ritmi, dönüm noktalarını ve kırılma anlarını göstermek.',
            decision_job: 'Pazar hangi ritimle evriliyor?',
            owner: 'Trend katmanı',
            status: 'refactor',
            year_filter: false,
            model_year_note: true
        },
        'total-market': {
            title: 'Toplam Pazar',
            subtitle: 'Yıllık ve aylık pazar yapısı',
            group: 'Pazar ve Dağılım',
            purpose: 'Pazarın toplamını, büyüklüğünü ve tempo yapısını göstermek.',
            decision_job: 'Pazar ne kadar büyük, hangi ritimde, hangi dönemde hareket ediyor?',
            owner: 'Pazar büyüklüğü',
            status: 'refactor',
            year_filter: false,
            model_year_note: true
        },
        'brand-summary': {
            title: 'Marka & Distribütör',
            subtitle: 'Marka, kanal ve distribütör ekosistemi',
            group: 'Kurumsal',
            purpose: 'Marka yapısını, distribütör etkisini ve kanal omurgasını göstermek.',
            decision_job: 'Kurumsal organizasyon ve ekosistem nasıl konumlanmış?',
            owner: 'Ekosistem',
            status: 'refactor',
            year_filter: false,
            model_year_note: true
        },
        'hp-segment': {
            title: 'HP Segment Merkezi',
            subtitle: 'HP, marka, model ve il zekâsını tek ekranda birleştirir',
            group: 'Stratejik Analiz',
            purpose: 'Tüm HP tabanlı raporları tek bir ürün mimarisi merkezinde toplamak.',
            decision_job: 'Hangi teknik özellik mimarisi pazarı sürüklüyor?',
            owner: 'Ürün mimarisi',
            status: 'merge',
            year_filter: false,
            model_year_note: false
        },
        'prov-top-brand': {
            title: 'İl Liderlik Merkezi',
            subtitle: 'İl > marka > model derinliğini tekrarsız bir karar ekranında toplar',
            group: 'Pazar ve Dağılım',
            purpose: 'Bir ilin lider markalarını ve o markaların gerçek model omurgasını göstermek.',
            decision_job: 'Bir ilde kim lider, hangi model omurgası ile lider?',
            owner: 'İl bazlı rekabet',
            status: 'keep',
            year_filter: true,
            model_year_note: true
        },
        'brand-compare': {
            title: 'Marka Karşılaştırma Merkezi',
            subtitle: 'İki markanın pazar, saha, portföy ve fiyat derinliğini tek panelde birleştirir',
            group: 'Stratejik Analiz',
            purpose: 'İki markayı sahada ve portföyde karşılaştırmak.',
            decision_job: 'Rakibe karşı nerede üstünsünüz, nerede açık veriyorsunuz?',
            owner: 'Rekabet',
            status: 'merge',
            year_filter: false,
            model_year_note: true
        },
        'regional-index': {
            title: 'Bölgesel Mekanizasyon Komuta Merkezi',
            subtitle: 'Türkiye haritasından seçilen il için mekanizasyon, iklim ve makine strateji dosyası üretir',
            group: 'Saha ve Öngörüler',
            purpose: 'Harita üzerinden seçilen her il için mekanizasyon seviyesi, ürün deseni, iklim baskısı ve tercih edilen makine mimarisini tek dosyada göstermek.',
            decision_job: 'Bu ilde hangi traktör ve ekipman mimarisiyle, hangi saha hamlesi yapılmalı?',
            owner: 'Bölgesel yapısal analiz',
            status: 'keep',
            year_filter: true,
            model_year_note: true
        },
        'model-region': {
            title: 'Model-Bölge Analizi',
            subtitle: 'Model habitatı, beyaz alan ve saha yönlendirme merkezi',
            group: 'Stratejik Analiz',
            purpose: 'Belirli modellerin hangi bölgelerde doğal habitat kurduğunu, nerede beyaz alan ürettiğini ve portföy/rakip yönlendirmesini göstermek.',
            decision_job: 'Bu model hangi bölgede savunulmalı, hangi ilde büyütülmeli, hangi kardeş veya rakip modelle ayrışmalı?',
            owner: 'Model yayılımı',
            status: 'keep',
            year_filter: false,
            model_year_note: true
        },
        sales: {
            title: 'Satış Analizi',
            subtitle: 'Detaylı satış verileri',
            group: 'Pazar ve Dağılım',
            purpose: 'Ham satış davranışını detay seviyesinde açmak.',
            decision_job: 'Satış davranışının derin detayı ne söylüyor?',
            owner: 'Satış derinliği',
            status: 'refactor',
            year_filter: true,
            model_year_note: true
        },
        competitors: {
            title: 'Rakip Analizi',
            subtitle: 'Çok boyutlu karşılaştırma',
            group: 'Stratejik Analiz',
            purpose: 'Rakip baskısını ayrık bir savaş odası formatında okumak.',
            decision_job: 'Rakiplerin hamlesi bize ne yaptırıyor?',
            owner: 'Rakip stratejisi',
            status: 'refactor',
            year_filter: true,
            model_year_note: true
        },
        models: {
            title: 'Model Karşılaştırma',
            subtitle: 'Teknik özellik analizi',
            group: 'Stratejik Analiz',
            purpose: 'Model seviyesinde teknik farkları ve fiyat mimarisini göstermek.',
            decision_job: 'Hangi model, hangi ihtiyaca daha doğru oturuyor?',
            owner: 'Teknik kıyas',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        province: {
            title: 'İl Agro Intelligence',
            subtitle: 'Toprak, iklim, ürün, ekipman ve tercih edilen traktörü tek katmanda okur',
            group: 'Saha ve Öngörüler',
            purpose: 'Bir ilin tarımsal faaliyet mantığını ve makine ihtiyacını göstermek.',
            decision_job: 'Bu ilde hangi tarımsal profil hangi tip traktöre ihtiyaç doğuruyor?',
            owner: 'İl bazlı agro zekâ',
            status: 'keep',
            year_filter: true,
            model_year_note: false
        },
        weather: {
            title: 'İklim Komuta Merkezi',
            subtitle: 'Saha ritmi, ürün deseni ve iklim baskısını tek ekranda yönetir',
            group: 'Saha ve Öngörüler',
            purpose: 'Kısa vade hava penceresi ile orta vade iklim sinyalini birleştirmek.',
            decision_job: 'Saha operasyonu bu dönemde nasıl planlanmalı?',
            owner: 'İklim zekâsı',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        'media-watch': {
            title: 'Medya Takip',
            subtitle: 'Marka gündemi, şikayet, lansman ve resmi karar istihbaratı',
            group: 'Saha ve Öngörüler',
            purpose: 'Seçili marka için haber, sosyal medya, forum, şikayet ve resmi karar akışını tek merkezde toplamak.',
            decision_job: 'Marka bugün nerede konuşuluyor, hangi risk ve fırsat başlıkları doğuyor?',
            owner: 'Medya istihbaratı',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        'ai-insights': {
            title: 'AI Öngörüler',
            subtitle: 'Yönetici savaş odası, rakip baskısı ve gelecek sinyalleri',
            group: 'Saha ve Öngörüler',
            purpose: 'Bugün, yarın ve sonraki yıllara ait stratejik özet çıkarmak.',
            decision_job: 'Ne olacak ve buna şimdiden ne yapmalıyız?',
            owner: 'Tahmin ve strateji',
            status: 'refactor',
            year_filter: false,
            model_year_note: false
        },
        subscription: {
            title: 'Abonelik',
            subtitle: 'Plan ve ödeme yönetimi',
            group: 'Platform',
            purpose: 'Plan, yetki ve ticari kullanımı yönetmek.',
            decision_job: 'Hangi pakette hangi yetki seti var?',
            owner: 'Platform',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        },
        tarmakbir: {
            title: 'TarmakBir Komuta Merkezi',
            subtitle: 'N+N1 ritmi ile bütün madde baskısını tek aksiyon ekranında birleştirir',
            group: 'Saha ve Öngörüler',
            purpose: 'Model yılı ritmi ile tüm madde baskısını aksiyoner şekilde okumak.',
            decision_job: 'Hangi marka hangi ritimde stok ve momentum baskısı taşıyor?',
            owner: 'TarmakBir',
            status: 'keep',
            year_filter: true,
            model_year_note: false
        },
        settings: {
            title: 'Ayarlar',
            subtitle: 'Hesap ayarları',
            group: 'Platform',
            purpose: 'Kullanıcı ve sistem ayarlarını yönetmek.',
            decision_job: 'Hesap ve platform davranışları nasıl yönetilecek?',
            owner: 'Platform',
            status: 'keep',
            year_filter: false,
            model_year_note: false
        }
    });

    function normalize(page) {
        return aliases[page] || page || 'dashboard';
    }

    function getMeta(page) {
        return pages[normalize(page)] || pages.dashboard;
    }

    function isCanonical(page) {
        return normalize(page) === page;
    }

    global.ReportRegistry = Object.freeze({
        aliases,
        pages,
        normalize,
        getMeta,
        isCanonical
    });
})(window);
