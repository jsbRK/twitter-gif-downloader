// ============ Footer Year ============

(function () {
    'use strict';

    // ============ Footer Year ============
    function updateYear() {
        const el = document.getElementById('year');
        if (el) el.textContent = new Date().getFullYear();
    }

    // ============ Initialize ============
    function init() {
        updateYear();
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();

    // Expose for external access
    window.updateYear = updateYear;

})();