const tabs = [...document.querySelectorAll('.tab')];
const pages = [...document.querySelectorAll('.page')];
const mapElement = document.getElementById('map');
const statusElement = document.getElementById('status');
const plantsList = document.getElementById('plants-list');
const trailsList = document.getElementById('trails-list');
const collectedList = document.getElementById('collected-list');
const completionBar = document.getElementById('completion-bar');
const completionText = document.getElementById('completion-text');
const vaultCards = document.getElementById('vault-cards');

const maxRadiusKm = 80.4672; // 50 miles
const KM_PER_LAT_DEGREE = 111;
const GBIF_FETCH_LIMIT = 120;
const MAX_SPECIES_DISPLAY = 25;
const DEFAULT_VIABILITY_YEARS = 2;
const GENERAL_SEEDING_MONTHS = [8, 9, 10, 11];
const speciesStorageRules = [
  {
    pattern: /milkweed/i,
    title: 'Stratification',
    message: 'Refrigerate ~30 days before spring sowing.',
  },
];
const appState = {
  species: [],
  collectedIds: new Set(JSON.parse(localStorage.getItem('collectedSpecies') || '[]')),
};

const map = L.map(mapElement, { zoomControl: false }).setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const layerGroup = L.layerGroup().addTo(map);

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    pages.forEach((page) => page.classList.toggle('active', page.id === tab.dataset.tab));
    map.invalidateSize();
  });
});

document.getElementById('location-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = document.getElementById('address').value.trim();
  if (!address) return;

  statusElement.textContent = 'Geocoding address...';
  plantsList.innerHTML = '';
  trailsList.innerHTML = '';
  layerGroup.clearLayers();

  try {
    const location = await geocodeAddress(address);
    if (!isContinentalUS(location)) {
      statusElement.textContent = 'Address must be in the continental U.S.';
      return;
    }

    statusElement.textContent = 'Loading native species and trails in 50-mile radius...';

    const [species, trails] = await Promise.all([
      loadSpecies(location.lat, location.lon),
      loadTrails(location.lat, location.lon),
    ]);

    appState.species = species;

    renderMap(location, species, trails);
    renderSpeciesList(species);
    renderTrailsList(trails);
    refreshProgress();
    renderVaultCards();

    statusElement.textContent = `Loaded ${species.length} native plants and ${trails.length} hike spots.`;
  } catch (error) {
    statusElement.textContent = `Unable to load data: ${error.message}`;
  }
});

document.getElementById('rule-check').addEventListener('click', () => {
  const temp = Number(document.getElementById('temp').value);
  const humidity = Number(document.getElementById('humidity').value);
  const total = temp + humidity;
  document.getElementById('rule-result').textContent =
    total < 100
      ? `✅ Good storage conditions (${total} < 100).`
      : `⚠️ Storage risk: ${total}. Lower temperature or humidity.`;
});

function isContinentalUS({ lat, lon }) {
  return lat >= 24.5 && lat <= 49.5 && lon >= -124.8 && lon <= -66.9;
}

async function geocodeAddress(address) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Address not found');
  }
  return { lat: Number(data[0].lat), lon: Number(data[0].lon), display: data[0].display_name };
}

async function loadSpecies(lat, lon) {
  const latDelta = maxRadiusKm / KM_PER_LAT_DEGREE;
  const lonDelta = maxRadiusKm / (KM_PER_LAT_DEGREE * Math.cos((lat * Math.PI) / 180));

  const url = new URL('https://api.gbif.org/v1/occurrence/search');
  url.searchParams.set('limit', String(GBIF_FETCH_LIMIT));
  url.searchParams.set('offset', '0');
  url.searchParams.set('kingdomKey', '6');
  url.searchParams.set('hasCoordinate', 'true');
  url.searchParams.set('establishmentMeans', 'NATIVE');
  url.searchParams.set('decimalLatitude', `${lat - latDelta},${lat + latDelta}`);
  url.searchParams.set('decimalLongitude', `${lon - lonDelta},${lon + lonDelta}`);

  const response = await fetch(url);
  const data = await response.json();
  const rows = (data.results || [])
    .filter((item) => item.decimalLatitude && item.decimalLongitude)
    .map((item) => ({
      id: String(item.speciesKey || item.taxonKey || item.key),
      name: item.vernacularName || item.species || item.scientificName || 'Unknown plant',
      scientificName: item.scientificName || '',
      lat: item.decimalLatitude,
      lon: item.decimalLongitude,
      month: Number(item.month || 0),
      basis: item.basisOfRecord || 'observation',
    }))
    .filter((item) => haversine(lat, lon, item.lat, item.lon) <= maxRadiusKm);

  const deduped = [...new Map(rows.map((item) => [item.id, item])).values()].slice(0, MAX_SPECIES_DISPLAY);
  return deduped;
}

async function loadTrails(lat, lon) {
  const query = `
    [out:json][timeout:20];
    (
      way["highway"~"path|track|footway"](around:${Math.round(maxRadiusKm * 1000)},${lat},${lon});
      relation["route"="hiking"](around:${Math.round(maxRadiusKm * 1000)},${lat},${lon});
      node["leisure"="nature_reserve"](around:${Math.round(maxRadiusKm * 1000)},${lat},${lon});
    );
    out center 12;
  `;

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
  });
  const data = await response.json();

  return (data.elements || [])
    .map((element) => ({
      id: String(element.id),
      name: element.tags?.name || element.tags?.leisure || element.tags?.route || 'Trail / natural area',
      lat: element.center?.lat || element.lat,
      lon: element.center?.lon || element.lon,
    }))
    .filter((item) => item.lat && item.lon)
    .slice(0, 20);
}

