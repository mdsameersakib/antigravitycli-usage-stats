"use strict";

const vscode = require("vscode");
const fs = require("fs");
const https = require("https");
const http = require("http");
const childProcess = require("child_process");
const util = require("util");

const exec = util.promisify(childProcess.exec);

const LIVE_ENDPOINTS = {
  userStatus: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
  commandModelConfigs: "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
  userQuotaSummary: "/exa.language_server_pb.LanguageServerService/GetUserQuotaSummary",
  unleash: "/exa.language_server_pb.LanguageServerService/GetUnleashData"
};

const REQUEST_TIMEOUT_MS = 8000;
const HOUR_MS = 60 * 60 * 1000;

let statusBar;
let panel;
let refreshTimer;
let lastSnapshot;
let isRefreshing = false;

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "antigravityStats.showPanel";
  statusBar.text = "$(pulse) AG Stats";
  statusBar.tooltip = "Antigravity usage is loading";
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("antigravityStats.refresh", () => refresh(true)),
    vscode.commands.registerCommand("antigravityStats.showPanel", showPanel),
    vscode.commands.registerCommand("antigravityStats.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "antigravityStats");
    }),
    vscode.commands.registerCommand("antigravityStats.dumpRawQuota", dumpRawQuota),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("antigravityStats")) {
        scheduleRefresh(context);
        refresh(true);
      }
    })
  );

  scheduleRefresh(context);
  refresh(false);
}

function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

function scheduleRefresh(context) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const seconds = Math.max(5, getConfig().get("refreshIntervalSeconds", 15));
  refreshTimer = setInterval(() => refresh(false), seconds * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
}

async function refresh(showErrors) {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;

  try {
    const snapshot = await collectSnapshot();
    lastSnapshot = snapshot;
    updateStatusBar(snapshot);
    updatePanel(snapshot);
  } catch (error) {
    statusBar.text = "$(warning) AG Stats";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusBar.tooltip = `Antigravity Stats: ${error.message}`;

    if (showErrors) {
      vscode.window.showWarningMessage(`Antigravity Stats: ${error.message}`);
    }
  } finally {
    isRefreshing = false;
  }
}

async function collectSnapshot() {
  const now = Date.now();
  const liveQuota = await fetchLiveQuota().catch((error) => ({ error: error.message, models: [], account: null }));

  return {
    generatedAt: new Date(now),
    liveQuota
  };
}

async function fetchLiveQuota() {
  const raw = await fetchRawQuota();
  return parseQuotaResponse(raw.json, raw.shape);
}

async function fetchRawQuota() {
  const processInfo = await detectAntigravityProcess();
  const ports = await getListeningPorts(processInfo.pid);
  const apiPort = await findWorkingPort(ports, processInfo.csrfToken);

  try {
    const quotaSummary = await makeRequest(apiPort, processInfo.extensionPort, processInfo.csrfToken, LIVE_ENDPOINTS.userQuotaSummary, defaultRequestBody());
    const json = JSON.parse(quotaSummary);
    const parsed = parseQuotaResponse(json, "quotaSummary");
    if (parsed.models.length > 0) {
      return { json, shape: "quotaSummary" };
    }
  } catch {
    // Older Antigravity builds do not expose this endpoint.
  }

  try {
    const userStatus = await makeRequest(apiPort, processInfo.extensionPort, processInfo.csrfToken, LIVE_ENDPOINTS.userStatus, defaultRequestBody());
    return { json: JSON.parse(userStatus), shape: "userStatus" };
  } catch {
    const commandModels = await makeRequest(apiPort, processInfo.extensionPort, processInfo.csrfToken, LIVE_ENDPOINTS.commandModelConfigs, defaultRequestBody());
    return { json: JSON.parse(commandModels), shape: "commandModelConfigs" };
  }
}

function redactRawQuota(json) {
  const clone = JSON.parse(JSON.stringify(json));
  walkObject(clone, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    for (const key of Object.keys(node)) {
      if (/email/i.test(key)) {
        node[key] = "[redacted]";
      }
    }
  });
  return clone;
}

