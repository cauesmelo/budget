# Cloud data without your own server

Budget runs in the browser and saves data locally in IndexedDB. Optional synchronization saves JSON backups in the application's private folder in Google Drive. This lets you clone the same project on multiple computers using the same Google account and OAuth configuration.

The integration is implemented. To enable it, you must create the client ID in your Google account; the project does not contain third-party credentials. Having the integration in the code does not mean that an account has already been configured or that a real synchronization has taken place.

## Options compared

Information verified against official sources on **October 11, 2026**. The recommendation considers a personal application used by one person who imports statements monthly and needs offline access.

| Option | Advantages | Requirements and limits | Choice for this project |
| --- | --- | --- | --- |
| Google Drive: JSON in the application folder | Stores the complete structured state; limited permissions; uses an existing Google account; requires no server | Create a project and OAuth client; connect in the browser; monitor available account storage | **Implemented and recommended** |
| Google Sheets | Data is readable and editable as a spreadsheet; API supports batch operations | Same OAuth setup; maintain the spreadsheet structure; handle manual edits and concurrent changes | Good alternative if editing the database as a spreadsheet is a priority |
| OneDrive: JSON in the application folder | Uses an existing Microsoft/Office account; permissions limited to one folder | Register an application in Microsoft Entra; implement OAuth with PKCE and Microsoft Graph integration | Possible alternative, not yet implemented |
| Supabase Free | PostgreSQL database, authentication, queries, and access rules | Create a project, schema, and rules; the free plan can pause inactive projects | Better if the product expands to multiple users; unnecessary in this version |
| Local storage and JSON backups only | Works without configuring an external service | You must transfer backups between computers and keep them safe | Available from first use |

Google Docs is a text document. To use a spreadsheet as a database, the option would be **Google Sheets**. For Budget's data model, JSON in Drive preserves transactions, categories, planning, and settings without translating every change into cell operations.

## Configure Google Drive

Complete this setup once in the account that will store your data. You do not need paid hosting or a service account.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, for example `Personal Budget`.
2. In **APIs & Services → Library**, enable the **Google Drive API**.
3. Open **Google Auth Platform**. Configure the application name, support email, and contact email. For a personal account, choose the **External** audience.
4. In **Data Access**, add only the scope `https://www.googleapis.com/auth/drive.appdata`. This scope is classified as **non-sensitive** and allows data storage in the application's own folder; it does not grant access to all documents in your Drive. [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
5. In **Clients**, create an OAuth client of type **Web application**. Under **Authorized JavaScript origins**, add these two origins:

   ```text
   http://localhost
   http://localhost:5173
   ```

   Open the application at `http://localhost:5173`. The development port is fixed. Origins do not include paths, a trailing slash, or the repository name. If you change the project's port, register the new origin. Official setup requires both the localhost origin and the origin with the port. External domains require HTTPS; localhost has a development exception. [Client setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid), [origin rules](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow).
6. Copy the **Client ID**, ending in `.apps.googleusercontent.com`, and enter it in Budget's cloud settings. Do not copy the client secret. The flow used here runs in the browser and does not need that secret. [Client IDs and server operations](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid).
7. If the application is in **Testing**, add your account's email under **Test users**. This mode allows up to 100 test users, and consent expires after seven days, requiring authorization again. For continued personal use, you can change the audience to **In production**; the weekly Testing limit no longer applies. [Audience and publishing](https://support.google.com/cloud/answer/15549945?hl=en).
8. In Budget's **Settings** screen, click **Connect and sync**, select your account, and authorize the application folder. The application then synchronizes your data. Use **Sync now** for subsequent synchronization during that session. On another computer, configure the same client ID and use **Connect and sync** with the same account to retrieve your data.

