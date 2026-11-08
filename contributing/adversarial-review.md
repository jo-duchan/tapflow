---
type: rules
topics: [process, review, quality]
status: living
---

# Adversarial review — how to run one, and how to keep it cheap

> The gate itself is stated in the root [AGENTS.md](../AGENTS.md): every code-change PR needs an
> independent review, recorded in `.work/reviews/<branch>.md` with the full 40-character HEAD hash,
> and a PreToolUse hook enforces it. **This file is the how.** Read it before launching a reviewer —
> the difference between a 4-minute review and a 106-minute one is entirely in how the prompt is
> written.

## Why an independent context

The authoring session inherits its own assumptions. It cannot refute them, because the reasoning that
produced the diff is the same reasoning that would have to find the hole. So the reviewer must be a
context that has **not** seen the working conversation — given only the diff, repo access, and a
refute-first prompt.

Docs-only PRs may skip the review itself, but still write the record with the skip reason. The gate
always requires the record.

## Channels

- **Default reviewer**: a fresh subagent given only the diff, repo access, and a refute-first prompt —
  "find bugs, contract violations, and missing cases; verify every claim with commands; report
  findings with severity and evidence, plus a checked-and-cleared list". Do not share the authoring
  session's reasoning with it.
- **Escalation**: protocol / public-interface / release-infrastructure changes get a second
  independent channel — a second subagent with a different lens, or Codex for cross-model
  independence.

## Keeping a review affordable

Review wall-clock is dominated by **what the reviewer has to execute**, not by how hard it thinks.
Measured across one session: a read-and-probe review of a protocol change took 11 minutes at 93k
tokens; a review of ~590 lines of tooling took **106 minutes at only 134k tokens** — fewer tokens,
10× the time, because it spent that time on `pnpm install`, `pnpm build`, starting real dev servers
and waiting out sleeps.

- **Only use an isolated worktree when the reviewer must edit files.** A fresh worktree has no
  `node_modules` and no `dist`, so it pays 8–10 minutes of install and build before it can run
  anything — **the first time on a machine.** After that pnpm's store is warm and shared across
  worktrees: `pnpm install --frozen-lockfile` in a second worktree of the same clone was measured at
  **5.3 seconds**, and only `pnpm build` still costs minutes. The number above is the cold case, and
  reading it as the general one is what kept a session from running its suite for hours — and a reviewer that does not know this reports results from commands that silently did
  nothing (`vitest: command not found` swallowed by a shell exit). A read-only lens (contract,
  compatibility, documentation) can work against the primary checkout, which is already built.
- **Say what to install.** When a worktree is required, the prompt must open with
  `pnpm install --frozen-lockfile && pnpm build`, or the first `pnpm test` result is meaningless.
- **Do the mutation testing yourself, then hand over the list.** Ask the reviewer to find what your
  mutations *missed*, not to redo them. Every surviving mutation found so far came from someone
  imagining a different way to break a test — never from running more of them.
- **No blanket "run it 10 times".** Repeat runs have found zero flakes across two rounds; they cost
  4+ minutes each time. Ask for 3 runs, and only for tests that use timers or real sleeps.
- **Split by lens and run the lenses in parallel.** Wall-clock is then the slowest lens, not the sum.
  Two channels on the same commit took 11 and 40 minutes concurrently, against 51 serially.
- **A design review can be made to execute nothing at all.** This is the cheapest review there is, so
  there is no excuse for skipping the one the cross-cutting section below requires. Hand the reviewer
  the measurements you already took and **forbid re-running them**, name the files to read so it does
  not sweep the tree, list the commands it must not run (`eslint`, `pnpm test`, `tsc`, `pnpm build`),
  cap the findings (4 is enough), and state a time budget. Two lenses over a plan plus its
  uncommitted diff came back in **4m30s and 3m25s at 83k / 74k tokens**, wall-clock 4m30s in
  parallel. The measurements in the prompt were what made it cheap — a reviewer told "src 40 files,
  hooks 13, components 51, lib 19, and here are the 2 errors" spends its time judging instead of
  counting.
- **Verify the reviewer's grounds, not just its verdict.** On that plan a `blocker` rested on correct
  evidence carrying the wrong weight: the component it flagged is an unused export that never
  renders, so the regression it predicted could not occur. The conclusion survived and the reason
  changed — which matters, because the reason is what goes in the record. Grade severity yourself. A
  finding whose evidence you have not reproduced is a hypothesis, including when it agrees with you.