async function dumpRawQuota() {
  try {
    const raw = await fetchRawQuota();
    const redacted = redactRawQuota(raw.json);
    const text = `// Antigravity raw quota response (shape: ${raw.shape})\n` +
      `// Email fields have been redacted. Please double-check before sharing.\n` +
      `// This is for debugging the Weekly Limit calculation only.\n\n` +
      JSON.stringify(redacted, null, 2);

    const doc = await vscode.workspace.openTextDocument({ content: text, language: "jsonc" });
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage("Antigravity Stats: Raw quota JSON opened in a new editor tab. Review it, then share it to help fix the Weekly Limit calculation.");
  } catch (error) {
    vscode.window.showWarningMessage(`Antigravity Stats: Could not fetch raw quota JSON — ${error.message}`);
  }
}

async function detectAntigravityProcess() {
  const { stdout } = await exec("ps -ax -o pid=,command=");
  const lines = stdout.split(/\r?\n/);
  let sawCandidate = false;

  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2];
    const lower = command.toLowerCase();
    const isLanguageServer = lower.includes("language_server") || lower.includes("agentapi") || lower === "agy" || lower.endsWith("/agy") || lower.includes(" /agy");
    const isAntigravity = lower.includes("antigravity") || lower.includes("agy") || lower.includes(".gemini/antigravity-cli");

    if (!isLanguageServer || !isAntigravity) {
      continue;
    }

    sawCandidate = true;
    const csrfToken = extractFlag(command, "--csrf_token") || "";

    return {
      pid,
      csrfToken,
      extensionPort: parseNumber(extractFlag(command, "--extension_server_port"))
    };
  }

  throw new Error("Antigravity language server is not running. Open Antigravity to enable live quota.");
}

function extractFlag(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escaped}(?:=|\\s+)([^\\s]+)`, "i"));
  return match ? match[1] : null;
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getListeningPorts(pid) {
  const lsofPath = ["/usr/bin/lsof", "/usr/sbin/lsof"].find((candidate) => fs.existsSync(candidate));
  if (!lsofPath) {
    throw new Error("lsof is required to discover Antigravity's local API port.");
  }

  const { stdout } = await exec(`${lsofPath} -nP -iTCP -sTCP:LISTEN -p ${pid}`);
  return Array.from(stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
}

async function findWorkingPort(ports, csrfToken) {
  for (const port of ports) {
    try {
      await makeHttpsRequest(port, csrfToken, LIVE_ENDPOINTS.unleash, unleashRequestBody());
      return port;
    } catch {
      // Try the next local port.
    }
  }

  throw new Error("Could not find Antigravity's local quota API port.");
}

function makeRequest(httpsPort, httpPort, csrfToken, requestPath, body) {
  return makeHttpsRequest(httpsPort, csrfToken, requestPath, body).catch((error) => {
    if (httpPort && httpPort !== httpsPort) {
      return makeHttpRequest(httpPort, csrfToken, requestPath, body);
    }

    throw error;
  });
}

function makeHttpsRequest(port, csrfToken, requestPath, body) {
  return makeNodeRequest(https, port, csrfToken, requestPath, body, { rejectUnauthorized: false });
}

function makeHttpRequest(port, csrfToken, requestPath, body) {
  return makeNodeRequest(http, port, csrfToken, requestPath, body, {});
}

function makeNodeRequest(module, port, csrfToken, requestPath, body, extraOptions) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(body);
    const request = module.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken
        },
        ...extraOptions
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`Antigravity API returned HTTP ${response.statusCode}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Antigravity API request timed out"));
    });
    request.write(bodyText);
    request.end();
  });
}

function defaultRequestBody() {
  return {
    metadata: {
      ideName: "antigravity",
      extensionName: "antigravity-usage-tracker",
      ideVersion: "unknown",
      locale: "en"
    }
  };
}

function unleashRequestBody() {
  return {
    context: {
      properties: {
        devMode: "false",
        extensionVersion: "0.1.0",
        hasAnthropicModelAccess: "true",
        ide: "antigravity",
        ideVersion: "unknown",
        installationId: "antigravity-usage-tracker",
        language: "UNSPECIFIED",
        os: process.platform,
        requestedModelId: "MODEL_UNSPECIFIED"
      }
    }
  };
}

