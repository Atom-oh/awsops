// Slash-command section targeting for AI Assist. Auto-routing is the default; a leading `/<section>`
// (skill-like) targets ONE message to a section gateway. Pure + framework-free → unit-tested.
import { SECTIONS } from '@/lib/sections';

export interface SlashCommand {
  key: string;
  label: string;
  icon: string;
  active: boolean;
}

// `auto` first (explicit "let the classifier decide"), then one command per section.
export const SLASH_COMMANDS: SlashCommand[] = [
  { key: 'auto', label: '자동 라우팅', icon: '🧭', active: true },
  ...SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: s.icon, active: s.active })),
];

const KEYS = new Set(SLASH_COMMANDS.map((c) => c.key));
function commandList(custom: SlashCommand[]): SlashCommand[] {
  const seen = new Set(KEYS);
  return [...SLASH_COMMANDS, ...custom.filter((c) => {
    if (!c.active || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(c.key) || seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  })];
}
// Leading `/<key>` only — NO left-trim (a leading space ⇒ literal text, not a command). The
// separator is exactly ONE whitespace char; everything after it is the body, kept verbatim so
// pasted indentation/newlines survive.
const RE = /^\/([a-z0-9][a-z0-9-]*)(?:\s([\s\S]*))?$/;

export function parseSlash(text: string, custom: SlashCommand[] = []): { section: string | null; prompt: string } {
  const m = RE.exec(text);
  if (m && commandList(custom).some(c => c.key === m[1])) {
    const key = m[1];
    const body = m[2] ?? '';
    return { section: key === 'auto' ? null : key, prompt: body };
  }
  return { section: null, prompt: text };
}

// Prefix filter for the `/` autocomplete menu (fragment = text after the leading slash).
export function matchCommands(fragment: string, custom: SlashCommand[] = []): SlashCommand[] {
  const f = fragment.toLowerCase();
  return commandList(custom).filter((c) => c.key.startsWith(f));
}
