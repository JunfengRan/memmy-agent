export function rephraseRelation(before: string, after: string): "refine" | "contradict" {
  if (!before || before === after) return "refine";
  if (/不|不要|改为|改成|不再|instead|no longer/i.test(after)) return "contradict";
  return "refine";
}

export function rephrasedDecision(before: { id: string; text: string }, afterText: string, reason: string): {
  id: string;
  text: string;
  lastChange: { relation: "refine" | "contradict"; reason: string };
} {
  return {
    id: before.id,
    text: afterText,
    lastChange: { relation: rephraseRelation(before.text, afterText), reason }
  };
}
