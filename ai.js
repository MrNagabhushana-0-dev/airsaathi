/*
 * AirSaathi - GenAI assistant backends.
 *
 * Provider chain, in preference order under "auto":
 *  1. "gemini"       Google Gemini API (AI Studio free tier), only when the
 *                    visitor has explicitly entered their own key in
 *                    Settings; stored only in their own browser's
 *                    localStorage, never part of this repo.
 *  2. "pollinations" Pollinations.ai free text API (https://text.pollinations.ai/),
 *                    the default hosted route, keyless. Requests ask
 *                    Pollinations to keep the chat out of their public feed
 *                    (private:true) and carry only the chat content: the
 *                    visitor's question plus the minimized context JSON
 *                    (current city AQI snapshot and the few profile facts an
 *                    answer needs). This is a third-party service: anything
 *                    sent leaves the visitor's device.
 *  3. "nano"         Chrome's built-in Prompt API (Gemini Nano), fully
 *                    on-device, when the visitor's browser supports it.
 *
 * If the chosen backend is unavailable the assistant says so plainly and
 * points to AI Settings - there is no hidden fallback to canned answers,
 * and the rest of the app keeps working on live data.
 *
 * The assistant is grounded on the live AQI snapshot and the visitor's
 * household profile through a system prompt, so answers are dynamic and
 * context-specific rather than canned.
 */
(function (root) {
  'use strict';

  var SYSTEM_PROMPT = [
    'You are Saathi, the air-quality assistant inside the AirSaathi web app.',
    'You help families and communities cope with winter smog and urban air',
    'pollution. You are given the live air-quality snapshot and the user\'s',
    'household profile as JSON context. Ground every answer in that context:',
    'reference the actual AQI numbers, the actual pollutants and the actual',
    'profile. Suggest low-emission daily routines, indoor air-quality hacks',
    'and sustainable alternatives, and always explain the direct impact of',
    'each suggestion in one short sentence. Follow public EPA-style health',
    'guidance for the current AQI band; when the band is Unhealthy or worse,',
    'or the household includes sensitive members and the band is above',
    'Moderate, do not recommend outdoor exertion - describe the lowest-AQI',
    'stretch only as the least-bad time for unavoidable trips. Be warm,',
    'concrete and brief: 3-6 sentences or a short list. Never invent AQI',
    'readings; if the context has no data, say so and give general guidance.'
  ].join('\n');

  function buildMessages(context, history, userText) {
    var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (context) {
      msgs.push({ role: 'system', content: 'Live context JSON:\n' + JSON.stringify(context) });
    }
    (history || []).forEach(function (m) { msgs.push(m); });
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }

  function nanoAvailable() {
    if (typeof LanguageModel === 'undefined') return Promise.resolve(false);
    return LanguageModel.availability().then(function (a) {
      return a === 'available' || a === 'downloadable';
    }).catch(function () { return false; });
  }

  function nanoChat(context, history, userText) {
    var prompt = buildMessages(context, history, userText)
      .map(function (m) { return m.role.toUpperCase() + ':\n' + m.content; })
      .join('\n\n');
    return LanguageModel.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }]
    }).then(function (session) {
      return session.prompt(prompt).then(function (text) {
        session.destroy();
        return text;
      });
    });
  }

  function geminiChat(key, model, context, history, userText) {
    var contents = buildMessages(context, history, userText).map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user',
               parts: [{ text: m.content }] };
    });
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model || 'gemini-2.5-flash') + ':generateContent?key=' +
      encodeURIComponent(key);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: contents })
    }).then(function (res) {
      if (!res.ok) throw new Error('Gemini API error ' + res.status);
      return res.json();
    }).then(function (data) {
      var parts = data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts;
      if (!parts) throw new Error('Empty Gemini response');
      return parts.map(function (p) { return p.text || ''; }).join('');
    });
  }

  /* Pollinations.ai free text API - OpenAI-style POST, keyless anonymous
     tier, private:true asks them to keep the chat out of their public feed.
     In testing their own 402 response stated "1 reply every 45 seconds per
     IP"; on that response we wait the suggested time and retry once, then
     fail honestly if still limited. */
  function pollinationsOnce(context, history, userText) {
    return fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        private: true,
        referrer: 'airsaathi',
        messages: buildMessages(context, history, userText)
      })
    }).then(function (res) {
      if (res.ok) {
        return res.text().then(function (text) {
          if (!text || !text.trim()) throw new Error('Empty Pollinations response');
          return text.trim();
        });
      }
      return res.text().then(function (body) {
        var wait = /wait (\d+) seconds/i.exec(body || '');
        var err = new Error(res.status === 402
          ? 'the free Pollinations tier allows one message every ~45 seconds from the same network'
          : 'Pollinations error ' + res.status);
        err.retryAfterSec = wait ? Math.min(60, parseInt(wait[1], 10)) : (res.status === 402 ? 45 : 0);
        err.rateLimited = res.status === 402;
        throw err;
      });
    });
  }

  function pollinationsChat(context, history, userText) {
    return pollinationsOnce(context, history, userText).catch(function (err) {
      if (!err.rateLimited || !err.retryAfterSec) throw err;
      return new Promise(function (resolve) {
        setTimeout(resolve, (err.retryAfterSec + 2) * 1000);
      }).then(function () { return pollinationsOnce(context, history, userText); });
    });
  }

  /*
   * chat(settings, context, history, userText) -> Promise<{text, provider}>
   * settings: { provider: 'auto'|'nano'|'gemini'|'pollinations',
   *             geminiKey: '', geminiModel: '' }
   * "auto" tries the visitor's own Gemini key, then on-device Nano, then
   * the disclosed free Pollinations route. Nothing else.
   */
  function chat(settings, context, history, userText) {
    var preferred = (settings && settings.provider) || 'auto';
    var PROVIDER_POLLINATIONS = 'Pollinations.ai (free text API)';

    function tryGemini() {
      if (settings && settings.geminiKey) {
        return geminiChat(settings.geminiKey, settings.geminiModel, context, history, userText)
          .then(function (text) { return { text: text, provider: 'Google Gemini API' }; });
      }
      return Promise.reject(new Error('no visitor key'));
    }
    function tryNano() {
      return nanoAvailable().then(function (ok) {
        if (!ok) throw new Error('Browser AI unavailable on this device');
        return nanoChat(context, history, userText)
          .then(function (text) { return { text: text, provider: 'Browser AI (Gemini Nano, on-device)' }; });
      });
    }
    function tryPollinations() {
      return pollinationsChat(context, history, userText)
        .then(function (text) { return { text: text, provider: PROVIDER_POLLINATIONS }; });
    }
    function unavailable(err) {
      throw new Error('The AI assistant is unavailable right now (' + err.message +
        '). The live AQI tools above still work. You can add your own free Gemini key in AI Settings and try again.');
    }

    if (preferred === 'gemini') {
      return tryGemini().catch(function () {
        throw new Error('Add your Gemini API key in AI Settings first, or switch the backend to Auto.');
      });
    }
    if (preferred === 'nano') return tryNano();
    if (preferred === 'pollinations') {
      return tryPollinations().catch(unavailable);
    }
    /* auto: an explicitly configured key wins; otherwise the free
       Pollinations default, then on-device Nano as last resort. */
    return tryGemini()
      .catch(function () { return tryPollinations(); })
      .catch(function () { return tryNano(); })
      .catch(unavailable);
  }

  root.AI = { chat: chat, nanoAvailable: nanoAvailable, SYSTEM_PROMPT: SYSTEM_PROMPT };
})(typeof window !== 'undefined' ? window : globalThis);
