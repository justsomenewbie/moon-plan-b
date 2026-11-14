type Raster = { width: number; height: number; data: Uint8ClampedArray };

export function globeCenter(longitude: number, latitude: number) {
  return { longitude: ((longitude + 180) % 360 + 360) % 360 - 180, latitude: Math.max(-90, Math.min(90, latitude)) };
}

// Inverse orthographic projection of a north-up, zero-meridian-centered color map.
export function drawGlobe(texture: Raster, frame: Raster, longitude: number, latitude: number, zoom = 1) {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const { width: w, height: h, data: pixels } = texture;
  const radius = zoom * Math.min(frame.width, frame.height) / 2;
  for (let row = 0; row < frame.height; row++) {
    const y = (frame.height / 2 - row - 0.5) / radius;
    for (let col = 0; col < frame.width; col++) {
      const x = (col + 0.5 - frame.width / 2) / radius;
      const depth = 1 - x * x - y * y;
      const output = 4 * (row * frame.width + col);
      if (depth < 0) { frame.data[output + 3] = 0; continue; }
      const z = Math.sqrt(depth);
      const u = 0.5 + (lon + Math.atan2(x, z * cosLat - y * sinLat)) / (2 * Math.PI);
      const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, y * cosLat + z * sinLat))) / Math.PI;
      const tx = (u - Math.floor(u)) * w - 0.5;
      const ty = Math.max(0, Math.min(h - 1, v * h - 0.5));
      const x0 = (Math.floor(tx) + w) % w, x1 = (x0 + 1) % w;
      const y0 = Math.floor(ty), y1 = Math.min(y0 + 1, h - 1);
      const fx = tx - Math.floor(tx), fy = ty - y0;
      // Fixed studio shading describes curvature. It carries no observation-time data.
      const shade = 0.64 + 0.36 * z;
      for (let channel = 0; channel < 3; channel++) {
        const top = pixels[4 * (y0 * w + x0) + channel] * (1 - fx) + pixels[4 * (y0 * w + x1) + channel] * fx;
        const bottom = pixels[4 * (y1 * w + x0) + channel] * (1 - fx) + pixels[4 * (y1 * w + x1) + channel] * fx;
        frame.data[output + channel] = (top * (1 - fy) + bottom * fy) * shade;
      }
      frame.data[output + 3] = 255;
    }
  }
}
