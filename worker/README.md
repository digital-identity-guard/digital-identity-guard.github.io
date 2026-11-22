# AI analysis backend (Cloudflare Worker)

The website is static, so it cannot keep an API key secret. This small Worker holds the
Anthropic API key, limits each visitor to **4 AI analyses per hour**, asks Claude to research
the account on the public web (web search + web fetch), and sends back one result per indicator.

## One-time setup (about 10 minutes)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Get an Anthropic API key at https://platform.claude.com (Settings → API keys).
3. In this `worker` folder:

   ```bash
   npm install
   npx wrangler login
   npx wrangler kv namespace create RATE_LIMIT   # paste the printed id into wrangler.toml
   npx wrangler secret put ANTHROPIC_API_KEY     # paste your API key when asked
   npx wrangler deploy
   ```

4. `wrangler deploy` prints the Worker address, e.g.
   `https://digital-identity-guard-ai.<your-subdomain>.workers.dev`.
   Put it in `js/config.js` on the website as `aiEndpoint`.

## Notes

- The limit is per visitor IP address, over a rolling hour. Change `MAX_PER_HOUR` in `src/index.js`.
- Only the sites listed in `ALLOWED_ORIGINS` can call the Worker.
- Each analysis runs Claude Opus 5.5 with up to 6 web searches and 4 page fetches, so it costs a few cents.
- X and LinkedIn often block automated page reads. Claude then relies on search results and other
  public sources, and marks anything it could not see as "Not checked".
