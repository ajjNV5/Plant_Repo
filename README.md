# Plant Repo

Bio-Steward Seed Archive is a client-side web app for local plant discovery, trail planning, and seed storage tracking.

This document is an onboarding guide for engineers joining the project.

## What the app does

The app has three tabs:

1. Bio-Map
- Geocodes a US address.
- Loads local plant observations from GBIF.
- Loads nearby hike and nature locations from Overpass (OpenStreetMap).
- Renders both on a Leaflet map.
- Links each hike location to likely nearby plants with confidence badges.

2. Seed-Dex
- Tracks collected plants from the current loaded species list.
- Persists collected state locally.
- Shows progress as a completion bar.

3. Vault Manual
- Applies Rule of 100 logic.
- Tracks seed batches by species and year.
- Renders SVG seed vials with dynamic fill color, fill level, and glow based on viability.
- Shifts visual atmosphere from lush to parched based on storage conditions.

## Tech stack

- Vanilla HTML, CSS, JavaScript.
- Leaflet for map rendering.
- Nominatim for geocoding.
- GBIF occurrence API for plant observations.
- Overpass API for hike and nature location data.
- LocalStorage for persistence.

No build system is required.

## Project structure

- index.html: app shell, templates, external stylesheet and script includes.
- styles.css: full visual theme, component styling, marker styling, vault visuals.
- app.js: state management, API calls, filtering logic, map rendering, vault logic.

## Run locally

Use a static server from the repo root.

```bash
cd <repository-directory>
python -m http.server 8000
```

Open http://localhost:8000

## Data flow overview

1. User submits address in Bio-Map.
2. Nominatim returns lat/lon.
3. App validates continental US bounds.
4. App requests in parallel:
- GBIF plant occurrence results.
- Overpass hike and nature spot results.
5. App filters/normalizes data.
6. App links trail points to nearby plants and computes confidence.
7. App renders:
- Plant and trail markers on Leaflet map.
- Plant list, trail cards, and progress state.

## Plant data model

Each normalized plant record includes:

- id
- commonName
- scientificName
- imageUrl
- lat
- lon
- month
- basis

Current filtering strategy emphasizes reliable observations:

- hasCoordinate=true
- hasGeospatialIssue=false
- occurrenceStatus=PRESENT
- taxonRank=SPECIES
- year within recent window
- coordinateUncertaintyInMeters threshold
- within radius by haversine distance

## Trail matching model

Trail points are linked to likely plants via distance + relevance scoring.

- Primary radius: nearby match window.
- Fallback radius: expanded window if no nearby matches.
- Final fallback: nearest regional observations.

Each plant-trail match includes:

- distance
- confidence label (High, Medium, Low)
- seeding phase text

## Map rendering model

- Plant markers use image-based custom div icons.
- Trail markers use a unified hiker icon.
- Popups summarize nearby likely plants and seeding state.

## Vault system model

The vault tracks batch life cycles per species:

- Species can have multiple batch years.
- Batch data is grouped by species in UI.
- Each batch gets a viability score derived from:
  - age since collection year
  - current storage health

Storage health is computed from temp + humidity and drives:

- rule feedback messaging
- vial visuals
- global atmospheric theme interpolation

## Local storage keys

- collectedSpecies: array of selected species ids.
- seedVaultBatches: array of batch objects (species id/name/scientific name/year).

## UI system notes

- Theme direction is mystical natural with glassmorphism-like surfaces.
- Typography uses Cinzel for headings, Lora for body, Montserrat for UI/data text.
- Marker and card styles are intentionally high-contrast for field usability.

## Common engineering tasks

1. Adjust map query behavior
- Edit GBIF/Overpass parameter logic in app.js.

2. Tune match strictness
- Edit trail match radius and score functions in app.js.

3. Modify marker visuals
- Update marker HTML generation in app.js and marker classes in styles.css.

4. Change vault viability behavior
- Update computeBatchViability and computeStorageHealth in app.js.

5. Extend onboarding text and product behavior docs
- Update this README.

## Operational caveats

- External APIs may rate-limit or return sparse results in some regions.
- GBIF common names and media are not guaranteed for every species.
- Overpass response density varies by location.
- Browser caching may hide style changes until hard refresh.

## Recommended next improvements

1. Add lightweight automated tests for data normalization and viability scoring.
2. Add explicit retry/backoff and user-facing API failure states.
3. Add simple telemetry hooks for match quality and no-result sessions.
