// Orthographic view of local east, north and up, with the camera above the southern horizon at orbit 0°.
const radians = Math.PI / 180;
const tilt = 22 * radians;

export function skyPoint(azimuth: number, elevation: number, orbit: number) {
  const bearing = (azimuth - orbit) * radians;
  const altitude = elevation * radians;
  const east = Math.cos(altitude) * Math.sin(bearing);
  const north = Math.cos(altitude) * Math.cos(bearing);
  const up = Math.sin(altitude);
  return {
    x: east,
    y: -up * Math.cos(tilt) - north * Math.sin(tilt),
  };
}
