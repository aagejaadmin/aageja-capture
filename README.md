# AaGeJa Capture Service

Server side of the **Screenshot Library Builder** agent. Signs in to a product's web environment, walks through it (or captures a list of pages) at one exact size, masks email addresses and phone numbers, and keeps the library (images with embedded metadata, `library.json`, and a zip of everything) for 24 hours on links anyone with the link can open.

Separate from content-api so a browser's memory use never touches content production.

## Where the capture starts (1.8.0)

- **The URL entered** is where it starts. If it is the site's root, or its sign-in page (the sign-in form is at that address, or the address is named login, sign-in, sso or auth), the capture starts from the page reached after sign-in, as before. Any other URL is a page inside the product: it is opened again after sign-in, so a site that sends every user to its own home page does not decide where the capture starts. Listed menu paths start from that page too.
- **Its folder:** with no pages listed, a capture that starts at the URL entered takes only addresses under that URL's folder (`/app/x/` for `/app/x/home`). Links outside it are not followed and a click that leads outside it is not captured; the report counts them. If the URL opened somewhere else (the site sent it on), there is no limit. A Continue run keeps the first run's folder. The first screen is named by its highlighted menu item, else its heading.
- **Web components:** the walk's control list, each screen's name, headings, labels and controls, what tells screens apart, and the loading check also look inside open shadow roots. A control inside one is clicked again by a CSS path through each host (`host > child`), which Playwright follows. On a page with no shadow roots every result is the same as in 1.7.2. From 1.8.1 the path uses an element's id attribute only: ServiceNow's components report an id with no attribute behind it, which no path can match.
- **Menu groups:** in the navigation, a control that opens a group of menu items (`data-has-children`) is opened like a menu button, so Menus and links finds a side menu's pages.
- **Dialogs** count as open only when they are on screen: a side panel kept off to the right of the page does not hide the page behind it.
- **Tabs that load a page** under the same heading as the page they sit on are named "<page> – <tab>" ("Security – Design-time"), like tabs that do not.

## Many customers at once (1.7.0)

