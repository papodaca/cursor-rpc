import { CursorRpcError } from "./errors.js";

export type EnvironmentName = "prod" | "playground" | "staging" | "dev-staging" | "localhost";

export type ResolvedEnvironment = {
  name: EnvironmentName | "custom";
  apiUrl: string;
  websiteUrl: string;
};

export type ResolveEnvironmentOptions = {
  apiEndpoint?: string;
  apiBaseUrl?: string;
  websiteUrl?: string;
  env?: Record<string, string | undefined>;
};

type EnvironmentRow = {
  name: EnvironmentName;
  apiUrl: string;
  websiteUrl: string;
};

const PROD: EnvironmentRow = { name: "prod", apiUrl: "https://api2.cursor.sh", websiteUrl: "https://cursor.com" };

const ENVIRONMENTS: readonly EnvironmentRow[] = [
  PROD,
  { name: "playground", apiUrl: "https://api.playground.cursor.sh", websiteUrl: "https://playground.cursor.com" },
  { name: "staging", apiUrl: "https://staging.cursor.sh", websiteUrl: "https://staging.cursor.sh" },
  { name: "dev-staging", apiUrl: "https://dev-staging.cursor.sh", websiteUrl: "https://dev-staging.cursor.sh" },
  { name: "localhost", apiUrl: "https://localhost:8000", websiteUrl: "https://localhost:8000" },
];

export function resolveEnvironment(options: ResolveEnvironmentOptions = {}): ResolvedEnvironment {
  const env = options.env ?? process.env;
  const apiCandidate = firstNonEmpty(
    options.apiEndpoint,
    options.apiBaseUrl,
    env.CURSOR_API_ENDPOINT,
    env.CURSOR_API_BASE_URL,
    PROD.apiUrl,
  );
  const websiteCandidate = firstOptional(options.websiteUrl, env.CURSOR_WEBSITE_URL);

  assertSafeConfiguredUrl(apiCandidate, "API URL");
  if (websiteCandidate !== undefined) {
    assertSafeConfiguredUrl(websiteCandidate, "website URL");
  }

  const matched = matchEnvironment(apiCandidate, websiteCandidate);
  if (matched !== undefined) {
    return matched;
  }

  const apiUrl = stripTrailingSlash(apiCandidate);
  const websiteUrl = websiteCandidate === undefined
    ? originOf(apiUrl)
    : stripTrailingSlash(websiteCandidate);
  return { name: "custom", apiUrl, websiteUrl };
}

function matchEnvironment(apiCandidate: string, websiteCandidate: string | undefined): ResolvedEnvironment | undefined {
  const candidates = [apiCandidate, websiteCandidate].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (!canMatchTable(candidate)) {
      continue;
    }
    const origin = originOf(candidate).toLowerCase();
    for (const row of ENVIRONMENTS) {
      if (originOf(row.apiUrl).toLowerCase() === origin || originOf(row.websiteUrl).toLowerCase() === origin) {
        return { name: row.name, apiUrl: row.apiUrl, websiteUrl: row.websiteUrl };
      }
    }
  }
  return undefined;
}

function canMatchTable(value: string): boolean {
  const url = parseHttpUrl(value, "URL");
  return url.hash === "" && url.search === "" && url.username === "" && url.password === "";
}

function assertSafeConfiguredUrl(value: string, label: string): void {
  if (value.includes("#")) {
    throw new CursorRpcError(`${label} must not contain #`, { code: "invalid_argument" });
  }
  parseHttpUrl(value, label);
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CursorRpcError(`${label} is not a valid URL`, { code: "invalid_argument" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CursorRpcError(`${label} must use http or https`, { code: "invalid_argument" });
  }
  if (url.username !== "" || url.password !== "") {
    throw new CursorRpcError(`${label} must not include userinfo`, { code: "invalid_argument" });
  }
  return url;
}

function originOf(value: string): string {
  return new URL(value).origin;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function firstOptional(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  const found = firstOptional(...values);
  if (found === undefined) {
    throw new CursorRpcError("API URL is missing", { code: "invalid_argument" });
  }
  return found;
}
