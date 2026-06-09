# rules-en — English AI tells taxonomy

> Distilled and adapted from `avoid-ai-writing` (MIT). Source & license: [NOTICE.md](./NOTICE.md).
> Crypto/web3-specific patterns and voice-persona profiles from the source were dropped — not relevant to tapflow docs/marketing.

**Signals, not proof.** These shapes are more common in LLM output, but non-native English, deadline-pressed writers, and technical genres produce them too. Don't treat a score as a verdict.

**Untouchable** (never flag/rewrite): see command §1 — code, identifiers/APIs, numbers, dates, proper nouns, quoted material, links (except AI-tool URL params / citation leaks below, which are *removed*).

---

## Severity tiers

- **P0 — credibility killers**: cutoff disclaimers, chatbot/sycophantic artifacts, vague attributions, significance inflation on routine events, citation-markup leaks, unfilled placeholders, AI-tool URL params.
- **P1 — obvious AI smell**: Tier 1 words, template/slot-fill phrases, "Let's" openers, synonym cycling, formulaic openings, bold overuse, em-dash > 1/1000 words, future-narrative closers, hedge-stacked predictions, bullet-NP lists.
- **P2 — stylistic polish**: generic conclusions, rule of three, uniform paragraph length, copula avoidance, transition phrases (Moreover/Furthermore), Tier 3 density.

Quick pass = P0+P1. Full audit = all three.

## Words — three tiers

**Tier 1 — always replace** (5–20× more frequent in AI text):

| Replace | With |
|---|---|
| delve / delve into | explore, dig into, look at |
| landscape (metaphor) | field, space, industry |
| tapestry / realm / paradigm | (concrete term) / area, domain / model, approach |
| embark / commence | start, begin |
| testament to / underscores | shows, proves / highlights |
| robust / comprehensive | strong, reliable / thorough, complete |
| cutting-edge / pivotal | latest, advanced / important, key |
| leverage (verb) / utilize | use |
| meticulous / seamless | careful, precise / smooth, easy |
| game-changer / watershed moment | (state what changed) / turning point |
| nestled / vibrant / thriving / bustling | sits, is in / (describe) / growing, active / busy |
| deep dive / unpack | look at, examine / explain, break down |
| intricate / complexities | complex / (name the actual ones) |
| ever-evolving / enduring | changing / lasting |
| daunting / holistic | hard, difficult / complete, whole |
| actionable / impactful | practical, useful / effective |
| learnings / thought leadership | lessons, findings / expert, authority |
| best practices / at its core | proven methods / (cut, state the thing) |
| synergy / interplay | (the combined effect) / relationship |
| in order to / due to the fact that | to / because |
| serves as / features (v) / boasts / presents | is / has, includes / has / is, shows |
| ascertain / endeavor | find out, determine / effort, try |
| embrace (metaphor) / symphony / showcasing | adopt, use / (the coordination) / showing |

**Tier 2 — flag when 2+ in one paragraph** (fine alone, AI signal in clusters):
harness, navigate, foster, elevate, unleash, streamline, empower, bolster, spearhead, resonate, revolutionize, facilitate, underpin, nuanced, crucial, multifaceted, ecosystem (metaphor), myriad, plethora, encompass, catalyze, reimagine, galvanize, augment, cultivate, illuminate, elucidate, juxtapose, transformative, cornerstone, paramount, poised (to), burgeoning, nascent, quintessential, overarching, underpinning.

**Tier 3 — flag only at high density** (~3%+): significant(ly), innovative, effective(ly), dynamic, scalable, compelling, unprecedented, exceptional, remarkable, sophisticated, instrumental, world-class / state-of-the-art / best-in-class. → replace with numbers, comparisons, specifics.

## Phrase & structure tells

