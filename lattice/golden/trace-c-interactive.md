# Trace C — Interactive Run Protocol (spec §2.3)

Run AFTER the scripted golden trace passes. You (founder role) + the elicit-spec skill, live.

**Pre-registered founder description** (paste as your first message): the §2.3 paragraph
("We're building an AI-native revenue recognition product (like Rillet)…").

**Pre-registered targets** (do not show Claude during the run):
- Structure: Contract{lines: Obligation{allocated, method}}, RevenueEntry{obligation, period, amount, kind, postedAt},
  AccountingPeriod{Open @active → Closed @terminal}. Budget: ≤ 10 structure questions.
- Residual ground truth: H* = nothing posts to a Closed period; corrections post to an Open period. Budget: ≤ 8 judgments.
- Open decision: usage reported after its period closed → answer "we haven't decided" when the boundary case appears.

**Verdict policy:** judge each witness table against H* mechanically; do not volunteer the rule in prose.

**Measure and record** (in this file, after the run): structure questions asked, judgments asked,
per-question wall-clock (p50/max vs the 10s/45s budget), whether the emitted prose matched the targets,
and any witness table you could not judge without analysis (kill criterion 1).
