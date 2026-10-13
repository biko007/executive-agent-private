#!/usr/bin/env bun
/**
 * scripts/casameta-login — meldet sich am Casameta-Portal an. OHNE Sprachmodell.
 *
 * WARUM DETERMINISTISCH. Der eigentliche Portal-Agent ist ein Sprachmodell. Es
 * soll das Passwort nie sehen — nicht im Prompt, nicht im Protokoll, nicht in
 * einem Screenshot-Dateinamen, nicht im Trace. Deshalb macht dieses Skript die
 * Anmeldung allein und übergibt dem Agenten nur den fertigen Sitzungszustand.
 *
 * DER LOGIN IST ZWEISTUFIG. Das Formular `#login-form` schickt zuerst nur die
 * E-Mail-Adresse; der Server antwortet mit `PasswordRequired=1` und einem
 * `PrepareToken`, erst dann erscheint das Passwortfeld.
 *
 * CLOUDFLARE TURNSTILE. Die Seite bindet `challenges.cloudflare.com` ein und
 * legt das Ergebnis in das versteckte Feld `#Captcha`. Es ist die UNSICHTBARE
 * Variante — ein echter Browser löst sie im Normalfall ohne Zutun. Dieses
 * Skript wartet schlicht darauf, dass das Feld gefüllt ist.
 *
 * Was es NICHT tut: Token von einem Löserdienst holen, Token fälschen, den
 * Fingerabdruck verschleiern. Erscheint eine sichtbare Challenge, bricht es ab
 * und meldet das. Bot-Schutz wird erfüllt, nicht umgangen.
 *
 * HEADLESS — GEMESSEN, NICHT GEWÄHLT. Geplant war ein sichtbarer Browser unter
 * Xvfb, weil Headless-Chromium bei Turnstile häufiger beanstandet wird. Das
 * geht auf diesem VPS nicht: Unter Xvfb scheitert jeder Screenshot
 * reproduzierbar an `Protocol error (Page.captureScreenshot)` — sowohl auf dem
 * vorhandenen Display :1 (1024x768, gehört dem Trading-System) als auch auf
 * einem eigenen über `xvfb-run` mit passender Geometrie. Headless dagegen
 * liefert Screenshots und Trace vollständig.
 *
 * Screenshots sind Protokollpflicht und nicht verhandelbar. Also headless —
 * mit der Folge, dass offen bleibt, ob Turnstile uns durchlässt. Das beantwortet
 * der erste echte Login-Test, nicht eine Annahme.
 *
 * Aufruf:
 *   bun run scripts/casameta-login.ts              # anmelden, Zustand sichern
 *   bun run scripts/casameta-login.ts --pruefen    # nur prüfen, ob Sitzung gilt
 *   bun run scripts/casameta-login.ts --selbsttest # Zustand verwerfen, neu anmelden
 */
