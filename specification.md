# Portal

Portal is a framework for building a web application, that supports context dependent views. Those views come from a microservice/self contained system architecture.

Portal delivers a few common capabilities:
- Login via a configurable set of OAuth 2 authorization servers, selected explicitly by the user (e.g. a "Sign in with GitHub" button). GitHub is the first supported provider; more can be added later without changing this model. Portal does not own user credentials — that stays with the chosen provider.
- Registration workflow: on a user's first successful login via a provider, Portal provisions a local profile for that identity and assigns initial role(s). There is no separate sign-up form and no Portal-owned password.
- Rights management
- all routes are secured and checked against the rights of the authenticated user
- rights are managed via roles
- navigation menu, dependent on rights and context

## Architecture

Portal is a backend-for-frontend that composes pages server-side from one or more self-contained systems (SCSs). It owns the shell, the OAuth2 login flow, route security, and the nav menu; each SCS owns its own domain logic, its own rights, and the fragments/views it contributes.

### Request flow

1. Portal resolves the current context (see below) for the incoming request.
2. Portal checks the target route's required role(s), from the relevant SCS's manifest, against the authenticated user's role assignments. If the user lacks the required role, Portal returns 403 without contacting the SCS.
3. If authorized, Portal calls the SCS(s) server-side to fetch the fragment(s) for that route/context, and composes them into the final response.

### SCS manifest contract

Each SCS exposes a manifest endpoint (`GET /.portal/manifest`) that Portal fetches at startup and periodically thereafter. The manifest declares, for that SCS:
- `name`: the SCS's identity, used for role namespacing (e.g. `orders` → roles like `orders:admin`)
- `routes`: the routes/fragments it serves, each with its required role(s)
- `nav`: the nav menu entries it contributes, each with its required role(s)

```json
{
  "name": "orders",
  "routes": [{ "path": "/orders", "requiredRoles": ["orders:viewer"] }],
  "nav": [{ "label": "Orders", "path": "/orders", "requiredRoles": ["orders:viewer"] }]
}
```

Portal has no built-in knowledge of any SCS's routes, nav entries, or roles beyond what the manifest declares — adding a new SCS means registering its manifest, not changing Portal's code. A nav entry's domain/context (see Context model below) is the owning SCS's own `name` — one SCS, one domain, for this stage; an SCS contributing to multiple domains is future scope if it turns out to be needed.

**Discovery**: Portal is configured with a static list of known SCS base URLs (e.g. `PORTAL_SCS_URLS`, comma-separated); it appends `/.portal/manifest` to each to fetch. Adding an SCS means adding it to this list, not building a self-registration mechanism (deferred as unnecessary complexity for this stage).

**Fetch and failure handling**: Portal fetches every configured SCS's manifest at startup and on a fixed refresh interval thereafter. A malformed response is treated the same as an unreachable SCS: Portal logs the failure, keeps serving the last-known-good manifest it has for that SCS (or nothing, if it has never successfully fetched one), and marks that SCS's data as stale. A transient failure in one SCS doesn't remove its routes or nav entries from users mid-session.

### Identity, sessions, and rights

- **Login**: user explicitly picks a provider (e.g. "Sign in with GitHub") from Portal's configured list of OAuth2 authorization servers. Portal acts as the OAuth2 client; it never sees or stores the provider's password.
- **Redirect URI**: the OAuth `redirect_uri` sent to the provider defaults to the incoming request's own origin, which is only correct for local/plain-HTTP development. In any deployment behind TLS or a reverse proxy, Portal's base URL must be configured explicitly (`PORTAL_BASE_URL`, or the `baseUrl` server option) so the registered callback matches what's actually sent — otherwise the provider will reject the exchange with a redirect URI mismatch.
- **First login**: Portal provisions a local profile linked to the provider identity, with no roles assigned by default.
- **Browser ↔ Portal**: after login, Portal issues its own bearer token (not the provider's token). The frontend stores it and sends it as `Authorization: Bearer …` on requests to Portal. Logout discards/invalidates this token; it is short-lived and reissued via a refresh flow rather than long-lived.
- **Portal → SCS**: for each request that needs an SCS fragment, Portal mints a short-lived signed internal token (JWT) carrying the user id and the user's roles for that SCS. The SCS verifies the signature; it does not need to know how the user originally authenticated.
- **Roles**: namespaced per SCS (e.g. `orders:admin`, `billing:viewer`), defined by each SCS via its manifest — no cross-SCS collisions, no central coordination of role names. Portal owns a central admin UI/API for assigning roles to users, but does not define what a role means; that's the owning SCS's responsibility.
- **Route enforcement**: always performed by Portal, before any SCS is called, using the manifest's declared required role(s) for the route.

### Context model

Context = the current SCS/domain (required), with an optional selected entity (e.g. a workspace or project) nested inside it. There is no tenant/organization concept — multi-tenancy was explicitly considered and deferred; Portal is single-tenant for now. The nav menu is the union of nav entries from every registered SCS's manifest, filtered to the entries whose required role the current user holds, and further scoped to the current domain/entity.

