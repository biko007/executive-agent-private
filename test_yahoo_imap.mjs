import { ImapFlow } from "imapflow";

const client = new ImapFlow({
  host: "imap.mail.yahoo.com",
  port: 993,
  secure: true,
  auth: {
    user: process.env.YAHOO_USER,
    pass: process.env.YAHOO_APP_PASSWORD
  }
});

try {
  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  try {
    const status = await client.status("INBOX", { messages: true, unseen: true });
    console.log("✅ Connected. INBOX:", status);
  } finally {
    lock.release();
  }
  await client.logout();
} catch (e) {
  console.error("❌ IMAP failed:", e?.message || e);
  process.exitCode = 1;
}
