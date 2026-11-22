/**
 * Allow local browser extension popups/service workers (`chrome-extension://`,
 * `moz-extension://`) to call web2's local API routes without opening CORS to
 * arbitrary websites.
 */
export function withExtensionCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!/^(?:chrome|moz)-extension:\/\//i.test(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
