# AirSaathi — Urban Air Quality Assistant

**PromptWars Virtual · Challenge 06: Urban Air Quality Assistant**

AirSaathi is a GenAI-powered assistant that helps families and communities navigate
severe winter smog and urban air pollution. It reads the **live** air over any city,
builds a personalised plan (low-emission daily routines, indoor air-quality hacks,
sustainable alternatives) tuned to the household's location and lifestyle, and explains
the **direct impact** of every suggestion. A conversational AI assistant ("Saathi")
answers free-text questions grounded in the same live data and profile.

## Live demo

_Deployed link added at submission time._

## What it does

- **Live dashboard** — current US AQI with EPA band advice, six key pollutants
  (PM2.5, PM10, NO₂, O₃, SO₂, CO), and a 48-hour hourly AQI forecast chart with the
  cleanest 2-hour outdoor window highlighted.
- **Household profile** — children, elders, asthma/heart conditions, commute mode and
  distance, exercise habits, mask/purifier ownership. Saved only in the visitor's own
  browser (localStorage).
- **Personalised plan** — a deterministic, unit-tested recommendation engine turns the
  live AQI + hourly forecast + profile into:
  - a low-emission daily routine (best outdoor window, mask and exertion guidance),
  - indoor air-quality hacks (ventilation timing, HEPA use, indoor PM sources),
  - sustainable swaps with estimated weekly CO₂e savings and a plain-language "why".
- **AI assistant** — a chat panel backed by a real generative model (see below). The
  model receives the live AQI snapshot, the 12-hour forecast and the saved profile as
  JSON context, so answers are dynamic and specific ("Is 6 AM jogging OK for my father
  today?" is answered against *today's actual AQI*, not canned text).
- **Impact tracker** — ticking adopted swaps totals the estimated weekly CO₂e saving
  and translates it into an everyday equivalent.

## Where GenAI is used

1. **Runtime (in the product):** the assistant panel calls a generative model with a
   system prompt engineered for this domain plus the live context JSON
   (`ai.js`, `SYSTEM_PROMPT`). Backends, in preference order:
   - **Google Gemini API (AI Studio free tier)** — only when the visitor has explicitly
     entered their own key in AI Settings; stored only in their browser, never
     committed to this repo;
   - **Pollinations.ai free text API** (<https://text.pollinations.ai/>) — the disclosed,
     keyless hosted default. Requests ask Pollinations to keep chats out of their
     public feed (`private:true`) and carry only the chat content: the visitor's
     question plus a minimized context JSON (current city AQI snapshot and the few
     profile facts an answer needs). It is a third-party service: chat content leaves
     the visitor's device, and the pre-send notice in the UI says so. In our testing
     the provider's own rate-limit response stated one reply every 45 seconds per IP;
     the app detects that limit, waits and retries once, then says so plainly;
   - **Browser built-in AI (Gemini Nano via the Chrome Prompt API)** — fully on-device,
     no key, when the visitor's browser supports it (last resort under Auto).
   If the chosen backend is unavailable the assistant says so — there is no hidden
   fallback to canned answers, and everything else keeps working on live data. The
   provider used is shown under each answer, and the demo video shows a prompt going
   in and a fresh, context-specific response coming out.
2. **Build time:** the app was vibe-coded with AI coding assistants; the domain system
   prompt, recommendation rules and content were drafted and iterated with them.

The recommendation engine (`engine.js`) is deliberately deterministic and unit-tested
(`tests/engine.test.mjs`, 29 checks) so health-relevant guidance never depends on model
flakiness; the LLM layer adds free-form conversation on top of the same verified facts.

## Architecture

```
index.html   structure, accessibility (semantic landmarks, labels, ARIA)
styles.css   hand-written responsive styling, no framework
engine.js    pure recommendation logic: AQI banding (US EPA), best outdoor window,
             emission-factor savings, plan generation — unit-testable in Node
ai.js        GenAI provider chain + domain system prompt + context grounding
app.js       UI wiring: city search, geolocation, live data, chart, profile, chat
tests/engine.test.mjs   23 engine assertions, run with `node tests/engine.test.mjs`
```

No build step, no dependencies, no trackers; three small static files (< 100 KB total).

## Data sources and honesty notes

- Live air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)
  (CAMS-based, free, keyless). AQI on the US EPA scale.
- City search: Open-Meteo geocoding API.
- Emission savings use labelled **estimates**, all from one source on one consistent
  basis: OECD/ITF (2020), *Good to Go? Assessing the Environmental Performance of New
  Mobility*, Figure 2, p.23 — life-cycle g CO₂e per passenger-km (vehicle + fuel +
  infrastructure + operations, global-average occupancy), central estimates read
  approximately from the chart: private petrol car ≈155, private moped (closest
  category to an Indian petrol two-wheeler) ≈70, urban bus ≈90, metro/urban train ≈65.
  <https://www.oecd.org/content/dam/oecd/en/publications/reports/2020/09/good-to-go-assessing-the-environmental-performance-of-new-mobility_fabe5eab/f5cd236b-en.pdf>
  Auto-rickshaw is not covered by that source, so the app quotes no numeric saving for
  auto swaps. Figures are for comparison, not measurement — CO₂e avoided is a climate
  figure and does not claim a measured reduction in personal pollution exposure.
- Health guidance follows public EPA-band advisories: above Moderate, sensitive groups
  are told to avoid outdoor exertion; above USG/Unhealthy, everyone is. The day's lowest
  2-hour stretch is then presented only as the least-bad time for unavoidable trips,
  never as a safe exercise window. It is not medical advice.

## Run locally

Any static server works:

```bash
cd airsaathi
python3 -m http.server 8080     # then open http://localhost:8080
node tests/engine.test.mjs      # run the engine tests
```

Privacy: profile, adopted swaps and (if used) the visitor's Gemini key live only in the
visitor's browser localStorage. Nothing is sent anywhere except the chosen AI provider
and the public Open-Meteo APIs.
