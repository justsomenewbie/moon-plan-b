// Sector boundaries follow the producer's clockwise 16-point compass.
const headings = [
  "north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast",
  "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest",
] as const;

export function compassHeading(bearing: number) {
  return headings[Math.round(bearing / 22.5) % 16];
}
