const CLEANUP_MODEL = process.env.CLEANUP_MODEL || "gpt-4.1-nano";
const TIMEOUT_MS = Number(process.env.CLEANUP_TIMEOUT_MS || 4000);

const SYSTEM_PROMPT = `You clean up raw dictation transcripts so they read like written text.

Rules:
- Add punctuation and proper capitalization.
- Remove filler words: "um", "uh", "uhh", "like", "you know" - unless they are intentional.
- Fix obvious transcription mistakes if context makes them clear.
- Preserve the original language (English, French, Croatian, etc.) - do NOT translate.
- Preserve the meaning. Do not add or remove information.
- Do not add greetings, closings, or commentary.
- Output the cleaned text only, with no quotes and no preamble.`;

export async function polishTranscript(rawText) {
  if (!process.env.OPENAI_API_KEY) return rawText;
  if (!rawText || rawText.length < 2) return rawText;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: rawText }
        ],
        temperature: 0
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(`Cleanup HTTP ${response.status}`);
      return rawText;
    }

    const data = await response.json();
    const cleaned = data?.choices?.[0]?.message?.content?.trim();
    return cleaned || rawText;
  } catch (error) {
    console.error("Cleanup error:", error.message);
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}