- **Template/slot-fill**: "a [adj] step towards [adj] X", "Whether you're X or Y" (false breadth), "I recently had the pleasure of …ing". → state the specific thing.
- **Transitions**: Moreover / Furthermore / Additionally → restructure or "and/also". "In today's X" / "In an era where" → cut. "When it comes to" / "At the end of the day" / "That said" → cut or simplify.
- **Filler**: "It is important to note that", "In terms of", "The reality is that", "It's worth noting that", "Here's what's interesting" → just state it.
- **Chatbot artifacts** (P0): "I hope this helps!", "Certainly!", "Great question!", "Feel free to reach out", "Let me know if…", "In this article, we will explore…", "Let's dive in!" → remove.
- **Sycophantic** (P0): "You're absolutely right!", "Excellent point!" → remove.
- **"Let's" openers**: "Let's explore / take a look / break this down" → start with the point.
- **Reasoning artifacts**: "Let me think step by step", "Breaking this down", "Step 1:", "First, let's consider" → state conclusion then evidence.
- **Acknowledgment loops**: "To answer your question", "The question of whether", recapping the previous section → just answer.
- **Vague attributions** (P0): "Experts believe", "Studies show", "Research suggests" → cite a specific source or drop.
- **Significance inflation** (P0): "marking a pivotal moment in the evolution of…", "a watershed moment for the industry" → delete the inflation clause if the sentence still works.
- **Generic conclusions / future-narrative**: "The future looks bright", "Only time will tell", "may become one of the most important narratives of…" → cut or make a falsifiable claim.
- **Hedge-stacked predictions**: "could potentially", "may eventually", "might ultimately" → pick one word.
- **"Real/actual" inflation**: "genuine utility", "real X" on an abstract noun → drop, or name the contrast explicitly.
- **Hollow intensifiers**: genuine, truly, quite frankly, to be honest, "worth reading/a look" → cut, say *why*.
- **Copula avoidance**: serves as / features / boasts / represents → default to "is"/"has".
- **Synonym cycling**: developers…engineers…practitioners…builders in one paragraph → repeat the clearest word.
- **Rhetorical-question openers**: "But what does this mean for X?" → answer directly.
- **Confidence calibration**: Interestingly / Surprisingly / Notably / Importantly stacked → flag by density (3+ in 500 words).
- **Formulaic challenges**: "Despite challenges, X continues to thrive" → name the challenge and response or cut.

## Formatting

- **Em dash (— or --)**: target zero; hard max 1 / 1000 words. Headings too.
- **Bold overuse**: ≤1 bold phrase per major section, or none.
- **Emoji in headers**: remove. (Social posts: 1–2 end-of-line OK.)
- **Excessive bullets**: convert to prose unless genuinely list-like (feature comparison, steps, params).
- **Bullet-NP lists**: 5+ short adj+noun items with no verb → prose or full claims.
- **Title-case headings**: use sentence case for subheadings.
- **Curly quotes**: weak signal; only flag in plain-text/code contexts.

## Structure & rhythm (#1 detection signal)

- **Sentence-length uniformity**: most sentences 15–25 words = robotic. Mix 3–8 word punches with 20+ flow. Fragments OK.
- **Paragraph-length uniformity**: vary deliberately; some one-sentence paragraphs.
- **Formulaic openings**: "In the rapidly evolving world of…" → lead with the news/insight.
- **Missing first-person / over-neutrality**: where a voice is expected, absence of "I think" / a stated preference is itself a tell.
- **Over-polishing warning**: sanding away all irregularity pushes text *toward* AI profiles. Don't remove all personality.

## Fingerprints (mechanical removal, P0 — near-proof)

- **Citation markup leaks**: `citeturn0search0`, `contentReference[oaicite:0]{index=0}`, `oai_citation`, `[attached_file:1]` → strip.
- **AI-tool URL params**: `utm_source=chatgpt.com|claude.ai|perplexity.ai`, `referrer=grok.com` → strip param, keep URL.
- **Unfilled placeholders**: `[Your Name]`, `[INSERT SOURCE]`, `2025-XX-XX`, `<!-- add citation -->` → fill or delete.
- **Cutoff disclaimers**: "As of my last update", "I don't have access to real-time data" → find the info or remove.

## Context carve-outs (relevant to tapflow)

- **`docs` / `technical-blog` profile** (tapflow docs, READMEs): clarity over voice. These technical terms are **not** flagged in technical context: `robust`, `comprehensive`, `seamless`, `ecosystem`, `leverage` (real platform/API leverage), `facilitate`, `underpin`, `streamline`. Still flag: `delve`, `tapestry`, `beacon`, `embark`, `testament to`, `game-changer`, `harness`. Hedging ("may", "could") is relaxed — often accurate in technical prose. Bullet/parameter lists are fine.
- **Em dash — tapflow docs/marketing exception.** The project's `write-docs.md` explicitly sanctions the `— short clause` pattern in English ("— no manual uploads") as natural. Do **not** flag em dashes that close a sentence with a short trailing clause. Flag em dashes only when they are *overused as a rhythm crutch*: 3+ em-dash sentences in a row, or an em dash used mid-clause where a comma belongs. (The 1/1000-words hard cap does not apply to tapflow EN docs.)
- **Bold-term glossary exception.** A definition list where each item leads with a bold term — `- **Relay** — the central server.` — is the correct form for "Key concepts" / glossary sections. Do **not** flag these as inline-header lists. The inline-header rule still fires on *repetitive bold headers that restate themselves* ("**Performance:** Performance improved by…") in body prose.
- **Self-reference escape hatch**: when writing *about* AI patterns, quoted examples, code blocks, and explicitly illustrative text are exempt. Flag only the author's own prose.

## When to rewrite from scratch

5+ vocabulary hits across 3+ categories + uniform sentence/paragraph length = the structure itself is AI. Patching phrases won't fix it; advise stating the core point in one sentence and rebuilding.
