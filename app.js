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
const vaultSection = document.getElementById('vault');
const tempInput = document.getElementById('temp');
const humidityInput = document.getElementById('humidity');

const maxRadiusKm = 80.4672; // 50 miles
const KM_PER_LAT_DEGREE = 111;
const GBIF_FETCH_LIMIT = 120;
const MAX_SPECIES_DISPLAY = 25;
const DEFAULT_VIABILITY_YEARS = 2;
const MAX_COORD_UNCERTAINTY_METERS = 1000;
const RECENT_OBSERVATION_YEARS = 10;
const TRAIL_PLANT_RADIUS_KM = 8;
const TRAIL_PLANT_EXPANDED_RADIUS_KM = 20;
const MAX_PLANTS_PER_TRAIL = 8;
const GENERAL_SEEDING_MONTHS = [8, 9, 10, 11];
const STORAGE_HEALTH_MIN_SUM = 70;
const STORAGE_HEALTH_MAX_SUM = 130;
let seedVialIdCounter = 0;
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
  vaultBatches: JSON.parse(localStorage.getItem('seedVaultBatches') || '[]'),
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

    statusElement.textContent = 'Loading local species and trails in 50-mile radius...';

    const [species, trails] = await Promise.all([
      loadSpecies(location.lat, location.lon),
      loadTrails(location.lat, location.lon),
    ]);
    const trailsWithPlants = attachPlantMatchesToTrails(trails, species);

    appState.species = species;

    renderMap(location, species, trailsWithPlants);
    renderSpeciesList(species);
    renderTrailsList(trailsWithPlants);
    refreshProgress();
    renderVaultCards();

    statusElement.textContent = `Loaded ${species.length} local plants and ${trails.length} hike spots.`;
  } catch (error) {
    statusElement.textContent = `Unable to load data: ${error.message}`;
  }
});

document.getElementById('rule-check').addEventListener('click', () => {
  const temp = Number(tempInput.value);
  const humidity = Number(humidityInput.value);
  const total = temp + humidity;
  const health = computeStorageHealth(temp, humidity);
  document.getElementById('rule-result').textContent =
    total < 100
      ? `✅ Good storage conditions (${total} < 100).`
      : `⚠️ Storage risk: ${total}. Lower temperature or humidity.`;

  applyVaultAtmosphere(health);
  renderVaultCards();
});

