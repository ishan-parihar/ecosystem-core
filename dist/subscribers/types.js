/**
 * Subscriber core: types and the storage adapter contract.
 *
 * The adapter is an interface rather than a Supabase client on purpose. The
 * package carries the state machine, the token rules and the suppression
 * policy; the application supplies the table. That keeps the package free of
 * `@supabase/supabase-js` and free of `$env`, while the duplicated surface
 * stays at roughly forty lines of glue per application.
 */
/** The statuses that must never receive another campaign. */
export const SUPPRESSED_STATUSES = ['bounced', 'complained'];
//# sourceMappingURL=types.js.map