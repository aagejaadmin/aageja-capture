# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, walks through it (or captures a list of pages) at one exact size, masks email addresses and phone numbers, and keeps the library (images with embedded metadata, `library.json`, and a zip of everything) for 24 hours on links anyone with the link can open.

Separate from content-api so a browser's memory use never touches content production.

## The walk (1.5.0)

- **No pages listed:** the service walks the product from the page after sign-in, nearest screens first, up to 100 screenshots and 45 minutes. The same screen for another record (`/users/123`, `/users/456`, `?id=5`) is captured once.
- **`click_level`** says what it clicks:
  - `links` (default): menu items, tabs and links. Navigation menus (☰, "Admin ▾", menus that open on hover) are opened to find their links.
  - `buttons`: also buttons, ⋯ menus, dropdowns, accordions and wizard steps. Each dialog and form is captured, then left without saving. A button that changes data (Delete, Send, Save…) is clicked with every request but a plain read refused, and page loads refused: if it opens an "Are you sure?" box, the box is captured and Cancel pressed; if it acts at once, nothing reaches the site.
  - `all`: also presses buttons that change data, after every other screen is captured. The browser then refuses nothing but addresses off the public internet, and answers the site's own "Are you sure?" yes.
  - At every level: never signs out, pays, or acts as another user.
- **Pages listed** with `buttons` or `all`: it opens what is on each listed page (buttons, tabs, dialogs) and follows no links.
- The controls on each screen come from `discover_controls.js`, the platform-module-capture skill's script, with the additions marked in it. What may be clicked, and how screens are told apart, is in `walk.js`.
- The run report says what it clicked, why it stopped, how many links and buttons it found but did not try, what it did not click and why, and what it opened but did not keep.
- **Not kept (1.6.0):** a page that shows the site's error message ("An error occurred while processing your request", "Page not found", "Access denied"…, tested on its title and headings; nothing on it is opened), and a page that is the same as a screen already captured (the same title, headings, labels, controls and text on screen, numbers aside: Home and Welcome). A listed page that shows the error message goes in Not captured.
- **Not clicked (1.6.1):** sorting, paging, carousel and calendar controls (they show the same screen). The same button on each item of a list ("Actions: <course>", "Approve <name>") is opened for the first item only. A link's query settings are checked only for strong words (delete, approve, send…), so Cornerstone's `…/UserTranscript/MainView.aspx?Reset=true` is followed; the path and route names are checked for all of them.
- **Names (1.6.1):** a page's visible heading; if it has none, its tab title, unless the title is only the site's tagline (Cornerstone's "Realize Your Potential"); then the biggest bold text near the top. "Still loading" is reported only while a loading sign (a spinner, a busy region) is on screen.
- **Continue (1.6.0):** a walk stops at 100 screenshots (or 45 minutes). `continue_from` = the earlier run's library link: the next run signs in again, carries on with the screens the earlier run found but did not open, skips what it captured, and saves one library holding both runs. Within the earlier library's 24 hours; same environment; Pages blank; the first run's clicking choice is used. `CAPTURE_MAX_SCREENS` lowers the limit on a test machine only.

## The library

- Every library is kept by this service for 24 hours (`RETENTION_HOURS`), then deleted. The links carry a 128-bit random token and stop working when the time is up.
- **Library link:** `…/library/<token>/library.json`. Shown to the customer only as the **Continue link** when a walk left links and buttons not tried yet: it lasts 24 hours, too short for storyboards. Storyboards read the customer's own copy (next point).
- **Download:** `…/library/<token>/screenshots.zip`: the images in their folders, `library.json`, `screenshot-catalogue.pdf` and a `READ ME.txt`.
- **Library Ready (1.6.0):** the summary is short: the download and how to put it in the customer's own folder, the PDF, when the links stop, counts of what was not captured or needs checking, and the Continue link. The screenshots and the full report are in the PDF; they are on the screen only if the PDF could not be made.
- **Catalogue (1.6.0):** `…/library/<token>/screenshots.pdf`: every screenshot with its name and description, then how the capture went. Made from a smaller JPEG copy of each screenshot.
- **To keep the screenshots,** the customer unzips the download and uploads it to a folder anyone can open by link: a public GitHub repository, a public Amazon S3 or Google Cloud Storage bucket, or a public web folder. In `library.json` each image's link is relative to the file (`home/x.png`), so it still works there. Then they paste that folder's link (GitHub) or the link to its `library.json` (anywhere else) into the Storyboard and Lab Guide Developer.
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
| `POST /capture/start` | yes | `{ product, client, environment_url, username, password, targets, click_level, continue_from, mask_words }` → `{ job_id, status_url }`. Username and password: both, or neither for an address that opens without signing in. `targets` blank: walk the product. `click_level`: `links` (default), `buttons` or `all`. |
| `GET /capture/status/:id` | yes | Progress, then `screens[]`, `ai_input` (page text for the description step), `report_md`, `not_captured[]` |
| `GET /capture/image/:id/:folder/:file` | yes | A captured image, for preview |
| `POST /capture/finalize/:id` | yes | Body: the description step's output as plain text, or `{ descriptions }` → `{ library_url, download_url, expires, summary_md, images[] }` |
| `GET /library/:token/library.json`, `/screenshots.zip`, `/screenshots.pdf`, `/<folder>/<file>.png` | no | The library, until it expires. Nothing else is served. |

- `targets` is one page per line: a full web address, a path starting with `/`, or a menu path such as `Admin > Users`. Blank: the walk.

## Rules the code enforces

- **Credentials:** optional (an address that opens without signing in needs none). When given, they arrive with each run, are used in the browser only, and are never written, logged or returned. A key in the address's query string is never written to the library: it records page paths only. The agent tells the person running it that the password stays in MindStudio's run history and to change it after the capture.
- **What it does on the site** depends on `click_level` (The walk, above). Below `all`:
  - Menu steps, links and web addresses containing words that change data (delete, save, submit, sign out and similar) are refused before anything is clicked.
  - After sign-in, the browser refuses DELETE, PUT and PATCH requests, and form posts that load a new page when the service did not start them.
  - Pages still make their own background requests while loading, as they do for anyone viewing them. Every one that is not a plain read is listed in the run report.
  - New windows are closed.
- **Public addresses only:** the environment must be a named site on the public internet, and the browser refuses any request to this machine, private networks or cloud-internal names.
- **Same site only:** web addresses on another site are refused.
- **Exact size:** every image is the requested size (default 1512×709), checked before it is kept.
- **Masking:** email addresses and phone numbers (10–15 digits) on screen are replaced before the screenshot, and so are the user's own words.
- **Nothing kept longer than 24 hours:** every job and library is deleted after 24 hours. The library records page paths only, never the environment address.
