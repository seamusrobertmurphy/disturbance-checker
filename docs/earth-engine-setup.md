# Earth Engine setup

Two things must exist before anyone can run a check: a Cloud project registered
for Earth Engine that pays for compute, and an OAuth client that lets the
browser sign people in against it. Neither can be avoided. Earth Engine refuses
every compute call made without a registered project, and Google will not issue
a token to an origin it does not recognise.

These steps describe the **Google Auth Platform**, the console section at
`console.cloud.google.com/auth`. It replaced the older "APIs and Services →
OAuth consent screen" and "Credentials" pages, and the settings live in
different places now:

| Google Auth Platform | Formerly | What it holds |
|---|---|---|
| **Branding** | Consent screen, first page | App name, support email, logo |
| **Audience** | Consent screen, user type | Internal or External, test users, publishing status |
| **Clients** | Credentials | OAuth client IDs and authorized origins |
| **Data Access** | Consent screen, scopes | Which scopes the app requests |
| **Verification Center** | Verification | Review status, only if External and published |

## 1. Register the project for Earth Engine

Earth Engine access is per Cloud project and must be registered explicitly at
[code.earthengine.google.com/register](https://code.earthengine.google.com/register).
Registration asks you to choose a track, and the choice is a licensing
commitment rather than a billing preference.

**Commercial** is the correct track for verification and validation work carried
out for a fee, which includes ACR IFM verification. It requires a Cloud billing
account.

**Noncommercial** is free and is limited to academic research, education,
nonprofit and government use. Using it for paid assurance work would breach the
terms, and the exposure sits with the organisation, not with Google's
enforcement appetite.

If you are unsure which applies, that is a question for whoever signs the
engagement letter, not a technical one.

## 2. Attach billing

Under **Billing** in the Cloud console, link a billing account to the project.

A project with no billing account is the single most common reason a run fails:
every Earth Engine call returns 403, with no obvious connection to billing in
the error. The Google Auth Platform overview flags this under **Project Checkup
→ Developer identity → Billing account verification**.

Then enable the **Earth Engine API** under **APIs and Services → Library**.

## 3. Choose the audience

**Audience** offers Internal or External, and which you can pick is decided for
you.

**Internal** is only available when the project belongs to a Google Workspace
organisation, and it limits sign-in to accounts in that organisation. It skips
Google's verification review entirely. If your team is on Workspace and the
project sits inside it, choose this and move on.

**External** is the only option when the project sits under a personal Google
account. To check which you have, look at the project's Organisation in the
console project picker: `No organisation` means External is your only choice.

### External without verification

External apps have a publishing status. Left in **Testing**, the app works
immediately with no review, for up to 100 users, each of whom you add by address
under **Audience → Test users**. Anyone not on that list is refused.

For a verification team this is usually the right answer. Add your colleagues as
test users and stop there. Publishing to Production would trigger a review of the
Earth Engine scope, which is more process than a small internal tool warrants.

One caveat normally applies to Testing mode: refresh tokens expire after seven
days. It does not bite here, because this tool holds a short-lived access token
of about an hour and asks the operator to sign in again rather than keeping a
long-lived session. The design and the constraint happen to agree.

## 4. Set the scope

Under **Data Access**, add exactly one scope:

```
https://www.googleapis.com/auth/earthengine
```

That is the only scope this tool requests, and getting it down to one took a
deliberate change worth knowing about.

The Earth Engine JavaScript client defines `DEFAULT_AUTH_SCOPES_` as three
scopes, not one:

| Scope | Google's classification |
|---|---|
| `auth/earthengine` | Sensitive |
| `auth/cloud-platform` | Sensitive, broad Cloud access |
| `auth/drive` | **Restricted**, full read and write on the user's Drive |

Any application calling `ee.data.authenticateViaOauth` in the ordinary way gets
all three. The consent screen then asks colleagues to grant "See, edit, create
and delete all of your Google Drive files" for a tool that never touches Drive,
and an External app requesting a restricted scope faces Google's most demanding
review, including a third-party security assessment.

The function takes an undocumented sixth argument, `suppressDefaultScopes`.
Internally it calls `mergeAuthScopes_(!suppressDefaultScopes, false,
extraScopes)`, so passing `true` drops the defaults and uses only what you
supply. This tool passes it, which is why the consent screen asks for Earth
Engine and nothing else.

So add the one scope above under **Data Access**, and do not add
`devstorage.full_control` or Drive. Compute, `getMap` and `reduceRegion` all run
under the Earth Engine scope alone. Cloud Storage would only be needed if export
were added, and that should be a deliberate decision at the time.

## 5. Create the OAuth client

Under **Clients → Create client**, choose application type **Web application**.

The type matters. If the project already has clients, they are probably
**Desktop** clients created for the QGIS and geemap workflow. A Desktop client
cannot authenticate a browser app, and reusing one produces an
`unauthorized_client` error that gives no hint about the cause. Create a new
one.

Under **Authorized JavaScript origins**, add the exact origin the app is served
from. Origin means scheme and host with no path:

```
https://seamusrobertmurphy.github.io
https://geolibre.app
http://localhost:5173
```

Add all three now. The first is your Pages deployment, the second lets you test
inside a hosted GeoLibre before deploying anything, and the third is for local
development. Google permits origins you do not control; verification governs the
consent screen, not this list.

A path here is the most common cause of `redirect_uri_mismatch`. It is
`https://seamusrobertmurphy.github.io`, never
`https://seamusrobertmurphy.github.io/disturbance-checker/`.

Leave **Authorized redirect URIs** empty. This flow is the JavaScript implicit
flow and does not use one.

Copy the client ID. It looks like
`141292844612-abc123def456.apps.googleusercontent.com`.

## 6. Grant colleagues access

Colleagues sign in as themselves. There is no way for a browser-only tool to run
on one person's credentials, because the only mechanism that would allow it is a
service account key, which cannot live in a public bundle without being a leaked
credential. What you can do is make everyone's compute bill to your project.

For each colleague, under **IAM and Admin → IAM**, grant on the project:

| Role | Why |
|------|-----|
| `roles/serviceusage.serviceUsageConsumer` | Lets them make API calls that bill to this project |
| `roles/earthengine.viewer` | Read access to Earth Engine resources |

If the app is External and in Testing, they must *also* be listed under
**Audience → Test users**. The two lists are separate and both are enforced. A
colleague with the IAM roles but no test-user entry is refused at sign-in; one
with a test-user entry but no IAM roles signs in and then gets 403 on every
call.

## 7. Where the client ID goes

Three places, in the order the tool checks them.

**A repository secret, for the deployed site.** In this repository, **Settings →
Secrets and variables → Actions → New repository secret**, named
`GEE_OAUTH_CLIENT_ID`. The deploy workflow passes it to the build as
`VITE_GEE_OAUTH_CLIENT_ID`, which Vite inlines.

The client ID is not a secret in the cryptographic sense; it ships in the
JavaScript bundle and is visible to anyone who opens the page. It is kept as an
Actions secret to stay out of the git history, not because exposure breaks
anything. What protects the project is the authorized origin list, the test-user
list and the IAM grants.

**An environment variable, for a local build:**

```bash
VITE_GEE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com \
GEOLIBRE_APP_BASE=/disturbance-checker/ \
npm run build
```

**A URL parameter, for a one-off:** append `?gee_client_id=...`. This is how you
test inside a GeoLibre deployment you do not control, and it needs no rebuild.

The Cloud project ID follows the same pattern: `VITE_GEE_PROJECT_ID` at build
time, or `?ee_project_id=` at runtime. Setting it at build time still leaves the
panel asking the operator to confirm, because compute bills to whoever is signed
in and that should be deliberate.

## What the Project Checkup warnings mean

The Google Auth Platform overview shows a Project Checkup panel. Not all of its
warnings matter equally.

**Billing account verification** matters. It is the blocker described in step 2.

**Updated contact information** and **Project contacts** are trust signals used
during verification review. If the app stays Internal, or External in Testing,
they are cosmetic and can be left. Fill them in before ever publishing to
Production.

## Troubleshooting

**`redirect_uri_mismatch` or `origin_mismatch`.** The serving origin is not in
the authorized JavaScript origins list, or was entered with a trailing path or
slash. Changes take a few minutes to propagate.

**`unauthorized_client`.** Almost always a Desktop client being used from a
browser. Create a Web application client.

**`access_denied` immediately after choosing an account.** The app is External
and in Testing, and that account is not on the test-user list.

**The popup opens and closes with nothing happening.** The browser blocked it.
Popups need a user gesture, which is why sign-in happens on the Run button
rather than on page load.

**403 on every call after a successful sign-in.** No billing account, the Earth
Engine API is not enabled, the project is not registered for Earth Engine, or
the user lacks `serviceUsageConsumer`.

**Sign-in works, then everything fails an hour later.** The access token
expiring, which is expected. The panel shows remaining session time and offers a
re-run that regenerates the tiles from the recorded parameters.
