import fs from "node:fs";
import path from "node:path";

// Lazy-load playwright to avoid import errors if not installed yet
let pw: typeof import("playwright") | null = null;
async function loadPlaywright() {
  if (!pw) pw = await import("playwright");
  return pw;
}

// ── Lazy Singleton Browser ──────────────────────────────────────────────────

let browserInstance: import("playwright").Browser | null = null;
let contextInstance: import("playwright").BrowserContext | null = null;

async function getBrowser(): Promise<import("playwright").Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  const { chromium } = await loadPlaywright();
  browserInstance = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browserInstance;
}

async function getContext(): Promise<import("playwright").BrowserContext> {
  if (contextInstance) return contextInstance;
  const browser = await getBrowser();
  contextInstance = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  return contextInstance;
}

// ── URL Validation ──────────────────────────────────────────────────────────

function validateUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const parsed = new URL(url); // throws on invalid
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Nur http/https URLs erlaubt");
  }
  return parsed.href;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function openPage(
  rawUrl: string,
  options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
): Promise<{ title: string; content: string; url: string }> {
  const url = validateUrl(rawUrl);
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, {
      waitUntil: options?.waitUntil || "domcontentloaded",
      timeout: 30000,
    });
    const title = await page.title();
    let content = await page.evaluate(() => {
      const el = document.querySelector("article") || document.querySelector("main") || document.body;
      return el?.innerText || "";
    });
    if (content.length > 15000) content = content.slice(0, 15000) + "\n…(abgeschnitten)";
    return { title, content, url: page.url() };
  } finally {
    await page.close();
  }
}

export async function login(
  rawUrl: string,
  usernameSelector: string,
  passwordSelector: string,
  username: string,
  password: string,
): Promise<{ success: boolean; title: string; url: string; error?: string }> {
  const url = validateUrl(rawUrl);
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.fill(usernameSelector, username);
    await page.fill(passwordSelector, password);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    const title = await page.title();
    return { success: true, title, url: page.url() };
  } catch (e: any) {
    return { success: false, title: "", url, error: e.message };
  } finally {
    await page.close();
  }
}

export async function extractText(
  rawUrl: string,
  selector?: string,
): Promise<{ text: string; title: string; url: string }> {
  const url = validateUrl(rawUrl);
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    let text: string;
    if (selector) {
      const el = await page.$(selector);
      text = el ? (await el.innerText()) : "";
    } else {
      text = await page.evaluate(() => document.body.innerText || "");
    }
    if (text.length > 15000) text = text.slice(0, 15000) + "\n…(abgeschnitten)";
    return { text, title, url: page.url() };
  } finally {
    await page.close();
  }
}

export async function screenshot(rawUrl: string): Promise<string> {
  const url = validateUrl(rawUrl);
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const dir = path.join(
      process.env.HOME || "/root",
      ".openclaw/workspace/artifacts/personal/screenshots",
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const filePath = path.join(dir, filename);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (contextInstance) {
    await contextInstance.close().catch(() => {});
    contextInstance = null;
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
