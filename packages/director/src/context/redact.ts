/**
 * Secret redaction for Context Packets (docs/10-security.md, AC-010-05). Known credential formats
 * are replaced with [REDACTED] before a text is measured or placed in a Packet. Secret files are
 * never indexed in the first place (scan policy); this catches secrets inside indexed sources.
 */
export const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/gu,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/gu,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
];

export function redactSecrets(text: string): { readonly text: string; readonly count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}
