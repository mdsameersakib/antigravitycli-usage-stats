# Antigravity CLI Usage Stats

A lightweight VS Code extension to monitor your local Antigravity CLI model quotas and rate limits from your status bar.

---

## Overview

This extension provides developers with clear, real-time visibility into the rate limits of models running under the Antigravity CLI environment. By parsing status values from your local machine, it helps you manage your development limits without leaving your editor.

---

## Screenshots

### Status Bar and Hover Tooltip
![Hover Screenshot](https://raw.githubusercontent.com/mdsameersakib/antigravitycli-usage-stats/refs/heads/main/media/hover-screenshot.png)

### Details Panel Webview
![Details Panel Screenshot](https://raw.githubusercontent.com/mdsameersakib/antigravitycli-usage-stats/refs/heads/main/media/details-screenshot.png)

---

## Core Capabilities

- **Status Bar Integration**: Displays a clean, minimal status string showing your critical remaining model percentage and time until refresh (e.g. `56% - 1h 55m`).
- **Organized Tooltip**: Displays a clean summary of Gemini and Claude/GPT model pools in separate categories when you hover over the status bar item.
- **Interactive Details View**: Provides a premium webview panel showing limit progress bars that change colors dynamically to reflect remaining quota levels.
- **Adaptive Warnings**: Changes the status bar background color to warn you when remaining usage falls below a customizable threshold.
- **Selective Refresh Feedback**: Triggers a spinning sync indicator in the status bar only when you manually initiate a refresh, keeping background updates silent.

---

## Architecture and Process

All quota information is queried directly from the local Antigravity server running on your machine. The extension automatically detects the running `agy` process, scans for the correct local port, and fetches status data from the local `/exa.language_server_pb.LanguageServerService/GetUserStatus` endpoint securely.

---

## Visual Design and Alerts

Remaining quota status percentages are styled dynamically according to the following rules:

- **Plentiful (76% to 100%)**: Rendered in green (`#4CAF50`).
- **Moderate (26% to 75%)**: Rendered in orange (`#FF9800`).
- **Low (11% to 25%)**: Rendered in red-orange (`#FF5722`).
- **Critical (0% to 10%)**: Rendered in crimson red (`#D32F2F`).

---

## Installation

To compile and install the extension:

1. Open the extension folder in your terminal:
   ```bash
   cd antigravity-usage-tracker
   ```
2. Build the extension package:
   ```bash
   npx @vscode/vsce package
   ```
3. In VS Code, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`), select **Extensions: Install from VSIX...**, and choose the generated `.vsix` file.

---

## Configuration

Customize the extension settings under the `antigravityStats` prefix:

- `refreshIntervalSeconds`: The interval in seconds for background polling (default: `15`, minimum: `5`).
- `statusBarMode`: Controls which quota to summarize in the status bar (`lowest` remaining or `first`).
- `warningRemainingPercent`: The remaining percentage threshold that triggers a status bar warning color (default: `20`).
- `showAccountEmail`: Enables displaying your account email in the Details Panel (default: `false`).

---

## Note on Weekly Limits

Weekly quota allocations are managed and validated on Google's cloud servers. Since they are not exposed by the local Antigravity server API, this extension excludes them to ensure you only see accurate, local rate limits.

---

## Open Source and Transparency

This extension is 100% open-source! If you want to audit the code or inspect how the local server communication is handled, you can check the complete source code directly on our GitHub repository: [mdsameersakib/antigravitycli-usage-stats](https://github.com/mdsameersakib/antigravitycli-usage-stats).

---

## Privacy

All operations run entirely on your local machine. The extension does not read private OAuth credential files, handle Google authorization tokens, or transmit telemetry to external servers.
