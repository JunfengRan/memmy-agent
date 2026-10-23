export interface EvalFacts {
  owner: boolean;
  decision: boolean;
  secretLeak: boolean;
  convention: boolean;
  coldStart: boolean;
}

const OWNER = "cursor:main";
const FILE = "src/pool.ts";
const DECISION = "scope coefficient";
const SECRET = "OTHER_PROJECT_SECRET";
const CONVENTION = "return Task list";
const COLD = "run tests before commit";

export function scoreContext(text: string): EvalFacts {
  return {
    owner: text.includes(OWNER) && text.includes(FILE),
    decision: text.includes(DECISION),
    secretLeak: text.includes(SECRET),
    convention: text.includes(CONVENTION),
    coldStart: text.includes(COLD)
  };
}

export function factScore(facts: EvalFacts): number {
  const hits = [facts.owner, facts.decision, facts.convention, facts.coldStart, !facts.secretLeak];
  return hits.filter(Boolean).length / hits.length;
}

export function questionPassed(text: string, question: { need: readonly string[]; forbid: readonly string[] }): boolean {
  return question.need.every((item) => text.includes(item)) && question.forbid.every((item) => !text.includes(item));
}

export function mentionsPhrase(text: string, answer: string): boolean {
  const hay = text.replace(/\s+/g, "");
  const compact = answer.replace(/\s+/g, "");
  if (compact.length === 0) return false;
  const width = 16;
  if (compact.length <= width) return hay.includes(compact);
  for (let index = 0; index + width <= compact.length; index += width) {
    if (hay.includes(compact.slice(index, index + width))) return true;
  }
  return false;
}
