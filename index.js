const express = require('express')
const dotenv = require('dotenv')
const app = express()
const port = 3000

dotenv.config()
const API_KEY = process.env.GOOGLE_API_KEY

async function getWalkingRoute(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&mode=walking&key=${API_KEY}`
  const res = await fetch(url)
  const data = await res.json()

  if (data.status !== "OK" || !data.routes.length) return null

  const leg = data.routes[0].legs[0]
  return {
    distance: leg.distance.text,
    distanceValue: leg.distance.value,
    duration: leg.duration.text,
  }
}

app.get('/bars', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 39.4699
    const lng = parseFloat(req.query.lng) || -0.3763
    const rangeKm = Math.min(Math.max(parseInt(req.query.range) || /*5,*/ /*<- value given by user (to change after frontend)*/ 1), 10)
    const initialRadiusMeters = 10000

    const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${initialRadiusMeters}&type=bar|night_club&key=${API_KEY}`

    const placesResponse = await fetch(placesUrl)
    const placesData = await placesResponse.json()

    if (placesData.status !== "OK") {
      return res.status(500).json({ error: `Google Places API error: ${placesData.status}`, details: placesData.error_message })
    }

    const filteredPlaces = placesData.results.filter(place => place.rating >= 4)
    const origin = { lat, lng }

    const barsWithinRange = []

    for (const place of filteredPlaces) {
      const destination = place.geometry.location
      const walkingRoute = await getWalkingRoute(origin, destination)

      if (walkingRoute && walkingRoute.distanceValue <= rangeKm * 1000) {
        barsWithinRange.push({
          name: place.name,
          address: place.vicinity,
          rating: place.rating,
          total_ratings: place.user_ratings_total,
          price_level: place.price_level ? "$".repeat(place.price_level) : "N/A",
          place_id: place.place_id,
          location: destination,
          walking_distance: walkingRoute.distance,
          walking_duration: walkingRoute.duration,
        })
      }
    }

    res.json(barsWithinRange)

  } catch (error) {
    console.error('Error fetching bars:', error)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.listen(port, () => {
  console.log(`Drinkini location service running on http://localhost:${port}`)
})
