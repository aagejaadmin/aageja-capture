# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, captures a list of pages read-only at one exact size, masks email addresses and phone numbers, and saves the library (images with embedded metadata, plus `library.json`) in one commit.

Separate from content-api so a browser's memory use never touches content production.

## Railway

- Deploys from this repo with the `Dockerfile` (Playwright's own image; its tag must match `playwright` in `package.json`).
- Variables:
  - `CAPTURE_KEY`: required. A long random string. The agent sends it as `X-AaGeJa-Key`.
  - `GITHUB_TOKEN`: fine-grained token with **Contents: Read and write** on the repos in `HOUSE_REPOS` only.
  - `HOUSE_REPOS`: optional. Defaults to `aagejaadmin/aageja-screenshots`.
  - `RETENTION_HOURS`: optional. Defaults to 24.
- Railway does not redeploy on a variable change by itself. Click the "Changes" badge to deploy.

## Routes

| Route | Key | What it does |
|---|---|---|
| `GET /health` | no | Status |
| `POST /capture/start` | yes | `{ product, client, environment_url, username, password, targets, image_size, mask_words }` → `{ job_id, status_url }` |
| `GET /capture/status/:id` | yes | Progress, then `screens[]` (page text for the description step, `preview_url`) and `not_captured[]` |
| `GET /capture/image/:id/:folder/:file` | no | A captured image, for preview (unguessable id, kept 24 hours) |
| `POST /capture/finalize/:id` | yes | `{ descriptions, storage: { type: "github", repo, branch, folder } }` → `{ library_url, library_json_url, images[] }` |

`targets` is one page per line: a full web address, a path starting with `/`, or a menu path such as `Admin > Users`.

## Rules the code enforces

- **Credentials:** used in the browser only. They are never written, logged or returned.
- **Read-only:**
  - Menu steps and web addresses containing words that change data (delete, save, submit, sign out and similar) are refused before anything is clicked.
  - After sign-in, the browser refuses DELETE, PUT and PATCH requests, and form posts that load a new page.
  - New windows are closed.
- **Same site only:** web addresses on another site are refused.
- **Exact size:** every image is the requested size (default 1512×709), checked before it is kept.
- **Masking:** email addresses and phone numbers (10–15 digits) on screen are replaced before the screenshot, and so are the user's own words.
- **Never deletes:** an image with the same name is replaced and its `library.json` row updated. Every other image and row is kept.
