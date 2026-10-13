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
 *   bun run scripts/casameta-login.ts --erzwingen --diagnose
 *       wie oben, zusaetzlich Trace, Screenshot je Station und befund.json in
 *       ~/.local/share/biko-portals/casameta/diagnose/<zeitstempel>/ (700).
 *       Der Screenshot zeigt den Login-Namen im Formular — er bleibt lokal.
 */
import { chromium, type BrowserContext } from 'playwright';
import { readFileSync, existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORTAL = 'https://portal.casameta.de';
const START = `${PORTAL}/login/checkbrowser?ReturnUrl=%2f`;
const ENV_DATEI = join(homedir(), '.config', 'biko-portals', 'env');
const BASIS = join(homedir(), '.local', 'share', 'biko-portals', 'casameta');
const PROFIL = join(BASIS, 'profile');
const ZUSTAND = join(BASIS, 'storage_state.json');
const DIAGNOSE_BASIS = join(BASIS, 'diagnose');

/** Wartezeit für das Turnstile-Token. Großzügig: Die Prüfung läuft im
 *  Hintergrund und braucht auf einem VPS ohne GPU spürbar länger als am
 *  Arbeitsplatz. */
const TURNSTILE_MS = 45_000;

export interface LoginErgebnis {
  ok: boolean;
  grund?: 'keine-zugangsdaten' | 'turnstile-sichtbar' | 'anmeldung-abgelehnt'
        | 'browser-start' | 'fehler';
  meldung: string;
  /** Letzter erreichter Schritt — die Diagnosefrage schlechthin. */
  schritt?: Schritt;
  /** Ordner mit Trace, Screenshots und befund.json, nur bei --diagnose. */
  diagnoseOrdner?: string;
}

/** Die Stationen des zweistufigen Logins, in der Reihenfolge des Ablaufs. */
export type Schritt =
  | 'browser-start'
  | 'startseite'
  | 'email-eingetragen'
  | 'email-abgeschickt'
  | 'passwortfeld-erschienen'
  | 'passwort-abgeschickt'
  | 'angemeldet';

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

async function anmelden(diagnose = false): Promise<LoginErgebnis> {
  const zugang = envLesen();
  if (!zugang) {
    return {
      ok: false, grund: 'keine-zugangsdaten',
      meldung: `Zugangsdaten fehlen. Erwartet werden CASAMETA_USER und `
        + `CASAMETA_PASSWORD in ${ENV_DATEI}. Anzulegen mit ~/bin/casameta-credentials.`,
    };
  }
  verzeichnisseAnlegen();

  /* Der Browserstart lag bis 13.10.2026 VOR dem try-Block. Scheiterte er, kam
     die Ursache nie bei der aufrufenden Stelle an — die Meldung lautete nur
     "unerwarteter Abbruch". Jetzt liegt er innerhalb. */
  let ctx: BrowserContext | undefined;
  let schritt: Schritt = 'browser-start';
  let ordner = '';
  const befund: Record<string, unknown> = { beginn: new Date().toISOString() };
  const konsole: string[] = [];

  /* Ab dem Moment, in dem das Passwort im Formular steht, wird keine
     Playwright-Meldung mehr durchgereicht — sie kann den Feldinhalt enthalten.
     Davor ist sie die einzige Diagnosequelle und wird gebraucht. */
  let passwortImFormular = false;

  /** Screenshot plus Zustandsnotiz je Station. Nur mit --diagnose. */
  const station = async (seite: any, name: Schritt): Promise<void> => {
    schritt = name;
    if (!diagnose || !ordner) return;
    try {
      await seite.screenshot({ path: join(ordner, `${name}.png`), fullPage: true });
      befund[name] = {
        url: seite.url(),
        turnstileToken: await turnstileGefuellt(seite),
        passwortfeld: await seite.locator('input[type="password"]').count() > 0,
        meldung: await portalMeldung(seite),
      };
    } catch { /* Diagnose darf den Ablauf nie zum Scheitern bringen */ }
  };

  try {
    ctx = await chromium.launchPersistentContext(PROFIL, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });

    if (diagnose) {
      ordner = join(DIAGNOSE_BASIS, new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(ordner, { recursive: true });
      chmodSync(ordner, 0o700);
      await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    const seite = ctx.pages()[0] ?? await ctx.newPage();
    seite.on('console', (m: any) => {
      if (konsole.length < 50) konsole.push(`${m.type()}: ${m.text()}`.slice(0, 300));
    });
    seite.on('pageerror', (e: any) => {
      if (konsole.length < 50) konsole.push(`pageerror: ${String(e).slice(0, 300)}`);
    });

    const antwort = await seite.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    befund.startStatus = antwort?.status() ?? null;
    befund.startUrl = seite.url();
    await station(seite, 'startseite');

    if (await sichtbareChallenge(ctx)) {
      befund.sichtbareChallenge = true;
      return {
        ok: false, grund: 'turnstile-sichtbar', schritt, diagnoseOrdner: ordner,
        meldung: 'Cloudflare Turnstile verlangt eine sichtbare Bestaetigung. '
          + 'Sie wird nicht umgangen. Der Login muss einmal von Hand erfolgen.',
      };
    }

    // Schritt 1: E-Mail-Adresse
    await seite.fill('#EMail', zugang.benutzer);
    await warteAufTurnstile(seite);
    await station(seite, 'email-eingetragen');
    await seite.click('#loginBtn');
    await seite.waitForTimeout(1500);
    await station(seite, 'email-abgeschickt');

    // Schritt 2: Passwort — das Feld erscheint erst nach dem ersten Absenden.
    const passwortFeld = seite.locator('input[type="password"]').first();
    try {
      await passwortFeld.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      /* Das Portal hat auf die E-Mail-Adresse hin kein Passwortfeld geliefert.
         Das ist eine eigene, benennbare Ursache und kein allgemeiner Fehler. */
      return {
        ok: false, grund: 'anmeldung-abgelehnt', schritt, diagnoseOrdner: ordner,
        meldung: 'Das Portal hat nach dem ersten Schritt kein Passwortfeld '
          + `angezeigt. Letzte Adresse: ${seite.url()}. `
          + `Meldung der Seite: ${(await portalMeldung(seite)) || 'keine'}.`,
      };
    }
    await station(seite, 'passwortfeld-erschienen');

    /* `fill` schreibt direkt in den Wert, ohne Tastaturereignisse zu
       protokollieren. Der Wert taucht dadurch in keinem Trace-Eintrag auf. */
    passwortImFormular = true;
    await passwortFeld.fill(zugang.passwort);
    await warteAufTurnstile(seite);
    await Promise.all([
      seite.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {}),
      seite.click('#loginBtn'),
    ]);
    await seite.waitForTimeout(2500);
    await station(seite, 'passwort-abgeschickt');

    if (seite.url().includes('/login/')) {
      if (await sichtbareChallenge(ctx)) {
        befund.sichtbareChallenge = true;
        return {
          ok: false, grund: 'turnstile-sichtbar', schritt, diagnoseOrdner: ordner,
          meldung: 'Nach der Passworteingabe erscheint eine sichtbare '
            + 'Cloudflare-Challenge. Sie wird nicht umgangen.',
        };
      }
      const meldung = await portalMeldung(seite);
      return {
        ok: false, grund: 'anmeldung-abgelehnt', schritt, diagnoseOrdner: ordner,
        meldung: 'Das Portal bleibt auf der Loginseite. Meldung der Seite: '
          + `${meldung || 'keine'}. Letzte Adresse: ${seite.url()}.`,
      };
    }

    await ctx.storageState({ path: ZUSTAND });
    chmodSync(ZUSTAND, 0o600);
    await station(seite, 'angemeldet');
    return { ok: true, meldung: 'Login OK', schritt, diagnoseOrdner: ordner };
  } catch (e: any) {
    /* Vor der Passworteingabe ist die Meldung unverfaenglich und notwendig.
       Danach wird nur der Fehlertyp genannt. */
    const detail = passwortImFormular
      ? `${e?.name ?? 'Fehler'} (Einzelheiten unterdrueckt, koennten Feldinhalte enthalten)`
      : `${e?.name ?? 'Fehler'}: ${String(e?.message ?? '').slice(0, 400)}`;
    befund.fehler = detail;
    return {
      ok: false,
      grund: schritt === 'browser-start' ? 'browser-start' : 'fehler',
      schritt, diagnoseOrdner: ordner,
      meldung: `Abbruch im Schritt "${schritt}": ${detail}`,
    };
  } finally {
    befund.schritt = schritt;
    befund.konsole = konsole;
    befund.ende = new Date().toISOString();
    if (ctx) {
      if (diagnose && ordner) {
        await ctx.tracing.stop({ path: join(ordner, 'trace.zip') }).catch(() => {});
      }
      await ctx.close().catch(() => {});
    }
    if (diagnose && ordner) {
      try {
        writeFileSync(join(ordner, 'befund.json'), JSON.stringify(befund, null, 2), { mode: 0o600 });
      } catch { /* nichts */ }
    }
  }
}

/** Steht ein Turnstile-Token im versteckten Feld? Nur ja/nein, nie der Wert. */
async function turnstileGefuellt(seite: any): Promise<boolean> {
  try {
    return await seite.evaluate(() => {
      const f = document.querySelector('#Captcha') as HTMLInputElement | null;
      return !!f && (f.value ?? '').length > 0;
    });
  } catch { return false; }
}

/** Sichtbarer Hinweis- oder Fehlertext der Seite. Das ist Ausgabe des Portals,
 *  keine Eingabe von uns — genau diese Zeile beantwortet die Frage, ob die
 *  Zugangsdaten beanstandet wurden. */
async function portalMeldung(seite: any): Promise<string> {
  try {
    return await seite.evaluate(() => {
      const treffer: string[] = [];
      const wahl = '.validation-summary-errors, .field-validation-error, .alert, '
        + '.text-danger, [role="alert"]';
      document.querySelectorAll(wahl).forEach(el => {
        const t = (el as HTMLElement).innerText?.trim();
        if (t) treffer.push(t);
      });
      return treffer.join(' | ').slice(0, 500);
    });
  } catch { return ''; }
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

  const diagnose = argv.includes('--diagnose');
  const e = await anmelden(diagnose);
  console.log(e.ok ? 'Login OK' : `Login fehlgeschlagen: ${e.meldung}`);
  if (e.schritt) console.log(`Letzter Schritt: ${e.schritt}`);
  if (e.diagnoseOrdner) console.log(`Diagnose: ${e.diagnoseOrdner}`);
  process.exit(e.ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch(() => {
    console.log('Login fehlgeschlagen: unerwarteter Abbruch.');
    process.exit(1);
  });
}

export { anmelden, sitzungGueltig, ZUSTAND, PROFIL, ENV_DATEI };
