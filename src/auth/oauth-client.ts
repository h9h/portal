import type { OAuthProviderConfig } from "./providers";
import type { ProviderProfile } from "./users";

export function buildAuthorizeUrl(provider: OAuthProviderConfig, state: string, redirectUri: string): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(
  provider: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const response = await fetchFn(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed with status ${response.status}`);
  const json = (await response.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`Token exchange response missing access_token: ${json.error ?? "unknown error"}`);
  return json.access_token;
}

export async function fetchUserProfile(
  provider: OAuthProviderConfig,
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<ProviderProfile> {
  const response = await fetchFn(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Fetching user profile failed with status ${response.status}`);
  const json = await response.json();
  return provider.mapProfile(json);
}
