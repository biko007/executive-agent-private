/**
 * arm-status/__tests__ — erkennt eine wartende Armierung über Tatsachen.
 *
 * Der Leerlauf-Wächter meldete eine wartende Armierung bisher nur, wenn der
 * Deny-Hook eine Blockade protokolliert hatte — also nur, wenn der rote
 * Schritt wirklich versucht wurde. Weiß Claude Code vorher, dass er blockiert
 * würde, versucht es ihn gar nicht; dann steht nichts im Protokoll.
 *
 * Ein erster Versuch, diese Lücke über Berichtstexte zu schließen, schlug auf
 * Prosa an und ist verworfen worden. Hier wird stattdessen gefragt:
 *
 *   1. Liegt in den noch nicht gepushten Commits ein roter Pfad?
 *   2. Liegt eine Migrationsdatei vor, deren Version nicht in `schema_version`
 *      steht?
 *
 * Die Fehlalarm-Fälle sind das Wichtigste an diesen Tests. Eine Meldung, die
 * zu oft kommt, wird ignoriert — und hilft dann im echten Fall nicht.
 */
import { describe, it, expect } from 'bun:test';
import {
  lesePfadMuster, istRoterPfad, zerlegeMigration, offeneMigrationen,
  fasseArmBedarf, pruefeArmBedarf,
} from '../index.js';

/** Auszug aus der echten red-zone.conf, gekürzt. */
const KONFIG = `# Rote-Zone-Konfiguration
# Kommentar

[red-paths]
# Datenbank-Struktur
*/migrations/*.sql
scripts/migrate-*.ts
src/modules/*/migrate-*.ts
scripts/rollback-*.ts

# Zugangsschicht
src/modules/telegram-binding/**
.claude/hooks/**
.claude/settings.json
.github/workflows/**
.env
**/.env

[red-commands]
migrate.*--apply
psql.*openclaw_core
`;

describe('lesePfadMuster', () => {
  it('liest nur den Abschnitt der Pfade', () => {
    const m = lesePfadMuster(KONFIG);
    expect(m).toContain('*/migrations/*.sql');
    expect(m).toContain('.claude/hooks/**');
    // Die Befehlsmuster gehören nicht dazu.
    expect(m.some(x => x.includes('--apply'))).toBe(false);
    expect(m.some(x => x.startsWith('#'))).toBe(false);
  });

  it('kommt mit leerer Konfiguration zurecht', () => {
    expect(lesePfadMuster('')).toEqual([]);
    expect(lesePfadMuster('[red-commands]\nmigrate.*x\n')).toEqual([]);
  });
});

describe('istRoterPfad', () => {
  const muster = lesePfadMuster(KONFIG);

  it('erkennt eine Migrationsdatei in beliebiger Tiefe', () => {
    /* Der Hook vergleicht mit bash-Globs, dort überspannt ein Sternchen auch
       Schrägstriche. Diese Umsetzung muss sich genauso verhalten — sonst
       meldet sie Pfade, die der Hook durchlässt, oder umgekehrt. */
    expect(istRoterPfad('src/modules/assets/migrations/V041__x.sql', muster))
      .toBe('*/migrations/*.sql');
    expect(istRoterPfad('src/shared/settings/migrations/035_x.sql', muster))
      .toBe('*/migrations/*.sql');
  });

  it('erkennt die Migrations- und Rücknahmeskripte', () => {
    expect(istRoterPfad('scripts/rollback-v041.ts', muster)).toBe('scripts/rollback-*.ts');
    expect(istRoterPfad('src/modules/assets/migrate-v041.ts', muster))
      .toBe('src/modules/*/migrate-*.ts');
  });

  it('erkennt Hooks, Einstellungen und Arbeitsabläufe', () => {
    expect(istRoterPfad('.claude/hooks/deny-destructive.sh', muster)).toBe('.claude/hooks/**');
    expect(istRoterPfad('.claude/settings.json', muster)).toBe('.claude/settings.json');
    expect(istRoterPfad('.github/workflows/ci.yml', muster)).toBe('.github/workflows/**');
  });

  it('erkennt Env-Dateien auch in Unterordnern', () => {
    expect(istRoterPfad('.env', muster)).toBe('.env');
    expect(istRoterPfad('src/modules/x/.env', muster)).toBe('**/.env');
  });
});

