# Plant_Repo

Bio-Steward Seed Archive web app prototype with three mobile-friendly pages:

1. **Bio-Map (The Hunt)**
   - Address input geocoded to latitude/longitude (continental U.S. only)
   - 50-mile radius map using Leaflet/OpenStreetMap tiles
   - Native plant occurrences pulled from GBIF and filtered to the 50-mile radius
   - Nearby trails/nature locations pulled from Overpass (OpenStreetMap)
   - Interactive map popups for plants and hike spots
2. **Seed-Dex (Progress)**
   - Tracks collected seeds vs species discovered in region
   - Completion bar with local persistence in browser storage
3. **Vault Manual (Archive)**
   - Rule of 100 calculator (`temperature + relative humidity < 100`)
   - Dynamic storage/planting cards generated from collected species
   - Seed viability reminder for 2-year review windows

## Run locally

```bash
cd /home/runner/work/Plant_Repo/Plant_Repo
python3 -m http.server 8000
```

Open: `http://localhost:8000`
