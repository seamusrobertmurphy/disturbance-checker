import { EE_SCOPES, FALLBACK_OAUTH_CLIENT_ID } from "../defaults";

// Minimal structural type for the parts of the Earth Engine JS client used here.
// The published package ships no TypeScript definitions.
export interface EarthEngineApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * The parts of the client's auth surface this module depends on, recorded here
 * because the published package ships no types and the sixth argument to
 * authenticateViaOauth is undocumented.
 *
 *   authenticateViaOauth(
 *     clientId, onSuccess, onFailure,
 *     extraScopes, onImmediateFailed, suppressDefaultScopes)
 *
 * Internally it calls mergeAuthScopes_(!suppressDefaultScopes, false,
 * extraScopes), so passing true for the last argument is the only way to stop
 * DEFAULT_AUTH_SCOPES_ (earthengine, cloud-platform, drive) being requested.
 */
export type AuthenticateViaOauth = (
  clientId: string,
  onSuccess: () => void,
  onFailure: (error: unknown) => void,
  extraScopes?: string[],
  onImmediateFailed?: () => void,
  suppressDefaultScopes?: boolean,
) => void;

let cached: EarthEngineApi | null = null;
let initialisedProject: string | null = null;

/**
 * Access token lifetime. Google issues one hour for this flow and does not
 * report the value back through the JS client's public surface, so the session
 * clock is anchored on the moment authentication succeeded.
 */
export const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** Stop treating a session as usable slightly before the token actually dies. */
const EXPIRY_MARGIN_MS = 60 * 1000;

let authenticatedAt: number | null = null;

export function sessionExpiresAt(): number | null {
  return authenticatedAt === null ? null : authenticatedAt + TOKEN_LIFETIME_MS;
}

export function sessionRemainingMs(now: number): number {
  const expiry = sessionExpiresAt();
  if (expiry === null) return 0;
  return Math.max(0, expiry - now);
}

export function isSessionExpired(now: number): boolean {
  const expiry = sessionExpiresAt();
  if (expiry === null) return true;
  return now >= expiry - EXPIRY_MARGIN_MS;
}

export function clearSession(): void {
  authenticatedAt = null;
  initialisedProject = null;
}

export async function loadEarthEngine(): Promise<EarthEngineApi> {
  if (cached) return cached;
  const module = (await import("@google/earthengine")) as Record<string, unknown>;
  const resolved =
    (module.default as EarthEngineApi | undefined) ??
    (module.ee as EarthEngineApi | undefined) ??
    ((globalThis as Record<string, unknown>).ee as EarthEngineApi | undefined) ??
    (module as unknown as EarthEngineApi);
  if (!resolved || typeof resolved.initialize !== "function") {
    throw new Error("The Earth Engine client failed to load.");
  }
  cached = resolved;
  return resolved;
}

/**
 * Google OAuth client IDs always end in `.apps.googleusercontent.com`. Checking
 * that lets an obviously wrong value be ignored rather than passed to the auth
 * library, which accepts it and then never calls back, leaving the panel stuck
 * on "Signing in to Earth Engine" forever. A pasted placeholder such as
 * YOUR_CLIENT_ID is the common case.
 */
export function isLikelyOauthClientId(value: string): boolean {
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(value.trim());
}

/** Set when a supplied client ID was rejected, so the panel can say why. */
let rejectedClientId: string | null = null;

export function rejectedClientIdValue(): string | null {
  return rejectedClientId;
}

export function resolveOauthClientId(): string {
  rejectedClientId = null;

  const candidates: string[] = [];
  const fromUrl = new URLSearchParams(window.location.search).get("gee_client_id");
  if (fromUrl && fromUrl.trim()) candidates.push(fromUrl.trim());
  const fromEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env
    ?.VITE_GEE_OAUTH_CLIENT_ID;
  if (typeof fromEnv === "string" && fromEnv.trim()) candidates.push(fromEnv.trim());

  for (const candidate of candidates) {
    if (isLikelyOauthClientId(candidate)) return candidate;
    rejectedClientId = candidate;
  }

  return FALLBACK_OAUTH_CLIENT_ID;
}

