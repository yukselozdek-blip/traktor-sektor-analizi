module.exports = {
    intelligenceSources: [
        {
            source_code: 'tuik_general_agriculture_census_2025',
            title: 'Genel Tarim Sayimi',
            publisher: 'TUİK',
            source_type: 'census',
            geography_scope: 'turkiye',
            official_url: 'https://www.tuik.gov.tr/Kurumsal/Genel_Tarim_Sayimi',
            publication_date: '2025-01-01',
            notes: 'Tarimsal isletme, arazi, hayvancilik ve ekipman omurgasi icin kullanilir.'
        },
        {
            source_code: 'tuik_data_portal',
            title: 'TUİK Veri Portali',
            publisher: 'TUİK',
            source_type: 'statistics',
            geography_scope: 'turkiye',
            official_url: 'https://data.tuik.gov.tr/',
            publication_date: null,
            notes: 'Bitkisel uretim, fiyat endeksleri ve il bazli tarim istatistikleri icin ana kaynak.'
        },
        {
            source_code: 'tarim_orman_stratejik_plan_2024_2028',
            title: 'Tarim ve Orman Bakanligi 2024-2028 Stratejik Plani',
            publisher: 'Tarim ve Orman Bakanligi',
            source_type: 'strategy',
            geography_scope: 'turkiye',
            official_url: 'https://www.tarimorman.gov.tr/SGB/Belgeler/Stratejik%20Plan/Tar%C4%B1m%20ve%20Orman%20Bakanl%C4%B1%C4%9F%C4%B1%202024-2028%20Stratejik%20Plan%C4%B1.pdf',
            publication_date: '2024-01-01',
            notes: 'Destek, uyum, arz guvenligi ve kirsal kalkinma onceliklerini tanimlar.'
        },
        {
            source_code: 'tkdk_ipard_iii_2025_calls',
            title: 'IPARD III Programi 2025 Yili Cagri Takvimi',
            publisher: 'TKDK',
            source_type: 'support',
            geography_scope: 'turkiye',
            official_url: 'https://www.tkdk.gov.tr/Haber/ipard-iii-programi-2025-yili-cagritakvimi-yayimlandi-12778',
            publication_date: '2025-03-24',
            notes: 'Makina, modernizasyon ve kirsal yatirim taleplerini tetikleyen ana destek kaynagi.'
        },
        {
            source_code: 'tkdk_ipard_iii_open_field_irrigation',
            title: 'IPARD III Programi Sulama Destekleri Acik Alanda da Gecerli',
            publisher: 'TKDK',
            source_type: 'support',
            geography_scope: 'turkiye',
            official_url: 'https://www.tkdk.gov.tr/Haber/ipard-iii-programi-sulama-destekleri-acik-alanda-da-gecerli-12846?lang=tr',
            publication_date: '2025-04-18',
            notes: 'Sulama yayginlasmasi ve buna bagli ekipman/cekis ihtiyacini etkileyen sinyal.'
        },
        {
            source_code: 'iklim_uyum_eylem_planlari',
            title: 'Iklim Degisikligine Uyum Eylem Planlari',
            publisher: 'Iklim Degisikligi Baskanligi',
            source_type: 'climate',
            geography_scope: 'turkiye',
            official_url: 'https://iklim.gov.tr/eylem-planlari-i-19',
            publication_date: null,
            notes: 'Tarim ve su yonetimi icin ulusal uyum perspektifi sunar.'
        },
        {
            source_code: 'mgm_climate_projections',
            title: 'Turkiye Icin Iklim Degisikligi Projeksiyonlari',
            publisher: 'Meteoroloji Genel Mudurlugu',
            source_type: 'climate',
            geography_scope: 'turkiye',
            official_url: 'https://www.mgm.gov.tr/iklim/iklim-degisikligi.aspx?s=projeksiyonlar',
            publication_date: null,
            notes: 'Bolgesel sicaklik, yagis ve iklim kayma sinyalleri icin resmi projection kaynagi.'
        },
        {
            source_code: 'oecd_fao_agricultural_outlook_2025_2034',
            title: 'OECD-FAO Agricultural Outlook 2025-2034',
            publisher: 'OECD / FAO',
            source_type: 'outlook',
            geography_scope: 'global',
            official_url: 'https://www.oecd.org/en/publications/oecd-fao-agricultural-outlook-2025-2034_601276cd-en.html',
            publication_date: '2025-07-15',
            notes: 'Kuresel tarim verimliligi, ticaret ve emtia sinyalleri icin ust duzey dis kaynak.'
        },
        {
            source_code: 'fao_sofa_2022',
            title: 'The State of Food and Agriculture 2022',
            publisher: 'FAO',
            source_type: 'outlook',
            geography_scope: 'global',
            official_url: 'https://www.fao.org/newsroom/detail/FAO-state-of-food-and-agriculture--SOFA-2022-automation-agrifood-systems/en',
            publication_date: '2022-11-02',
            notes: 'Tarimda otomasyon ve mekanizasyon donusumu icin ana referans.'
        },
        {
            source_code: 'fao_sofa_2024',
            title: 'The State of Food and Agriculture 2024',
            publisher: 'FAO',
            source_type: 'outlook',
            geography_scope: 'global',
            official_url: 'https://www.fao.org/agrifood-economics/publications/detail/en/c/1722598/',
            publication_date: '2024-11-04',
            notes: 'Tarim-gida sistemlerinde deger odakli donusum ve yatirim sinyalleri icin referans.'
        }
    ],
    supportPrograms: [
        {
            program_code: 'IPARD_III_2025',
            authority_name: 'TKDK',
            program_name: 'IPARD III Programi 2025 Cagri Takvimi',
            program_type: 'hibe',
            status: 'announced',
            support_scope: 'tarimsal isletme modernizasyonu, mekanizasyon, altyapi ve yatirim destekleri',
            support_mode: 'grant',
            currency: 'EUR',
            min_grant_rate_pct: 40,
            max_grant_rate_pct: 75,
            source_code: 'tkdk_ipard_iii_2025_calls',
            official_url: 'https://www.tkdk.gov.tr/Haber/ipard-iii-programi-2025-yili-cagritakvimi-yayimlandi-12778',
            notes: 'Programin 81 ile yayilmis yapisi mekanizasyon talep motorunda kullanilacak.'
        },
        {
            program_code: 'IPARD_III_OPEN_FIELD_IRRIGATION',
            authority_name: 'TKDK',
            program_name: 'IPARD III Acik Alan Sulama Destekleri',
            program_type: 'hibe',
            status: 'announced',
            support_scope: 'acik alan sulama sistemleri, tarimsal altyapi ve su verimliligi',
            support_mode: 'grant',
            currency: 'EUR',
            min_grant_rate_pct: 40,
            max_grant_rate_pct: 75,
            source_code: 'tkdk_ipard_iii_open_field_irrigation',
            official_url: 'https://www.tkdk.gov.tr/Haber/ipard-iii-programi-sulama-destekleri-acik-alanda-da-gecerli-12846?lang=tr',
            notes: 'Sulama yatirimi ile cekis, HP ve ekipman ihtiyaci arasindaki bagin modellenmesi icin kullanilir.'
        }
    ],
    supportApplicationWindows: [
        {
            program_code: 'IPARD_III_2025',
            application_year: 2025,
            call_no: '2025',
            open_date: '2025-03-24',
            close_date: null,
            budget_amount: 785000000,
            budget_currency: 'EUR',
            status: 'announced',
            notes: '2025 cagri takvimi ve genisleyen butce sinyali.'
        }
    ],
    commodityCatalog: [
        { commodity_code: 'WHEAT', commodity_name: 'Bugday' },
        { commodity_code: 'CORN', commodity_name: 'Misir' },
        { commodity_code: 'SUNFLOWER', commodity_name: 'Aycicegi' },
        { commodity_code: 'COTTON', commodity_name: 'Pamuk' },
        { commodity_code: 'SUGAR_BEET', commodity_name: 'Seker Pancari' },
        { commodity_code: 'BARLEY', commodity_name: 'Arpa' }
    ]
};
