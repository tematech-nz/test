/* Small original device icons (24x24 grid) drawn inside generic equipment boxes. Pure SVG markup, works offline. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  var INK = '#37474f', FILL = '#ffffff', ACC = '#90caf9';
  var SHAPES = {
    pc: '<rect x="3" y="4" width="18" height="12" rx="1.5" fill="' + ACC + '"/><path d="M12 16v4M8 20h8"/>',
    laptop: '<rect x="5" y="5" width="14" height="9" rx="1" fill="' + ACC + '"/><path d="M3 18h18l-1.8-4H4.8z" fill="' + FILL + '"/>',
    ap: '<path d="M4 19a8 8 0 0 1 16 0z" fill="' + FILL + '"/><circle cx="12" cy="15.5" r="1" fill="' + INK + '"/><path d="M8.6 10.6a5 5 0 0 1 6.8 0M5.8 7.6a9 9 0 0 1 12.4 0" fill="none"/>',
    camera: '<rect x="3" y="8" width="13" height="8.5" rx="1.5" fill="' + FILL + '"/><path d="M16 11.2l5-2.7v7l-5-2.7z" fill="' + ACC + '"/><circle cx="8.5" cy="12.2" r="2" fill="' + ACC + '"/>',
    printer: '<rect x="7" y="3.5" width="10" height="5.5" fill="' + FILL + '"/><rect x="3" y="9" width="18" height="8" rx="1.5" fill="' + ACC + '"/><rect x="7" y="14" width="10" height="6.5" fill="' + FILL + '"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2" fill="' + FILL + '"/><rect x="8.5" y="5" width="7" height="4" fill="' + ACC + '"/><path d="M9 12.5h1.5M11.3 12.5h1.5M13.6 12.5h1.5M9 15.5h1.5M11.3 15.5h1.5M13.6 15.5h1.5M9 18.5h1.5M11.3 18.5h1.5M13.6 18.5h1.5"/>',
    server: '<rect x="3" y="4" width="18" height="6.5" rx="1.2" fill="' + FILL + '"/><rect x="3" y="13.5" width="18" height="6.5" rx="1.2" fill="' + FILL + '"/><circle cx="6.8" cy="7.2" r="1" fill="' + INK + '"/><circle cx="6.8" cy="16.7" r="1" fill="' + INK + '"/><path d="M11 7.2h7M11 16.7h7"/>'
  };
  function svg(kind, x, y, size) {
    var s = SHAPES[kind];
    if (!s) return '';
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + (size / 24) + ')" stroke="' + INK + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" pointer-events="none" data-icon="' + kind + '">' + s + '</g>';
  }
  NM.icons = { svg: svg, kinds: Object.keys(SHAPES) };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.icons;
})(typeof window !== 'undefined' ? window : globalThis);