- Up to `CAPTURE_CONCURRENCY` captures (default 10) run at the same time, each in its own browser with its own sign-in. A capture beyond that waits its turn; its status says how many are ahead (`status_line`).
- Measured on a 2-vCPU test machine with the Larkspur stand-in: 4 captures at once peaked at 1.7 GB for the service and its browsers; 6 captures with 4 slots all finished with identical screenshots. A real product's pages are heavier: check Railway's memory graph on the first busy day.
- Each job is written to its own folder (`job.json`) when it is queued, starts, finishes and is saved. With a Railway volume attached, libraries, their links and their Continue links survive a redeploy for their 24 hours. A capture running during a redeploy is reported as interrupted ("run the agent again"); the password is never written down, so it cannot carry on.

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
- **Never written (1.7.0):** below `all`, the browser refuses any request that would write data, whatever sent it: DELETE, PUT, PATCH, or a POST whose address (`unfollowTrainingBFF`, `PostChangesV4`, `…/Actions/Execute`), GraphQL mutation, ASP.NET event or JSON action says so. Reads sent as POST (search, GraphQL queries, tracking) go through. Follow, Like, Rate and other toggles, links with no address that run code, and pressed/not-pressed buttons are judged as buttons that change data. The report lists every refused request first, then the others.
- **Not clicked (1.6.1, 1.7.0):** sorting, paging, carousel and calendar controls (they show the same screen); from 1.7.0 also a table's column headings, a filter panel's sections and calendar views (Day view, Week view, Agenda view). The same button on each item of a list ("Actions: <course>", "Approve <name>") is opened for the first item only. A link's query settings are checked only for strong words (delete, approve, send…), so Cornerstone's `…/UserTranscript/MainView.aspx?Reset=true` is followed; the path and route names are checked for all of them.
- **Areas (1.7.0):** a page's folder is the site's own area: the active menu item, else the navigation menu section its link sat in ("Learning" for Learning > Training Plans), else the first menu step. An action word ("Open: …") and dates are dropped. A screen opened from another is named by what was clicked ("Day view", "Bio – Transcript").
- **Names (1.6.1):** a page's visible heading; if it has none, its tab title, unless the title is only the site's tagline (Cornerstone's "Realize Your Potential"); then the biggest bold text near the top. "Still loading" is reported only while a loading sign (a spinner, a busy region) is on screen.
- **Continue (1.6.0):** a walk stops at 100 screenshots (or 45 minutes). `continue_from` = the earlier run's library link: the next run signs in again, carries on with the screens the earlier run found but did not open, skips what it captured, and saves one library holding both runs. Within the earlier library's 24 hours; same environment; Pages blank; the first run's clicking choice is used. `CAPTURE_MAX_SCREENS` lowers the limit on a test machine only.

## The library

- Every library is kept by this service for 24 hours (`RETENTION_HOURS`), then deleted. The links carry a 128-bit random token and stop working when the time is up.
- **Library link:** `…/library/<token>/library.json`. Shown to the customer only as the **Continue link** when a walk left links and buttons not tried yet: it lasts 24 hours, too short for storyboards. Storyboards read the customer's own copy (next point).
- **Download:** `…/library/<token>/screenshots.zip`: the images in their folders, `library.json`, `screenshot-catalog.pdf` and a `READ ME.txt`.
- **Library Ready (1.6.0):** the summary is short: the download and how to put it in the customer's own folder, the PDF, when the links stop, counts of what was not captured or needs checking, and the Continue link. The screenshots and the full report are in the PDF; they are on the screen only if the PDF could not be made.
- **Catalog (1.6.0):** `…/library/<token>/screenshots.pdf`: every screenshot with its name and description, then how the capture went. Made from a smaller JPEG copy of each screenshot.
- **To keep the screenshots,** the customer unzips the download and uploads it to a folder anyone can open by link: a public GitHub repository, a public Amazon S3 or Google Cloud Storage bucket, or a public web folder. In `library.json` each image's link is relative to the file (`home/x.png`), so it still works there. Then they paste that folder's link (GitHub) or the link to its `library.json` (anywhere else) into the Storyboard and Lab Guide Developer.
- Google Drive, SharePoint and OneDrive cannot be used: storyboards and slide decks cannot open images from them by link.
- No account or key of AaGeJa's touches a customer's storage. (Saving straight to GitHub, S3 or Google Cloud Storage was built and is kept on the `capture-storage-options` branch, not deployed.)

## Railway

- Deploys from this repo with the `Dockerfile` (Playwright's own image; its tag must match `playwright` in `package.json`).
- Variables:
  - `CAPTURE_KEY`: required. A long random string. The agent sends it as `X-AaGeJa-Key`.
  - `RETENTION_HOURS`: optional. Defaults to 24. How long a job and its library are kept.
  - `CAPTURE_ALLOW_LOCAL`: never set on Railway. Set to `1` only on a test machine, to allow `http://` and local addresses.
  - `CAPTURE_CONCURRENCY`: optional. Defaults to 10. Captures that run at the same time.
  - `WORK_DIR`: optional. Defaults to `<volume>/capture` when a volume is attached, else `/tmp/capture`.
  - `GITHUB_TOKEN`: no longer used from 1.3.0. Delete it.
- Railway does not redeploy on a variable change by itself. Click the "Changes" badge to deploy.
- **Attach a volume** (any mount path, for example `/data`). Railway then sets `RAILWAY_VOLUME_MOUNT_PATH` and the service keeps its jobs there; `/health` shows `"storage":"volume"`. Without one (`"storage":"temporary"`) a redeploy clears every library. With a volume, a redeploy has a short outage (Railway runs one deployment at a time on a volume) and cuts off captures that are running: deploy when `/health` shows `"running":0`.

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
  - After sign-in, the browser refuses every request that would write data (The walk, Never written), and form posts that load a new page when the service did not start them.
  - Pages still make their own background requests while loading, as they do for anyone viewing them. Every refused request, then every other one that is not a plain read, is listed in the run report.
  - New windows are closed.
- **Public addresses only:** the environment must be a named site on the public internet, and the browser refuses any request to this machine, private networks or cloud-internal names.
- **Same site only:** web addresses on another site are refused.
- **Exact size:** every image is the requested size (default 1512×709), checked before it is kept.
- **Masking:** email addresses and phone numbers (10–15 digits) on screen are replaced before the screenshot, and so are the user's own words.
- **Nothing kept longer than 24 hours:** every job and library is deleted after 24 hours. The library records page paths only, never the environment address.
