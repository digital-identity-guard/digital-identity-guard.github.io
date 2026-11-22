# 🛡️ Digital Identity Guard · حارس الهوية الرقمية

An awareness tool that answers two questions about an unfamiliar social-media account:

1. **Is this account really who it claims to be?**
2. **Is it trying to scam me?**

Student project – Ebdaa 2026 · Yazan Omar Alzahrani · Mohannad Ali Alghamdi

## Run it

Open `index.html` in any browser. There is no build step and no server: every check runs in the browser and nothing you type is sent anywhere. The site never contacts Instagram, X or any other platform.

## How a check works

1. **Choose a mode:** Manual check or AI analysis.
2. **Enter the account:** an X or LinkedIn username or profile link. A link sets the platform by itself; for a bare username the user picks X or LinkedIn.
3. **Optional:** paste a message the account sent.
4. **Manual only:** the verification badge question and the 12-item checklist.

### Results (top to bottom)

1. The safety disclaimer.
2. The four sharing categories, with the one for this check highlighted: Never share (0-3), Public info (4-5), Professional info (6-7), Personal info (8-10).
3. The score out of 10.
4. What the account passed and failed: the 12 checklist items (manual) or all 9 indicator groups (AI).
5. The analysis of the pasted message.

### Scoring

Each check gives a score out of 10, which maps to one of the four categories. Serious warning signs cap the score.

## AI analysis

The AI analysis is powered by Claude through a small backend in [`worker/`](worker/README.md) (a Cloudflare Worker), which keeps the API key secret and limits each visitor to 4 analyses per hour. Put the Worker's address in `js/config.js`. Until then, the AI mode uses the browser's own checks only.

## Files

| File | What it does |
| --- | --- |
| `js/check.js` | Manual and AI scoring, categories |
| `js/messages.js` | Scam analysis of the pasted message (Arabic + English) |
| `js/analyzer.js` | Link / username parsing and look-alike checks |
| `js/guard.js` | Badge meanings |
| `js/i18n.js`, `js/i18n-check.js` | Arabic and English text |
| `js/config.js` | AI backend address |
| `worker/` | AI backend (Cloudflare Worker) |
