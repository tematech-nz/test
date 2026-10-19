/*
 * NetMap id generator - the ONLY place ids are made.
 *
 *   NetMap.uuid.make('obj')  -> 'obj_<16 hex>'  (never returns an id this session has already seen)
 *   NetMap.uuid.seed(project) -> remember every id in a loaded project, so new ids cannot collide with it
 *   NetMap.uuid.known(id)    -> true if the id was generated or seeded
 *
 * Loaded once, first, by index.html. A second copy of this file throws instead of silently replacing the registry
 * (which would forget ids and allow collisions).
 */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (NM.uuid) throw new Error('js/uuid.js was loaded twice - there must be exactly one id generator');

  var seen = Object.create(null);

  function raw() {
    var s = '', i;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var a = new Uint8Array(8);
      crypto.getRandomValues(a);
      for (i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    } else if (typeof require === 'function') {
      s = require('crypto').randomBytes(8).toString('hex');
    } else {
      for (i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
    }
    return s;
  }

  function make(prefix) {
    var id;
    do { id = prefix + '_' + raw(); } while (seen[id]);
    seen[id] = true;
    return id;
  }

  function known(id) { return !!seen[id]; }

  /* every string under an "id" key, at any depth */
  function seed(data) {
    var n = 0;
    (function walk(v) {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i]); return; }
      for (var k in v) {
        if (k === 'id' && typeof v[k] === 'string') { if (!seen[v[k]]) n++; seen[v[k]] = true; }
        else walk(v[k]);
      }
    })(data);
    return n;
  }

  NM.uuid = Object.freeze({ make: make, seed: seed, known: known });
})(typeof window !== 'undefined' ? window : globalThis);
