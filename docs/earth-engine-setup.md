# Earth Engine setup

Two things must exist before anyone can run a check: a Cloud project that pays
for Earth Engine compute, and an OAuth client that lets the browser sign people
in against it. Neither can be avoided. Earth Engine refuses every compute call
made without a bound project, and Google will not issue a token to an origin it
does not recognise.

## 1. The Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/) and either
   select an existing project or create one. The project ID, not the display
   name, is what the tool asks for.
2. Attach a billing account under **Billing**. Earth Engine's commercial tier
   refuses compute on a project with no billing account, even inside the free
   monthly allowance.
3. Enable the **Earth Engine API** under **APIs and Services > Library**.
4. Register the project for Earth Engine at
   [code.earthengine.google.com/register](https://code.earthengine.google.com/register)
   and choose the commercial or noncommercial path that matches your use.

### Granting colleagues access

Colleagues sign in as themselves. There is no way for a browser-only tool to run
on one person's credentials, because the only mechanism that would allow it is a
service account key, which cannot live in a public bundle without being a leaked
credential. What you can do is make everyone's compute bill to your project.

For each colleague, under **IAM and Admin > IAM**, grant on the project:

| Role | Why |
|------|-----|
| `roles/serviceusage.serviceUsageConsumer` | Lets them make API calls that bill to this project |
| `roles/earthengine.viewer` | Read access to Earth Engine resources |

Each colleague also needs a Google account that is registered for Earth Engine.

## 2. The OAuth client

The tool ships with no client ID, and sign-in fails until one is configured. The
client must be registered in the same Cloud project.

1. Go to **APIs and Services > OAuth consent screen**. Choose **Internal** if
   everyone using the tool is in your Google Workspace organisation, which
   avoids Google's verification review entirely. Choose **External** only if you
   need accounts outside it, and expect a review before more than 100 people can
   sign in.
2. Add the scope `https://www.googleapis.com/auth/earthengine`.
3. Go to **APIs and Services > Credentials**, then
   **Create Credentials > OAuth client ID**, and choose **Web application**.
4. Under **Authorized JavaScript origins**, add the exact origin the app is
   served from. Origin means scheme and host with no path:

   ```
   https://seamusrobertmurphy.github.io
   ```

   Not `https://seamusrobertmurphy.github.io/disturbance-checker/`. A path here
   is the single most common reason sign-in fails with `redirect_uri_mismatch`.
   Add `http://localhost:5173` as well if you want local development to work.
5. Leave **Authorized redirect URIs** empty. This flow is the JavaScript implicit
   flow and does not use one.
6. Copy the client ID. It looks like
   `141292844612-abc123def456.apps.googleusercontent.com`.

## 3. Where the client ID goes

There are three places, in the order the tool checks them.

**A repository secret, for the deployed site.** This is the normal path. In this
repository go to **Settings > Secrets and variables > Actions > New repository
secret**, name it `GEE_OAUTH_CLIENT_ID`, and paste the client ID. The deploy
workflow reads it and passes it to the GeoLibre build as
`VITE_GEE_OAUTH_CLIENT_ID`, which Vite inlines at build time.

The client ID is not a secret in the cryptographic sense; it ships in the
JavaScript bundle and is visible to anyone who opens the page. It is stored as
an Actions secret to keep it out of the git history, not because exposure breaks
anything. What protects the project is the authorized origin list and the IAM
grants, not the confidentiality of this string.

**An environment variable, for a local build.** When building the GeoLibre app
yourself:

```bash
VITE_GEE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com \
GEOLIBRE_APP_BASE=/disturbance-checker/ \
npm run build
```

**A URL parameter, for a one-off.** Append `?gee_client_id=...` to the page URL.
This is useful for testing a second client without rebuilding, and is the only
option if you are loading the plugin into a GeoLibre deployment you do not
control.

The Cloud project ID follows the same pattern: `VITE_GEE_PROJECT_ID` at build
time, or `?ee_project_id=` at runtime. If you set it at build time the panel
still shows it and still asks the operator to confirm, because compute bills to
whoever is signed in and that decision should be deliberate.

## Troubleshooting

**`redirect_uri_mismatch` or `origin_mismatch` on sign-in.** The origin serving
the page is not in the authorized JavaScript origins list, or was entered with a
trailing path or slash. Changes can take a few minutes to propagate.

**The popup opens and closes with nothing happening.** The browser blocked it.
The popup must be opened from a user gesture, which is why sign-in happens on
the Run button rather than automatically on load.

**`Earth Engine client library not initialized` or 403 on every call.** The
Cloud project has no billing account, the Earth Engine API is not enabled, or
the signed-in user lacks `serviceUsageConsumer` on it.

**Sign-in works, then everything fails an hour later.** That is the access token
expiring, and it is expected. The panel shows the remaining session time and
offers a re-run, which regenerates the tiles from the recorded parameters.
