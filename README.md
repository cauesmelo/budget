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

1. Choose the **Card billing month** and import your Itaú bank and card statements in `.xls` or `.xlsx` format. Review any warnings and confirm.
2. In **Transactions**, choose a category from the selector and complete the description. The date, original description, amount, installments, and source are already filled in. Correct the transaction type and scope when necessary.
3. In **Medium-term plan**, enter your opening reserve, expected income, expenses, and planning horizon. Edit the monthly amounts and follow the charts.
4. In **Data and cloud**, export a backup or configure the Google Drive connection.

Repeated files preserve your edits and do not recreate deleted transactions. Identical transactions that appear more than once in the same file are preserved as separate occurrences. Matching depends on the date, original text, amount, account, billing month, and installment. Changes to these fields in a new statement may require review.

## Categories

Use **Manage categories**, available in Transactions and Data and cloud, to create, rename, archive, or reactivate options. The selectors let you search for and choose a registered category; typing in the search field only filters the list. Transactions and manual entries share the same list. You can also leave a record **Uncategorized** while reviewing it.

Categories already present in your data are added to the catalog automatically. Renaming updates the category assigned to existing records; archiving removes the category from the options for new entries while preserving historical records and filters. The catalog is included in local saves, backups, and Drive synchronization.

Planning items use names, types, dates, and monthly amounts. The planning table displays items that overlap the projection horizon, including items with explicit zero amounts.

## Medium-term planning

Create one row for each planned income, expense, or reserve allocation. Choose its behavior:

- **Fixed** repeats the default amount throughout the active date range.
- **By month** uses only the amounts entered for individual months; unset months are zero.
- **Installments** adds the active purchase schedules and stops each one after its final payment. Use **Manage installments** to enter the payment, first billing month, and remaining payment count, including the first month.

Any monthly amount can override the calculated value, including with zero. Remove the override to restore the calculation. Existing plan rows keep their fixed behavior. Start/end dates constrain every behavior.

For an additional card commitment row, include only existing installments that other budget rows do not already cover. The installment editor can suggest personal purchases from a selected imported billing month. Review and select them explicitly; work expenses, transfers, refunds, and already scheduled suggestions are excluded. Suggestions include the selected bill's payment. Matching uses the original purchase details across successive statements; changed statement details and manually entered schedules still require your review. Nothing creates future actual transactions or changes the forecast without your selection.

**Reserve** means money saved at the **beginning** of the month. The selected month's cards show income, spending, surplus, opening reserve, and closing reserve. A reserve target is an internal allocation: it reduces the amount available after the target, but does not subtract savings from total assets again. The table and charts distinguish opening and closing balances.