describe('istRoterPfad — Fehlalarm-Fälle', () => {
  const muster = lesePfadMuster(KONFIG);

  it('meldet gewöhnliche Quelldateien NICHT', () => {
    for (const p of [
      'src/modules/assets/routes.ts',
      'src/modules/assets/casameta.ts',
      'src/modules/nk/engine.ts',
      'docs/CHANGELOG.md',
      'scripts/casameta-eingabeblatt.ts',
      'public/js/assets-belege.js',
    ]) {
      expect(istRoterPfad(p, muster)).toBeNull();
    }
  });

  it('meldet eine Datei mit „migration" im Namen NICHT, wenn sie nicht im Ordner liegt', () => {
    expect(istRoterPfad('docs/migrations-howto.md', muster)).toBeNull();
    expect(istRoterPfad('src/modules/assets/migration-notes.ts', muster)).toBeNull();
  });

  it('meldet Tests zu Migrationen NICHT', () => {
    // Der Hook würde sie auch nicht melden: kein .sql, kein migrate-*.ts.
    expect(istRoterPfad('src/modules/banking/__tests__/migration.test.ts', muster)).toBeNull();
  });

  it('meldet nichts bei leerer Musterliste', () => {
    expect(istRoterPfad('src/modules/assets/migrations/V041__x.sql', [])).toBeNull();
  });
});

describe('zerlegeMigration', () => {
  it('liest Modul und Version', () => {
    expect(zerlegeMigration('src/modules/assets/migrations/V041__heizkosten.sql'))
      .toEqual({ modul: 'assets', version: 41, pfad: 'src/modules/assets/migrations/V041__heizkosten.sql' });
    expect(zerlegeMigration('src/modules/banking/migrations/V040__x.sql')?.modul).toBe('banking');
  });

  it('übergeht Boot-Zeit-Migrationen mit Zahlenvorsatz', () => {
    /* Die Dateien mit `0xx_`-Vorsatz wendet der Dienst beim Start selbst an.
       Sie brauchen keinen Owner — und würden sonst dauerhaft gemeldet. */
    expect(zerlegeMigration('src/shared/settings/migrations/035_system_settings.sql')).toBeNull();
    expect(zerlegeMigration('src/shared/migrations/001_core_tables.sql')).toBeNull();
  });

  it('übergeht alles, was keine Migrationsdatei ist', () => {
    expect(zerlegeMigration('src/modules/assets/routes.ts')).toBeNull();
    expect(zerlegeMigration('docs/V041.md')).toBeNull();
  });
});

describe('offeneMigrationen', () => {
  const dateien = [
    'src/modules/banking/migrations/V040__x.sql',
    'src/modules/assets/migrations/V041__y.sql',
    'src/shared/settings/migrations/035_z.sql',
  ];

  it('nennt nur die nicht angewendeten', () => {
    const offen = offeneMigrationen(dateien, new Set(['banking:40']));
    expect(offen.map(o => `${o.modul}:${o.version}`)).toEqual(['assets:41']);
  });

  it('nennt keine, wenn alles angewendet ist', () => {
    expect(offeneMigrationen(dateien, new Set(['banking:40', 'assets:41']))).toEqual([]);
  });

  it('verwechselt gleiche Versionsnummern verschiedener Module nicht', () => {
    /* V037 gibt es bei Fleet UND bei Instagram, V043 bei Memory UND bei
       telegram-binding — die Versionen sind PER MODUL. Ein Vergleich nur über
       die Zahl würde eine angewendete Migration für eine offene halten. */
    const d = [
      'src/modules/fleet/migrations/V037__a.sql',
      'src/modules/instagram/migrations/V037__b.sql',
    ];
    const offen = offeneMigrationen(d, new Set(['fleet:37']));
    expect(offen.map(o => o.modul)).toEqual(['instagram']);
  });
});

