// Netlify Function: credentials stay on the server.
export default async (request) => {
  if (request.method !== 'GET') return new Response('Method not allowed', {status:405});
  const key = Netlify.env.get('TOMTOM_API_KEY');
  if (!key) return Response.json({ configured:false, error:'TomTom API key not configured' }, {status:503});
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3 || q.length > 180) return Response.json({error:'Query must be 3 to 180 characters'}, {status:400});
  const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 8));
  const base = new URL(`https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json`);
  base.searchParams.set('key', key);
  base.searchParams.set('limit', String(limit));
  base.searchParams.set('language','en-US');
  base.searchParams.set('countrySet','US');
  base.searchParams.set('typeahead','true');
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (url.searchParams.has('lat') && url.searchParams.has('lon') && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180) {
    base.searchParams.set('lat', String(lat)); base.searchParams.set('lon', String(lon));
    base.searchParams.set('radius', '80467');
  }
  try {
    const upstream = await fetch(base, {signal:AbortSignal.timeout(8000)});
    if (!upstream.ok) return Response.json({error:'Map provider unavailable',code:upstream.status}, {status:502});
    const data = await upstream.json();
    const features = (data.results || []).filter(r => r.position && Number.isFinite(r.position.lat) && Number.isFinite(r.position.lon) && ['US','USA'].includes(String(r.address?.countryCode || '').toUpperCase())).map(r => {
      const a = r.address || {};
      const street = a.streetName || a.street || '';
      const number = a.streetNumber ? String(a.streetNumber) : '';
      return { type:'Feature', geometry:{type:'Point',coordinates:[r.position.lon,r.position.lat]}, properties:{
        name:r.poi?.name || '', housenumber:number,street,city:a.municipality || a.localName || '',state:a.countrySubdivision || '',country:a.country || 'United States',countrycode:'US',
        accuracy: number ? 'address-provider' : (r.type === 'POI' ? 'poi' : 'approximate'), provider:'TomTom',
        fullAddress:a.freeformAddress || ''
      }};
    });
    return Response.json({features,provider:'TomTom',configured:true}, {headers:{'Cache-Control':'public, max-age=30'}});
  } catch {return Response.json({error:'Map provider timed out'}, {status:502});}
};
