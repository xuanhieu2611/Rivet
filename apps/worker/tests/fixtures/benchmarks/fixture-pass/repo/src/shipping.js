export const HEAVY_PARCEL_KG = 5;
export const LIGHT_RATE = 5;
export const HEAVY_RATE = 12;

export function shippingCost(weightKg) {
  if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg < 0) {
    throw new TypeError("weightKg must be a non-negative finite number");
  }

  return weightKg > HEAVY_PARCEL_KG ? HEAVY_RATE : LIGHT_RATE;
}