Google provides an exception to review submission when an application is used only by you or by a few people you know. Public distribution may require verification. Displaying a verified name/logo in the consent screen involves brand verification; there is no guarantee that warnings will be absent in every configuration. The non-sensitive scope used here avoids requesting the additional review for access to all of Drive. [Brand verification and the personal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

Do not create a different OAuth project for each computer: reuse the same application's client ID. If you use another Google account, your remote data will be in that other account. The folder belongs to the application and does not appear as a normal file in Drive. [Application data folder](https://developers.google.com/workspace/drive/api/guides/appdata).

## How synchronization works

When you click synchronize, Budget:

1. Identifies this browser using a random ID saved locally. The ID contains no name, email, or bank identifier.
2. Lists the application's backups in Drive, including every page of the listing.
3. Selects the latest backup from **each browser/device**, using the modification date and, for ties, the file ID.
4. Downloads and validates those backups before accepting their data. If a latest backup is invalid, upload stops and local data is preserved.
5. Merges local records with those from all selected backups. Different records are preserved; for changes to the same record, the latest version wins. Deletions use tombstones so a transaction deleted on another computer is not restored. Ties are resolved deterministically by content.
6. Creates a **new complete backup** in the application folder. The integration does not modify or delete previous backups.

The category catalog is also included in these copies, including renames and archived categories. Older backups without a catalog are migrated from existing classifications. An archived category remains in historical records but cannot be selected for a new assignment.

This avoids overwriting a single file that another computer has just updated. If two computers synchronize at the same time, each creates its own file; the next synchronization merges the latest file from each. They may show different states until that next synchronization. This is not simultaneous, real-time collaboration.

For a record edited offline on two computers, one version wins according to the update rule. Financial settings also have a version; concurrent settings edits are not merged field by field. When using multiple devices, synchronize before starting and again after finishing.

On the first synchronization of an empty browser with default financial settings, the application adopts the planning/settings already in the cloud. A newly created state does not replace the previous budget merely because its creation timestamp is newer.

Tabs in the same browser share the local ID. In browsers that support **Web Locks**, synchronization is serialized across tabs. In browsers without this feature, use a single tab to synchronize. The ID depends on the site's origin and the browser profile; changing browser/profile or clearing storage creates another ID.

The client ID is a public local setting and **is not included in synchronized JSON or exported backups**. When retrieving cloud data, the client ID configured on that computer is preserved.

## Session and security

The application loads the official Google Identity Services library and obtains a temporary token through an authorization popup. The token stays only in memory: it is not written to IndexedDB/localStorage, exported, or sent to GitHub. The application does not use a client secret or request your banking password. Drive calls use HTTPS and the `drive.appdata` scope.

Google documents the token flow for browser applications, with direct API access through REST/CORS. This flow does not use server refresh tokens. When temporary authorization expires or the page is reloaded, you may need to click **Connect and sync** again. The application expires its local session shortly before the expiry reported by Google. [Google Identity Services: token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

**Disconnect** ends the local session, cancels in-progress requests, and attempts to revoke authorization with Google. It does not delete local data or remote backups. Remote revocation depends on the connection to Google; you can also review permissions under [Google account connections](https://myaccount.google.com/connections).

JSON files contain your financial data. They are private in your account, but this version **does not provide application-level password encryption**. Anyone with access to your browser/profile can read local data. Protect exported backups as carefully as bank statements. Do not commit statements, backups, or real data to repositories.

## Storage and cost

Standard Google Drive API usage is available at no additional cost. The documentation was updated in May 2026: for new projects, it specifies per-minute limits, daily traffic of 1 TB, and a free threshold of 400 million quota units per day. Google announced future charges for usage above the quotas, with at least 90 days' advance notice. A personal application with occasional synchronization stays far below these volumes; free usage depends on quotas and service terms. [Current Drive limits and pricing](https://developers.google.com/workspace/drive/api/guides/limits).

A Google account currently includes **up to 15 GB** shared across Gmail, Google Drive, and Google Photos. The account must have available storage. [Included storage](https://support.google.com/googleone/answer/9004014?hl=en-419).

A structured personal history usually occupies a few MB, but each synchronization adds a complete copy. For example, a 500 KB state synchronized 100 times uses approximately 50 MB, plus metadata. The application downloads only the latest files from each device, but lists historical files and does not clean them up automatically. An individual snapshot is limited to 25 MB in this version.

Also keep an exported backup outside the browser. Google allows users to remove data from the application folder, and the folder may be deleted when the application is removed from Drive. Synchronization should not be your only copy. [Application folder lifecycle](https://developers.google.com/workspace/drive/api/guides/appdata).

## Alternative details

### Google Sheets

The API allows reading/writing spreadsheets directly from the browser. The recommended `drive.file` scope authorizes only files created/selected for the application and is non-sensitive. The `spreadsheets` and `spreadsheets.readonly` scopes, which cover all spreadsheets, are sensitive. To adopt Sheets in this project, creating a dedicated spreadsheet with `drive.file` would be preferable to requesting access to all spreadsheets in the account. [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).

Standard usage has no additional cost. Current quotas include 300 read requests and 300 write requests per minute per project, and 60 of each per minute per user/project. The documentation also announces future charges for usage above the quotas. These quotas are sufficient for a personal budget using batch operations. Sheets would be useful for inspecting data manually, but would require defining the structure and behavior of external edits. [Sheets limits and pricing](https://developers.google.com/workspace/sheets/api/limits).

### OneDrive

Microsoft Graph provides an application folder at `Apps/{application name}`, using the `Files.ReadWrite.AppFolder` scope and the account's available storage. For personal Microsoft accounts, the special folders endpoint documentation identifies this scope as the minimum for the application folder. Users can modify/remove files in that folder. [Application folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder), [permissions for personal accounts](https://learn.microsoft.com/en-us/graph/api/drive-get-specialfolder?view=graph-rest-1.0).

A browser integration requires registering the application in Microsoft Entra and using an authorization code with **PKCE**, without a client secret in the frontend. In SPA applications, refresh tokens last 24 hours; the application must renew authorization afterward. An existing Office account can make this option appealing, but Microsoft Graph integration is not implemented in Budget. [SPA flow and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas), [token lifetime](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).

### Supabase Free

The current free plan allows two projects and includes a 500 MB database per project, 1 GB of file storage, and 5 GB of traffic. These volumes comfortably support a personal budget. Authentication, a table schema, and access policies would need to be implemented to restrict data to your user. [Free plan and limits](https://supabase.com/docs/guides/platform/billing-on-supabase).

The main limitation for this use case is automatic pausing after low activity over a seven-day period. An application used only for monthly reviews may require reactivating the project in the dashboard. Drive therefore fits occasional use without your own server better. [Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

## Run locally or publish

To run on another computer, clone the code and use the README commands. The browser accesses private data directly in Drive after your authorization. The computer does not need a database or its own backend.

A static frontend can technically be hosted, but hosting requires separate configuration. On GitHub Free, GitHub Pages requires a public repository. Pages sites are public even when their source can be in a private repository. GitHub advises against using Pages for sensitive transactions such as sending passwords or card numbers. This version runs locally by default and includes no personal data in the published code. [Pages availability and behavior](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [HTTPS and restrictions](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).

If you later configure an HTTPS origin, register **the origin**, for example `https://your-domain`, in OAuth. Repository paths are not part of the origin. Local storage for an HTTPS origin is separate from localhost storage; connect and synchronize to retrieve your data.

## Common problems

| Message/situation | Resolution |
| --- | --- |
| Unauthorized origin / `origin_mismatch` | Open `http://localhost:5173` and verify that both `http://localhost` and `http://localhost:5173` are in the Web client's origins |
| An application in Testing blocks your account | Add the exact email under Test users; complete the popup with that account |
| Authorization is requested again | Browser tokens are temporary; in Testing, consent also expires after seven days |
| The Google popup did not open | Allow pop-ups for the application's origin and click **Connect and sync** again |
| Drive denied access | Confirm that the Google Drive API is enabled and authorize the application folder scope |
| Internet failure or timeout | Your local data remains saved. Reconnect/synchronize when the connection returns |
| No data appears on another computer | Use the same Google account and client ID; confirm that synchronization completed on the first computer |
| Invalid remote backup | The application stops uploading to avoid propagating the error. Export local data and investigate the backup before restoring it |
| Insufficient Google account storage | Free up space or use local backups; Budget does not purchase storage or remove files automatically |
