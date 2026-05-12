import "dotenv/config";

const tenant = process.env.M365_TENANT_ID;
const clientId = process.env.M365_CLIENT_ID;
const clientSecret = process.env.M365_CLIENT_SECRET;
const user = process.env.M365_USER || "juergen.bickel@bikolino.com";

if (!tenant || !clientId || !clientSecret) {
  console.error("Missing env: M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET");
  process.exit(1);
}

async function getToken() {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default"
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Token error ${res.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function graphGet(path, token) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Graph error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  const token = await getToken();

  // List next 10 events ordered by start time
  const data = await graphGet(
    `/users/${encodeURIComponent(user)}/events?$top=10&$orderby=start/dateTime`,
    token
  );

  console.log(`✅ Got ${data.value?.length || 0} events for ${user}`);
  for (const ev of data.value || []) {
    console.log(`- ${ev.subject || "(no subject)"} | ${ev.start?.dateTime} -> ${ev.end?.dateTime}`);
  }
})().catch(e => {
  console.error("❌ Calendar test failed:", e.message);
  process.exit(1);
});
