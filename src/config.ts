/** Shared settings: where the app runs and the roles every access check iterates over. */

/** The local Juice Shop container from scripts/juice-shop.ts. Override with BASE_URL; never point it at a public site. */
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

/** Roles the product supports, plus a caller with no session. */
export const ROLES = ['anonymous', 'customer', 'deluxe', 'accounting', 'admin'] as const;
export type Role = (typeof ROLES)[number];
