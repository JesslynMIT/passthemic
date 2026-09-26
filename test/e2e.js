// End-to-end: host creates a session, two participants join, raise hands,
// host taps Next, audio track arrives at the host over WebRTC, handoff + cut work.
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const host = await ctx.newPage();
  const errors = [];
  for (const p of [host]) p.on('pageerror', e => errors.push('host: ' + e.message));

  await host.goto(`${BASE}/host.html`);
  await host.fill('#sname', 'Test Study Group');
  await host.click('button[type=submit]');
  await host.waitForSelector('#app:not(.hidden)');
  const code = (await host.textContent('#code')).trim();
  console.log('session code', code);
  assert.match(code, /^[A-Z]{3}-\d{3}$/);
  assert.ok((await host.getAttribute('#qr', 'src')).includes(code));

  // Each participant gets its own browser context = its own phone (own localStorage).
  const phones = {};
  const join = async (name) => {
    const c = await browser.newContext({ permissions: ['microphone'] }); phones[name] = c;
    const p = await c.newPage();
    p.on('pageerror', e => errors.push(name + ': ' + e.message));
    await p.goto(`${BASE}/?code=${code}`);
    await p.fill('#name', name);
    await p.click('button[type=submit]');
    await p.waitForSelector('#room:not(.hidden)');
    return p;
  };
  const maria = await join('Maria L.');
  const david = await join('David K.');
  await host.waitForFunction(() => document.querySelector('#count').textContent.startsWith('2'));

  // raise hands
  await maria.click('#hand'); await david.click('#hand');
  await host.waitForFunction(() => document.querySelectorAll('.qitem').length === 2);
  assert.equal(await maria.textContent('#handTitle'), 'Hand raised');
  await david.waitForFunction(() => document.querySelector('#posTitle').textContent.trim() === "You're 2nd", null, { timeout: 5000 });
  await maria.waitForFunction(() => document.querySelector('#posTitle').textContent.trim() === "You're next", null, { timeout: 5000 });

  // host taps Next -> Maria live, audio arrives
  await host.click('#next');
  await maria.waitForSelector('#live:not(.hidden)');
  await host.waitForFunction(() => window.__host.tracks === 1 && ['connected', 'connecting'].includes(window.__host.pcState), null, { timeout: 15000 });
  await host.waitForFunction(() => window.__host.pcState === 'connected', null, { timeout: 15000 });
  console.log('host audio link:', await host.evaluate(() => window.__host.pcState), 'tracks:', await host.evaluate(() => window.__host.tracks));
  assert.equal((await host.textContent('#liveName')).trim(), 'Maria L.');
  assert.equal((await david.textContent('#posTitle')).trim(), "You're next");
  assert.ok((await maria.textContent('#nextName')).includes('David'));

  // mute propagates
  await maria.click('#mute');
  await host.waitForFunction(() => document.querySelector('#liveLabel').textContent.includes('muted'));

  // Maria done -> floor open, David still next
  await maria.click('#done');
  await maria.waitForSelector('#room:not(.hidden)');
  await host.waitForFunction(() => window.__host.pcState === 'none');
  assert.equal((await host.textContent('#liveName')).trim(), 'David K. is up next');

  // handoff: make David a facilitator; he taps Next on his phone and goes live himself
  await host.evaluate(() => { const b = [...document.querySelectorAll('#members button')].find(x => x.textContent.startsWith('David')); if (!b.classList.contains('on')) b.click(); });
  await david.waitForSelector('#facbar:not(.hidden)');
  await david.click('#facNext');
  await david.waitForSelector('#live:not(.hidden)');
  await host.waitForFunction(() => window.__host.pcState === 'connected', null, { timeout: 15000 });

  // host cuts him
  await host.click('#cut');
  await david.waitForSelector('#room:not(.hidden)');
  assert.equal((await david.textContent('#posTitle')).trim(), 'Your turn ended');

  // --- close the app with hand down: still a member, just "closed"; reopen = instant rejoin, same identity
  const mariaUrl = maria.url();
  await maria.close();
  await host.waitForFunction(() => document.querySelector('#count').textContent.includes('2 in the room · 1 phone open'));
  const maria2 = await phones['Maria L.'].newPage();
  await maria2.goto(`${BASE}/`);                       // plain URL, no code: remembered session
  await maria2.waitForSelector('#room:not(.hidden)', { timeout: 5000 });
  assert.equal((await maria2.textContent('#meName')).trim(), 'Maria L.');
  await host.waitForFunction(() => document.querySelector('#count').textContent.includes('2 in the room · 2 phones open'));
  assert.ok((await maria2.textContent('#micNoteText')).includes('You can close this now'));

  // --- close the app with hand UP: keeps place but Next skips to the next open phone
  await maria2.click('#hand'); await david.click('#hand');
  await host.waitForFunction(() => document.querySelectorAll('.qitem').length === 2);
  await maria2.close();
  await host.waitForFunction(() => document.querySelector('.qitem').textContent.includes('phone closed'));
  assert.ok((await host.textContent('#next')).includes('David'), 'Next should skip the closed phone');
  await host.click('#next');
  await david.waitForSelector('#live:not(.hidden)');
  await host.click('#cut');
  await david.waitForSelector('#room:not(.hidden)');

  // Maria reopens: her hand is still up, and she's now first in line
  const maria3 = await phones['Maria L.'].newPage();
  await maria3.goto(`${BASE}/`);
  await maria3.waitForSelector('#room:not(.hidden)');
  await maria3.waitForFunction(() => document.querySelector('#handTitle').textContent === 'Hand raised');
  assert.equal((await maria3.textContent('#posTitle')).trim(), "You're next");

  // explicit Leave really leaves
  await maria3.click('#leave');
  await host.waitForFunction(() => document.querySelector('#count').textContent.startsWith('1 in the room'));

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  console.log('ALL E2E CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('E2E FAILED:', e.message); process.exit(1); });
