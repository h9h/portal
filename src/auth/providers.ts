import type { ProviderProfile } from "./users";

export type OAuthProviderConfig = {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  mapProfile: (json: any) => ProviderProfile;
};

export function getProviders(env: NodeJS.ProcessEnv = process.env): Record<string, OAuthProviderConfig> {
  return {
    github: {
      name: "github",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      clientId: env.GITHUB_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
      scope: "read:user",
      mapProfile: (json: any) => ({
        providerUserId: String(json.id),
        email: json.email ?? null,
        displayName: json.name ?? json.login ?? null,
      }),
    },
  };
}
