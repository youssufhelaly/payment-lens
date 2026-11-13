// Model output and Stripe free-text fields are printed to a terminal, so strip control
// characters (including ANSI escape sequences) that could rewrite or spoof the display.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function safeText(value: unknown): string {
  return String(value).replace(CONTROL_CHARS, "");
}

export function escapeMarkdownCell(value: unknown): string {
  return safeText(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
