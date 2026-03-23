# PermitIntel OSINT

OSINT-powered permit intelligence and deal generation engine.

## What this does
- Ingests permit data
- Generates monetizable opportunities
- Produces outreach-ready assets
- Routes through Cloudflare Worker (LLM + OSINT engine)

## Architecture

/app → frontend  
/worker → Cloudflare Worker (intelligence engine)  
/shared → shared types + schemas  

## Quick Start

1. Deploy Worker
2. Run frontend
3. Send permit → get deal asset
