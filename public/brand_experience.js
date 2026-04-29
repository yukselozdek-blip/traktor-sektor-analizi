(function (global) {
    const GENERIC_THEME = {
        name: 'Traktör Sektör Analiz Platformu',
        primary_color: '#2563eb',
        secondary_color: '#0f172a',
        accent_color: '#38bdf8',
        text_color: '#f8fafc',
        hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Tractor-agricultural-machine-cultivating-field.jpg',
        image_alt: 'Tarla içinde çalışan traktör',
        photo_source_label: 'Wikimedia Commons',
        photo_source_url: 'https://commons.wikimedia.org/wiki/File:Tractor-agricultural-machine-cultivating-field.jpg',
        motif_label: 'Yönetici içgörüsü',
        emphasis: 'Markanızı merkezde tutan, rakipleri ve sektör ortalamasını aynı katmanda okutan premium açılış deneyimi.',
        compare_copy: 'Kendi markanızı rakipler ve sektör ortalamalarıyla birlikte yönetin.',
        signature: ['Pazar ritmi', 'Rakip kıyası', 'Kurumsal vitrin'],
        symbol: 'AG',
        icon: 'fa-chart-line'
    };

    const BRAND_SLUG_ALIASES = {
        tumosan: 'tumosan',
        basak: 'basak',
        'new-holland': 'new-holland',
        newholland: 'new-holland',
        'massey-ferguson': 'massey-ferguson',
        masseyferguson: 'massey-ferguson',
        'john-deere': 'john-deere',
        johndeere: 'john-deere',
        'case-ih': 'case',
        caseih: 'case',
        case: 'case',
        'deutz-fahr': 'deutz',
        deutzfahr: 'deutz',
        deutz: 'deutz',
        erkunt: 'erkunt',
        hattat: 'hattat',
        kubota: 'kubota',
        landini: 'landini',
        same: 'same',
        solis: 'solis',
        'antonio-carraro': 'antonio-carraro',
        antoniocarraro: 'antonio-carraro',
        mccormick: 'mccormick',
        fendt: 'fendt',
        valtra: 'valtra',
        claas: 'claas',
        fiat: 'fiat',
        yanmar: 'yanmar',
        'ferrari-tractors': 'ferrari-tractors',
        ferrari: 'ferrari-tractors',
        karatas: 'karatas',
        kioti: 'kioti',
        tafe: 'tafe'
    };

    const BRAND_THEME_REGISTRY = {
        tumosan: {
            hero_image_url: 'https://www.tumosan.com.tr/uploads/2023/07/8000-serisi-1_op.jpg',
            image_alt: 'TÜMOSAN 8000 serisi traktörü',
            photo_source_label: 'TÜMOSAN 8000 Serisi',
            photo_source_url: 'https://www.tumosan.com.tr/en/products/8095',
            motif_label: 'Yerli güç omurgası',
            emphasis: 'Yerli motor, saha yaygınlığı ve tarla odağını tek yönetici girişinde birleştirir.',
            compare_copy: 'TÜMOSAN performansını sektör liderleri ve pazar ortalaması ile aynı tabloda okuyun.',
            signature: ['Yerli motor', '400+ ağ', 'Tarla / bahçe'],
            symbol: '81',
            icon: 'fa-bolt'
        },
        basak: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Ba%C5%9Fak%20Trakt%C3%B6r%20Agritechnica%202017.jpg',
            image_alt: 'Başak Traktör fuar görseli',
            photo_source_label: 'Başak Traktör Agritechnica',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Ba%C5%9Fak_Trakt%C3%B6r_Agritechnica_2017.jpg',
            motif_label: 'Anadolu üretim hattı',
            emphasis: 'Yerli üretim, fuar temposu ve servis erişimi ile kurumsal vitrine odaklanır.',
            compare_copy: 'Başak ritmini rakip markalar ve sektör trendleriyle birlikte takip edin.',
            signature: ['Yerli üretim', 'Fuar temposu', 'Servis izi'],
            symbol: 'BK',
            icon: 'fa-seedling'
        },
        'new-holland': {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:New%20Holland%207840%20tractor%20%2819330925415%29.jpg',
            image_alt: 'New Holland traktör fotoğrafı',
            photo_source_label: 'New Holland 7840',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:New_Holland_7840_tractor_(19330925415).jpg',
            motif_label: 'Mavi saha ağı',
            emphasis: 'Geniş bayi izi, yüksek hacim ve mavi marka imzası ile premium saha okumasına uygundur.',
            compare_copy: 'New Holland hacmini pazar liderliği ve sektör yoğunluğu ile birlikte analiz edin.',
            signature: ['Mavi ağ', 'Pazar liderliği', 'Saha kapsamı'],
            symbol: 'NH',
            icon: 'fa-earth-europe'
        },
        'massey-ferguson': {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Massey%20Ferguson%205460%20tractor%20%2823472773879%29.jpg',
            image_alt: 'Massey Ferguson traktör fotoğrafı',
            photo_source_label: 'Massey Ferguson 5460',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Massey_Ferguson_5460_tractor_(23472773879).jpg',
            motif_label: 'Kırmızı performans hattı',
            emphasis: 'Kırmızı marka gücü, model çeşitliliği ve saha ritmi tek yönetim katmanında buluşur.',
            compare_copy: 'Massey Ferguson markanızı rakip segmentler ve sektör paylarıyla birlikte yönetin.',
            signature: ['Kırmızı güç', 'Model derinliği', 'Segment hızı'],
            symbol: 'MF',
            icon: 'fa-chart-column'
        },
        'john-deere': {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:John%20Deere%20tractor%20%281%29.jpg',
            image_alt: 'John Deere traktör fotoğrafı',
            photo_source_label: 'John Deere tractor',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:John_Deere_tractor_(1).jpg',
            motif_label: 'Yeşil makine sinyali',
            emphasis: 'Güç, verimlilik ve saha görünürlüğünü daha cesur bir yönetici çerçevesine taşır.',
            compare_copy: 'John Deere pozisyonunu sektör ivmesi ve rakip sahası ile birlikte okuyun.',
            signature: ['Yeşil sinyal', 'Verim odağı', 'Segment baskısı'],
            symbol: 'JD',
            icon: 'fa-leaf'
        },
        case: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Case%20IH%2C%20WAW%281%29.jpg',
            image_alt: 'Case IH traktör fotoğrafı',
            photo_source_label: 'Case IH tractor',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Case_IH,_WAW(1).jpg',
            motif_label: 'Kırmızı rekabet merceği',
            emphasis: 'Rakip takibi, fiyat bandı ve saha konumlanması için net bir yönetici yüzü sunar.',
            compare_copy: 'CASE markanızı segment bazında rakipler ve sektör ortalaması ile kıyasa alın.',
            signature: ['Rakip merceği', 'Fiyat bandı', 'Segment rekabeti'],
            symbol: 'CS',
            icon: 'fa-crosshairs'
        },
        deutz: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Deutz%20100%2006%20tractor%20%2817135177425%29.jpg',
            image_alt: 'Deutz traktör fotoğrafı',
            photo_source_label: 'Deutz tractor',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Deutz_100_06_tractor_(17135177425).jpg',
            motif_label: 'Verimlilik mühendisliği',
            emphasis: 'Verimlilik, Alman mühendislik algısı ve saha dağılımını premium bir tonda sunar.',
            compare_copy: 'DEUTZ markanızı verimlilik segmentleri ve rakip fiyat bandı ile kıyasa alın.',
            signature: ['Mühendislik', 'Verimlilik', 'Saha dengesi'],
            symbol: 'DZ',
            icon: 'fa-gears'
        },
        kubota: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Kubota%20tractor%20%2850600439387%29.jpg',
            image_alt: 'Kubota traktör fotoğrafı',
            photo_source_label: 'Kubota tractor',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Kubota_tractor_(50600439387).jpg',
            motif_label: 'Kompakt turuncu hat',
            emphasis: 'Kompakt güç, bahçe sınıfları ve fiyat odağını daha net bir giriş deneyimiyle öne çıkarır.',
            compare_copy: 'Kubota markanızı bahçe odağı ve fiyat segmentleriyle birlikte konumlandırın.',
            signature: ['Kompakt güç', 'Bahçe odağı', 'Fiyat netliği'],
            symbol: 'KB',
            icon: 'fa-sun'
        },
        fendt: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Fendt%20933%20tractor.jpg',
            image_alt: 'Fendt traktör fotoğrafı',
            photo_source_label: 'Fendt 933',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Fendt_933_tractor.jpg',
            motif_label: 'Hassas premium hat',
            emphasis: 'Premium algı, fiyat seviyesi ve teknik derinliği saha verisiyle birleştirir.',
            compare_copy: 'Fendt pozisyonunu premium rakipler ve sektör paylarıyla aynı tabloda izleyin.',
            signature: ['Premium algı', 'Teknik derinlik', 'Fiyat konumu'],
            symbol: 'FD',
            icon: 'fa-gem'
        },
        valtra: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Valtra%204th%20generation%20N%20Series%20tractor.jpg',
            image_alt: 'Valtra N serisi traktör fotoğrafı',
            photo_source_label: 'Valtra N Series',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Valtra_4th_generation_N_Series_tractor.jpg',
            motif_label: 'Kuzey tork çizgisi',
            emphasis: 'Yüksek çekiş algısını, teknik ton ve bölgesel talep sinyalleriyle birlikte sunar.',
            compare_copy: 'Valtra markanızı çekiş, fiyat ve il yaygınlığı boyutlarında okuyun.',
            signature: ['Kuzey torku', 'Çekiş hızı', 'İl yaygınlığı'],
            symbol: 'VT',
            icon: 'fa-mountain'
        },
        landini: {
            hero_image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Landini%20Tractor%201706.JPG',
            image_alt: 'Landini traktör fotoğrafı',
            photo_source_label: 'Landini Tractor 1706',
            photo_source_url: 'https://commons.wikimedia.org/wiki/File:Landini_Tractor_1706.JPG',
            motif_label: 'İtalyan saha karakteri',
            emphasis: 'Tarla karakteri, ürün tarzı ve fiyat hissini daha rafine bir açılışla buluşturur.',
            compare_copy: 'Landini markanızı rakip güç bandı ve sektör yoğunluğu ile birlikte değerlendirin.',
            signature: ['Tarla karakteri', 'Model stili', 'Fiyat hissi'],
            symbol: 'LN',
            icon: 'fa-flag-checkered'
        },
        claas: {
            motif_label: 'Canlı yönetici ritmi',
            emphasis: 'Yüksek görünürlük ve mekanizasyon algısını daha modern bir yönetici diliyle sunar.',
            compare_copy: 'CLAAS varlığını sektör mekanizasyonu ve rakip güç bantlarıyla birlikte okuyun.',
            signature: ['Mekanizasyon', 'Yüksek görünürlük', 'Saha dengesi'],
            symbol: 'CL',
            icon: 'fa-satellite-dish'
        },
        same: {
            motif_label: 'Saha denge hattı',
            emphasis: 'Tarla ve bağ-bahçe karmasını tek kurumsal görünümde toplar.',
            compare_copy: 'SAME performansını kategori karması ve rakip paylarıyla birlikte izleyin.',
            signature: ['Kategori karması', 'Saha dengesi', 'Model izi'],
            symbol: 'SM',
            icon: 'fa-compass-drafting'
        },
        erkunt: {
            motif_label: 'Anadolu çekiş çizgisi',
            emphasis: 'Yerli saha sezgisi ve bölgesel gücü daha premium bir açılış katmanına taşır.',
            compare_copy: 'ERKUNT verisini il ivmesi, fiyat seviyesi ve sektör payı ile birlikte yönetin.',
            signature: ['Anadolu izi', 'Bölge hızı', 'Fiyat bandı'],
            symbol: 'EK',
            icon: 'fa-location-dot'
        },
        hattat: {
            motif_label: 'Endüstriyel saha sinyali',
            emphasis: 'Sanayi omurgası ve saha yaygınlığını daha tok bir kurumsal tonla sunar.',
            compare_copy: 'HATTAT ritmini il yoğunluğu ve rakip segmentleriyle birlikte takip edin.',
            signature: ['Sanayi gücü', 'İl yoğunluğu', 'Rakip segment'],
            symbol: 'HT',
            icon: 'fa-industry'
        },
        solis: {
            motif_label: 'Erişilebilir güç çerçevesi',
            emphasis: 'Erişilebilir güç vaadini daha net fiyat ve saha verisiyle buluşturur.',
            compare_copy: 'SOLIS markanızı fiyat algısı ve kategori karması ile birlikte okuyun.',
            signature: ['Erişilebilir güç', 'Fiyat odağı', 'Kategori karması'],
            symbol: 'SL',
            icon: 'fa-broadcast-tower'
        },
        'antonio-carraro': {
            motif_label: 'Uzman bağ çizgisi',
            emphasis: 'Niş kullanım alanlarını daha rafine ve uzman bir dilde sunar.',
            compare_copy: 'Antonio Carraro markanızı niş segmentler ve sektör ortalamalarıyla birlikte izleyin.',
            signature: ['Uzman segment', 'Bağ / bahçe', 'Niş odak'],
            symbol: 'AC',
            icon: 'fa-wine-glass'
        },
        mccormick: {
            motif_label: 'Ağır hizmet merceği',
            emphasis: 'Güç algısını ve teknik sertliği daha net bir yönetici tonuna taşır.',
            compare_copy: 'McCormick pozisyonunu yüksek HP ve fiyat bantlarıyla birlikte kıyasa alın.',
            signature: ['Yüksek HP', 'Teknik sertlik', 'Fiyat bandı'],
            symbol: 'MC',
            icon: 'fa-hammer'
        },
        fiat: {
            motif_label: 'Miras saha hikâyesi',
            emphasis: 'Tarihî mirası güncel rekabet verisiyle aynı katmanda toplar.',
            compare_copy: 'FIAT varlığını tarihsel iz, rakip payı ve sektör ritmi ile birlikte okuyun.',
            signature: ['Miras', 'Tarihsel iz', 'Rekabet ritmi'],
            symbol: 'FT',
            icon: 'fa-clock-rotate-left'
        },
        yanmar: {
            motif_label: 'Kompakt mühendislik çerçevesi',
            emphasis: 'Kompakt segmentleri ve teknik inceliği daha sade ama premium bir dille sunar.',
            compare_copy: 'YANMAR markanızı kompakt güç ve fiyat seviyeleriyle birlikte izleyin.',
            signature: ['Kompakt teknik', 'Sade premium', 'Fiyat netliği'],
            symbol: 'YN',
            icon: 'fa-microchip'
        },
        'ferrari-tractors': {
            motif_label: 'Özel bahçe imzası',
            emphasis: 'Bağ / bahçe uzmanlığını daha cesur bir kurumsal vitrinle destekler.',
            compare_copy: 'Ferrari Tractors verisini niş segmentler ve rakip bahçe markaları ile birlikte okuyun.',
            signature: ['Bağ uzmanlığı', 'Bahçe ritmi', 'Niş marka'],
            symbol: 'FR',
            icon: 'fa-apple-whole'
        },
        kioti: {
            motif_label: 'Kompakt rakip çerçevesi',
            emphasis: 'Kompakt ve orta sınıf gücü daha net rakip okumalarıyla öne çıkarır.',
            compare_copy: 'KIOTI markanızı kompakt segment ve fiyat bandı çerçevesinde izleyin.',
            signature: ['Kompakt güç', 'Rakip çerçeve', 'Saha izi'],
            symbol: 'KT',
            icon: 'fa-layer-group'
        },
        tafe: {
            motif_label: 'Değer mühendisliği hattı',
            emphasis: 'Değer odaklı konumlanmayı premium veri diliyle buluşturur.',
            compare_copy: 'TAFE markanızı fiyat / değer dengesi ve sektör payı ile birlikte okuyun.',
            signature: ['Değer odağı', 'Fiyat dengesi', 'Segment izi'],
            symbol: 'TF',
            icon: 'fa-scale-balanced'
        },
        karatas: {
            motif_label: 'Bölgesel dağıtım çerçevesi',
            emphasis: 'Bölgesel dağıtım ve saha kapsamasını daha rafine bir yönetici katmanına taşır.',
            compare_copy: 'Karataş markanızı bölgesel talep ve rakip dağılımı ile birlikte yönetin.',
            signature: ['Bölgesel dağılım', 'Saha kapsamı', 'Kurumsal vitrin'],
            symbol: 'KR',
            icon: 'fa-map'
        }
    };

    function normalizeBrandToken(value = '') {
        return String(value || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function canonicalSlug(value = '') {
        const normalized = normalizeBrandToken(value);
        return BRAND_SLUG_ALIASES[normalized] || normalized;
    }

    function buildMonogram(name = '') {
        const tokens = String(name || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2);

        if (tokens.length === 0) return 'TS';
        if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
        return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase();
    }

    function hexToRgbString(hex, fallback = '37, 99, 235') {
        const normalized = String(hex || '')
            .trim()
            .replace('#', '');

        if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
            return fallback;
        }

        const red = parseInt(normalized.slice(0, 2), 16);
        const green = parseInt(normalized.slice(2, 4), 16);
        const blue = parseInt(normalized.slice(4, 6), 16);
        return `${red}, ${green}, ${blue}`;
    }

    function getTheme(brand = {}) {
        const slug = canonicalSlug(brand.slug || brand.db_slug || brand.name || '');
        const preset = BRAND_THEME_REGISTRY[slug] || {};
        const resolvedName = brand.name || preset.name || GENERIC_THEME.name;
        const primary = brand.primary_color || preset.primary_color || GENERIC_THEME.primary_color;
        const secondary = brand.secondary_color || preset.secondary_color || GENERIC_THEME.secondary_color;
        const accent = brand.accent_color || preset.accent_color || GENERIC_THEME.accent_color;
        const textColor = brand.text_color || preset.text_color || GENERIC_THEME.text_color;

        return {
            ...GENERIC_THEME,
            ...preset,
            ...brand,
            name: resolvedName,
            slug: slug || canonicalSlug(GENERIC_THEME.name),
            primary_color: primary,
            secondary_color: secondary,
            accent_color: accent,
            text_color: textColor,
            hero_image_url: preset.hero_image_url || GENERIC_THEME.hero_image_url,
            image_alt: preset.image_alt || `${resolvedName} traktör görseli`,
            photo_source_label: preset.photo_source_label || GENERIC_THEME.photo_source_label,
            photo_source_url: preset.photo_source_url || GENERIC_THEME.photo_source_url,
            motif_label: preset.motif_label || GENERIC_THEME.motif_label,
            emphasis: preset.emphasis || GENERIC_THEME.emphasis,
            compare_copy: preset.compare_copy || GENERIC_THEME.compare_copy,
            signature: Array.isArray(preset.signature) && preset.signature.length
                ? preset.signature.slice(0, 4)
                : GENERIC_THEME.signature.slice(0, 4),
            symbol: preset.symbol || buildMonogram(resolvedName),
            monogram: buildMonogram(resolvedName),
            icon: preset.icon || GENERIC_THEME.icon,
            primary_rgb: hexToRgbString(primary),
            secondary_rgb: hexToRgbString(secondary, '15, 23, 42'),
            accent_rgb: hexToRgbString(accent, hexToRgbString(primary))
        };
    }

    function applyTheme(root, brand = {}, prefix = 'brand') {
        const theme = getTheme(brand);
        if (!root || !root.style) return theme;

        root.style.setProperty(`--${prefix}-primary`, theme.primary_color);
        root.style.setProperty(`--${prefix}-secondary`, theme.secondary_color);
        root.style.setProperty(`--${prefix}-accent`, theme.accent_color);
        root.style.setProperty(`--${prefix}-text`, theme.text_color);
        root.style.setProperty(`--${prefix}-primary-rgb`, theme.primary_rgb);
        root.style.setProperty(`--${prefix}-secondary-rgb`, theme.secondary_rgb);
        root.style.setProperty(`--${prefix}-accent-rgb`, theme.accent_rgb);
        root.style.setProperty(`--${prefix}-hero-image`, `url("${theme.hero_image_url}")`);

        return theme;
    }

    function matchBrand(brandList = [], slug = '') {
        const canonical = canonicalSlug(slug);
        return (brandList || []).find(item => canonicalSlug(item?.slug || item?.db_slug || item?.name || '') === canonical) || null;
    }

    global.BrandExperience = {
        applyTheme,
        canonicalSlug,
        getTheme,
        matchBrand
    };
})(window);