- **Some cost is irreducible.** Verifying code that kills processes means starting and killing
  processes, with real waits. Budget for it and say so up front, rather than discovering it at 100
  minutes.
- **A running review holds the checkout's *branch*, not just its working tree.** The rule above about
  worktrees is easy to read as "do not run two mutating channels at once" and stop there. It is wider
  than that: while a review runs, **you** are the other process. One session switched branches
  mid-review to handle another PR's comments, and from that moment the files under review were not on
  disk and the tree was dirty with a different slice's work. That reviewer noticed via `git reflog` and
  built itself a worktree; one that did not check would have reported results from a tree containing
  none of the change. A separate incident had a reviewer's restore-to-`HEAD` discard six edits made in
  the checkout while it ran.
- **So: while a review runs, the checkout is read-only to you.** Concurrent work goes in a worktree
  that *you* create, not one the reviewer has to discover it needs. This applies to a read-only
  reviewer too — it is reading files, so editing them mid-run means it may report on text you have
  already changed.
- **And "you" is not only this session.** The rule above is written as discipline, which quietly
  assumes the only other process is the one making the promise. It is not: another session of your own
  — a second terminal reviewing somebody's PR, an editor task, anything holding the same clone — moves
  the branch under a running review, and no amount of care on this side prevents it. Measured on
  2026-08-28: two channels were reviewing a branch when a concurrent session checked out `pr-656` and
  then a third branch. Neither had been told this could happen.

  **So the reviewer prompt names the commit, and the reviewer checks.** Both channels noticed — one via
  `git reflog` — and finished by reading blobs with `git show <sha>:<path>`, so both reports were
  sound and their findings verified against the real files afterwards. That is the behaviour to ask
  for rather than to be lucky about: give the reviewer the full HEAD hash you want reviewed, and say
  that if the tree no longer holds it, it should read blobs at that hash instead and say so in its
  report. A reviewer that silently trusts the tree reports on a change that is not there.

  **"No longer holds it" is two questions, not one.** `git rev-parse HEAD` catches a branch that
  moved; it says nothing about an uncommitted edit, which leaves the hash matching while the files
  differ — and that is the case the paragraph above this one is about. So the reviewer checks
  `git status --porcelain` as well, and treats either signal as reason to read blobs. Asking only for
  the hash is a check that reads as covering both and covers one.

## Ask the reviewer for facts, not for a disposition

The gate above asks for a `now`/`later` column and a `later` budget, and the root
[AGENTS.md](../AGENTS.md) then asks the author to re-grade every one. **Measured once: three issues
filed off that column and all three closed again within the session** — one because no consumer
reached the defect, one for the same reason a day's work later, and one whose fix was six lines in a
file the running lens was already reading. Nothing was missing from the reviews. The re-grade simply
did not happen, which is what happens to a step that produces no artifact.

**The gate above stays as it is.** What follows is a shape to try alongside it, not a replacement —
the `now`/`later` column and the `later` budget have nine measured issues behind them and this has
three, so removing them on this evidence would be the mistake it is trying to describe. Try it in a
prompt, keep the column, and see which one the author actually uses.

The shape is to add three facts and let the disposition fall out of them:

| field | what it must contain |
|---|---|
| **reaching path** | a concrete consumer or call sequence that hits it, **or the words "none found"** |
| **fix size** | lines, for the smallest honest fix — not the ideal one |
| **lens** | the one already running, or which other one it needs |

The disposition is then close to arithmetic and the author has nothing to defer to. **"None found" is
not a `later`; it is a comment beside the code**, which is where the invariant belonged in two of the
three cases above — `g_queues` carries exactly such an argument for why address reuse is harmless
there, and the code the issues were about carried none.

**Write the three fields and the disposition into `.work/reviews/<branch>.md` per finding.** That is
the artifact the re-grade never had: a skipped one shows up as an empty column instead of as nothing
at all. A check could assert the fields are non-empty, but it would be a spelling assertion — a floor,
not a fence.

**This is one session's evidence, from one author in one area.** It is written here rather than in the
gate because the gate's current shape is what produced the measurement, and replacing a rule that has
its own measurement behind it needs more than three data points.

## On trial: four prompt rules from the Elephant-Goldfish Model

