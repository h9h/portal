import { verifyAccessToken } from "./tokens";

export function getAuthenticatedUserId(req: Request, secret: string): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  const payload = verifyAccessToken(token, secret);
  return payload?.sub ?? null;
}