/**
 * Resolution order for the Cloud project, mirroring GeoLibre's own
 * earth-engine-auth.ts so a deployment can pin it without a rebuild.
 */
export function resolveProjectId(fallback: string): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("ee_project_id");
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  const fromEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env
    ?.VITE_GEE_PROJECT_ID;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const stored = window.localStorage.getItem("tuvsud.disturbance.eeProjectId");
  if (stored && stored.trim()) return stored.trim();
  return fallback;
}

export function rememberProjectId(projectId: string): void {
  try {
    window.localStorage.setItem("tuvsud.disturbance.eeProjectId", projectId);
  } catch {
    // Private browsing blocks localStorage. The project ID stays in memory.
  }
}

export function currentUserEmail(ee: EarthEngineApi): string | null {
  try {
    const token = ee.data?.getAuthToken?.();
    if (!token) return null;
    // The client does not expose the profile. Presence of a token is all that
    // can be reported without an extra userinfo request.
    return "signed in";
  } catch {
    return null;
  }
}

/**
 * Resolve the Earth Engine client ahead of time.
 *
 * Sign-in ends in a popup, and browsers only allow a popup inside the gesture
 * that triggered it. Safari is the strictest. Loading the 1.7 MB client lazily
 * at sign-in time puts an await between the click and the popup, which is long
 * enough for the gesture to lapse and the popup to be suppressed silently.
 * Calling this when the panel mounts means the click reaches the popup with
 * nothing async in between.
 */
export function preloadEarthEngine(): void {
  void loadEarthEngine().catch(() => undefined);
}

/** Sign-in never legitimately takes this long; past it, something is wrong. */
const AUTH_TIMEOUT_MS = 90_000;

export async function authenticate(clientId: string): Promise<void> {
  if (!clientId) {
    throw new Error(
      "No OAuth client ID is configured. Set VITE_GEE_OAUTH_CLIENT_ID at build time, or pass ?gee_client_id= in the URL.",
    );
  }
  if (!isLikelyOauthClientId(clientId)) {
    throw new Error(
      `"${clientId}" is not a Google OAuth client ID. They end in .apps.googleusercontent.com. Remove the gee_client_id parameter from the URL to use the built-in client.`,
    );
  }
  const ee = await loadEarthEngine();

  if (ee.data?.getAuthToken?.()) {
    authenticatedAt = Date.now();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      fn();
    };

    // The auth library calls neither callback in several failure modes: a
    // blocked popup, a client ID the consent screen rejects, or a popup the
    // user closes. Without this the promise never settles and the panel sits on
    // "Signing in to Earth Engine" indefinitely.
    const timer = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            "Earth Engine sign-in did not complete. The sign-in window was most likely blocked: allow pop-ups for this site and press Run again. In Safari, check Settings > Websites > Pop-up Windows.",
          ),
        ),
      );
    }, AUTH_TIMEOUT_MS);

    const onSuccess = () =>
      finish(() => {
        authenticatedAt = Date.now();
        resolve();
      });
    const onFailure = (error: unknown) =>
      finish(() => reject(new Error(describeError(error))));
    const onImmediateFailed = () => {
      // Third-party cookie blocking defeats the silent flow. Fall back to the
      // popup, which requires a user gesture and is why sign-in is a button.
      if (!ee.data?.authenticateViaPopup) {
        reject(new Error("Earth Engine popup authentication is unavailable."));
        return;
      }
      ee.data.authenticateViaPopup(onSuccess, onFailure);
    };

    if (!ee.data?.authenticateViaOauth) {
      reject(new Error("Earth Engine OAuth authentication is unavailable."));
      return;
    }
    // The sixth argument is suppressDefaultScopes. Without it the client merges
    // in DEFAULT_AUTH_SCOPES_, which is earthengine *plus* cloud-platform *plus*
    // full Google Drive. Drive is a restricted scope: colleagues would be asked
    // to grant "see, edit, create and delete all of your Google Drive files" for
    // a tool that never touches Drive, and any External verification would fall
    // into Google's restricted-scope review. Suppressing the defaults and
    // passing EE_SCOPES explicitly means the consent screen asks for Earth
    // Engine and nothing else.
    ee.data.authenticateViaOauth(
      clientId,
      onSuccess,
      onFailure,
      EE_SCOPES,
      onImmediateFailed,
      true,
    );
  });
}

