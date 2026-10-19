export type StreamPart = { type: string; data: unknown };

export async function readUiStream(
  response: Response,
  onPart: (part: StreamPart) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body) {
    throw new Error(`Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const json = JSON.parse(data) as { type?: string; data?: unknown };
      if (json.type) onPart({ type: json.type, data: json.data });
    }
  }
}
