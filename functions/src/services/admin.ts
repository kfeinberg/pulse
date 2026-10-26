export interface AdminToken {
  email?: unknown;
  email_verified?: unknown;
}
const ADMIN_EMAIL = "kalli.feinberg@gmail.com";

export function isAdminToken(token: AdminToken | undefined): boolean {
  return token?.email === ADMIN_EMAIL && token.email_verified === true;
}

// Accept only an SDK-verified Firebase ID token, never an email supplied in
// query parameters or request data. Verification is injectable for fixtures.
export async function authorizeAdminHeader(
  header: string | undefined,
  verify: (token: string) => Promise<AdminToken>
): Promise<boolean> {
  const bearer = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!bearer) return false;
  try { return isAdminToken(await verify(bearer)); }
  catch { return false; }
}
