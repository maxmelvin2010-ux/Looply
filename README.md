# Looply 3.5 — Netlify source

This build consolidates U.S.-only search, a redesigned interface and icon, improved drag-handle placement, animated dots during route computation, route summary, navigation step preview, and Apple/Google Maps handoffs.

## Deploy

Replace the root files in the existing GitHub repository, including `netlify/functions/search.mjs`, `netlify.toml`, `index.html`, `app.js`, `styles.css`, and `favicon.svg`. GitHub upload may not reliably overwrite entire folder trees; verify `netlify/functions/search.mjs` is present with its correct path. Commit changes. The connected Netlify site should redeploy from the main branch. Check Deploys for Published and hard refresh. Build command: none. Publish directory: `.`.

For TomTom search, add `TOMTOM_API_KEY` in Netlify environment variables and redeploy. Do not put the key in source files. With no key the fallback is Photon. This package does NOT add live traffic, guaranteed rooftop address accuracy, or newer 2026 map records.

## Directions limitations

In-browser Start route offers driving-step preview with optional device speech and GPS map centering. It does not autonomously track turns, recalculate off-route, or provide certified live navigation. Use a dedicated Maps app for actual turn-by-turn. Google Maps handoff uses small, numbered multi-stop segments for mobile URL compatibility; Apple Maps handoff lists sequential legs. Neither provider can be forced to follow the same OSRM road geometry, and background navigation is not supported by the web app. Test on device before use.

Netlify Git-based deployment required for Functions; drag-and-drop deployment is static only.
