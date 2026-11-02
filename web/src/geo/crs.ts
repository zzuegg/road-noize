import proj4 from 'proj4'
import { register } from 'ol/proj/proj4'
import { get as getProjection } from 'ol/proj'

export const UTM32N = 'EPSG:25832'
proj4.defs(UTM32N, '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')
register(proj4)
getProjection(UTM32N)?.setExtent([166021, 0, 833978, 9329005])

export function toLonLat(e: number, n: number): [number, number] {
  return proj4(UTM32N, 'EPSG:4326', [e, n]) as [number, number]
}
