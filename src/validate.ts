// Shared boundary gate for free-form string fields (Phase 8). Two classes of
// input pass a typeof check but cannot be stored faithfully:
//   - U+0000: Postgres rejects it in text and jsonb, so it died at INSERT as
//     a fail-closed 500 instead of the pinned 400.
//   - An unpaired UTF-16 surrogate: worse than a 500 — Node's UTF-8 encoder
//     silently mutates it to U+FFFD on the wire to Postgres, so two distinct
//     idempotency keys ('a\uD800b', 'a\uD801b') collapse into one stored key.
// Every validated free-form string on the body routes must pass this gate
// before it can reach an INSERT.
export function isCleanString(s: string): boolean {
  return !s.includes('\u0000') && s.isWellFormed()
}
