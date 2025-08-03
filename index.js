require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const matrixCache = new Map();
const placesCache = new Map();
const BATCH_SIZE = 25;

app.get('/geocode', async (req, res) => {
  const address = req.query.address;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch location data' });
  }
});

app.get('/drinks', async (req, res) => {
  try {
    const { lat, lng, range = 1 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: "Missing location parameters" });

    console.log("\n==============================");
    console.log(`📥 NEW REQUEST: /drinks`);
    console.log(`➡️ Location: lat=${lat}, lng=${lng}`);
    console.log(`➡️ Range: ${range} km`);

    const radius = 10000; // max 10 km
    const maxDistance = parseFloat(range) * 1000;

    const placeTypes = ["bar", "pub", "night_club"];
    const placesCacheKey = `${lat},${lng}`;
    const matrixCacheKey = placesCacheKey;

    // Jeśli jest cache, zwracaj od razu wyniki filtrowane po range
    if (placesCache.has(placesCacheKey) && matrixCache.has(matrixCacheKey)) {
      console.log("⚡ Using cached data - responding immediately");

      const cachedPlaces = placesCache.get(placesCacheKey).results;
      const cachedMatrix = matrixCache.get(matrixCacheKey);

      const filtered = cachedPlaces
        .map((bar, i) => {
          const element = cachedMatrix.elements[i];
          if (!element || element.status !== "OK") return null;
          return {
            name: bar.name,
            address: bar.vicinity,
            type: bar.types?.[0] || null,
            rating: bar.rating || null,
            total_ratings: bar.user_ratings_total || null,
            price_level: bar.price_level ? "$".repeat(bar.price_level) : null,
            place_id: bar.place_id,
            location: bar.geometry.location,
            distance: element.distance.text,
            duration: element.duration.text,
            distanceValue: element.distance.value
          };
        })
        .filter(bar => bar && bar.distanceValue <= maxDistance)
        .sort((a, b) => a.distanceValue - b.distanceValue);

      res.json(filtered);

      // Asynchroniczne odświeżanie cache w tle (nie blokuje klienta)
      (async () => {
        try {
          console.log("⏳ Async cache refresh started");

          const newPlaces = await fetchAllPlaces(lat, lng, radius, placeTypes);
          placesCache.set(placesCacheKey, { results: newPlaces.allBars });
          setTimeout(() => placesCache.delete(placesCacheKey), 86_400_000);

          const destinations = newPlaces.allBars.map(bar => `${bar.geometry.location.lat},${bar.geometry.location.lng}`);

          let allElements = [];
          for (let i = 0; i < destinations.length; i += BATCH_SIZE) {
            const batch = destinations.slice(i, i + BATCH_SIZE);
            const matrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${batch.join('|')}&mode=walking&key=${process.env.GOOGLE_API_KEY}`;
            const response = await fetch(matrixUrl);
            const data = await response.json();
            if (data.status === "OK") {
              allElements = allElements.concat(data.rows[0].elements);
            } else {
              console.error("❌ Distance Matrix API error during async refresh:", data);
            }
            // Możesz dać małą przerwę jeśli chcesz (np. await new Promise(r => setTimeout(r, 100)); )
          }

          matrixCache.set(matrixCacheKey, { elements: allElements });
          setTimeout(() => matrixCache.delete(matrixCacheKey), 86_400_000);

          console.log("✅ Async cache refresh finished");
        } catch (e) {
          console.error("❌ Async cache refresh error", e);
        }
      })();

      return;
    }

    // Jeśli brak cache - wykonaj pełne fetchowanie i odpowiedź

    console.log("🌐 No cache - fetching fresh data...");

    const newPlaces = await fetchAllPlaces(lat, lng, radius, placeTypes);
    const allBars = newPlaces.allBars;
    const totalPlacesRequests = newPlaces.totalRequests;

    console.log(`📊 FOUND ${allBars.length} places (from ${placeTypes.join(", ")})`);
    console.log(`📡 Places API requests sent: ${totalPlacesRequests}`);

    if (!allBars.length) {
      console.log("❌ No places found.");
      console.log("==============================\n");
      return res.json([]);
    }

    const destinations = allBars.map(bar => `${bar.geometry.location.lat},${bar.geometry.location.lng}`);

    let allElements = [];
    let distanceMatrixRequests = 0;

    for (let i = 0; i < destinations.length; i += BATCH_SIZE) {
      const batch = destinations.slice(i, i + BATCH_SIZE);
      console.log(`➡️ Distance Matrix batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} destinations`);
      const matrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${batch.join('|')}&mode=walking&key=${process.env.GOOGLE_API_KEY}`;
      const response = await fetch(matrixUrl);
      const data = await response.json();
      distanceMatrixRequests++;

      if (data.status !== "OK") {
        console.log("❌ Distance Matrix API error:", data);
        console.log("==============================\n");
        return res.status(400).json({
          error: "Distance Matrix API error",
          details: data.error_message || "Unknown error"
        });
      }

      allElements = allElements.concat(data.rows[0].elements);
    }

    matrixCache.set(matrixCacheKey, { elements: allElements });
    setTimeout(() => matrixCache.delete(matrixCacheKey), 86_400_000);

    console.log(`📡 Distance Matrix API requests: ${distanceMatrixRequests}`);

    const results = allBars
      .map((bar, i) => {
        const element = allElements[i];
        if (!element || element.status !== "OK") return null;

        return {
          name: bar.name,
          address: bar.vicinity,
          type: bar.types?.[0] || null,
          rating: bar.rating || null,
          total_ratings: bar.user_ratings_total || null,
          price_level: bar.price_level ? "$".repeat(bar.price_level) : null,
          place_id: bar.place_id,
          location: bar.geometry.location,
          distance: element.distance.text,
          duration: element.duration.text,
          distanceValue: element.distance.value
        };
      })
      .filter(bar => bar && bar.distanceValue <= maxDistance)
      .sort((a, b) => a.distanceValue - b.distanceValue);

    console.log(`✅ Returning ${results.length} places sorted by distance`);
    console.log("==============================\n");

    // Cache zapisz też po pierwszym fetchu
    placesCache.set(placesCacheKey, { results: allBars });
    setTimeout(() => placesCache.delete(placesCacheKey), 86_400_000);

    matrixCache.set(matrixCacheKey, { elements: allElements });
    setTimeout(() => matrixCache.delete(matrixCacheKey), 86_400_000);

    res.json(results);

  } catch (error) {
    console.error("❌ Server error:", error);
    console.log("==============================\n");
    res.status(500).json({ error: "Internal server error" });
  }
});


/**
 * Pobiera wszystkie strony wyników Places API (do 60 miejsc na typ)
 * @param {string} lat 
 * @param {string} lng 
 * @param {number} radius 
 * @param {string[]} types 
 * @returns {Promise<{allBars: any[], totalRequests: number}>}
 */
async function fetchAllPlaces(lat, lng, radius, types) {
  let allResults = [];
  let totalRequests = 0;

  // fetchuj równolegle dla każdego typu
  const promises = types.map(async (type) => {
    let resultsForType = [];
    let pageToken = null;
    let attempts = 0;

    do {
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${process.env.GOOGLE_API_KEY}${pageToken ? `&pagetoken=${pageToken}` : ''}`;
      const response = await fetch(url);
      const data = await response.json();
      totalRequests++;

      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        console.error(`❌ Places API error for type ${type}:`, data);
        break;
      }

      if (data.results) {
        resultsForType = resultsForType.concat(data.results);
      }

      pageToken = data.next_page_token || null;
      if (pageToken) await new Promise(r => setTimeout(r, 2000)); // 2s przerwy przy paginacji

      attempts++;
    } while (pageToken && attempts < 3);

    return resultsForType;
  });

  const resultsArrays = await Promise.all(promises);
  resultsArrays.forEach(arr => allResults.push(...arr));

  return { allBars: allResults, totalRequests };
}

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server running locally at: http://localhost:${port}`);
  console.log(`🌐 Accessible on your network at: http://192.168.1.115:${port}`);
});
