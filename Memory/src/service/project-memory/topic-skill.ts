// Examples must stay outside the eval/project-memory domains so the guide cannot leak gold topics.
export const PROJECT_MEMORY_TOPIC_SKILL = `# Topic skill: choosing topic_id

A topic is one work object in the project: a module, a deliverable, a bug under investigation, or one area of working rules. Search returns a topic together with all of its entries, so a good topic answers "what is the current state of X" in one place.

## Steps
1. Read the existing topics listed for this project. When an entry is about the same work object as an existing topic, reuse that topic_id exactly, even if the entry adds a new detail.
2. Create a new topic only when no existing topic covers the work object, and reuse it for every other entry in this response that belongs to the same object.
3. Keep every detail of one work object under its topic: inputs, calculation rules, edge cases, parameters, failures and status changes. A parameter or an edge case is never a topic on its own.
4. Split topics only when the work objects differ: a different module or deliverable, a separate bug investigation, or a different area of rules (for example repository safety rules vs. communication habits).

## Granularity
- A project normally has about 3 to 8 topics, and each topic grows to several entries.
- Too fine: index-batch-size, index-retry-timeout and index-tokenizer are details of one object; use search-index-build for all three.
- Too coarse: one topic for the whole project, or a topic named after the project. Keep unrelated modules apart.
- A correction or later change of a fact stays in that fact's topic; never open a topic for the change itself.

## Naming
- kebab-case, 2 to 4 words, shaped as <object>-<aspect>, for example search-index-build, search-api-contract, team-review-rules.
- Name the work object, not the single fact, the entry kind, a date, or a status word such as fix, change or update.
- Never create a synonym of an existing topic_id.`;
