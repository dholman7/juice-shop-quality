/**
 * Strips customer data and secrets from failure text before it leaves the machine.
 * Order matters: tokens before emails, since JWT payloads can contain an email.
 */
const RULES: [RegExp, string][] = [
  [/eyJ[\w-]+\.[\w-]*\.[\w-]*/g, '<jwt>'],
  [/Bearer\s+[\w.-]+/gi, 'Bearer <token>'],
  [/\b[0-9a-f]{32}\b/gi, '<hash>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<card-number>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/"(password|passwordRepeat|answer|totpSecret|secret|token)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"'],
];

export function redact(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
