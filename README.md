# Budget

Budget is a personal finance application in English, with Itaú statement imports and reserve planning. It runs in the browser, saves data locally, and offers optional Google Drive synchronization within the free quotas for personal use.

## Run on any computer

Install [Node.js 22.12 or later](https://nodejs.org/), clone this project, and run:

```sh
git clone https://github.com/cauesmelo/budget.git
cd budget
npm ci
npm start
```

The browser opens at **http://localhost:5173**. Keep the terminal open while using the application. The `Start.command` launcher on macOS and `Start.bat` on Windows perform these steps. On Linux, use `./start.sh`. After updating the code with `git pull`, run `npm ci` again.

For development, use `npm run dev`. For a static build, use `npm run build`; to test that build, use `npm run preview`. The compiled application includes a manifest and application cache for offline access after the first load, including the import modules. Synchronization requires an internet connection. Application installation support depends on the browser.

## First use

1. In **Import files**, select your Budget workbook. The preview shows historical records and medium-term plan items. Confirm the import.
2. Choose the **Card billing month** and import the Itaú bank and card statements in `.xls` or `.xlsx` format. Review any warnings and confirm.
3. In **Transactions**, choose a category from the selector and complete the description. The date, original description, amount, installments, and source are already filled in. Correct the transaction type when necessary.
4. In **Medium-term plan**, review the opening reserve for the first month, income, expenses, and planning horizon. Edit the expected monthly amounts and follow the charts.
5. In **Data and cloud**, export a backup or configure the Google Drive connection.

Repeated files preserve your edits and do not recreate deleted transactions. Identical transactions that appear more than once in the same file are preserved as separate occurrences. Matching depends on the date, original text, amount, account, billing month, and installment. Changes to these fields in a new statement may require review.

## Categories

Use **Manage categories**, available in Transactions, Medium-term plan, and Data and cloud, to create, rename, archive, or reactivate options. The selectors let you search for and choose a registered category; typing in the search field only filters the list. Transactions, manual entries, and plan items share the same list. You can also leave a record **Uncategorized** while reviewing it.

Categories already present in your data and imported workbooks are added to the catalog automatically. Renaming updates the category assigned to existing records; archiving removes the category from the options for new entries while preserving historical records and filters. The catalog is included in local saves, backups, and Drive synchronization.

Category changes applied from a selected month preserve earlier classifications. Planning items that cross that boundary are split into historical and future intervals with the same amounts and overrides. The planning table displays items that overlap the projection horizon, including items with explicit zero amounts.

## Legacy and tracked months

A saved tracking start month marks earlier months **Legacy**. These months use spreadsheet history and manual corrections; tracked months use account, card, and manual transactions. Each chart month selects its own source automatically. Statement copies of expenses already covered by Legacy history are excluded from that month's total.

Legacy income can use fixed monthly amounts for specified historical periods. Each fixed amount replaces the month's income total, including any imported income, without creating artificial salary transactions. The Legacy badge and income note identify these assumptions; **Data and cloud** shows the configured periods. Tracking rules are private financial data and travel with backups and Drive synchronization independently of reserve settings.

## How amounts are handled

- Transactions use integer cents and signed amounts: debits are negative and credits are positive. Card refunds reduce spending.
- Identifiable credit card bill payments, investments, and principal withdrawals are transfers. They are excluded from spending and income. Identified investment earnings count as income. You can correct this classification in the preview or transaction list.
- A card purchase belongs to its billing month. Its original purchase date is preserved. Future installments **are not created automatically**: import subsequent bills or add the commitment to your plan.
- Each reporting month automatically selects Legacy history or tracked statements to avoid counting the same expenses twice. Legacy months retain manual corrections alongside their spreadsheet records.
- Budget history uses the worksheet month as its reporting month, preserving the original date and all categories. Spending totals are rebuilt from the rows and may differ from workbook indicators that exclude certain categories. Identified investments remain transfers.
- Planning is independent of actual transactions. Importing a statement does not automatically change your forecast.
- Closing reserve = opening reserve + planned income − spending expenses + expected return on the opening reserve. The closing balance becomes the next month's opening balance. Contributions are internal targets because moving money into a reserve does not reduce total assets. They are not subtracted or added again.
- Migration uses the values available in workbook cells and creates editable fields; it does not execute Excel formulas. Subsequent Budget imports add new records and preserve items already edited in the application.
- An open card bill can change, and bank transactions can use future processing dates. Import warnings help you review these cases.

## Cloud storage without a paid server

The implemented option is **Google Drive**, using the application's own folder and JSON files. Google Docs is a text editor; Google Sheets is an alternative if editing the data directly as a spreadsheet is essential. Drive requires less configuration and preserves the application's complete data model. OneDrive is compatible with an existing Microsoft account; Supabase is more suitable for multiple users, but its free plan can pause inactive projects.

Drive setup requires an OAuth client ID created in your Google account. It does not require a banking password, client secret, or server. Authorization requests only `drive.appdata`. The token stays in memory, and you may need to reconnect when it expires. Follow the [setup and comparison guide](docs/CLOUD.md), with official sources and limits researched in October 2026.

On another computer, use the same OAuth client ID and **synchronize before starting**. Synchronization is triggered by the button and should be repeated after making changes. It merges the latest copies from your computers and saves a new copy to Drive, keeping previous copies. If the same record is edited on two computers, the edit with the latest timestamp wins. Keep the computers' clocks accurate. Deletions are also synchronized. Concurrent changes to fields of the same record are not merged individually.

## Personal data and GitHub

The code does not include supplied files, personal statement filenames, real transactions, or backups. Test examples are fictional. `.gitignore` excludes workbooks, statements, credential files, keys, backups, and the `data`, `private`, and `backups` directories. A JSON backup contains your financial data; store it outside the repository. OAuth credentials and tokens are not included in backups or files uploaded to Drive.

Local data belongs to the browser profile and the site's origin and port. Another browser or a different port has separate storage. Clearing browser data or using an incognito window can erase the local copy. Export a backup or synchronize before doing so.

The initial legacy Budget import records a receipt alongside the data. This receipt travels with backups and synchronization and prevents repeating the initial load, even after imported records are deleted. The initial load preserves existing edits, deletions, categories, and customized local settings.

The application rename automatically migrates local data from the previous version and continues to recognize its backups and older Drive copies. The device ID is also preserved. Newly exported backups use the name `budget-backup-YYYY-MM-DD.json`.

The code is hosted in [cauesmelo/budget](https://github.com/cauesmelo/budget) and can be cloned on other computers. The application does not send your data to GitHub. To use static hosting, publish only the contents of `dist`, without statements or personal data, and register the corresponding HTTPS origin in the OAuth client. The project does not need hosting to run locally.

## Verification

```sh
npm test
npm run build
```

Tests cover calculations in cents, refunds, contributions, projections, duplicates, migration, deletions, backup validation, and synchronization with mocked Google calls.

Optional tests are available for the three reference files. They read the files directly without copying them into the project:

```sh
PRIVATE_IMPORT_DIR="/path/outside/the/repository" npm run test:files
```

The default filenames are `budget.xlsx`, `statement.xls`, and `invoice.xlsx`. To use other names, set `PRIVATE_BUDGET_FILE`, `PRIVATE_BANK_FILE`, and `PRIVATE_CARD_FILE` in your local environment; do not store personal filenames in the code. Without `PRIVATE_IMPORT_DIR`, private tests are skipped. Real Google authorization can only be validated after configuring your own OAuth client ID.

## Structure

`src/App.tsx` contains the screens. `src/lib/categories.ts` manages the category catalog and category migration. `src/lib/importers.ts` reads supported formats. `src/lib/finance.ts` calculates totals, projections, and merges. `src/lib/storage.ts` validates and stores data in IndexedDB. `src/lib/drive.ts` handles Google authorization and copy synchronization. The application uses React, TypeScript, Vite, Recharts, and the official SheetJS CE distribution.
