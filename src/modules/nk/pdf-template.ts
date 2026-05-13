/**
 * nk/pdf-template — Handlebars template compilation + HTML rendering.
 * Sprint 5.5b — Etappe g
 *
 * Template is embedded as a string constant to avoid .hbs copy-to-dist issues.
 */
import Handlebars from 'handlebars';
import type { TenantRecipient } from './types.js';

// ── Handlebars Helpers ──────────────────────────────────────────────────────

Handlebars.registerHelper('fmtEur', (value: unknown) => {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (isNaN(n)) return '0,00 €';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
});

Handlebars.registerHelper('fmtDate', (value: unknown) => {
  if (!value) return '';
  const d = new Date(String(value));
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
});

Handlebars.registerHelper('signBadge', (value: unknown) => {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (isNaN(n) || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
});

Handlebars.registerHelper('abs', (value: unknown) => {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  return isNaN(n) ? 0 : Math.abs(n);
});

Handlebars.registerHelper('ifEq', function (this: unknown, a: unknown, b: unknown, options: any) {
  return a === b ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('gt', (a: unknown, b: unknown) => {
  return Number(a) > Number(b);
});

Handlebars.registerHelper('escapeHtml', (text: unknown) => {
  const str = String(text || '');
  return new Handlebars.SafeString(
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
  );
});

// ── Template (embedded) ─────────────────────────────────────────────────────

const STATEMENT_TEMPLATE = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Nebenkostenabrechnung {{period_year}}</title>
  <style>
    @page { size: A4; margin: 20mm 15mm 25mm 15mm; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 10pt; color: #222; line-height: 1.4; }
    .page { padding: 0; }

    /* Briefkopf */
    .header { margin-bottom: 8mm; border-bottom: 0.5pt solid #999; padding-bottom: 4mm; }
    .header .owner { font-size: 8pt; color: #666; }
    .header .property-name { font-size: 14pt; font-weight: bold; margin-top: 2mm; }
    .header .property-address { font-size: 9pt; color: #444; }

    /* Anschrift */
    .recipient { margin-top: 6mm; margin-bottom: 8mm; min-height: 25mm; }
    .recipient .name { font-weight: bold; font-size: 11pt; }
    .recipient .address { font-size: 10pt; color: #333; }

    /* Title */
    .title { font-size: 13pt; font-weight: bold; margin-bottom: 2mm; }
    .subtitle { font-size: 9pt; color: #555; margin-bottom: 6mm; }

    /* Table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
    th, td { padding: 2mm 3mm; text-align: left; font-size: 9pt; }
    th { background: #f5f5f5; border-bottom: 1pt solid #ccc; font-weight: 600; }
    td { border-bottom: 0.5pt solid #eee; }
    .right { text-align: right; }
    .bold { font-weight: 600; }

    /* Summary */
    .summary { margin-top: 4mm; padding: 3mm 4mm; background: #f9f9f9; border: 0.5pt solid #ddd; }
    .summary-row { display: flex; justify-content: space-between; margin-bottom: 1mm; }
    .summary-row.total { font-weight: bold; font-size: 11pt; border-top: 1pt solid #999; padding-top: 2mm; margin-top: 2mm; }
    .positive { color: #2a7d2a; }
    .negative { color: #c0392b; }
    .neutral { color: #333; }

    /* Balance highlight */
    .balance-box { margin-top: 4mm; padding: 4mm; border: 1pt solid #333; text-align: center; }
    .balance-box .label { font-size: 9pt; color: #555; }
    .balance-box .amount { font-size: 14pt; font-weight: bold; }
    .balance-refund { background: #e8f5e9; border-color: #2a7d2a; }
    .balance-payment { background: #fbe9e7; border-color: #c0392b; }

    /* Owner block */
    .owner-block-notice { margin-top: 4mm; padding: 3mm; background: #fff3e0; border: 0.5pt solid #e65100; font-size: 9pt; color: #e65100; }

    /* Info section */
    .info-section { margin-top: 5mm; font-size: 8pt; color: #666; }
    .info-section p { margin-bottom: 1mm; }

    /* Footer */
    .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 2mm 15mm; font-size: 7pt; color: #999; border-top: 0.5pt solid #ddd; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="page">
    <!-- Briefkopf -->
    <div class="header">
      <div class="owner">{{escapeHtml owner}}</div>
      <div class="property-name">{{escapeHtml property_name}}</div>
      <div class="property-address">{{escapeHtml property_street}}, {{escapeHtml property_postal_code}} {{escapeHtml property_city}}</div>
    </div>

    {{#if is_owner_block}}
    <!-- Owner Block Variant -->
    <div class="title">Eigentümer-Zusammenfassung — Nebenkostenabrechnung {{period_year}}</div>
    <div class="subtitle">Abrechnungszeitraum: {{fmtDate period_start}} – {{fmtDate period_end}}</div>

    <div class="owner-block-notice">
      Diese Zusammenfassung enthält Leerstands- und Ausschlussanteile, die dem Eigentümer zugeordnet werden.
    </div>

    {{else}}
    <!-- Tenant Variant -->
    <div class="recipient">
      {{#each recipients}}
      <div class="name">{{#if company_name}}{{escapeHtml company_name}}{{else}}{{escapeHtml first_name}} {{escapeHtml last_name}}{{/if}}</div>
      {{#if correspondence_address}}
      <div class="address">
        {{#if correspondence_address.street}}{{escapeHtml correspondence_address.street}}<br>{{/if}}
        {{#if correspondence_address.postal_code}}{{escapeHtml correspondence_address.postal_code}} {{/if}}{{#if correspondence_address.city}}{{escapeHtml correspondence_address.city}}{{/if}}
      </div>
      {{/if}}
      {{/each}}
    </div>

    <div class="title">Nebenkostenabrechnung {{period_year}}</div>
    <div class="subtitle">Abrechnungszeitraum: {{fmtDate period_start}} – {{fmtDate period_end}} ({{active_days}} Tage)</div>
    {{/if}}

    <!-- Kostenarten-Tabelle -->
    <table>
      <thead>
        <tr>
          <th>Kostenart</th>
          <th class="right">Gesamt Objekt</th>
          <th>Schlüssel</th>
          <th class="right">Anteil</th>
          <th class="right">Ihr Anteil</th>
        </tr>
      </thead>
      <tbody>
        {{#each items}}
        <tr>
          <td>
            {{#ifEq item_type "vacancy_owner_share"}}Leerstand{{else}}
            {{#ifEq item_type "excluded_billing_mode"}}Pauschale/Inkl.-Mieter{{else}}
            {{#ifEq item_type "rounding_adjustment"}}Rundungsanpassung{{else}}
            {{escapeHtml category_name}}{{/ifEq}}{{/ifEq}}{{/ifEq}}
          </td>
          <td class="right">{{#if total_property}}{{fmtEur total_property}}{{/if}}</td>
          <td>{{#if allocation_basis}}{{escapeHtml allocation_basis}}{{/if}}</td>
          <td class="right">{{#if share_fraction}}{{share_fraction}}{{/if}}</td>
          <td class="right bold">{{fmtEur amount}}</td>
        </tr>
        {{/each}}
      </tbody>
    </table>

    {{#unless is_owner_block}}
    <!-- Summary -->
    <div class="summary">
      <div class="summary-row">
        <span>Gesamtkosten Ihr Anteil</span>
        <span>{{fmtEur costs_total}}</span>
      </div>
      <div class="summary-row">
        <span>Vorauszahlungen</span>
        <span>– {{fmtEur advance_total}}</span>
      </div>
      {{#if rounding_adjustment}}
      <div class="summary-row">
        <span>Rundungsanpassung</span>
        <span>{{fmtEur rounding_adjustment}}</span>
      </div>
      {{/if}}
      <div class="summary-row total">
        <span>{{#if (gt balance 0)}}Nachzahlung{{else}}Guthaben{{/if}}</span>
        <span class="{{signBadge balance}}">{{fmtEur (abs balance)}}</span>
      </div>
    </div>

    <!-- Balance highlight -->
    <div class="balance-box {{#if (gt balance 0)}}balance-payment{{else}}balance-refund{{/if}}">
      <div class="label">{{#if (gt balance 0)}}Nachzahlung fällig{{else}}Erstattungsbetrag{{/if}}</div>
      <div class="amount {{signBadge balance}}">{{fmtEur (abs balance)}}</div>
    </div>
    {{/unless}}

    {{#if is_owner_block}}
    <div class="summary">
      <div class="summary-row total">
        <span>Eigentümeranteil Gesamt</span>
        <span>{{fmtEur costs_total}}</span>
      </div>
    </div>
    {{/if}}

    <!-- Info -->
    <div class="info-section">
      <p>Erstellt am: {{fmtDate generated_at}} | Engine: {{engine_version}}</p>
      {{#if warnings_count}}<p>Hinweise: {{warnings_count}} — siehe Detailansicht im Dashboard.</p>{{/if}}
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span>Run #{{run_id}} v{{version}}</span>
    <span>SHA-256: {{snapshot_sha256}}</span>
  </div>
</body>
</html>`;

let compiledTemplate: Handlebars.TemplateDelegate | null = null;

/**
 * Get the compiled Handlebars template (lazily compiled, cached).
 */
function getTemplate(): Handlebars.TemplateDelegate {
  if (!compiledTemplate) {
    compiledTemplate = Handlebars.compile(STATEMENT_TEMPLATE);
  }
  return compiledTemplate;
}

/**
 * Render statement HTML from snapshot data.
 */
export function renderStatementHtml(
  snapshot: Record<string, unknown>,
  statement: Record<string, unknown>,
  recipients: TenantRecipient[] | null,
  categoryNames: Map<number, string>,
): string {
  const run = snapshot.run as Record<string, unknown>;
  const items = (statement.items as Array<Record<string, unknown>>).map(item => ({
    ...item,
    category_name: item.cost_category_id
      ? categoryNames.get(item.cost_category_id as number) || `Kategorie ${item.cost_category_id}`
      : '',
  }));

  const data = {
    // Property info
    owner: (run as any).property_code || '',
    property_name: (run as any).property_code || '',
    property_street: '',
    property_postal_code: '',
    property_city: '',
    // Period
    period_year: run.period_year,
    period_start: run.period_start,
    period_end: run.period_end,
    active_days: statement.active_days,
    // Statement
    is_owner_block: statement.is_owner_block,
    items,
    costs_total: statement.costs_total,
    advance_total: statement.advance_total,
    balance: statement.balance,
    rounding_adjustment: statement.rounding_adjustment,
    // Recipients
    recipients: recipients || [],
    // Meta
    generated_at: snapshot.generated_at,
    engine_version: (run as any).engine_version || '',
    run_id: run.property_id,
    version: '',
    snapshot_sha256: '',
    warnings_count: (snapshot.warnings as unknown[])?.length || 0,
  };

  const template = getTemplate();
  return template(data);
}

/**
 * Validate that recipients have the minimum info needed for PDF rendering.
 * Returns error string or null if ok.
 */
export function validatePreRenderCompleteness(
  recipients: TenantRecipient[] | null,
  isOwnerBlock: boolean,
): string | null {
  if (isOwnerBlock) return null; // Owner blocks don't need recipients

  if (!recipients || recipients.length === 0) {
    return 'No recipients found for tenant statement';
  }

  for (const r of recipients) {
    if (!r.last_name && !r.company_name) {
      return `Recipient tenant_id=${r.tenant_id} has no last_name or company_name`;
    }
  }

  return null;
}
