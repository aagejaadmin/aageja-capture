# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, captures a list of pages at one exact size, masks email addresses and phone numbers, and keeps the library (images with embedded metadata, `library.json`, and a zip of everything) for 24 hours on links anyone with the link can open.

Separate from content-api so a browser's memory use never touches content production.

## The library

- Every library is kept by this service for 24 hours (`RETENTION_HOURS`), then deleted. The links carry a 128-bit random token and stop working when the time is up.
- **Library link:** `…/library/<token>/library.json`. Paste it into the Storyboard Designer's Screenshot Library URL field within the 24 hours. The Storyboard Designer reads each screen's description from it.
- **Download:** `…/library/<token>/screenshots.zip`: the images in their folders, `library.json` and a `READ ME.txt`.
- **To keep the screenshots,** the customer unzips the download and uploads it to a folder anyone can open by link: a public GitHub repository, a public Amazon S3 or Google Cloud Storage bucket, or a public web folder. In `library.json` each image's link is relative to the file (`home/x.png`), so it still works there. Then they paste that folder's link (GitHub) or the link to its `library.json` (anywhere else) into the Storyboard Designer.
- Google Drive, SharePoint and OneDrive cannot be used: storyboards and slide decks cannot open images from them by link.
- No account or key of AaGeJa's touches a customer's storage. (Saving straight to GitHub, S3 or Google Cloud Storage was built and is kept on the `capture-storage-options` branch, not deployed.)

## Railway

- Deploys from this repo with the `Dockerfile` (Playwright's own image; its tag must match `playwright` in `package.json`).
- Variables:
  - `CAPTURE_KEY`: required. A long random string. The agent sends it as `X-AaGeJa-Key`.
  - `RETENTION_HOURS`: optional. Defaults to 24. How long a job and its library are kept.
  - `CAPTURE_ALLOW_LOCAL`: never set on Railway. Set to `1` only on a test machine, to allow `http://` and local addresses.
  - `GITHUB_TOKEN`: no longer used from 1.3.0. Delete it.
- Railway does not redeploy on a variable change by itself. Click the "Changes" badge to deploy.
- A redeploy clears the service's disk: captures not yet saved and libraries still within their 24 hours are lost.

## Routes

| Route | Key | What it does |
|---|---|---|
| `GET /health` | no | Status |
| `POST /capture/start` | yes | `{ product, client, environment_url, username, password, targets, mask_words }` → `{ job_id, status_url }` |
| `GET /capture/status/:id` | yes | Progress, then `screens[]`, `ai_input` (page text for the description step), `report_md`, `not_captured[]` |
| `GET /capture/image/:id/:folder/:file` | yes | A captured image, for preview |
| `POST /capture/finalize/:id` | yes | Body: the description step's output as plain text, or `{ descriptions }` → `{ library_url, download_url, expires, summary_md, images[] }` |
| `GET /library/:token/library.json`, `/screenshots.zip`, `/<folder>/<file>.png` | no | The library, until it expires. Nothing else is served. |

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
- **Nothing kept longer than 24 hours:** every job and library is deleted after 24 hours. The library records page paths only, never the environment address.
