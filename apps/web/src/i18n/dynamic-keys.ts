/**
 * Key prefixes the app assembles at run time (`tDynamic(\`audit.action.${action}\`)`), so the
 * catalog test does not report their keys as unused. Keep each prefix as narrow as the lookup.
 */
export const DYNAMIC_KEY_PREFIXES: readonly string[] = [];
