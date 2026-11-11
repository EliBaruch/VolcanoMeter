# VolcanoMeter

A volcano that listens. It is shown in cross-section, so you can see the magma chamber and the chute up to the crater. Calm conversation leaves it asleep. Raised voices make the magma climb. A real shouting match makes it erupt.

Everything runs in the browser. Sound is analysed on the device and discarded; nothing is recorded, stored or sent anywhere.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the printed address, press **Start listening** and allow the microphone. Microphone access needs `https` (or `localhost`).

Other commands:

```bash
npm test
```

```bash
npm run build
```

`npm run build` writes a static site to `dist/`, which any static host can serve.

## Using it

- **Start listening** opens the microphone and learns the room for a few seconds. Talk normally at first so it learns what "normal" sounds like for these voices and this microphone.
- **Try it without a microphone** gives a slider (and the arrow keys) to drive the heat by hand.
- The settings button has sensitivity, a "Relearn" button for when the device moves or the room changes, a low-power mode and full screen.
- It can be installed to the home screen and works offline after the first visit.

URL options: `?demo` starts in manual mode, `?demo=0.6` starts at a fixed heat, `?scale=0.5` pins the render resolution.

## How it decides what is "heated"

`src/audio/heat.ts` reduces each audio frame to three numbers and combines them:

- **Loudness above the room.** The quietest moment of the last 30 seconds is the baseline, so a café and a quiet office both start at calm.
- **Loudness above these speakers' own normal.** It learns the typical level of the conversation, so sitting close to the microphone is not mistaken for shouting.
- **Vocal effort.** Raised voices shift energy toward higher frequencies, which does not depend on distance from the microphone.
- **How continuous the talking is.** Arguments leave few pauses.

These feed a slow integrator: one loud word nudges it, sustained raised voices drive it up, and it cools when people calm down. Automatic gain control is switched off on the microphone, because it would flatten a shout to normal volume.

## Sound

The volcano's sound is generated live with Web Audio (`src/audio/sound.ts`); there are no recordings. A deep rumble and churning grow with the heat, gas bubbles pop at the magma surface, gas hisses as the column nears the crater, and an eruption brings a blast, a roar, crackle, the thud of landing lava bombs and thunder. One-off sounds are triggered by the same random events as the picture.

The speaker button in the top bar mutes it, and the volume slider is in settings. Browsers only allow sound after a tap, so it starts with the first button press.

Because the app listens while it plays, three things stop the volcano reacting to itself:

- The microphone runs the browser's echo cancellation while sound is on (automatic gain stays off).
- Everything that plays before an eruption sits below the speech band, which the heat model ignores.
- An eruption has a fixed maximum length, so even on a device with no echo cancellation the roar cannot keep it going forever.

## How it is drawn

Raw WebGL2, no runtime dependencies.

- The magma is a small GPU simulation with feedback (`sim.frag.glsl`): each frame is advected from the last, stirred by curl noise, random gas bursts and the live sound level. It has history, so it does not loop.
- Bubbles, tremors, spatter and lightning arrive on a random clock seeded from the operating system (`src/sim/events.ts`).
- The rock (strata, fractures, stars, distant ranges) is rendered once into a texture and only re-lit each frame.
- Sparks and lava bombs are a pre-allocated particle pool; lava on the slopes is a 1D flow that creeps downhill, cools and freezes.
- Post-processing: bloom, heat haze, filmic tonemapping, grain.

Performance: render resolution adapts to the device, the frame rate halves while the volcano is at rest, nothing is allocated per frame, and rendering stops when the tab is hidden.

## Layout

```
src/audio/    microphone, the heat model and the sound engine
src/sim/      volcano state machine, random events, shared geometry
src/render/   renderer, particles, lava flow, shaders
src/ui/       start screen, status gauge, settings
tests/        unit tests for the heat model, the state machine and the sound mix
```