function parseQuotaResponse(response, shape) {
  if (!isOkCode(response.code)) {
    throw new Error("Antigravity quota API returned a non-OK response.");
  }

  const status = shape === "userStatus" ? response.userStatus || {} : response;
  const configs = findModelConfigs(status);
  const models = configs.map(parseModelQuota).filter(Boolean).sort(compareModelQuota);
  const planInfo = status.planStatus?.planInfo || {};

  return {
    error: null,
    account: {
      email: status.email || null,
      plan: planInfo.planDisplayName || planInfo.displayName || planInfo.productName || planInfo.planName || null
    },
    availablePromptCredits: status.planStatus?.availablePromptCredits ?? null,
    models
  };
}

function isOkCode(code) {
  if (code === undefined || code === null) {
    return true;
  }

  if (typeof code === "number") {
    return code === 0;
  }

  if (typeof code === "string") {
    return ["ok", "success", "0"].includes(code.toLowerCase());
  }

  return typeof code === "object" && code.isOK === true;
}

function getWeeklyResetDate() {
  const now = new Date();
  const resultDate = new Date(now);
  const day = resultDate.getUTCDay();
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  resultDate.setUTCDate(resultDate.getUTCDate() + daysUntilSunday);
  resultDate.setUTCHours(0, 0, 0, 0);
  return resultDate;
}

function parseModelQuota(config) {
  const quota = config.quotaInfo || config.quotaSummary || config.usageLimits || config.commandQuota || config;
  const label = config.label || config.displayName || config.name || config.modelOrAlias?.model || config.model || "Unknown model";
  const buckets = extractQuotaBuckets(quota);

  if (buckets.length === 0) {
    return null;
  }

  for (const bucket of buckets) {
    if (bucket.label === "Quota") {
      bucket.label = "Hourly";
    }
  }

  // Do not fabricate a "100% remaining" weekly bucket when the API didn't
  // actually report one -- that would misrepresent real usage. Leave it
  // absent here; getGroupedQuotas() fills in an honest "Unknown" bucket
  // (or a clearly-flagged estimate for Gemini) at the group level.
  const hasWeekly = buckets.some((b) => b.label === "Weekly");
  if (!hasWeekly) {
    buckets.push({
      label: "Weekly",
      remainingFraction: null,
      resetTime: getWeeklyResetDate(),
      used: null,
      limit: null,
      raw: {}
    });
  }

  const fractions = buckets.map((bucket) => bucket.remainingFraction).filter((value) => typeof value === "number");
  const resetTimes = buckets.map((bucket) => bucket.resetTime).filter(Boolean).sort((a, b) => a.getTime() - b.getTime());

  return {
    label,
    modelId: config.modelOrAlias?.model || config.model || config.modelId || null,
    buckets,
    remainingFraction: fractions.length > 0 ? Math.min(...fractions) : null,
    resetTime: resetTimes[0] || null,
    raw: quota
  };
}

function getGroupedQuotas(models, availablePromptCredits = null) {
  const groups = [
    {
      name: "GEMINI MODELS",
      description: "Gemini Flash, Gemini Pro",
      match: (m) => m.label.toLowerCase().includes("gemini")
    },
    {
      name: "CLAUDE AND GPT MODELS",
      description: "Claude Opus, Claude Sonnet, GPT-OSS",
      match: (m) => m.label.toLowerCase().includes("claude") || m.label.toLowerCase().includes("gpt")
    }
  ];

  const grouped = [];

  for (const grp of groups) {
    const matchedModels = models.filter(grp.match);
    if (matchedModels.length === 0) {
      continue;
    }

    let representativeModel = matchedModels.sort((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1))[0];
    
    const buckets = representativeModel.buckets.map((b) => {
      let label = b.label;
      if (label === "Hourly" || label === "Quota") {
        label = "Five Hour Limit";
      } else if (label === "Weekly") {
        label = "Weekly Limit";
      }
      return {
        ...b,
        label
      };
    });

    // IMPORTANT: when we cannot find real weekly data, we must NOT invent a
    // fake "100% / full quota" value. That would silently lie to the user.
    // Instead we mark remainingFraction as null, which the formatter renders
    // as "Unknown" rather than a false "Quota available".
    let weeklyBucket = buckets.find((b) => b.label === "Weekly Limit");
    if (!weeklyBucket) {
      weeklyBucket = {
        label: "Weekly Limit",
        remainingFraction: null,
        resetTime: getWeeklyResetDate(),
        used: null,
        limit: null,
        raw: {}
      };
      buckets.push(weeklyBucket);
    }

    // Best-effort estimate for Gemini's weekly bucket using prompt credits,
    // ONLY used as a fallback when no real weekly bucket was already parsed
    // directly from the API response. This guessed 500-credit cap is not
    // verified against real account data yet -- see dumpRawQuota command.
    if (
      grp.name === "GEMINI MODELS" &&
      weeklyBucket.remainingFraction === null &&
      typeof availablePromptCredits === "number"
    ) {
      weeklyBucket.remainingFraction = Math.max(0, Math.min(1.0, availablePromptCredits / 500));
      weeklyBucket.estimated = true;
    }

    const hasFiveHour = buckets.some((b) => b.label === "Five Hour Limit");
    if (!hasFiveHour) {
      const resetTime = representativeModel.resetTime || new Date(Date.now() + 5 * 60 * 60 * 1000);
      buckets.push({
        label: "Five Hour Limit",
        remainingFraction: representativeModel.remainingFraction ?? null,
        resetTime: resetTime,
        used: null,
        limit: null,
        raw: {}
      });
    }

    buckets.sort((a, b) => {
      if (a.label === "Weekly Limit") return -1;
      if (b.label === "Weekly Limit") return 1;
      return 0;
    });

    grouped.push({
      name: grp.name,
      description: grp.description,
      buckets
    });
  }

  return grouped;
}