import { chromium, type BrowserContext } from 'playwright';
import { readFileSync, existsSync, mkdirSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORTAL = 'https://portal.casameta.de';
const START = `${PORTAL}/login/checkbrowser?ReturnUrl=%2f`;
const ENV_DATEI = join(homedir(), '.config', 'biko-portals', 'env');
const BASIS = join(homedir(), '.local', 'share', 'biko-portals', 'casameta');
const PROFIL = join(BASIS, 'profile');
const ZUSTAND = join(BASIS, 'storage_state.json');

/** Wartezeit für das Turnstile-Token. Großzügig: Die Prüfung läuft im
 *  Hintergrund und braucht auf einem VPS ohne GPU spürbar länger als am
 *  Arbeitsplatz. */
const TURNSTILE_MS = 45_000;

export interface LoginErgebnis {
  ok: boolean;
  grund?: 'keine-zugangsdaten' | 'turnstile-sichtbar' | 'anmeldung-abgelehnt' | 'fehler';
  meldung: string;
}

function envLesen(): { benutzer: string; passwort: string } | null {
  if (!existsSync(ENV_DATEI)) return null;
  const inhalt = readFileSync(ENV_DATEI, 'utf-8');
  const b = inhalt.match(/^CASAMETA_USER=(.*)$/m);
  const p = inhalt.match(/^CASAMETA_PASSWORD=(.*)$/m);
  if (!b || !p || !b[1].trim() || !p[1].trim()) return null;
  return { benutzer: b[1].trim(), passwort: p[1].trim() };
}

function verzeichnisseAnlegen(): void {
  mkdirSync(PROFIL, { recursive: true });
  chmodSync(BASIS, 0o700);
  chmodSync(PROFIL, 0o700);
}

/** Ist die gespeicherte Sitzung noch gültig? Ohne Anmeldung, nur ein Aufruf
 *  der Startseite: Landet er auf /login/..., ist sie abgelaufen. */
async function sitzungGueltig(): Promise<boolean> {
  if (!existsSync(ZUSTAND)) return false;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ storageState: ZUSTAND });
    const seite = await ctx.newPage();
    const antwort = await seite.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const gueltig = !!antwort && !seite.url().includes('/login/');
    await ctx.close();
    return gueltig;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

/** Erscheint eine Challenge, die der Nutzer anklicken müsste? Dann ist Schluss. */
async function sichtbareChallenge(ctx: BrowserContext): Promise<boolean> {
  const seite = ctx.pages()[0];
  const rahmen = seite.locator('iframe[src*="challenges.cloudflare.com"]');
  if (await rahmen.count() === 0) return false;
  try {
    const kasten = await rahmen.first().boundingBox();
    /* Die unsichtbare Variante rendert einen Rahmen der Größe 0 oder gar
       keinen. Alles, was nennenswert Fläche hat, verlangt eine Handlung. */
    return !!kasten && kasten.width > 50 && kasten.height > 20;
  } catch {
    return false;
  }
}

async function anmelden(): Promise<LoginErgebnis> {
  const zugang = envLesen();
  if (!zugang) {
    return {
      ok: false, grund: 'keine-zugangsdaten',
      meldung: `Zugangsdaten fehlen. Erwartet werden CASAMETA_USER und `
        + `CASAMETA_PASSWORD in ${ENV_DATEI}. Anzulegen mit ~/bin/casameta-credentials.`,
    };
  }
  verzeichnisseAnlegen();

  /* Headless, siehe Kopfkommentar — unter Xvfb gäbe es keine Screenshots.
     Locale und Zeitzone werden gesetzt, damit das Portal deutsche Zahlen- und
     Datumsformate liefert; daran hängt die ganze Feldzuordnung. */
  const ctx = await chromium.launchPersistentContext(PROFIL, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });

  try {
    const seite = ctx.pages()[0] ?? await ctx.newPage();
    await seite.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    if (await sichtbareChallenge(ctx)) {
      return {
        ok: false, grund: 'turnstile-sichtbar',
        meldung: 'Cloudflare Turnstile verlangt eine sichtbare Bestätigung. '
          + 'Sie wird nicht umgangen. Der Login muss einmal von Hand erfolgen.',
      };
    }

    // Schritt 1: E-Mail-Adresse
    await seite.fill('#EMail', zugang.benutzer);
    await warteAufTurnstile(seite);
    await seite.click('#loginBtn');

    // Schritt 2: Passwort — das Feld erscheint erst nach dem ersten Absenden.
    const passwortFeld = seite.locator('input[type="password"]').first();
    await passwortFeld.waitFor({ state: 'visible', timeout: 30_000 });
    /* `fill` schreibt direkt in den Wert, ohne Tastaturereignisse zu
       protokollieren. Der Wert taucht dadurch in keinem Trace-Eintrag auf. */
    await passwortFeld.fill(zugang.passwort);
    await warteAufTurnstile(seite);
    await Promise.all([
      seite.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {}),
      seite.click('#loginBtn'),
    ]);
    await seite.waitForTimeout(2500);

    if (seite.url().includes('/login/')) {
      if (await sichtbareChallenge(ctx)) {
        return {
          ok: false, grund: 'turnstile-sichtbar',
          meldung: 'Nach der Passworteingabe erscheint eine sichtbare '
            + 'Cloudflare-Challenge. Sie wird nicht umgangen.',
        };
      }
      return {
        ok: false, grund: 'anmeldung-abgelehnt',
        meldung: 'Das Portal hat die Anmeldung abgelehnt und bleibt auf der '
          + 'Loginseite. Benutzername oder Passwort stimmen nicht, oder das '
          + 'Konto ist gesperrt.',
      };
    }

    await ctx.storageState({ path: ZUSTAND });
    chmodSync(ZUSTAND, 0o600);
    return { ok: true, meldung: 'Login OK' };
  } catch (e: any) {
    /* Die Fehlermeldung von Playwright kann den Feldinhalt enthalten. Sie wird
       deshalb nicht durchgereicht, nur ihr Typ. */
    return {
      ok: false, grund: 'fehler',
      meldung: `Der Anmeldevorgang ist abgebrochen (${e?.name ?? 'Fehler'}). `
        + 'Einzelheiten stehen bewusst nicht hier, weil die Meldung Feldinhalte '
        + 'enthalten kann.',
    };
  } finally {
    await ctx.close();
  }
}

