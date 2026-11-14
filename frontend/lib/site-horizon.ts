export function usesSmoothSphere(site?: { horizonMethod?: string; demSource?: string }) {
  return site?.horizonMethod === "flat" && site.demSource?.startsWith("none:outside-") === true;
}