function formatGroupedBucket(bucket) {
  if (typeof bucket.remainingFraction !== "number") {
    return "Unknown (Antigravity did not report this value)";
  }
  const percent = Math.round(bucket.remainingFraction * 100);
  const estimateNote = bucket.estimated ? " (estimated)" : "";
  if (percent >= 100) {
    return `Quota available${estimateNote}`;
  }
  const refreshes = bucket.resetTime ? ` · Refreshes in ${formatDuration(bucket.resetTime)}` : "";
  return `${percent}% remaining${estimateNote}${refreshes}`;
}

function formatDuration(date) {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "0m";
  const diffMins = Math.round(diffMs / (60 * 1000));
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function makeProgressBar(fraction) {
  const percent = typeof fraction === "number" ? fraction * 100 : 100;
  const size = 50;
  const filledSize = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
  const emptySize = size - filledSize;
  const bar = "█".repeat(filledSize) + "░".repeat(emptySize);
  return `[${bar}] ${percent.toFixed(2)}%`;
}

function findModelConfigs(value) {
  const direct = value.cascadeModelConfigData?.clientModelConfigs || value.clientModelConfigs || value.modelConfigs || value.models;
  if (Array.isArray(direct)) {
    return direct;
  }

  const arrays = [];
  walkObject(value, (node, pathParts) => {
    if (!Array.isArray(node)) {
      return;
    }

    const hasQuotaModels = node.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }

      const serializedPath = pathParts.join(".").toLowerCase();
      return (serializedPath.includes("model") || item.model || item.modelId || item.modelOrAlias || item.label) && hasQuotaShape(item);
    });

    if (hasQuotaModels) {
      arrays.push(node);
    }
  });

  return arrays.sort((a, b) => b.length - a.length)[0] || [];
}

function hasQuotaShape(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (value.quotaInfo || value.quotaSummary || value.usageLimits || value.commandQuota) {
    return true;
  }

  return Object.keys(value).some((key) => /quota|limit|remaining|reset|usage/i.test(key));
}

function extractQuotaBuckets(quota) {
  const buckets = [];

  walkObject(quota, (node, pathParts) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }

    const remainingFraction = readFraction(node);
    const resetTime = parseResetTime(readFirst(node, ["resetTime", "resetAt", "resetsAt", "nextResetTime"]));
    const used = readNumber(readFirst(node, ["used", "usedCount", "consumed", "consumedCount", "usage"]));
    const limit = readNumber(readFirst(node, ["limit", "max", "maximum", "total", "quota", "capacity"]));
    const hasUsefulQuota = remainingFraction !== null || resetTime || (used !== null && limit !== null);

    if (!hasUsefulQuota) {
      return;
    }

    buckets.push({
      label: quotaBucketLabel(pathParts, node),
      remainingFraction,
      resetTime,
      used,
      limit,
      raw: node
    });
  });

  return dedupeBuckets(buckets);
}

