# Realtime Voice Agents

This project creates a small local voice app for the OpenAI Realtime API.

Think of it like a front desk: your browser talks to the local server, and the local server talks to OpenAI while keeping your API key out of the browser.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file:

   ```bash
   cp .env.example .env
   ```

3. Put your OpenAI API key in `.env`.

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the URL printed in the terminal.

6. Pick an agent, connect, and hold the talk button while speaking.

## What is included

- `server.js` runs the demo web server.
- `realtime-relay.js` is the reusable server-side relay for other apps.
- `public/realtime-voice-agent.js` is the reusable browser widget.
- `public/index.html` gives you a simple voice-agent demo page.
- `.env.example` shows the settings you need.

The browser connects to:

```text
ws://localhost:3000/realtime
```

The server connects to OpenAI:

```text
wss://api.openai.com/v1/realtime?model=gpt-realtime-2
```

## Use this in another app

There are two parts, like a phone and a private switchboard:

- The browser widget is the phone. You can put it on any page.
- The relay is the switchboard. It stays on your server so your OpenAI key is never shown in the browser.

### 1. Add the relay to your app server

Install the WebSocket dependency in the other app if it does not already have it:

```bash
npm install ws
```

Then attach the relay to that app's HTTP server:

```js
import { createServer } from "node:http";
import { attachRealtimeRelay } from "./realtime-relay.js";

const server = createServer(app);

attachRealtimeRelay(server, {
  path: "/realtime",
  model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2"
});

server.listen(3000);
```

Keep `OPENAI_API_KEY` in the server's `.env` file.

### 2. Add the widget to a page

Copy `public/realtime-voice-agent.js` into the other app's public/static folder. Then add:

```html
<script type="module" src="/realtime-voice-agent.js"></script>

<realtime-voice-agent></realtime-voice-agent>
```

If the relay is on a different URL, point the widget at it:

```html
<realtime-voice-agent endpoint="ws://localhost:3000/realtime"></realtime-voice-agent>
```

For a smaller version:

```html
<realtime-voice-agent compact></realtime-voice-agent>
```

To start with a specific personality:

```html
<realtime-voice-agent agent="operator"></realtime-voice-agent>
```

Available agents are `companion`, `paperclip`, `hermes`, `operator`, and `custom`.
