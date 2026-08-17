const express = require('express');
const router  = express.Router();
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { GeoCache } = require('../models/database');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const TIMEOUT_MS = 8000;

const withTimeout = (promise) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
  ]);

// ── Two-layer geocode cache (memory + MongoDB) ────────────────────────────
// Layer 1: in-memory Map for instant sub-millisecond lookups
// Layer 2: MongoDB GeoCache collection — survives server restarts/deploys
// Key precision: 2 decimal places ≈ 1 km grid
const _geoCache  = new Map();         // key → payload
const _inflight  = new Map();         // key → Promise (deduplicates concurrent requests for same spot)
const _cacheKey  = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

// GET /api/geocode?lat=17.43&lng=78.37
router.get('/', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });

  // Layer 1: in-memory hit — instant, no DB or external call
  const ckey = _cacheKey(lat, lng);
  if (_geoCache.has(ckey)) return res.json({ lat, lng, ..._geoCache.get(ckey) });

  // Deduplicate: if another request for the same ~1km cell is already in-flight,
  // wait on the same Promise instead of firing a second external API call
  if (_inflight.has(ckey)) {
    try {
      const payload = await _inflight.get(ckey);
      return res.json({ lat, lng, ...payload });
    } catch {
      return res.status(502).json({ error: 'geocoding failed' });
    }
  }

  const fromNominatim = async () => {
    const r = await withTimeout(fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { 'User-Agent': 'BRP-AMS/1.0 (brp-ams@brptripura.com)', 'Accept-Language': 'en' } }
    ));
    const j = await r.json();
    if (!j.display_name) throw new Error('no data');
    const a = j.address || {};
    return {
      city:     a.city || a.town || a.village || a.municipality || a.county || '',
      suburb:   a.suburb || a.neighbourhood || a.quarter || a.hamlet || a.locality || '',
      postcode: a.postcode || '',
      state:    a.state || '',
      district: a.state_district || a.county || a.district || '',
      address:  j.display_name,
    };
  };

  const fromBigData = async () => {
    const r = await withTimeout(fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    ));
    const j = await r.json();
    if (!j.city && !j.locality && !j.principalSubdivision) throw new Error('no data');
    const adminList = (j.localityInfo?.administrative || [])
      .filter(a => a.name && a.adminLevel >= 4 && a.adminLevel <= 8)
      .sort((a, b) => b.adminLevel - a.adminLevel);
    const city   = j.city || j.locality || adminList[0]?.name || '';
    const suburb = (j.locality && j.locality !== city) ? j.locality
      : (adminList.find(a => a.adminLevel >= 7)?.name || '');
    return {
      city,
      suburb,
      postcode: j.postcode || '',
      state:    j.principalSubdivision || '',
      district: j.localityInfo?.administrative?.find(a => a.adminLevel === 5)?.name || '',
      address:  [suburb, city, j.principalSubdivision, j.countryName].filter(Boolean).join(', '),
    };
  };

  // Register in-flight promise before any await so concurrent requests share it
  const resolvePromise = (async () => {
    // Layer 2: MongoDB persistent cache — survives server restarts
    try {
      const cached = await GeoCache.findOne({ key: ckey }).lean();
      if (cached) {
        _geoCache.set(ckey, cached.payload);
        return cached.payload;
      }
    } catch { /* DB unavailable — fall through to live geocode */ }

    // Layer 3: live geocode — BigDataCloud + Nominatim in parallel
    const results   = await Promise.allSettled([fromBigData(), fromNominatim()]);
    const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const winner    = fulfilled.find(v => v.city || v.suburb || v.district || v.state);
    const payload   = winner
      ? { ...winner, postcode: winner.postcode || fulfilled.find(v => v.postcode)?.postcode || '' }
      : fulfilled[0];

    if (!payload) throw new Error('geocoding failed');

    // Persist to memory and MongoDB
    _geoCache.set(ckey, payload);
    GeoCache.updateOne({ key: ckey }, { $set: { payload } }, { upsert: true }).catch(() => {});

    return payload;
  })();

  _inflight.set(ckey, resolvePromise);
  resolvePromise.finally(() => _inflight.delete(ckey));

  try {
    const payload = await resolvePromise;
    return res.json({ lat, lng, ...payload });
  } catch (err) {
    return res.status(502).json({ error: 'geocoding failed', details: err.message });
  }
});

// GET /api/geocode/search?q=<text> — forward geocoding (name → lat/lng), India only
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q required (min 2 chars)' });
  try {
    const r = await withTimeout(fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q.trim())}&format=json&addressdetails=1&limit=6&countrycodes=in`,
      { headers: { 'User-Agent': 'BRP-AMS/1.0 (brp-ams@brptripura.com)', 'Accept-Language': 'en' } }
    ));
    const results = await r.json();
    res.json(results.map(item => ({
      lat:          parseFloat(item.lat),
      lng:          parseFloat(item.lon),
      display_name: item.display_name,
      city:         item.address?.city || item.address?.town || item.address?.village || item.address?.suburb || '',
      state:        item.address?.state || '',
      district:     item.address?.state_district || item.address?.county || item.address?.district || '',
      postcode:     item.address?.postcode || '',
    })));
  } catch (err) {
    res.status(502).json({ error: 'search failed', details: err.message });
  }
});

module.exports = router;
