// Erişilebilirlik katmanı: dinamik olarak üretilen arayüzde eksik erişilebilir adları tamamlar,
// tıklanabilir ama klavyeyle odaklanamayan öğeleri klavyeyle çalışır hâle getirir.
// Mevcut işlevleri değiştirmez (yalnızca aria-*/tabindex/role ekler ve Enter/Space ile click tetikler).
(function () {
    'use strict';

    var ICON_LABELS = {
        'fa-sign-out-alt': 'Çıkış yap', 'fa-right-from-bracket': 'Çıkış yap', 'fa-bars': 'Menüyü aç/kapat', 'fa-bell': 'Bildirimler',
        'fa-sync-alt': 'Yenile', 'fa-rotate': 'Yenile', 'fa-times': 'Kapat', 'fa-xmark': 'Kapat', 'fa-search': 'Ara',
        'fa-magnifying-glass': 'Ara', 'fa-trash': 'Sil', 'fa-trash-alt': 'Sil', 'fa-edit': 'Düzenle', 'fa-pen': 'Düzenle',
        'fa-download': 'İndir', 'fa-eye': 'Göster', 'fa-eye-slash': 'Gizle', 'fa-plus': 'Ekle', 'fa-filter': 'Filtrele',
        'fa-print': 'Yazdır', 'fa-chevron-down': 'Aç', 'fa-chevron-up': 'Kapat', 'fa-chevron-left': 'Geri', 'fa-chevron-right': 'İleri',
        'fa-arrow-left': 'Geri', 'fa-arrow-right': 'İleri', 'fa-share-nodes': 'Paylaş', 'fa-copy': 'Kopyala', 'fa-expand': 'Tam ekran',
        'fa-circle-info': 'Bilgi', 'fa-info-circle': 'Bilgi', 'fa-gear': 'Ayarlar', 'fa-cog': 'Ayarlar', 'fa-user': 'Kullanıcı'
    };
    var SELECT_HINTS = [
        [/year|yil/i, 'Yıl'], [/cabin|kabin/i, 'Kabin tipi'], [/drive|cekis/i, 'Çekiş'], [/gear|sanziman/i, 'Şanzıman'],
        [/hp|guc/i, 'Motor gücü (HP)'], [/brand|marka/i, 'Marka'], [/province|\bil\b|city|sehir/i, 'İl'], [/region|bolge/i, 'Bölge'],
        [/month|ay\b/i, 'Ay'], [/model/i, 'Model'], [/categ|segment|kategori/i, 'Segment'], [/dimension|boyut/i, 'Boyut'],
        [/sort|sira/i, 'Sıralama'], [/period|donem/i, 'Dönem'], [/metric|metrik/i, 'Metrik'], [/plan/i, 'Plan'], [/language|dil/i, 'Dil']
    ];

    function text(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }

    function hasName(el) {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
        if (el.getAttribute('title')) return true;
        if (el.labels && el.labels.length) {
            for (var li = 0; li < el.labels.length; li++) {
                var c = el.labels[li].cloneNode(true);
                var inner = c.querySelectorAll('select,input,textarea,option');
                for (var ci = 0; ci < inner.length; ci++) inner[ci].remove();
                if (text(c)) return true;
            }
        }
        if (el.tagName === 'BUTTON' || el.tagName === 'A') {
            if (text(el)) return true;
            var img = el.querySelector('img[alt]:not([alt=""])');
            if (img) return true;
        }
        return false;
    }

    function iconLabel(el) {
        var icons = el.querySelectorAll('i[class*="fa-"]');
        for (var i = 0; i < icons.length; i++) {
            var cls = icons[i].className.split(/\s+/);
            for (var j = 0; j < cls.length; j++) if (ICON_LABELS[cls[j]]) return ICON_LABELS[cls[j]];
        }
        return '';
    }

    function labelSelect(el) {
        var key = (el.id || '') + ' ' + (el.name || '');
        for (var i = 0; i < SELECT_HINTS.length; i++) if (SELECT_HINTS[i][0].test(key)) return SELECT_HINTS[i][1] + ' seçimi';
        var first = el.options && el.options[0] ? text(el.options[0]) : '';
        return first ? 'Filtre: ' + first : 'Seçim';
    }

    function fixControl(el) {
        if (el.dataset.a11yDone === '1') return;
        var tag = el.tagName;
        if ((tag === 'BUTTON' || (tag === 'A' && el.hasAttribute('onclick'))) && !hasName(el)) {
            var l = iconLabel(el);
            if (l) el.setAttribute('aria-label', l);
        } else if (tag === 'SELECT' && !hasName(el)) {
            el.setAttribute('aria-label', labelSelect(el));
        }
        // Hemen önündeki ilişkilendirilmemiş <label>'i bu alanla eşleştir (for/id)
        if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && el.type !== 'hidden' && !hasName(el)) {
            var prev = el.previousElementSibling;
            if (prev && prev.tagName === 'LABEL' && !prev.htmlFor && !prev.querySelector('input,select,textarea') && text(prev)) {
                if (!el.id) el.id = 'a11y-f-' + Math.random().toString(36).slice(2, 9);
                prev.htmlFor = el.id;
            }
        }
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && !hasName(el)) {
            var n = el.getAttribute('placeholder') || (el.name || '').replace(/[_-]+/g, ' ');
            if (n) el.setAttribute('aria-label', n);
        }
        // Tıklanabilir ama doğal olarak odaklanamayan öğeler: klavye ile erişilebilir yap
        if (el.hasAttribute('onclick') && !/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|OPTION)$/.test(tag) && !(tag === 'A' && el.hasAttribute('href'))) {
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
            if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
        }
        el.dataset.a11yDone = '1';
    }

    function fixScrollable(el) {
        if (el.hasAttribute('tabindex') || el.dataset.a11yScroll === '1') return;
        var cs = getComputedStyle(el);
        var scrolls = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX);
        if (scrolls && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
            if (!el.querySelector('a[href],button,input,select,textarea,[tabindex="0"]')) el.setAttribute('tabindex', '0');
            el.dataset.a11yScroll = '1';
        }
    }

    // Başlık sırası: atlanan seviyeleri aria-level ile düzelt (yalnızca erişilebilirlik ağacı; görünüm değişmez)
    function fixHeadings() {
        var main = document.getElementById('mainContent');
        if (!main) return;
        var hs = main.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
        var last = 1;
        for (var i = 0; i < hs.length; i++) {
            var h = hs[i];
            if (h.getAttribute('aria-hidden') === 'true' || h.id === 'pageTitleSr' || !(h.offsetWidth || h.offsetHeight || h.getClientRects().length)) continue;
            var nat = /^H[1-6]$/.test(h.tagName) ? +h.tagName.charAt(1) : (+h.getAttribute('aria-level') || 2);
            var lvl = Math.min(nat, last + 1);
            if (h.dataset.a11yLvl !== '1' && lvl !== nat) { h.setAttribute('aria-level', String(lvl)); h.dataset.a11yLvl = '1'; }
            last = h.dataset.a11yLvl === '1' ? +h.getAttribute('aria-level') : nat;
        }
    }

    function scan(root) {
        var scope = root && root.querySelectorAll ? root : document;
        var controls = scope.querySelectorAll('button, select, input, textarea, [onclick]');
        for (var i = 0; i < controls.length; i++) fixControl(controls[i]);
        if (root.nodeType === 1) fixControl(root);
        var cands = scope.querySelectorAll('.sidebar-menu, .notif-list, [class*="scroll"], [class*="table"], [class*="wrap"], [style*="overflow"]');
        for (var k = 0; k < cands.length && k < 400; k++) fixScrollable(cands[k]);
    }

    // Enter / Space ile tıklama (role=button öğeleri için)
    document.addEventListener('keydown', function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('role') === 'button' && el.hasAttribute('onclick') && !/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName)) {
            e.preventDefault();
            el.click();
        } else if (e.key === 'Enter' && el.tagName === 'A' && !el.hasAttribute('href') && el.hasAttribute('onclick')) {
            e.preventDefault();
            el.click();
        }
    });

    var queued = false;
    var pending = new Set();
    function flush() {
        queued = false;
        var nodes = Array.from(pending); pending.clear();
        for (var i = 0; i < nodes.length; i++) if (document.contains(nodes[i])) scan(nodes[i]);
        fixHeadings();
    }
    function schedule() {
        if (queued) return;
        queued = true;
        (window.requestIdleCallback || function (f) { return setTimeout(f, 120); })(flush, { timeout: 500 });
    }

    function start() {
        scan(document.body);
        fixHeadings();
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var added = muts[i].addedNodes;
                for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) pending.add(added[j]);
            }
            if (pending.size) schedule();
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
