export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

/** Roles the product supports, plus a caller with no session. */
export const ROLES = ['anonymous', 'customer', 'deluxe', 'accounting', 'admin'] as const;
export type Role = (typeof ROLES)[number];