function renderMap(location, species, trails) {
  map.setView([location.lat, location.lon], 10);
  layerGroup.clearLayers();

  L.circle([location.lat, location.lon], {
    radius: maxRadiusKm * 1000,
    color: '#2d7a3d',
    fillColor: '#5bc473',
    fillOpacity: 0.15,
  })
    .bindPopup(`Search radius: 50 miles<br>${location.display}`)
    .addTo(layerGroup);

  L.marker([location.lat, location.lon])
    .bindPopup(`📍 Base location<br>${location.display}`)
    .addTo(layerGroup);

  species.forEach((plant) => {
    const icon = L.divIcon({ className: '', html: '<div class="plant-marker">🌿</div>', iconSize: [44, 56] });
    L.marker([plant.lat, plant.lon], { icon })
      .bindPopup(
        `<b>${plant.name}</b><br>${plant.scientificName || 'Species unknown'}<br>${seedPhaseText(plant.month)}<br>Likely source: ${plant.basis}`,
      )
      .addTo(layerGroup);
  });

  trails.forEach((trail) => {
    L.circleMarker([trail.lat, trail.lon], { radius: 5, color: '#3b5ca8' })
      .bindPopup(`🥾 ${trail.name}`)
      .addTo(layerGroup);
  });
}

function renderSpeciesList(species) {
  const template = document.getElementById('plant-item-template');
  plantsList.innerHTML = '';

  species.forEach((plant) => {
    const fragment = template.content.cloneNode(true);
    const checkbox = fragment.querySelector('input');
    const name = fragment.querySelector('.name');
    const details = fragment.querySelector('.details');

    checkbox.checked = appState.collectedIds.has(plant.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        appState.collectedIds.add(plant.id);
      } else {
        appState.collectedIds.delete(plant.id);
      }
      localStorage.setItem('collectedSpecies', JSON.stringify([...appState.collectedIds]));
      refreshProgress();
      renderVaultCards();
    });

    name.textContent = plant.name;
    details.textContent = ` (${seedPhaseText(plant.month)})`;
    plantsList.appendChild(fragment);
  });
}

function renderTrailsList(trails) {
  trailsList.innerHTML = '';
  trails.forEach((trail) => {
    const li = document.createElement('li');
    li.textContent = trail.name;
    trailsList.appendChild(li);
  });
}

function refreshProgress() {
  const total = appState.species.length;
  const collectedSpecies = appState.species.filter((plant) => appState.collectedIds.has(plant.id));
  const collected = collectedSpecies.length;
  const percent = total ? Math.round((collected / total) * 100) : 0;

  completionBar.style.width = `${percent}%`;
  completionText.textContent = `${collected} / ${total} collected (${percent}%)`;

  collectedList.innerHTML = '';
  if (!collectedSpecies.length) {
    const li = document.createElement('li');
    li.textContent = 'No verified seed collections yet.';
    collectedList.appendChild(li);
    return;
  }

  collectedSpecies.forEach((plant) => {
    const li = document.createElement('li');
    li.textContent = `${plant.name} • ${seedPhaseText(plant.month)}`;
    collectedList.appendChild(li);
  });
}

function renderVaultCards() {
  const collectedSpecies = appState.species.filter((plant) => appState.collectedIds.has(plant.id));
  vaultCards.replaceChildren();
  if (!collectedSpecies.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'small';
    emptyMessage.textContent = 'Collect and verify seeds on the Bio-Map to generate personalized storage cards.';
    vaultCards.appendChild(emptyMessage);
    return;
  }

  collectedSpecies.forEach((plant) => {
    const card = document.createElement('article');
    card.className = 'card';
    const matchedRule = speciesStorageRules.find((rule) => rule.pattern.test(plant.name));

    const year = new Date().getFullYear();
    const title = document.createElement('h4');
    title.textContent = plant.name;
    card.appendChild(title);

    const storage = document.createElement('p');
    storage.innerHTML = `<b>Storage:</b> Cool, dry, dark container. Label as ${year} harvest.`;
    card.appendChild(storage);

    const planting = document.createElement('p');
    planting.innerHTML = '<b>Planting:</b> Sow at 2–3× seed depth in native soil mix with full sun adaptation.';
    card.appendChild(planting);

    const expiry = document.createElement('p');
    expiry.innerHTML = `<b>Expiry Alert:</b> Review by ${year + DEFAULT_VIABILITY_YEARS}; viability may decline after ${DEFAULT_VIABILITY_YEARS} years.`;
    card.appendChild(expiry);

    if (matchedRule) {
      const specialRule = document.createElement('p');
      specialRule.innerHTML = `<b>${matchedRule.title}:</b> ${matchedRule.message}`;
      card.appendChild(specialRule);
    }

    vaultCards.appendChild(card);
  });
}

function seedPhaseText(month) {
  if (!month) return 'Season unknown';
  return GENERAL_SEEDING_MONTHS.includes(month) ? 'Likely seeding phase' : 'Not peak seeding phase';
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (n) => (n * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

refreshProgress();
renderVaultCards();
