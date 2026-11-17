/**
 * Strips customer data and secrets from failure text before it leaves the machine.
 * Runs on every failure before triage stores it, so neither the proposals file nor a model
 * prompt ever holds a token, email, password hash, or card number.
 * Order matters: tokens before emails, since JWT payloads can contain an email.
 */
const RULES: [RegExp, string][] = [
  // JWTs always start with eyJ (base64 of '{"').
  [/eyJ[\w-]+\.[\w-]*\.[\w-]*/g, '<jwt>'],
  [/Bearer\s+[\w.-]+/gi, 'Bearer <token>'],
  // Juice Shop stores passwords as 32-hex MD5 hashes.
  [/\b[0-9a-f]{32}\b/gi, '<hash>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<card-number>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  // Secret-looking JSON fields in request or response bodies quoted by an error.
  [/"(password|passwordRepeat|answer|totpSecret|secret|token)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"'],
];

export function redact(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
