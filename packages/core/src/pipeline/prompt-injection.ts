/**
 * Prompt-injection observability for text that crosses from an untrusted
 * repository or issue into a coding-agent prompt.
 *
 * This scanner is deliberately bounded and heuristic. It is not a security
 * boundary, and it must never decide whether a job may continue. The actual
 * defense is the role-specific capability set and the sandbox boundary.
 */

export const INJECTION_PATTERN_CLASSES = [
  "instruction_override",
  "secret_exfiltration",
  "unsafe_tool_use",
  "external_exfiltration",
  "filesystem_escape",
] as const;

export type InjectionPatternClass = (typeof INJECTION_PATTERN_CLASSES)[number];

/** Maximum UTF-8 bytes inspected from one source at one scan boundary. */
export const INJECTION_SCAN_MAX_BYTES = 32 * 1_024;

const PATTERNS: readonly [InjectionPatternClass, RegExp][] = [
  [
    "instruction_override",
    /\b(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,120}\b(?:instruction|directive|policy|system|developer|prompt|rule|task|request)s?\b|\b(?:important|new)\s+(?:agent\s+)?instructions?\b|\b(?:you are now|system message)\b/i,
  ],
  [
    "secret_exfiltration",
    /\b(?:read|send|upload|post|share|exfiltrat\w*|leak|reveal|dump|print)\b[\s\S]{0,120}\b(?:secret|credential|token|password|api[ _-]?key|environment|\.env)\b/i,
  ],
  [
    "unsafe_tool_use",
    /\b(?:run|execute|invoke|use|call)\b[\s\S]{0,100}\b(?:curl|wget|nc|netcat|ssh|sudo|docker|git\s+push|rm\s+-rf|cat\s+\/proc)\b|\b(?:skip|do not run|avoid)\b[\s\S]{0,80}\b(?:test|validation|security|review)s?\b|\bdisable(?:\s+the)?\s+(?:test|validation|security|review)s?\b/i,
  ],
  [
    "external_exfiltration",
    /\b(?:send|upload|post|publish|transmit|contact|visit)\b[\s\S]{0,120}(?:https?:\/\/|webhook|example\.com)/i,
  ],
  [
    "filesystem_escape",
    /\b(?:read|write|copy|delete|modify|access)\b[\s\S]{0,100}(?:\/etc|\/root|\.ssh|outside the workspace|parent directory|worker host|host filesystem)/i,
  ],
];

export interface InjectionScanResult {
  patternClasses: InjectionPatternClass[];
  truncated: boolean;
}

/**
 * Scans only a bounded prefix of a source and returns classes, never matches or
 * source text. Duplicate classes are collapsed in declaration order.
 */
export function scanPromptInjection(text: string): InjectionScanResult {
  const bounded = boundText(text, INJECTION_SCAN_MAX_BYTES);
  const patternClasses = PATTERNS.filter(([, pattern]) => pattern.test(bounded.text)).map(
    ([patternClass]) => patternClass,
  );

  return { patternClasses, truncated: bounded.truncated };
}

/**
 * Wraps untrusted text in a visible, labelled block. Delimiters inside the
 * content remain data; the prompt preamble tells the model not to treat them as
 * instructions. Existing file and command caps remain intact; only the scan is
 * bounded, so fencing does not silently hide repository content from the model.
 */
export function fenceUntrustedText(source: string, location: string, text: string): string {
  return [
    `<rivet-untrusted-content source="${escapeAttribute(source)}" location="${escapeAttribute(location)}">`,
    text,
    "</rivet-untrusted-content>",
  ].join("\n");
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };

  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  return {
    text:
      `${bytes.subarray(0, headBytes).toString("utf8")}\n` +
      `[rivet: ${bytes.byteLength - maxBytes} bytes omitted]\n` +
      bytes.subarray(bytes.byteLength - tailBytes).toString("utf8"),
    truncated: true,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
