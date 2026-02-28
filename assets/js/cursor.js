// ============ Custom Cursor ============

(function initCustomCursor() {
    // Cache DOM elements
    const outerCursor = document.querySelector('.cursor--outer');
    const innerCursor = document.querySelector('.cursor--inner');

    // Get sizes from CSS for accurate positioning
    const outerSize = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--outer-size'));
    const outerOffset = outerSize / 2;

    const innerSize = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--inner-size'));
    const innerOffset = innerSize / 2;

    // Update cursor position x and y coordinates
    function updatePosition(x, y) {
        outerCursor.style.left = `${x - outerOffset}px`;
        outerCursor.style.top = `${y - outerOffset}px`;
        innerCursor.style.left = `${x - innerOffset}px`;
        innerCursor.style.top = `${y - innerOffset}px`;
    }

    //Show/hide cursor elements
    function setCursorVisibility(visible) {
        const method = visible ? 'add' : 'remove';
        outerCursor.classList[method]('visible');
        innerCursor.classList[method]('visible');
    }

    // Mouse Events
    document.addEventListener('mousemove', (e) => {
        updatePosition(e.clientX, e.clientY);
        setCursorVisibility(true);
        outerCursor.style.transition = "0.1s";
    });

    document.addEventListener('mouseleave', () => {
        setCursorVisibility(false);
    });

    document.addEventListener('click', () => {
        outerCursor.classList.add('clicking');

        // Remove class after animation completes
        outerCursor.addEventListener('animationend', () => {
            outerCursor.classList.remove('clicking');
        }, { once: true });
    });

    // Touch Events (for mobile support)
    document.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        updatePosition(touch.clientX, touch.clientY);
        setCursorVisibility(true);
    });

    document.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        updatePosition(touch.clientX, touch.clientY);
    });

    document.addEventListener('touchend', () => {
        setCursorVisibility(false);
    });

    // Expose for external access
    window.CustomCursor = {
        updatePosition,
        setCursorVisibility
    };
})();