[tempInput, humidityInput].forEach((input) => {
  input.addEventListener('input', () => {
    applyVaultAtmosphere(computeStorageHealth(Number(tempInput.value), Number(humidityInput.value)));
  });
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
  const currentYear = new Date().getFullYear();
  const minYear = currentYear - RECENT_OBSERVATION_YEARS;

  const searchParams = {
    limit: String(GBIF_FETCH_LIMIT),
    offset: '0',
    kingdomKey: '6',
    hasCoordinate: 'true',
    hasGeospatialIssue: 'false',
    occurrenceStatus: 'PRESENT',
    taxonRank: 'SPECIES',
    year: `${minYear},${currentYear}`,
    decimalLatitude: `${lat - latDelta},${lat + latDelta}`,
    decimalLongitude: `${lon - lonDelta},${lon + lonDelta}`,
  };

  const data = await fetchGbifOccurrences(searchParams);
  const rows = (data.results || [])
    .filter(
      (item) =>
        item.decimalLatitude &&
        item.decimalLongitude &&
        Number.isFinite(item.coordinateUncertaintyInMeters) &&
        item.coordinateUncertaintyInMeters <= MAX_COORD_UNCERTAINTY_METERS,
    )
    .map((item) => ({
      id: String(item.speciesKey || item.taxonKey || item.key),
      commonName: item.vernacularName || item.species || item.scientificName || 'Unknown plant',
      scientificName: item.scientificName || item.species || '',
      imageUrl: pickPlantImageUrl(item),
      lat: item.decimalLatitude,
      lon: item.decimalLongitude,
      month: Number(item.month || 0),
      basis: item.basisOfRecord || 'observation',
    }))
    .filter((item) => haversine(lat, lon, item.lat, item.lon) <= maxRadiusKm)
    .sort((a, b) => scoreSpeciesRecord(b) - scoreSpeciesRecord(a))
    .map((item) => ({ ...item, name: item.commonName }));

  const deduped = [...new Map(rows.map((item) => [item.id, item])).values()].slice(0, MAX_SPECIES_DISPLAY);
  return deduped;
}

function pickPlantImageUrl(item) {
  const mediaImage = (item.media || []).find((media) => media?.identifier || media?.references);
  return mediaImage?.identifier || mediaImage?.references || '';
}

function scoreSpeciesRecord(record) {
  let score = 0;
  if (record.imageUrl) score += 3;
  if (record.commonName && record.commonName !== 'Unknown plant') score += 2;
  if (record.scientificName) score += 1;
  return score;
}

async function fetchGbifOccurrences(params) {
  const url = new URL('https://api.gbif.org/v1/occurrence/search');
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GBIF request failed (${response.status})`);
  }
  return response.json();
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
      typeHint: inferTrailTypeHint(element.tags || {}),
      lat: element.center?.lat || element.lat,
      lon: element.center?.lon || element.lon,
    }))
    .filter((item) => item.lat && item.lon)
    .slice(0, 20);
}

function inferTrailTypeHint(tags) {
  if (tags.leisure === 'nature_reserve') return 'preserve';
  if (tags.route === 'hiking') return 'trail';
  if (tags.highway === 'path' || tags.highway === 'footway' || tags.highway === 'track') return 'trail';
  return 'general';
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
    const markerHtml = plant.imageUrl
      ? `<div class="plant-map-marker"><span class="plant-map-thumb-wrap"><img class="plant-map-thumb" src="${escapeHtmlAttribute(plant.imageUrl)}" alt="${escapeHtmlAttribute(plant.commonName || plant.name)} photo" referrerpolicy="no-referrer" /></span></div>`
      : '<div class="plant-map-marker no-image"><span class="plant-map-thumb-wrap"><span class="plant-map-thumb-fallback">No photo</span></span></div>';
    const icon = L.divIcon({ className: '', html: markerHtml, iconSize: [64, 76], iconAnchor: [32, 69], popupAnchor: [0, -56] });
    L.marker([plant.lat, plant.lon], { icon })
      .bindPopup(
        `<b>${plant.name}</b><br>${plant.scientificName || 'Species unknown'}<br>${seedPhaseText(plant.month)}<br>Likely source: ${plant.basis}`,
      )
      .addTo(layerGroup);
  });

  trails.forEach((trail) => {
    const trailSummary = buildTrailPlantsSummary(trail, 3);
    const icon = createTrailMapIcon(trail);
    L.marker([trail.lat, trail.lon], { icon })
      .bindPopup(
        `<b>🥾 ${trail.name}</b><br>${trailSummary.countText}<br>${trailSummary.scopeText}<br><br>${trailSummary.itemsText}`,
      )
      .addTo(layerGroup);
  });
}

function createTrailMapIcon(trail) {
  const category = 'hiker';
  const svg = getTrailIconSvg(category);
  return L.divIcon({
    className: '',
    html: `<div class="trail-marker ${category}">${svg}</div>`,
    iconSize: [38, 46],
    iconAnchor: [19, 42],
    popupAnchor: [0, -32],
  });
}

function categorizeTrailName(trail) {
  const text = `${trail.name || ''} ${trail.typeHint || ''}`.toLowerCase();
  if (/preserve|reserve|refuge|sanctuary/.test(text)) return 'preserve';
  if (/trail|route|path|footpath|hiking/.test(text)) return 'trail';
  if (/park|state park|national park/.test(text)) return 'park';
  if (/lake|river|creek|marsh|wetland|pond/.test(text)) return 'water';
  if (/mount|mountain|ridge|peak|canyon/.test(text)) return 'summit';
  if (/forest|woods|grove|arboretum|garden/.test(text)) return 'forest';
  return 'general';
}

function getTrailIconSvg(category) {
  const icons = {
    hiker:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 21l2.5-6 2.5-2.5 1.8 2.2 3.2 2.3M6 14l4-3.2 2-3.8 3 2M13.5 8.7l2.5 1.8M4.5 10.5l2.5 1"/></svg>',
    preserve:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M8 21l2-7-4-2 2-5 4 3M16 21l-2-7 4-2-2-5-4 3"/></svg>',
    trail:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20c4-4 6-6 8-10 1.2-2.2 3.1-4.1 8-6M7 17h2M12 12h2M17 7h2"/></svg>',
    park:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21h16M6 21v-7h12v7M12 3l7 5v6H5V8z"/></svg>',
    water:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9c1.8 0 1.8 1 3.6 1s1.8-1 3.6-1 1.8 1 3.6 1 1.8-1 3.6-1M4 14c1.8 0 1.8 1 3.6 1s1.8-1 3.6-1 1.8 1 3.6 1 1.8-1 3.6-1"/></svg>',
    summit:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20l6-9 4 5 3-4 5 8M9 11l2-3 2 3"/></svg>',
    forest:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l5 8h-3l3 5h-4v5h-2v-5H7l3-5H7z"/></svg>',
    general:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a7 7 0 0 0-7 7c0 4.6 7 11 7 11s7-6.4 7-11a7 7 0 0 0-7-7zm0 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  };
  return icons[category] || icons.general;
}

function renderSpeciesList(species) {
  const template = document.getElementById('plant-item-template');
  plantsList.innerHTML = '';

  species.forEach((plant) => {
    const fragment = template.content.cloneNode(true);
    const checkbox = fragment.querySelector('input');
    const commonName = fragment.querySelector('.common-name');
    const scientificName = fragment.querySelector('.scientific-name');
    const details = fragment.querySelector('.details');
    const image = fragment.querySelector('.plant-thumb');
    const imageWrap = fragment.querySelector('.plant-thumb-wrap');

    checkbox.checked = appState.collectedIds.has(plant.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        appState.collectedIds.add(plant.id);
        addVaultBatch(plant, new Date().getFullYear());
      } else {
        appState.collectedIds.delete(plant.id);
      }
      localStorage.setItem('collectedSpecies', JSON.stringify([...appState.collectedIds]));
      refreshProgress();
      renderVaultCards();
    });

    commonName.textContent = plant.commonName || plant.name;
    scientificName.textContent = plant.scientificName || 'Scientific name unavailable';
    details.textContent = seedPhaseText(plant.month);

    if (plant.imageUrl) {
      image.src = plant.imageUrl;
      image.alt = `${plant.commonName || plant.name} reference photo`;
    } else {
      imageWrap.classList.add('no-image');
      image.alt = 'No photo available';
    }

    plantsList.appendChild(fragment);
  });
}

function renderTrailsList(trails) {
  trailsList.innerHTML = '';
  trails.forEach((trail) => {
    const li = document.createElement('li');
    li.className = 'trail-item';

    const title = document.createElement('h4');
    title.className = 'trail-name';
    title.textContent = trail.name;
    li.appendChild(title);

    const summary = document.createElement('p');
    summary.className = 'small';
    summary.textContent = `${trail.matchedPlants.length} likely plants • ${trail.seedingNowCount} seeding now • ${trail.scopeLabel}`;
    li.appendChild(summary);

    if (!trail.matchedPlants.length) {
      const empty = document.createElement('p');
      empty.className = 'small';
      empty.textContent = 'No high-confidence plant matches near this hike yet.';
      li.appendChild(empty);
      trailsList.appendChild(li);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'trail-plant-list';
    trail.matchedPlants.forEach((plant) => {
      const item = document.createElement('li');
      item.className = 'trail-plant-item';

      if (plant.imageUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'trail-plant-thumb';
        thumb.src = plant.imageUrl;
        thumb.loading = 'lazy';
        thumb.referrerPolicy = 'no-referrer';
        thumb.alt = `${plant.commonName || plant.name} reference photo`;
        item.appendChild(thumb);
      }

      const textWrap = document.createElement('div');
      const name = document.createElement('p');
      name.className = 'trail-plant-name';
      name.textContent = `${plant.commonName || plant.name} (${formatDistance(plant.distanceKm)})`;
      textWrap.appendChild(name);

      const badge = document.createElement('span');
      badge.className = `match-badge ${plant.confidenceClass}`;
      badge.textContent = plant.confidenceLabel;
      textWrap.appendChild(badge);

      const detail = document.createElement('p');
      detail.className = 'small';
      detail.textContent = `${seedPhaseText(plant.month)} • ${plant.scientificName || 'Scientific name unavailable'}`;
      textWrap.appendChild(detail);

      item.appendChild(textWrap);
      list.appendChild(item);
    });

    li.appendChild(list);
    trailsList.appendChild(li);
  });
}

function attachPlantMatchesToTrails(trails, species) {
  return trails.map((trail) => {
    const candidates = species
      .map((plant) => {
        const distanceKm = haversine(trail.lat, trail.lon, plant.lat, plant.lon);
        const confidence = getMatchConfidence(plant, distanceKm);
        return {
          ...plant,
          distanceKm,
          confidenceLabel: confidence.label,
          confidenceClass: confidence.className,
          matchScore: scoreTrailPlantMatch(plant, distanceKm),
        };
      })
      .sort((a, b) => b.matchScore - a.matchScore);

    let matchedPlants = candidates.filter((plant) => plant.distanceKm <= TRAIL_PLANT_RADIUS_KM);
    let scopeLabel = `within ${TRAIL_PLANT_RADIUS_KM} km`;

    if (!matchedPlants.length) {
      matchedPlants = candidates.filter((plant) => plant.distanceKm <= TRAIL_PLANT_EXPANDED_RADIUS_KM);
      scopeLabel = `expanded to ${TRAIL_PLANT_EXPANDED_RADIUS_KM} km`;
    }

    if (!matchedPlants.length) {
      matchedPlants = candidates.slice(0, 3);
      scopeLabel = 'nearest regional observations';
    }

    matchedPlants = matchedPlants
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, MAX_PLANTS_PER_TRAIL);

    const seedingNowCount = matchedPlants.filter((plant) => GENERAL_SEEDING_MONTHS.includes(plant.month)).length;
    return { ...trail, matchedPlants, seedingNowCount, scopeLabel };
  });
}

function scoreTrailPlantMatch(plant, distanceKm) {
  const distanceScore = Math.max(0, TRAIL_PLANT_EXPANDED_RADIUS_KM - distanceKm) * 2;
  const seedingScore = GENERAL_SEEDING_MONTHS.includes(plant.month) ? 2 : 0;
  const imageScore = plant.imageUrl ? 1 : 0;
  return distanceScore + seedingScore + imageScore;
}

function getMatchConfidence(plant, distanceKm) {
  const isSeedingNow = GENERAL_SEEDING_MONTHS.includes(plant.month);
  if (distanceKm <= 3 && isSeedingNow) {
    return { label: 'High confidence', className: 'high' };
  }
  if (distanceKm <= 8 || (distanceKm <= 12 && isSeedingNow)) {
    return { label: 'Medium confidence', className: 'medium' };
  }
  return { label: 'Low confidence', className: 'low' };
}

function formatDistance(distanceKm) {
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTrailPlantsSummary(trail, maxItems) {
  if (!trail.matchedPlants?.length) {
    return {
      countText: 'No nearby plant matches',
      scopeText: '',
      itemsText: 'Try another trail pin or broaden species filters.',
    };
  }

  const itemsText = trail.matchedPlants
    .slice(0, maxItems)
    .map(
      (plant) =>
        `• ${plant.commonName || plant.name} (${formatDistance(plant.distanceKm)}) - ${seedPhaseText(plant.month)} - ${plant.confidenceLabel}`,
    )
    .join('<br>');

  return {
    countText: `${trail.matchedPlants.length} likely plants • ${trail.seedingNowCount} seeding now`,
    scopeText: trail.scopeLabel,
    itemsText,
  };
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
  const speciesById = new Map(appState.species.map((plant) => [plant.id, plant]));
  const grouped = groupVaultBatchesBySpecies(speciesById);
  const storageHealth = computeStorageHealth(Number(tempInput.value), Number(humidityInput.value));

  vaultCards.replaceChildren();
  if (!grouped.length) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'small';
    emptyMessage.textContent = 'Collect and verify seeds on the Bio-Map to generate personalized storage cards.';
    vaultCards.appendChild(emptyMessage);
    return;
  }

  grouped.forEach((group) => {
    const plant = group.plant;
    const card = document.createElement('article');
    card.className = 'card vault-card';
    const matchedRule = speciesStorageRules.find((rule) => rule.pattern.test(plant.name));

    const year = new Date().getFullYear();
    const title = document.createElement('h4');
    title.textContent = plant.name;
    card.appendChild(title);

    const scientificName = document.createElement('p');
    scientificName.className = 'small vault-sci';
    scientificName.textContent = plant.scientificName || 'Scientific name unavailable';
    card.appendChild(scientificName);

    const rack = document.createElement('div');
    rack.className = 'seed-rack';
    const newestBatch = group.batches[0];
    const summaryViability = computeBatchViability(newestBatch.year, storageHealth, year);
    rack.innerHTML = buildSeedVialSvg(summaryViability, `Primary batch '${String(newestBatch.year).slice(-2)}`);
    card.appendChild(rack);

    const actions = document.createElement('div');
    actions.className = 'vault-actions';
    const addBatchBtn = document.createElement('button');
    addBatchBtn.type = 'button';
    addBatchBtn.className = 'small';
    addBatchBtn.textContent = 'Add Batch Year';
    addBatchBtn.addEventListener('click', () => {
      const entered = window.prompt(`Add collection year for ${plant.name}`, String(year));
      if (!entered) return;
      const parsedYear = Number(entered.trim());
      if (!Number.isInteger(parsedYear) || parsedYear < 1950 || parsedYear > year + 1) {
        window.alert('Enter a valid 4-digit year.');
        return;
      }
      addVaultBatch(plant, parsedYear);
      renderVaultCards();
    });
    actions.appendChild(addBatchBtn);
    card.appendChild(actions);

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

    const cycles = document.createElement('details');
    cycles.className = 'life-cycles';
    const summary = document.createElement('summary');
    summary.textContent = `${group.batches.length} life cycle${group.batches.length > 1 ? 's' : ''}`;
    cycles.appendChild(summary);

    const cycleList = document.createElement('div');
    cycleList.className = 'cycle-list';

    group.batches.forEach((batch) => {
      const viability = computeBatchViability(batch.year, storageHealth, year);
      const batchCard = document.createElement('div');
      batchCard.className = `batch-card ${viability < 0.3 ? 'at-risk' : ''}`;

      const batchTag = document.createElement('span');
      batchTag.className = 'batch-tag';
      batchTag.textContent = `'${String(batch.year).slice(-2)}`;
      batchCard.appendChild(batchTag);

      const vialWrap = document.createElement('div');
      vialWrap.className = 'batch-vial';
      vialWrap.innerHTML = buildSeedVialSvg(viability, `${plant.name} ${batch.year}`);
      batchCard.appendChild(vialWrap);

      const batchMeta = document.createElement('p');
      batchMeta.className = 'small';
      batchMeta.textContent = `Collected ${batch.year} • Viability ${Math.round(viability * 100)}%`;
      batchCard.appendChild(batchMeta);

      cycleList.appendChild(batchCard);
    });

    cycles.appendChild(cycleList);
    card.appendChild(cycles);

    vaultCards.appendChild(card);
  });
}

