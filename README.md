# Looply 3.4 — Netlify search upgrade (beta)

This project is based on the older five-file `Looply-Live-Website(1).zip` supplied in the conversation, **not** the separate Looply 3.3 package. It retains the existing Photon/OSRM fallback and adds an optional server-side TomTom search function. It is NOT a finished App Store app and does NOT yet include live traffic or cloud voice.

## Deploy with Netlify (functions)
1. Put this entire folder in a GitHub repository (keep `netlify.toml` and `netlify/functions/search.mjs`).
2. In Netlify, choose **Add new project → Import an existing project** and select that GitHub repository. Build command: blank; publish directory: `.`. The Git-linked build deploys the function automatically.
3. Netlify → **Project configuration → Environment variables** → add `TOMTOM_API_KEY` with a valid key from your TomTom developer account. Set scope to include Functions; redeploy after changing variables.
4. Visit `https://YOUR-SITE.netlify.app/api/search?q=San%20Mateo` and confirm it returns JSON including `provider:"TomTom"`.
5. Test numbered addresses, business names, nearby searches, remote searches, draggable pins and round-trip routes before publishing. APIs can fail or return estimated locations. Don't rely on beta for safety-critical navigation.

A drag-and-drop static deploy alone will NOT deploy these source functions reliably; use Git-connected deployment or Netlify CLI. If you deploy only the website files, search falls back to Photon.

## Important data limitations
A search provider coordinate may represent a driveway, road entrance, parcel midpoint or interpolation, not the actual rooftop. The app flags address-vs-street results and allows manual repositioning. Manual placement is an adjustment by the user, not third-party verification. For truly parcel/rooftop-specific pins, a licensed parcel/rooftop data source and an accuracy review are needed.

The original OSRM public demo has no live traffic. This upgrade does not claim current 2026 road validation, a live traffic overlay, or traffic-aware optimality. For production, replace routing with a contracted traffic-capable API and validate routing and travel time responses.

For App Store release, create a native project with Capacitor or equivalent, add native navigation/location handling and permissions, test on devices, and submit via Xcode and App Store Connect. Apple requires the legal age of majority to enroll as an individual; a parent or eligible adult/organization can own the developer membership where appropriate. Apple's minimum functionality guidelines can reject a thin web wrapper.
