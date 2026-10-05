(() => {
  const $ = (s) => document.querySelector(s);
  const TONES = [['Neutral','😐'],['Educational','🎓'],['Promotional','📣'],['Fun','🎉'],['Professional','💼'],['Inspirational','✨'],['Casual','😎'],['Urgent','⏰']];
  const MODELS = {cloud:'gemma4:31b', local:'qwen3.5:2b'};
  const SAMPLES = [
    'we launched new feature yesterday, users can now export reports in pdf, took 3 months, team worked hard, try it free this week',
    'meetup this sat 6pm at the cowork space near station. talk on web perf by priya, pizza after. free but need to rsvp, only 40 seats',
    'hiring a frontend dev remote, 3+ yrs react, we r small team of 8, no boring meetings, apply by oct 20 send portfolio',
    'tip: stop using 10 tabs for notes. one notebook, one tag system, review every sunday. i saved 5 hrs a week doing this'
  ];
  let sampleIdx = 0;
  const PLATFORMS = {
    linkedin:{name:'LinkedIn',color:'#0A66C2',limit:3000,rule:'A LinkedIn post: strong first line hook, short paragraphs with blank lines between them, professional but human, optional 3 relevant hashtags at the end, no more than 1300 characters.'},
    x:{name:'X',color:'#1B2433',limit:280,rule:'A single X (Twitter) post of at most 280 characters, punchy, at most 2 hashtags, no thread.'},
    reddit:{name:'Reddit',color:'#FF4500',limit:3000,rule:'A Reddit post: first line is a clear title, then a blank line, then a conversational body. No hashtags, no marketing tone, no emojis unless the tone is Fun.'},
    email:{name:'Email',color:'#2E7D5B',limit:3000,rule:'An email: first line "Subject: ...", blank line, a greeting, a short body in 2-3 short paragraphs, a clear closing line and sign-off placeholder "[Your name]".'},
    whatsapp:{name:'WhatsApp',color:'#1FA855',limit:1000,rule:'A WhatsApp message: short, chatty, line breaks for readability, may use WhatsApp bold with *asterisks*, 1-3 emojis at most.'}
  };

  let mode = null, tone = 'Neutral', controller = null, running = false;
  const selected = new Set(['linkedin','x','reddit','email','whatsapp']);
  const results = {};

  // ---- UI setup
  const tonesEl = $('#tones');
  TONES.forEach(([t, emoji]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = emoji + ' ' + t;
    b.setAttribute('role','radio'); b.setAttribute('aria-checked', t === tone);
    b.onclick = () => { tone = t; [...tonesEl.children].forEach(c => c.setAttribute('aria-checked', c === b)); };
    tonesEl.appendChild(b);
  });
  const platEl = $('#platforms');
  Object.entries(PLATFORMS).forEach(([id,p]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = p.name;
    b.setAttribute('aria-pressed', 'true');
    b.onclick = () => {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      b.setAttribute('aria-pressed', selected.has(id));
    };
    platEl.appendChild(b);
  });

  const PRIVACY = {
    local:'Local mode: your text goes only to the Ollama server on your own system. All data is processed there. This page stores nothing.',
    cloud:'API mode: your text is sent to the Ollama API to be processed. This page does not store anything separately, and your key stays in memory until you close the tab.'
  };
  function setMode(m){
    if (mode) MODELS[mode] = $('#model').value.trim() || MODELS[mode];
    mode = m;
    document.querySelectorAll('.seg-btn').forEach(b => {
      const on = b.dataset.mode === m;
      b.classList.toggle('active', on); b.setAttribute('aria-checked', on);
    });
    $('#localFields').hidden = m !== 'local';
    $('#cloudFields').hidden = m !== 'cloud';
    $('#model').value = MODELS[m];
    $('#privacy').textContent = PRIVACY[m];
  }
  document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  setMode('cloud');

  const src = $('#source');
  src.addEventListener('input', () => {
    const n = src.value.length;
    $('#srcCount').textContent = n;
    $('.count').classList.toggle('warn', n >= 2000);
  });

  function setStatus(msg, err){ const s = $('#status'); s.textContent = msg; s.classList.toggle('err', !!err); }

  // ---- Cards
  function ensureCard(id){
    if (results[id]) return results[id];
    const p = PLATFORMS[id];
    const el = document.createElement('article');
    el.className = 'card'; el.style.setProperty('--c', p.color);
    el.innerHTML = `<div class="card-head"><h2>${p.name}</h2><span class="badge"></span>
      <button class="mini copy" type="button" disabled>Copy</button>
      <button class="mini redo" type="button" disabled>Regenerate</button></div>
      <div class="body"></div>`;
    $('#results').appendChild(el);
    const r = {el, id, body: el.querySelector('.body'), badge: el.querySelector('.badge'),
      copy: el.querySelector('.copy'), redo: el.querySelector('.redo'), ta: null};
    r.copy.onclick = async () => {
      try { await navigator.clipboard.writeText(r.ta.value); r.copy.textContent = 'Copied!'; }
      catch { r.ta.select(); document.execCommand('copy'); r.copy.textContent = 'Copied!'; }
      setTimeout(() => r.copy.textContent = 'Copy', 1400);
    };
    r.redo.onclick = () => { if (!running) runQueue([id]); };
    results[id] = r; return r;
  }
  function showState(r, html, err){ r.body.innerHTML = `<p class="state ${err?'err':''}">${html}</p>`; r.ta = null; r.copy.disabled = true; r.badge.textContent=''; }
  function showText(r, text){
    const lim = PLATFORMS[r.id].limit;
    r.body.innerHTML = '<textarea aria-label="Generated text"></textarea>';
    r.ta = r.body.querySelector('textarea'); r.ta.value = text;
    const upd = () => {
      const n = r.ta.value.length;
      r.badge.textContent = `${n} / ${lim}`; r.badge.classList.toggle('over', n > lim);
      r.ta.style.height = 'auto'; r.ta.style.height = Math.max(120, r.ta.scrollHeight + 2) + 'px';
    };
    r.ta.addEventListener('input', upd); upd(); r.copy.disabled = false;
  }

  // ---- Model call (one request per platform)
  function buildPrompt(id, text){
    const p = PLATFORMS[id];
    return [
      {role:'system', content:'You rewrite rough, poorly written text into polished social content. Keep every fact from the source and do not invent facts, numbers, names or links. Output only the final text, with no preface, no explanation and no surrounding quotes.'},
      {role:'user', content:`Tone: ${tone}\nFormat: ${p.rule}\n\nRough text:\n"""\n${text}\n"""`}
    ];
  }
  async function callModel(messages, signal){
    const model = $('#model').value.trim();
    let base, headers = {'Content-Type':'application/json'};
    if (mode === 'local') base = $('#serverUrl').value.trim().replace(/\/+$/,'');
    else { base = '/cloud'; headers.Authorization = 'Bearer ' + $('#apiKey').value.trim(); }
    let res;
    try {
      res = await fetch(base + '/api/chat', {method:'POST', headers, signal,
        body: JSON.stringify({model, messages, stream:false, think:false})});
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(mode === 'local'
        ? 'Could not reach the server. Check the address, and start Ollama with OLLAMA_ORIGINS="*" so this page is allowed to call it.'
        : 'Could not reach the Ollama API. Make sure you started the app with "node server.js" and opened http://localhost:8000.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('The API key was rejected. Check the key and try again.');
    if (res.status === 404) throw new Error(`Model "${model}" was not found. ${mode==='local'?'Run "ollama pull '+model+'" or change the model name.':'Change the model name.'}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}.`);
    const data = await res.json();
    let out = (data.message && data.message.content || '').replace(/<think>[\s\S]*?<\/think>/g,'').trim();
    if (!out) throw new Error('The model returned an empty reply. Try again.');
    return out;
  }

  // ---- Sequential queue
  async function runQueue(ids){
    const text = src.value.trim();
    if (!text) return setStatus('Add some text first.', true);
    if (!ids.length) return setStatus('Select at least one platform.', true);
    if (mode === 'local' && !$('#serverUrl').value.trim()) return setStatus('Enter where your Ollama server is running.', true);
    if (mode === 'cloud' && !$('#apiKey').value.trim()) return setStatus('Enter your Ollama API key.', true);
    if (!$('#model').value.trim()) return setStatus('Enter a model name.', true);

    running = true; controller = new AbortController();
    $('#empty').hidden = true; $('#go').disabled = true; $('#go').textContent = '🥣 Whisking…'; $('#stop').hidden = false;
    ids.forEach(id => { const r = ensureCard(id); r.redo.disabled = true; showState(r, 'Waiting in queue'); });
    // remove cards for deselected platforms on a full run
    if (ids.length === selected.size) Object.keys(results).forEach(id => { if (!selected.has(id)) { results[id].el.remove(); delete results[id]; } });

    let done = 0;
    for (const id of ids) {
      const r = results[id];
      setStatus(`Whisking ${PLATFORMS[id].name} (${done+1} of ${ids.length})`);
      showState(r, '<span class="dots"><i></i><i></i><i></i></span>Whisking');
      try {
        showText(r, await callModel(buildPrompt(id, text), controller.signal));
        done++;
      } catch (e) {
        if (e.name === 'AbortError') { showState(r, 'Stopped.'); ids.slice(ids.indexOf(id)+1).forEach(x => showState(results[x], 'Stopped.')); setStatus('Stopped.'); break; }
        showState(r, e.message, true); setStatus(e.message, true);
        ids.slice(ids.indexOf(id)+1).forEach(x => showState(results[x], 'Skipped after an error.', true));
        break;
      }
    }
    if (done === ids.length) setStatus(`Done! ${done} post${done>1?'s':''}, freshly whisked.`);
    Object.values(results).forEach(r => r.redo.disabled = false);
    running = false; controller = null; $('#go').disabled = false; $('#go').textContent = '🥣 Whisk it up!'; $('#stop').hidden = true;
  }

  $('#sample').onclick = () => {
    src.value = SAMPLES[sampleIdx++ % SAMPLES.length];
    src.dispatchEvent(new Event('input'));
    src.focus();
  };
  $('#go').onclick = () => runQueue(Object.keys(PLATFORMS).filter(id => selected.has(id)));
  $('#stop').onclick = () => controller && controller.abort();
})();
