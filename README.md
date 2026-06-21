# Antigravity Usage Tracker

VS Code extension for tracking Antigravity CLI usage from the local machine.

It shows live model quota percentages and reset times when Antigravity is running. When Antigravity returns separate quota buckets, the extension keeps them separate so hourly and weekly limits can be shown per model.

## Run Locally

1. Open `extensions/antigravity-usage-tracker` in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Run `Antigravity Stats: Show Usage Panel` from the command palette.

No build step is required because the extension is plain CommonJS JavaScript.

## Settings

- `antigravityStats.refreshIntervalSeconds`: refresh interval, minimum 15 seconds.
- `antigravityStats.statusBarMode`: `lowest` or `first`.
- `antigravityStats.warningRemainingPercent`: status bar warning threshold.
- `antigravityStats.showAccountEmail`: disabled by default.

## Accuracy Note

Antigravity quotas are work-based, not simple request-count limits. This extension does not estimate quota from local prompt counts. It displays the live quota data returned by Antigravity's local API.