The indicators follow [Gustavo Cerbasi's framework](https://www.gustavocerbasi.com.br/livros/4/como-organizar-sua-vida-financeira). This app uses each month's planned spending as the cost-of-living estimate:

| Indicator | Asset target |
| --- | --- |
| PMS | 6 × monthly spending |
| PMR | 12 or 20 × monthly spending |
| PI | 0.1 × annual spending × age |
| PNIF | Annual spending ÷ net annual return as a decimal |

Progress is opening reserve divided by the target. These targets overlap and are not added together. Zero spending leaves progress uncalculated. Enter your age in the first planning month and your net annual return to enable PI and PNIF; neither input is assumed. Age advances once per planning year. PMR defaults to 12 months, with a 20-month option. The annual return sets PNIF's target; the separate expected monthly return projects reserve growth.

Schedules and indicator assumptions are saved locally, in backups, and with Drive sync. A schedule belongs to its budget row; concurrent edits follow the same whole-record timestamp rule as other plan edits. A fresh start discards previous planning assumptions along with the previous plan.

## Reporting period and a fresh start

Monthly reports use account, card, and manual transactions. Income is recorded from actual credits; the app has no fixed historical salary assumptions or spreadsheet-history reporting mode. Budget workbooks are no longer an import format.

A saved reporting start month excludes earlier reporting months from the overview, charts, manual entries, and statement imports. Card transactions use their billing month, so a purchase made earlier can still belong to the first tracked bill. The overview chart grows from the first reporting month instead of showing earlier history.

A fresh start has its own saved identity. Backups and Drive sync preserve it, so financial records, imports, and planning settings from a previous start cannot repopulate the current budget. Devices using the same start continue to merge edits and deletions normally. Categories and work settings remain independent. Older backup formats are accepted, with retired workbook history and historical income assumptions discarded.

## Personal and work cash flow

The overview's income, expenses, net income, and category charts cover personal transactions. A separate **Work in / out** card shows work credits (reimbursements and refunds) and debits for the selected month. Its review link opens the work transaction filter. Monthly work cash flow is not an outstanding reimbursement balance: an expense and its reimbursement may occur in different months.

Choose **Personal** or **Work** in the **Scope** selector on each transaction, including import previews and manual entries. For a reimbursement, select Work and the income type; the interface labels it **Reimbursement**. Keep salary Personal. Work transfers and deleted records are excluded from both sets of totals. Personal transactions without categories appear in a small review banner above the overview cards.

In **Data and cloud**, customize the work label and optionally select expense categories that should default to Work, including archived historical categories. These category rules apply only to expenses; employer names and income descriptions never classify a deposit as a reimbursement. An explicit transaction scope takes priority over category rules. The work label, rules, and individual scopes are private financial data and are saved with backups and Drive synchronization. Older backups preserve the current work configuration when merged.

Work cash flow is separate from the independent medium-term plan; review planned commitments directly in the planning table.

## How amounts are handled

- Transactions use integer cents and signed amounts: debits are negative and credits are positive. Card refunds reduce spending.
- Identifiable credit card bill payments, investments, and principal withdrawals are transfers. They are excluded from spending and income. Identified investment earnings count as income. You can correct this classification in the preview or transaction list.
- A card purchase belongs to its billing month. Its original purchase date is preserved. Future installments **are not created automatically**: import subsequent bills or add the commitment to your plan.
- Planning is independent of actual transactions. Importing a statement does not automatically change your forecast.
- Closing reserve = opening reserve + planned income − spending expenses + expected return on the opening reserve. The closing balance becomes the next month's opening balance. Contributions are internal targets because moving money into a reserve does not reduce total assets. They are not subtracted or added again.
- An open card bill can change, and bank transactions can use future processing dates. Import warnings help you review these cases.

## Cloud storage without a paid server

The implemented option is **Google Drive**, using the application's own folder and JSON files. Google Docs is a text editor; Google Sheets is an alternative if editing the data directly as a spreadsheet is essential. Drive requires less configuration and preserves the application's complete data model. OneDrive is compatible with an existing Microsoft account; Supabase is more suitable for multiple users, but its free plan can pause inactive projects.

Drive setup requires an OAuth client ID created in your Google account. It does not require a banking password, client secret, or server. Authorization requests only `drive.appdata`. The token stays in memory, and you may need to reconnect when it expires. Follow the [setup and comparison guide](docs/CLOUD.md), with official sources and limits researched in October 2026.

On another computer, use the same OAuth client ID and **synchronize before starting**. Synchronization is triggered by the button and should be repeated after making changes. It merges the latest copies from your computers and saves a new copy to Drive, keeping previous copies. If the same record is edited on two computers, the edit with the latest timestamp wins. Keep the computers' clocks accurate. Deletions are also synchronized. Concurrent changes to fields of the same record are not merged individually. If two devices select the same imported installment into different rows, the latest row keeps that purchase; the other row retains its unrelated schedules and monthly overrides.

## Personal data and GitHub

The code does not include supplied files, personal statement filenames, real transactions, or backups. Test examples are fictional. `.gitignore` excludes workbooks, statements, credential files, keys, backups, and the `data`, `private`, and `backups` directories. A JSON backup contains your financial data; store it outside the repository. OAuth credentials and tokens are not included in backups or files uploaded to Drive.

Local data belongs to the browser profile and the site's origin and port. Another browser or a different port has separate storage. Clearing browser data or using an incognito window can erase the local copy. Export a backup or synchronize before doing so.

The application rename automatically migrates local data from the previous version and continues to recognize its backups and older Drive copies. The device ID is also preserved. Newly exported backups use the name `budget-backup-YYYY-MM-DD.json`.

The code is hosted in [cauesmelo/budget](https://github.com/cauesmelo/budget) and can be cloned on other computers. The application does not send your data to GitHub. To use static hosting, publish only the contents of `dist`, without statements or personal data, and register the corresponding HTTPS origin in the OAuth client. The project does not need hosting to run locally.

## Verification

```sh
npm test
npm run build
```

Tests cover calculations in cents, refunds, contributions, fixed/monthly/installment projections, Cerbasi indicators, duplicate commitments, migration, deletions, backup validation, and synchronization with mocked Google calls.

Optional tests are available for bank and card statement files. They read the files directly without copying them into the project:

```sh
PRIVATE_IMPORT_DIR="/path/outside/the/repository" npm run test:files
```

The default filenames are `statement.xls` and `invoice.xlsx`. To use other names, set `PRIVATE_BANK_FILE` and `PRIVATE_CARD_FILE` in your local environment; do not store personal filenames in the code. Without `PRIVATE_IMPORT_DIR`, private tests are skipped. Real Google authorization can only be validated after configuring your own OAuth client ID.

## Structure

`src/App.tsx` contains the screens. `src/lib/categories.ts` manages the category catalog and category migration. `src/lib/importers.ts` reads supported formats. `src/lib/finance.ts` calculates totals, projections, and merges. `src/lib/storage.ts` validates and stores data in IndexedDB. `src/lib/drive.ts` handles Google authorization and copy synchronization. The application uses React, TypeScript, Vite, Recharts, and the official SheetJS CE distribution.
