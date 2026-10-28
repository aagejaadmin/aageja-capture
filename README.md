# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, captures a list of pages at one exact size, masks email addresses and phone numbers, and saves the library (images with embedded metadata, plus `library.json`).

Separate from content-api so a browser's memory use never touches content production.

## Where a library is saved

| Library folder given | Where the library goes | Library link (for the Storyboard Designer) |
|---|---|---|
| Nothing | Kept on this service for 24 hours, on links anyone with the link can open, plus a zip of everything | `…/library/<token>/library.json` |
| A GitHub folder | The customer's public repository, in one commit | The folder link |
| An Amazon S3 folder | The customer's bucket | That folder's `library.json` |
| A Google Cloud Storage folder | The customer's bucket | That folder's `library.json` |

- Google Drive, SharePoint, OneDrive, Dropbox and Box are refused: storyboards and slide decks cannot open images from them by link.
- Before anything is captured, the service checks it can save to the folder and that the files open without signing in. For S3 and Google Cloud Storage it writes one small file, `aageja-capture-check.txt` (the same name every run), and opens it.
- The Storyboard Designer reads `library.json` with each screen's description (content-api `/screenshot-manifest`, JSON list).

## Railway

- Deploys from this repo with the `Dockerfile` (Playwright's own image; its tag must match `playwright` in `package.json`).
- Variables:
  - `CAPTURE_KEY`: required. A long random string. The agent sends it as `X-AaGeJa-Key`.
  - `GITHUB_TOKEN`: the capture service's own GitHub account, a classic token with the `public_repo` scope.
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: the capture service's own AWS user. It needs no permissions of its own; customers grant it access to their folder.
  - `GCS_SA_KEY`: the capture service's own Google service account, its JSON key (the whole file). It needs no roles of its own; customers grant it access to their bucket.
  - Each of the three accounts is optional. A kind of folder with no account set is refused with a message.
  - `RETENTION_HOURS`: optional. Defaults to 24. How long a job, its images and a 24-hour library are kept.
  - `CAPTURE_ALLOW_LOCAL`: never set on Railway. Set to `1` only on a test machine, to allow `http://` and local addresses.
  - `GITHUB_API_BASE`, `S3_ENDPOINT`, `STS_ENDPOINT`, `GCS_API_BASE`: test machine only, to point at stand-ins.
- Railway does not redeploy on a variable change by itself. Click the "Changes" badge to deploy.
- A redeploy clears the service's disk: captures not yet saved and 24-hour libraries are lost.

## What customers grant (once per folder)

| Folder | The customer's administrator |
|---|---|
| GitHub | Makes the repository public and invites the capture GitHub account as a collaborator with Write access. |
| Amazon S3 | Adds a bucket policy that lets the capture AWS user put files in the folder (`s3:PutObject`) and lets anyone read them (`s3:GetObject`). Block Public Access must allow it. |
| Google Cloud Storage | Gives the capture service account the **Storage Object User** role on the bucket, and `allUsers` the **Storage Object Viewer** role. |

`GET /accounts` returns the three account names, so the intake shows the exact one to grant.

## Routes

| Route | Key | What it does |
|---|---|---|
| `GET /health` | no | Status, and which of the three accounts are set |
| `GET /accounts` | no | `{ github, aws, google, temporary_hours }`: account names only |
| `POST /capture/start` | yes | `{ product, client, environment_url, username, password, targets, mask_words, library_folder }` → `{ job_id, status_url }`. The library folder is checked before anything is captured; blank means 24 hours. |
| `GET /capture/status/:id` | yes | Progress, then `screens[]`, `ai_input` (page text for the description step), `report_md`, `not_captured[]` |
| `GET /capture/image/:id/:folder/:file` | yes | A captured image, for preview |
| `POST /capture/finalize/:id` | yes | Body: the description step's output as plain text, or `{ descriptions }` → `{ library_url, library_json_url, saved_to, download_url?, expires?, summary_md, images[] }` |
| `GET /library/:token/library.json`, `/screenshots.zip`, `/<folder>/<file>.png` | no | A 24-hour library, until it expires. The token is 128 random bits. |

- `targets` is one page per line: a full web address, a path starting with `/`, or a menu path such as `Admin > Users`.

## Rules the code enforces

- **Credentials:** arrive with each run, are used in the browser only, and are never written, logged or returned. The agent tells the person running it that the password stays in MindStudio's run history and to change it after the capture.
- **What it does on the site:**
  - It only opens pages and clicks menu items. Menu steps and web addresses containing words that change data (delete, save, submit, sign out and similar) are refused before anything is clicked.
  - After sign-in, the browser refuses DELETE, PUT and PATCH requests, and form posts that load a new page when the service did not start them.
  - Pages still make their own background requests while loading, as they do for anyone viewing them. Every one that is not a plain read is listed in the run report.
  - New windows are closed.
- **Public addresses only:** the environment must be a named site on the public internet, and the browser refuses any request to this machine, private networks or cloud-internal names.
- **Same site only:** web addresses on another site are refused.
- **Exact size:** every image is the requested size (default 1512×709), checked before it is kept.
- **Masking:** email addresses and phone numbers (10–15 digits) on screen are replaced before the screenshot, and so are the user's own words.
- **Nothing kept longer than 24 hours:** images saved to a customer folder are deleted from this service once saved; a 24-hour library and every job are deleted after 24 hours. The saved library records page paths only, never the environment address.
- **Never deletes from a customer folder:** an image with the same name is replaced and its `library.json` row updated. Every other file and row is kept.
