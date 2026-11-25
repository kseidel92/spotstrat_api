/** 3 Dez 2026, 15:00 Brasília (GMT−3). */
const LAUNCH_AT = Date.UTC(2026, 11, 3, 18, 0, 0);

function salesOpen(now = Date.now()) {
  if (String(process.env.SALES_OPEN || '').toLowerCase() === 'true') return true;
  return now >= LAUNCH_AT;
}

function salesClosedPayload(locale) {
  const when = new Intl.DateTimeFormat(locale || 'pt-BR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(LAUNCH_AT);
  return {
    error: 'before_launch',
    message: `As compras abrem no lançamento (${when}).`,
    launchAt: new Date(LAUNCH_AT).toISOString(),
  };
}

module.exports = { LAUNCH_AT, salesOpen, salesClosedPayload };