describe('fasseArmBedarf', () => {
  it('schweigt, wenn nichts offen ist', () => {
    expect(fasseArmBedarf({ rotePfadeUngepusht: [], offeneMigrationen: [] }))
      .toEqual({ wartet: false });
  });

  it('nennt den ungepushten roten Pfad', () => {
    const b = fasseArmBedarf({
      rotePfadeUngepusht: [{ pfad: 'src/modules/assets/migrations/V041__x.sql', muster: '*/migrations/*.sql' }],
      offeneMigrationen: [],
    });
    expect(b.wartet).toBe(true);
    expect(b.quelle).toBe('ungepushter_roter_pfad');
    expect(b.gegenstand).toContain('V041');
  });

  it('kürzt eine lange Liste und nennt die Zahl', () => {
    const b = fasseArmBedarf({
      rotePfadeUngepusht: ['a', 'b', 'c', 'd', 'e'].map(p => ({ pfad: p + '.sql', muster: 'x' })),
      offeneMigrationen: [],
    });
    expect(b.gegenstand).toContain('5 noch nicht gepushte');
    expect(b.gegenstand).toContain('und 2 weitere');
  });

  it('gibt dem ungepushten Pfad den Vorrang vor der Migration', () => {
    /* Dort liegt fertige Arbeit, die nicht beim Owner ankommt. Eine nicht
       angewendete Migration kann dagegen bewusst warten — so wie V041 nach der
       Owner-Entscheidung, MG24 bei 30/70 zu lassen. */
    const b = fasseArmBedarf({
      rotePfadeUngepusht: [{ pfad: 'x.sql', muster: '*/migrations/*.sql' }],
      offeneMigrationen: [{ modul: 'assets', version: 42, pfad: 'y.sql' }],
    });
    expect(b.quelle).toBe('ungepushter_roter_pfad');
  });

  it('nennt die offene Migration, wenn nichts ungepusht ist', () => {
    const b = fasseArmBedarf({
      rotePfadeUngepusht: [],
      offeneMigrationen: [{ modul: 'assets', version: 42, pfad: 'y.sql' }],
    });
    expect(b.quelle).toBe('migration_nicht_angewendet');
    expect(b.gegenstand).toContain('assets V42');
  });

  it('gibt eine stabile Kennung, damit dieselbe Lage nur einmal gemeldet wird', () => {
    const fakten = {
      rotePfadeUngepusht: [{ pfad: 'b.sql', muster: 'x' }, { pfad: 'a.sql', muster: 'x' }],
      offeneMigrationen: [],
    };
    const eins = fasseArmBedarf(fakten);
    // Umgekehrte Reihenfolge derselben Dateien ergibt dieselbe Kennung.
    const zwei = fasseArmBedarf({
      rotePfadeUngepusht: [...fakten.rotePfadeUngepusht].reverse(),
      offeneMigrationen: [],
    });
    expect(eins.kennung).toBe(zwei.kennung);
  });
});

describe('pruefeArmBedarf — zusammengesetzt, ohne Git und ohne Datenbank', () => {
  it('erkennt einen ungepushten roten Pfad', async () => {
    const b = await pruefeArmBedarf({
      konfig: KONFIG,
      ungepusht: {
        '.openclaw/workspace/.openclaw/extensions/executive-agent': [
          'src/modules/assets/routes.ts',
          'src/modules/assets/migrations/V042__neu.sql',
        ],
      },
      migrationsDateien: [],
    });
    expect(b.wartet).toBe(true);
    expect(b.gegenstand).toContain('V042');
  });

  it('schweigt, wenn die ungepushten Dateien harmlos sind', async () => {
    const b = await pruefeArmBedarf({
      konfig: KONFIG,
      ungepusht: {
        '.openclaw/workspace/.openclaw/extensions/executive-agent': [
          'src/modules/assets/routes.ts', 'docs/CHANGELOG.md',
        ],
      },
      migrationsDateien: [],
    });
    expect(b.wartet).toBe(false);
  });

  it('erkennt eine Migrationsdatei ohne Eintrag in schema_version', async () => {
    const b = await pruefeArmBedarf({
      konfig: KONFIG,
      ungepusht: {},
      migrationsDateien: ['src/modules/assets/migrations/V042__neu.sql'],
      dbAbfrage: async () => [{ modul: 'assets', version: 41 }],
    });
    expect(b.wartet).toBe(true);
    expect(b.quelle).toBe('migration_nicht_angewendet');
  });

  it('schweigt, wenn die Migration angewendet ist', async () => {
    const b = await pruefeArmBedarf({
      konfig: KONFIG,
      ungepusht: {},
      migrationsDateien: ['src/modules/assets/migrations/V041__x.sql'],
      dbAbfrage: async () => [{ modul: 'assets', version: 41 }],
    });
    expect(b.wartet).toBe(false);
  });

  it('schweigt ohne Datenbankzugang statt zu raten', async () => {
    /* Ohne Antwort aus der Datenbank ist unbekannt, was angewendet ist. Dann
       zu melden hiesse raten — und würde bei jedem Datenbankausfall eine
       Meldung erzeugen. */
    const b = await pruefeArmBedarf({
      konfig: KONFIG,
      ungepusht: {},
      migrationsDateien: ['src/modules/assets/migrations/V042__neu.sql'],
      dbAbfrage: async () => { throw new Error('keine Verbindung'); },
    });
    expect(b.wartet).toBe(false);
  });

  it('schweigt ohne Konfiguration statt alles zu melden', async () => {
    const b = await pruefeArmBedarf({
      konfig: '',
      ungepusht: {
        '.openclaw/workspace/.openclaw/extensions/executive-agent': ['irgendwas.sql'],
      },
      migrationsDateien: [],
    });
    expect(b.wartet).toBe(false);
  });
});