async function warteAufTurnstile(seite: any): Promise<void> {
  /* Das Feld ist anfangs leer und wird von der Cloudflare-Bibliothek gefüllt.
     Bleibt es leer, wird trotzdem abgeschickt — manche Seiten verlangen das
     Token nur beim zweiten Schritt. Der Fehlschlag zeigt sich dann sauber an
     der Antwort des Portals, nicht hier. */
  await seite.waitForFunction(
    () => {
      const f = document.querySelector('#Captcha') as HTMLInputElement | null;
      return !f || (f.value ?? '').length > 0;
    },
    undefined,
    { timeout: TURNSTILE_MS },
  ).catch(() => {});
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--selbsttest')) {
    /* Sitzung absichtlich verwerfen und prüfen, ob der Re-Login greift. */
    if (existsSync(ZUSTAND)) {
      writeFileSync(ZUSTAND, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
      console.log('Selbsttest: Sitzungszustand ungültig gemacht.');
    } else {
      console.log('Selbsttest: kein Sitzungszustand vorhanden.');
    }
    const gueltig = await sitzungGueltig();
    console.log(`Selbsttest: Sitzung gültig? ${gueltig ? 'ja' : 'nein'} (erwartet: nein)`);
    if (gueltig) { console.error('Selbsttest fehlgeschlagen.'); process.exit(1); }
    const e = await anmelden();
    console.log(e.ok ? 'Selbsttest: Re-Login OK' : `Selbsttest: ${e.meldung}`);
    process.exit(e.ok || e.grund === 'keine-zugangsdaten' ? 0 : 1);
  }

  if (argv.includes('--pruefen')) {
    const gueltig = await sitzungGueltig();
    console.log(gueltig ? 'Sitzung gültig' : 'Sitzung abgelaufen');
    process.exit(gueltig ? 0 : 1);
  }

  if (!argv.includes('--erzwingen') && await sitzungGueltig()) {
    console.log('Login OK (bestehende Sitzung)');
    process.exit(0);
  }

  const e = await anmelden();
  console.log(e.ok ? 'Login OK' : `Login fehlgeschlagen: ${e.meldung}`);
  process.exit(e.ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch(() => {
    console.log('Login fehlgeschlagen: unerwarteter Abbruch.');
    process.exit(1);
  });
}

export { anmelden, sitzungGueltig, ZUSTAND, PROFIL, ENV_DATEI };