export async function initialise(projectId: string): Promise<EarthEngineApi> {
  const ee = await loadEarthEngine();
  if (!projectId || !projectId.trim()) {
    throw new Error(
      "An Earth Engine Cloud project is required. Earth Engine refuses every compute call without one.",
    );
  }
  const project = projectId.trim();
  if (initialisedProject === project) return ee;

  ee.data?.setProject?.(project);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      fn();
    };

    // The Cloud project is the sixth argument. A client version that orders
    // these differently, or a project the account cannot reach, leaves both
    // callbacks unfired rather than raising.
    const timer = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Earth Engine did not finish initialising against project "${project}". Check the project id, that the Earth Engine API is enabled on it, and that your account has access.`,
          ),
        ),
      );
    }, 60_000);

    ee.initialize(
      null,
      null,
      () => finish(() => resolve()),
      (error: unknown) => finish(() => reject(new Error(describeError(error)))),
      null,
      project,
    );
  });

  assertGeneratedClasses(ee, project);
  initialisedProject = project;
  return ee;
}

/**
 * Confirm the dynamically generated classes are present.
 *
 * Classes such as ee.Reducer, ee.Kernel and ee.Classifier do not exist in the
 * client bundle at all: grep it for "Reducer" and there are no matches. They are
 * built by initializeGeneratedClasses_() from the algorithm list the server
 * returns during initialize().
 *
 * When that list comes back empty the client does not raise. It reports
 * initialisation as successful, and the first use of a generated class fails
 * much later with "undefined is not an object (evaluating 'ee.Reducer.sum')",
 * which points nowhere near the real cause. Checking here converts that into an
 * error naming the project and what to check about it.
 */
function assertGeneratedClasses(ee: EarthEngineApi, project: string): void {
  if (typeof ee.Reducer?.sum === "function") return;

  throw new Error(
    `Earth Engine initialised against project "${project}" but returned no algorithm list, so core operations such as ee.Reducer are unavailable. This is what a project that is not registered for Earth Engine looks like from the client. Check that "${project}" is registered at code.earthengine.google.com/register, that the Earth Engine API is enabled on it, and that your account has access to it.`,
  );
}

export async function connect(
  clientId: string,
  projectId: string,
): Promise<EarthEngineApi> {
  await authenticate(clientId);
  return initialise(projectId);
}

/** Promise wrapper around the client's node-style evaluate callback. */
export function evaluate<T>(computed: {
  evaluate: (cb: (value: T, error?: string) => void) => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    computed.evaluate((value, error) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(value);
    });
  });
}

/**
 * Resolve an Earth Engine image to an XYZ tile template. The returned URL is
 * bound to the current access token and stops authorising when it expires,
 * which is why no tile URL is ever written into saved project state.
 */
export function getTileUrl(
  image: { getMap: (visParams: unknown, cb: (mapId: unknown, error?: string) => void) => void },
  visParams: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    image.getMap(visParams, (mapId: unknown, error?: string) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      const record = mapId as { urlFormat?: string; mapid?: string; token?: string } | null;
      if (record?.urlFormat) {
        resolve(record.urlFormat);
        return;
      }
      if (record?.mapid) {
        resolve(
          `https://earthengine.googleapis.com/v1/${record.mapid}/tiles/{z}/{x}/{y}`,
        );
        return;
      }
      reject(new Error("Earth Engine returned no tile URL."));
    });
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Earth Engine reported an unknown error.";
  }
}
