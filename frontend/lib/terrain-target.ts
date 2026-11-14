export const defaultTerrainSites = "im1_odysseus,im2_athena";
export type TerrainTarget = { run_id: string } & (
  { site_id?: string; site_ids?: never } | { site_ids: string; site_id?: never }
);

function validSite(id: string) {
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(id);
}

export function terrainSiteIds(target?: TerrainTarget): string {
  if (!target) return defaultTerrainSites;
  if (typeof target.run_id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(target.run_id))
    throw new Error("This run link requires a live backend and a valid model run ID.");
  if (target.site_ids !== undefined) {
    const ids = typeof target.site_ids === "string" && target.site_ids.length <= 129 ? target.site_ids.split(",") : [];
    if (target.site_id !== undefined || ids.length !== 2 || ids[0] === ids[1] || !ids.every(validSite))
      throw new Error("Two distinct sites from this run are needed for a pair comparison.");
    return target.site_ids;
  }
  if (target.site_id !== undefined && !validSite(target.site_id))
    throw new Error("The shared site requires a model run and a valid site ID.");
  return target.site_id ?? defaultTerrainSites;
}

export function readTerrainTarget(params: URLSearchParams): TerrainTarget | undefined {
  for (const key of ["run_id", "site_id", "site_ids"]) {
    if (params.getAll(key).length > 1) throw new Error("The shared request contains duplicate fields.");
  }
  const run_id = params.get("run_id"), site_id = params.get("site_id"), site_ids = params.get("site_ids");
  if (run_id === null) {
    if (site_id !== null || site_ids !== null) throw new Error("The shared site requires a model run and a valid site ID.");
    return undefined;
  }
  if (site_id !== null && site_ids !== null) throw new Error("Two distinct sites from this run are needed for a pair comparison.");
  const target = site_ids !== null ? { run_id, site_ids } : site_id !== null ? { run_id, site_id } : { run_id };
  terrainSiteIds(target);
  return target;
}

export function writeTerrainTarget(params: URLSearchParams, target: TerrainTarget) {
  terrainSiteIds(target);
  params.set("run_id", target.run_id);
  params.delete("site_id");
  params.delete("site_ids");
  if (target.site_ids !== undefined) params.set("site_ids", target.site_ids);
  if (target.site_id !== undefined) params.set("site_id", target.site_id);
}
