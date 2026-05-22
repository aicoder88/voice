import { keyboard, Key } from "@nut-tree-fork/nut-js";
import { clipboard } from "electron";

keyboard.config.autoDelayMs = 0;

const USE_CLIPBOARD = process.env.TYPE_VIA_CLIPBOARD !== "false";
const RELEASE_DELAY_MS = Number(process.env.TYPE_RELEASE_DELAY_MS || 80);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function typeText(text) {
  if (!text) return;

  await sleep(RELEASE_DELAY_MS);

  if (USE_CLIPBOARD) {
    const previousClipboard = clipboard.readText();
    clipboard.writeText(text);
    try {
      await keyboard.pressKey(Key.LeftControl, Key.V);
      await keyboard.releaseKey(Key.LeftControl, Key.V);
    } finally {
      setTimeout(() => {
        try { clipboard.writeText(previousClipboard); } catch {}
      }, 250);
    }
    return;
  }

  await keyboard.type(text);
}
