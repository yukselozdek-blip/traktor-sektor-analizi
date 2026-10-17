/* Traktör Sektör Analizi · Tanıtım sayfası etkileşimleri.
 * Yalnızca görünüm katmanı: mobil gezinme, başlık gölgesi, kaydırmada belirme.
 * İçerik JS olmadan da tam görünür; belirme sınıfları yalnızca burada eklenir. */
(function () {
    'use strict';

    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // ---- Mobil gezinme paneli ----
    var toggle = document.querySelector('[data-nav-toggle]');
    var panel = document.querySelector('[data-mobile-menu]');
    var mobileMq = window.matchMedia ? window.matchMedia('(min-width: 1001px)') : null;

    function setMenuOpen(open) {
        if (!toggle || !panel) return;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        panel.hidden = !open;
        var icon = toggle.querySelector('i');
        if (icon) icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
    }

    if (toggle && panel) {
        toggle.addEventListener('click', function () {
            setMenuOpen(toggle.getAttribute('aria-expanded') !== 'true');
        });

        panel.addEventListener('click', function (event) {
            var link = event.target.closest && event.target.closest('a[href^="#"]');
            if (link) setMenuOpen(false);
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
                setMenuOpen(false);
                toggle.focus();
            }
        });

        // Masaüstüne geçince mobil paneli kapat (gizli ama açık kalmasın).
        if (mobileMq) {
            var onWide = function (e) { if (e.matches) setMenuOpen(false); };
            if (mobileMq.addEventListener) mobileMq.addEventListener('change', onWide);
            else if (mobileMq.addListener) mobileMq.addListener(onWide);
        }
    }

    // ---- Kaydırınca başlık arka planı ----
    var header = document.querySelector('[data-header]');
    if (header) {
        var ticking = false;
        var updateHeader = function () {
            header.classList.toggle('is-scrolled', window.scrollY > 8);
            ticking = false;
        };
        window.addEventListener('scroll', function () {
            if (!ticking) {
                window.requestAnimationFrame(updateHeader);
                ticking = true;
            }
        }, { passive: true });
        updateHeader();
    }

    // ---- Kaydırmada belirme ----
    var revealItems = document.querySelectorAll('[data-reveal]');
    if (!reduceMotion && 'IntersectionObserver' in window && revealItems.length) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.remove('lp-reveal-init');
                    entry.target.classList.add('lp-reveal-in');
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });

        Array.prototype.forEach.call(revealItems, function (el) {
            el.classList.add('lp-reveal-init');
            observer.observe(el);
        });
    }
})();
