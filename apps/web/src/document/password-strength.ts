/**
 * A password strength estimate without a dependency (zxcvbn-like, much simpler): the
 * entropy of the character classes used, reduced for repeats, sequences, keyboard rows and
 * common passwords. Meant for a meter, not for policy: it errs on the side of "weak".
 */

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  /** 0 very weak … 4 strong; 0 also for an empty password. */
  readonly score: StrengthScore;
  /** Estimated entropy in bits after penalties. */
  readonly bits: number;
}

const COMMON = [
  'password',
  'passw0rd',
  '123456',
  '12345678',
  'qwerty',
  'azerty',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'abc123',
  'sunshine',
  'football',
  'princess',
  'master',
  'secret',
  'parola',
  'sifre',
  'şifre',
  'changeme',
  'default',
];

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'azertyuiop',
];

function reversed(value: string): string {
  let out = '';
  for (let i = value.length - 1; i >= 0; i--) out += value.charAt(i);
  return out;
}

/** Characters that continue an ascending or descending run (abc, 321, qwe). */
function sequenceLength(lower: string): number {
  let penalized = 0;
  for (let i = 0; i + 2 < lower.length; ) {
    let run = 1;
    for (const seq of SEQUENCES) {
      for (const s of [seq, reversed(seq)]) {
        let j = 0;
        const at = s.indexOf(lower[i] ?? '');
        if (at === -1) continue;
        while (i + j < lower.length && s[at + j] === lower[i + j]) j++;
        run = Math.max(run, j);
      }
    }
    if (run >= 3) {
      penalized += run - 1;
      i += run;
    } else {
      i++;
    }
  }
  return penalized;
}

/** Characters that repeat the previous one (aaa) or a repeated block (abcabc). */
function repeatLength(value: string): number {
  let penalized = 0;
  for (let i = 1; i < value.length; i++) if (value[i] === value[i - 1]) penalized++;
  for (let size = 2; size <= value.length / 2; size++) {
    const block = value.slice(0, size);
    if (
      block.repeat(Math.floor(value.length / size)) ===
      value.slice(0, size * Math.floor(value.length / size))
    ) {
      penalized = Math.max(penalized, value.length - size);
      break;
    }
  }
  return penalized;
}

export function passwordStrength(value: string): PasswordStrength {
  if (value.length === 0) return { score: 0, bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/[0-9]/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += /[^\x20-\x7e]/.test(value) ? 64 : 33;
  const lower = value.toLowerCase();
  const effective = Math.max(
    1,
    value.length - Math.max(repeatLength(value), sequenceLength(lower)),
  );
  let bits = effective * Math.log2(Math.max(pool, 2));
  const common = COMMON.find((word) => lower.includes(word));
  if (common) bits = Math.min(bits, 10 + (value.length - common.length) * 4);
  bits = Math.max(0, Math.round(bits));
  const score: StrengthScore = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, bits };
}
