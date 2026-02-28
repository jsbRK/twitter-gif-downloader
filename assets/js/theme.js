// ============ Theme Manager ============

document.documentElement.classList.toggle(
    'dark',
    localStorage.theme === 'dark' ||
    (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)
);

(function () {
    'use strict';

    // ============ Theme Manager ============
    const ThemeManager = {
        toggle: null,

        init() {
            this.toggle = document.getElementById('theme-toggle');

            // Sync toggle button state with current theme
            this.updateState(document.documentElement.classList.contains('dark'));

            // React to system preference changes
            window.matchMedia('(prefers-color-scheme: dark)')
                .addEventListener('change', e => {
                    if (!localStorage.theme) this.setDark(e.matches);
                });

            this.toggle?.addEventListener('click', () => this.toggleTheme());
        },

        toggleTheme() {
            const isDark = !document.documentElement.classList.contains('dark');
            localStorage.theme = isDark ? 'dark' : 'light';
            this.setDark(isDark);
        },

        setDark(isDark) {
            document.documentElement.classList.toggle('dark', isDark);
            this.updateState(isDark);
        },

        updateState(isDark) {
            this.toggle?.setAttribute('aria-checked', isDark);
        }
    };

    // ============ Mobile Nav ============
    const MobileNav = {
        init() {
            this.btn = document.getElementById('mobile-nav-btn');
            this.nav = document.getElementById('mobile-nav');
            this.openIcon = document.getElementById('nav-open-icon');
            this.closeIcon = document.getElementById('nav-close-icon');

            if (!this.btn || !this.nav) return;

            this.btn.addEventListener('click', () => this.toggle());
        },

        toggle() {
            const isOpen = !this.nav.classList.contains('hidden');

            this.nav.classList.toggle('hidden');
            this.openIcon?.classList.toggle('hidden');
            this.closeIcon?.classList.toggle('hidden');

            this.btn.setAttribute('aria-expanded', String(!isOpen));
        }
    };

    // ============ Initialize ============
    function init() {
        ThemeManager.init();
        MobileNav.init();
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();

    // Expose for external access
    window.ThemeManager = ThemeManager;

})();