function walkObject(value, visitor, pathParts = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  visitor(value, pathParts);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObject(item, visitor, pathParts.concat(String(index)), seen));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkObject(child, visitor, pathParts.concat(key), seen);
  }
}

function readFraction(node) {
  const remaining = readNumber(readFirst(node, ["remainingFraction", "remainingRatio", "remainingPercent", "remainingPercentage"]));
  if (remaining !== null) {
    return remaining > 1 ? remaining / 100 : remaining;
  }

  const used = readNumber(readFirst(node, ["used", "usedCount", "consumed", "consumedCount", "usage"]));
  const limit = readNumber(readFirst(node, ["limit", "max", "maximum", "total", "quota", "capacity"]));
  if (used !== null && limit && limit > 0) {
    return Math.max(0, Math.min(1, 1 - used / limit));
  }

  return null;
}

function readFirst(node, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(node, name)) {
      return node[name];
    }
  }

  return undefined;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quotaBucketLabel(pathParts, node) {
  const explicit = readFirst(node, ["label", "displayName", "name", "period", "bucket", "window"]);
  if (explicit && typeof explicit !== "object") {
    return titleCase(String(explicit));
  }

  const text = pathParts.join(" ").toLowerCase();
  if (/hourly|perhour|per_hour|\bhour\b/.test(text)) {
    return "Hourly";
  }
  if (/weekly|perweek|per_week|\bweek\b/.test(text)) {
    return "Weekly";
  }
  if (/daily|perday|per_day|\bday\b/.test(text)) {
    return "Daily";
  }
  if (/monthly|permonth|per_month|\bmonth\b/.test(text)) {
    return "Monthly";
  }

  const lastUseful = pathParts.filter((part) => !/^\d+$/.test(part)).at(-1);
  return lastUseful ? titleCase(lastUseful.replace(/[_-]/g, " ")) : "Quota";
}

