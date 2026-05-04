# Authors / Identity Map

This repo is operated by two GitHub identities, by design (see PR Gating Standard v1.1 §3.1.1).

## Human identity — `chrisberno`
- CEO + CTO seat both review/approve/merge as this identity.
- Should NEVER be the *author* of a PR opened from a feature branch.

## Bot identity — `onreb-bot[bot]` (App ID 3591125)
- All executing agents (Traycer, PP-CTO seat, Claude execute mode) commit + push + open PRs as this identity.
- Cannot self-approve (GitHub rule) — by design, this is the lever that forces every change through `chrisberno` review.

The split exists so the CTO seat retains formal `gh pr review --approve` authority on bot-authored PRs without GitHub blocking self-approval. See `~/.claude/credentials/GITHUB-BOT-IDENTITY.md` for credential details (local-only).

Tracked under ONR-79.
