/*
 * The language of an email, in this order:
 *   1. the majority language of the keyword hits;
 *   2. the Content-Language header;
 *   3. a small stopword scorer over the languages in settings;
 *   4. the first language in settings.
 * When the hits tie, steps 2 to 4 choose among the tied languages only.
 */
import { normalize } from "@/lib/domain/normalize";
import type { KeywordHit } from "@/lib/types";
import { wordsOf } from "./extract";

/** Short, common words that tell the languages apart (overlaps such as "in", "is", "je" left out). */
const STOPWORDS_RAW: Record<string, string> = {
  en: "the and you your we our us with for this that have has would please thank thanks of are be been to from about regards dear",
  de: "der die das und sie ihre ihr ihnen wir uns unser unsere mit für nicht ist eine einen einem ein zu dem auf bei dass sich auch wird haben gerne grüße freundlichen vielen dank über möchten würden können",
  fr: "le les et vous votre vos nous notre pour avec une est pas qui dans merci sur aux cette sommes bonjour cordialement",
  es: "el los las y usted para con una por gracias del nuestro nuestra estamos muy saludos pero como esta su sus",
  nl: "het een van uw wij onze voor niet bedankt groeten dat zijn hebben wordt graag jouw jullie naar ook bij",
  tr: "ve bir bu için ile siz sizin biz teşekkür ederiz olarak daha çok sayın saygılarımızla",
};

const STOPWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(STOPWORDS_RAW).map(([language, words]) => [language, new Set(words.split(" ").map(normalize))]),
);

/** Fewest stopwords for the scorer to name a language. */
const MIN_STOPWORDS = 2;

/** "de-DE, en" -> "de"; null for anything that is not a language subtag. */
export function primarySubtag(value: string | null | undefined): string | null {
  const tag = (value ?? "").trim().toLowerCase().split(/[-_,;\s]/)[0];
  return /^[a-z]{2,3}$/.test(tag) ? tag : null;
}

/** The language among `languages` with the most stopwords in the text, if one clearly leads. */
export function stopwordLanguage(text: string, languages: readonly string[]): string | null {
  const scored = languages
    .filter((l) => STOPWORDS.has(l))
    .map((language) => ({ language, words: STOPWORDS.get(language)! }));
  if (scored.length === 0) return null;
  const counts = new Map(scored.map((s) => [s.language, 0]));
  for (const word of wordsOf(text)) {
    for (const s of scored) if (s.words.has(word)) counts.set(s.language, counts.get(s.language)! + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < MIN_STOPWORDS || (second && second[1] === best[1])) return null;
  return best[0];
}

export interface LanguageInput {
  hits: readonly KeywordHit[];
  contentLanguage?: string | null;
  /** Subject and body. */
  text: string;
  /** Settings, in order. */
  languages: readonly string[];
}

export function detectLanguage(input: LanguageInput): string | null {
  const counts = new Map<string, number>();
  for (const hit of input.hits) {
    if (hit.language) counts.set(hit.language, (counts.get(hit.language) ?? 0) + 1);
  }
  if (counts.size === 0) return fallback(input, null);
  const max = Math.max(...counts.values());
  const top = [...counts].filter(([, n]) => n === max).map(([language]) => language);
  return top.length === 1 ? top[0] : fallback(input, top);
}

/** Steps 2 to 4, among the tied hit languages when `among` is given. */
function fallback(input: LanguageInput, among: string[] | null): string | null {
  const allowed = (language: string) => !among || among.includes(language);
  const header = primarySubtag(input.contentLanguage);
  if (header && allowed(header)) return header;
  const scored = stopwordLanguage(input.text, among ?? input.languages);
  if (scored) return scored;
  return input.languages.find(allowed) ?? among?.[0] ?? null;
}
