import WebSocket, { WebSocketServer } from "ws";

const defaultInstructions =
  "You are a warm, emotionally aware realtime voice companion. Be natural, friendly, honest, lightly witty, and easy to interrupt. Listen for tone and context, avoid empty praise, and keep spoken replies conversational unless the user wants depth.";

export function attachRealtimeRelay(server, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    path = "/realtime",
    instructions = defaultInstructions
  } = options;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Create a .env file from .env.example first.");
  }

  const browserSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname !== path) {
      return;
    }

    browserSockets.handleUpgrade(request, socket, head, (clientSocket) => {
      browserSockets.emit("connection", clientSocket);
    });
  });

  browserSockets.on("connection", (clientSocket) => {
    const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const openaiSocket = new WebSocket(realtimeUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    const queuedMessages = [];

    openaiSocket.on("open", () => {
      sendToClient(clientSocket, {
        type: "local.status",
        status: "connected",
        model
      });

      openaiSocket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions,
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000
                },
                turn_detection: {
                  type: "server_vad"
                }
              },
              output: {
                format: {
                  type: "audio/pcm",
                  rate: 24000
                }
              }
            }
          }
        })
      );

      while (queuedMessages.length > 0) {
        openaiSocket.send(queuedMessages.shift());
      }
    });

    openaiSocket.on("message", (message) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(message.toString());
      }
    });

    openaiSocket.on("error", (error) => {
      sendToClient(clientSocket, {
        type: "local.error",
        message: error.message
      });
    });

    openaiSocket.on("close", (code, reason) => {
      sendToClient(clientSocket, {
        type: "local.status",
        status: "closed",
        code,
        reason: reason.toString()
      });
      clientSocket.close();
    });

    clientSocket.on("message", (message) => {
      const payload = message.toString();

      if (openaiSocket.readyState === WebSocket.OPEN) {
        openaiSocket.send(payload);
        return;
      }

      queuedMessages.push(payload);
    });

    clientSocket.on("close", () => {
      openaiSocket.close();
    });
  });

  return {
    path,
    close: () => browserSockets.close()
  };
}

function sendToClient(socket, event) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}
