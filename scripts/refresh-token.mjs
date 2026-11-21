// Refreshes a long-lived Threads token (valid 60 days; must be at least 24h old).
// Prints the new token to stdout so the workflow can store it as a secret.
const token = process.env.THREADS_ACCESS_TOKEN;
if (!token) {
  console.error("THREADS_ACCESS_TOKEN is not set.");
  process.exit(1);
}

const url = new URL("https://graph.threads.net/refresh_access_token");
url.search = new URLSearchParams({ grant_type: "th_refresh_token", access_token: token });

const res = await fetch(url);
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.access_token) {
  console.error(`Refresh failed: ${res.status} ${data.error?.message || JSON.stringify(data)}`);
  process.exit(1);
}

console.error(`Token refreshed; expires in ${Math.round(data.expires_in / 86400)} days.`);
process.stdout.write(data.access_token);
