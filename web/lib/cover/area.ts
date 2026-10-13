import { cellFromKey, cellFromLatLon, keyFromCellId } from '@cover/core/cells'

/**
 * The area cover is bought for: one square of the grid, about 5 km across. Its key is what goes on the public
 * record; the exact position it was found from goes no further than this module's caller.
 */
export interface Area {
  key: bigint
  /** Centre of the area. This, and never the exact position, is what the service is asked about. */
  lat: number
  lon: number
  bounds: { south: number; north: number; west: number; east: number }
  /** How the area is named to the person: a city, "where you are", or the simulator. */
  label: string
  source: 'location' | 'city' | 'simulator'
}

export interface City {
  name: string
  lat: number
  lon: number
}

/** Cities offered when a device cannot or may not share its position. Each stands for the area at its centre. */
export const CITIES: readonly City[] = [
  { name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
  { name: 'Kraków', lat: 50.0647, lon: 19.945 },
  { name: 'Wrocław', lat: 51.1079, lon: 17.0385 },
  { name: 'Gdańsk', lat: 54.352, lon: 18.6466 },
  { name: 'Poznań', lat: 52.4064, lon: 16.9252 },
  { name: 'Łódź', lat: 51.7592, lon: 19.456 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Prague', lat: 50.0755, lon: 14.4378 },
  { name: 'Vienna', lat: 48.2082, lon: 16.3738 },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { name: 'Lisbon', lat: 38.7223, lon: -9.1393 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
]

/** The area that contains a point. */
export function areaAt(lat: number, lon: number, source: Area['source'], label: string): Area {
  const cell = cellFromLatLon(lat, lon)
  return { key: keyFromCellId(cell.id), lat: cell.lat, lon: cell.lon, bounds: cell.bounds, label, source }
}

/** The area behind a key read from the chain. */
export function areaFromKey(key: bigint, source: Area['source'], label: string): Area {
  const cell = cellFromKey(key)
  return { key, lat: cell.lat, lon: cell.lon, bounds: cell.bounds, label, source }
}

export function cityArea(city: City): Area {
  return areaAt(city.lat, city.lon, 'city', `central ${city.name}`)
}

export type LocationFailure = 'denied' | 'unavailable' | 'unsupported'

export class LocationError extends Error {
  readonly reason: LocationFailure

  constructor(reason: LocationFailure) {
    super(`location ${reason}`)
    this.name = 'LocationError'
    this.reason = reason
  }
}

export interface ExactPosition {
  lat: number
  lon: number
  /** Metres. */
  accuracy: number
}

type Geolocator = Pick<Geolocation, 'getCurrentPosition'>

const PERMISSION_DENIED = 1

/**
 * Asks the device where it is, once.
 *
 * @throws LocationError saying whether the person refused, the device could not tell, or the browser has no
 * way to ask.
 */
export function locate(
  geolocation: Geolocator | undefined = globalThis.navigator?.geolocation,
  options: PositionOptions = { enableHighAccuracy: false, timeout: 15_000, maximumAge: 120_000 },
): Promise<ExactPosition> {
  if (!geolocation) return Promise.reject(new LocationError('unsupported'))
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => reject(new LocationError(error.code === PERMISSION_DENIED ? 'denied' : 'unavailable')),
      options,
    )
  })
}

/** The area around a position. The position itself is not kept. */
export function areaOf(position: Pick<ExactPosition, 'lat' | 'lon'>, label: string): Area {
  return areaAt(position.lat, position.lon, 'location', label)
}
