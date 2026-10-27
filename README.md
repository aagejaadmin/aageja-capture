# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, captures a list of pages at one exact size, masks email addresses and phone numbers, and saves the library (images with embedded metadata, plus `library.json`) to the customer's GitHub folder in one commit.

Separate from content-api so a browser's memory use never touches content production.

## Railway

- Deploys from this repo with the `Dockerfile` (Playwright's own image; its tag must match `playwright` in `package.json`).
- Variables:
  - `CAPTURE_KEY`: required. A long random string. The agent sends it as `X-AaGeJa-Key`.
  - `GITHUB_TOKEN`: the capture service's own GitHub account, a classic token with the `public_repo` scope. Customers add that account to their repository with write access.
  - `RETENTION_HOURS`: optional. Defaults to 24.
  - `CAPTURE_ALLOW_LOCAL`: never set on Railway. Set to `1` only on a test machine, to allow `http://` and local addresses.
- Railway does not redeploy on a variable change by itself. Click the "Changes" badge to deploy.

## Routes

| Route | Key | What it does |
|---|---|---|
| `GET /health` | no | Status |
| `POST /capture/start` | yes | `{ product, client, environment_url, username, password, targets, mask_words, library_folder }` → `{ job_id, status_url }`. The library folder is checked with GitHub before anything is captured. |
| `GET /capture/status/:id` | yes | Progress, then `screens[]`, `ai_input` (page text for the description step), `report_md`, `not_captured[]` |
| `GET /capture/image/:id/:folder/:file` | yes | A captured image, for preview, until the library is saved |
| `POST /capture/finalize/:id` | yes | Body: the description step's output as plain text, or `{ descriptions }` → `{ library_url, library_json_url, summary_md, images[] }` |

- `targets` is one page per line: a full web address, a path starting with `/`, or a menu path such as `Admin > Users`.
- `library_folder` is a github.com folder link copied from the browser, for example `https://github.com/your-organization/screenshots/tree/main/product-name`. The repository must be public (storyboards and slide decks open the images without signing in) and the capture service's GitHub account must have write access.

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
- **Nothing kept:** images are deleted from the service once the library is saved, and every job after 24 hours. The saved library records page paths only, never the environment address.
- **Never deletes from the library:** an image with the same name is replaced and its `library.json` row updated. Every other image and row is kept.