[Elephant-Goldfish](https://github.com/google/elephant-goldfish-model) reviews design documents with
fresh-context agents, which is this file's idea applied one stage earlier. We found no measured
results in its repository, and its own FAQ tells you to measure on your own tasks, so these are here
to try rather than because they were proven. Keep the ones the next few reviews actually use.

- **In a design pass, the reviewer paraphrases before it finds anything.** Two to five sentences on
  what the design proposes and how the existing system works, as the document describes it. Compare
  that with your intent; a wrong paraphrase is a finding. A list of undefined terms cannot catch a
  plan whose terms are all defined and whose parts do not connect. Paraphrase with no premises from
  the author, or it only reads your summary back to you.
- **Premises are mechanical facts, never conclusions.** Counts, error output and config contents
  keep a review cheap. A cause, an intent or a reason something is safe hands the reviewer the
  assumption it exists to refute, and telling it not to re-check turns that assumption into a given.
- **A rejection has to be checkable, and has to check the conclusion.** Cite something the reviewer
  could have read: a file and symbol, or a recorded decision. If the only evidence sits outside every
  file it could read, such as a verbal decision or an unwritten convention, neither reject nor fix:
  hand it to the user. Showing the reviewer's *reason* is wrong is not enough either. On #814 the
  stated reason was false and the conclusion was true, because two fallbacks masked each other and
  mutating either one failed no test. You wrote the change, so wanting to reject a finding is not
  evidence against it.
- **A channel that did not finish did not review.** Timed out, failed, or returned no report: retry
  it once, then write it down as `not run`. Never record it as a channel with no findings. This is
  the shape of #827, where a timeout passed with the same ✔️ as a clean run. A text search of the
  review records found no instance here, so it is insurance rather than a fix.

Three things it does are deliberately not taken. **Severity stays yours to re-grade**, which it
forbids, because the unused-export `blocker` above needed exactly that. **Reviewers keep their tools**:
its personas are read-only, and ours find defects by planting mutations and running commands.
**Reviewers keep the project's instructions**: it verifies that a reviewer sees no `CLAUDE.md`, and
ours have to know the repo's rules to judge a diff against them.

## The cleared list ages with the diff

A reviewer's "checked and cleared" list describes the code **as the reviewer read it**. Fixing the
findings changes that code — so **after applying the fixes, re-check whether any fix invalidated a
cleared item.** The list is evidence, not a warranty, and it expires the moment you edit.

This is not a hypothetical. On #503 a reviewer cleared `setAgentCapabilities(msg.capabilities ?? [])`:
type-dead now that `capabilities` is required, but live at runtime, and *"removing it would be caught
by `sessionScope.test.tsx:35,74`"*. That was true when it was written. Both of those lines were
`{ type: 'session:joined' } as BrowserInbound` — a fixture omitting the field — and a later finding in
the same review was that those casts must go. Typing the fixtures correctly is right, and it silently
removed the fallback's only coverage: the mutation went from caught to surviving all 297 tests, with
nothing failing to say so.

The failure mode is specific and worth naming: **a cleared item whose grounds are a test, where
another finding changes that test.** So:

- When a review yields several findings, treat the cleared list as **one of the things the fixes can
  break**. Read it again at the end, not once at the start.
- If a cleared item's grounds were "a test catches this", re-run that mutation after the fixes. Being
  told a mutation is caught is not the same as it being caught now.
- Record the reversal in the review file rather than quietly deleting it — strike the original and say
  what overturned it. Someone later needs to know the clearance was real and then stopped being real.

The same applies to your own mutation results: a mutation you ran before the fixes was run against
code that no longer exists.

## The justification is part of the change, not documentation of it

A fix changes code. The sentence written next to that code said why the old shape was right, and now it is
false. **After applying review fixes, re-read the prose each fix touched** — the comment, the doc block, the
changeset, the AGENTS.md paragraph. Not as a tidy-up pass at the end: as part of the fix.

This is the twin of the section above and it points the other way. That one is about a *reviewer's* clearance
expiring when you fix the findings. This is about *your own recorded reasoning* going false when you do.

Three instances on one program, in three consecutive layers, none of them caught by the author:

- A union's doc claimed every member carried a required `sessionId`. A review finding in the same PR made
  three of them optional; the claim stayed.
- A field was declared optional, with a comment giving the reason: "the producers pass through an optional
  one, so requiring it could only be satisfied with the `!` we are trying to remove." True when written. **A
  later hunk of the same commit** made the producers required, so the reason was false before the commit was
  finished — and the field was then weaker than every producer it described, declaring a message nobody sends.
- A union was split during a review round, precisely to stop one socket type-checking another's message. The
  changeset and the package's AGENTS.md kept naming the merged union, so both documents described the design
  that round had just rejected, next to the reasoning for rejecting it.

The failure is not sloppiness about comments. In all three the prose was the **argument for the design**, so a
stale one does not merely misinform — it argues for the thing that was removed, and the next reader has to
choose between the code and a reason that sounds deliberate. The second instance is the sharpest: the
justification was refuted by the same change it was justifying, which no amount of care *at the end* would
have caught, because the end is where it looked consistent.

Two habits that would have caught all three:

- When a fix changes a declaration, grep the declaration's own name and the field you touched. Both a comment
  above it and a changeset paragraph will usually come back.
- When a fix reverses a decision, find the sentence that recorded the decision. If a review talked you out of
  something, the write-up saying why you did it is somewhere, and it is now wrong.

### The two habits above are not sufficient, and here is what they miss

Those are both **identifier** searches, and later rounds on the same program found the two classes they cannot
reach. Frequency first: one slice produced **five** survivors after the author had already swept it, and a
later one produced two more that the sweep had specifically been looking for.

- **Read the paragraph *above* the hunk, in the file — not in the diff.** Four of those five were the lead-in
  sentence or the preceding paragraph of a place that *was* edited. The sharpest: a commit whose stated
  headline was "this ends a contradiction that sat in two files" left the retired argument verbatim on the base
  interface its rewritten member now `extends`, 140 lines above the rewritten block. The contradiction did not
  end; it moved inside one file. The grep found every site that *mentioned* the message by name and none of the
  sentences that *explained* those sites.
- **A sentence quoting a value is found by the value's word, not by the identifier near it.** Two comments
  saying a diagnostic fires "once per session" survived the change that made it once per client, because the
  sweep grepped `addressSkew` and `predates addressed` and neither sentence contains either. Search the
  vocabulary of quantity: counts, cardinalities, directions, and *once* / *always* / *only* / *every*.
  Line-number lists are the worst case — one comment carried seven of them onto a `break` and three comments,
  invalidated silently by a refactor in the same commit.
- **Do not blanket-replace.** In that same pass the identical phrase "once per session" was **correct** two
  files away, describing a different record with a genuinely per-session key. A global substitution would have
  broken the true half while fixing the false one, and the distinction was the whole point of the fix.
- **A justification that cites another command is a claim about that command, and nothing you run checks
  it.** The three habits above all assume the sentence was true once. This one never was. `tapflow setup`
  was changed to exit 1 on `SETUP INCOMPLETE`, and the reason given — in the changeset, the changelog and
  the code comment — was *"`tapflow doctor` already exits 1 for the same state"*. The author had grepped
  `doctor.ts`, seen `process.exit(1)` at three call sites, and stopped at the call. Its predicate is
  `hasFailures = !ok && !warn`, one screen above, with a comment saying a warn does not count. Nearly every
  pending step in `lib/setup.ts` is `ok: false, warn: true`, so the two disagree on the ordinary cases: a Mac
  with no simulator runtime passes `doctor` and fails `setup`.

  **The change was right and the reason was false**, which is the expensive combination — a false citation
  does not just misinform, it conceals that the decision was never made. "Align with `doctor`" needs no
  further argument, so nobody writes one; once the citation goes, the real reason ("the predicate the banner
  already used, and deliberately stricter than `doctor`") is still unwritten. Green through 510 tests,
  repo-wide typecheck and lint, and a five-mutation sweep on the predicate. **The sweep was not even blind:
  measured afterwards, mutating the predicate to `doctor`'s own rule does fail, and fails on the assertions
  that change added.** No suite was ever going to catch it, because the false sentence is about a file
  nothing relates to this one.

  So: **when a justification names another command or module, open it and read the predicate, not the call
  site.** And when two components deliberately answer differently, say so beside both — see
  `packages/cli/AGENTS.md` on `doctor` and `setup`.

### A prompt skeleton that stays cheap

What made the 4m30s pair cheap was structural, not stylistic. Each prompt carried:

1. **One lens, named.** "Your lens is whether the uncommitted diff changes runtime behaviour" — not
   a list of five concerns.
2. **The measurements, as premises.** File counts, error counts, config contents, wired-up scripts —
   whatever you already ran. Followed by: do not re-run these. Facts only: a cause or a reason
   something is safe is not a premise.
3. **The files to read, listed.** Otherwise the reviewer greps the tree to find them. **When one of
   the lenses is whether the prose is still true, that list has to name `contributing/` too.** A
   review of the tunnel-port change listed `docs/`, the AGENTS files and the CHANGELOG, and its
   reviewer cleared them all correctly — while two decision records went on stating the invariant the
   change had just narrowed, one of them in its own "read this before" header. The author found them
   after the PR was open. The directory is where the *reasons* live, so it is the one place a wrong
   sentence argues for the design that was removed.
4. **The commands not to run**, by name.
5. **A findings cap and a time budget.**
6. **A required "checked and cleared" list**, so coverage is visible when nothing is found.
7. **A now/later column on every finding, a `later` budget of two per channel — and for every
   `later`, the reason plus a one-line issue title and body.**

   The budget is the part that was missing, and its absence is measured: capping findings while
   leaving deferrals free produced nine issues from three PRs in a day. Ask the reviewer to justify
   each `later` against the ten-line rule, and **re-grade every one of them yourself** — the column is
   the reviewer's opinion about work it is not doing.

   Every issue that does get filed names its parent on a line of its own (`Parent: #607`), which is
   what lets the work it came from enumerate what it still owes.
 Without the column the split falls to whoever holds the diff, who is the person
   least able to see what deferring costs, and the answer defaults to "later" because that is what
   keeps the diff small. Without the issue text, "later" costs a sentence while filing costs a task,
   and the cheaper one wins — which is how six deferrals came to live in a single conversation. The
   root [AGENTS.md](../AGENTS.md#an-adjacent-defect-is-fixed-here-unless-it-needs-its-own-decision)
   has the line: roughly ten lines under the lens already running is fixed here, a design decision is
   not. Measured once: six deferrals from a four-issue session, three of them a single line each.

## Cross-cutting changes — review the design before the code

Applies when a change spans **two or more packages, or both platforms**. Skip it for work inside one
package.

1. **Write the invariant table first** — one row per path or state, one column per platform, and what
   the *user* observes. Put it in the plan document. The clipboard bridge took eleven review rounds
   largely because this table was never written: the same class of defect (one platform fixed, the
   other not) was found five separate times, each by a reviewer rather than by looking.
2. **Review the design before the code.** One adversarial pass over the plan and that table, before
   implementing. The expensive rounds on a multi-package feature are the ones where the mechanism
   itself was wrong, and a wrong mechanism is cheapest to find on paper. This is **in addition to**
   the pre-PR review, not instead of it.
3. **A design-level review finding means replan, not patch.** If a reviewer says the *shape* is wrong
   — wrong scope for a flag, wrong owner for a decision — stop and redo that part. Patching a design
   finding produced the next design finding three times in a row on the clipboard branch.
4. **Mutate the guards too.** A test written to catch drift or protect an invariant is itself untested
   until you break the thing it guards and watch it fail — and until you run it **alone**. Three
   separate guards on the clipboard branch had the very hole they were written to close, including
   one that only worked because a sibling `describe` leaked its environment.

A worked example of the payoff: a two-package chore planned two code edits to satisfy new lint
errors. The design pass established that one error was a false positive on a load-bearing rotation
path and the other sat in an export that never renders — both planned edits became suppressions with
recorded reasons, and the regressions they would have introduced had no test to catch them. Cost: 4
minutes 30 seconds.

## The record

Write findings + dispositions (fixed, or skipped with a reason) to `.work/reviews/<branch>.md`
(slashes → `__`), including the **full 40-character HEAD hash** (`git rev-parse HEAD` — an
abbreviated hash will not pass the gate). Mention the review in the PR body.

The hook `.claude/hooks/adversarial-review-gate.sh` blocks PR creation unless that record exists and
references the current HEAD. **Any commit after the review invalidates the record** until it is
refreshed against the new diff — including a commit that only fixes what the review found.

Record the dispositions honestly. A finding you skipped needs the reason in writing; a finding whose
severity you re-graded needs the re-grading and its basis, not a silent downgrade. The record is read
later by someone deciding whether a defect was known.
