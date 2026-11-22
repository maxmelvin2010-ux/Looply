/*
 * Looply — lightweight, no-login, browser-based multi-stop road route planning.
 * Map: OpenFreeMap + MapLibre GL JS. Search: Photon. Road time: OSRM.
 * Public routing/geocoding instances are suitable for light use and evaluation;
 * serious/high-volume deployments should use their own or contracted services.
 */
(() => {
  'use strict';

  const MAX_STOPS = 20;
  const STORAGE_KEY = 'looply.planner.v1';
  const MAP_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
  const MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
  const GEOCODER = 'https://photon.komoot.io/api/';
  const OSRM = 'https://router.project-osrm.org';
  const DEFAULT_CENTER = [-122.335, 37.542];
  const SEARCH_COUNTRY = 'US'; // US-only launch: never show foreign matches

  const PIN_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M19 10c0 5.2-7 11-7 11S5 15.2 5 10a7 7 0 1 1 14 0Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="1.6"/></svg>';
  const CROSS_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6 18 18M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const GRIP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.8"/><circle cx="16" cy="5" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="16" cy="12" r="1.8"/><circle cx="9" cy="19" r="1.8"/><circle cx="16" cy="19" r="1.8"/></svg>';

  const $ = (id) => document.getElementById(id);
  let idCounter = 1;
  const makeStop = (text = '', coordinates = null) => ({ id: 'stop-' + idCounter++, text, coordinates });
  const state = {
    start: { text: '', coordinates: null },
    stops: [makeStop(), makeStop()],
    route: null,
    mapStyle: 'light',
    busy: false,
    locateUsed: false
  };
  let map = null;
  let mapLoaded = false;
  let markers = [];
  let geoDebounce = null;
  let geoAbort = null;
  let suggestionsOwner = null;
  let toastTimeout = null;
  let routeAbort = null;
  let draggedStopId = null;
  let navigationSteps = []; let navigationIndex = 0; let gpsWatch = null; let navigationVoice = true; let lastSpokenIndex = -1; let lastGPS = null;
  let selectedMarker = null;
  let reverseAbort = null;
  let lastPhotonRequest = 0;
  let lastRoutingRequest = 0;
  let photonQueue = Promise.resolve();
  let routingQueue = Promise.resolve();

  function safeText(value) { return String(value == null ? '' : value).trim(); }
  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.style.background = isError ? '#8a394b' : '#24334d';
    el.hidden = false;
    clearTimeout(toastTimeout);
    requestAnimationFrame(() => el.classList.add('show'));
    toastTimeout = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 220); }, 3600);
  }
  function validPoint(p) { return Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90; }
  function saveState() {
    try {
      // The current-location coordinate is deliberately not persisted to localStorage.
      const start = { text: state.locateUsed ? '' : state.start.text, coordinates: state.locateUsed ? null : state.start.coordinates };
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ start, stops: state.stops.map(s => ({ text: s.text, coordinates: s.coordinates })) }));
    } catch { /* Storage may be disabled in private browsing. Route planning still works. */ }
  }
  function readState() {
    try {
      const params = new URLSearchParams(window.location.search);
      const shared = params.get('r');
      if (shared) {
        const binary = atob(shared.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const decoded = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof decoded.start === 'string' && Array.isArray(decoded.stops) && decoded.stops.length <= MAX_STOPS) {
          state.start = { text: decoded.start.slice(0, 250), coordinates: null };
          state.stops = decoded.stops.filter(s => typeof s === 'string').map(s => makeStop(s.slice(0, 250)));
          if (state.stops.length < 2) while (state.stops.length < 2) state.stops.push(makeStop());
          saveState();
          return;
        }
      }
    } catch { /* Invalid link: use locally saved stops instead. */ }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      if (saved.start && typeof saved.start.text === 'string') state.start = { text: saved.start.text.slice(0, 250), coordinates: validPoint(saved.start.coordinates) ? saved.start.coordinates : null };
      if (Array.isArray(saved.stops)) {
        state.stops = saved.stops.slice(0, MAX_STOPS).filter(s => s && typeof s.text === 'string').map(s => makeStop(s.text.slice(0, 250), validPoint(s.coordinates) ? s.coordinates : null));
        while (state.stops.length < 2) state.stops.push(makeStop());
      }
    } catch { /* Bad local data: ignore. */ }
  }

  function resetRoute() {
    if (state.busy && routeAbort) routeAbort.abort();
    stopNavigation();
    if (state.route) {
      state.route = null;
      $('results').hidden = true;
      $('mapOverlayHeading').hidden = false;
      $('mapOverlayBottom').hidden = false;
      if (mapLoaded && map.getSource('loop-route')) map.getSource('loop-route').setData(emptyLine());
    }
    renderMarkers();
    $('optimizeHint').textContent = 'Ready when you are';
    $('optimizeBtnText').textContent = 'Find my best route';
  }
  function stopCount() { return state.stops.filter(s => safeText(s.text)).length; }
  function refreshStopCount() {
    const count = stopCount();
    $('stopCount').textContent = count + ' added';
    $('totalStops').textContent = count;
    $('addStopBtn').disabled = state.stops.length >= MAX_STOPS;
  }
  function getStop(id) { return state.stops.find(s => s.id === id); }
  function updateStart(text, coords = null) {
    state.start = { text, coordinates: coords };
    state.locateUsed = false;
    resetRoute();
    saveState();
  }
  function updateStop(id, text, coords = null) {
    const stop = getStop(id);
    if (!stop) return;
    stop.text = text;
    stop.coordinates = coords;
    resetRoute();
    saveState();
    refreshStopCount();
  }

  function isUSFeature(feature) {
    const p = feature?.properties || {};
    const code = String(p.countrycode || p.countryCode || '').toUpperCase();
    const name = String(p.country || '').trim().toLowerCase();
    // An absent country is unverified, not permission to place a pin.
    return code === SEARCH_COUNTRY || ['united states', 'united states of america', 'usa', 'us'].includes(name);
  }
  function enteredHouseNumber(query) { return /^\s*(\d+[a-z]?)\b/i.exec(query)?.[1]?.toLowerCase() || ''; }
  function matchingFeatures(data, query) {
    const number = enteredHouseNumber(query);
    return (data.features || []).filter(f => f.geometry?.type === 'Point' && validPoint(f.geometry.coordinates) && isUSFeature(f))
      .filter(f => !number || String(f.properties?.housenumber || '').toLowerCase() === number);
  }
  function featureLabel(feature) {
    const p = feature.properties || {};
    const base = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.name || p.street), p.city || p.town || p.village || p.county, p.state, p.country].filter(Boolean);
    return [...new Set(base)].join(', ');
  }
  function featureHeading(feature) {
    const p = feature.properties || {};
    return p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.town || p.county || 'Address';
  }
  async function fetchJSON(url, signal, timeout = 18000) {
    const controller = new AbortController();
    const handler = () => controller.abort();
    signal?.addEventListener('abort', handler, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`The map service returned ${response.status}. Please try again.`);
      return await response.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', handler); }
  }
  // Public demo endpoints ask clients to avoid bursts. Requests are serialized and paced.
  async function pacedFetch(url, signal, timeout, service) {
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    const previous = service === 'photon' ? photonQueue : routingQueue;
    if (service === 'photon') photonQueue = turn;
    else routingQueue = turn;
    await previous;
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const last = service === 'photon' ? lastPhotonRequest : lastRoutingRequest;
      const delay = Math.max(0, 1050 - (Date.now() - last));
      if (delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, delay);
        function cancel() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); }
        signal?.addEventListener('abort', cancel, { once: true });
      });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (service === 'photon') lastPhotonRequest = Date.now();
      else lastRoutingRequest = Date.now();
      return await fetchJSON(url, signal, timeout);
    } finally { release(); }
  }
  const fetchGeocoder = async (url, signal, timeout = 16000) => {
    // Prefer server-side TomTom search, but keep this older static app usable without an API key.
    if (url.includes('/api/') || url.startsWith(GEOCODER)) {
      const original = new URL(url);
      const api = new URL('/api/search', location.origin);
      for (const name of ['q','limit','lat','lon','countrycode']) if (original.searchParams.has(name)) api.searchParams.set(name, original.searchParams.get(name));
      try {
        const response = await fetch(api, {signal});
        if (response.ok) return await response.json();
      } catch (e) { if (signal?.aborted) throw e; }
    }
    return pacedFetch(url, signal, timeout, 'photon');
  };
  const fetchRouting = (url, signal, timeout = 30000) => pacedFetch(url, signal, timeout, 'routing');
  function geoUrl(query, limit = 6) {
    const u = new URL(GEOCODER);
    u.searchParams.set('q', query);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('lang', 'en');
    u.searchParams.set('countrycode', SEARCH_COUNTRY);
    // Prefer the chosen start, otherwise favor the initial Bay Area map;
    // geographic bias is NOT a restrictive 50-mile search radius.
    const center = validPoint(state.start.coordinates) ? state.start.coordinates : DEFAULT_CENTER;
    u.searchParams.set('lat', center[1]);
    u.searchParams.set('lon', center[0]);
    return u.toString();
  }
  function closeSuggestions() {
    clearTimeout(geoDebounce);
    if (geoAbort) { geoAbort.abort(); geoAbort = null; }
    document.querySelectorAll('.suggestions').forEach(el => { el.hidden = true; el.replaceChildren(); });
    document.querySelectorAll('input[aria-expanded]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    suggestionsOwner = null;
  }
  function wireAddressInput(input, kind, stopId) {
    input.addEventListener('input', () => {
      const val = input.value;
      if (kind === 'start') updateStart(val);
      else if (kind === 'stop') updateStop(stopId, val);
      showAutocomplete(input, val, kind, stopId);
    });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 3 && (kind === 'map' || !validPoint(kind === 'start' ? state.start.coordinates : getStop(stopId)?.coordinates))) showAutocomplete(input, input.value, kind, stopId); });
    input.addEventListener('keydown', e => {
      const panel = input.closest('.field-shell').querySelector('.suggestions');
      const items = [...panel.querySelectorAll('.suggestion-item')];
      let selected = items.findIndex(el => el.classList.contains('selected'));
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); selected = (selected + 1) % items.length; selectSuggestionItem(items, selected); }
      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); selected = (selected - 1 + items.length) % items.length; selectSuggestionItem(items, selected); }
      if (e.key === 'Enter') {
        if (items.length) { e.preventDefault(); items[selected < 0 ? 0 : selected].click(); }
        else if (kind === 'map' && input.value.trim()) { e.preventDefault(); closeSuggestions(); searchMapPlace(input.value.trim()); }
        else if (kind === 'start' && input.value.trim() && stopCount()) { e.preventDefault(); closeSuggestions(); optimize(); }
      }
      if (e.key === 'Escape') { closeSuggestions(); input.blur(); }
    });
  }
  function selectSuggestionItem(items, selected) { items.forEach((item, i) => item.classList.toggle('selected', i === selected)); }
  function showAutocomplete(input, query, kind, stopId) {
    if (geoDebounce) clearTimeout(geoDebounce);
    if (geoAbort) geoAbort.abort();
    closeSuggestions();
    const panel = input.closest('.field-shell').querySelector('.suggestions');
    if (safeText(query).length < 3) return;
    suggestionsOwner = input;
    geoDebounce = setTimeout(async () => {
      const controller = new AbortController();
      geoAbort = controller;
      panel.innerHTML = '<div class="suggestion-loading">Finding addresses…</div>';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      try {
        const data = await fetchGeocoder(geoUrl(query), controller.signal, 12000);
        if (controller.signal.aborted || input !== suggestionsOwner || input.value !== query) return;
        panel.replaceChildren();
        const features = matchingFeatures(data, query);
        if (!features.length) {
          panel.innerHTML = enteredHouseNumber(query)
            ? '<div class="suggestion-empty">No exact U.S. house-number match. Add city, state and ZIP, or choose the building on the map. Street-only pins are not accepted as houses.</div>'
            : '<div class="suggestion-empty">No U.S. matches. Try a city, state, or ZIP code.</div>';
          return;
        }
        for (const feature of features) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'suggestion-item';
          button.setAttribute('role', 'option');
          button.innerHTML = PIN_ICON;
          const label = document.createElement('span');
          label.className = 'suggestion-text';
          const primary = document.createElement('strong');
          primary.textContent = featureHeading(feature);
          const secondary = document.createElement('small');
          secondary.textContent = featureLabel(feature) + (feature.properties?.housenumber ? ' · Address match (pin may be approximate)' : ' · Place/street location (not a verified house)');
          label.append(primary, secondary);
          button.append(label);
          button.addEventListener('mousedown', e => e.preventDefault());
          button.addEventListener('click', () => {
            const text = featureLabel(feature);
            const coords = feature.geometry.coordinates;
            input.value = text;
            if (kind === 'start') updateStart(text, coords);
            else if (kind === 'map') showPickedLocation(text, coords);
            else updateStop(stopId, text, coords);
            closeSuggestions();
            input.blur();
            if (mapLoaded && !state.route) map.flyTo({ center: coords, zoom: feature.properties?.housenumber ? 17 : 14, duration: 950 });
            renderMarkers();
          });
          panel.appendChild(button);
        }
      } catch (e) {
        if (!controller.signal.aborted && input === suggestionsOwner) panel.innerHTML = '<div class="suggestion-empty">Address suggestions unavailable. You can still type an address.</div>';
      }
    }, 570);
  }

  function renderStops() {
    const list = $('stopsList');
    list.replaceChildren();
    for (const [index, stop] of state.stops.entries()) {
      const row = document.createElement('div');
      row.className = 'stop-row' + (validPoint(stop.coordinates) ? ' resolved' : '');
      row.dataset.id = stop.id;
      row.draggable = true;
      const number = document.createElement('div');
      number.className = 'stop-count-badge';
      number.textContent = String(index + 1);
      const shell = document.createElement('div');
      shell.className = 'field-shell';
      shell.innerHTML = '<span class="field-search-icon" aria-hidden="true">' + PIN_ICON + '</span>';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = `Stop ${index + 1} · Enter an address`;
      input.value = stop.text;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', `Stop ${index + 1} address`);
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      const suggestions = document.createElement('div');
      suggestions.className = 'suggestions';
      suggestions.hidden = true;
      suggestions.setAttribute('role', 'listbox');
      shell.append(input, suggestions);
      wireAddressInput(input, 'stop', stop.id);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'remove-stop'; remove.innerHTML = CROSS_ICON;
      remove.title = `Remove stop ${index + 1}`; remove.setAttribute('aria-label', `Remove stop ${index + 1}`);
      remove.addEventListener('click', () => removeStop(stop.id));
      const handle = document.createElement('button');
      handle.type = 'button'; handle.className = 'drag-handle'; handle.innerHTML = GRIP_ICON;
      handle.title = 'Drag to move or click to move down';
      handle.setAttribute('aria-label', `Move stop ${index + 1} down one position`);
      handle.addEventListener('click', () => moveStop(stop.id, 1));
      handle.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveStop(stop.id, e.key === 'ArrowUp' ? -1 : 1); } });
      row.append(number, shell, handle, remove);
      row.addEventListener('dragstart', e => { if (e.target.tagName === 'INPUT') { e.preventDefault(); return; } draggedStopId = stop.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', stop.id); });
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); e.dataTransfer.dropEffect = 'move'; });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('drag-over'); reorderStop(draggedStopId || e.dataTransfer.getData('text/plain'), stop.id); });
      row.addEventListener('dragend', () => { draggedStopId = null; document.querySelectorAll('.stop-row').forEach(r => r.classList.remove('dragging', 'drag-over')); });
      list.appendChild(row);
    }
    refreshStopCount();
  }
  function removeStop(id) {
    if (state.stops.length === 1) { state.stops = [makeStop()]; }
    else state.stops = state.stops.filter(s => s.id !== id);
    closeSuggestions(); resetRoute(); renderStops(); saveState();
  }
  function moveStop(id, delta) {
    const i = state.stops.findIndex(s => s.id === id);
    if (i < 0) return;
    const j = (i + delta + state.stops.length) % state.stops.length;
    [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
    closeSuggestions(); resetRoute(); renderStops(); saveState();
    const button = document.querySelector(`.stop-row[data-id="${id}"] .drag-handle`);
    button?.focus();
  }
  function reorderStop(id, targetId) {
    if (!id || id === targetId) return;
    const from = state.stops.findIndex(s => s.id === id);
    const target = state.stops.findIndex(s => s.id === targetId);
    if (from < 0 || target < 0) return;
    const [moving] = state.stops.splice(from, 1);
    state.stops.splice(target, 0, moving);
    closeSuggestions(); resetRoute(); renderStops(); saveState();
  }
  function addStop(focus = true) {
    if (state.stops.length >= MAX_STOPS) { toast(`Limit of ${MAX_STOPS} stops per route.`, true); return; }
    const stop = makeStop();
    state.stops.push(stop);
    renderStops(); saveState();
    if (focus) {
      const input = document.querySelector(`.stop-row[data-id="${stop.id}"] input`);
      input?.focus(); input?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function resolveAddress(place, signal) {
    if (validPoint(place.coordinates)) return place.coordinates;
    const search = safeText(place.text);
    if (!search) throw new Error('An address is missing.');
    let data;
    try { data = await fetchGeocoder(geoUrl(search, 5), signal, 16000); }
    catch (err) { if (err.name === 'AbortError') throw err; throw new Error(`Couldn't search for “${search}”. Check the internet connection or try again.`); }
    const enteredNumber = enteredHouseNumber(search);
    const candidates = matchingFeatures(data, search);
    const feature = candidates[0];
    if (!feature) throw new Error(enteredNumber
      ? `Couldn't verify house number ${enteredNumber} for “${search}”. Choose an address suggestion or pin the building on the map. No street-only substitute was used.`
      : `Couldn't find “${search}”. Try a more specific address or choose a suggestion.`);
    place.coordinates = feature.geometry.coordinates;
    // Keep the typed name when possible, but correct only empty labels.
    if (!place.text) place.text = featureLabel(feature);
    return place.coordinates;
  }
  const directionsUrl = (points) => points.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  function matrixUrl(coords) { return `${OSRM}/table/v1/driving/${directionsUrl(coords)}?annotations=duration`; }
  function routeUrl(coords) { return `${OSRM}/route/v1/driving/${directionsUrl(coords)}?geometries=geojson&overview=full&steps=false`; }
  function tripUrl(coords) { return `${OSRM}/trip/v1/driving/${directionsUrl(coords)}?roundtrip=true&source=first&destination=any&geometries=geojson&overview=full&steps=false`; }
  function isMatrixValid(data, n) { return data?.code === 'Ok' && Array.isArray(data.durations) && data.durations.length === n && data.durations.every(row => Array.isArray(row) && row.length === n); }
  function edge(matrix, a, b) { const v = matrix[a]?.[b]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Infinity; }
  function routeCost(matrix, order) { let total = 0, last = 0; for (const next of order) { total += edge(matrix, last, next); last = next; } return total + edge(matrix, last, 0); }

  // Exact Held–Karp dynamic-programming solution for a round trip with up to 11 stops.
  // Uses OSRM road-time durations and permits asymmetric travel times (one-way streets).
  function exactOrder(matrix, count) {
    const states = 1 << count;
    const total = states * count;
    const dp = new Float64Array(total).fill(Infinity);
    const parent = new Int16Array(total).fill(-1);
    const at = (mask, last) => mask * count + last;
    for (let i = 0; i < count; i++) dp[at(1 << i, i)] = edge(matrix, 0, i + 1);
    for (let mask = 1; mask < states; mask++) {
      for (let last = 0; last < count; last++) {
        if (!(mask & (1 << last))) continue;
        const cost = dp[at(mask, last)];
        if (!Number.isFinite(cost)) continue;
        for (let next = 0; next < count; next++) {
          if (mask & (1 << next)) continue;
          const candidate = cost + edge(matrix, last + 1, next + 1);
          const newIndex = at(mask | (1 << next), next);
          if (candidate < dp[newIndex]) { dp[newIndex] = candidate; parent[newIndex] = last; }
        }
      }
    }
    const mask = states - 1;
    let best = Infinity, bestLast = -1;
    for (let j = 0; j < count; j++) {
      const cost = dp[at(mask, j)] + edge(matrix, j + 1, 0);
      if (cost < best) { best = cost; bestLast = j; }
    }
    if (bestLast < 0 || !Number.isFinite(best)) throw new Error('Some of these stops cannot be connected by road.');
    const result = [];
    let currentMask = mask, last = bestLast;
    while (last >= 0) {
      result.unshift(last + 1);
      const prev = parent[at(currentMask, last)];
      currentMask ^= 1 << last;
      last = prev;
    }
    return result;
  }

  // For longer lists, multi-start nearest-neighbor + 2-opt + single-stop relocations.
  // Optimizes the same driving-time matrix without claiming an exact global solution.
  function heuristicOrder(matrix, count) {
    const all = Array.from({ length: count }, (_, i) => i + 1);
    let bestOrder = null, bestCost = Infinity;
    for (const seed of all) {
      const remaining = new Set(all);
      const order = [seed]; remaining.delete(seed);
      while (remaining.size) {
        let next = -1, cost = Infinity;
        for (const value of remaining) { const c = edge(matrix, order[order.length - 1], value); if (c < cost) { cost = c; next = value; } }
        if (next < 0) break;
        order.push(next); remaining.delete(next);
      }
      if (order.length !== count) continue;
      let currentCost = routeCost(matrix, order);
      let improved = true, rounds = 0;
      while (improved && rounds++ < 25) {
        improved = false;
        for (let i = 0; i < count - 1; i++) {
          for (let j = i + 1; j < count; j++) {
            const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
            const c = routeCost(matrix, candidate);
            if (c + 0.01 < currentCost) { order.splice(0, count, ...candidate); currentCost = c; improved = true; }
          }
        }
        for (let i = 0; i < count; i++) {
          for (let j = 0; j < count; j++) {
            if (i === j) continue;
            const candidate = order.slice(); const [node] = candidate.splice(i, 1); candidate.splice(j, 0, node);
            const c = routeCost(matrix, candidate);
            if (c + 0.01 < currentCost) { order.splice(0, count, ...candidate); currentCost = c; improved = true; }
          }
        }
      }
      if (currentCost < bestCost) { bestCost = currentCost; bestOrder = [...order]; }
    }
    if (!bestOrder || !Number.isFinite(bestCost)) throw new Error('Some of these stops cannot be connected by road.');
    return bestOrder;
  }

  async function computeRoute(coords, signal) {
    try {
      const table = await fetchRouting(matrixUrl(coords), signal, 25000);
      if (!isMatrixValid(table, coords.length)) throw new Error('Travel-time matrix unavailable.');
      const count = coords.length - 1;
      const order = count <= 11 ? exactOrder(table.durations, count) : heuristicOrder(table.durations, count);
      const ordered = [0, ...order, 0];
      const road = await fetchRouting(routeUrl(ordered.map(i => coords[i])), signal, 30000);
      if (road?.code !== 'Ok' || !road.routes?.[0]?.geometry?.coordinates?.length) throw new Error('Could not draw the road route.');
      return { geometry: road.routes[0].geometry, legs: road.routes[0].legs || [], duration: road.routes[0].duration, distance: road.routes[0].distance, order, method: count <= 11 ? 'exact' : 'estimated' };
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw error;
      // Public tables can be limited. OSRM Trip provides an approximate fallback.
      const trip = await fetchRouting(tripUrl(coords), signal, 30000);
      if (trip?.code !== 'Ok' || !trip.trips?.[0]?.geometry?.coordinates?.length || !Array.isArray(trip.waypoints)) throw error;
      const order = trip.waypoints.map((w, i) => ({ inputIndex: i, position: w.waypoint_index })).sort((a, b) => a.position - b.position).map(w => w.inputIndex).filter(i => i !== 0);
      if (order.length !== coords.length - 1) throw new Error('The routing service returned an incomplete route.');
      const t = trip.trips[0];
      return { geometry: t.geometry, legs: t.legs || [], duration: t.duration, distance: t.distance, order, method: 'estimated' };
    }
  }

  function setBusy(value, label = '') {
    state.busy = value;
    $('optimizeBtn').disabled = value;
    $('optimizeBtn').classList.toggle('is-loading', value);
    $('optimizeBtnText').textContent = value ? label : (state.route ? 'Re-optimize this route' : 'Find my best route');
    $('optimizeBtnArrow').style.visibility = value ? 'hidden' : 'visible';
    $('optimizeHint').textContent = value ? 'Finding the best way…' : (state.route ? 'Your loop is ready' : 'Ready when you are');
  }
  async function optimize() {
    if (state.busy) return;
    closeSuggestions();
    const selected = state.stops.filter(s => safeText(s.text));
    if (!safeText(state.start.text) && !validPoint(state.start.coordinates)) { toast('Add your starting location first.', true); $('startInput').focus(); return; }
    if (!selected.length) { toast('Add at least one stop to plan your loop.', true); document.querySelector('.stop-row input')?.focus(); return; }
    const signalController = new AbortController();
    routeAbort = signalController;
    setBusy(true, 'Locating your stops…');
    try {
      const places = [state.start, ...selected];
      for (let i = 0; i < places.length; i++) {
        if (signalController.signal.aborted) return;
        $('optimizeBtnText').textContent = `Locating ${i + 1} of ${places.length}…`;
        await resolveAddress(places[i], signalController.signal);
      }
      saveState(); renderStops();
      $('optimizeBtnText').textContent = 'Optimizing road times…';
      const result = await computeRoute(places.map(p => p.coordinates), signalController.signal);
      const ordered = result.order.map(i => places[i]);
      state.stops = [...ordered, ...state.stops.filter(s => !safeText(s.text))];
      state.route = { ...result, orderedStops: ordered, start: { ...state.start } };
      renderStops(); saveState(); renderRoute(); renderResults();
      $('results').hidden = false;
      $('mapOverlayHeading').hidden = true;
      $('mapOverlayBottom').hidden = true;
      $('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast(`Your ${ordered.length}-stop loop is ready!`);
      if (window.innerWidth <= 760) $('sidebar').classList.add('collapsed');
    } catch (error) {
      if (error.name !== 'AbortError') {
        toast(error.message || 'Route planning is temporarily unavailable. Try again in a moment.', true);
        console.error('[Looply] Unable to optimize:', error);
      }
    } finally { setBusy(false); if (routeAbort === signalController) routeAbort = null; }
  }
  function googleMapsLeg(from, to) {
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', `${from[1]},${from[0]}`);
    url.searchParams.set('destination', `${to[1]},${to[0]}`);
    url.searchParams.set('travelmode', 'driving');
    return url.toString();
  }
  function orderedRoutePoints() {
    if (!state.route || !validPoint(state.start.coordinates)) return [];
    return [state.start.coordinates, ...state.route.orderedStops.map(p => p.coordinates), state.start.coordinates].filter(validPoint);
  }
  const coordinateString = p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
  function googleLink(points) {
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api','1'); url.searchParams.set('origin',coordinateString(points[0]));
    url.searchParams.set('destination',coordinateString(points[points.length - 1])); url.searchParams.set('travelmode','driving');
    if (points.length > 2) url.searchParams.set('waypoints',points.slice(1,-1).map(coordinateString).join('|'));
    return url.toString();
  }
  function appleLink(from,to) {
    const u = new URL('https://maps.apple.com/');
    u.searchParams.set('saddr',coordinateString(from)); u.searchParams.set('daddr',coordinateString(to)); u.searchParams.set('dirflg','d');
    return u.toString();
  }
  function openGoogleRoute() {
    const points=orderedRoutePoints(); if(points.length<3)return;
    // Conservative mobile-compatible chunks: 1 intermediate stop per link, with overlap.
    const segments=[];
    for (let i=0; i<points.length-1; i+=2) segments.push(points.slice(i,Math.min(i+3,points.length)));
    window.open(googleLink(segments[0]),'_blank','noopener,noreferrer');
    if(segments.length>1) {
      const box=$('exportNotice'); box.replaceChildren();
      box.append(document.createTextNode(`Google Maps route ${1} of ${segments.length} opened. Continue with: `));
      segments.slice(1).forEach((pts,i)=>{ const a=document.createElement('a'); a.href=googleLink(pts); a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=`Segment ${i+2}`; box.append(a, document.createTextNode('  ')); });
      toast(`${segments.length} route segments. Open the remaining links in order.`);
    } else $('exportNotice').textContent='Google Maps opened with the complete route. It may choose different roads.';
  }
  function openAppleRoute() {
    const pts=orderedRoutePoints(); if(pts.length<3)return;
    window.open(appleLink(pts[0],pts[1]),'_blank','noopener,noreferrer');
    const box=$('exportNotice'); box.replaceChildren();
    box.append(document.createTextNode(`Apple Maps leg 1 of ${pts.length-1} opened. Open these in order to finish the loop: `));
    for(let i=1;i<pts.length-1;i++){const a=document.createElement('a');a.href=appleLink(pts[i],pts[i+1]);a.target='_blank';a.rel='noopener noreferrer';a.textContent=`Leg ${i+1}`;box.append(a,document.createTextNode('  '));}
    toast('Apple Maps opens one leg at a time; all legs are listed here.');
  }
  function speakNav(message) {
    if (!navigationVoice || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(message); u.rate=.96; u.lang='en-US'; speechSynthesis.speak(u);
  }
  function navStepText(step) {
    const m=step.maneuver||{}; const road=step.name?` onto ${step.name}`:'';
    const type=m.type||''; const modifier=m.modifier||'';
    if(type==='arrive')return 'Arrive at your destination';
    if(type==='depart')return `Head ${modifier||'out'}${road}`;
    if(type==='roundabout'||type==='rotary')return `Enter the roundabout${road}`;
    if(type==='turn'||type==='end of road'||type==='fork')return `Turn ${modifier||'ahead'}${road}`;
    if(type==='merge')return `Merge ${modifier}${road}`;
    if(type==='on ramp'||type==='off ramp')return `Take the ${type}${road}`;
    if(type==='continue'||type==='new name')return `Continue${road}`;
    return `Continue ${modifier}${road}`.trim();
  }
  function showNavStep(announce=false) {
    const s=navigationSteps[navigationIndex]; if(!s)return;
    $('navStepTitle').textContent=navStepText(s);
    $('navStepDistance').textContent=`Step ${navigationIndex+1} of ${navigationSteps.length} · ${formatDistance(s.distance||0)} on this step. Follow road signs and conditions.`;
    $('prevTurnBtn').disabled=navigationIndex===0; $('nextTurnBtn').disabled=navigationIndex>=navigationSteps.length-1;
    if(announce&&lastSpokenIndex!==navigationIndex){lastSpokenIndex=navigationIndex;speakNav(navStepText(s));}
  }
  function stopNavigation() {
    if(gpsWatch!==null&&navigator.geolocation){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;}
    if('speechSynthesis' in window)speechSynthesis.cancel();
    if($('navigationPanel'))$('navigationPanel').hidden=true;
    navigationSteps=[];navigationIndex=0;lastSpokenIndex=-1;
  }
  async function startNavigation() {
    if(!state.route)return;
    $('navigationPanel').hidden=false;
    $('navStepTitle').textContent='Loading driving directions…';
    $('navStepDistance').textContent='Preparing guidance from routing data.';
    const points=orderedRoutePoints();
    try {
      const url=`${OSRM}/route/v1/driving/${directionsUrl(points)}?steps=true&overview=full&geometries=geojson`;
      const data=await fetchRouting(url,undefined,30000);
      if(data.code!=='Ok'||!data.routes?.[0]?.legs?.length)throw new Error('No directions returned.');
      navigationSteps=data.routes[0].legs.flatMap(leg=>leg.steps||[]).filter(step=>step.maneuver);
      navigationIndex=0;lastSpokenIndex=-1;showNavStep(true);
      // In-browser step review is NOT autonomous live turn-by-turn. GPS is shown as context only.
      if(navigator.geolocation){gpsWatch=navigator.geolocation.watchPosition(pos=>{
        lastGPS=[pos.coords.longitude,pos.coords.latitude];
        if(mapLoaded)map.easeTo({center:lastGPS,zoom:Math.max(map.getZoom(),13),duration:600});
      },()=>{}, {enableHighAccuracy:true,maximumAge:3000,timeout:12000});}
    }catch(e){$('navStepTitle').textContent='Could not load driving instructions';$('navStepDistance').textContent='Use Apple Maps or Google Maps for live turn-by-turn guidance.';}
  }
  function formatDistance(meters) { const mi = meters / 1609.344; return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`; }
  function formatDuration(seconds) { const min = Math.round(seconds / 60); if (min < 60) return `${min} min`; const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h ${m}m` : `${h}h`; }
  function renderResults() {
    const result = state.route; if (!result) return;
    $('totalDistance').textContent = formatDistance(result.distance);
    $('totalDuration').textContent = formatDuration(result.duration);
    $('totalStops').textContent = String(result.orderedStops.length);
    $('routeMethod').textContent = result.method === 'exact' ? 'Shortest estimated drive time for these stops' : 'Best estimated drive order found';
    $('optimizeBtnText').textContent = 'Re-optimize this route';
    $('optimizeHint').textContent = 'Your loop is ready';
    const list = $('routeOrder'); list.replaceChildren();
    const items = [{ name: state.start.text, desc: 'Starting location', type: 'start', icon: 'S' }, ...result.orderedStops.map((stop, i) => ({ name: stop.text, desc: result.legs[i] ? `${formatDuration(result.legs[i].duration)} drive from last stop` : `Stop ${i + 1}`, type: 'stop', icon: String(i + 1) })), { name: state.start.text, desc: result.legs[result.legs.length - 1] ? `${formatDuration(result.legs[result.legs.length - 1].duration)} drive back · Round trip complete` : 'Back where you started', type: 'finish', icon: '✓' }];
    items.forEach((item, index) => {
      const li = document.createElement('li');
      const rail = document.createElement('div'); rail.className = 'order-rail';
      const bubble = document.createElement('span'); bubble.className = `order-circle ${item.type === 'start' || item.type === 'finish' ? item.type : ''}`; bubble.textContent = item.icon;
      rail.append(bubble);
      if (index !== items.length - 1) { const line = document.createElement('span'); line.className = 'order-line'; rail.append(line); }
      const detail = document.createElement('div'); detail.className = 'order-item-details';
      const title = document.createElement('strong'); title.textContent = item.name;
      const sub = document.createElement('span'); sub.textContent = item.desc;
      detail.append(title, sub);
      if (item.type === 'stop' || item.type === 'finish') {
        const legIndex = index - 1;
        const from = legIndex === 0 ? state.start.coordinates : result.orderedStops[legIndex - 1]?.coordinates;
        const to = item.type === 'finish' ? state.start.coordinates : result.orderedStops[legIndex]?.coordinates;
        if (validPoint(from) && validPoint(to)) {
          const nav = document.createElement('a');
          nav.className = 'navigate-link';
          nav.href = googleMapsLeg(from, to);
          nav.target = '_blank'; nav.rel = 'noopener noreferrer';
          nav.textContent = item.type === 'finish' ? 'Navigate back ↗' : 'Navigate this leg ↗';
          nav.setAttribute('aria-label', `Open this leg to ${item.name} in Google Maps`);
          detail.append(nav);
        }
      }
      li.append(rail, detail); list.append(li);
    });
  }
  function emptyLine() { return { type: 'FeatureCollection', features: [] }; }
  function routeGeojson() { return state.route ? { type: 'Feature', properties: {}, geometry: state.route.geometry } : emptyLine(); }
  function ensureRouteLayers() {
    if (!mapLoaded || !map?.isStyleLoaded()) return;
    if (!map.getSource('loop-route')) map.addSource('loop-route', { type: 'geojson', data: routeGeojson() });
    if (!map.getLayer('loop-route-shadow')) map.addLayer({ id: 'loop-route-shadow', type: 'line', source: 'loop-route', paint: { 'line-color': '#fff', 'line-width': 12, 'line-opacity': .94, 'line-blur': .7 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!map.getLayer('loop-route-primary')) map.addLayer({ id: 'loop-route-primary', type: 'line', source: 'loop-route', paint: { 'line-color': '#4a6cf6', 'line-width': 6.3, 'line-opacity': .96 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  }
  function renderMarkers() {
    if (!mapLoaded) return;
    for (const marker of markers) marker.remove();
    markers = [];
    const points = [state.start, ...state.stops.filter(s => safeText(s.text))];
    for (const [idx, place] of points.entries()) {
      if (!validPoint(place.coordinates)) continue;
      const el = document.createElement('div');
      el.className = 'route-marker ' + (idx === 0 ? 'start' : 'stop');
      el.textContent = idx === 0 ? 'S' : String(idx);
      el.title = place.text;
      const name = document.createElement('div'); name.className = 'popup-title'; name.textContent = idx === 0 ? 'Start & finish' : `Stop ${idx}`;
      const address = document.createElement('div'); address.className = 'popup-detail'; address.textContent = place.text;
      const wrapper = document.createElement('div'); wrapper.append(name, address);
      const popup = new maplibregl.Popup({ offset: 22, closeButton: false }).setDOMContent(wrapper);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true }).setLngLat(place.coordinates).setPopup(popup).addTo(map);
      el.title = `${place.text} — drag pin onto the building to correct an approximate match`;
      marker.on('dragend', () => {
        const moved = marker.getLngLat();
        place.coordinates = [moved.lng, moved.lat];
        resetRoute(); saveState();
        toast('Pin adjusted manually. Confirm that it is on the intended building.');
      });
      markers.push(marker);
    }
  }
  function fitRoute() {
    if (!mapLoaded) { toast('Map is still loading.'); return; }
    const coords = state.route?.geometry?.coordinates || [state.start, ...state.stops].filter(s => validPoint(s.coordinates)).map(s => s.coordinates);
    if (!coords.length) { map.flyTo({ center: DEFAULT_CENTER, zoom: 10.5, duration: 900 }); return; }
    if (coords.length === 1) { map.flyTo({ center: coords[0], zoom: 12, duration: 850 }); return; }
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    const isMobile = window.innerWidth < 760;
    map.fitBounds(bounds, { padding: isMobile ? { top: 130, right: 55, bottom: 140, left: 55 } : { top: 90, right: 95, bottom: 95, left: 95 }, maxZoom: 13.5, duration: 1000 });
  }
  function renderRoute() {
    ensureRouteLayers();
    if (mapLoaded && map.getSource('loop-route')) map.getSource('loop-route').setData(routeGeojson());
    renderMarkers();
    fitRoute();
  }
  // Map can be used independently of the planner: search or click to select a place.
  async function searchMapPlace(query) {
    const controller = new AbortController();
    $('mapSearchInput').disabled = true;
    try {
      const data = await fetchGeocoder(geoUrl(query, 5), controller.signal, 17000);
      const feature = matchingFeatures(data, query)[0];
      if (!feature) { toast('No map results for that place. Try a more specific search.', true); return; }
      const label = featureLabel(feature);
      $('mapSearchInput').value = label;
      showPickedLocation(label, feature.geometry.coordinates);
    } catch { toast('Search failed. Check your internet connection and try again.', true); }
    finally { $('mapSearchInput').disabled = false; }
  }
  function showPickedLocation(label, coords) {
    if (!mapLoaded) { toast('The map has not connected yet.', true); return; }
    if (selectedMarker) selectedMarker.remove();
    const pin = document.createElement('div');
    pin.className = 'picked-marker'; pin.textContent = '+';
    const pane = document.createElement('div'); pane.className = 'picked-popup';
    const title = document.createElement('strong'); title.textContent = label;
    const hint = document.createElement('span'); hint.textContent = 'Choose what to do with this location:';
    const controls = document.createElement('div'); controls.className = 'picked-actions';
    const fromHere = document.createElement('button'); fromHere.type = 'button'; fromHere.textContent = 'Set as start';
    const addHere = document.createElement('button'); addHere.type = 'button'; addHere.textContent = '+ Add stop';
    fromHere.addEventListener('click', () => {
      $('startInput').value = label;
      updateStart(label, [...coords]);
      selectedMarker?.remove(); selectedMarker = null;
      renderMarkers();
      toast('Starting point set on the map.');
    });
    addHere.addEventListener('click', () => {
      let target = state.stops.find(s => !safeText(s.text));
      if (!target) {
        if (state.stops.length >= MAX_STOPS) { toast('You have reached the 20-stop limit.', true); return; }
        target = makeStop(); state.stops.push(target);
      }
      updateStop(target.id, label, [...coords]);
      renderStops();
      selectedMarker?.remove(); selectedMarker = null;
      renderMarkers();
      toast(`Added stop: ${label}`);
    });
    controls.append(fromHere, addHere); pane.append(title, hint, controls);
    const popup = new maplibregl.Popup({ offset: 27, closeButton: true, maxWidth: '280px' }).setDOMContent(pane);
    selectedMarker = new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat(coords).setPopup(popup).addTo(map);
    selectedMarker.togglePopup();
    map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 13), duration: 850 });
  }
  async function pickMapLocation(coords) {
    if (reverseAbort) reverseAbort.abort();
    reverseAbort = new AbortController();
    const signal = reverseAbort.signal;
    let label = `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
    // Immediately show the pin so the interaction works even if reverse geocoding fails.
    showPickedLocation(label, coords);
    try {
      const u = new URL('https://photon.komoot.io/reverse');
      u.searchParams.set('lon', coords[0]); u.searchParams.set('lat', coords[1]);
      u.searchParams.set('lang', 'en');
      const data = await fetchGeocoder(u.toString(), signal, 13000);
      if (signal.aborted) return;
      const feature = (data.features || []).find(f => f.geometry?.type === 'Point' && isUSFeature(f));
      if (feature) {
        const found = featureLabel(feature);
        if (found && selectedMarker && validPoint(selectedMarker.getLngLat().toArray())) {
          const current = selectedMarker.getLngLat();
          if (Math.abs(current.lng - coords[0]) < .00001 && Math.abs(current.lat - coords[1]) < .00001) {
            showPickedLocation(found, coords);
          }
        }
      }
    } catch { /* Coordinate pin remains usable when reverse lookup is unavailable. */ }
  }
  function initializeMap() {
    if (typeof window.maplibregl === 'undefined') { $('mapNetworkWarning').hidden = false; return; }
    try {
      map = new maplibregl.Map({ container: 'map', style: MAP_STYLE_LIGHT, center: DEFAULT_CENTER, zoom: 10.2, minZoom: 2, maxZoom: 19, attributionControl: true, cooperativeGestures: false, dragRotate: false, pitchWithRotate: false });
      map.touchZoomRotate.disableRotation();
      map.on('load', () => {
        mapLoaded = true; $('mapFallback').hidden = true; $('mapNetworkWarning').hidden = true;
        $('mapStatus').classList.add('connected'); $('mapStatusText').textContent = 'Live street map connected';
        ensureRouteLayers(); renderMarkers();
        map.on('click', event => { if (!event.originalEvent?.target?.closest('.maplibregl-marker, .maplibregl-popup')) pickMapLocation([event.lngLat.lng, event.lngLat.lat]); });
      });
      map.on('style.load', () => { if (!mapLoaded) return; ensureRouteLayers(); renderMarkers(); });
      map.on('error', error => { console.warn('[Looply map]', error.error || error); });
      setTimeout(() => { if (!mapLoaded) $('mapNetworkWarning').hidden = false; }, 16000);
    } catch (e) { console.error('[Looply] Map failed:', e); $('mapNetworkWarning').hidden = false; }
  }
  function activateMapButtons() {
    $('zoomInBtn').addEventListener('click', () => mapLoaded ? map.zoomIn({ duration: 300 }) : toast('Map needs an internet connection.', true));
    $('zoomOutBtn').addEventListener('click', () => mapLoaded ? map.zoomOut({ duration: 300 }) : toast('Map needs an internet connection.', true));
    $('fitBtn').addEventListener('click', fitRoute);
    $('mapStyleBtn').addEventListener('click', () => {
      if (!mapLoaded) { toast('Map needs an internet connection.', true); return; }
      state.mapStyle = state.mapStyle === 'light' ? 'dark' : 'light';
      map.setStyle(state.mapStyle === 'light' ? MAP_STYLE_LIGHT : MAP_STYLE_DARK);
      $('mapStyleBtn').setAttribute('title', state.mapStyle === 'light' ? 'Switch to dark map' : 'Switch to light map');
    });
  }
  async function useCurrentLocation() {
    if (!navigator.geolocation) { toast('Your browser does not support location access.', true); return; }
    $('locateBtn').disabled = true;
    $('locateBtn').style.opacity = '.5';
    navigator.geolocation.getCurrentPosition(position => {
      const coordinates = [position.coords.longitude, position.coords.latitude];
      state.start = { text: 'My current location', coordinates };
      state.locateUsed = true;
      $('startInput').value = state.start.text;
      resetRoute(); saveState(); closeSuggestions();
      if (mapLoaded) map.flyTo({ center: coordinates, zoom: 13, duration: 1100 });
      toast('Starting at your current location.');
      $('locateBtn').disabled = false; $('locateBtn').style.opacity = '';
    }, err => {
      toast(err.code === 1 ? 'Location access was denied. Enter an address instead.' : 'Could not determine your location.', true);
      $('locateBtn').disabled = false; $('locateBtn').style.opacity = '';
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  function setExample() {
    if (routeAbort) routeAbort.abort();
    state.start = { text: 'San Mateo, California, United States', coordinates: null };
    state.stops = ['Burlingame, California, United States', 'Foster City, California, United States', 'Redwood City, California, United States', 'Belmont, California, United States'].map(s => makeStop(s));
    state.locateUsed = false;
    $('startInput').value = state.start.text;
    closeSuggestions(); resetRoute(); renderStops(); saveState();
    $('sidebarScroll').scrollTo({ top: 0, behavior: 'smooth' });
    toast('Example loaded. Tap “Find my best route” to optimize.');
    if (window.innerWidth <= 760) $('sidebar').classList.remove('collapsed');
  }
  function clearAll() {
    if (routeAbort) routeAbort.abort();
    state.start = { text: '', coordinates: null };
    state.stops = [makeStop(), makeStop()];
    state.locateUsed = false;
    $('startInput').value = '';
    closeSuggestions(); resetRoute(); renderStops(); saveState();
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    toast('Route cleared.');
  }
  async function copyToClipboard(content) {
    if (navigator.clipboard?.writeText && window.isSecureContext) return await navigator.clipboard.writeText(content);
    const el = document.createElement('textarea'); el.value = content; el.style.position = 'fixed'; el.style.opacity = '0';
    document.body.appendChild(el); el.select();
    const worked = document.execCommand('copy'); el.remove();
    if (!worked) throw new Error('Clipboard unavailable.');
  }
  async function copyRoute() {
    if (!state.route) return;
    const r = state.route;
    const lines = ['LOOPLY — OPTIMIZED ROUND TRIP', `Total: ${formatDistance(r.distance)} · ${formatDuration(r.duration)}`, '', `START: ${state.start.text}`, ...r.orderedStops.map((s, i) => `${i + 1}. ${s.text}`), `FINISH: ${state.start.text}`, '', 'Times are estimates and exclude live traffic.'];
    try { await copyToClipboard(lines.join('\n')); toast('Stop order copied to your clipboard.'); }
    catch { toast('Could not copy. Try another browser.', true); }
  }
  async function shareRoute() {
    if (!state.route) return;
    if (state.locateUsed) { toast('To share this loop, enter a starting address instead of using your precise location.', true); return; }
    try {
      const data = JSON.stringify({ start: state.start.text, stops: state.route.orderedStops.map(s => s.text) });
      const bytes = new TextEncoder().encode(data);
      let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      const r = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const link = new URL(window.location.href); link.search = '?r=' + r; link.hash = '';
      if (link.href.length > 8000) { toast('This route is too long for a share link. Use Copy route instead.', true); return; }
      await copyToClipboard(link.href);
      toast('Share link copied! Anyone with it can see the addresses.');
    } catch { toast('Could not create a share link in this browser.', true); }
  }
  function openPasteModal() {
    $('pasteModal').hidden = false; $('bulkTextarea').value = '';
    setTimeout(() => $('bulkTextarea').focus(), 30);
  }
  function closePasteModal() { $('pasteModal').hidden = true; }
  function importStops() {
    const lines = $('bulkTextarea').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) { toast('Paste at least one address.', true); return; }
    const blanks = state.stops.filter(s => !safeText(s.text));
    const slots = MAX_STOPS - state.stops.length + blanks.length;
    if (lines.length > slots) { toast(`Only ${slots} more stops will fit. Remove stops or paste fewer addresses.`, true); return; }
    let next = 0;
    for (const blank of blanks) { if (next >= lines.length) break; blank.text = lines[next++]; blank.coordinates = null; }
    while (next < lines.length) state.stops.push(makeStop(lines[next++]));
    resetRoute(); renderStops(); saveState(); closePasteModal();
    toast(`Added ${lines.length} ${lines.length === 1 ? 'stop' : 'stops'}.`);
  }
  function initMobile() {
    if (window.innerWidth <= 760) $('sidebar').classList.add('collapsed');
    $('mobilePlannerBtn').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
    const bar = document.querySelector('.topbar');
    bar.addEventListener('click', e => { if (window.innerWidth <= 760 && !e.target.closest('a,button')) $('sidebar').classList.toggle('collapsed'); });
    window.addEventListener('resize', debounce(() => { if (mapLoaded) map.resize(); }, 180));
  }
  function bindUI() {
    readState();
    $('startInput').value = state.start.text;
    wireAddressInput($('startInput'), 'start');
    wireAddressInput($('mapSearchInput'), 'map');
    $('retryMapBtn').addEventListener('click', () => window.location.reload());
    renderStops();
    $('optimizeBtn').addEventListener('click', optimize);
    $('addStopBtn').addEventListener('click', () => addStop());
    $('clearBtn').addEventListener('click', clearAll);
    $('sampleBtn').addEventListener('click', setExample);
    $('locateBtn').addEventListener('click', useCurrentLocation);
    $('copyBtn').addEventListener('click', copyRoute);
    $('googleMapsBtn').addEventListener('click', openGoogleRoute);
    $('appleMapsBtn').addEventListener('click', openAppleRoute);
    $('startRouteBtn').addEventListener('click', startNavigation);
    $('stopNavBtn').addEventListener('click', stopNavigation);
    $('prevTurnBtn').addEventListener('click',()=>{navigationIndex=Math.max(0,navigationIndex-1);showNavStep(true);});
    $('nextTurnBtn').addEventListener('click',()=>{navigationIndex=Math.min(navigationSteps.length-1,navigationIndex+1);showNavStep(true);});
    $('voiceToggleBtn').addEventListener('click',()=>{navigationVoice=!navigationVoice;$('voiceToggleBtn').textContent=navigationVoice?'Voice on':'Voice off';if(!navigationVoice&&'speechSynthesis' in window)speechSynthesis.cancel();});
    $('shareBtn').addEventListener('click', shareRoute);
    $('pasteBtn').addEventListener('click', openPasteModal);
    $('closeModalBtn').addEventListener('click', closePasteModal);
    $('pasteModal').addEventListener('mousedown', e => { if (e.target === $('pasteModal')) closePasteModal(); });
    $('importBtn').addEventListener('click', importStops);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSuggestions(); closePasteModal(); } });
    document.addEventListener('pointerdown', e => { if (!e.target.closest('.field-shell')) closeSuggestions(); });
    activateMapButtons(); initializeMap(); initMobile();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI, { once: true });
  else bindUI();
})();
