/**
 * Initializes the theme based on stored user preference.
 * Reads the 'oikos-theme' value from localStorage and applies the
 * corresponding 'data-theme' attribute to the document element.
 * If no valid value is found, the attribute is removed.
 */
(function() {
  var stored = localStorage.getItem('oikos-theme');
  if (stored === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (stored === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
})();