function titleCase(value) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dedupeBuckets(buckets) {
  const seen = new Set();
  return buckets.filter((bucket) => {
    const key = [
      bucket.label,
      bucket.remainingFraction,
      bucket.resetTime?.getTime() || "",
      bucket.used ?? "",
      bucket.limit ?? ""
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseResetTime(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function compareModelQuota(a, b) {
  return modelRank(a.label) - modelRank(b.label) || a.label.localeCompare(b.label);
}

function modelRank(label) {
  const lower = label.toLowerCase();
  if (lower.includes("claude") && lower.includes("sonnet") && !lower.includes("thinking")) return 1;
  if (lower.includes("claude") && lower.includes("sonnet")) return 2;
  if (lower.includes("claude") && lower.includes("opus")) return 3;
  if (lower.includes("gpt")) return 4;
  if (lower.includes("gemini") && lower.includes("pro") && lower.includes("high")) return 5;
  if (lower.includes("gemini") && lower.includes("pro")) return 6;
  if (lower.includes("gemini") && lower.includes("flash")) return 7;
  return 20;
}

function updateStatusBar(snapshot) {
  const config = getConfig();
  const mode = config.get("statusBarMode", "lowest");
  const bestQuota = selectStatusQuota(snapshot.liveQuota.models, mode);
  const quotaText = bestQuota ? `${bestQuota.labelShort} ${formatStatusPercent(bestQuota.remainingPercent)}` : "live off";

  statusBar.text = `$(rocket) AG ${quotaText}`;

  const warningThreshold = config.get("warningRemainingPercent", 20);
  const isWarning = bestQuota && bestQuota.remainingPercent <= warningThreshold;
  statusBar.backgroundColor = isWarning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

  const tooltipMd = new vscode.MarkdownString(buildTooltip(snapshot), true);
  tooltipMd.isTrusted = true;
  statusBar.tooltip = tooltipMd;
}

function selectStatusQuota(models, mode) {
  const flattened = models.flatMap((model) => model.buckets.map((bucket) => ({ model, bucket })));
  const withPercent = flattened.filter((item) => typeof item.bucket.remainingFraction === "number");
  const item = mode === "first"
    ? flattened[0]
    : withPercent.sort((a, b) => a.bucket.remainingFraction - b.bucket.remainingFraction)[0] || flattened[0];
  if (!item) {
    return null;
  }

  return {
    ...item.model,
    bucket: item.bucket,
    labelShort: `${compactModelLabel(item.model.label)} ${item.bucket.label}`,
    remainingPercent: typeof item.bucket.remainingFraction === "number" ? Math.round(item.bucket.remainingFraction * 100) : null
  };
}

function compactModelLabel(label) {
  return label
    .replace(/^gemini\s*/i, "G")
    .replace(/^claude\s*/i, "C")
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
}

function formatStatusPercent(value) {
  return typeof value === "number" ? `${value}%` : "unknown";
}

function buildTooltip(snapshot) {
  const lines = [];
  lines.push("**Antigravity CLI Usage Quota**");
  lines.push("");

  if (snapshot.liveQuota.error) {
    lines.push(`$(warning) *Live quota unavailable: ${snapshot.liveQuota.error}*`);
    lines.push("");
  } else if (snapshot.liveQuota.models.length > 0) {
    const groups = getGroupedQuotas(snapshot.liveQuota.models, snapshot.liveQuota.availablePromptCredits);
    for (const group of groups) {
      lines.push(`**${group.name}** *(${group.description})*  `);
      for (const bucket of group.buckets) {
        lines.push(`${bucket.label}: ${formatGroupedBucket(bucket)}  `);
      }
      lines.push("");
    }
  } else {
    lines.push("$(info) *No model quota data returned*");
    lines.push("");
  }

  lines.push("[$(sync) Refresh](command:antigravityStats.refresh)&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;[$(link-external) Open Details](command:antigravityStats.showPanel)");

  return lines.join("\n");
}

function showPanel() {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "antigravityStats",
      "Antigravity Usage",
      vscode.ViewColumn.One,
      { enableScripts: false }
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }

  updatePanel(lastSnapshot);
  refresh(false);
}

function updatePanel(snapshot) {
  if (!panel) {
    return;
  }

  panel.webview.html = snapshot ? renderPanel(snapshot) : renderLoadingPanel();
}

function renderLoadingPanel() {
  return htmlPage("<main><h1>Antigravity Usage</h1><p>Loading usage data...</p></main>");
}

function renderPanel(snapshot) {
  const showEmail = getConfig().get("showAccountEmail", false);
  const accountLines = [];

  if (snapshot.liveQuota.account?.plan) {
    accountLines.push(`<span>${escapeHtml(snapshot.liveQuota.account.plan)}</span>`);
  }
  if (showEmail && snapshot.liveQuota.account?.email) {
    accountLines.push(`<span>${escapeHtml(snapshot.liveQuota.account.email)}</span>`);
  }

  const quotaHtml = snapshot.liveQuota.error
    ? `<div class="notice">Live quota unavailable: ${escapeHtml(snapshot.liveQuota.error)}</div>`
    : renderQuotaCards(snapshot.liveQuota.models, snapshot.liveQuota.availablePromptCredits);

  return htmlPage(`
    <main>
      <header>
        <div>
          <h1>Antigravity Usage</h1>
          <p>Live model quotas from Antigravity</p>
        </div>
        <div class="meta">
          ${accountLines.join("")}
          <span>Updated ${escapeHtml(formatTime(snapshot.generatedAt))}</span>
        </div>
      </header>

      <section>
        <h2>Model Quotas</h2>
        ${quotaHtml}
      </section>

      <section>
        <h2>Notes</h2>
        <p>This extension only displays Antigravity quota data returned by the running local Antigravity API. It does not estimate quotas from prompt counts or local logs.</p>
      </section>
    </main>
  `);
}

function renderQuotaCards(models, availablePromptCredits) {
  const groups = getGroupedQuotas(models, availablePromptCredits);
  if (groups.length === 0) {
    return `<div class="notice">No live quota models were returned.</div>`;
  }

  return `<div class="quota-list">${groups
    .map((group) => {
      return `
        <article class="quota-card">
          <div class="quota-heading" style="display: block;">
            <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 4px;">${escapeHtml(group.name)}</h3>
            <span style="font-size: 12px; color: var(--muted);">Models within this group: ${escapeHtml(group.description)}</span>
          </div>
          <div class="bucket-list" style="margin-top: 18px;">
            ${group.buckets.map((bucket) => bucketRow(bucket)).join("")}
          </div>
        </article>
      `;
    })
    .join("")}</div>`;
}

function bucketRow(bucket) {
  const hasData = typeof bucket.remainingFraction === "number";
  const percent = hasData ? Math.round(bucket.remainingFraction * 100) : 0;
  return `
    <div class="bucket-row" style="margin-top: 16px;">
      <div class="bucket-title" style="display: flex; justify-content: space-between; align-items: baseline;">
        <span style="font-size: 13px; font-weight: 600;">${escapeHtml(bucket.label)}</span>
        <strong style="font-size: 12px; font-weight: 500; color: var(--muted);">${escapeHtml(formatGroupedBucket(bucket))}</strong>
      </div>
      ${hasData ? `<div class="bar" style="margin: 8px 0 0 0;"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>` : ""}
    </div>
  `;
}

function formatBucket(bucket) {
  const pieces = [];
  if (typeof bucket.remainingFraction === "number") {
    pieces.push(`${Math.round(bucket.remainingFraction * 100)}% left`);
  }
  if (bucket.used !== null && bucket.limit !== null) {
    pieces.push(`${bucket.used}/${bucket.limit}`);
  }
  if (bucket.resetTime) {
    pieces.push(`resets ${formatRelativeTime(bucket.resetTime)}`);
  }
  return pieces.length > 0 ? pieces.join(", ") : "unknown";
}

function htmlPage(body) {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <style>
          :root {
            color-scheme: light dark;
            --border: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
            --muted: color-mix(in srgb, var(--vscode-foreground) 68%, transparent);
            --surface: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
            --accent: var(--vscode-charts-green);
          }
          body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
          }
          main {
            max-width: 980px;
            margin: 0 auto;
            padding: 28px 24px 40px;
          }
          header {
            display: flex;
            justify-content: space-between;
            gap: 18px;
            align-items: flex-start;
            border-bottom: 1px solid var(--border);
            padding-bottom: 18px;
            margin-bottom: 22px;
          }
          h1, h2, h3, p {
            margin: 0;
          }
          h1 {
            font-size: 26px;
            line-height: 1.2;
          }
          h2 {
            font-size: 16px;
            margin: 26px 0 12px;
          }
          h3 {
            font-size: 13px;
            font-weight: 600;
          }
          p, small, .meta, header p {
            color: var(--muted);
          }
          .meta {
            display: flex;
            flex-direction: column;
            gap: 4px;
            text-align: right;
            font-size: 12px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
            gap: 10px;
          }
          .quota-card, .notice {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 14px;
          }
          .quota-list {
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
          }
          .quota-heading {
            display: flex;
            justify-content: space-between;
            gap: 14px;
            align-items: center;
          }
          .quota-heading strong {
            color: var(--muted);
            font-size: 12px;
            font-weight: 500;
          }
          .bucket-list {
            display: grid;
            gap: 12px;
            margin-top: 14px;
          }
          .bucket-title {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: baseline;
          }
          .bucket-title span {
            font-size: 13px;
            font-weight: 600;
          }
          .bucket-title strong {
            font-size: 13px;
            text-align: right;
          }
          .bar {
            height: 8px;
            overflow: hidden;
            border-radius: 999px;
            background: color-mix(in srgb, var(--vscode-foreground) 13%, transparent);
            margin: 12px 0 10px;
          }
          .bar span {
            display: block;
            height: 100%;
            border-radius: inherit;
            background: var(--accent);
          }
          @media (max-width: 640px) {
            main {
              padding: 20px 16px 32px;
            }
            header {
              flex-direction: column;
            }
            .meta {
              text-align: left;
            }
          }
        </style>
      </head>
      <body>${body}</body>
    </html>`;
}

function getConfig() {
  return vscode.workspace.getConfiguration("antigravityStats");
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatRelativeTime(date) {
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const units = [
    ["day", 24 * HOUR_MS],
    ["hour", HOUR_MS],
    ["minute", 60 * 1000]
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (const [unit, size] of units) {
    if (absMs >= size || unit === "minute") {
      return formatter.format(Math.round(diffMs / size), unit);
    }
  }

  return formatTime(date);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  activate,
  deactivate
};