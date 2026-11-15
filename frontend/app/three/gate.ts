// The decorative 3D backdrop is skipped on devices or settings where it would cost more than it gives.
export type DeviceHints = { reducedMotion: boolean; saveData?: boolean; deviceMemory?: number };

export function allows3D({ reducedMotion, saveData, deviceMemory }: DeviceHints): boolean {
  if (reducedMotion || saveData) return false;
  return !(typeof deviceMemory === "number" && deviceMemory <= 2);
}

// Stars and motes scale with the viewport area so a phone draws far fewer points than a desktop.
export function particleCount(width: number, height: number, areaPerParticle: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round((width * height) / areaPerParticle)));
}
