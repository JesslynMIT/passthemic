# Pass the Mic

Speak from your seat. Everyone's phone is a microphone; a queue decides whose is on.
The facilitator taps **Next** from her chair, and the chosen phone streams voice to the
laptop plugged into the room speakers. No app to install, no mic to carry around.

## How it works

| Piece | What it does |
| --- | --- |
| `server.js` | One small Node process: serves the pages, keeps the room/queue state, relays WebRTC signaling. Audio never passes through it. |
| `public/index.html` | Participant phone: join by QR or code, raise hand, see your position, go live, mute, "I'm done". Facilitator controls appear when you're handed the host role. |
| `public/host.html` | Host device (the laptop on the speakers): creates the session, shows the QR code, plays whoever is live, Next / Cut / Give floor / hand off. "Room screen mode" hides the controls for the projector. |
| `test/e2e.js` | Headless-browser test of the whole flow, including the audio link. |

Audio path: participant phone → WiFi (WebRTC, ~100 ms) → host laptop → 3.5 mm / USB → room speakers.

## Run it locally (5 minutes)

```bash
npm install
npm start          # http://localhost:3000
```

Open `http://localhost:3000/host.html` on the laptop, create a session, and you'll see the QR code and a code like `WED-412`.

**Phones need HTTPS to use the microphone.** `localhost` is exempt, but phones on your WiFi are not. Two easy ways:

1. **Deploy it** (below) — simplest, and you get a permanent link the group can bookmark.
2. **Tunnel for a test session:** `npx localtunnel --port 3000` (or ngrok / Cloudflare Tunnel) gives you a temporary `https://` URL. Open the host page through that URL so the QR code points at it.

## Deploy (free tier is plenty)

The app is a plain Node server with no database, so any host that runs `npm start` works.

**Render** (recommended): New → Web Service → connect this folder's repo → Build `npm install`, Start `npm start`. Done; you get `https://<name>.onrender.com`.

**Railway / Fly.io:** same two commands. Set `PORT` only if the host doesn't inject it.

Environment variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `AWAY_HAND_MS` | `300000` | How long a closed phone keeps its raised hand (5 min) |
| `HOST_PIN` | unset | When set, the host page asks for this PIN before creating or taking over a session. Set it on Render → Environment. The join page never needs it. |
| `ICE_SERVERS` | STUN only | JSON array of ICE servers. Add a TURN server here if attendees will be on cellular data rather than the room WiFi (see "Large rooms") |

The 90 s silence auto-release is set by `SILENCE_MS` in `public/index.html`.

## Running a session

1. On the laptop connected to the speakers, open `/host.html`, name the session, click **Create session**. Click once anywhere if the "Tap to enable room audio" overlay appears (browsers require one click before playing sound).
2. Put the laptop on the projector — **Fullscreen**, then **Room screen mode** to hide the buttons.
3. People scan the QR code (or type the code at the site), enter their name, and tap **Join**.
4. They tap **Raise hand**. The host page and every phone show the queue.
5. Facilitator taps **Next** (on the laptop, or on her own phone once she's been handed the host role — tap her name under "Who can run the queue"). The person's phone turns green and their voice comes out of the speakers.
6. Speaker taps **I'm done**, or the facilitator taps **Next** / **Cut**. 90 s of silence also releases the mic.

## Closing the app is fine

Attendees only need the app open to raise a hand and to speak.

| Situation | What happens |
| --- | --- |
| Hand down, app closed or phone locked | Still a member. The host screen shows "N phones open" separately from "N in the room". Nothing to do. |
| Open the app again (home-screen icon or the QR) | Straight back in, same name, no form. |
| Hand up, app open | Screen stays awake automatically. The phone says "Keep this open while your hand is up". |
| Hand up, app closed anyway | Keeps its place in the queue for 5 min, shown as "phone closed · skipped". **Next** skips to the first open phone. If they reopen in time they're still in line. |
| **Leave** button | Really leaves; next visit shows the join form. |

Tip for regulars: Add to Home Screen once, then it's one tap to raise a hand.

## Large rooms (40+ people)

- **Everyone on the same WiFi as the host laptop** is the reliable path: signalling is tiny and the live phone connects to the laptop directly over the LAN.
- **A phone hotspot is not a fallback at this size** — hotspots cap at roughly 10 devices. If the venue WiFi is bad, people can use cellular data instead, but then the live phone and the laptop are on different networks and the audio link needs a TURN relay. Set `ICE_SERVERS` with a TURN server (Cloudflare and Metered both have free tiers) — no code change.
- **Speaker:** a small Bluetooth speaker (JBL Flip/Charge class) covers ~20 people; for 60 use a PartyBox-class speaker or the room PA. Put it at the front, away from the seats.
- **Facilitation:** hand the host role to a second person so the queue keeps moving if the facilitator is speaking.
- **Room screen:** use Fullscreen + Room screen mode; the QR is the join path for most people, so make it big. The session code is on screen for anyone who can't scan.

## Feedback (echo) control

Browser echo cancellation only removes sound the *same device* plays, and the live phone plays nothing — so it does not stop room feedback by itself. What does:

| Layer | What it does |
| --- | --- |
| Phone: auto-gain OFF | AGC amplifies quiet input; that is what turns a faint echo into a howl |
| Phone: noise gate | Mic is effectively closed between words; opens in ~5 ms on voice. Threshold adapts to each phone's noise floor |
| Phone: high-pass + compressor | Cuts rumble and handling noise; tames loud bursts |
| Host: volume slider | Set it during sound check: raise until you hear a faint ring, then back off 20% |
| Host: limiter | Hard ceiling so a spike can't run away |
| Host: **Kill feedback** button | Mutes the room for 2 s, then returns at 70% of the previous level |
| Room: placement | Speaker at the front, pointing at the audience; seats start 2–3 m back; speakers hold the phone near the mouth |

Sound-check routine (2 minutes, before people arrive): one person live at the front row, one at the back row. Raise volume until the back can hear clearly. If it rings, tap Kill feedback and leave it at the level it returns to.

## Tips that matter in a real room

- **Feedback:** keep the speakers a few metres from the seats; the phone's own speaker is never used, and echo cancellation is on. If you still get a squeal, lower the PA a notch.
- **Bad WiFi:** turn on a hotspot from the laptop or one phone and have everyone join that; a room of 30 phones only sends tiny messages except the one that's live.
- **Nobody with a phone / dead battery:** keep the old mic for that one person.
- **Reload safety:** phones remember the session until they tap Leave; the host page remembers it for the tab's lifetime.
- **Privacy:** the browser asks for the mic only when a person is on deck or live; the mic is released as soon as their turn ends.

## Test

```bash
npm start &
npm test
```

Runs a headless host plus two participants with fake microphones and checks join → raise → Next → audio connected → mute → done → hand off → cut.

## What's deliberately not in v1

Accounts, recording, captions, remote participants, native apps, more than one live speaker. See the product spec for the reasoning.