function groupVaultBatchesBySpecies(speciesById) {
  const groups = new Map();
  appState.vaultBatches.forEach((batch) => {
    const plant = speciesById.get(batch.speciesId) || {
      id: batch.speciesId,
      name: batch.speciesName || 'Unknown plant',
      scientificName: batch.scientificName || '',
      commonName: batch.speciesName || 'Unknown plant',
    };
    if (!groups.has(batch.speciesId)) {
      groups.set(batch.speciesId, { plant, batches: [] });
    }
    groups.get(batch.speciesId).batches.push(batch);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      batches: group.batches.sort((a, b) => b.year - a.year),
    }))
    .sort((a, b) => a.plant.name.localeCompare(b.plant.name));
}

function addVaultBatch(plant, year) {
  const exists = appState.vaultBatches.some((batch) => batch.speciesId === plant.id && batch.year === year);
  if (exists) return;

  appState.vaultBatches.push({
    speciesId: plant.id,
    speciesName: plant.commonName || plant.name,
    scientificName: plant.scientificName || '',
    year,
  });
  localStorage.setItem('seedVaultBatches', JSON.stringify(appState.vaultBatches));
}

function computeBatchViability(batchYear, storageHealth, currentYear = new Date().getFullYear()) {
  const ageYears = Math.max(0, currentYear - batchYear);
  const ageFactor = Math.max(0, 1 - ageYears / DEFAULT_VIABILITY_YEARS);
  return Math.max(0, Math.min(1, ageFactor * (0.45 + storageHealth * 0.55)));
}

