const EARTH_RADIUS_KM = 6371.0088
const KM_PER_DEGREE_LAT = 111.195

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Great-circle distance in kilometres. */
export function distanceKm(latA: number, lonA: number, latB: number, lonB: number): number {
  const dLat = radians(latB - latA)
  const dLon = radians(lonB - lonA)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Degrees of latitude and longitude that span `km` around a point at latitude `lat`. */
export function degreesForKm(km: number, lat: number): { lat: number; lon: number } {
  const latDegrees = km / KM_PER_DEGREE_LAT
  const shrink = Math.max(Math.cos(radians(Math.min(Math.abs(lat) + latDegrees, 89))), 0.01)
  return { lat: latDegrees, lon: Math.min(latDegrees / shrink, 180) }
}
