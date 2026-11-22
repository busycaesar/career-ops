import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";

/**
 * Google sign-in for web2. The OAuth client the user created lives in
 * data/google-oauth-client.json; the refresh token web2 gets back is kept in
 * data/google-token.json. Both are in the gitignored user data folder.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// drive.file only: web2 sees just the files it creates itself (its CV folder,
// master resume and tailored copies), never the rest of the user's Drive.
// The Docs API accepts it for those same files.
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const EXPIRY_MARGIN_MS = 60_000;

type OAuthClient = { client_id: string; client_secret: string; redirect_uris: string[] };
type StoredToken = { refresh_token: string; access_token?: string; expires_at?: number };

function clientFile(): string {
  return path.join(careerOpsRoot(), "data", "google-oauth-client.json");
}

function tokenFile(): string {
  return path.join(careerOpsRoot(), "data", "google-token.json");
}

function readClient(): OAuthClient {
  let parsed: Record<string, OAuthClient>;
  try {
    parsed = JSON.parse(fs.readFileSync(clientFile(), "utf8"));
  } catch (err) {
    throw new Error(`Could not read the Google OAuth client at ${clientFile()}: ${(err as Error).message}`);
  }
  const client = parsed.web ?? parsed.installed;
  if (!client?.client_id || !client.client_secret || !client.redirect_uris?.length) {
    throw new Error(`${clientFile()} is not a Google OAuth client file (no client_id, client_secret or redirect_uris).`);
  }
  return client;
}

function readToken(): StoredToken | null {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), "utf8")) as StoredToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function saveToken(token: StoredToken): void {
  atomicWrite(tokenFile(), `${JSON.stringify(token, null, 2)}\n`);
  fs.chmodSync(tokenFile(), 0o600);
}

/**
 * What Google's file picker needs in the browser: a short-lived access token,
 * the API key the user created for the Picker API (GOOGLE_API_KEY), and the
 * Cloud project number (the leading digits of the OAuth client id), which ties
 * the picked files to this app's drive.file permission.
 */
export async function pickerConfig(): Promise<{ accessToken: string; apiKey: string; appId: string }> {
  const appId = readClient().client_id.split("-")[0];
  return { accessToken: await googleAccessToken(), apiKey: readApiKey(), appId };
}

const API_KEY_LINE = /^\s*GOOGLE_API_KEY\s*=\s*(.*?)\s*$/;

/** GOOGLE_API_KEY from the environment, else from the data folder's .env. */
function readApiKey(): string {
  if (process.env.GOOGLE_API_KEY?.trim()) return process.env.GOOGLE_API_KEY.trim();
  const envFile = path.join(careerOpsRoot(), ".env");
  let text = "";
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = API_KEY_LINE.exec(line);
    const value = match?.[1].replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) return value;
  }
  throw new Error(`No GOOGLE_API_KEY in the environment or in ${envFile}. Add your Google Picker API key there.`);
}

export function isGoogleConnected(): boolean {
  return Boolean(readToken()?.refresh_token);
}

export function googleConsentUrl(state: string): string {
  const client = readClient();
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const client = readClient();
  const body = await postToken({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: client.redirect_uris[0],
    grant_type: "authorization_code",
  });
  const granted = new Set((body.scope ?? "").split(" "));
  const missing = SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw new Error(`Google did not grant every permission web2 needs (missing: ${missing.join(", ")}). Click Reconnect and tick every checkbox on Google's consent screen.`);
  }
  if (!body.refresh_token) throw new Error("Google did not return a refresh token. Remove web2's access at myaccount.google.com/permissions and connect again.");
  saveToken({ refresh_token: body.refresh_token, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 });
}

/** A valid access token, refreshed when the stored one is about to expire. */
export async function googleAccessToken(): Promise<string> {
  const token = readToken();
  if (!token?.refresh_token) throw new Error("Google Drive is not connected. Connect it from web2's Settings page.");
  if (token.access_token && token.expires_at && token.expires_at - EXPIRY_MARGIN_MS > Date.now()) return token.access_token;
  const client = readClient();
  const body = await postToken({
    refresh_token: token.refresh_token,
    client_id: client.client_id,
    client_secret: client.client_secret,
    grant_type: "refresh_token",
  });
  saveToken({ ...token, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };

async function postToken(fields: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);
  return body;
}