function computeStorageHealth(temp, humidity) {
  const total = temp + humidity;
  const health = (STORAGE_HEALTH_MAX_SUM - total) / (STORAGE_HEALTH_MAX_SUM - STORAGE_HEALTH_MIN_SUM);
  return Math.max(0, Math.min(1, health));
}

function applyVaultAtmosphere(storageHealth) {
  const parched = 1 - storageHealth;
  document.documentElement.style.setProperty('--vault-health', storageHealth.toFixed(3));
  document.documentElement.style.setProperty('--vault-parched', parched.toFixed(3));
  if (!vaultSection) return;
  vaultSection.style.setProperty('--vault-health', storageHealth.toFixed(3));
  vaultSection.style.setProperty('--vault-parched', parched.toFixed(3));
}

function buildSeedVialSvg(viability, label) {
  const clamped = Math.max(0, Math.min(1, viability));
  seedVialIdCounter += 1;
  const clipId = `vial-fill-shape-${seedVialIdCounter}`;
  const hue = Math.round(clamped * 120);
  const fluidColor = `hsl(${hue}, 80%, 55%)`;
  const glowStrength = 4 + clamped * 10;
  const fluidHeight = 76 * clamped;
  const fluidY = 100 - fluidHeight;

  return `
    <svg class="seed-vial" viewBox="0 0 70 150" role="img" aria-label="${escapeHtmlAttribute(label)}">
      <defs>
        <clipPath id="${clipId}">
          <rect x="20" y="24" width="30" height="80" rx="12" />
        </clipPath>
      </defs>
      <rect x="26" y="8" width="18" height="16" rx="4" class="vial-cap" />
      <rect x="20" y="24" width="30" height="80" rx="12" class="vial-glass" />
      <rect x="20" y="${fluidY}" width="30" height="${fluidHeight}" fill="${fluidColor}" clip-path="url(#${clipId})" style="filter: drop-shadow(0 0 ${glowStrength}px ${fluidColor});" />
      <rect x="20" y="24" width="30" height="80" rx="12" class="vial-outline" />
      <text x="35" y="130" text-anchor="middle" class="vial-percent">${Math.round(clamped * 100)}%</text>
    </svg>
  `;
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
applyVaultAtmosphere(computeStorageHealth(Number(tempInput.value), Number(humidityInput.value)));
renderVaultCards();
